/**
 * agy_all_setups_regime_test.mjs
 *
 * Tests the Grand Unified Theory regime framework against ALL setups.
 * For each real forward-resolved trade, computes:
 *   - 10, 20, 30, 45, 60, 90, 180 day balance area position
 *   - Mid vs Edge label for short-term (10,20,30) and macro (60,90,180)
 *
 * Reports for each setup_type:
 *   - Raw overall EV
 *   - Split by each regime dimension
 *   - The "winning" regime combo if one exists
 *
 * Only uses real forward data: origin_status IN ('ACTIVE','SHADOW'),
 * resolution IN ('TARGET_HIT','STOP_HIT'), actual_pnl IS NOT NULL
 */
import pg from 'pg';
const pool = new pg.Pool({
    user: process.env.PGUSER || 'trader',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'trading_journal',
    password: process.env.PGPASSWORD || 'trader123',
    port: process.env.PGPORT || 5432,
});

const MNQ = 2;
const LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
const SHORT_TERM = [10, 20, 30];
const MACRO = [60, 90, 180];
const MIN_N = 5; // minimum trades per bucket to report

async function run() {
    // 1. Load daily bars into memory
    console.log('Loading daily bars...');
    const { rows: daily } = await pool.query(`
        SELECT date_trunc('day', ts)::date AS day,
               MAX(high)::float AS hi,
               MIN(low)::float  AS lo
        FROM price_bars_primary
        WHERE symbol = 'NQ' AND ts >= '2022-01-01'
        GROUP BY 1
        ORDER BY 1
    `);
    console.log(`${daily.length} daily bars loaded`);

    // Build fast lookup: given a date string, get the N prior days
    function balanceArea(firedAt, lookback) {
        const d = new Date(firedAt);
        const prev = daily.filter(b => new Date(b.day) < d);
        if (prev.length < lookback) return null;
        const sl = prev.slice(-lookback);
        const hi = Math.max(...sl.map(b => b.hi));
        const lo = Math.min(...sl.map(b => b.lo));
        return { hi, lo, range: hi - lo };
    }

    function getPos(price, ba) {
        if (!ba || ba.range === 0) return null;
        return (price - ba.lo) / ba.range;
    }

    function label(pos) {
        if (pos === null) return null;
        return (pos >= 0.25 && pos <= 0.75) ? 'Mid' : 'Edge';
    }

    // 2. Load all real forward-resolved trades
    console.log('Loading real forward-resolved trades...');
    const { rows: trades } = await pool.query(`
        SELECT
            setup_type,
            fired_at,
            price_at_detection::float AS price,
            actual_pnl::float AS pnl,
            resolution,
            origin_status
        FROM active_setups
        WHERE origin_status IN ('ACTIVE', 'SHADOW')
          AND resolution IN ('TARGET_HIT', 'STOP_HIT')
          AND actual_pnl IS NOT NULL
          AND fired_at IS NOT NULL
          AND price_at_detection IS NOT NULL
        ORDER BY fired_at
    `);
    console.log(`${trades.length} real forward-resolved trades loaded`);

    // 3. Tag each trade with regime labels
    console.log('Computing regime labels...');
    const tagged = trades.map(t => {
        const positions = {};
        const labels = {};
        for (const L of LOOKBACKS) {
            const ba = balanceArea(t.fired_at, L);
            const p = getPos(t.price, ba);
            positions[L] = p;
            labels[L] = label(p);
        }
        return { ...t, positions, labels, pnlMNQ: t.pnl * MNQ };
    });
    console.log('Regime labels computed');

    // 4. Aggregate by setup_type
    const bySetup = {};
    for (const t of tagged) {
        if (!bySetup[t.setup_type]) bySetup[t.setup_type] = [];
        bySetup[t.setup_type].push(t);
    }

    function bucket(trades, filter) {
        const t = filter ? trades.filter(filter) : trades;
        if (!t.length) return null;
        const total = t.reduce((s, x) => s + x.pnlMNQ, 0);
        const wins = t.filter(x => x.pnlMNQ > 0).length;
        return {
            n: t.length,
            ev: total / t.length,
            total,
            winPct: (100 * wins / t.length).toFixed(1),
        };
    }

    function fmtBucket(b) {
        if (!b || b.n < MIN_N) return `N<${MIN_N}`;
        return `N=${b.n} EV=$${b.ev.toFixed(0)}/trade WR=${b.winPct}%`;
    }

    // 5. Print results
    console.log('\n' + '='.repeat(70));
    console.log('ALL SETUPS — REGIME FRAMEWORK TEST (real forward data only)');
    console.log(`MNQ $${MNQ}/pt | Min N=${MIN_N} per bucket`);
    console.log('='.repeat(70));

    // Sort setups by total N descending
    const sorted = Object.entries(bySetup).sort((a, b) => b[1].length - a[1].length);

    for (const [setupType, trades] of sorted) {
        const overall = bucket(trades);
        if (!overall || overall.n < MIN_N) continue;

        console.log(`\n── ${setupType} ──`);
        console.log(`  Overall: ${fmtBucket(overall)}`);

        // Single-dimension regime splits
        for (const L of LOOKBACKS) {
            const mid  = bucket(trades, t => t.labels[L] === 'Mid');
            const edge = bucket(trades, t => t.labels[L] === 'Edge');
            if ((!mid || mid.n < MIN_N) && (!edge || edge.n < MIN_N)) continue;
            const midStr  = mid  && mid.n  >= MIN_N ? fmtBucket(mid)  : `N<${MIN_N}`;
            const edgeStr = edge && edge.n >= MIN_N ? fmtBucket(edge) : `N<${MIN_N}`;
            const gap = (mid && edge && mid.n >= MIN_N && edge.n >= MIN_N)
                ? `  [Gap: $${(mid.ev - edge.ev).toFixed(0)}/trade Mid-Edge]`
                : '';
            console.log(`  ${L}d: Mid=${midStr} | Edge=${edgeStr}${gap}`);
        }

        // Theory combos: short-term × macro
        let bestCombo = null, bestEV = -Infinity;
        for (const stL of SHORT_TERM) {
            for (const macL of MACRO) {
                const combos = {
                    [`Mid${stL}+Mid${macL}`]: t => t.labels[stL]==='Mid' && t.labels[macL]==='Mid',
                    [`Mid${stL}+Edge${macL}`]: t => t.labels[stL]==='Mid' && t.labels[macL]==='Edge',
                    [`Edge${stL}+Mid${macL}`]: t => t.labels[stL]==='Edge' && t.labels[macL]==='Mid',
                    [`Edge${stL}+Edge${macL}`]: t => t.labels[stL]==='Edge' && t.labels[macL]==='Edge',
                };
                for (const [name, filter] of Object.entries(combos)) {
                    const b = bucket(trades, filter);
                    if (b && b.n >= MIN_N && b.ev > bestEV) {
                        bestEV = b.ev;
                        bestCombo = { name, ...b };
                    }
                }
            }
        }

        // Print the top 3 combos by EV
        const comboResults = [];
        for (const stL of SHORT_TERM) {
            for (const macL of MACRO) {
                const combos = {
                    [`Mid${stL}+Mid${macL}`]: t => t.labels[stL]==='Mid' && t.labels[macL]==='Mid',
                    [`Mid${stL}+Edge${macL}`]: t => t.labels[stL]==='Mid' && t.labels[macL]==='Edge',
                    [`Edge${stL}+Mid${macL}`]: t => t.labels[stL]==='Edge' && t.labels[macL]==='Mid',
                    [`Edge${stL}+Edge${macL}`]: t => t.labels[stL]==='Edge' && t.labels[macL]==='Edge',
                };
                for (const [name, filter] of Object.entries(combos)) {
                    const b = bucket(trades, filter);
                    if (b && b.n >= MIN_N) comboResults.push({ name, ...b });
                }
            }
        }
        comboResults.sort((a, b) => b.ev - a.ev);

        if (comboResults.length > 0) {
            console.log(`  Best regime combos:`);
            for (const c of comboResults.slice(0, 3)) {
                const marker = c.ev > overall.ev * 1.5 ? ' ⭐' : '';
                console.log(`    ${c.name}: ${fmtBucket(c)}${marker}`);
            }
            // Also show worst combo for contrast
            const worst = comboResults[comboResults.length - 1];
            if (worst && worst.ev < overall.ev * 0.5) {
                console.log(`    Worst: ${worst.name}: ${fmtBucket(worst)}`);
            }
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log('THEORY SUMMARY: Mid(short-term) + Edge(macro) performance by setup');
    console.log('='.repeat(70));

    for (const stL of SHORT_TERM) {
        for (const macL of MACRO) {
            const theoryLabel = `Mid${stL}+Edge${macL}`;
            const antiLabel   = `Edge${stL}+Mid${macL}`;
            console.log(`\n▶ ${theoryLabel} [EMA Theory] vs ${antiLabel} [Mean-Rev Theory]`);
            const rows = [];
            for (const [setupType, trades] of sorted) {
                const th = bucket(trades, t => t.labels[stL]==='Mid' && t.labels[macL]==='Edge');
                const an = bucket(trades, t => t.labels[stL]==='Edge' && t.labels[macL]==='Mid');
                if ((!th || th.n < MIN_N) && (!an || an.n < MIN_N)) continue;
                const thStr = th && th.n >= MIN_N ? `EV=$${th.ev.toFixed(0)} N=${th.n}` : `N<${MIN_N}`;
                const anStr = an && an.n >= MIN_N ? `EV=$${an.ev.toFixed(0)} N=${an.n}` : `N<${MIN_N}`;
                rows.push(`  ${setupType.padEnd(35)} | ${theoryLabel}: ${thStr.padEnd(20)} | ${antiLabel}: ${anStr}`);
            }
            rows.forEach(r => console.log(r));
        }
    }

    pool.end();
}

run().catch(console.error);
