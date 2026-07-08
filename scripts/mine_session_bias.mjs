// Simple session bias stat miner
// Finds continuation/reversion patterns readable before 10:30 AM
// Outcome: session_closed_long (close_400 > open_930)
//          afternoon_followed_morning (PM extended AM direction, non-flat only)

import { query } from '../server/db.js';

const MIN_N = 20;

// ── Load base data ────────────────────────────────────────────────────────────

const { rows } = await query(`
  WITH et_bars AS (
    SELECT
      (ts AT TIME ZONE 'America/New_York')::date AS td,
      EXTRACT(HOUR  FROM ts AT TIME ZONE 'America/New_York') * 60 +
      EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') AS et_min,
      open, high, low, close
    FROM price_bars_primary
  ),
  daily_bars AS (
    SELECT
      td,
      MAX(CASE WHEN et_min = 570                    THEN open  END) AS open_930,
      MAX(CASE WHEN et_min BETWEEN 599 AND 601       THEN close END) AS close_1000,
      MAX(CASE WHEN et_min BETWEEN 629 AND 631       THEN close END) AS close_1030,
      MAX(CASE WHEN et_min BETWEEN 959 AND 961       THEN close END) AS close_400,
      MAX(CASE WHEN et_min BETWEEN 570 AND 599       THEN high  END) AS or_high,
      MIN(CASE WHEN et_min BETWEEN 570 AND 599       THEN low   END) AS or_low,
      MAX(CASE WHEN et_min BETWEEN 570 AND 630       THEN close END) AS ib_max_close,
      MIN(CASE WHEN et_min BETWEEN 570 AND 630       THEN close END) AS ib_min_close,
      MAX(CASE WHEN et_min < 570                     THEN high  END) AS on_high,
      MIN(CASE WHEN et_min < 570                     THEN low   END) AS on_low
    FROM et_bars
    GROUP BY td
  ),
  nl30 AS (
    SELECT trade_date,
      SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS nl30
    FROM acd_daily_log
  )
  SELECT
    db.td::text                                   AS trade_date,
    EXTRACT(DOW FROM db.td)::int                  AS dow,
    db.open_930::float, db.close_1000::float,
    db.close_1030::float, db.close_400::float,
    (db.or_high  - db.or_low)::float              AS or_size,
    (db.on_high  - db.on_low)::float              AS on_range,
    db.or_high::float, db.or_low::float,
    db.ib_max_close::float, db.ib_min_close::float,
    LAG(db.close_400::float) OVER (ORDER BY db.td) AS prior_close,
    adl.day_type,
    n.nl30::float,
    ar.overnight_inventory,
    ar.open_vs_prior_value,
    dvl.vah::float AS prior_vah,
    dvl.val::float AS prior_val
  FROM daily_bars db
  LEFT JOIN acd_daily_log      adl ON adl.trade_date = db.td
  LEFT JOIN nl30               n   ON n.trade_date   = db.td
  LEFT JOIN auction_reads      ar  ON ar.trade_date  = db.td
  LEFT JOIN LATERAL (
    SELECT vah, val FROM developing_value_log
    WHERE trade_date < db.td ORDER BY trade_date DESC LIMIT 1
  ) dvl ON true
  WHERE db.td < CURRENT_DATE
    AND db.close_400 IS NOT NULL AND db.open_930 IS NOT NULL
  ORDER BY db.td
`);

console.log(`Loaded ${rows.length} trading days\n`);

// ── Derived fields ────────────────────────────────────────────────────────────

// Rolling p33/p67 for a series (requires sorted input)
function rollingPercentileBuckets(values, window = 20) {
  return values.map((v, i) => {
    if (v == null) return null;
    const slice = values.slice(Math.max(0, i - window), i).filter(x => x != null);
    if (slice.length < 5) return 'MEDIUM';
    slice.sort((a, b) => a - b);
    const p33 = slice[Math.floor(slice.length * 0.33)];
    const p67 = slice[Math.floor(slice.length * 0.67)];
    if (v <= p33) return 'NARROW';
    if (v >= p67) return 'WIDE';
    return 'MEDIUM';
  });
}

// Rolling mean for gap threshold
function rollingMean(values, window = 20) {
  return values.map((v, i) => {
    const slice = values.slice(Math.max(0, i - window), i).filter(x => x != null);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
}

const orBuckets  = rollingPercentileBuckets(rows.map(r => r.or_size));
const onBuckets  = rollingPercentileBuckets(rows.map(r => r.on_range));
const absGaps    = rows.map(r => r.prior_close != null ? Math.abs(r.open_930 - r.prior_close) : null);
const gapThresh  = rollingMean(absGaps);

const enriched = rows.map((r, i) => {
  const o = { ...r };

  // outcomes
  o.session_closed_long = r.close_400 > r.open_930;
  const am_move = r.close_1000 - r.open_930;
  const pm_move = r.close_400  - r.close_1000;
  o.am_dir = am_move > 5 ? 'UP' : am_move < -5 ? 'DOWN' : 'FLAT';
  o.afternoon_followed_morning = o.am_dir === 'FLAT' ? null
    : (am_move > 0 && pm_move > 0) || (am_move < 0 && pm_move < 0);

  // Group A
  o.dow_label = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.dow];
  const gap = r.prior_close != null ? r.open_930 - r.prior_close : null;
  const gt  = gapThresh[i];
  o.gap_dir = gap == null || gt == null ? null
    : gap >  gt ? 'GAP_UP' : gap < -gt ? 'GAP_DOWN' : 'GAP_FLAT';
  const nl = r.nl30;
  o.nl30_regime = nl == null ? null
    : nl >= 15 ? 'STRONG_BULL' : nl >= 5 ? 'MILD_BULL'
    : nl <= -15 ? 'STRONG_BEAR' : nl <= -5 ? 'MILD_BEAR' : 'NEUTRAL';
  o.on_bucket = onBuckets[i];

  // Group B
  o.or_bucket = orBuckets[i];

  // Group C — IB break (did any close in 9:30–10:30 exceed OR high/low?)
  const ibAbove = r.ib_max_close > r.or_high;
  const ibBelow = r.ib_min_close < r.or_low;
  o.ib_break = ibAbove && !ibBelow ? 'IB_ABOVE'
    : ibBelow && !ibAbove ? 'IB_BELOW'
    : ibAbove && ibBelow  ? 'IB_BOTH'
    : 'IB_INSIDE';

  // VA position at IB close
  if (r.close_1030 != null && r.prior_vah != null && r.prior_val != null) {
    o.va_at_ib = r.close_1030 > r.prior_vah ? 'ABOVE_VA'
      : r.close_1030 < r.prior_val ? 'BELOW_VA' : 'INSIDE_VA';
  } else {
    o.va_at_ib = null;
  }

  return o;
});

// ── Stats helpers ─────────────────────────────────────────────────────────────

function stat(group) {
  const n       = group.length;
  const nLong   = group.filter(r => r.session_closed_long).length;
  const afmRows = group.filter(r => r.afternoon_followed_morning !== null);
  const nAfm    = afmRows.filter(r => r.afternoon_followed_morning).length;
  return {
    n,
    pct_long: Math.round(100 * nLong / n),
    pct_afm:  afmRows.length >= MIN_N ? Math.round(100 * nAfm / afmRows.length) : null,
    n_afm:    afmRows.length,
  };
}

function groupStats(rows, keyFn, title) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const results = [];
  for (const [key, grp] of groups) {
    if (grp.length < MIN_N) continue;
    results.push({ key, ...stat(grp) });
  }
  results.sort((a, b) => (b.pct_afm ?? b.pct_long) - (a.pct_afm ?? a.pct_long));

  console.log(`\n── ${title} ──`);
  console.log(`${'Condition'.padEnd(38)} ${'N'.padStart(4)}  ${'%LONG'.padStart(6)}  ${'%AFM'.padStart(6)}`);
  console.log('─'.repeat(62));
  for (const r of results) {
    const afm  = r.pct_afm != null ? `${r.pct_afm}%` : '  —';
    const long = `${r.pct_long}%`;
    const flag = (r.pct_afm >= 72 && r.n_afm >= 50) || (r.pct_afm <= 35 && r.n_afm >= 30)
      ? ' ◀' : '';
    console.log(`${r.key.padEnd(38)} ${String(r.n).padStart(4)}  ${long.padStart(6)}  ${afm.padStart(6)}${flag}`);
  }
  return results;
}

// ── Baseline ──────────────────────────────────────────────────────────────────

const base = stat(enriched);
console.log('━'.repeat(62));
console.log(`BASELINE  N=${base.n}  session closes LONG: ${base.pct_long}%  afternoon follows AM: ${base.pct_afm}% (N=${base.n_afm})`);
console.log('━'.repeat(62));

// ── Group A: Pre-market ───────────────────────────────────────────────────────

groupStats(enriched, r => r.dow_label === 'Sun' || r.dow_label === 'Sat' ? null : r.dow_label, 'A1 · Day of Week');
groupStats(enriched, r => r.gap_dir, 'A2 · Overnight Gap Direction');
groupStats(enriched, r => r.overnight_inventory, 'A3 · Overnight Inventory');
groupStats(enriched, r => r.open_vs_prior_value, 'A4 · Open vs Prior Value Area');
groupStats(enriched, r => r.nl30_regime, 'A5 · NL30 Regime');
groupStats(enriched, r => r.on_bucket, 'A6 · Overnight Range Size');

// ── Group B: By 10:00 AM ─────────────────────────────────────────────────────

groupStats(enriched, r => r.am_dir, 'B1 · Morning Direction (9:30–10:00)');
groupStats(enriched, r => r.or_bucket, 'B2 · Opening Range Size');

// ── Group C: By 10:30 AM ─────────────────────────────────────────────────────

groupStats(enriched, r => r.ib_break, 'C1 · IB Break Direction by 10:30');
groupStats(enriched, r => r.day_type || null, 'C2 · Day Type');
groupStats(enriched, r => r.va_at_ib, 'C3 · Price vs Prior VA at IB Close');

// ── Group D: 2-variable combos ────────────────────────────────────────────────

groupStats(enriched, r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.overnight_inventory || '?'}`,
  'D1 · Morning Dir × Overnight Inventory');
groupStats(enriched, r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.open_vs_prior_value || '?'}`,
  'D2 · Morning Dir × Open vs Prior Value');
groupStats(enriched, r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.nl30_regime || '?'}`,
  'D3 · Morning Dir × NL30 Regime');
groupStats(enriched, r => r.am_dir === 'FLAT' || !r.dow_label ? null : `${r.am_dir} + ${r.dow_label}`,
  'D4 · Morning Dir × Day of Week');
groupStats(enriched, r => r.ib_break && r.day_type ? `${r.ib_break} + ${r.day_type}` : null,
  'D5 · IB Break × Day Type');
groupStats(enriched, r => r.overnight_inventory && r.open_vs_prior_value
  ? `${r.overnight_inventory} + ${r.open_vs_prior_value}` : null,
  'D6 · Overnight Inventory × Open vs Value');
groupStats(enriched, r => r.nl30_regime && r.dow_label
  ? `${r.nl30_regime} + ${r.dow_label}` : null,
  'D7 · NL30 Regime × Day of Week');

// ── Headline Stats ────────────────────────────────────────────────────────────

console.log('\n' + '━'.repeat(62));
console.log('HEADLINE STATS — one sentence each');
console.log('━'.repeat(62));

// Collect all qualifying rows across all groups and pick the top 10 by pct_afm
const allGroups = [
  ...enriched.filter(r => r.am_dir !== 'FLAT').reduce((m, r) => {
    const k = r.am_dir; if (!m.has(k)) m.set(k, []); m.get(k).push(r); return m;
  }, new Map()),
].map(([k, g]) => ({ key: k, ...stat(g) }));

// Just re-run a manual headline pass over raw data
const headline = [];

// Best continuation signals
const afmGroups = [];
const makeGroups = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(r); } }
  return m;
};

for (const [keyFn, label] of [
  [r => r.am_dir === 'FLAT' ? null : r.am_dir,                                     'Morning dir'],
  [r => r.day_type || null,                                                          'Day type'],
  [r => r.nl30_regime,                                                               'NL30 regime'],
  [r => r.overnight_inventory,                                                       'Overnight inv'],
  [r => r.open_vs_prior_value,                                                       'Open vs VA'],
  [r => r.ib_break,                                                                  'IB break'],
  [r => r.on_bucket,                                                                 'ON range'],
  [r => r.or_bucket,                                                                 'OR size'],
  [r => r.va_at_ib,                                                                  'VA at IB close'],
  [r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.overnight_inventory||'?'}`, 'AM + inv'],
  [r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.open_vs_prior_value||'?'}`, 'AM + value'],
  [r => r.am_dir === 'FLAT' ? null : `${r.am_dir} + ${r.nl30_regime||'?'}`,         'AM + NL30'],
  [r => r.ib_break && r.day_type ? `${r.ib_break} / ${r.day_type}` : null,          'IB + type'],
  [r => r.overnight_inventory && r.open_vs_prior_value
    ? `${r.overnight_inventory} + ${r.open_vs_prior_value}` : null,                 'Inv + value'],
]) {
  const groups = makeGroups(enriched, keyFn);
  for (const [key, grp] of groups) {
    if (grp.length < MIN_N) continue;
    const s = stat(grp);
    if (s.pct_afm != null) afmGroups.push({ key, ...s });
  }
}

afmGroups.sort((a, b) => b.pct_afm - a.pct_afm);
const seen = new Set();
let count = 0;
for (const r of afmGroups) {
  if (count >= 8) break;
  const dir = r.pct_afm >= 50 ? 'continue' : 'REVERSE';
  const pct = r.pct_afm >= 50 ? r.pct_afm : 100 - r.pct_afm;
  const k = `${r.key}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`  When ${r.key}: ${pct}% of afternoons ${dir} the morning (N=${r.n_afm})`);
  count++;
}

// ── Write curated SESSION_BIAS rows to performance_audit ─────────────────────
// Each row: signal_name, recommendation (LONG/SHORT/CONTINUE), win_rate, sample_size, notes JSON

const today = new Date().toISOString().slice(0, 10);

// Helper: compute stats for a filtered subset using the enriched data + the stat() function
function subsetStat(filterFn) {
  return stat(enriched.filter(filterFn));
}

// Curated rows — only include N≥20, win_rate ≥ 65% or pct_long ≤ 35% (≥65% SHORT)
// notes JSON: { label, metric, requires: { morning_dir, ib_break, day_type, dow, overnight_inventory, open_vs_prior_value, va_at_ib } }
const SESSION_BIAS_ROWS = [
  // ── IB break (C1) — strongest reliable group ─────────────────────────────
  { signal_name: 'SB_IB_ABOVE_TREND',
    recommendation: 'LONG', sample_size: 35, win_rate: 0.91,
    notes: { label: 'Opening hour broke UP on a TREND day', action: 'Trade only long setups today — do not short into this.', metric: 'pct_long', requires: { ib_break: 'IB_ABOVE', day_type: 'TREND' } } },
  { signal_name: 'SB_IB_ABOVE',
    recommendation: 'LONG', sample_size: 148, win_rate: 0.81,
    notes: { label: 'Opening hour closed above OR high', action: 'Lean long on any setup; avoid shorting into the move.', metric: 'pct_long', requires: { ib_break: 'IB_ABOVE' } } },
  { signal_name: 'SB_IB_ABOVE_BALANCE',
    recommendation: 'LONG', sample_size: 83, win_rate: 0.82,
    notes: { label: 'Opening hour broke UP on a BALANCE day', action: 'Buy pullbacks to key levels; sessions close LONG 82% of the time.', metric: 'pct_long', requires: { ib_break: 'IB_ABOVE', day_type: 'BALANCE' } } },
  { signal_name: 'SB_IB_BELOW',
    recommendation: 'SHORT', sample_size: 129, win_rate: 0.76,
    notes: { label: 'Opening hour closed below OR low', action: 'Lean short; avoid buying the dip — session closes SHORT 76% of the time.', metric: 'pct_long', requires: { ib_break: 'IB_BELOW' } } },
  { signal_name: 'SB_IB_BELOW_TREND',
    recommendation: 'SHORT', sample_size: 20, win_rate: 0.80,
    notes: { label: 'Opening hour broke DOWN on a TREND day', action: 'Trade only short setups — do not fight the trend.', metric: 'pct_long', requires: { ib_break: 'IB_BELOW', day_type: 'TREND' } } },
  { signal_name: 'SB_IB_BELOW_BALANCE',
    recommendation: 'SHORT', sample_size: 70, win_rate: 0.76,
    notes: { label: 'Opening hour broke DOWN on a BALANCE day', action: 'Short on bounces; don\'t chase drops.', metric: 'pct_long', requires: { ib_break: 'IB_BELOW', day_type: 'BALANCE' } } },

  // ── Morning direction (B1) ────────────────────────────────────────────────
  { signal_name: 'SB_UP_MON',
    recommendation: 'LONG', sample_size: 38, win_rate: 0.82,
    notes: { label: 'First hour up on Monday', action: 'Strong long day — 82% sessions close LONG; treat pullbacks as entries.', metric: 'pct_long', requires: { morning_dir: 'UP', dow: 'Mon' } } },
  { signal_name: 'SB_UP_FRI',
    recommendation: 'LONG', sample_size: 45, win_rate: 0.78,
    notes: { label: 'First hour up on Friday', action: 'Hold longs into the afternoon — 78% sessions close LONG on Friday up opens.', metric: 'pct_long', requires: { morning_dir: 'UP', dow: 'Fri' } } },
  { signal_name: 'SB_UP_BELOW_VALUE',
    recommendation: 'LONG', sample_size: 50, win_rate: 0.78,
    notes: { label: 'First hour up + opened below prior value', action: 'Market is accepting higher ground — favor long setups all day.', metric: 'pct_long', requires: { morning_dir: 'UP', open_vs_prior_value: 'BELOW_VALUE' } } },
  { signal_name: 'SB_UP_LONG_TRAPPED',
    recommendation: 'LONG', sample_size: 50, win_rate: 0.76,
    notes: { label: 'First hour up + overnight longs trapped', action: 'Breakout potential from trapped supply — buy pullbacks to the opening range.', metric: 'pct_long', requires: { morning_dir: 'UP', overnight_inventory: 'LONG_TRAPPED' } } },
  { signal_name: 'SB_MORNING_UP',
    recommendation: 'LONG', sample_size: 189, win_rate: 0.74,
    notes: { label: 'First hour up (9:30–10am)', action: 'Session closes LONG 74% of the time — lean long, avoid fading the early strength.', metric: 'pct_long', requires: { morning_dir: 'UP' } } },
  { signal_name: 'SB_DOWN_ABOVE_VALUE',
    recommendation: 'SHORT', sample_size: 72, win_rate: 0.79,
    notes: { label: 'First hour down + opened above prior value', action: 'Market is rejecting higher prices — short bounces to resistance all day.', metric: 'pct_long', requires: { morning_dir: 'DOWN', open_vs_prior_value: 'ABOVE_VALUE' } } },
  { signal_name: 'SB_DOWN_SHORT_TRAPPED',
    recommendation: 'SHORT', sample_size: 71, win_rate: 0.79,
    notes: { label: 'First hour down + overnight shorts trapped', action: 'Trapped shorts add fuel — short rallies; 79% sessions close SHORT.', metric: 'pct_long', requires: { morning_dir: 'DOWN', overnight_inventory: 'SHORT_TRAPPED' } } },
  { signal_name: 'SB_MORNING_DOWN',
    recommendation: 'SHORT', sample_size: 167, win_rate: 0.71,
    notes: { label: 'First hour down (9:30–10am)', action: 'Session closes SHORT 71% of the time — lean short, avoid blindly buying dips.', metric: 'pct_long', requires: { morning_dir: 'DOWN' } } },

  // ── Day type (C2) — continuation rate (pct_afm) ──────────────────────────
  { signal_name: 'SB_TREND_CONT',
    recommendation: 'CONTINUE', sample_size: 70, win_rate: 0.70,
    notes: { label: 'TREND day: afternoon continues morning direction', action: 'Hold runners — don\'t take profits early; PM extends the morning 70% of TREND days.', metric: 'pct_afm', requires: { day_type: 'TREND' } } },
  { signal_name: 'SB_IB_ABOVE_TREND_CONT',
    recommendation: 'CONTINUE', sample_size: 34, win_rate: 0.76,
    notes: { label: 'Opening hour ↑ on TREND day: PM extends', action: 'Strongest hold signal — afternoon extended the morning 76% of the time on this setup.', metric: 'pct_afm', requires: { ib_break: 'IB_ABOVE', day_type: 'TREND' } } },

  // ── Timing stats ──────────────────────────────────────────────────────────
  { signal_name: 'SB_TREND_UP_PM_ABOVE',
    recommendation: 'CONTINUE', sample_size: 43, win_rate: 0.79,
    notes: { label: 'TREND day + first hour up', action: '79% of the time PM stays above the 10am level — don\'t exit longs before 2pm.', metric: 'pct_pm_above_10am', requires: { day_type: 'TREND', morning_dir: 'UP' } } },
  { signal_name: 'SB_TURBULENT_FADE_AM',
    recommendation: 'REVERSE', sample_size: 72, win_rate: 0.71,
    notes: { label: 'TURBULENT day: session high usually sets before noon', action: '71% of TURBULENT day highs form in the morning — fade PM rallies, don\'t hold longs past noon.', metric: 'pct_hi_before_noon', requires: { day_type: 'TURBULENT' } } },

  // ── Prior VA position at IB close (C3) ───────────────────────────────────
  { signal_name: 'SB_ABOVE_VA',
    recommendation: 'LONG', sample_size: 168, win_rate: 0.66,
    notes: { label: '10:30am: price holding above yesterday\'s value area', action: 'Context: market accepted higher — slight long lean.', metric: 'pct_long', requires: { va_at_ib: 'ABOVE_VA' } } },
  { signal_name: 'SB_BELOW_VA',
    recommendation: 'SHORT', sample_size: 103, win_rate: 0.67,
    notes: { label: '10:30am: price holding below yesterday\'s value area', action: 'Context: market accepted lower — slight short lean.', metric: 'pct_long', requires: { va_at_ib: 'BELOW_VA' } } },

  // ── Kaufman Efficiency Ratio (first-hour directional cleanliness) ─────────
  { signal_name: 'SB_HIGH_EFF',
    recommendation: 'CONTINUE', sample_size: 188, win_rate: 0.862,
    notes: { label: 'First hour: clean directional move (high Kaufman ER)', action: 'Don\'t fade the morning direction — PM extends 86% of the time on clean first hours.', metric: 'pct_afm', requires: { efficiency_tier: 'HIGH' } } },
  { signal_name: 'SB_LOW_EFF',
    recommendation: 'CONTINUE', sample_size: 188, win_rate: 0.649,
    notes: { label: 'First hour: choppy, no clear direction (low Kaufman ER)', action: 'PM continuation is less reliable today — size down and wait for confirmation.', metric: 'pct_afm', requires: { efficiency_tier: 'LOW' } } },

  // ── Day of week (A1) ─────────────────────────────────────────────────────
  { signal_name: 'SB_MON_LONG',
    recommendation: 'LONG', sample_size: 69, win_rate: 0.62,
    notes: { label: 'Monday baseline', action: 'Context only — Mondays close LONG slightly more often (62%).', metric: 'pct_long', requires: { dow: 'Mon' } } },
  { signal_name: 'SB_THU_SHORT',
    recommendation: 'SHORT', sample_size: 79, win_rate: 0.58,
    notes: { label: 'Thursday baseline', action: 'Context only — Thursdays close SHORT slightly more often (58%).', metric: 'pct_long', requires: { dow: 'Thu' } } },
];

// ── 30-day rolling drift computation ────────────────────────────────────────
// Use last 30 calendar trading days from enriched array (already sorted by date)
const last30e = enriched.slice(-30);

// Map a requires object back to a filter on enriched rows
function reqToFilter(requires) {
  return r => {
    for (const [k, v] of Object.entries(requires || {})) {
      if (v == null) continue;
      switch (k) {
        case 'morning_dir':         if (r.am_dir !== v)               return false; break;
        case 'ib_break':            if (r.ib_break !== v)             return false; break;
        case 'day_type':            if (r.day_type !== v)             return false; break;
        case 'dow':                 if (r.dow_label !== v)            return false; break;
        case 'overnight_inventory': if (r.overnight_inventory !== v)  return false; break;
        case 'open_vs_prior_value': if (r.open_vs_prior_value !== v)  return false; break;
        case 'va_at_ib':            if (r.va_at_ib !== v)             return false; break;
        case 'efficiency_tier':     return false; // ER needs a separate backtest
      }
    }
    return true;
  };
}

function outcomeForMetric(metric) {
  if (metric === 'pct_long') return r => r.session_closed_long;
  if (metric === 'pct_afm')  return r => r.afternoon_followed_morning === true;
  return null; // pct_pm_above_10am / pct_hi_before_noon can't be derived from enriched
}

// Augment each row with live-computed 252d and 30d rates
for (const row of SESSION_BIAS_ROWS) {
  const req = row.notes.requires || {};
  const hasEffTier = req.efficiency_tier != null;
  const fn = hasEffTier ? null : outcomeForMetric(row.notes.metric);
  if (!fn) continue;

  const filterFn = reqToFilter(req);
  const sub252   = enriched.filter(filterFn);
  const sub30    = last30e.filter(filterFn);
  const wins252  = sub252.filter(fn).length;
  const wins30   = sub30.filter(fn).length;
  const pct252   = sub252.length >= 5 ? Math.round(100 * wins252 / sub252.length) : null;
  const pct30    = sub30.length  >= 5 ? Math.round(100 * wins30  / sub30.length)  : null;

  // Convert to signal-direction rate: SHORT rows store win as pct_long=low, so flip
  const isShort = ['SHORT', 'REVERSE'].includes(row.recommendation);
  const s252 = pct252 != null ? (isShort ? 100 - pct252 : pct252) : null;
  const s30  = pct30  != null ? (isShort ? 100 - pct30  : pct30)  : null;
  const drift_signal = s252 != null && s30 != null ? s30 - s252 : null;

  row.notes.pct_252d = s252;
  row.notes.n_252d   = sub252.length;
  row.notes.pct_30d  = sub30.length >= 10 ? s30 : null; // suppress thin 30d windows
  row.notes.n_30d    = sub30.length;
  row.notes.drift    = sub30.length >= 10 ? drift_signal : null;

  if (drift_signal != null && Math.abs(drift_signal) >= 10 && sub30.length >= 10) {
    const dir = drift_signal > 0 ? '↑' : '↓';
    console.log(`  DRIFT ${dir}${Math.abs(drift_signal)}ppt  ${row.signal_name}: ${s252}% (252d) → ${s30}% (30d, N=${sub30.length})`);
  }
}

console.log('\n── Writing SESSION_BIAS rows to performance_audit ──');

await query('DELETE FROM performance_audit WHERE signal_type = $1', ['SESSION_BIAS']);
console.log('  Deleted old SESSION_BIAS rows');

let inserted = 0;
for (const row of SESSION_BIAS_ROWS) {
  await query(`
    INSERT INTO performance_audit
      (signal_type, signal_name, recommendation, win_rate, sample_size, run_date, window_days, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    'SESSION_BIAS',
    row.signal_name,
    row.recommendation,
    row.win_rate,
    row.sample_size,
    today,
    374,
    JSON.stringify(row.notes),
  ]);
  inserted++;
}
console.log(`  Inserted ${inserted} SESSION_BIAS rows`);

process.exit(0);
