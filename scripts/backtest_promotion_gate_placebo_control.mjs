import pg from 'pg';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';

const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'gemini_readonly', password: 'gemini_ro_2026' });

const fmt = n => (n === null || n === undefined || Number.isNaN(n)) ? 'n/a' : (n >= 0 ? '+' : '') + n.toFixed(2);
const d10 = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function main() {
    console.log("Loading data from DB...");
    const gateRows = await pool.query(`SELECT run_date, created_at, signal_name, recommendation, notes FROM performance_audit WHERE signal_type='SETUP_STATUS' ORDER BY signal_name, created_at`);
    const trades = await pool.query(`
        SELECT id, trade_date, setup_type, fired_at, origin_status, actual_pnl::float AS pnl,
               resolution, size_multiplier::float AS sm, is_rth, session,
               price_at_detection::float, stop_level::float
        FROM active_setups
        WHERE origin_status IN ('ACTIVE','SHADOW') AND actual_pnl IS NOT NULL
          AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
          AND ib_window_stale_basis IS NOT TRUE
        ORDER BY fired_at
    `);

    const N_MIN = 15, WR_MIN = 52.0, EV_MIN = 0.0, WR_BAND = 3.0, EV_BAND = 1.0;
    const start = new Date('2026-08-01');
    const end = new Date('2026-08-16T23:59:59Z');

    const byType = new Map();
    for (const row of gateRows.rows) {
        if (!byType.has(row.signal_name)) byType.set(row.signal_name, []);
        let n = {}; try { n = JSON.parse(row.notes); } catch (e) {}
        byType.get(row.signal_name).push({
            date: row.run_date, created_at: row.created_at, rec: row.recommendation, notes: n
        });
    }

    for (const [type, history] of byType) {
        let currentCohort = null, currentEstWr = null, currentEstEv = null;
        let wasEligible = null;

        for (const h of history) {
            const runDate = new Date(h.date);
            const isEligible = ['ACTIVE', 'PROMOTE', 'DAY_TYPE_MANAGED'].includes(h.rec);
            const inWindow = runDate >= start && runDate <= end;
            const r90 = h.notes.recent_90d;
            const hasRealData = r90 && r90.real_n != null && r90.real_wr != null && r90.real_ev != null;

            if (wasEligible !== null) {
                if (inWindow && hasRealData) {
                    if (isEligible && !wasEligible) {
                        if (r90.real_n >= N_MIN && r90.real_wr >= WR_MIN && r90.real_ev > EV_MIN) {
                            if (currentCohort !== 'PROMOTED') {
                                currentCohort = 'PROMOTED'; currentEstWr = r90.real_wr; currentEstEv = r90.real_ev;
                            }
                        }
                    }
                    if (!isEligible) {
                        if (r90.real_n >= N_MIN && r90.real_wr >= (WR_MIN - WR_BAND) && r90.real_ev >= (EV_MIN - EV_BAND)) {
                            if (!(r90.real_wr >= WR_MIN && r90.real_ev > EV_MIN)) {
                                if (currentCohort !== 'JUST_MISSED') {
                                    currentCohort = 'JUST_MISSED'; currentEstWr = r90.real_wr; currentEstEv = r90.real_ev;
                                }
                            }
                        }
                    }
                }

                if (currentCohort === 'PROMOTED' && !isEligible) currentCohort = null;
                if (currentCohort === 'JUST_MISSED' && isEligible) currentCohort = null;
            }

            h.cohort = currentCohort; h.estWr = currentEstWr; h.estEv = currentEstEv;
            wasEligible = isEligible;
        }
    }

    const multiRunDays = new Set(['2026-08-10', '2026-08-11', '2026-08-16', '2026-08-17', '2026-08-19']);
    
    function analyze(excludeMultiRunDays) {
        const results = { PROMOTED: [], JUST_MISSED: [] };
        let flaggedTrades = 0;
        
        for (const t of trades.rows) {
            const hist = byType.get(t.setup_type);
            if (!hist) continue;
            let best = null;
            for (const g of hist) { if (g.created_at < t.fired_at) best = g; else break; }
            
            if (best && best.cohort) {
                const runDateStr = d10(best.date);
                if (multiRunDays.has(runDateStr)) {
                    if (!excludeMultiRunDays) flaggedTrades++;
                    if (excludeMultiRunDays) continue;
                }

                const stopWidth = Math.abs(t.price_at_detection - t.stop_level);
                let bucket = 'other';
                if (stopWidth >= 14 && stopWidth < 30) bucket = '14-30';
                else if (stopWidth >= 30 && stopWidth < 50) bucket = '30-50';
                else if (stopWidth >= 50 && stopWidth < 70) bucket = '50-70';
                else if (stopWidth >= 70 && stopWidth <= 92) bucket = '70-92';

                results[best.cohort].push({ 
                    ...t, estEv: best.estEv, estWr: best.estWr, bucket, stopWidth
                });
            }
        }
        return { results, flaggedTrades };
    }

    function printStats(label, dataObj) {
        const { results, flaggedTrades } = dataObj;
        console.log(`\n=============================================================`);
        console.log(`=== ${label} (Flagged multi-run-day trades in sample: ${flaggedTrades}) ===`);
        console.log(`=============================================================`);
        
        for (const cohort of ['PROMOTED', 'JUST_MISSED']) {
            const ts = results[cohort];
            const n = ts.length;
            if (n === 0) {
                console.log(`\nCohort ${cohort}: N=0`);
                continue;
            }
            const ev = ts.reduce((s,t) => s + t.pnl, 0) / n;
            const estEv = ts.reduce((s,t) => s + t.estEv, 0) / n;
            const underperf = ev - estEv;
            const rigor = computeRigor(ts, { dateField: 'trade_date', pnlFn: t => t.pnl });
            
            console.log(`\nCohort ${cohort}:`);
            console.log(`  Trades (N)      : ${n}`);
            console.log(`  Estimated EV    : ${fmt(estEv)}`);
            console.log(`  Actual Fwd EV   : ${fmt(ev)}`);
            console.log(`  Underperformance: ${fmt(underperf)}`);
            console.log(`  Rigor           : Clean=${rigor.clean}, DistinctDates=${rigor.distinctDates}, Top5DayPct=${rigor.top5DayPct}%`);
            
            const grouped = new Map();
            for (const t of ts) {
                if (!grouped.has(t.setup_type)) grouped.set(t.setup_type, []);
                grouped.get(t.setup_type).push(t);
            }
            console.log(`  Types involved  :`);
            for (const [tname, tlist] of grouped) {
                const tev = tlist.reduce((s, t) => s + t.pnl, 0) / tlist.length;
                console.log(`    - ${tname} (N=${tlist.length}, Fwd EV=${fmt(tev)})`);
            }
        }
        
        console.log(`\n=== Stop-Width Control ===`);
        for (const bucket of ['14-30', '30-50', '50-70', '70-92']) {
            const pTs = results['PROMOTED'].filter(t => t.bucket === bucket);
            const jTs = results['JUST_MISSED'].filter(t => t.bucket === bucket);
            const pEv = pTs.length ? pTs.reduce((s,t) => s + t.pnl, 0) / pTs.length : null;
            const jEv = jTs.length ? jTs.reduce((s,t) => s + t.pnl, 0) / jTs.length : null;
            console.log(`  Bucket ${bucket}: PROMOTED N=${pTs.length} EV=${fmt(pEv)} | JUST_MISSED N=${jTs.length} EV=${fmt(jEv)}`);
        }
        
        console.log(`\n=== computeReplication (Underperformance: est_ev - actual_ev) ===`);
        const bySetup = new Map();
        for (const cohort of ['PROMOTED', 'JUST_MISSED']) {
            for (const t of results[cohort]) {
                const key = `${t.setup_type}_${cohort}`;
                if (!bySetup.has(key)) bySetup.set(key, { id: key, cohort: cohort, trades: [] });
                bySetup.get(key).trades.push(t);
            }
        }
        const units = Array.from(bySetup.values());
        const selectedIds = units.filter(u => u.cohort === 'PROMOTED').map(u => u.id);
        
        const rep = computeReplication(units, {
            idFn: u => u.id,
            metricFn: u => {
                if (u.trades.length === 0) return null;
                const actualEv = u.trades.reduce((s, t) => s + t.pnl, 0) / u.trades.length;
                const estEv = u.trades.reduce((s, t) => s + t.estEv, 0) / u.trades.length;
                // Positive value means it UNDERPERFORMED (regressed to the mean)
                return { n: u.trades.length, value: estEv - actualEv }; 
            },
            selectedIds: selectedIds
        });
        
        console.log(`  Selected (PROMOTED) Pooled Underperf : ${fmt(rep.selectedPooled.value)} (N=${rep.selectedPooled.n})`);
        console.log(`  Held-Out (JUST_MISSED) Pooled Underperf: ${fmt(rep.heldOutPooled.value)} (N=${rep.heldOutPooled.n})`);
        console.log(`  Replicates?                          : ${rep.replicates}`);
        console.log(`  Held-Out Favorable Frac (regressed)  : ${rep.heldOutFavorableFrac}`);
    }

    printStats('ALL DATA (including known multiple-calibration-run days)', analyze(false));
    printStats('STRICT DATA (excluding known multiple-calibration-run days)', analyze(true));

}
main().then(() => pool.end()).catch(console.error);
