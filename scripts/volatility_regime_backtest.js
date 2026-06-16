// Phase 1 — REPORT ONLY. Backtests setup performance by volatility regime.
// Does NOT touch live detection/resolution/classification logic.
//
// Methodology (per spec):
//  1. realized vol = stdev of 5-min log-returns, computed two ways per session:
//       - SESSION: full RTH (9:30-16:00 ET, etMin 570-959)
//       - MORNING: 9:30-10:30 ET window (etMin 570-630)
//  2. Trailing 20-session mean/stdev of that SAME measure (session vs session,
//     morning vs morning) -> z-score per session.
//  3. Regime classification from z-score; HIGH-VOL further split into
//     DIRECTIONAL vs CHOP using trend_str = |close-open|/range (same metric
//     used by derive_day_types.js, threshold 0.50).
//  4. Setup outcomes by regime, reusing /tmp/all_setups_replay.json (output of
//     scripts/replay_all_setups.js — same resolution logic, not re-derived).

import pg from 'pg';
import fs from 'fs';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const N_BASELINE = 20;

// ── 1. Raw 1-min RTH bars, all sessions ────────────────────────────────────
const barsQ = await q(`
  SELECT DISTINCT ON (ts) ts::date::text as d,
    (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int as et_min,
    open::float, high::float, low::float, close::float
  FROM price_bars WHERE symbol='NQ'
    AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
  ORDER BY ts, id DESC
`);
const barsByDate = {};
for (const b of barsQ.rows) (barsByDate[b.d] ??= []).push(b);
for (const d in barsByDate) barsByDate[d].sort((a, b) => a.et_min - b.et_min);

// ── 2. day_type from acd_daily_log (ground truth, already populated) ───────
const dtQ = await q(`SELECT trade_date::text, day_type, daily_score::float FROM acd_daily_log WHERE trade_date < CURRENT_DATE ORDER BY trade_date`);
const dayTypeByDate = {};
for (const r of dtQ.rows) dayTypeByDate[r.trade_date] = r.day_type;

// ── 3. Build 5-min bars + compute session/morning vol + trend_str per date ──
function fiveMinBars(oneMinBars) {
  const buckets = {};
  for (const b of oneMinBars) {
    const bucket = Math.floor(b.et_min / 5) * 5;
    if (!buckets[bucket]) buckets[bucket] = { et_min: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    else {
      const x = buckets[bucket];
      x.high = Math.max(x.high, b.high);
      x.low = Math.min(x.low, b.low);
      x.close = b.close; // last wins (bars are ordered)
    }
  }
  return Object.values(buckets).sort((a, b) => a.et_min - b.et_min);
}

function stdevLogReturns(fiveMin) {
  if (fiveMin.length < 3) return null;
  const rets = [];
  for (let i = 1; i < fiveMin.length; i++) {
    const c0 = fiveMin[i - 1].close, c1 = fiveMin[i].close;
    if (c0 > 0 && c1 > 0) rets.push(Math.log(c1 / c0));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

const dates = Object.keys(barsByDate).sort();
const sessions = [];
for (const d of dates) {
  const bars = barsByDate[d];
  if (bars.length < 200) continue; // require near-full session (matches derive_day_types HAVING COUNT(*)>=200)

  const full = bars; // 570-959
  const morning = bars.filter(b => b.et_min <= 630);

  const fullFive = fiveMinBars(full);
  const morningFive = fiveMinBars(morning);

  const sessionVol = stdevLogReturns(fullFive);
  const morningVol = stdevLogReturns(morningFive);
  if (sessionVol == null || morningVol == null) continue;

  const sess_open = full[0].open;
  const sess_high = Math.max(...full.map(b => b.high));
  const sess_low = Math.min(...full.map(b => b.low));
  const sess_close = full[full.length - 1].close;
  const range = sess_high - sess_low;
  const trend_str = range > 0 ? Math.abs(sess_close - sess_open) / range : 0;

  sessions.push({ trade_date: d, sessionVol, morningVol, trend_str, dayType: dayTypeByDate[d] ?? null });
}

// ── 4. Trailing-20 baseline + z-score ───────────────────────────────────────
for (let i = 0; i < sessions.length; i++) {
  if (i < N_BASELINE) { sessions[i].zSession = null; sessions[i].zMorning = null; continue; }
  const prior = sessions.slice(i - N_BASELINE, i);

  const priorSess = prior.map(s => s.sessionVol);
  const meanS = priorSess.reduce((s, x) => s + x, 0) / priorSess.length;
  const sdS = Math.sqrt(priorSess.reduce((s, x) => s + (x - meanS) ** 2, 0) / (priorSess.length - 1));

  const priorMorn = prior.map(s => s.morningVol);
  const meanM = priorMorn.reduce((s, x) => s + x, 0) / priorMorn.length;
  const sdM = Math.sqrt(priorMorn.reduce((s, x) => s + (x - meanM) ** 2, 0) / (priorMorn.length - 1));

  sessions[i].zSession = sdS > 0 ? (sessions[i].sessionVol - meanS) / sdS : null;
  sessions[i].zMorning = sdM > 0 ? (sessions[i].morningVol - meanM) / sdM : null;
}

const scored = sessions.filter(s => s.zMorning != null && s.zSession != null);
console.log(`Total sessions with full data: ${sessions.length}`);
console.log(`Sessions with valid z-scores (after ${N_BASELINE}-session warm-up): ${scored.length}`);

// ── STEP 2: distribution at multiple thresholds ─────────────────────────────
console.log(`\n=== Z-SCORE DISTRIBUTION (z_morning, the morning-specific measure) ===`);
for (const thresh of [1, 1.5, 2]) {
  const high = scored.filter(s => s.zMorning >= thresh).length;
  const low = scored.filter(s => s.zMorning <= -thresh).length;
  const normal = scored.length - high - low;
  console.log(`  z>=+${thresh} (HIGH): ${high}  |  z<=-${thresh} (LOW): ${low}  |  NORMAL: ${normal}`);
}
console.log(`\n=== Z-SCORE DISTRIBUTION (z_session, full-RTH measure) ===`);
for (const thresh of [1, 1.5, 2]) {
  const high = scored.filter(s => s.zSession >= thresh).length;
  const low = scored.filter(s => s.zSession <= -thresh).length;
  const normal = scored.length - high - low;
  console.log(`  z>=+${thresh} (HIGH): ${high}  |  z<=-${thresh} (LOW): ${low}  |  NORMAL: ${normal}`);
}

// Chosen threshold: 1.0 on z_morning (see report for justification)
const HIGH_THRESH = 1.0;
const LOW_THRESH = -1.0;

for (const s of scored) {
  if (s.zMorning >= HIGH_THRESH) {
    s.regime = s.trend_str >= 0.50 ? 'HIGH-VOL-DIRECTIONAL' : 'HIGH-VOL-CHOP';
  } else if (s.zMorning <= LOW_THRESH) {
    s.regime = 'LOW-VOL';
  } else {
    s.regime = 'NORMAL-VOL';
  }
}

console.log(`\n=== REGIME DISTRIBUTION (threshold z_morning >=+${HIGH_THRESH} / <=${LOW_THRESH}) ===`);
const regimeCounts = {};
for (const s of scored) regimeCounts[s.regime] = (regimeCounts[s.regime] || 0) + 1;
for (const [r, c] of Object.entries(regimeCounts)) console.log(`  ${r.padEnd(22)} n=${c}`);

// ── STEP 3: setup outcomes by regime ────────────────────────────────────────
const fired = JSON.parse(fs.readFileSync('/tmp/all_setups_replay.json', 'utf8'));
const regimeByDate = {};
for (const s of scored) regimeByDate[s.trade_date] = s.regime;

for (const f of fired) f.regime = regimeByDate[f.trade_date] ?? null;
const firedScored = fired.filter(f => f.regime != null);

function summarize(rows) {
  const hits = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const stops = rows.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = rows.filter(r => r.resolution === 'EXPIRED').length;
  const decided = hits + stops;
  const wr = decided ? (hits / decided * 100).toFixed(1) : 'n/a';
  return { n: rows.length, hits, stops, expired, decided, wr };
}

console.log(`\n=== STEP 3a: OVERALL setup outcomes by regime (all setup types pooled) ===`);
for (const regime of ['HIGH-VOL-DIRECTIONAL', 'HIGH-VOL-CHOP', 'NORMAL-VOL', 'LOW-VOL']) {
  const rows = firedScored.filter(f => f.regime === regime);
  const s = summarize(rows);
  const flag = s.decided < 20 ? '  [LIMITED SAMPLE n<20]' : '';
  console.log(`  ${regime.padEnd(22)} fired=${String(s.n).padEnd(4)} TARGET_HIT=${String(s.hits).padEnd(3)} STOP_HIT=${String(s.stops).padEnd(3)} EXPIRED=${String(s.expired).padEnd(3)} winRate=${s.wr}% (n=${s.decided})${flag}`);
}

console.log(`\n=== STEP 3b: PER-SETUP-TYPE outcomes by regime (only types with >=10 total fires) ===`);
const byType = {};
for (const f of firedScored) (byType[f.type] ??= []).push(f);
for (const [type, rows] of Object.entries(byType)) {
  if (rows.length < 10) continue;
  console.log(`\n  ${type}:`);
  for (const regime of ['HIGH-VOL-DIRECTIONAL', 'HIGH-VOL-CHOP', 'NORMAL-VOL', 'LOW-VOL']) {
    const subset = rows.filter(r => r.regime === regime);
    if (!subset.length) continue;
    const s = summarize(subset);
    const flag = s.decided < 20 ? '  [LIMITED SAMPLE n<20]' : '';
    console.log(`    ${regime.padEnd(22)} fired=${String(s.n).padEnd(4)} TARGET_HIT=${String(s.hits).padEnd(3)} STOP_HIT=${String(s.stops).padEnd(3)} EXPIRED=${String(s.expired).padEnd(3)} winRate=${s.wr}% (n=${s.decided})${flag}`);
  }
}

// ── STEP 4: redundancy vs day_type ──────────────────────────────────────────
console.log(`\n=== STEP 4a: REGIME vs DAY_TYPE CROSS-TAB ===`);
const crossTab = {};
for (const s of scored) {
  const dt = s.dayType ?? '(none)';
  crossTab[s.regime] ??= {};
  crossTab[s.regime][dt] = (crossTab[s.regime][dt] || 0) + 1;
}
for (const [regime, dts] of Object.entries(crossTab)) {
  const total = Object.values(dts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(dts).map(([dt, c]) => `${dt}=${c} (${(c/total*100).toFixed(0)}%)`).join(', ');
  console.log(`  ${regime.padEnd(22)} n=${total}  ->  ${parts}`);
}

// ── This morning / yesterday's z-scores, if available ───────────────────────
console.log(`\n=== RECENT SESSIONS (most recent with valid z-score) ===`);
const recent = scored.slice(-5);
for (const s of recent) {
  console.log(`  ${s.trade_date}  zMorning=${s.zMorning.toFixed(2)}  zSession=${s.zSession.toFixed(2)}  trend_str=${s.trend_str.toFixed(2)}  regime=${s.regime}  dayType=${s.dayType}`);
}

fs.writeFileSync('/tmp/vol_regime_sessions.json', JSON.stringify(scored, null, 2));
await pool.end();
