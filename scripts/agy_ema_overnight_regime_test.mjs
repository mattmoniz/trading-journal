/**
 * agy_ema_overnight_regime_test.mjs
 * 
 * Tests Grand Unified Theory: EMA (trend) thrives in Mid(short-term) + Edge(macro)
 * Entry: Any 9/21 EMA cross in 2–7 AM ET window (full range, not specific hours)
 * Exit: RTH open 9:30 AM ET OR hard stop (tested at 60, 80, 100pt)
 * Clustering: Only 1 trade active at a time
 * MNQ: $2/pt
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
const STOP_WIDTHS = [60, 80, 100];
const LOOKBACKS = [10, 20, 30, 45, 60, 90, 180];
const SHORT_TERM = [10, 20, 30];
const MACRO = [60, 90, 180];

function calcEMA(prices, p) {
    const k = 2 / (p + 1);
    let e = prices[0];
    return prices.map(v => (e = (v - e) * k + e));
}

function etHour(b) { return b.et_hour; }
function etMin(b)  { return b.et_minute; }
function isRTH(b)  { const h = b.et_hour, m = b.et_minute; return h > 9 || (h === 9 && m >= 30); }

function stats(label, trades) {
    if (!trades.length) return;
    let eq = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
        eq += t.pnl;
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        if (dd > maxDD) maxDD = dd;
    }
    const total = trades.reduce((s,t) => s + t.pnl, 0);
    const wins  = trades.filter(t => t.pnl > 0).length;
    const stops = trades.filter(t => t.exit === 'STOP').length;
    const rth   = trades.filter(t => t.exit === 'RTH').length;
    const rdd   = maxDD > 0 ? (total/maxDD).toFixed(2) : 'N/A';
    console.log(`${label}`);
    console.log(`  N=${trades.length} | Win=${wins}(${(100*wins/trades.length).toFixed(0)}%) | Stops=${stops} | RTH=${rth}`);
    console.log(`  PnL=$${total.toFixed(0)} | MaxDD=-$${maxDD.toFixed(0)} | R/DD=${rdd}x`);
}

async function run() {
    // Load 1-min bars
    console.log('Loading bars...');
    const { rows: bars1m } = await pool.query(`
        SELECT ts, open::float, high::float, low::float, close::float, EXTRACT(hour FROM ts) as et_hour, EXTRACT(minute FROM ts) as et_minute
        FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= '2023-01-01' ORDER BY ts`);
    console.log(`${bars1m.length} 1-min bars loaded`);

    // Resample to 5-min
    const bars5m = [];
    let cur = null;
    for (const b of bars1m) {
        const r = new Date(Math.floor(new Date(b.ts).getTime()/300000)*300000);
        if (!cur) { cur = {ts:r,open:b.open,high:b.high,low:b.low,close:b.close, et_hour: b.et_hour, et_minute: b.et_minute}; }
        else if (r.getTime()===cur.ts.getTime()) {
            cur.high=Math.max(cur.high,b.high); cur.low=Math.min(cur.low,b.low); cur.close=b.close;
        } else { bars5m.push(cur); cur={ts:r,open:b.open,high:b.high,low:b.low,close:b.close, et_hour: b.et_hour, et_minute: b.et_minute}; }
    }
    if (cur) bars5m.push(cur);
    console.log(`${bars5m.length} 5-min bars`);

    // Daily bars for balance areas
    const { rows: daily } = await pool.query(`
        SELECT date_trunc('day',ts) AS day, MAX(high)::float AS h, MIN(low)::float AS l
        FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= '2022-01-01' GROUP BY 1 ORDER BY 1`);

    function balanceArea(ts, lookback) {
        const d = new Date(ts);
        const prev = daily.filter(b => new Date(b.day) < d);
        if (prev.length < lookback) return null;
        const sl = prev.slice(-lookback);
        const hi = Math.max(...sl.map(b=>b.h)), lo = Math.min(...sl.map(b=>b.l));
        return { hi, lo, range: hi-lo };
    }

    function pos(price, ba) {
        if (!ba || ba.range===0) return null;
        return (price - ba.lo) / ba.range;
    }

    // EMAs
    const closes = bars5m.map(b=>b.close);
    const e9  = calcEMA(closes, 9);
    const e21 = calcEMA(closes, 21);

    // Find signals in 2-7 AM ET window
    const signals = [];
    for (let i = 21; i < bars5m.length; i++) {
        const h = etHour(bars5m[i]);
        if (h < 2 || h > 7) continue;
        const crossUp   = e9[i-1] <= e21[i-1] && e9[i] > e21[i];
        const crossDown = e9[i-1] >= e21[i-1] && e9[i] < e21[i];
        if (!crossUp && !crossDown) continue;

        // Pre-compute positions for all lookbacks
        const positions = {};
        for (const L of LOOKBACKS) {
            const ba = balanceArea(bars5m[i].ts, L);
            positions[L] = pos(bars5m[i].close, ba);
        }

        signals.push({ type: crossUp?'LONG':'SHORT', idx:i, price:bars5m[i].close, ts:bars5m[i].ts, positions });
    }
    console.log(`${signals.length} raw signals found`);

    // Resolve trades per stop width
    function resolve(stopPts) {
        const trades = [];
        let lockUntil = -1;
        for (const sig of signals) {
            if (sig.idx <= lockUntil) continue;
            const isLong = sig.type === 'LONG';
            let pnl=0, exit='EOD', exitIdx=sig.idx;

            for (let j = sig.idx+1; j < bars5m.length; j++) {
                const bar = bars5m[j];
                // RTH open exit
                if (isRTH(bar)) {
                    pnl = isLong ? bar.open - sig.price : sig.price - bar.open;
                    exit='RTH'; exitIdx=j; break;
                }
                // Hard stop
                if (isLong && bar.low  <= sig.price - stopPts) { pnl=-stopPts; exit='STOP'; exitIdx=j; break; }
                if (!isLong && bar.high >= sig.price + stopPts) { pnl=-stopPts; exit='STOP'; exitIdx=j; break; }
                // Session end gap (daily settlement)
                if (j > sig.idx+1 && bar.ts.getTime()-bars5m[j-1].ts.getTime() > 3600000) {
                    pnl = isLong ? bars5m[j-1].close - sig.price : sig.price - bars5m[j-1].close;
                    exit='SESSION'; exitIdx=j-1; break;
                }
            }
            lockUntil = exitIdx;
            trades.push({ ...sig, pnl: pnl*MNQ, exit, stopPts });
        }
        return trades;
    }

    const byStop = {};
    for (const s of STOP_WIDTHS) {
        byStop[s] = resolve(s);
        console.log(`Stop ${s}pt: ${byStop[s].length} trades`);
    }

    const OOS = t => new Date(t.ts) >= new Date('2025-01-01');

    // ==========================================
    console.log('\n' + '='.repeat(62));
    console.log('  EMA OVERNIGHT: 2-7 AM ET | 9/21 cross | Ride to 9:30 open');
    console.log('  MNQ $2/pt | Clustering: 1 trade at a time');
    console.log('='.repeat(62));

    // --- STOP WIDTH RAW COMPARISON ---
    console.log('\n▶ RAW (NO FILTER) — STOP WIDTH COMPARISON');
    for (const s of STOP_WIDTHS) {
        const t = byStop[s], oos = t.filter(OOS);
        stats(`  ${s}pt ALL-TIME`, t);
        stats(`  ${s}pt OOS 2025+`, oos);
        console.log('');
    }

    // --- PER LOOKBACK SINGLE-DIM for each stop ---
    for (const s of STOP_WIDTHS) {
        const t = byStop[s], oos = t.filter(OOS);
        console.log(`\n▶ ${s}pt STOP — SINGLE-DIMENSION BALANCE AREA BREAKDOWN`);
        for (const L of LOOKBACKS) {
            const midA = t.filter(x => x.positions[L]!==null && x.positions[L]>=0.25 && x.positions[L]<=0.75);
            const edgA = t.filter(x => x.positions[L]!==null && (x.positions[L]<0.25||x.positions[L]>0.75));
            const midO = oos.filter(x => x.positions[L]!==null && x.positions[L]>=0.25 && x.positions[L]<=0.75);
            const edgO = oos.filter(x => x.positions[L]!==null && (x.positions[L]<0.25||x.positions[L]>0.75));
            console.log(`\n  -- ${L}-DAY BALANCE AREA --`);
            stats(`  Middle 50% all-time (N=${midA.length})`, midA);
            stats(`  Middle 50% OOS only (N=${midO.length})`, midO);
            stats(`  Edge      all-time (N=${edgA.length})`, edgA);
            stats(`  Edge      OOS only (N=${edgO.length})`, edgO);
        }
    }

    // --- GRAND UNIFIED THEORY COMBOS ---
    console.log('\n\n' + '='.repeat(62));
    console.log('  GRAND UNIFIED THEORY: EMA trend = Mid(short) + Edge(macro)');
    console.log('='.repeat(62));

    for (const s of STOP_WIDTHS) {
        const t = byStop[s], oos = t.filter(OOS);
        console.log(`\n▶ ${s}pt STOP — THEORY COMBOS [short-term × macro]`);

        for (const stL of SHORT_TERM) {
            for (const macL of MACRO) {
                const isTheory = x => {
                    const ps=x.positions[stL], pm=x.positions[macL];
                    if (ps===null||pm===null) return false;
                    return (ps>=0.25&&ps<=0.75) && !(pm>=0.25&&pm<=0.75); // Mid ST + Edge Macro
                };
                const isAnti = x => {
                    const ps=x.positions[stL], pm=x.positions[macL];
                    if (ps===null||pm===null) return false;
                    return !(ps>=0.25&&ps<=0.75) && (pm>=0.25&&pm<=0.75); // Edge ST + Mid Macro
                };
                const thA=t.filter(isTheory), thO=oos.filter(isTheory);
                const anA=t.filter(isAnti),   anO=oos.filter(isAnti);
                console.log(`\n  Mid${stL}+Edge${macL} [THEORY] vs Edge${stL}+Mid${macL} [ANTI-THEORY]`);
                stats(`  ✅ Mid${stL}+Edge${macL} all-time (N=${thA.length})`, thA);
                stats(`  ✅ Mid${stL}+Edge${macL} OOS     (N=${thO.length})`, thO);
                stats(`  ❌ Edge${stL}+Mid${macL} all-time (N=${anA.length})`, anA);
                stats(`  ❌ Edge${stL}+Mid${macL} OOS     (N=${anO.length})`, anO);
            }
        }
    }

    pool.end();
}
run().catch(console.error);
