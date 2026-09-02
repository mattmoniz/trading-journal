// Exploratory pilot (user request, 2026-09-01): does early ATR/range expansion predict that a
// bigger-than-usual move is underway? Distinct from already-tested signals in this codebase:
// - Single-bar VOLUME spike -> found to mean EXHAUSTION, not continuation (hivolLopace finding).
// - PACE (points/minute of price movement) -> real for Globex, not clean for RTH.
// ATR measures bar RANGE (high-low), not volume or directional speed -- a genuinely different
// axis (a market can move fast with tight bars, or slow with wide whippy bars).
//
// Reuses the exact "first 60 min max move" population definition already validated in
// RESEARCH_CLAIM flush_move_distribution_percentiles_wider_target (N=446 RTH days / N=821 Globex
// sessions) rather than reinventing move detection. No lookahead: the ATR "precursor" window is
// always the FIRST 15 minutes of the same 60-min window being characterized, strictly before the
// point being predicted.
import { query } from '../server/db.js';

const RTH_START_MOD = 570;   // 9:30 ET
const GLOBEX_START_MOD = 1080; // 18:00 ET

async function loadSessionBars(symbol, startMod, sessionLabel) {
  const bars = await query(`
    SELECT ts, high::float, low::float, close::float,
      (EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York')*60 + EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York'))::int as mod,
      (ts AT TIME ZONE 'America/New_York')::date as et_date
    FROM price_bars_primary
    WHERE symbol=$1
    ORDER BY ts ASC
  `, [symbol]);
  return bars.rows;
}

function atr(bars) {
  // True range per bar approximated as high-low (no prior-close gap component -- 1-min bars,
  // gaps within a session are negligible; this is a range measure, not a strict Wilder ATR).
  if (!bars.length) return null;
  return bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length;
}

async function analyze(label, startMod) {
  const bars = await loadSessionBars('NQ', startMod, label);
  // Group into sessions keyed by the session's own start date (for RTH: same ET date as open;
  // for Globex: the date the 18:00 bar falls on -- sessions don't cross into the analysis here,
  // we just need each session's own first ~65 minutes of bars in order).
  const byDate = new Map();
  for (const b of bars) {
    if (b.mod < startMod || b.mod >= startMod + 65) continue; // only need first 65 min
    const key = (b.et_date instanceof Date) ? b.et_date.toISOString().slice(0, 10) : String(b.et_date).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(b);
  }

  const rows = [];
  for (const [date, dayBars] of byDate) {
    dayBars.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (dayBars.length < 61) continue; // need a genuinely complete first-60-min window
    const first15 = dayBars.slice(0, 15);
    const full60 = dayBars.slice(0, 61);
    const rest45 = dayBars.slice(15, 61); // NON-overlapping: minute 15 through 60 only
    const precursorATR = atr(first15);
    const openPrice = dayBars[0].close;
    const priceAt15 = dayBars[14].close;

    let maxMoveUp = 0, maxMoveDown = 0;
    for (const b of full60) {
      maxMoveUp = Math.max(maxMoveUp, b.high - openPrice);
      maxMoveDown = Math.max(maxMoveDown, openPrice - b.low);
    }
    const maxMove = Math.max(maxMoveUp, maxMoveDown); // ORIGINAL (circular) version, kept for comparison

    // HONEST version: additional move from minute 15 onward, measured from price AT minute 15,
    // not from the open -- this is the part precursorATR has NOT already seen.
    let addUp = 0, addDown = 0;
    for (const b of rest45) {
      addUp = Math.max(addUp, b.high - priceAt15);
      addDown = Math.max(addDown, priceAt15 - b.low);
    }
    const additionalMove = Math.max(addUp, addDown);

    rows.push({ date, precursorATR, maxMove, additionalMove });
  }

  console.log(`\n=== ${label}: N=${rows.length} sessions ===`);
  if (rows.length < 20) { console.log('Too thin, skipping.'); return; }

  function report(field, label) {
    const sorted = [...rows].sort((a, b) => a.precursorATR - b.precursorATR);
    const third = Math.ceil(sorted.length / 3);
    const terciles = [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
    const tLabels = ['LOW precursor ATR', 'MID precursor ATR', 'HIGH precursor ATR'];
    console.log(`  --- vs ${label} ---`);
    terciles.forEach((t, i) => {
      const avgMove = t.reduce((s, r) => s + r[field], 0) / t.length;
      const medMove = [...t.map(r => r[field])].sort((a, b) => a - b)[Math.floor(t.length / 2)];
      console.log(`  ${tLabels[i]}: N=${t.length}, avg=${avgMove.toFixed(1)}pt, median=${medMove.toFixed(1)}pt`);
    });
    const n = rows.length;
    const meanX = rows.reduce((s, r) => s + r.precursorATR, 0) / n;
    const meanY = rows.reduce((s, r) => s + r[field], 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (const r of rows) {
      num += (r.precursorATR - meanX) * (r[field] - meanY);
      denX += (r.precursorATR - meanX) ** 2;
      denY += (r[field] - meanY) ** 2;
    }
    console.log(`  Pearson correlation: ${(num / Math.sqrt(denX * denY)).toFixed(3)}`);
  }
  report('maxMove', 'TOTAL move incl. precursor window (CIRCULAR, for comparison only)');
  report('additionalMove', 'ADDITIONAL move AFTER the precursor window (the honest test)');
}

async function main() {
  await analyze('RTH', RTH_START_MOD);
  await analyze('GLOBEX', GLOBEX_START_MOD);
  console.log('\nDone. Exploratory only -- no claim recorded.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
