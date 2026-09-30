// Entry-order-flow shadow tracker, 2026-09-16 (observation-only, same guarantee family as
// step_trail_shadow/pitch_catch_shadow/direction_gate_shadow/momentum_against_fade_shadow/
// breakeven_stop_shadow -- never touches a real trade's own origin_status/status/resolution/
// actual_pnl/stop_level, only writes its own JSONB column, right after the real INSERT, wrapped
// so a failure here can never affect the real row it's tagging).
//
// Backing research: scripts/backtest_price_drift_gate_phase0.mjs + backtest_price_drift_gate_
// orderflow_phase0b.mjs (2026-09-16 session).
//
// REMOVED 2026-09-29 (DeepSeek design-critique audit of the whole shadow-tag family):
// LONG_REPEAT_ADVERSE_FLOW used to fire when a same-setup_type LONG repeat came in at a WORSE
// price than the last real same-setup_type LONG fire, AND the prior 1-min bar showed net
// selling -- backtest EV=-$15.94/trade vs +$4.14. Never cleared for live gating: DeepSeek's
// 2026-09-16 review already found this backtest population substantially OVERLAPS the already-
// live isSameSetupRefireBlocked() gate (same-setup repeats within a short window are already
// force-SHADOW'd there), so the measured -$15.94 was never provably this rule's own marginal
// edge. The real live data confirmed the concern: N=30 real flagged trades (2026-09-16 to
// 2026-09-28) came in net PROFITABLE (netIfHonored=-$1,118, i.e. honoring the gate would have
// COST money) -- the opposite sign from the backtest. Since the only structural difference
// between this rule and the surviving SHORT_MORNING_ADVERSE_FLOW rule (whose sign held live) is
// conditioning on "same-setup repeat," the conclusion is that this rule was measuring the
// refire-cooldown gate's own leftover complement, not a real independent signal -- more N
// couldn't have fixed a selection confound, so it's removed rather than left to accumulate more
// of the same measurement. `getLastSameSetupFire()` (the reference-fire lookup this rule
// depended on) was removed with it -- nothing else used it. See RESEARCH_CLAIM
// entryflow_long_repeat_removed_confounded_20260929 for the full account, and
// CLAUDE.md's "Conventions" entry on any same-setup lookup needing an explicit excludeId (the
// bug this rule already needed one fix for, 2026-09-22) for the earlier history.
//
// SHORT_MORNING_ADVERSE_FLOW (the sole surviving rule): fires for ANY SHORT candidate (first
// touch or repeat -- price-drift was tested and does NOT hold for shorts, so it's not part of
// this rule) fired in RTH when the single 1-min bar that closed immediately before now shows net
// BUYING. Tested: N=366, EV=-$15.75/trade vs +$4.58 -- the most rigorously checked finding of
// the session (48 distinct dates, top5DayPct=20.8%, stable across all 3 chronological thirds,
// strengthens to -$19.62 in the most recent 45 days). Live real data confirms the sign held:
// N=118 (2026-09-16 to 2026-09-28), netIfHonored=+$1,645. Does NOT transfer to Globex (tested
// directly: ~flat, -$4.98 vs -$3.64) and gets thin/noisy in the afternoon -- the backtest's own
// 9:30-noon window was flagged (by the user and independently by DeepSeek) as an arbitrary
// boundary picked from a few ad hoc buckets, not a real calibrated cutoff, so it is NOT baked
// into wouldBeFlagged below -- every RTH SHORT with adverse flow gets flagged, and the real
// ET-minute-of-day is stored on every row (`etMin`) so a future revisit can derive whatever
// time-of-day boundary the accumulated data actually supports, rather than shipping a guessed
// one now. Per DeepSeek's 2026-09-29 critique, this rule is conceptually the 1-bar version of
// touchOrderflowPressureShadow.js's 8-bar OFP signal (both "adverse directional pressure right
// before entry") -- HOLD, not independently promoted or removed, pending a head-to-head once
// both have more real forward data.
//
// RTH only, at launch -- Globex was tested and came back flat for this rule. Re-check once more
// Globex history accumulates.
//
// SHIPPED AS OBSERVATION-ONLY (user's explicit call 2026-09-16, after an initial "wire it to
// actually prevent live/shadow trades" request was walked back once DeepSeek's design-critique
// caveats above were in front of them -- same arc as direction_gate_shadow's own history).
// wouldBeFlagged never changes a real candidate's ACTIVE/SHADOW eligibility.

import { query } from '../db.js';

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
// session. getLastSameSetupFire() (the LONG_REPEAT_ADVERSE_FLOW reference-fire lookup) was
// removed 2026-09-29 along with that rule -- nothing else in this codebase used it.

// Pure-ish classification (does real reads, no writes) -- exported separately from the tagger
// so a future recheck/backtest-alignment script can call the exact same logic without
// re-deriving it, per this codebase's "export the real function" convention. `excludeId` is
// kept in the signature for call-site compatibility (tagEntryOrderFlowShadow still passes it)
// even though the sole surviving rule doesn't need a self-match guard -- SHORT_MORNING_
// ADVERSE_FLOW has no same-setup reference lookup by construction.
export async function classifyEntryOrderFlowShadow({ direction, setupType, entryPrice, excludeId: _excludeId = null }) {
  if (!direction || !setupType || entryPrice == null) return null;
  if (direction !== 'SHORT') return null; // LONG_REPEAT_ADVERSE_FLOW removed 2026-09-29 -- see file header
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowEtMin = nowET.getHours() * 60 + nowET.getMinutes();
  const nowIsRTH = nowEtMin >= 570 && nowEtMin < 1080; // matches RTH_SESSION_FIRED_AT_SQL's own bounds

  const { delta: priorBarDelta, barStale } = await getPriorClosedBarDelta();
  const adverseFlow = priorBarDelta == null ? null : priorBarDelta > 0;
  const checkedAt = new Date().toISOString();

  // No hardcoded time-of-day cutoff in the flag itself (user + DeepSeek both flagged 9:30-
  // noon as an arbitrary boundary picked from a few backtest buckets, not a real calibrated
  // number -- this codebase's own "no static thresholds" rule). wouldBeFlagged is just the
  // real signal (adverse flow); etMin is stored raw so a future revisit can derive whatever
  // real time-of-day boundary the accumulated data actually supports, instead of guessing one
  // now and baking it into which rows even get flagged.
  const wouldBeFlagged = nowIsRTH && adverseFlow === true;
  return { direction, setupType, rule: 'SHORT_MORNING_ADVERSE_FLOW', priorBarDelta, barStale, adverseFlow, etMin: nowEtMin, wouldBeFlagged, checkedAt };
}

// Tags a real (ACTIVE/SHADOW) row, right after insert, with this candidate's own entry-order-
// flow reading -- SHADOW-ONLY / OBSERVATION-ONLY, exact same posture as tagDirectionGateShadow()/
// tagMomentumAgainstFadeShadow(). Keyed by the row's own `id` via a follow-up UPDATE, not
// threaded through the INSERT's own positional params (same reasoning as those two: avoids the
// manually-counting-$N-params failure mode).
export async function tagEntryOrderFlowShadow(insertedId, { direction, setupType, entryPrice }) {
  if (!insertedId || !direction || !setupType || entryPrice == null) return;
  try {
    const result = await classifyEntryOrderFlowShadow({ direction, setupType, entryPrice, excludeId: insertedId });
    if (!result) return;
    await query(`UPDATE active_setups SET entry_orderflow_shadow = $1 WHERE id = $2`, [JSON.stringify(result), insertedId]);
  } catch (_) { /* observation-only -- never let a tagging failure surface anywhere */ }
}
