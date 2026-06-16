// Developing-value tracker — SINGLE SOURCE OF TRUTH for "where is value building".
//
// DESCRIPTIVE ONLY. This module makes no prediction and emits no signal/rating.
// It reports the state of the developing auction (POC/VAH/VAL, migration vs the
// prior session, hold-vs-reject, and rolling multi-session drift) so morning
// prep, afternoon review, and weekly review all read the SAME computed values
// from the developing_value_log table.
//
// All POC/VAH/VAL values are OHLC-DERIVED APPROXIMATIONS: each 1-min bar's
// volume is spread evenly across its high-low tick range (tearsheet.js
// spread-volume method — same as scripts/acceptance_engine_backtest.js),
// NOT a tick-true Market Profile. Every consumer must label them as such.
//
// The acceptance backtest (scripts/acceptance_engine_backtest.js) showed
// intraday migration direction does NOT predict day outcomes — so this module
// must not be turned into a signal. It exists purely for situational
// awareness: "value has been building higher/lower/holding", full stop.

import { query } from '../db.js';

const RTH_START = 570; // 9:30 ET
const RTH_END = 960;   // 16:00 ET
const TICK = 0.25;
const round = p => Math.round(p / TICK) * TICK;

// ── Profile computation (tearsheet.js-style spread-volume approximation) ───
export function computeProfile(bars) {
  if (!bars.length) return null;
  const volMap = {};
  for (const b of bars) {
    const h = b.high, l = b.low, v = b.volume;
    if (!(h >= l)) continue;
    const levels = Math.max(1, Math.round((h - l) / TICK) + 1);
    const vpl = v / levels;
    for (let p = l; p <= h + TICK / 2; p += TICK) {
      const lvl = round(p);
      volMap[lvl] = (volMap[lvl] || 0) + vpl;
    }
  }
  const entries = Object.entries(volMap).map(([p, v]) => ({ price: parseFloat(p), volume: v })).sort((a,b)=>a.price-b.price);
  if (entries.length < 3) return null;
  const totalVol = entries.reduce((s,l)=>s+l.volume,0);
  const maxVol = Math.max(...entries.map(l=>l.volume));
  const pocIdx = entries.findIndex(l => l.volume === maxVol);
  let vaVol = entries[pocIdx].volume;
  let upI = pocIdx + 1, dnI = pocIdx - 1;
  while (vaVol < totalVol * 0.70 && (upI < entries.length || dnI >= 0)) {
    const upAdd = upI < entries.length ? entries[upI].volume : 0;
    const dnAdd = dnI >= 0 ? entries[dnI].volume : 0;
    if (upAdd >= dnAdd && upI < entries.length) { vaVol += upAdd; upI++; }
    else if (dnI >= 0) { vaVol += dnAdd; dnI--; }
    else { vaVol += upAdd; upI++; }
  }
  const vah = entries[upI-1]?.price ?? entries[pocIdx].price;
  const val = entries[dnI+1]?.price ?? entries[pocIdx].price;
  return { poc: entries[pocIdx].price, vah, val, maxVol, totalVol };
}

// ── Migration descriptor vs the prior session's persisted profile ──────────
// HOLDING threshold = 10% of the prior session's VA width (descriptive
// heuristic — not tuned/validated as a predictive cutoff).
function describeMigration(profile, sessionHigh, sessionLow, sessionClose, prior) {
  if (!prior) {
    return { pocDelta: null, vaOverlapPct: null, migrationDir: null, holdReject: null };
  }
  const priorVAWidth = prior.vah - prior.val;
  const threshold = Math.max(0.25, 0.10 * priorVAWidth); // floor of 1 tick-ish (0.25)
  const pocDelta = profile.poc - prior.poc;
  let migrationDir;
  if (Math.abs(pocDelta) < threshold) migrationDir = 'HOLDING';
  else migrationDir = pocDelta > 0 ? 'HIGHER' : 'LOWER';

  const overlapLo = Math.max(profile.val, prior.val);
  const overlapHi = Math.min(profile.vah, prior.vah);
  const overlap = Math.max(0, overlapHi - overlapLo);
  const unionWidth = Math.max(profile.vah, prior.vah) - Math.min(profile.val, prior.val);
  const vaOverlapPct = unionWidth > 0 ? overlap / unionWidth : 1;

  let holdReject = 'N/A';
  if (migrationDir === 'HIGHER') holdReject = sessionClose > prior.vah ? 'ACCEPTED' : 'REJECTED';
  else if (migrationDir === 'LOWER') holdReject = sessionClose < prior.val ? 'ACCEPTED' : 'REJECTED';

  return { pocDelta, vaOverlapPct, migrationDir, holdReject };
}

// ── Compute + persist one session's developing-value row ───────────────────
// Requires the prior session's row to already be persisted (sequential backfill).
export async function computeAndPersistSession(tradeDate) {
  const barsQ = await query(`
    SELECT open::float, high::float, low::float, close::float, volume::float
    FROM price_bars
    WHERE symbol='NQ' AND ts::date=$1
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END-1}
    ORDER BY ts
  `, [tradeDate]);
  const bars = barsQ.rows;
  if (bars.length < 60) return null;

  const profile = computeProfile(bars);
  if (!profile) return null;

  const sessionHigh = Math.max(...bars.map(b=>b.high));
  const sessionLow = Math.min(...bars.map(b=>b.low));
  const sessionClose = bars[bars.length-1].close;

  const priorQ = await query(`SELECT poc::float, vah::float, val::float FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [tradeDate]);
  const prior = priorQ.rows[0] || null;
  const mig = describeMigration(profile, sessionHigh, sessionLow, sessionClose, prior);

  await query(`
    INSERT INTO developing_value_log
      (trade_date, poc, vah, val, session_high, session_low, session_close, poc_delta_vs_prior, va_overlap_pct_vs_prior, migration_dir_vs_prior, hold_or_reject_vs_prior)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (trade_date) DO UPDATE SET
      poc=$2, vah=$3, val=$4, session_high=$5, session_low=$6, session_close=$7,
      poc_delta_vs_prior=$8, va_overlap_pct_vs_prior=$9, migration_dir_vs_prior=$10, hold_or_reject_vs_prior=$11, computed_at=now()
  `, [tradeDate, profile.poc, profile.vah, profile.val, sessionHigh, sessionLow, sessionClose, mig.pocDelta, mig.vaOverlapPct, mig.migrationDir, mig.holdReject]);

  return { trade_date: tradeDate, poc: profile.poc, vah: profile.vah, val: profile.val, sessionHigh, sessionLow, sessionClose, ...mig };
}

// ── Live (in-progress) developing profile for "today" — PROVISIONAL ────────
// Not persisted: an in-progress session's profile is built on thin/partial
// volume and will keep shifting until the close.
export async function computeLiveSession(tradeDate) {
  const barsQ = await query(`
    SELECT open::float, high::float, low::float, close::float, volume::float
    FROM price_bars
    WHERE symbol='NQ' AND ts::date=$1
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN ${RTH_START} AND ${RTH_END-1}
    ORDER BY ts
  `, [tradeDate]);
  const bars = barsQ.rows;
  if (bars.length < 10) return null;

  const profile = computeProfile(bars);
  if (!profile) return null;

  const sessionHigh = Math.max(...bars.map(b=>b.high));
  const sessionLow = Math.min(...bars.map(b=>b.low));
  const sessionClose = bars[bars.length-1].close;

  const priorQ = await query(`SELECT poc::float, vah::float, val::float FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 1`, [tradeDate]);
  const prior = priorQ.rows[0] || null;
  const mig = describeMigration(profile, sessionHigh, sessionLow, sessionClose, prior);

  return { trade_date: tradeDate, poc: profile.poc, vah: profile.vah, val: profile.val, sessionHigh, sessionLow, sessionClose, ...mig, barsUsed: bars.length, provisional: true };
}

// ── Rolling multi-session drift (the more trustworthy, longer-horizon read) ─
// Purely descriptive: reports POC movement and the tally of HIGHER/LOWER/
// HOLDING migrations over the trailing window. "BUILDING HIGHER/LOWER" here
// means "POC has moved in that direction over the window" — not a forecast.
export async function getRollingDrift(asOfDate, windowSizes = [5, 10, 20]) {
  const maxWindow = Math.max(...windowSizes);
  const rowsQ = await query(`
    SELECT trade_date::text, poc::float, vah::float, val::float, migration_dir_vs_prior
    FROM developing_value_log
    WHERE trade_date < $1
    ORDER BY trade_date DESC
    LIMIT $2
  `, [asOfDate, maxWindow]);
  const rows = rowsQ.rows.slice().reverse(); // oldest-first

  const out = {};
  for (const w of windowSizes) {
    const slice = rows.slice(-w);
    if (slice.length < Math.min(w, 5)) { out[w] = { available: false, n: slice.length }; continue; }
    const first = slice[0], last = slice[slice.length-1];
    const pocChange = last.poc - first.poc;
    const tally = { HIGHER: 0, LOWER: 0, HOLDING: 0 };
    for (const r of slice) if (r.migration_dir_vs_prior) tally[r.migration_dir_vs_prior] = (tally[r.migration_dir_vs_prior]||0)+1;

    // Descriptive drift label based on net POC movement relative to the
    // window's own POC range (purely a "how far did it move" descriptor).
    const pocVals = slice.map(r=>r.poc);
    const pocRange = Math.max(...pocVals) - Math.min(...pocVals);
    let drift = 'BALANCING';
    if (pocRange > 0) {
      if (pocChange > 0.25 * pocRange) drift = 'BUILDING HIGHER';
      else if (pocChange < -0.25 * pocRange) drift = 'BUILDING LOWER';
    }

    out[w] = {
      available: true, n: slice.length,
      firstDate: first.trade_date, lastDate: last.trade_date,
      pocStart: first.poc, pocEnd: last.poc, pocChange,
      tally, drift,
    };
  }
  return out;
}

// ── Combined context for consumers (morning prep / afternoon review / weekly) ──
// `date` = the session to center on. If a persisted row exists for `date`,
// it's returned as the "current" session (final). Otherwise, if `date` is
// today (or has partial bars), a live/provisional read is computed but NOT
// persisted. Rolling drift always uses persisted (completed) sessions prior
// to `date`.
export async function getDevelopingValueContext(date, windowSizes = [5, 10, 20]) {
  const persistedQ = await query(`SELECT trade_date::text, poc::float, vah::float, val::float, session_high::float, session_low::float, session_close::float, poc_delta_vs_prior::float as "pocDelta", va_overlap_pct_vs_prior::float as "vaOverlapPct", migration_dir_vs_prior as "migrationDir", hold_or_reject_vs_prior as "holdReject" FROM developing_value_log WHERE trade_date=$1`, [date]);
  let current = persistedQ.rows[0] || null;
  if (current) current = { ...current, provisional: false };
  if (!current) {
    current = await computeLiveSession(date);
  }

  const rolling = await getRollingDrift(date, windowSizes);
  const historyQ = await query(`SELECT trade_date::text, poc::float, vah::float, val::float, migration_dir_vs_prior as "migrationDir" FROM developing_value_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 20`, [date]);

  return {
    method: 'OHLC-derived approximation (tearsheet.js spread-volume method): not a tick-true Market Profile.',
    descriptive_only: true,
    date,
    current,
    rolling,
    history: historyQ.rows.slice().reverse(),
  };
}
