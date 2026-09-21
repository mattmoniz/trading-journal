// Entry-order-flow shadow tracker, 2026-09-16 (observation-only, same guarantee family as
// step_trail_shadow/pitch_catch_shadow/direction_gate_shadow/momentum_against_fade_shadow/
// breakeven_stop_shadow -- never touches a real trade's own origin_status/status/resolution/
// actual_pnl/stop_level, only writes its own JSONB column, right after the real INSERT, wrapped
// so a failure here can never affect the real row it's tagging).
//
// Backing research: scripts/backtest_price_drift_gate_phase0.mjs + backtest_price_drift_gate_
// orderflow_phase0b.mjs (2026-09-16 session). Two DIFFERENT rules, one per direction -- they do
// not behave the same, so this is deliberately not one symmetric "trend gate":
//
// LONG_REPEAT_ADVERSE_FLOW: fires when a same-setup_type LONG repeat comes in at a WORSE price
// (lower) than the last real same-setup_type LONG fire within the current session, AND the
// single 1-min bar that closed immediately before now shows net SELLING. The backtest's own
// "within 60 minutes" cutoff was flagged (by the user and independently by DeepSeek) as picked
// from a handful of ad hoc buckets (<10min/<60min looked bad, beyond ~4hr reversed), not a real
// calibrated boundary -- so it is NOT part of wouldBeFlagged below; only price direction + flow
// direction gate it, and the real elapsed minutes since the reference fire (`minutesSinceRef`)
// is stored on every row so a future recheck can derive the real cutoff from accumulated data
// instead of a guess. Tested: N=115 (RTH), EV=-$15.94/trade vs +$4.14 (worse-price alone, no flow
// condition) / +$25.72 (best cell, same-or-better price + favorable flow). NOT yet cleared for
// live gating -- DeepSeek's 2026-09-16
// design-critique review found this backtest population substantially OVERLAPS the already-live
// isSameSetupRefireBlocked() gate (shipped 2026-09-13/14): a same-setup repeat within a short
// window where no OTHER setup fired in between is already force-SHADOW'd by that gate, so this
// rule's measured -$15.94 is not necessarily its own marginal/incremental edge. Also missing: a
// LONG-only chronological-stability check (only the pooled LONG+SHORT population was checked).
// See OPEN_DECISION entry_orderflow_shadow_6week_revisit_20260916.
//
// SHORT_MORNING_ADVERSE_FLOW: fires for ANY SHORT candidate (first touch or repeat -- price-
// drift was tested and does NOT hold for shorts, so it's not part of this rule) fired in RTH
// when the single 1-min bar that closed immediately before now shows net BUYING. Tested: N=366,
// EV=-$15.75/trade vs +$4.58 -- the most rigorously checked finding of the session (48 distinct
// dates, top5DayPct=20.8%, stable across all 3 chronological thirds, strengthens to -$19.62 in
// the most recent 45 days). Does NOT transfer to Globex (tested directly: ~flat, -$4.98 vs
// -$3.64) and gets thin/noisy in the afternoon -- the backtest's own 9:30-noon window was flagged
// (by the user and independently by DeepSeek) as an arbitrary boundary picked from a few ad hoc
// buckets, not a real calibrated cutoff, so it is NOT baked into wouldBeFlagged below -- every
// RTH SHORT with adverse flow gets flagged, and the real ET-minute-of-day is stored on every row
// (`etMin`) so the 6-week revisit can derive whatever time-of-day boundary the accumulated data
// actually supports, rather than shipping a guessed one now.
//
// Both rules: RTH only, at launch -- LONG because Globex has too little real data to say
// anything yet (N=11/4), SHORT because Globex was tested and came back flat. Re-check both once
// more Globex history accumulates.
//
// SHIPPED AS OBSERVATION-ONLY (user's explicit call 2026-09-16, after an initial "wire it to
// actually prevent live/shadow trades" request was walked back once DeepSeek's design-critique
// caveats above were in front of them -- same arc as direction_gate_shadow's own history).
// wouldBeFlagged never changes a real candidate's ACTIVE/SHADOW eligibility.

import { query } from '../db.js';
import { RTH_SESSION_FIRED_AT_SQL } from '../routes/acd.js';

// FIXED 2026-09-17 (user-caught live: circled a real STOP_HIT PW_HIGH_FADE_SHORT that showed
// as un-flagged, priorBarDelta=-135 -- traced to the 09:50 bar, not the 09:51 bar that had
// actually closed by fired_at). The Sierra ingestion pipeline (sierraWatcher.js, poll 5s +
// 2s stability debounce by default) has real, multi-second lag between a minute rolling over
// and that minute's bar landing in price_bars_primary -- roughly a third of today's RTH SHORT
// fires land within ~15s of their own minute boundary, the exact window where the
// just-closed bar may not have been ingested yet. The original query silently fell back to
// whichever bar WAS available (one bar too old), with no way to tell from the stored row that
// this had happened. Didn't change this specific trade's verdict (both the 09:50 and 09:51
// bars read net-selling), but is a real, systematic staleness risk for this rule generally.
// One short retry (matching the watcher's own ~5s+2s cadence) resolves the common case;
// `barStale` is stored either way so a future audit can see when it didn't.
async function getPriorClosedBarDelta() {
  const fetchLatest = async () => {
    const r = await query(`
      SELECT ts::text AS ts, (ask_volume::int - bid_volume::int) AS delta
      FROM price_bars_primary
      WHERE symbol='NQ' AND ts < date_trunc('minute', NOW())
      ORDER BY ts DESC LIMIT 1
    `).catch(() => ({ rows: [] }));
    return r.rows[0] ?? null;
  };
  // NOW() is timestamptz; price_bars_primary.ts is a naive column (no offset) -- must cast to
  // ::timestamp (applies the session's own America/New_York TimeZone setting) BEFORE ::text,
  // or the '-04'/'-05' offset suffix makes the string compare below always mismatch.
  const expectedTs = await query(`SELECT (date_trunc('minute', NOW()) - INTERVAL '1 minute')::timestamp::text AS ts`)
    .then(r => r.rows[0]?.ts).catch(() => null);

  let bar = await fetchLatest();
  let barStale = expectedTs != null && bar != null && bar.ts !== expectedTs;
  if (barStale) {
    await new Promise(res => setTimeout(res, 8000)); // ~poll(5s)+stability(2s)+margin
    const retried = await fetchLatest();
    if (retried && retried.ts === expectedTs) { bar = retried; barStale = false; }
  }
  return { delta: bar?.delta ?? null, barStale };
}

// Last REAL fire (any origin ACTIVE/SHADOW) of the exact same setup_type, within the current
// session. FIXED 2026-09-16 (DeepSeek code review, found real): RTH_SESSION_FIRED_AT_SQL is a
// pure TIME-OF-DAY predicate (hour*60+minute in [570,1080)), not a date bound -- the original
// version returned "the most recent same-setup fire at an RTH time-of-day, across ALL history,"
// so a today's-first-fire could get compared against a stale reference from yesterday or last
// week. The backtest this file is built from (backtest_price_drift_gate_phase0.mjs's
// simulate()) explicitly `state.clear()`s on every RTH<->Globex transition, scoping the
// reference to "since THIS session opened" -- this function now matches that by also bounding
// to today's own trade_date (only ever called with nowIsRTH=true in practice, per the one live
// call site in classifyEntryOrderFlowShadow(), so "today" unambiguously means the current RTH
// session). `todayET` derived from the same already-ET-converted Date object the caller
// computed `nowIsRTH` from, not a fresh `new Date().toISOString()` (that would be the naive-
// timestamp/ambient-timezone bug this codebase's own hard rule warns about).
async function getLastSameSetupFire(setupType, nowIsRTH, todayET) {
  const sessionFilter = nowIsRTH ? RTH_SESSION_FIRED_AT_SQL : `NOT (${RTH_SESSION_FIRED_AT_SQL})`;
  const r = await query(`
    SELECT entry_zone_low::float AS entry_zone_low, entry_zone_high::float AS entry_zone_high, fired_at
    FROM active_setups
    WHERE setup_type=$1 AND origin_status IN ('ACTIVE','SHADOW') AND fired_at < NOW() AND ${sessionFilter}
      AND trade_date = $2::date
    ORDER BY fired_at DESC LIMIT 1
  `, [setupType, todayET]).catch(() => ({ rows: [] }));
  const row = r.rows[0];
  if (!row) return null;
  return { entryPrice: row.entry_zone_high ?? row.entry_zone_low, firedAt: row.fired_at };
}

// Pure-ish classification (does real reads, no writes) -- exported separately from the tagger
// so a future recheck/backtest-alignment script can call the exact same logic without
// re-deriving it, per this codebase's "export the real function" convention.
export async function classifyEntryOrderFlowShadow({ direction, setupType, entryPrice }) {
  if (!direction || !setupType || entryPrice == null) return null;
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowEtMin = nowET.getHours() * 60 + nowET.getMinutes();
  const nowIsRTH = nowEtMin >= 570 && nowEtMin < 1080; // matches RTH_SESSION_FIRED_AT_SQL's own bounds

  const { delta: priorBarDelta, barStale } = await getPriorClosedBarDelta();
  const adverseFlow = priorBarDelta == null ? null : (direction === 'SHORT' ? priorBarDelta > 0 : priorBarDelta < 0);
  const checkedAt = new Date().toISOString();

  if (direction === 'SHORT') {
    // No hardcoded time-of-day cutoff in the flag itself (user + DeepSeek both flagged 9:30-
    // noon as an arbitrary boundary picked from a few backtest buckets, not a real calibrated
    // number -- this codebase's own "no static thresholds" rule). wouldBeFlagged is just the
    // real signal (adverse flow); etMin is stored raw so the 6-week revisit can derive whatever
    // real time-of-day boundary the accumulated data actually supports, instead of guessing one
    // now and baking it into which rows even get flagged.
    const wouldBeFlagged = nowIsRTH && adverseFlow === true;
    return { direction, setupType, rule: 'SHORT_MORNING_ADVERSE_FLOW', priorBarDelta, barStale, adverseFlow, etMin: nowEtMin, wouldBeFlagged, checkedAt };
  }

  // LONG_REPEAT_ADVERSE_FLOW -- RTH only (see file header); Globex has too little real data to
  // calibrate, not tested as "no effect," so it's simply not evaluated outside RTH here.
  if (!nowIsRTH) {
    return { direction, setupType, rule: 'LONG_REPEAT_ADVERSE_FLOW', priorBarDelta, barStale, adverseFlow, wouldBeFlagged: false, notApplicable: 'GLOBEX_NOT_YET_CALIBRATED', checkedAt };
  }
  const todayET = nowET.toLocaleDateString('en-CA'); // matches acd.js's own todayET convention
  const lastFire = await getLastSameSetupFire(setupType, nowIsRTH, todayET);
  const refEntryPrice = lastFire?.entryPrice ?? null;
  const minutesSinceRef = lastFire ? +((Date.now() - new Date(lastFire.firedAt).getTime()) / 60000).toFixed(1) : null;
  // priceDriftGated is pure direction (worse price than the last same-setup fire) -- NO time
  // cutoff baked in here either, same reasoning as the SHORT rule above. minutesSinceRef is
  // still recorded on every row so the revisit can bucket by real elapsed time (the backtest
  // saw the effect concentrated under ~60min and reversing past ~4hr, but that was a handful of
  // ad hoc buckets, not a derived boundary) rather than a threshold decided in advance.
  const priceDriftGated = refEntryPrice != null && entryPrice < refEntryPrice;
  const wouldBeFlagged = priceDriftGated && adverseFlow === true;
  return {
    direction, setupType, rule: 'LONG_REPEAT_ADVERSE_FLOW',
    priorBarDelta, barStale, adverseFlow, refEntryPrice, minutesSinceRef, priceDriftGated, wouldBeFlagged, checkedAt,
  };
}

// Tags a real (ACTIVE/SHADOW) row, right after insert, with this candidate's own entry-order-
// flow reading -- SHADOW-ONLY / OBSERVATION-ONLY, exact same posture as tagDirectionGateShadow()/
// tagMomentumAgainstFadeShadow(). Keyed by the row's own `id` via a follow-up UPDATE, not
// threaded through the INSERT's own positional params (same reasoning as those two: avoids the
// manually-counting-$N-params failure mode).
export async function tagEntryOrderFlowShadow(insertedId, { direction, setupType, entryPrice }) {
  if (!insertedId || !direction || !setupType || entryPrice == null) return;
  try {
    const result = await classifyEntryOrderFlowShadow({ direction, setupType, entryPrice });
    if (!result) return;
    await query(`UPDATE active_setups SET entry_orderflow_shadow = $1 WHERE id = $2`, [JSON.stringify(result), insertedId]);
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}
