// Re-test of Gemini's unprimed findings (scratch/antigravity_response.md, 2026-08-24)
// on firmer footing: same JOIN-vs-FADE / Delta Intensity questions, but using THIS
// thread's already-audited med50 convergence statistic (not raw POC, which this
// thread separately proved is a discontinuous "argmax teleport" artifact) and
// next-bar-open entry (not same-bar-close, the no-lookahead convention used
// everywhere else in this thread). Also adds a new dimension per direct request:
// does taking the trade near an already-tracked "strong market level" help?
//
// JOIN = trade WITH the rotation leg's own direction (down-leg -> short, up-leg ->
// long). FADE = trade AGAINST it (down-leg -> long, up-leg -> short) -- FADE is what
// every earlier script in this thread tested; JOIN is Gemini's framing, tested here
// for the first time under the audited construction.
//
// Level proximity reuses server/services/levelProximityService.js's real
// getRollingATR() + the same AT_LEVEL/LATE/CHASING ATR-scaled tagging convention
// (2%/10% of rolling 20-day RTH ATR) against the real level_prices table (472
// sessions: PD_VAH/VAL/POC, IB, OR5/10/15/30, monthly/quarterly VA, pivots, ONH/ONL,
// etc.) -- reused directly, not reimplemented, per this codebase's own rule.
import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { getRollingATR } from '../server/services/levelProximityService.js';
import { recordClaim } from './record_claim.mjs';
import { detectSignalEvents, TICK, formatET, mean, percentile } from './backtest_poc_rotation_vbp.mjs';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';

// FIXED 2026-08-30 (OPEN_DECISION poc_rotation_thread_points_mislabeled_as_dollars): EV/WR
// below used to be raw price points printed with a "$" prefix. res.pnl stays in points
// (trade-sim/CSV unaffected); only summarize()'s EV/WR/recordClaim conversion changed. The
// winnerJoin/bestStrat selection logic (below) compares .valEV across candidates that are ALL
// summed over the SAME 3 exit strategies -- a shared PPT*x-3*COMM affine transform of the raw
// points totals, so which arm/strategy "wins" is unchanged, only the reported $ value is.
const PPT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMM = LIVE_INSTRUMENT.commissionPerRoundTrip;
const dollarPnl = r => r.res.pnl * PPT - COMM;

const PATH = 'standard';
const R_PCT_REFERENCE_PRICE = 29547.75;
const R_PCT = 65 / R_PCT_REFERENCE_PRICE;
const DELTA_WINDOW_BARS = 3; // matches Gemini's delta_3

const EXIT_STRATEGIES = [
  { name: 'Fixed_30_30', stop: 30, target: 30, timeLimit: null },
  { name: 'Fixed_40_20', stop: 20, target: 40, timeLimit: null },
  { name: 'Time60_Stop20', stop: 20, target: null, timeLimit: 60 },
];

function runTrade(event, bars, join, strategy, entryOffset = 1) {
    const entryIdx = event.trigger_idx + entryOffset;
    if (entryIdx >= bars.length) return null;
    const entryPx = bars[entryIdx].open;
    const entryTime = bars[entryIdx].ts;
    const legIsUp = event.direction === 'UP';
    // JOIN: trade the leg's own direction. FADE: trade against it.
    const long = join ? legIsUp : !legIsUp;
    const trade_direction = long ? 'LONG' : 'SHORT';
    const stopPx = long ? entryPx - strategy.stop : entryPx + strategy.stop;
    const targetPx = strategy.target != null ? (long ? entryPx + strategy.target : entryPx - strategy.target) : null;

    let resolution = null, exitTime = null, exit_idx = entryIdx;
    for (let i = entryIdx; i < bars.length; i++) {
        exit_idx = i;
        const bar = bars[i];
        if (strategy.timeLimit != null && (i - entryIdx) >= strategy.timeLimit) {
            resolution = { res: 'TIME_LIMIT', exitPx: bar.close };
            exitTime = bar.ts;
            break;
        }
        const stopTouched = long ? bar.low <= stopPx : bar.high >= stopPx;
        if (stopTouched) { resolution = { res: 'STOP_HIT', exitPx: stopPx }; exitTime = bar.ts; break; }
        if (targetPx != null) {
            const targetTouched = long ? bar.high >= targetPx : bar.low <= targetPx;
            if (targetTouched) { resolution = { res: 'TARGET_HIT', exitPx: targetPx }; exitTime = bar.ts; break; }
        }
    }
    if (!resolution) { resolution = { res: 'TIME_EXPIRED', exitPx: bars[bars.length - 1].close }; exitTime = bars[bars.length - 1].ts; }
    const pnl = long ? resolution.exitPx - entryPx : entryPx - resolution.exitPx;
    return { entryTime, trade_direction, entryPx, stopPx, targetPx, exitTime, exitReason: resolution.res, bars_to_resolution: exit_idx - entryIdx + 1, pnl };
}

function deltaIntensityWindow(event, bars, windowBars) {
    const endIdx = event.trigger_idx;
    const startIdx = Math.max(0, endIdx - windowBars + 1);
    let netDelta = 0, totVol = 0;
    for (let j = startIdx; j <= endIdx; j++) {
        netDelta += (bars[j].ask_volume || 0) - (bars[j].bid_volume || 0);
        totVol += (bars[j].volume || 0);
    }
    return totVol > 0 ? Math.abs(netDelta) / totVol : 0;
}

function summarize(results) {
    const N = results.length;
    if (N === 0) return { N: 0 };
    const distinctDates = new Set(results.map(r => r.e.t)).size;
    const wins = results.filter(r => dollarPnl(r) > 0).length;
    const wr = (wins / N * 100).toFixed(1);
    const ev = (results.reduce((s, r) => s + dollarPnl(r), 0) / N).toFixed(2);
    let rigorStr = 'n/a (N<20)';
    if (N >= 20) {
        const rigor = computeRigor(results.map(r => ({ t: r.e.t, pnl: dollarPnl(r) })), { dateField: 't', pnlFn: r => r.pnl });
        rigorStr = `stable=${rigor.stable} cluster=${rigor.clustered}`;
    }
    return { N, distinctDates, wr, ev, valEV: Number(ev), rigorStr };
}

async function main() {
    const dvl = (await query(`SELECT trade_date::text as t FROM developing_value_log ORDER BY trade_date DESC`)).rows.reverse();
    const sessions = [];
    for (const row of dvl) {
        const bars = (await query(`
          SELECT ts, ts::date::text as d, high::float, low::float, close::float, open::float,
                 volume::float as volume, bid_volume::float as bid_volume, ask_volume::float as ask_volume
          FROM price_bars_primary WHERE symbol='NQ' AND (
            (ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR
            (ts::date = $1 AND EXTRACT(hour FROM ts) < 17)
          ) ORDER BY ts`, [row.t])).rows;
        if (bars.length < 300) continue;
        sessions.push({ t: row.t, bars });
    }
    console.log(`Loaded ${sessions.length} sessions.`);

    // Cache: ATR20 per date (getRollingATR is no-lookahead, only uses ts::date < logDate)
    const atrCache = new Map();
    // Cache: level_prices per date
    const levelsCache = new Map();
    async function getLevelsFor(date) {
        if (levelsCache.has(date)) return levelsCache.get(date);
        const r = await query(`SELECT level_name, price::float FROM level_prices WHERE trade_date=$1 AND price IS NOT NULL`, [date]);
        levelsCache.set(date, r.rows);
        return r.rows;
    }
    async function getAtrFor(date) {
        if (atrCache.has(date)) return atrCache.get(date);
        const atr = await getRollingATR(date);
        atrCache.set(date, atr);
        return atr;
    }

    async function proximityTag(date, price) {
        const levels = await getLevelsFor(date);
        if (!levels.length) return { tag: 'NO_LEVELS', nearestDist: null, nearestLevel: null };
        let nearest = null, nearestDist = Infinity;
        for (const l of levels) {
            const d = Math.abs(price - l.price);
            if (d < nearestDist) { nearestDist = d; nearest = l.level_name; }
        }
        const atr = await getAtrFor(date);
        const tag = atr != null
            ? (nearestDist <= 0.02 * atr ? 'AT_LEVEL' : nearestDist <= 0.10 * atr ? 'LATE' : 'CHASING')
            : (nearestDist <= 5 ? 'AT_LEVEL' : nearestDist <= 15 ? 'LATE' : 'CHASING');
        return { tag, nearestDist, nearestLevel: nearest };
    }

    const csvChunks = [`construction,section,label,trade_date,leg_direction,trade_direction,entry_time,entry_price,stop_price,target_price,exit_time,exit_reason,bars_to_resolution,pnl,delta_intensity,level_tag,nearest_level,nearest_dist\n`];
    const allResults = {};

    for (const [label, R, rMode] of [['FIXED_R65', 65, 'fixed'], ['PCT_R0.22pct', R_PCT, 'pct']]) {
        const resMed = await query(`SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY high - low) as median_range FROM price_bars_primary WHERE symbol='NQ'`);
        const THETA = Math.max(TICK, resMed.rows[0].median_range);
        const { all_signal, legCount } = detectSignalEvents(R, PATH, THETA, sessions, rMode);
        console.log(`\n=== ${label} (legCount=${legCount}, signal=${all_signal.length}, med50-based) ===`);

        // Pre-compute delta intensity + proximity tag for every event once.
        const enriched = [];
        for (const e of all_signal) {
            const session = sessions.find(s => s.t === e.t);
            const di = deltaIntensityWindow(e, session.bars, DELTA_WINDOW_BARS);
            const prox = await proximityTag(e.t, session.bars[e.trigger_idx].close);
            enriched.push({ e, di, prox });
        }

        // Section 1: JOIN vs FADE across the 3 exit strategies, full population.
        console.log('  --- Section 1: JOIN vs FADE (med50, next-bar-open entry) ---');
        const section1 = {};
        for (const join of [true, false]) {
            const dirLabel = join ? 'JOIN' : 'FADE';
            for (const strat of EXIT_STRATEGIES) {
                const results = enriched.map(({ e }) => {
                    const session = sessions.find(s => s.t === e.t);
                    const res = runTrade(e, session.bars, join, strat, 1);
                    return res ? { e, res } : null;
                }).filter(Boolean);
                const summary = summarize(results);
                section1[`${dirLabel}_${strat.name}`] = summary;
                console.log(`    ${dirLabel} ${strat.name}: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} (${summary.rigorStr})`);
                for (const { e, res } of results) {
                    const session = sessions.find(s => s.t === e.t);
                    const idx = enriched.findIndex(x => x.e === e);
                    const di = enriched[idx]?.di ?? '';
                    const prox = enriched[idx]?.prox ?? {};
                    csvChunks.push(`${label},JOIN_FADE,${dirLabel}_${strat.name},${e.t},${e.direction},${res.trade_direction},${res.entryTime},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx != null ? res.targetPx.toFixed(2) : ''},${res.exitTime},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)},${typeof di === 'number' ? di.toFixed(3) : ''},${prox.tag ?? ''},${prox.nearestLevel ?? ''},${prox.nearestDist != null ? prox.nearestDist.toFixed(2) : ''}\n`);
                }
            }
        }
        // Pick winning direction = whichever has the higher EV summed across the 3 strategies.
        // FIXED 2026-08-30 (DeepSeek code review round 4, finding S8, latent -- unreachable today,
        // all 6 cells confirmed N=1935/2322): `|| 0` treated a MISSING (N=0) cell the same as a
        // real break-even one for this sum. Pre-dollar-fix that was harmless (break-even WAS 0
        // points); post-fix a real break-even trade is -$2 (commission), so a missing cell would
        // have silently scored BETTER than a genuinely break-even one. `?? 0` only guards against
        // null/undefined, not against masking a real negative value the way `|| 0` does.
        const joinTotal = EXIT_STRATEGIES.reduce((s, st) => s + (section1[`JOIN_${st.name}`].valEV ?? 0), 0);
        const fadeTotal = EXIT_STRATEGIES.reduce((s, st) => s + (section1[`FADE_${st.name}`].valEV ?? 0), 0);
        const winnerJoin = joinTotal >= fadeTotal;
        const winnerLabel = winnerJoin ? 'JOIN' : 'FADE';
        // Pick winning exit strategy under the winning direction.
        const bestStrat = EXIT_STRATEGIES.map(st => ({ st, ev: section1[`${winnerLabel}_${st.name}`].valEV })).sort((a, b) => b.ev - a.ev)[0].st;
        console.log(`  Winner: ${winnerLabel} / ${bestStrat.name}`);

        // Section 2: Delta Intensity buckets (3-bar window, matching Gemini) under the winning direction+exit.
        console.log(`  --- Section 2: Delta Intensity buckets (${DELTA_WINDOW_BARS}-bar window), ${winnerLabel}/${bestStrat.name} ---`);
        const deltaBuckets = [
            ['ALL', () => true],
            ['Delta<0.1', x => x.di < 0.1],
            ['Delta>=0.1', x => x.di >= 0.1],
            ['Delta>=0.2', x => x.di >= 0.2],
        ];
        const section2 = {};
        for (const [bname, filterFn] of deltaBuckets) {
            const subset = enriched.filter(filterFn);
            const results = subset.map(({ e }) => {
                const session = sessions.find(s => s.t === e.t);
                const res = runTrade(e, session.bars, winnerJoin, bestStrat, 1);
                return res ? { e, res } : null;
            }).filter(Boolean);
            const summary = summarize(results);
            section2[bname] = summary;
            console.log(`    ${bname}: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} (${summary.rigorStr})`);
        }

        // Section 3: Level-proximity buckets under the winning direction+exit.
        console.log(`  --- Section 3: Level proximity (real level_prices, ATR-scaled), ${winnerLabel}/${bestStrat.name} ---`);
        const proxBuckets = [
            ['ALL', () => true],
            ['NEAR_LEVEL (AT_LEVEL or LATE)', x => x.prox.tag === 'AT_LEVEL' || x.prox.tag === 'LATE'],
            ['AT_LEVEL_ONLY', x => x.prox.tag === 'AT_LEVEL'],
            ['CHASING (far from any level)', x => x.prox.tag === 'CHASING'],
        ];
        const section3 = {};
        for (const [bname, filterFn] of proxBuckets) {
            const subset = enriched.filter(filterFn);
            const results = subset.map(({ e }) => {
                const session = sessions.find(s => s.t === e.t);
                const res = runTrade(e, session.bars, winnerJoin, bestStrat, 1);
                return res ? { e, res } : null;
            }).filter(Boolean);
            const summary = summarize(results);
            section3[bname] = summary;
            console.log(`    ${bname}: N=${summary.N} WR=${summary.wr}% EV=$${summary.ev} (${summary.rigorStr})`);
            for (const { e, res } of results) {
                const idx = enriched.findIndex(x => x.e === e);
                const di = enriched[idx]?.di ?? '';
                const prox = enriched[idx]?.prox ?? {};
                csvChunks.push(`${label},LEVEL_PROXIMITY,${bname},${e.t},${e.direction},${res.trade_direction},${res.entryTime},${res.entryPx.toFixed(2)},${res.stopPx.toFixed(2)},${res.targetPx != null ? res.targetPx.toFixed(2) : ''},${res.exitTime},${res.exitReason},${res.bars_to_resolution},${res.pnl.toFixed(2)},${typeof di === 'number' ? di.toFixed(3) : ''},${prox.tag ?? ''},${prox.nearestLevel ?? ''},${prox.nearestDist != null ? prox.nearestDist.toFixed(2) : ''}\n`);
            }
        }

        allResults[label] = { legCount, signalN: all_signal.length, section1, winnerLabel, bestStrat: bestStrat.name, section2, section3 };
    }

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/poc_rotation_join_fade_levels_trades.csv', csvChunks.join(''));
    fs.writeFileSync('scratch/poc_rotation_join_fade_levels_report.json', JSON.stringify(allResults, null, 2));

    for (const [label, r] of Object.entries(allResults)) {
        const s1lines = Object.entries(r.section1).map(([k, v]) => `  ${k}: N=${v.N} WR=${v.wr}% EV=$${v.ev} (${v.rigorStr})`).join('\n');
        const s2lines = Object.entries(r.section2).map(([k, v]) => `  ${k}: N=${v.N} WR=${v.wr}% EV=$${v.ev} (${v.rigorStr})`).join('\n');
        const s3lines = Object.entries(r.section3).map(([k, v]) => `  ${k}: N=${v.N} WR=${v.wr}% EV=$${v.ev} (${v.rigorStr})`).join('\n');
        const claimText = `Re-test of Gemini's unprimed JOIN-vs-FADE/Delta-Intensity findings using this thread's audited med50 convergence statistic (not raw POC) + next-bar-open entry (not same-bar-close). ${label} construction. Winner direction=${r.winnerLabel}, best exit=${r.bestStrat}.
Section 1 (JOIN vs FADE, 3 exits):
${s1lines}
Section 2 (Delta Intensity, ${DELTA_WINDOW_BARS}-bar window, under winning direction+exit):
${s2lines}
Section 3 (Level proximity vs real level_prices/ATR-scaled AT_LEVEL/LATE/CHASING, under winning direction+exit):
${s3lines}`;
        const best = Object.values(r.section3).filter(v => v.N >= 20).sort((a, b) => b.valEV - a.valEV)[0];
        if (best) {
            await recordClaim({
                slug: `poc_rotation_join_fade_levels_med50_${label === 'FIXED_R65' ? 'fixed' : 'pct'}`,
                claimText,
                sourceFile: 'scripts/backtest_poc_rotation_join_fade_levels.mjs',
                sampleSize: best.N,
                winRate: best.wr / 100,
                evPerTrade: best.valEV,
                rigorStatus: best.rigorStr,
                status: 'PROVISIONAL',
            });
        }
    }

    console.log('\nDONE');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
