// Exploratory pilot (user request, 2026-09-01): three precursor signals tested against the same
// honest, non-circular outcome -- does each predict MORE movement is still coming, beyond what's
// already happened in the precursor window itself?
//   1. ATR LEVEL (already validated this session: RTH r=0.621, Globex r=0.572)
//   2. RANGE-EXPANSION SLOPE (is range GROWING within the precursor window, not just its average
//      level -- distinct from #1, which only looks at the average)
//   3. SIGN-RUN-LENGTH / DIRECTIONAL PERSISTENCE (are bars closing the same direction in a row --
//      "choppy vs directional", distinct from both range signals since it discards magnitude and
//      keeps only the sign sequence)
// Reuses the exact "first 60 min max move" population definition already validated in
// RESEARCH_CLAIM flush_move_distribution_percentiles_wider_target (N=446 RTH / N=821 Globex)
// rather than reinventing move detection. No lookahead: all three precursor signals are computed
// ONLY from the first 15 minutes; the outcome is measured ONLY from minute 15 onward, from the
// price AT minute 15 -- excludes the precursor window itself from the outcome, same fix already
// applied to the ATR-only version of this script.
import { query } from '../server/db.js';

const RTH_START_MOD = 570;   // 9:30 ET
const GLOBEX_START_MOD = 1080; // 18:00 ET

async function loadSessionBars(symbol) {
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

function atrLevel(bars) {
  if (!bars.length) return null;
  return bars.reduce((s, b) => s + (b.high - b.low), 0) / bars.length;
}

// Simple linear regression slope of per-bar true range vs bar index (0..N-1) -- is range growing
// bar-over-bar within the window, independent of its average level.
function rangeSlope(bars) {
  const n = bars.length;
  const ranges = bars.map(b => b.high - b.low);
  const meanX = (n - 1) / 2;
  const meanY = ranges.reduce((s, r) => s + r, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ranges[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den > 0 ? num / den : 0; // points of range growth per bar
}

// Max run-length of consecutive same-direction closes (up-close vs down-close), and the fraction
// of bars agreeing with the window's own net direction -- a pure sign-sequence measure, discards
// magnitude entirely (distinct from both range signals above).
function directionalPersistence(bars) {
  let dirs = [];
  for (let i = 1; i < bars.length; i++) dirs.push(bars[i].close > bars[i - 1].close ? 1 : (bars[i].close < bars[i - 1].close ? -1 : 0));
  let maxRun = 0, curRun = 0, curSign = 0;
  for (const d of dirs) {
    if (d === 0) { curRun = 0; curSign = 0; continue; }
    if (d === curSign) curRun++;
    else { curSign = d; curRun = 1; }
    maxRun = Math.max(maxRun, curRun);
  }
  const netDir = bars[bars.length - 1].close > bars[0].close ? 1 : -1;
  const agreeing = dirs.filter(d => d === netDir).length;
  const agreeFrac = dirs.length ? agreeing / dirs.length : 0;
  return { maxRun, agreeFrac };
}

async function analyze(label, startMod) {
  const bars = await loadSessionBars('NQ');
  const byDate = new Map();
  for (const b of bars) {
    if (b.mod < startMod || b.mod >= startMod + 65) continue;
    const key = (b.et_date instanceof Date) ? b.et_date.toISOString().slice(0, 10) : String(b.et_date).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(b);
  }

  const rows = [];
  for (const [date, dayBars] of byDate) {
    dayBars.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (dayBars.length < 61) continue;
    const first15 = dayBars.slice(0, 15);
    const rest45 = dayBars.slice(15, 61);
    const priceAt15 = dayBars[14].close;

    const dp = directionalPersistence(first15);
    let addUp = 0, addDown = 0;
    for (const b of rest45) { addUp = Math.max(addUp, b.high - priceAt15); addDown = Math.max(addDown, priceAt15 - b.low); }
    const additionalMove = Math.max(addUp, addDown);

    rows.push({
      date,
      atrLevel: atrLevel(first15),
      rangeSlope: rangeSlope(first15),
      maxRun: dp.maxRun,
      agreeFrac: dp.agreeFrac,
      additionalMove,
    });
  }

  console.log(`\n=== ${label}: N=${rows.length} sessions ===`);
  if (rows.length < 20) { console.log('Too thin, skipping.'); return; }

  function terciles(field) {
    const sorted = [...rows].sort((a, b) => a[field] - b[field]);
    const third = Math.ceil(sorted.length / 3);
    return [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
  }
  function corr(field, outcome = 'additionalMove') {
    const n = rows.length;
    const meanX = rows.reduce((s, r) => s + r[field], 0) / n;
    const meanY = rows.reduce((s, r) => s + r[outcome], 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (const r of rows) { num += (r[field] - meanX) * (r[outcome] - meanY); denX += (r[field] - meanX) ** 2; denY += (r[outcome] - meanY) ** 2; }
    return num / Math.sqrt(denX * denY);
  }

  console.log(`  --- RANGE-EXPANSION SLOPE (is range growing within first 15 min, not just its level) ---`);
  terciles('rangeSlope').forEach((t, i) => {
    const avg = t.reduce((s, r) => s + r.additionalMove, 0) / t.length;
    console.log(`  T${i + 1} (${['LOW', 'MID', 'HIGH'][i]} range-slope): N=${t.length}, avgAdditionalMove=${avg.toFixed(1)}pt`);
  });
  console.log(`  Pearson correlation (rangeSlope vs additionalMove): ${corr('rangeSlope').toFixed(3)}`);

  console.log(`\n  --- DIRECTIONAL PERSISTENCE: max same-direction run-length in first 15 min ---`);
  terciles('maxRun').forEach((t, i) => {
    const avg = t.reduce((s, r) => s + r.additionalMove, 0) / t.length;
    const runRange = [Math.min(...t.map(r => r.maxRun)), Math.max(...t.map(r => r.maxRun))];
    console.log(`  T${i + 1} (run ${runRange[0]}-${runRange[1]} bars): N=${t.length}, avgAdditionalMove=${avg.toFixed(1)}pt`);
  });
  console.log(`  Pearson correlation (maxRun vs additionalMove): ${corr('maxRun').toFixed(3)}`);

  console.log(`\n  --- DIRECTIONAL PERSISTENCE: fraction of bars agreeing with net direction ---`);
  terciles('agreeFrac').forEach((t, i) => {
    const avg = t.reduce((s, r) => s + r.additionalMove, 0) / t.length;
    const fracRange = [Math.min(...t.map(r => r.agreeFrac)), Math.max(...t.map(r => r.agreeFrac))];
    console.log(`  T${i + 1} (${(fracRange[0] * 100).toFixed(0)}-${(fracRange[1] * 100).toFixed(0)}% agreeing): N=${t.length}, avgAdditionalMove=${avg.toFixed(1)}pt`);
  });
  console.log(`  Pearson correlation (agreeFrac vs additionalMove): ${corr('agreeFrac').toFixed(3)}`);

  console.log(`\n  (reference) ATR LEVEL correlation: ${corr('atrLevel').toFixed(3)}`);

  // Cross-correlation: are these actually independent signals, or all just restating ATR level?
  function crossCorr(fieldA, fieldB) {
    const n = rows.length;
    const meanX = rows.reduce((s, r) => s + r[fieldA], 0) / n;
    const meanY = rows.reduce((s, r) => s + r[fieldB], 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (const r of rows) { num += (r[fieldA] - meanX) * (r[fieldB] - meanY); denX += (r[fieldA] - meanX) ** 2; denY += (r[fieldB] - meanY) ** 2; }
    return num / Math.sqrt(denX * denY);
  }
  console.log(`\n  --- Cross-correlation with ATR level (independence check) ---`);
  console.log(`  rangeSlope vs atrLevel: ${crossCorr('rangeSlope', 'atrLevel').toFixed(3)}`);
  console.log(`  maxRun vs atrLevel: ${crossCorr('maxRun', 'atrLevel').toFixed(3)}`);
  console.log(`  agreeFrac vs atrLevel: ${crossCorr('agreeFrac', 'atrLevel').toFixed(3)}`);

  // Combined score: does stacking ATR level (strong) with agreeFrac (weak but independent) beat
  // ATR alone? Z-score both against this sample's own mean/sd (exploratory correlation check --
  // not a forward-deployable rule yet, that would need out-of-sample z parameters) and sum.
  function zscore(field) {
    const n = rows.length;
    const mean = rows.reduce((s, r) => s + r[field], 0) / n;
    const sd = Math.sqrt(rows.reduce((s, r) => s + (r[field] - mean) ** 2, 0) / n);
    return rows.map(r => (r[field] - mean) / sd);
  }
  const zAtr = zscore('atrLevel');
  const zAgree = zscore('agreeFrac');
  rows.forEach((r, i) => { r.combined = zAtr[i] + zAgree[i]; });
  console.log(`\n  --- COMBINED (zATR + zAgreeFrac) vs ATR alone ---`);
  terciles('combined').forEach((t, i) => {
    const avg = t.reduce((s, r) => s + r.additionalMove, 0) / t.length;
    console.log(`  T${i + 1} (${['LOW', 'MID', 'HIGH'][i]} combined): N=${t.length}, avgAdditionalMove=${avg.toFixed(1)}pt`);
  });
  console.log(`  Pearson correlation (combined vs additionalMove): ${corr('combined').toFixed(3)}`);
  console.log(`  (for comparison) ATR-alone correlation: ${corr('atrLevel').toFixed(3)}`);
}

async function main() {
  await analyze('RTH', RTH_START_MOD);
  await analyze('GLOBEX', GLOBEX_START_MOD);
  console.log('\nDone. Exploratory only -- no claim recorded yet, pending review.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
