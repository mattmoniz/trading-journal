// RTH candidate-building support cluster, extracted from server/routes/acd.js 2026-09-20
// (Phase A of docs/ACDJS_FILE_SIZE_REDUCTION_SPEC.md).
//
// The spec's original premise was that buildAllCandidates()/computeLevelFadeFactors() were
// "already decoupled enough to physically move with no logic changes, just a relocation +
// import" because they take their runSetupDetection state via an explicit `ctx` parameter.
// The spec itself warned not to trust that assumption without the exhaustive free-variable
// grep CLAUDE.md's Conventions section requires -- doing that grep found it was WRONG in one
// respect: both functions also read a handful of MODULE-LEVEL (not runSetupDetection-local)
// helpers that live outside their own `ctx`. Distinguishing "module-level" from
// "runSetupDetection-local" mattered here -- a module-level helper can move together with its
// callers with zero behavior change, since ES modules are singletons; a runSetupDetection-local
// closure (liveStats, allRthBarsRow.rows -- this file's own documented block-scoping footgun)
// cannot, which is exactly why Phase C stays deferred.
//
// Real dependency check performed (grep every module-level name defined before buildAllCandidates
// in the original file against both function bodies, verifying each hit was real code and not a
// comment mention -- several early "hits" on REFIRE_COOLDOWN_MINUTES/isInRefireCooldown/
// recentlyShadowedSameType/tagDirectionGateShadow/getMomentumAgainstFade* turned out to be
// comment-only references inside the two functions' own prose and were left in acd.js
// untouched): both functions turned out to need exactly 3 additional module-level things, all
// self-contained (no further transitive dependency on runSetupDetection-local state):
//   - logGatedCandidate() -- also called ~8 more times directly inside runSetupDetection's own
//     remaining body, so it's re-imported back into acd.js below, not just moved and forgotten.
//   - t1Guard()/t1GuardLabeled() -- confirmed used ONLY inside buildAllCandidates, nowhere else
//     in the file (their own declaration/comment lines were the only other hits) -- moved
//     cleanly, acd.js does not need them back.
//   - _pdpMissingLogged (a console.error dedup Set, mirrors the pattern already documented for
//     acd.js's own _dtaGateLogged) -- confirmed used only inside computeLevelFadeFactors --
//     moved cleanly, redeclared here as its own module-level singleton (identical behavior,
//     since ES modules are cached/singleton the same way the original module-level const was).
//
// No circular import results from this: acd.js only ever imports FROM this file
// (buildAllCandidates, computeLevelFadeFactors, logGatedCandidate), never the reverse.
import { query } from '../db.js';
import { getCached, setCached, DAY_CACHE_TTL } from './acdShared.js';
import { getPriorDayProfile, getOrVolBaseline20d } from './acdLiveCalibration.js';
import { getBetClass } from '../config/setupTypes.js';
import { matchPermissionSlips } from './permissionSlip.js';
import { computeIbBullBear } from './caseEngine.js';
import { classifyACDOpeningCall } from './openingCallClassifier.js';
import { computeLiveVolatilityRegime } from './volatilityRegimeService.js';
import { resampleBars, computeRSI14 } from './technicalIndicators.js';

// Dedup for the priorDayProfile-missing warning inside computeLevelFadeFactors -- without this,
// a day with no pre-market ACD read done yet would log the same "mechanism is silently inert"
// warning every 15s poll all day. Keyed by trade date so it naturally resets daily. Module-level
// singleton, same semantics as the original acd.js declaration (ES modules are cached).
const _pdpMissingLogged = new Set();

// ── Non-fire logging (roster-rebuild roadmap Phase 1, I2, 2026-08-10) ──────────────
// A `gated_candidates` row for every candidate this codebase's own gates drop, null, or
// keep out of the ACTIVE path -- before this, the current census of what the system does
// was blind to everything filtered before a row was written (e.g. a PROMOTE-status type
// showing zero real attempts was invisible in every existing analysis, since a nulled
// candidate simply never produced any row anywhere). Explicitly NOT a duplicate of the
// existing SHADOW-row audit trail (the level-fade 6-way combo, the forceShadow combo on the
// winning candidate, the overnight-level promotion gate) -- those already persist their own
// row with their own reason and don't need this table; this table exists specifically for the
// gates a 2026-08-10 audit found had NO trace at all (a console.error, or nothing): the IB
// day-type real-N floor, the OPEN_TEST_DRIVE hardcoded kill-switch, both riskOk checks, the
// directional-conflict "stand aside", the C_STANDALONE death-sequence/POC-counter
// suppressions, and the Globex same-day dedup.
// Fire-and-forget, never allowed to affect detection -- same posture as the rest of this
// file's audit inserts.
export async function logGatedCandidate({ tradeDate, setupType, gateName, gateReason, entry, stop, target }) {
  try {
    await query(`
      INSERT INTO gated_candidates (trade_date, setup_type, gate_name, gate_reason, would_have_entry, would_have_stop, would_have_target, bet_class)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [tradeDate, setupType, gateName, gateReason ?? null, entry ?? null, stop ?? null, target ?? null, getBetClass(setupType)]);
  } catch (_) { /* informational only, never block detection */ }
}

// Already pure (no closure dependency) -- hoisted out of runSetupDetection unchanged rather
// than redefined fresh on every single poll call. Returns the nearest valid T1 candidate in
// the correct direction vs entry. Candidates are checked in priority order; first valid one
// wins. Returns null if no candidate is on the right side — prevents wrong-direction targets.
function t1Guard(direction, entry, ...candidates) {
  const isLong = direction === 'LONG';
  for (const c of candidates) {
    if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) return Math.round(c);
  }
  return null;
}

// Same direction-guard as t1Guard, but candidates are { value, label } pairs
// and the matching label travels with the chosen value — so the displayed
// target and its label can never disagree about which structural level was used.
// Used by the TRT family, where every candidate must be a REAL structural level
// (no arbitrary price+multiple fallbacks) — falls through to NO_VIABLE_TARGET
// rather than inventing an unanchored number.
function t1GuardLabeled(direction, entry, ...candidates) {
  const isLong = direction === 'LONG';
  for (const cand of candidates) {
    const c = cand?.value;
    if (c != null && isFinite(c) && (isLong ? c > entry : c < entry)) {
      return { value: Math.round(c), label: cand.label };
    }
  }
  return { value: null, label: 'NO_VIABLE_TARGET' };
}


// ── runSetupDetection decomposition Pass 2 (2026-09-06) + Phase A relocation (2026-09-20) ──
// ── runSetupDetection decomposition, Pass 1 continued (2026-09-06) ───────────────────────────────
// The ~19 RTH candidate builders (SETUP 0a through 10, plus absorption/coilSurge/rsiDiv).
// DeepSeek's original plan characterized these as "19 tiny pure functions" -- verified via
// independent review to be WRONG: dtClass/sessionBiasMatch/sessionConflictFor are computed
// mid-list (not before or after, a clean phase boundary) and are consumed far downstream --
// dtClass reaches all the way into the sizeMultiplier IIFE itself (`if (dtClass ===
// 'TREND') mult = Math.max(mult - 0.25, 0.25);`), and sessionConflictFor is called from
// inside that same IIFE too. ibSetup is also mutated POST-HOC ~650 lines after its own
// construction (a day-type gate can retroactively null it). Splitting into 19 separate
// functions would force threading this cross-phase state as both params and return values
// across every one of them, and re-expressing the ibSetup gate as an awkward two-step --
// high risk for low payoff on the real live-trading write path. Instead: ONE function,
// explicit ctx parameter, internal body preserved 100% verbatim (byte-diffed against the
// original before removing it) -- this still achieves the real goal (no closure capture
// of outer runSetupDetection state) without touching the genuinely-entangled internals.
// The caller destructures this function's return back into the SAME local variable names
// runSetupDetection already used, so every downstream phase (P3-P10, untouched) keeps
// reading dtClass/sessionConflictFor/ibSetup/etc. via ordinary closure exactly as before --
// only this phase's OWN internals stopped depending on outer closure.
export async function buildAllCandidates(ctx) {
  const {
    todayET, getHistory, hasCFiredToday, etMin,
    orH, orL, orRange, currentPrice, nearPD2VA, avgVol, ibBars, timelineEvents,
    liveOpeningCallType, liveOpenVsPrior, aUpFired, aUpLevel, cUpConf, aDownFired, aDownLevel, cDownConf,
    sessionHigh, sessionLow, ltRow, ibBarsRow, latestBarRow, allRthBarsRow,
    pdVAH, pdVAL, pdPOC, nl30, nl30State, isMahBull, isMahBear,
  } = ctx;

      // ── SETUP 0a: TRT V2 (LONG) ──────────────────────────────────────────────
      // Early trigger: A Down fired, NO C confirmation in either direction, price crosses
      // back above OR Low. A Down sellers are trapped before any C fires — earlier entry
      // than classic TRT which requires C Down + C Up failure through OR High.
      let trtLongV2 = null;
      if (aDownFired && !cDownConf && !cUpConf && currentPrice && orL &&
          currentPrice > orL &&
          !timelineEvents.some(e => e === 'TRT_LONG_V2' || e === 'TRT_LONG')) {
        const trtLongV2Stop = +(aDownLevel - 12).toFixed(0);
        const trtLongV2T1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trtLongV2 = {
          type: 'TRT_LONG_V2', label: 'TRT V2 — EARLY REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongV2Stop,
          target: trtLongV2T1.value,
          targetLabel: trtLongV2T1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (A Down trapped)',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but C Down never confirmed. Price reclaimed OR Low (${orL?.toFixed(0)}) — A Down sellers are trapped early. No C opposite required (earlier entry than classic TRT). Stop below A Down level (${trtLongV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0b: TRT V2 (SHORT) ─────────────────────────────────────────────
      // Early trigger: A Up fired, NO C confirmation in either direction, price drops
      // back below OR High. A Up buyers are trapped before any C fires.
      let trtShortV2 = null;
      if (aUpFired && !cUpConf && !cDownConf && currentPrice && orH &&
          currentPrice < orH &&
          !timelineEvents.some(e => e === 'TRT_SHORT_V2' || e === 'TRT_SHORT')) {
        const trtShortV2Stop = +(aUpLevel + 12).toFixed(0);
        const trtShortV2T1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trtShortV2 = {
          type: 'TRT_SHORT_V2', label: 'TRT V2 — EARLY REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortV2Stop,
          target: trtShortV2T1.value,
          targetLabel: trtShortV2T1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (A Up trapped)',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} but C Up never confirmed. Price fell back below OR High (${orH?.toFixed(0)}) — A Up buyers are trapped early. No C opposite required (earlier entry than classic TRT). Stop above A Up level (${trtShortV2Stop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 0c: OPEN TEST DRIVE (OTD) ──────────────────────────────────────
      // Within first 15 bars (9:30–9:44): price probes one direction 10+ pts, then reverses
      // through OR in opposite direction with larger magnitude. Stop = probe extreme.
      let otdSetup = null;
      {
        const otdBars = ibBars.slice(0, 15);
        if (otdBars.length >= 3 && orH && orL && currentPrice &&
            !timelineEvents.some(e => e === 'OPEN_TEST_DRIVE_SHORT' || e === 'OPEN_TEST_DRIVE_LONG')) {
          const openPx    = otdBars[0].open;
          const upProbe   = Math.max(...otdBars.map(b => b.high)) - openPx;
          const downProbe = openPx - Math.min(...otdBars.map(b => b.low));
          const probeHigh = Math.max(...otdBars.map(b => b.high));
          const probeLow  = Math.min(...otdBars.map(b => b.low));

          const otdShortSignaled = upProbe >= 10 && otdBars.some(b => b.close < orL);
          const otdLongSignaled  = downProbe >= 10 && otdBars.some(b => b.close > orH);

          // FIXED 2026-07-17: SHORT's description hand-typed "-5.6% directional edge... 73% WR
          // (+23%, N=11)... 69% WR" — already known-dead per the comment below (KILL, real EV
          // -$74 to -$100) so this was actively misleading on an already-suppressed setup. Also
          // fixed the same "unbounded structural-level target" bug found across this session
          // (docs/OPEN_THREADS.md) — target/stop now read the real OPTIMAL_STOP calibration.
          const _otdOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
          if (otdShortSignaled && currentPrice < orL) {
            const _otdStopPts = _otdOpt?.OPEN_TEST_DRIVE_SHORT?.stop ?? 89;
            const _otdTargetPts = _otdOpt?.OPEN_TEST_DRIVE_SHORT?.target ?? 33;
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_SHORT', label: 'OPEN TEST DRIVE (SHORT)',
              direction: 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop: +(currentPrice + _otdStopPts).toFixed(0),
              target: +(currentPrice - _otdTargetPts).toFixed(0),
              targetLabel: `T1: ${_otdTargetPts}pt sweep-optimal · Stop: ${_otdStopPts}pt`,
              keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (reversal confirmed)',
              description: `Open Test Drive short. Price probed up ${upProbe.toFixed(0)}pts to ${probeHigh.toFixed(0)} then reversed through OR Low (${orL?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_TEST_DRIVE_SHORT') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
              history: await getHistory('TRANSITIONAL'),
            };
          } else if (otdLongSignaled && currentPrice > orH) {
            const _otdStopPts = _otdOpt?.OPEN_TEST_DRIVE_LONG?.stop ?? 112;
            const _otdTargetPts = _otdOpt?.OPEN_TEST_DRIVE_LONG?.target ?? 21;
            otdSetup = {
              type: 'OPEN_TEST_DRIVE_LONG', label: 'OPEN TEST DRIVE (LONG)',
              direction: 'LONG',
              entry: +currentPrice.toFixed(0),
              stop: +(currentPrice - _otdStopPts).toFixed(0),
              target: +(currentPrice + _otdTargetPts).toFixed(0),
              targetLabel: `T1: ${_otdTargetPts}pt sweep-optimal · Stop: ${_otdStopPts}pt`,
              keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (reversal confirmed)',
              description: `Open Test Drive long. Price probed down ${downProbe.toFixed(0)}pts to ${probeLow.toFixed(0)} in the opening, then reversed through OR High (${orH?.toFixed(0)}) — initiative buyers dominated.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_TEST_DRIVE_LONG') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
              history: await getHistory('TRANSITIONAL'),
            };
          }
        }
      }
      // OPEN_TEST_DRIVE suppressed 2026-07-05: LONG=31.8% WR N=44 EV=-$100 (KILL), SHORT=26.7% WR N=45 EV=-$74 (KILL).
      // Code gates (nearPD2VA) described in description but not enforced — base rate is catastrophic.
      // The "shadow tracking continues" comment above was FALSE (2026-08-10 audit, roadmap I2) --
      // this unconditionally nulled a fully-built candidate with zero trace anywhere. Now logged
      // to gated_candidates (informational only, doesn't restore shadow firing) so a future PD-2
      // VA gate revisit has real gated-population data to check, not just this comment's claim.
      if (otdSetup) {
        logGatedCandidate({ tradeDate: todayET, setupType: otdSetup.type, gateName: 'OTD_HARDCODED_KILL', gateReason: 'OPEN_TEST_DRIVE unconditionally suppressed 2026-07-05 (confirmed negative EV both directions)', entry: otdSetup.entry, stop: otdSetup.stop, target: otdSetup.target });
      }
      otdSetup = null;

      // ── SETUP 0d: A UP STRONG (LONG) ─────────────────────────────────────────
      let aUpStrong = null;
      if (aUpFired && nl30 >= -9 &&
          !timelineEvents.some(e => e === 'A_UP_STRONG' || e === 'A_UP_WEAK' || e === 'TRT_LONG' || e === 'TRT_LONG_V2')) {
        const aUpStrongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        aUpStrong = {
          type: 'A_UP_STRONG', label: 'A UP STRONG (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: aUpStrongT1.value,
          targetLabel: aUpStrongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `A Up fired at ${aUpLevel?.toFixed(0)} under a supportive trend (NL30 is at +${nl30}). Bullish momentum holds above OR High. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // A_DOWN_STRONG and A_UP_WEAK were removed here 2026-09-07 (dead-code audit) --
      // confirmed by commit 63b4168 (2026-06-24, "Remove dead code setups") to have zero real
      // fires across 389 trading days: both require the A-signal to fire against its own NL30
      // context (A Down while NL30 is non-bearish; A Up while NL30 is bearish), which the A
      // multiplier that produces aUpFired/aDownFired structurally prevents. That commit already
      // un-wired both from shadowCandidates; this removes the still-computing-every-poll-for-
      // nothing detector code itself. Their sibling A_UP_STRONG/A_DOWN_WEAK were NOT part of
      // that finding (both have real historical fires) and remain live below.

      // ── SETUP 0g: A DOWN WEAK (SHORT) ────────────────────────────────────────
      let aDownWeak = null;
      if (aDownFired && nl30 > 9 &&
          !timelineEvents.some(e => e === 'A_DOWN_STRONG' || e === 'A_DOWN_WEAK' || e === 'TRT_SHORT' || e === 'TRT_SHORT_V2')) {
        const aDownWeakT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 0.5 : null, label: 'OR Half Measured Move' }
        );
        aDownWeak = {
          type: 'A_DOWN_WEAK', label: 'A DOWN WEAK (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: aDownWeakT1.value,
          targetLabel: aDownWeakT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `A Down fired at ${aDownLevel?.toFixed(0)} but against a bullish trend (NL30 is at +${nl30}). High failure/reversal risk. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 1: TRT + MAH ────────────────────────────────────────────────────
      // "Mad As Hell" — extended trend exhaustion: TRT conditions + NL30 extreme for 10+ sessions
      let trtMah = null;
      if (isMahBull || isMahBear) {
        if (isMahBull && aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
            currentPrice < orL && currentPrice < aUpLevel) {
          const trtMahShortStop = +(aUpLevel + 12).toFixed(0);
          const trtMahShortT1 = t1GuardLabeled('SHORT', currentPrice,
            { value: pdVAL, label: 'Prior Day VAL' },
            { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_SHORT', label: 'TRT + MAH (SHORT)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: trtMahShortStop,
            target: trtMahShortT1.value,
            targetLabel: trtMahShortT1.label,
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
            description: `A Up + C Up both failed. NL30 at +${nl30} with 10+ consecutive extreme sessions. MAH: trapped buyers fuel a larger-than-normal reversal. Price below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_UP'),
          };
        } else if (isMahBear && aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                   currentPrice > orH && currentPrice > aDownLevel) {
          const trtMahLongStop = +(aDownLevel - 12).toFixed(0);
          const trtMahLongT1 = t1GuardLabeled('LONG', currentPrice,
            { value: pdVAH, label: 'Prior Day VAH' },
            { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
          );
          trtMah = {
            type: 'TRT_MAH_LONG', label: 'TRT + MAH (LONG)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: trtMahLongStop,
            target: trtMahLongT1.value,
            targetLabel: trtMahLongT1.label,
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
            description: `A Down + C Down both failed. NL30 at ${nl30} with 10+ consecutive extreme sessions. MAH: trapped sellers fuel a larger-than-normal reversal. Price above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}).`,
            history: await getHistory('TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 2: TRT ──────────────────────────────────────────────────────────
      // Trend Reversal Trade: A + C both failed, price confirms reversal through OR
      let trt = null;
      if (aUpFired && cUpConf && currentPrice && orL && aUpLevel &&
          currentPrice < orL && currentPrice < aUpLevel) {
        const trtShortStop = +(aUpLevel + 12).toFixed(0);
        const trtShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_SHORT', label: 'TRT — TREND REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: trtShortStop,
          target: trtShortT1.value,
          targetLabel: trtShortT1.label,
          keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low (failed support)',
          description: `A Up + C Up both failed. Price is now below OR Low (${orL?.toFixed(0)}) and A Up level (${aUpLevel?.toFixed(0)}). Trapped longs fuel the reversal — stop above A Up level (${trtShortStop}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      } else if (aDownFired && cDownConf && currentPrice && orH && aDownLevel &&
                 currentPrice > orH && currentPrice > aDownLevel) {
        const trtLongStop = +(aDownLevel - 12).toFixed(0);
        const trtLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' },
        );
        trt = {
          type: 'TRT_LONG', label: 'TRT — TREND REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: trtLongStop,
          target: trtLongT1.value,
          targetLabel: trtLongT1.label,
          keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High (failed resistance)',
          description: `A Down + C Down both failed. Price is now above OR High (${orH?.toFixed(0)}) and A Down level (${aDownLevel?.toFixed(0)}). Trapped shorts fuel the reversal — it's a slow-burn reversal, not a spike.\n\nEDGE: TRT_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('TRT_LONG') ?? 'not yet calibrated'} overall. EXECUTION: This trade needs TIME. Don't cut early. Expiry is 120 min. Target PD VAH or OR measured move. Stop below A Down level (${trtLongStop}).${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction zone.' : ''}`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // Day type — fetched early so IB tier and all downstream gates can use it
      const dtClassRow = await query(`SELECT day_type FROM acd_daily_log WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] }));
      const dtClass = dtClassRow.rows[0]?.day_type || null;

      // Session-bias conflict check (2026-07-14) — see docs/OPEN_THREADS.md's IB_BULLISH
      // incident writeup: today's IB_BULLISH fired LONG while every session-bias signal on
      // the dashboard (Permission Slip, session signals) read SHORT, and nothing cross-checked
      // that before firing. Reuses the exact same PERMISSION_SLIP matching antigravityEdges.js
      // uses for the dashboard banner (server/services/permissionSlip.js, shared, not a second
      // copy). Cached via setCached the same way liveStats escapes this block's scoping, so the
      // candidates-array section (~line 5300) can read it without re-querying.
      let sessionBiasMatch = getCached(todayET, 'permissionSlipMatch');
      if (!sessionBiasMatch) {
        const openBar = ibBars[0], closeBar = ibBars[ibBars.length - 1];
        const firstHourDir = (openBar && closeBar)
          ? (closeBar.close > openBar.open ? 'UP' : closeBar.close < openBar.open ? 'DOWN' : 'FLAT')
          : null;
        const permSlipRows = await query(`
          SELECT signal_name, sample_size, win_rate::float, recommendation, notes
          FROM performance_audit
          WHERE signal_type = 'PERMISSION_SLIP'
            AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'PERMISSION_SLIP')
        `).catch(() => ({ rows: [] }));
        sessionBiasMatch = matchPermissionSlips(
          { dayType: dtClass, aUpFired, aDownFired, cUpConfirmed: cUpConf, cDownConfirmed: cDownConf, firstHourDir },
          permSlipRows.rows
        );
        setCached(todayET, 'permissionSlipMatch', sessionBiasMatch);
      }
      // MIN_PCT=0.65 matches backtest_permission_slips.mjs's own bar for what counts as a
      // real permission slip — only flag a conflict against a signal that clears that bar,
      // not any thin/weak match.
      const sessionConflictFor = (direction) => {
        const opposing = direction === 'LONG' ? sessionBiasMatch.SHORT : direction === 'SHORT' ? sessionBiasMatch.LONG : null;
        return (opposing && opposing.winRate >= 0.65) ? opposing : null;
      };

      // ── SETUP 3: IB CONFIRMATION ──────────────────────────────────────────────
      // STALE COMMENT CORRECTED 2026-08-19 (part of ib_bullbear_window_fix_recalibration_needed
      // spec work): this used to say "ibBars itself is still the 30-min window (9:30-10:00,
      // spec)" — that was true before the 2026-08-12 fix (commit-documented at this file's
      // ibBarsRow query, ~line 4106), which widened ibBars to the real 60-min window
      // (BETWEEN 570 AND 629) to match ibHighToday/ibLowToday. The fire gate moved to 10:30
      // (etMin>=630) for a SEPARATE reason (below) — don't conflate the two fixes. Found 2026-07-14: gating fire at 10:00
      // meant dtClass (line 3341) was always null at decision time (day_type isn't
      // classified until IB close at 10:30 — see CLAUDE.md's day-type classifier
      // timing fix), so the day-type suppression checks below (dtClass==='BALANCE'
      // etc.) were a guaranteed no-op every single time this fired — confirmed live:
      // IB_BULLISH fired blind at 09:58 ET with dtClass=null, went on to lose
      // (-$159), and its all-time blended EV is -$27.81/trade (N=106) specifically
      // because the BALANCE-day case this check exists to filter out was never
      // actually being filtered. Moving the gate here (not changing the 30-min
      // level definition) lets the existing checks below actually run.
      let ibSetup = null;
      if (etMin >= 630 && ibBars.length >= 3) {
        // Shared with scripts/backtest_trend_gate_suppression.mjs — see caseEngine.js's
        // computeIbBullBear() header for why this was extracted 2026-08-03.
        const { ibMid, ibClose, totalAsk, totalBid, ibBullish, ibBearish } = computeIbBullBear(ibBars);
        if ((ibBullish || ibBearish) && currentPrice) {
          const isBull = ibBullish;
          const priceSide = isBull ? currentPrice > ibMid : currentPrice < ibMid;
          if (priceSide) {
            // Conflicting signal: A Up tested and failed (for bullish IB) or A Down tested and failed (for bearish IB)
            // Both aUpLevel/aDownLevel are from acd_daily_log; ibBars is the 9:30–10:30 window
            // (corrected 2026-08-12, was 9:30-10:00 before -- see the ibBarsRow query comment above)
            // WEAK WR = 33.3% (N=9 decided, 20 fired) — not yet suppressed because N<20 threshold.
            // Revisit when forward-test accumulates 20 decided WEAK trades. (replay_ib_setups.js 2026-07-01)
            const aUpTestedInIB   = aUpLevel   && ibBars.some(b => b.high >= aUpLevel);
            const aDownTestedInIB = aDownLevel  && ibBars.some(b => b.low  <= aDownLevel);
            const conflicting = isBull ? (aUpTestedInIB && !aUpFired) : (aDownTestedInIB && !aDownFired);

            // Session-bias conflict (2026-07-14) — see the sessionConflictFor definition above.
            // Informational flag only, does not suppress; full suppression of a mechanical
            // fade based on this is a bigger, unvalidated behavior change reserved for a future
            // pass (docs/OPEN_THREADS.md tracks it as still-open).
            const sessionConflict = sessionConflictFor(isBull ? 'LONG' : 'SHORT');

            // Stop geometry: data-derived via stop sweep in update_optimal_stops.mjs → performance_audit.
            // Read from liveStats._opt[type].stop (sweep-optimal, not p75_mae).
            // Fallback 50/80pt from 2026-07-05 sweep research if _opt is unavailable.
            // _ibLS: read the level-fade stats cache directly here (liveStats is declared later in the level-fade block)
            const _ibLS = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL);
            const ibTypeName = isBull ? 'IB_BULLISH' : 'IB_BEARISH';
            // Day-type-conditioned calibration (2026-08-03, OPEN_DECISION
            // ib_bearish_optimal_stop_not_day_type_conditioned) — the execution-efficiency
            // audit found IB_BEARISH's real realized EV sat well above its blended
            // OPTIMAL_STOP row, and its own SETUP_STATUS day-type breakdown already shows
            // a real BALANCE/TREND/TURBULENT split. scripts/backtest_ib_daytype_stop_target.mjs
            // sweeps stop/target SEPARATELY per (setup_type, day_type) via the same real,
            // imported sweepOptimalStopAndTarget(), writing rows keyed
            // `{setup_type}_{day_type}` (matching backtest_day_type_alpha.js's convention)
            // whenever that cell clears the usual MIN_N=20 floor. Try the day-type-specific
            // row first; fall back to the blended `{setup_type}` row if the cell doesn't
            // exist or is still thin — dtClass (~line 4284) is already required to fire
            // this whole block, so no extra dependency introduced.
            const ibDayTypeKey = dtClass ? `${ibTypeName}_${dtClass}` : null;
            const ibOpt = (ibDayTypeKey && _ibLS?._opt?.[ibDayTypeKey]) || _ibLS?._opt?.[ibTypeName];
            const ibStopPts = ibOpt?.stop ?? 50; // sweep-optimal 50pt for both BULLISH and BEARISH
            const stop = isBull ? +(currentPrice - ibStopPts).toFixed(0) : +(currentPrice + ibStopPts).toFixed(0);
            // FIXED 2026-07-17 (user noticed an 8:1 R:R / 630pt target on a real STOP_HIT trade and
            // asked whether targets are actually calibrated — they weren't). Stop already correctly
            // read the sweep-optimal ibOpt.stop, but target ignored ibOpt.target entirely and used
            // raw, uncapped PD VAH/VAL structural distance instead — real calibration shows p50-MFE-
            // sweep-optimal targets of 30.5pt (IB_BULLISH) / 45.8pt (IB_BEARISH), nowhere near the
            // hundreds of points PD VAH/VAL can sit at. See docs/OPEN_THREADS.md for the full incident.
            const ibTargetPts = ibOpt?.target ?? 35;
            const target = isBull
              ? +(currentPrice + ibTargetPts).toFixed(0)
              : +(currentPrice - ibTargetPts).toFixed(0);
            ibSetup = {
              type: isBull ? 'IB_BULLISH' : 'IB_BEARISH',
              label: conflicting
                ? (isBull ? 'IB Bullish — A Up failed (reduced)' : 'IB Bearish — A Down failed (reduced)')
                : (isBull ? 'IB BULLISH' : 'IB BEARISH'),
              signalQuality: conflicting ? 'WEAK' : 'NORMAL',
              direction: isBull ? 'LONG' : 'SHORT',
              entry: +currentPrice.toFixed(0),
              stop,
              target,
              targetLabel: `T1: ${ibTargetPts}pt sweep-optimal (half off) · Stop: ${ibStopPts}pt from entry (${stop})`,
              keyLevel: +ibMid.toFixed(0),
              keyLevelLabel: 'IB Midpoint',
              description: conflicting
                ? (isBull
                  ? `IB closed bullish but A Up was tested and rejected before 10:00 — conflicting signals. Half conviction only: smaller size, wider stop tolerance.`
                  : `IB closed bearish but A Down was tested and rejected before 10:00 — conflicting signals. Half conviction only.\n\nEDGE: IB_BEARISH ${_ibLS?._edgeText?.('IB_BEARISH') ?? 'not yet calibrated'} overall. EXECUTION: Lean short on rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`)
                : (isBull
                  ? `IB closed ${(ibClose - ibMid).toFixed(0)}pts above midpoint with ask volume dominating (${totalAsk.toLocaleString()} vs ${totalBid.toLocaleString()} bid). Buyers controlled the initial balance.\n\nEDGE: IB_BULLISH ${_ibLS?._edgeText?.('IB_BULLISH') ?? 'not yet calibrated'} overall. EXECUTION: Buy pullbacks to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt below entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
                  : `IB closed ${(ibMid - ibClose).toFixed(0)}pts below midpoint with bid volume dominating (${totalBid.toLocaleString()} vs ${totalAsk.toLocaleString()} ask). Sellers controlled the initial balance.\n\nEDGE: IB_BEARISH ${_ibLS?._edgeText?.('IB_BEARISH') ?? 'not yet calibrated'} overall. EXECUTION: Short rallies to IB midpoint (${Math.round(ibMid)}). Stop ${ibStopPts}pt above entry (${stop}). Target ${ibTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`),
              history: await getHistory(nl30State === 'BULLISH' ? 'TRENDING_UP' : nl30State === 'BEARISH' ? 'TRENDING_DOWN' : 'BALANCE'),
              // No `tier` field here (removed 2026-08-31, docs/IB_BULLISH_BEARISH_AUDIT_AND_REDESIGN_SPEC.md
              // Part 1 item 2) — it was a dtClass-keyed ternary that always evaluated to the
              // same value (dtClass is null at this point in the live session; acd_daily_log.day_type
              // isn't written until 8:20 PM ET, see OPEN_DECISION ib_daytype_calibration_structurally_unreachable),
              // so every live IB_BULLISH fire showed tier='WEAK' and every IB_BEARISH fire showed
              // tier='MARGINAL' regardless of actual conditions. Grepped: no frontend component
              // reads this setup's `.tier` field, so removing it is a pure no-op on display today.
              // The static "TREND days: strongest"/"TURBULENT: strongest. BALANCE: suppressed"
              // description claims above are also removed for the same reason — not computed
              // from anything live, and this file's own comment history shows the real "best
              // day-type" answer has flipped 3 times across independent audits (noise, not a
              // stable effect). The already-live `_edgeText()` call above still gives the real,
              // data-derived blended-EV summary; a real day-type breakdown needs the structural
              // fix tracked in the redesign spec, not a hand-typed replacement here.
            };
            // Session-bias conflict flag — appended post-construction rather than woven into
            // the description ternary above, to avoid touching that already-complex string
            // logic. Informational only (see sessionConflictFor definition, ~line 3355).
            if (sessionConflict) {
              ibSetup.sessionConflict = sessionConflict;
              ibSetup.description = `⚠ SESSION-BIAS CONFLICT: "${sessionConflict.label}" reads ${sessionConflict.direction} at ${(sessionConflict.winRate * 100).toFixed(0)}% (N=${sessionConflict.n}) — opposite this setup's direction. Not suppressed, but weigh this before sizing.\n\n${ibSetup.description}`;
            }
          }
        }
      }

      // ── SETUP 4: OPEN DRIVE ───────────────────────────────────────────────────
      let openDrive = null;
      if (liveOpeningCallType === 'OPEN_DRIVE' && orH && orL && currentPrice) {
        const nearOrHigh = Math.abs(currentPrice - orH) <= 15 && currentPrice >= orH - 15 && currentPrice <= orH + 5;
        const nearOrLow  = Math.abs(currentPrice - orL) <= 15 && currentPrice <= orL + 15 && currentPrice >= orL - 5;
        const isBull = nearOrHigh && nl30State !== 'BEARISH';
        const isBear = nearOrLow  && nl30State !== 'BULLISH';
        if (isBull || isBear) {
          // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
          // IB_BULLISH/BEARISH — see docs/OPEN_THREADS.md). The OR-measured-move projection
          // (orH + orRange) has no realistic-distance cap and can sit far past what real MFE data
          // supports. Now uses the real sweep-optimal OPTIMAL_STOP target instead.
          const _odTargetPts = isBull
            ? (getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.OPEN_DRIVE_LONG?.target ?? 50)
            : (getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.OPEN_DRIVE_SHORT?.target ?? 40);
          openDrive = {
            type: isBull ? 'OPEN_DRIVE_LONG' : 'OPEN_DRIVE_SHORT',
            label: isBull ? 'OPEN DRIVE (LONG)' : 'OPEN DRIVE (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(orL - (orH - orL)).toFixed(0) : +(orH + 2).toFixed(0),
            target: isBull
              ? +(currentPrice + _odTargetPts).toFixed(0)
              : +(currentPrice - _odTargetPts).toFixed(0),
            targetLabel: `T1: ${_odTargetPts}pt sweep-optimal`,
            keyLevel: +(isBull ? orH : orL).toFixed(0),
            keyLevelLabel: isBull ? 'OR High (support)' : 'OR Low (resistance)',
            // FIXED 2026-07-17: hand-typed "66.7% WR (N=42)"/"68.2% WR (N=22)" — real live SETUP_STATUS
            // data (N=44-59) shows OPEN_DRIVE_LONG's EV has since flipped negative (-$7 to -$16/trade)
            // and WR is ~46-47%, ~19pp lower than the hardcoded claim. Same "never fabricate a stat"
            // violation fixed elsewhere this session (docs/OPEN_THREADS.md).
            description: isBull
              ? `Open Drive up confirmed. Pullback to near OR High (${orH?.toFixed(0)}) — first test of the breakout level.\n\nEDGE: OPEN_DRIVE_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_DRIVE_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Buy the pullback to OR High. Stop below OR Low −1× OR Range (${+(orL - (orH - orL)).toFixed(0)}). Target ${_odTargetPts}pt sweep-optimal. Do NOT fade this drive before 1:30 PM.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `Open Drive down confirmed. Rally toward OR Low (${orL?.toFixed(0)}) — first test of the breakdown level.\n\nEDGE: OPEN_DRIVE_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('OPEN_DRIVE_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Short the rally to OR Low. Stop above OR High +2pt (${+(orH + 2).toFixed(0)}). Target ${_odTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction zone.' : ''}`,
            history: await getHistory('TRENDING_UP'),
          };
        }
      }

      // ── Setup D: Opening Drive, 15-minute-OR-consistent (roadmap Phase 6, 2026-08-11) ──
      // Deliberately a NEW setup_type (OPENING_DRIVE_15MIN_LONG/SHORT), NOT a change to
      // OPEN_DRIVE_LONG/SHORT above. Stage 1 (scripts/backtest_setup_d_opening_drive_
      // stage1.mjs) tested the CURRENT live 5-min-OR definition against a 15-min-OR-
      // consistent variant, each with a required blind-delay confound control (DeepSeek
      // design critique, scratch/deepseek_setup_d_design.md — the same confound that
      // invalidated engagement_confirmation_entry_timing: entering later against fixed
      // exits is structurally favorable regardless of the entry condition tested). Result:
      // the 5-min (live, above) definition FAILED its own confound check — its apparent
      // edge was indistinguishable from "just enter later." The 15-min variant PASSED
      // cleanly (beat blind delay, beat a flat default, rigor-clean, N=138). Full account:
      // OPEN_DECISION open_drive_5min_or_vs_15min_classifier_mismatch (resolved).
      //
      // Uses the extracted classifyACDOpeningCall() (server/services/
      // openingCallClassifier.js) — the SAME formula OPEN_DRIVE above uses inline, not a
      // reimplementation — fed a 15-minute OR (9:30-9:45) and a 45-minute confirm window
      // (9:30-10:15, same 1:3 anchor:confirm ratio the live 5-min/15-min pairing already
      // uses, just scaled up), replicating Stage 1's exact VARIANT_15MIN definition.
      //
      // Stage 2/3/4 (2026-08-31, scripts/backtest_setup_d_opening_drive_stage{2,3,4}*.mjs,
      // RESEARCH_CLAIM setup_d_hybrid_drive_magnitude_entry_oos_validated): the pullback-wait
      // rule below structurally forfeits ~15% of classified drives that never pull back at
      // all (real EV $85.54/trade on that subgroup vs $37.54/trade for the pullback subgroup
      // — pure missed opportunity, not a tradeoff). Drive magnitude at confirm-close --
      // (price - OR boundary)/OR range, signed by direction -- is a real, chronologically
      // OOS-validated discriminator (train AUC=0.293, test AUC=0.329) for which bucket a day
      // will fall into. Hybrid rule added: if magnitude clears DRIVE_MAG_IMMEDIATE_THRESHOLD
      // at confirm-close, fire an IMMEDIATE entry right then (own stop/target, validated
      // separately) instead of waiting for the pullback that Stage 2 showed is unambiguously
      // worse when it's actually going to happen but strictly better when it isn't going to.
      // DRIVE_MAG_IMMEDIATE_THRESHOLD (0.479, a median split of the Stage 4 train fold) and
      // the immediate-path stop/target (159/80, Stage 2's own sweep on that subgroup) are
      // hardcoded fallbacks for now -- same bootstrap pattern as stopPts/targetPts below --
      // no dedicated calibration script/SETUP_STATUS-style row exists yet for this specific
      // threshold; revisit once real SHADOW data accumulates for both entry paths.
      const DRIVE_MAG_IMMEDIATE_THRESHOLD = 0.479;
      let openingDrive15Min = null;
      try {
        // FIXED 2026-09-14 (live duplicate-flood bug, user-caught): this block previously had
        // NO per-day dedup at all, despite the comment ~15 lines below claiming the INSERT-stage
        // `existingSetup` check already covers it. That claim is wrong for THIS setup specifically
        // -- both odCall/driveMag are deterministic once the 10:15 confirm-close bar exists (frozen
        // for the rest of the day, same allRthBarsRow-freezes-at-4PM footgun this file already
        // documents elsewhere), so every ~15s poll from 10:15 onward recomputed the IDENTICAL
        // candidate and fired it again the instant the prior SHADOW row resolved -- the exact
        // shape of the 2026-08-20 IB_BEARISH/BRACKET_BREAKOUT_SHORT flood incident (see
        // isInRefireCooldown()'s header comment, ~line 527), except that incident's fix
        // (recentlyShadowedSameType/skipRedundantShadowInsert) was only ever wired into the RTH
        // main active-slot path, never this shadowCandidates-only setup, and OPENING_DRIVE_15MIN
        // isn't in REFIRE_COOLDOWN_MINUTES either. Confirmed live 2026-09-14: 8 byte-identical
        // LONG fires (same entry/stop/target, all TARGET_HIT, all $158.50) between 10:28 AM and
        // 4:57 PM ET -- the immediate-entry branch's fixed 10:15-close entry price was already far
        // past its own target by the time of each later poll, so every duplicate "won" instantly.
        // This is the ENTIRE real historical sample behind both OPENING_DRIVE_15MIN_LONG (N=8) and
        // _SHORT (N=2, 2026-08-19) -- both trading days on record are single real classification
        // events replicated by this bug, not independent trades; see the same-day data-repair note
        // in docs/OPEN_THREADS.md. Genuine single-fire-per-day semantics: this setup classifies AT
        // MOST once per session (one OPEN_DRIVE call, one direction), so a plain existence check
        // against today's real rows is correct and sufficient -- no cooldown-minutes heuristic
        // needed, matching how a real one-shot classification event should behave.
        const odAlreadyFiredToday = await query(`
          SELECT 1 FROM active_setups
          WHERE trade_date = $1 AND setup_type IN ('OPENING_DRIVE_15MIN_LONG','OPENING_DRIVE_15MIN_SHORT')
          LIMIT 1
        `, [todayET]).catch(() => ({ rows: [] }));
        if (currentPrice && etMin >= 615 && !odAlreadyFiredToday.rows.length) { // confirm window (9:30-10:15) must have closed
          const odOrBars = allRthBarsRow.rows.filter(b => b.et_min < 585); // 9:30-9:45
          const odConfirmBars = allRthBarsRow.rows.filter(b => b.et_min < 615); // 9:30-10:15
          if (odOrBars.length >= 5 && odConfirmBars.length >= 15) {
            const odOrH = Math.max(...odOrBars.map(b => b.high));
            const odOrL = Math.min(...odOrBars.map(b => b.low));
            const odCall = classifyACDOpeningCall(odConfirmBars, odOrH, odOrL);
            if (odCall?.type === 'OPEN_DRIVE') {
              const isLong = odCall.driveDirection === 'UP';
              const type = isLong ? 'OPENING_DRIVE_15MIN_LONG' : 'OPENING_DRIVE_15MIN_SHORT';
              // Drive magnitude uses the confirm-window-CLOSE bar's own price (the first bar
              // at/after minute 615), matching Stage 2/3/4's exact definition -- NOT
              // `currentPrice`, which could be several minutes later by the time a poll
              // catches this and would silently drift the entry away from what was actually
              // backtested. CORRECTED 2026-09-14: this comment used to claim `existingSetup`'s
              // per-(trade_date,setup_type) dedup (at the INSERT stage) already guaranteed a
              // once-per-day fire -- it didn't (see the real duplicate-flood incident and fix at
              // the top of this try block, ~line 2445). The odAlreadyFiredToday check added there
              // is what actually makes this true now.
              const odConfirmCloseBar = allRthBarsRow.rows.find(b => b.et_min >= 615);
              const odRange = (odOrH - odOrL) || 1;
              const driveMag = odConfirmCloseBar
                ? (isLong ? (odConfirmCloseBar.close - odOrH) / odRange : (odOrL - odConfirmCloseBar.close) / odRange)
                : null;

              // OR range + RVol tagging (2026-08-31, RESEARCH_CLAIM
              // setup_d_range_rvol_combo_robust_across_windows) -- informational only, does
              // NOT gate/size this fire. A wide OR range COMBINED WITH elevated relative
              // volume was found to be the worst-performing quadrant for this setup (swept
              // 5 RVol lookback windows before trusting any single one -- 20-day sits in the
              // middle of the range that held up across both chronological halves of
              // history). Stamped here so future real fires can be checked against the
              // backtest finding, not left as a dead end per this codebase's own "no dead
              // ends" rule. `orVolBaseline20d` is a day-cached trailing-20-day average of
              // this same OR-window's volume, prior days only -- see getOrVolBaseline20d().
              const odOrVol = odOrBars.reduce((s, b) => s + (b.bid_vol || 0) + (b.ask_vol || 0), 0);
              const odRvolBaseline = await getOrVolBaseline20d(todayET);
              const odRvol20d = odRvolBaseline ? odOrVol / odRvolBaseline : null;

              if (driveMag != null && driveMag >= DRIVE_MAG_IMMEDIATE_THRESHOLD) {
                const immOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[`${type}_IMMEDIATE`];
                const stopPts = immOpt?.stop ?? 159;
                const targetPts = immOpt?.target ?? 80;
                const entryPx = odConfirmCloseBar.close;
                openingDrive15Min = {
                  type, direction: isLong ? 'LONG' : 'SHORT', entry: entryPx,
                  stop: Math.round(isLong ? entryPx - stopPts : entryPx + stopPts),
                  target: Math.round(isLong ? entryPx + targetPts : entryPx - targetPts),
                  targetLabel: `15-min OR drive IMMEDIATE entry (Setup D hybrid)`,
                  description: `15-min Opening Range drive confirmed ${isLong ? 'up' : 'down'}, already ${driveMag.toFixed(2)}x the OR range past the boundary at 10:15 — entering immediately rather than waiting for a pullback (Stage 4 hybrid rule, OOS lift $8.89/classified-day). Stop ${stopPts}pt / target ${targetPts}pt.`,
                  history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                  orRangeAtDetection: odRange, rvol20dAtDetection: odRvol20d,
                };
              } else {
                // Exact asymmetric pullback band replicated from OPEN_DRIVE above — a
                // symmetric band would test a different (unvalidated) entry rule.
                const nearBoundary = isLong
                  ? (currentPrice >= odOrH - 15 && currentPrice <= odOrH + 5)
                  : (currentPrice <= odOrL + 15 && currentPrice >= odOrL - 5);
                if (nearBoundary) {
                  const opt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[type];
                  // Fallbacks only cover the narrow window before the OPTIMAL_STOP seed row
                  // (Stage 1's own result, stop=85/target=150) exists or if this lookup fails
                  // — same bootstrap-then-real-data-overrides pattern used throughout this file.
                  const stopPts = opt?.stop ?? 85;
                  const targetPts = opt?.target ?? 150;
                  openingDrive15Min = {
                    type, direction: isLong ? 'LONG' : 'SHORT', entry: currentPrice,
                    stop: Math.round(isLong ? currentPrice - stopPts : currentPrice + stopPts),
                    target: Math.round(isLong ? currentPrice + targetPts : currentPrice - targetPts),
                    targetLabel: `15-min OR drive reversal-of-pullback (Setup D)`,
                    description: `15-min Opening Range drive confirmed ${isLong ? 'up' : 'down'}, price pulled back to the OR boundary. Stage 1 bar-history backtest: stop ${stopPts}pt / target ${targetPts}pt (N=138, rigor-clean, beat its own blind-delay control).`,
                    history: { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                    orRangeAtDetection: odRange, rvol20dAtDetection: odRvol20d,
                  };
                }
              }
            }
          }
        }
      } catch (odErr) {
        // Isolated (2026-08-11, same convention as failedSweepReversalSetup above): a bug
        // here should cost this one SHADOW-only setup's fire for this poll, not 500 the
        // entire /api/acd/setup-detection response via the route's own outer catch.
        console.error('[setup-detection] OPENING_DRIVE_15MIN block error (isolated, not fatal):', odErr.message);
        openingDrive15Min = null;
      }

      // ── SETUP 5a: C PAIRED (LONG) ────────────────────────────────────────────
      let cPairedLong = null;
      if (aUpFired && cUpConf && !timelineEvents.some(e => e === 'C_PAIRED_LONG')) {
        const cPairedLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedLong = {
          type: 'C_PAIRED_LONG', label: 'C PAIRED (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: orL ? +orL.toFixed(0) : null,
          target: cPairedLongT1.value,
          targetLabel: cPairedLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up confirmed after an A Up fired. Paired C confirms absorption of seller counter-moves. Hold for weekly extension. Stop below OR Low (${orL?.toFixed(0)}).`,
          history: await getHistory('TRENDING_UP'),
        };
      }

      // ── SETUP 5b: C PAIRED (SHORT) ───────────────────────────────────────────
      let cPairedShort = null;
      if (aDownFired && cDownConf && !timelineEvents.some(e => e === 'C_PAIRED_SHORT')) {
        const cPairedShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange * 1.5 : null, label: 'OR Measured Move 1.5x' }
        );
        cPairedShort = {
          type: 'C_PAIRED_SHORT', label: 'C PAIRED (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: orH ? +orH.toFixed(0) : null,
          target: cPairedShortT1.value,
          targetLabel: cPairedShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down confirmed after an A Down fired. Paired C confirms absorption of buyer counter-moves. Hold for weekly extension. Stop above OR High (${orH?.toFixed(0)}).`,
          history: await getHistory('TRENDING_DOWN'),
        };
      }

      // ── SETUP 5c: C REVERSAL (LONG) ──────────────────────────────────────────
      let cReversalLong = null;
      if (aDownFired && cUpConf && !timelineEvents.some(e => e === 'C_REVERSAL_LONG')) {
        const cReversalLongT1 = t1GuardLabeled('LONG', currentPrice,
          { value: pdVAH, label: 'Prior Day VAH' },
          { value: (orH != null && orRange != null) ? orH + orRange : null, label: 'OR Measured Move' }
        );
        cReversalLong = {
          type: 'C_REVERSAL_LONG', label: 'C REVERSAL (LONG)',
          direction: 'LONG',
          entry: +currentPrice.toFixed(0),
          stop: sessionLow ? +sessionLow.toFixed(0) : (orL ? +orL.toFixed(0) : null),
          target: cReversalLongT1.value,
          targetLabel: cReversalLongT1.label,
          keyLevel: orH ? +orH.toFixed(0) : null, keyLevelLabel: 'OR High',
          description: `C Up fires after a failed A Down signal, confirming that the initial bearish thesis reversed. Stop below session low (${sessionLow?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 5d: C REVERSAL (SHORT) ─────────────────────────────────────────
      let cReversalShort = null;
      if (aUpFired && cDownConf && !timelineEvents.some(e => e === 'C_REVERSAL_SHORT')) {
        const cReversalShortT1 = t1GuardLabeled('SHORT', currentPrice,
          { value: pdVAL, label: 'Prior Day VAL' },
          { value: (orL != null && orRange != null) ? orL - orRange : null, label: 'OR Measured Move' }
        );
        cReversalShort = {
          type: 'C_REVERSAL_SHORT', label: 'C REVERSAL (SHORT)',
          direction: 'SHORT',
          entry: +currentPrice.toFixed(0),
          stop: sessionHigh ? +sessionHigh.toFixed(0) : (orH ? +orH.toFixed(0) : null),
          target: cReversalShortT1.value,
          targetLabel: cReversalShortT1.label,
          keyLevel: orL ? +orL.toFixed(0) : null, keyLevelLabel: 'OR Low',
          description: `C Down fires after a failed A Up signal, confirming that the initial bullish thesis reversed. Stop above session high (${sessionHigh?.toFixed(0)}).`,
          history: await getHistory('TRANSITIONAL'),
        };
      }

      // ── SETUP 6: FAILED AUCTION ───────────────────────────────────────────────
      let failedAuction = null;
      {
        const gLineLost      = timelineEvents.includes('G-Line lost');
        const gLineReclaimed = timelineEvents.includes('G-Line reclaimed');
        const pwHighTested   = timelineEvents.includes('PW High tested');
        const pwHighBroken   = timelineEvents.includes('PW High broken');
        const pwLowTested    = timelineEvents.includes('PW Low tested');
        const pwLowBroken    = timelineEvents.includes('PW Low broken');
        const lastBarVol     = latestBarRow.rows[0]?.volume || 0;
        const highVolume     = avgVol > 0 && lastBarVol > avgVol * 1.5;

        // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
        // IB_BULLISH/BEARISH, OPEN_DRIVE, VALUE_AREA_RESPONSIVE, BRACKET_BREAKOUT — see
        // docs/OPEN_THREADS.md): pdVAL/pdVAH picked first via t1Guard regardless of realistic
        // distance. FAILED_AUCTION_LONG/SHORT were THIN_N (N=3/N=9) with no OPTIMAL_STOP row at
        // the time of that fix, so the 40/35 fallback below was the only option — using the same
        // conservative generic fallback distance as other uncalibrated setups instead of an
        // unbounded structural level. FAILED_AUCTION_LONG has since cleared N≥20 (2026-08-03,
        // stop=54/target=26) — _faOpt now reads that row for new fires; the 40/35 fallback only
        // still applies to FAILED_AUCTION_SHORT (still THIN_N) or if _opt is momentarily unavailable.
        const _faOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt;
        if (pwHighTested && !pwHighBroken && currentPrice && currentPrice < (orH || currentPrice + 50)) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_SHORT?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_SHORT?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_SHORT', label: 'FAILED AUCTION — PRIOR WEEK HIGH',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice + _faStopPts).toFixed(0),
            target: +(currentPrice - _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'Prior Week High',
            description: `Prior week high was tested but price failed to close above it — supply waiting. Bulls pushed to last week's extreme, found sellers, retreated. Fade the failed breakout.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_SHORT') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('BALANCE'),
          };
        } else if (pwLowTested && !pwLowBroken && currentPrice && currentPrice > (orL || currentPrice - 50)) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_LONG?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_LONG?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — PRIOR WEEK LOW',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - _faStopPts).toFixed(0),
            target: +(currentPrice + _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'Prior Week Low',
            description: `Prior week low tested but price failed to close below — buyers defended. Fade the failed breakdown.\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_LONG') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('BALANCE'),
          };
        } else if (gLineLost && gLineReclaimed && currentPrice) {
          const _faStopPts = _faOpt?.FAILED_AUCTION_LONG?.stop ?? 40;
          const _faTargetPts = _faOpt?.FAILED_AUCTION_LONG?.target ?? 35;
          failedAuction = {
            type: 'FAILED_AUCTION_LONG', label: 'FAILED AUCTION — G-LINE RECLAIM',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(currentPrice - _faStopPts).toFixed(0),
            target: +(currentPrice + _faTargetPts).toFixed(0),
            targetLabel: `T1: ${_faTargetPts}pt sweep-optimal · Stop: ${_faStopPts}pt`,
            keyLevel: null, keyLevelLabel: 'G-Line (weekly open)',
            description: `G-Line lost then reclaimed — bears failed to hold below weekly open. ${highVolume ? 'High volume on reclaim confirms conviction.' : ''}\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('FAILED_AUCTION_LONG') ?? 'not yet calibrated'} overall.`,
            history: await getHistory('TRANSITIONAL'),
          };
        }
      }

      // ── SETUP 7: BRACKET BREAKOUT ─────────────────────────────────────────────
      let bracketBreakout = null;
      if (ltRow.rows.length >= 3 && orH && orL && currentPrice && pdVAH && pdVAL) {
        const priorHighs = ltRow.rows.map(r => r.or_high).filter(Boolean);
        const priorLows  = ltRow.rows.map(r => r.or_low).filter(Boolean);
        const bracketTop = priorHighs.length ? Math.max(...priorHighs) : null;
        const bracketBot = priorLows.length  ? Math.min(...priorLows)  : null;
        const breakingUp   = bracketTop && currentPrice > bracketTop + 5 && nl30State === 'BULLISH';
        const breakingDown = bracketBot && currentPrice < bracketBot - 5 && nl30State === 'BEARISH';
        if (breakingUp || breakingDown) {
          const isBull = breakingUp;
          // FIXED 2026-07-17: hand-typed "+4.4% directional edge (55.1% WR, N=49)"/"+30.7% directional
          // edge (80% WR, N=10)" — real live SETUP_STATUS shows BRACKET_BREAKOUT_LONG is SUPPRESS
          // (N=37, WR=29.7%, EV=-$16.84) and BRACKET_BREAKOUT_SHORT is THIN_N (N=16, WR=6.3%,
          // EV=-$104.75) — the polar opposite of the hardcoded claim. Same "never fabricate a stat"
          // violation, plus the same "unbounded structural-level target" bug (raw VA-extension
          // distance, no cap) fixed elsewhere this session (docs/OPEN_THREADS.md). Stop/target now
          // read the real sweep-optimal OPTIMAL_STOP calibration.
          const _bbOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT'];
          const _bbStopPts = _bbOpt?.stop ?? 80;
          const _bbTargetPts = _bbOpt?.target ?? 30;
          bracketBreakout = {
            type: isBull ? 'BRACKET_BREAKOUT_LONG' : 'BRACKET_BREAKOUT_SHORT',
            label: isBull ? 'BRACKET BREAKOUT (LONG)' : 'BRACKET BREAKOUT (SHORT)',
            direction: isBull ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: isBull ? +(currentPrice - _bbStopPts).toFixed(0) : +(currentPrice + _bbStopPts).toFixed(0),
            target: isBull ? +(currentPrice + _bbTargetPts).toFixed(0) : +(currentPrice - _bbTargetPts).toFixed(0),
            targetLabel: `T1: ${_bbTargetPts}pt sweep-optimal · Stop: ${_bbStopPts}pt`,
            keyLevel: +(isBull ? bracketTop : bracketBot).toFixed(0),
            keyLevelLabel: isBull ? 'Prior Bracket Top' : 'Prior Bracket Bottom',
            description: isBull
              ? `5-session bracket top (${bracketTop?.toFixed(0)}) exceeded with NL30 +${nl30}.\n\nEDGE: BRACKET_BREAKOUT_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('BRACKET_BREAKOUT_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Prior bracket top becomes support. Buy pullbacks to the bracket boundary. Stop ${_bbStopPts}pt below entry. Target ${_bbTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — higher conviction.' : ''}`
              : `5-session bracket bottom (${bracketBot?.toFixed(0)}) broken with NL30 ${nl30}.\n\nEDGE: BRACKET_BREAKOUT_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('BRACKET_BREAKOUT_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Prior bracket bottom becomes resistance. Short rallies to bracket boundary. Stop ${_bbStopPts}pt above entry. Target ${_bbTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`,
            history: await getHistory(isBull ? 'TRENDING_UP' : 'TRENDING_DOWN'),
          };
        }
      }

      // ── SETUP 8: VALUE AREA RESPONSIVE ───────────────────────────────────────
      let valueAreaResp = null;
      if (liveOpenVsPrior === 'INSIDE_VALUE' && liveOpeningCallType !== 'OPEN_DRIVE' && currentPrice && pdVAH && pdVAL) {
        const nearVAH = Math.abs(currentPrice - pdVAH) <= 20;
        const nearVAL = Math.abs(currentPrice - pdVAL) <= 20;
        if (nearVAH || nearVAL) {
          const isFade = nearVAH;
          // FIXED 2026-07-17 (same "unbounded structural-level target" bug found and fixed for
          // IB_BULLISH/BEARISH and OPEN_DRIVE — see docs/OPEN_THREADS.md). Both stop (hardcoded
          // +18/-8pt, contradicted its own description text which claimed a different "recalibrated"
          // value) and target (raw PD POC/VAH/VAL distance, unbounded) now read the real sweep-
          // optimal OPTIMAL_STOP calibration instead.
          const _varOpt = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._opt?.[isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG'];
          const _varStopPts = _varOpt?.stop ?? 30;
          const _varTargetPts = _varOpt?.target ?? 28;
          valueAreaResp = {
            type: isFade ? 'VALUE_AREA_RESPONSIVE_SHORT' : 'VALUE_AREA_RESPONSIVE_LONG',
            label: isFade ? 'VALUE AREA RESPONSIVE (SHORT)' : 'VALUE AREA RESPONSIVE (LONG)',
            direction: isFade ? 'SHORT' : 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: isFade ? +(currentPrice + _varStopPts).toFixed(0) : +(currentPrice - _varStopPts).toFixed(0),
            target: isFade ? +(currentPrice - _varTargetPts).toFixed(0) : +(currentPrice + _varTargetPts).toFixed(0),
            targetLabel: `T1: ${_varTargetPts}pt sweep-optimal · Stop: ${_varStopPts}pt`,
            keyLevel: +(isFade ? pdVAH : pdVAL).toFixed(0),
            keyLevelLabel: isFade ? 'Prior Day VAH' : 'Prior Day VAL',
            // FIXED 2026-07-17: hand-typed "66.7% WR (N=60)... 90% WR (N=10)... 93% WR (N=14)" for
            // SHORT, and a hardcoded "-5.0% directional edge, SUPPRESSED" claim for LONG that
            // directly contradicts live data (VALUE_AREA_RESPONSIVE_LONG is actually ACTIVE with
            // positive EV). Same "never fabricate a stat" violation fixed elsewhere this session
            // (docs/OPEN_THREADS.md).
            description: isFade
              ? `Price opened inside prior value and is testing VAH (${pdVAH?.toFixed(0)}) — responsive sellers defend this level.\n\nEDGE: VALUE_AREA_RESPONSIVE_SHORT ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('VALUE_AREA_RESPONSIVE_SHORT') ?? 'not yet calibrated'} overall. EXECUTION: Stop ${_varStopPts}pt above entry. Target ${_varTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`
              : `Price opened inside prior value and is testing VAL (${pdVAL?.toFixed(0)}) — responsive buyers defend this level.\n\nEDGE: VALUE_AREA_RESPONSIVE_LONG ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('VALUE_AREA_RESPONSIVE_LONG') ?? 'not yet calibrated'} overall. EXECUTION: Stop ${_varStopPts}pt below entry. Target ${_varTargetPts}pt sweep-optimal.${nearPD2VA ? '\n\n✅ AT PD-2 VA CONFLUENCE — highest conviction.' : ''}`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 9: C STANDALONE ─────────────────────────────────────────────────
      // No A signal today — first C break of OR is the setup
      let cStandalone = null;
      // RE-ENABLED 2026-07-17 (user directive: shadow every confirmed-losing setup instead of
      // hard-killing it, so forward data keeps accumulating and it can be reconsidered if it
      // recovers -- "treat these like the others that go through the motions"). Both branches
      // were fully disabled since 2026-07-05 (C_STANDALONE_UP: empty branch, C_STANDALONE_DOWN:
      // `if (false)`), meaning NEITHER fired even in shadow mode -- zero new data collected for
      // 12 days, unlike every other suppressed setup in this file (OPEN_TEST_DRIVE,
      // BRACKET_BREAKOUT, IB_BULLISH/BEARISH, the generic level-fade family), which all
      // continue to construct and rely on the existing dynamic mechanism (shadowCandidates ->
      // liveStats._suppressedSetups -> status='SHADOW' at insert time, ~line 6018) to keep
      // them out of live trade recommendations without freezing their data collection. This
      // restores that same treatment for C_STANDALONE_UP/DOWN -- no change to the suppression
      // mechanism itself, just removing the two setup_types that had been special-cased out of
      // it. Both are still SUPPRESS in live SETUP_STATUS as of tonight, so they will insert as
      // status='SHADOW', not 'ACTIVE' -- they cannot fire as real trades either way.
      if (!aUpFired && !aDownFired && !hasCFiredToday && currentPrice && orH && orL) {
        if (currentPrice > orH) {
          cStandalone = {
            type: 'C_STANDALONE_UP', label: 'C UP (STANDALONE)',
            direction: 'LONG',
            entry: +currentPrice.toFixed(0),
            stop: +(orL - 4).toFixed(0),
            target: t1Guard('LONG', currentPrice, pdVAH, currentPrice + (orRange || 80)),
            // FIXED 2026-09-07 (OPEN_DECISION backtest_unified_detectors_systemic_divergence_20260907):
            // this used to advertise "half off at T1 / runner 45pt" -- C_STANDALONE has no
            // runner_trail_width/extend_target_level/CONDITIONAL_VARIANTS entry anywhere, so
            // every real trade resolves flat against this single target, same bug already
            // fixed for VWAP_MAGNET this session. Describe the real flat-exit behavior.
            targetLabel: 'T1: PD VAH (flat)',
            keyLevel: +orH.toFixed(0), keyLevelLabel: 'OR High',
            description: `No A signal today. C Up — price closing above OR High (${orH?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('C_STANDALONE_UP') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
            history: await getHistory('BALANCE'),
          };
        } else if (currentPrice < orL && nearPD2VA) {
          cStandalone = {
            type: 'C_STANDALONE_DOWN', label: 'C DOWN (STANDALONE)',
            direction: 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(orH + 4).toFixed(0),
            target: t1Guard('SHORT', currentPrice, pdVAL, currentPrice - (orRange || 80)),
            // FIXED 2026-09-07 (same bug as the LONG branch above): no scale-out is
            // mechanically enforced for this setup -- describe the real flat exit.
            targetLabel: 'T1: PD VAL (flat)',
            keyLevel: +orL.toFixed(0), keyLevelLabel: 'OR Low',
            description: `No A signal today. C Down — price closing below OR Low (${orL?.toFixed(0)}).\n\nEDGE: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('C_STANDALONE_DOWN') ?? 'not yet calibrated'} overall — this setup is currently suppressed (confirmed negative EV).`,
            history: await getHistory('BALANCE'),
          };
        }
      }

      // ── SETUP 10: GAP FILL ──────────────────────────────────────────────────
      let gapFill = null;
      {
        const rangesQ = await query(`
          SELECT d, rth_low, rth_high FROM (
            SELECT ts::date::text as d,
              MIN(low)::float as rth_low,
              MAX(high)::float as rth_high
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
              AND ts::date <= $1
            GROUP BY ts::date
            ORDER BY ts::date DESC
            LIMIT 40
          ) sub ORDER BY d ASC
        `, [todayET]);
        const sessions = rangesQ.rows;

        if (sessions.length >= 2 && currentPrice) {
          const gaps = [];
          for (let i = 1; i < sessions.length; i++) {
            const prev = sessions[i - 1];
            const curr = sessions[i];
            if (curr.rth_low > prev.rth_high) {
              gaps.push({ type: 'up', fromDate: prev.d, toDate: curr.d, gapLow: prev.rth_high, gapHigh: curr.rth_low });
            } else if (curr.rth_high < prev.rth_low) {
              gaps.push({ type: 'down', fromDate: prev.d, toDate: curr.d, gapLow: curr.rth_high, gapHigh: prev.rth_low });
            }
          }

          const openGaps = [];
          for (const gap of gaps) {
            const gapIdx = sessions.findIndex(s => s.d === gap.toDate);
            const gapSize = gap.gapHigh - gap.gapLow;
            let filled = false;
            for (let i = gapIdx + 1; i < sessions.length; i++) {
              const s = sessions[i];
              if (gap.type === 'up') {
                if (s.rth_low <= gap.gapLow) { filled = true; break; }
              } else {
                if (s.rth_high >= gap.gapHigh) { filled = true; break; }
              }
            }
            if (!filled) {
              openGaps.push({ ...gap, gapSize });
            }
          }

          for (const gap of openGaps) {
            if (currentPrice < gap.gapHigh && currentPrice > gap.gapLow) {
              if (gap.type === 'up') {
                gapFill = {
                  type: 'GAP_FILL_SHORT',
                  label: `GAP FILL SHORT (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'SHORT',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapHigh + 15),
                  target: t1Guard('SHORT', currentPrice, gap.gapLow),
                  targetLabel: 'Gap Floor',
                  keyLevel: +Math.round(gap.gapHigh),
                  keyLevelLabel: 'Gap Ceiling',
                  description: `NQ entered the unfilled up-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill down to ${Math.round(gap.gapLow)}. Invalidation is 15 pts above gap ceiling.`,
                  history: await getHistory('TREND'),
                };
              } else {
                gapFill = {
                  type: 'GAP_FILL_LONG',
                  label: `GAP FILL LONG (${gap.fromDate} to ${gap.toDate})`,
                  direction: 'LONG',
                  entry: +currentPrice.toFixed(0),
                  stop: +Math.round(gap.gapLow - 15),
                  target: t1Guard('LONG', currentPrice, gap.gapHigh),
                  targetLabel: 'Gap Ceiling',
                  keyLevel: +Math.round(gap.gapLow),
                  keyLevelLabel: 'Gap Floor',
                  description: `NQ entered the unfilled down-gap zone from ${gap.fromDate} to ${gap.toDate} (${Math.round(gap.gapLow)}–${Math.round(gap.gapHigh)}). Expecting fast travel to complete the gap fill up to ${Math.round(gap.gapHigh)}. Invalidation is 15 pts below gap floor.`,
                  history: await getHistory('TREND'),
                };
              }
              break;
            }
          }
        }
      }

      // IB setup day-type precision gate — made DYNAMIC 2026-07-24 (was a hardcoded boolean
      // based on a stale in-code comment snapshot, re-verified/updated by hand at least twice
      // before, 2026-07-07 then 2026-07-14 — exactly the silent-drift pattern this codebase has
      // hit before, see docs/OPEN_THREADS.md). Now reads real DAY_TYPE_ALPHA rows (populated
      // weekly by backtest_day_type_alpha.js, extended 2026-07-23 to cover IB_BULLISH/IB_BEARISH
      // — previously excluded by that script's `LIKE '%FADE%'` filter) instead of a fixed
      // decision, using the same standard N>=20 / EV<-$5 bar this codebase already uses
      // everywhere else (backtest_setup_status.mjs's SUPPRESS floor) rather than a new
      // threshold. Self-corrects automatically as real data accumulates — no more manual
      // re-verification needed. liveStats._dta isn't populated until much later in this
      // function (~line 4877's Promise.all) so this can't reuse that shared object here;
      // intentionally a small, self-contained query instead of restructuring control flow in
      // this fragile function.
      if (ibSetup) {
        const ibDtaQ = await query(`
          SELECT DISTINCT ON (signal_name) signal_name, sample_size, ev_per_trade, notes, run_date::text
          FROM performance_audit
          WHERE signal_type='DAY_TYPE_ALPHA' AND signal_name = ANY($1::text[])
          ORDER BY signal_name, run_date DESC
        `, [['IB_BULLISH_BALANCE', 'IB_BULLISH_TREND', 'IB_BULLISH_TURBULENT',
             'IB_BEARISH_BALANCE', 'IB_BEARISH_TREND', 'IB_BEARISH_TURBULENT']]);
        const ibDtaRow = ibDtaQ.rows.find(r => r.signal_name === `${ibSetup.type}_${dtClass}`);
        if (ibDtaRow) {
          // Real-N floor added 2026-07-28 (Opus Audit #5 + direct user question "why is
          // IB_BULLISH still firing") -- the check above this comment trusted the BLENDED
          // cell EV with no origin_status filter, same gap PROMOTE_MIN_REAL_N already fixed
          // for the main SUPPRESS check on 2026-07-20 (backtest_setup_status.mjs) but never
          // applied here. Confirmed live: IB_BULLISH_TREND fired on blended EV=+$37.8 while
          // real (ACTIVE/SHADOW-origin) support was 0 trades -- all UNKNOWN-origin, unverifiable.
          // IB_BEARISH_TURBULENT fired on blended +$57.1 while real EV was -$12.70 (N=10 real).
          // Fix: once a cell has >=REAL_N_FLOOR real trades, trust REAL EV instead of blended
          // (this can un-suppress a cell whose blended EV looks bad but whose real trades are
          // fine, not just suppress) -- below the floor, treat as unproven and don't fire it
          // live regardless of how good blended looks, since blended can't be trusted at all
          // (the exact IB_BULLISH_TREND failure mode). REAL_N_FLOOR=5 reuses backtest_setup_
          // status.mjs's PROMOTE_MIN_REAL_N precedent (not importable directly -- that file
          // runs its whole backtest unconditionally on import, so redeclaring the same value
          // here with this comment is the established pattern, see IB_MID_SCALP's own local
          // PT/COMM redeclaration elsewhere in this file for the identical convention).
          const REAL_N_FLOOR = 5;
          const dtaNotes = ibDtaRow.notes ? JSON.parse(ibDtaRow.notes) : {};
          const realN = dtaNotes.real_n ?? 0;
          const realEv = dtaNotes.real_ev;
          const unproven = realN < REAL_N_FLOOR;
          const realBad = !unproven && realEv != null && realEv < -5;
          if (unproven || realBad) {
            // FIXED 2026-08-05 (RESEARCH_CLAIM ib_bullish_blocked_by_stale_daytype_alpha_realn0):
            // this gate previously nulled ibSetup with zero trace anywhere -- not a console
            // line, not a DB row, nothing. It silently blocked every IB_BULLISH RTH candidate
            // for 2+ days (a stale DAY_TYPE_ALPHA row reading real_n=0) and was only found by
            // reasoning backward from an unexplained outage. A gate that nulls a candidate
            // must say why, in real time, not just in a scratch/*.log line that scrolls away --
            // console.error so it lands in scratch/server_errors.jsonl (the standing error
            // watcher already tails this) and is queryable/greppable after the fact.
            const ibGateReason = `DAY_TYPE_ALPHA real-N floor: cell=${ibDtaRow.signal_name} run_date=${ibDtaRow.run_date} real_n=${realN} (floor=${REAL_N_FLOOR}) real_ev=${realEv ?? 'n/a'} reason=${unproven ? 'unproven (real_n<floor)' : 'realBad (real_ev<-5)'}`;
            console.error(`[ib-gate] ${ibSetup.type} NULLED by ${ibGateReason}`);
            logGatedCandidate({ tradeDate: todayET, setupType: ibSetup.type, gateName: 'IB_DAYTYPE_REAL_N_FLOOR', gateReason: ibGateReason, entry: ibSetup.entry, stop: ibSetup.stop, target: ibSetup.target });
            ibSetup = null;
          }
        }
      }

      // Morning volatility regime — used to gate C_STANDALONE in HIGH-VOL-CHOP (0% WR confirmed, regime backtest 2026-06-30)
      const regimeResult = await computeLiveVolatilityRegime().catch(() => ({ regime: null }));
      const morningRegime = regimeResult?.regime || null;

      // ── BULLISH ABSORPTION detection (support held + RSI rising + price flat) ──
      // Uses 2-min bars: 5-min was too coarse (16 fires/yr, 0 morning). 2-min
      // fires ~83/yr with 32 morning detections on BALANCE days.
      let absorptionSetup = null;
      if (allRthBarsRow.rows.length >= 30) {
        const absFb = resampleBars(allRthBarsRow.rows, 2);
        if (absFb.length >= 25) {
          const absC = absFb.map(b => b.close);
          const absRsi = computeRSI14(absC);

          const AW = 20;
          const last = absC.length - 1;
          if (last >= AW + 5 && absRsi[last] != null && absRsi[last - AW] != null) {
            const wb = absFb.slice(last - AW, last + 1);
            const wH = Math.max(...wb.map(b => b.high)), wL = Math.min(...wb.map(b => b.low));
            const wRange = wH - wL;
            const rsiDrift = absRsi[last] - absRsi[last - AW];
            const priceDrift = absC[last] - absC[last - AW];
            const priceFlat = Math.abs(priceDrift) < wRange * 0.3;
            const lowCluster = wb.filter(b => Math.abs(b.low - wL) < 5).length;

            const isBullAbsorption = lowCluster >= 4 && rsiDrift > 4 && priceFlat;
            const dayTypeOk = dtClass === 'BALANCE';

            if (isBullAbsorption && dayTypeOk) {
              const nearPD1VA = pdVAL && Math.abs(currentPrice - pdVAL) <= 25;
              const nearPD1POC = pdPOC && Math.abs(currentPrice - pdPOC) <= 25;
              const atLevel = nearPD1VA || nearPD1POC;

              const stopDist = 25;
              const targetDist = 40;
              // FIXED 2026-07-17: hand-typed "71.4% WR (N=35)... 90.9% WR (N=11)" with zero backing
              // data (ABSORPTION_LONG has never fired in active_setups) — same "never fabricate a
              // stat" violation as RSI_DIV above. Now reads liveStats._setupStats honestly.
              const _absorpStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.ABSORPTION_LONG;
              const _absorpEdge = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('ABSORPTION_LONG') ?? 'not yet calibrated';
              absorptionSetup = {
                type: 'ABSORPTION_LONG',
                direction: 'LONG',
                entry: +currentPrice.toFixed(0),
                stop: +(currentPrice - stopDist).toFixed(0),
                target: +(currentPrice + targetDist).toFixed(0),
                targetLabel: '40pt Runner (calibrated)',
                description: `Bullish absorption detected: ${lowCluster} 2-min bars clustering at support (${Math.round(wL)}), RSI rising +${rsiDrift.toFixed(0)} while price flat in ${Math.round(wRange)}pt range.\n\nEDGE: Bullish absorption ${_absorpEdge} overall.\n\nEXECUTION: Price held at support with buyers absorbing selling pressure. RSI confirms hidden bullish momentum. Enter long, stop below support zone (${Math.round(currentPrice - stopDist)}), target ${pdVAH ? 'PD VAH (' + Math.round(pdVAH) + ')' : '2R'}.${atLevel ? '\n\n✅ AT 2D VA LEVEL — historically higher conviction near this confluence.' : ''}${nearPD2VA ? '\n✅ PD-2 VA CONFLUENCE' : ''}`,
                history: (_absorpStats && _absorpStats.n >= 20)
                  ? { winRate: _absorpStats.wr, occurrences: _absorpStats.n, avgPnl: _absorpStats.ev, t1HitRate: _absorpStats.wr }
                  : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
              };
            }
          }
        }
      }

      // ── COIL SURGE detection (coil → volume surge → fade toward VWAP) ─────
      let coilSurgeSetup = null;
      if (allRthBarsRow.rows.length >= 60) {
        const cbars = allRthBarsRow.rows;
        const cRW = 15, cRT = 40, cVR = 0.40, cBB = 20, cPOP = 2.5;
        // Progressive VWAP
        let cPV = 0, cTV = 0;
        const cVwaps = [];
        for (const b of cbars) {
          const tp = (b.high + b.low + b.close) / 3;
          cPV += tp * (Number(b.vol) || 1); cTV += (Number(b.vol) || 1);
          cVwaps.push(cTV > 0 ? cPV / cTV : null);
        }

        for (let ci = 50; ci < cbars.length; ci++) {
          // Rolling range
          let cHi = -Infinity, cLo = Infinity;
          for (let j = ci - cRW + 1; j <= ci; j++) { cHi = Math.max(cHi, cbars[j].high); cLo = Math.min(cLo, cbars[j].low); }
          if (cHi - cLo >= cRT) continue;

          // Anchored baseline volume
          const cbs = Math.max(0, ci - cRW - cBB), cbe = ci - cRW;
          if (cbe - cbs < 10) continue;
          const cBv = cbars.slice(cbs, cbe).reduce((s, b) => s + (Number(b.vol) || 0), 0) / (cbe - cbs);
          if (cBv <= 0 || (Number(cbars[ci].vol) || 0) / cBv >= cVR) continue;

          // Check if CURRENT bar (latest) is a surge bar
          const lastBar = cbars[cbars.length - 1];
          const lastVol = Number(lastBar.vol) || 0;
          if (lastVol < cBv * cPOP) continue; // no surge yet
          if (ci < cbars.length - 5) continue; // coil must be recent (within last 5 bars)

          const vwap = cVwaps[cbars.length - 1];
          if (!vwap) continue;

          const dist = currentPrice - vwap;
          const isLong = dist < 0; // below VWAP → long toward VWAP
          const targetDist = Math.abs(dist);
          if (targetDist < 8) continue; // too close to VWAP, no trade

          const stopDist = Math.max(15, isLong ? currentPrice - (cLo - 5) : (cHi + 5) - currentPrice);
          const dayTypeOk = (dtClass === 'TREND' || (isLong && nl30 > 9) || (!isLong && nl30 < -9));
          if (!dayTypeOk) break; // only fire on TREND or NL30-aligned

          // FIXED 2026-07-17: hand-typed "65.3% WR on TREND days (N=49)... Expectancy +$24/trade"
          // with zero backing data (COIL_SURGE has never fired in active_setups) — same "never
          // fabricate a stat" violation as RSI_DIV/ABSORPTION_LONG above.
          const _coilType = isLong ? 'COIL_SURGE_LONG' : 'COIL_SURGE_SHORT';
          const _coilStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.[_coilType];
          const _coilEdge = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.(_coilType) ?? 'not yet calibrated';
          coilSurgeSetup = {
            type: _coilType,
            direction: isLong ? 'LONG' : 'SHORT',
            entry: +currentPrice.toFixed(0),
            stop: +(isLong ? currentPrice - stopDist : currentPrice + stopDist).toFixed(0),
            target: +vwap.toFixed(0),
            targetLabel: 'RTH VWAP',
            description: `Coil detected (${(cHi - cLo).toFixed(0)}pt range, volume ${((Number(cbars[ci].vol)||0)/cBv*100).toFixed(0)}% of baseline) with volume surge (${(lastVol/cBv).toFixed(1)}x baseline). Price is ${Math.abs(dist).toFixed(0)}pt ${dist > 0 ? 'above' : 'below'} VWAP.\n\nEDGE: Coil→surge→VWAP fade ${_coilEdge} overall.\n\nEXECUTION: Fade toward VWAP (${Math.round(vwap)}). Stop at coil range extreme (${isLong ? Math.round(cLo - 5) : Math.round(cHi + 5)}). Hold 10 bars max — edge decays after that. Only fires on TREND days or NL30-aligned.${nearPD2VA ? '\n\n✅ PD-2 VA CONFLUENCE' : ''}`,
            history: (_coilStats && _coilStats.n >= 20)
              ? { winRate: _coilStats.wr, occurrences: _coilStats.n, avgPnl: _coilStats.ev, t1HitRate: _coilStats.wr }
              : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
          };
          break;
        }
      }

      // ── 15min RSI Divergence detection ──────────────────────────────────────
      let rsiDivSetup = null;
      if (allRthBarsRow.rows.length >= 20) {
        // Resample to 15min
        const fb15 = resampleBars(allRthBarsRow.rows, 15);
        if (fb15.length >= 17) {
          const fc = fb15.map(b => b.close), fh = fb15.map(b => b.high), fl = fb15.map(b => b.low);
          const rsiArr = computeRSI14(fc);
          // Swing detection (N=2 for 15min — smaller window, faster detection)
          const SW = 2;
          const sHighs = [], sLows = [];
          for (let i = SW; i < fc.length - SW; i++) {
            let isH = true, isL = true;
            for (let j = 1; j <= SW; j++) {
              if (fh[i] <= fh[i-j] || fh[i] <= fh[i+j]) isH = false;
              if (fl[i] >= fl[i-j] || fl[i] >= fl[i+j]) isL = false;
            }
            if (isH) sHighs.push({ idx: i, price: fh[i], rsi: rsiArr[i] });
            if (isL) sLows.push({ idx: i, price: fl[i], rsi: rsiArr[i] });
          }
          // Check for divergence using the two most recent swing points
          // Bullish: price lower low + RSI higher low + CONFIRMATION bar closes higher
          if (sLows.length >= 2) {
            const curr = sLows[sLows.length - 1], prev = sLows[sLows.length - 2];
            if (curr.idx - prev.idx <= 12 && curr.price < prev.price && curr.rsi != null && prev.rsi != null && curr.rsi > prev.rsi) {
              const last = fc.length - 1;
              const confirmIdx = curr.idx + 1;
              const confirmed = confirmIdx <= last && fc[confirmIdx] > fc[curr.idx];
              if (confirmed && last - confirmIdx <= 2) {
                const stopDist = Math.max(20, Math.round((fh[curr.idx] - fl[curr.idx]) * 1.5));
                const rsiDelta = (curr.rsi - prev.rsi).toFixed(1);
                // FIXED 2026-07-17: this used to hand-type "WR with confirmation: 90.0% (N=20)" and a
                // matching history{} object with no real backing data at all — RSI_DIV_BULLISH has
                // zero fired trades in active_setups, a direct "never fabricate a stat" violation
                // (see CLAUDE.md, docs/OPEN_THREADS.md). Now reads liveStats._setupStats honestly via
                // _edgeText(), which reports real N/WR or says plainly there's no calibration yet.
                const _rsiBullStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.RSI_DIV_BULLISH;
                rsiDivSetup = {
                  type: 'RSI_DIV_BULLISH',
                  direction: 'LONG',
                  entry: currentPrice,
                  stop: currentPrice - stopDist,
                  target: t1Guard('LONG', currentPrice, currentPrice + stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BULLISH divergence CONFIRMED. Price made lower low (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made higher low (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ+${rsiDelta}). Confirmation bar closed higher — selling exhaustion confirmed. WR with confirmation: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('RSI_DIV_BULLISH') ?? 'not yet calibrated'}. Scalp long — hold 3 bars (45min) max. Take profit at value area midpoint or 2R.`,
                  history: (_rsiBullStats && _rsiBullStats.n >= 20)
                    ? { winRate: _rsiBullStats.wr, occurrences: _rsiBullStats.n, avgPnl: _rsiBullStats.ev, t1HitRate: _rsiBullStats.wr }
                    : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                };
              }
            }
          }
          // Bearish: price higher high + RSI lower high + CONFIRMATION bar closes lower
          if (!rsiDivSetup && sHighs.length >= 2) {
            const curr = sHighs[sHighs.length - 1], prev = sHighs[sHighs.length - 2];
            if (curr.idx - prev.idx <= 12 && curr.price > prev.price && curr.rsi != null && prev.rsi != null && curr.rsi < prev.rsi) {
              const last = fc.length - 1;
              const confirmIdx = curr.idx + 1;
              const confirmed = confirmIdx <= last && fc[confirmIdx] < fc[curr.idx];
              if (confirmed && last - confirmIdx <= 2) {
                const stopDist = Math.max(20, Math.round((fh[curr.idx] - fl[curr.idx]) * 1.5));
                const rsiDelta = (prev.rsi - curr.rsi).toFixed(1);
                // FIXED 2026-07-17: see the matching RSI_DIV_BULLISH comment above — same fabricated-
                // stat bug, same fix (RSI_DIV_BEARISH also has zero fired trades in active_setups).
                const _rsiBearStats = getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._setupStats?.RSI_DIV_BEARISH;
                rsiDivSetup = {
                  type: 'RSI_DIV_BEARISH',
                  direction: 'SHORT',
                  entry: currentPrice,
                  stop: currentPrice + stopDist,
                  target: t1Guard('SHORT', currentPrice, currentPrice - stopDist * 2),
                  targetLabel: '2R Target',
                  description: `15min RSI BEARISH divergence CONFIRMED. Price made higher high (${Math.round(curr.price)} vs ${Math.round(prev.price)}) but RSI made lower high (${curr.rsi.toFixed(0)} vs ${prev.rsi.toFixed(0)}, Δ-${rsiDelta}). Confirmation bar closed lower — buying exhaustion confirmed. WR with confirmation: ${getCached(todayET, 'levelFadeStats', DAY_CACHE_TTL)?._edgeText?.('RSI_DIV_BEARISH') ?? 'not yet calibrated'}. Scalp short — hold 2-3 bars (30-45min) max. Take profit at value area midpoint or 2R.`,
                  history: (_rsiBearStats && _rsiBearStats.n >= 20)
                    ? { winRate: _rsiBearStats.wr, occurrences: _rsiBearStats.n, avgPnl: _rsiBearStats.ev, t1HitRate: _rsiBearStats.wr }
                    : { winRate: null, occurrences: null, avgPnl: null, t1HitRate: null },
                };
              }
            }
          }
        }
      }


  return {
    trtLongV2, trtShortV2, otdSetup, aUpStrong, aDownWeak, trtMah, trt,
    dtClass, sessionConflictFor, ibSetup,
    openDrive, openingDrive15Min, cPairedLong, cPairedShort, cReversalLong, cReversalShort,
    failedAuction, bracketBreakout, valueAreaResp, cStandalone, gapFill,
    morningRegime, absorptionSetup, coilSurgeSetup, rsiDivSetup,
  };
}

// ── runSetupDetection decomposition, Pass 2 continued: P3 factor pre-fetch (2026-09-07) ──
// Extracted verbatim from runSetupDetection's body per the 2026-09-06 DeepSeek review's
// revised P3 assessment (already found this phase reads a P2 output -- dtClass -- via
// _lfRegimePersistQ, so it's not fully independent of buildAllCandidates()'s result; kept
// as ONE coarse wrapper, not split further, matching the same conservative call made for P2).
// Free-variable check (2026-09-07): only todayET, dtClass, allRthBarsRow, aUpFired, aDownFired
// are read from outside this block -- everything else (query/getCached/setCached/
// getGlobalCalib/getPriorDayProfile/DAY_CACHE_TTL/_pdpMissingLogged) is a module-level
// import/const already in scope for any top-level function in this file, same as
// buildAllCandidates(). Return-completeness check: every name below was independently grepped
// against the entire remainder of runSetupDetection (the P4 level-fade block through the final
// persist step). lfPriorStop/lfPriorWin were found to have ZERO downstream references anywhere
// in the file at extraction time (pre-existing dead code, not introduced by this move) -- kept
// unpruned in the original P3 commit per this codebase's precedent of not making cleanup
// judgment calls during a pure structural move, then deleted outright 2026-09-07 (re-confirmed
// still dead, no new references, as part of a broader dead-code pass).
export async function computeLevelFadeFactors(ctx) {
  const { todayET, dtClass, allRthBarsRow, aUpFired, aDownFired } = ctx;
        // Prior-day TREND risk gate (2026-09-06) — fetched once here, referenced as a plain
        // closure variable inside the (synchronous) sizeMultiplier IIFE below, same pattern as
        // dtClass just above. See getPriorDayProfile()'s own header (acdLiveCalibration.js) for
        // the full finding this feeds and why a pooled gate was chosen over a per-cell mirror
        // of DAY_TYPE_ALPHA (DeepSeek design critique, 2026-09-06).
        const priorDayProfile = await getPriorDayProfile(todayET);
        if (priorDayProfile == null && !_pdpMissingLogged.has(todayET)) {
          _pdpMissingLogged.add(todayET);
          console.error(`[priorDayProfile-gate] No auction_reads.prior_day_profile for ${todayET} — TREND-day risk gate is silently inert until today's pre-market ACD read is entered.`);
        }
  
        // ── Pre-fetch: overnight reads + prior setups (needed BEFORE level fade section) ─────
        // isS2DoubleCounter, isOvernightAligned, sizeMultiplier all reference these.
        // Previously defined at line ~4392 — caused silent TDZ ReferenceError on every level
        // fade call. Outer try{} at line 2545 caught it; fades appeared to work but sizeMultiplier
        // and isS2DoubleCounter suppression were both non-functional. Fixed 2026-07-05.
        // Batched 2026-07-15 — these 7 queries only depend on todayET (or nothing at
        // all, for the two bar-derived ones below), none on each other's results, but
        // were awaited one at a time. Profiling confirmed this exact section
        // ("Pre-fetch: overnight reads + prior setups") as the single dominant
        // contributor to /api/acd/setup-detection's remaining latency (1.8-6.7s of a
        // ~9-15s total, see docs/OPEN_THREADS.md) — collapsed into one Promise.all,
        // same pattern already applied to the Unified Level Fade Setups section above.
        const _cachedVwapSigmaPre = getCached(todayET, 'lfVwapSigma');
        const [_lfArRow, _lfPriorQ, _lfSameDirCountQ, _lfNl30Q, _lfVwapSigmaQ, _lfRecencyQ] = await Promise.all([
          query(`SELECT overnight_inventory, open_vs_prior_value FROM auction_reads WHERE trade_date=$1`, [todayET]).catch(() => ({ rows: [] })),
          // origin_status='ACTIVE' added 2026-07-27 (unify_sizemultiplier_into_validated_score) --
          // this drives lfConsecWins/lfConsecLosses, the win/loss-streak sizing factor (the largest
          // magnitude adjustments in the whole IIFE, up to +0.50/capped at 0.10). Predates the
          // origin_status column (written 2026-06-22, column added 2026-07-17) and was never
          // revisited. This is specifically about the TRADER'S OWN recent real trades (a
          // psychological/risk concept), so scoped to ACTIVE only -- SHADOW setups were never
          // shown to the user, so a SHADOW "loss" isn't something the user experienced either.
          query(`SELECT resolution FROM active_setups WHERE trade_date=$1 AND origin_status='ACTIVE' AND status='RESOLVED' ORDER BY fired_at DESC LIMIT 3`, [todayET]).catch(() => ({ rows: [] })),
          // origin_status IN ('ACTIVE','SHADOW') added 2026-07-27 -- unlike the streak query above,
          // "stacking" (how many same-direction fade attempts have occurred today) is a MARKET
          // STRUCTURE signal, not a personal-day one -- a SHADOW-origin touch is still a real,
          // live-price-triggered event (just suppressed from a full alert), so it legitimately
          // counts toward "how many real fades has this direction seen today." BACKFILL/UNKNOWN
          // (synthetic/historical) do not represent today's real market activity and are excluded.
          // TOUCH-AWARE 2026-09-07 (cluster touch credit Phase 2, DeepSeek design-critiqued): a
          // cluster's winner and its CLUSTER_SIBLING_TOUCH_CREDIT siblings all share one
          // cluster_touch_id (set to their own row id when there's no cluster), so
          // COUNT(DISTINCT COALESCE(cluster_touch_id, id)) counts one real market touch once,
          // not once per level that happened to sit in the same 15pt confluence zone. This is a
          // deliberate behavior CHANGE to a live sizing input (feeds the >=7-same-direction ->
          // 0.10x sizeMultiplier cap below), not a silent bugfix -- a clustered touch now counts
          // for LESS toward that de-risking cap than it did before this date. Siblings only ever
          // enter this count once they resolve to status='RESOLVED' (they insert as SHADOW/
          // status='ACTIVE' like anything else, so the count was never inflated at INSERT time,
          // only as resolved siblings accumulated over the session).
          query(
            `SELECT CASE WHEN setup_type LIKE '%_LONG' THEN 'LONG' WHEN setup_type LIKE '%_SHORT' THEN 'SHORT' END AS direction,
                    COUNT(DISTINCT COALESCE(cluster_touch_id, id)) as cnt
             FROM active_setups WHERE trade_date=$1 AND origin_status IN ('ACTIVE','SHADOW') AND status IN ('ACTIVE','RESOLVED')
             GROUP BY 1`,
            [todayET]
          ).catch(() => ({ rows: [] })),
          query(`
            SELECT COALESCE(SUM(COALESCE(daily_score, 0)), 0)::int AS nl30
            FROM (SELECT daily_score FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 30) sub
          `, [todayET]).catch(() => ({ rows: [{ nl30: 0 }] })),
          _cachedVwapSigmaPre ? Promise.resolve(null) : query(`
            WITH svwap AS (
              SELECT close::float as c,
                SUM((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float * close::float) OVER (PARTITION BY ts::date ORDER BY ts) /
                NULLIF(SUM((COALESCE(ask_volume,0)+COALESCE(bid_volume,0))::float) OVER (PARTITION BY ts::date ORDER BY ts), 0) AS vwap
              FROM price_bars_primary
              WHERE symbol='NQ'
                AND ts::date IN (SELECT DISTINCT ts::date FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 ORDER BY ts::date DESC LIMIT 20)
                AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            )
            SELECT AVG(ABS(c - vwap))::float as mean_dist, STDDEV(ABS(c - vwap))::float as std_dist
            FROM svwap WHERE vwap IS NOT NULL
          `, [todayET]).catch(() => ({ rows: [{}] })),
          // origin_status IN ('ACTIVE','SHADOW') added 2026-07-27 -- "level recency" (was this level
          // tested recently = proven defender, vs untested = risky) is about REAL market touches,
          // same reasoning as the stacking-count fix above. Without this, a level with dense
          // BACKFILL/UNKNOWN historical coverage would almost always show as "recently tested"
          // regardless of genuine recent activity.
          query(`
            SELECT
              REGEXP_REPLACE(setup_type, '_(LONG|SHORT)$', '') AS level_base,
              MAX(trade_date)::text AS last_date
            FROM active_setups
            WHERE trade_date >= $1::date - INTERVAL '21 days' AND trade_date < $1
              AND origin_status IN ('ACTIVE','SHADOW')
              AND status = 'RESOLVED'
            GROUP BY level_base
          `, [todayET]).catch(() => ({ rows: [] })),
        ]);
        const _lfOvInv  = _lfArRow.rows[0]?.overnight_inventory;
        const _lfOvOpen = _lfArRow.rows[0]?.open_vs_prior_value;
        const isOvernightAligned = (dir) =>
          (dir === 'LONG'  && (_lfOvInv === 'SHORT_TRAPPED' || _lfOvOpen === 'ABOVE_VALUE')) ||
          (dir === 'SHORT' && (_lfOvInv === 'LONG_TRAPPED'  || _lfOvOpen === 'BELOW_VALUE'));
        const isOvernightCounter = (dir) =>
          (dir === 'LONG'  && (_lfOvInv === 'LONG_TRAPPED'  || _lfOvOpen === 'BELOW_VALUE')) ||
          (dir === 'SHORT' && (_lfOvInv === 'SHORT_TRAPPED' || _lfOvOpen === 'ABOVE_VALUE'));
        // S2 double-counter: BOTH overnight inventory AND open-vs-value disagree with fade direction.
        // Backtest: baseline 72.2% WR → S2 filter $8,225 (+$833). Only suppress when both agree.
        const isS2DoubleCounter = (dir) =>
          (dir === 'LONG'  && _lfOvInv === 'LONG_TRAPPED'  && _lfOvOpen === 'BELOW_VALUE') ||
          (dir === 'SHORT' && _lfOvInv === 'SHORT_TRAPPED' && _lfOvOpen === 'ABOVE_VALUE');
        // Prior completed setups — streak depth sizing.
        // Research 2026-07-05: 1×loss=47% WR, 2×loss=31.6%, 3+×loss=28.4%; 1×win=76.6%, 2×win=79.7%, 3+×win=87.8%
        const lfFirstOfDay = !_lfPriorQ.rows[0];
        let lfConsecLosses = 0, lfConsecWins = 0;
        for (const r of _lfPriorQ.rows) {
          if (r.resolution === 'STOP_HIT')   { if (lfConsecWins   === 0) lfConsecLosses++; else break; }
          else if (r.resolution === 'TARGET_HIT') { if (lfConsecLosses === 0) lfConsecWins++;  else break; }
          else break;
        }
        // Stacking count: same-direction setups fired today (ACTIVE or RESOLVED).
        // Verified 2026-07-05: 1-6 setups = 80-86% WR solid; 7+ = 62.4% WR -$15.7 EV (N=1922) suppress.
        const _lfSameDirCounts = Object.fromEntries(_lfSameDirCountQ.rows.map(r => [r.direction, parseInt(r.cnt)]));
        // NL30: rolling 30-day sum of daily ACD scores — conditions fade edge by market regime.
        // Verified 2026-07-05 (N=229-429 per bucket): MILD trend = SHORT fades penalized (-$17 to -$19 EV);
        // STRONG regime boosts both extremes; prior-day only (< today) to avoid lookahead.
        const _lfNl30 = _lfNl30Q.rows[0]?.nl30 ?? 0;
        const _lfNl30Bucket = _lfNl30 > 15 ? 'STRONG_BULL' : _lfNl30 >= 6 ? 'MILD_BULL' :
          _lfNl30 < -15 ? 'STRONG_BEAR' : _lfNl30 <= -6 ? 'MILD_BEAR' : 'NEUTRAL';
        // Momentum-against-fade: was PAUSED mid-build 2026-09-05 pending the loss-cluster
        // investigation the user redirected to (which produced the direction-loss-alternation
        // gate above, not this). RESUMED same day as SHADOW-ONLY observational logging, not a
        // sizeMultiplier factor -- see getMomentumAgainstFade()/getMomentumAgainstFadeCalib()/
        // tagMomentumAgainstFadeShadow() near the top of this file for the actual wiring (all 4
        // real insert sites, same tag-after-insert pattern as tagDirectionGateShadow). A live
        // sizeMultiplier penalty is a separate, not-yet-made decision (OPEN_DECISION
        // momentum_against_fade_sizemultiplier_wiring_pending) -- deliberately not added here.
        // VWAP at detection time — computed from today's RTH bars (ask_vol+bid_vol ≈ total volume).
        // Rolling σ of VWAP distances over last 20 sessions gives the dynamic threshold.
        // Verified 2026-07-06: far extended (>mean+σ) = 76.2% WR +$59.7 EV z=+2.95 N=600.
        const _lfVwapData = allRthBarsRow.rows.reduce((acc, b) => {
          const vol = (b.ask_vol || 0) + (b.bid_vol || 0);
          acc.pv += b.close * vol; acc.vol += vol; return acc;
        }, { pv: 0, vol: 0 });
        const _lfVwap = _lfVwapData.vol > 0 ? _lfVwapData.pv / _lfVwapData.vol : null;
        let _lfVwapMean = _cachedVwapSigmaPre?.mean ?? null;
        let _lfVwapStd  = _cachedVwapSigmaPre?.std  ?? null;
        if (_lfVwapMean == null && _lfVwapSigmaQ) {
          _lfVwapMean = _lfVwapSigmaQ.rows[0]?.mean_dist ?? null;
          _lfVwapStd  = _lfVwapSigmaQ.rows[0]?.std_dist  ?? null;
          if (_lfVwapMean != null) setCached(todayET, 'lfVwapSigma', { mean: _lfVwapMean, std: _lfVwapStd });
        }
        // Level recency: last test date per level base name (past 21 days).
        // Research 2026-07-05: 1-2d ago = 65.9% WR $22 EV, 21d+ fresh = 60.5% WR -$5 EV.
        const lfRecencyMap = Object.fromEntries(_lfRecencyQ.rows.map(r => [r.level_base, r.last_date]));

        // TURBULENT intraday range confirmation (turbConfirmed) / eliteZone / isWithIbDirection /
        // the ELITE ZONE T2-runner trade-brief feature all REMOVED 2026-09-20 (user-requested dead-
        // code sweep following the sizeMultiplier factor-hygiene census). eliteZone was defined as
        // `dtClass === 'TURBULENT' && isWithIbDirection(dir) && turbConfirmed` -- confirmed 0% true
        // across all 137 real fired trades with a sizing snapshot (dtClass is null 99.3% of the
        // time during RTH, a known, separately-tracked bug with no safe live fix -- see
        // dtclass_other_3_gates_untested). This entire chain (this query's _lfTurbRangeQ, the
        // _lfAvgFirst15Range/_lfFirst15Bars/_lfFirst15Range/turbConfirmed derivation, isWithIbDirection,
        // and the eliteZone-gated T2 target/targetLabel clause/eliteNote text/sizeFactorsAtDetection
        // field/trade-brief field) had no consumer left once the eliteZone sizeMultiplier bump was
        // deleted earlier the same day -- confirmed via full-body grep before removing, not just a
        // read-through. Removing _lfTurbRangeQ also drops one DB query per poll that was computing a
        // number nothing downstream used anymore.
        // OR Expansion Bias: no A Up/A Down breach yet = untouched liquidity reinforces fade.
        // BALANCE: 78.88% WR N=161 (+5.77pp lift, z=2.03). TURBULENT: 96.15% WR N=26 (+20.97pp, z=2.77).
        // aUpFired/aDownFired are written to DB progressively each poll — real-time, not lookahead.
        const _lfOrExpanded = aUpFired || aDownFired;
  
        // Regime Persistence: prior 2 days same day_type = 3-day streak. Only meaningful on TURBULENT.
        // TURBULENT × streak: 84.08% WR N=157 (+8.89pp, z=3.45). BALANCE: flat (+0.20pp, skip).
        // NL30 nuance: streak negative in NEUTRAL (-3.13pp) — skip when NL30 is ranging.
        const _lfRegimePersistQ = dtClass === 'TURBULENT' && _lfNl30Bucket !== 'NEUTRAL'
          ? await query(`
              SELECT COUNT(*) AS streak_days
              FROM (SELECT day_type FROM acd_daily_log WHERE trade_date < $1 ORDER BY trade_date DESC LIMIT 2) sub
              WHERE day_type = $2
            `, [todayET, dtClass]).catch(() => ({ rows: [{ streak_days: '0' }] }))
          : { rows: [{ streak_days: '0' }] };
        const _lfRegimePersist = parseInt(_lfRegimePersistQ.rows[0]?.streak_days ?? '0') >= 2;
  
        // Overnight gap: pre-9:30 range vs rolling 60-session p33.
        // Opus audit 2026-07-07: small gaps (< p33) = 60.8% WR, -$27 EV (N=332) — quiet consolidation kills fades.
        // Threshold is rolling p33 (no hardcoded number per CLAUDE.md hard rule).
        // TIMEZONE BUG FIXED 2026-09-07 (found via Gemini's smallGapDay reconstruction audit,
        // independently confirmed live: a real 09:30:00 bar returned hour=5 through this query's
        // old UTC-then-America/New_York double timezone cast). price_bars_primary.ts
        // already stores naive ET wall-clock digits (server/db.js's own documented finding) --
        // treating it as UTC first shifts it back 4-5 hours before converting again. Real RTH
        // bars were silently misclassified as pre-9:30 "overnight" bars, contaminating both the
        // today_on and prior_on ranges. Fixed to EXTRACT directly, matching every other correct
        // et_min computation in this file (e.g. the _lfVwapSigmaQ query above).
        const _lfOnGapQ = await query(`
          WITH today_on AS (
            SELECT MAX(high)::float - MIN(low)::float AS on_range
            FROM price_bars_primary
            WHERE symbol='NQ' AND ts::date=$1
              AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) < 570
          ),
          prior_on AS (
            SELECT MAX(high) - MIN(low) AS on_range
            FROM price_bars_primary
            WHERE symbol='NQ'
              AND ts::date IN (
                SELECT DISTINCT ts::date FROM price_bars_primary
                WHERE symbol='NQ' AND ts::date < $1
                ORDER BY ts::date DESC LIMIT 60
              )
              AND (EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts)) < 570
            GROUP BY ts::date
          )
          SELECT
            (SELECT on_range FROM today_on) AS today_on_range,
            PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY on_range) AS p33_60d
          FROM prior_on
        `, [todayET]).catch(() => ({ rows: [{}] }));
        const _lfTodayOnRange = _lfOnGapQ.rows[0]?.today_on_range ?? null;
        const _lfOnRangeP33   = _lfOnGapQ.rows[0]?.p33_60d ?? null;
        const _lfSmallGap = _lfTodayOnRange != null && _lfOnRangeP33 != null && _lfTodayOnRange < _lfOnRangeP33;
  
        // Session delta: cumulative (ask_vol - bid_vol) from RTH open to now.
        // Backtest 2026-07-08 (N=4,354 fades): neutral |Δ|<p25 = 57.9% WR -$3 EV; high |Δ|>p75 = 69.3% WR +$28 EV.
        // Against-flow is slightly better than with-flow overall (overextension reversal logic) — only magnitude matters.
        const _lfSessionDelta = allRthBarsRow.rows.reduce((sum, b) => sum + ((b.ask_vol || 0) - (b.bid_vol || 0)), 0);
        const _lfAbsDelta = Math.abs(_lfSessionDelta);
        const _cachedDeltaPerc = getCached(todayET, 'lfDeltaPerc');
        let _lfDeltaP25 = _cachedDeltaPerc?.p25 ?? null;
        let _lfDeltaP75 = _cachedDeltaPerc?.p75 ?? null;
        if (_lfDeltaP25 == null) {
          // FIXED 2026-08-31 (OPEN_DECISION lf_session_delta_partial_vs_fullday_percentile_mismatch,
          // user-confirmed): this used to be a flat FULL-DAY sum percentile (one number per day,
          // GROUP BY ts::date, no time cutoff), compared live against _lfSessionDelta -- a
          // PARTIAL-day running sum as of fire time. Re-read the original 2026-07-08 validating
          // backtest (scripts/archive/backtest_session_delta.mjs) to resolve which convention it
          // actually used: it computed cumulative delta from 9:30 up through EACH HISTORICAL
          // SETUP'S OWN fire time, then took percentiles across all of those -- i.e. a percentile
          // of PARTIAL-day cumulative delta sampled at whatever time each trade happened to fire,
          // never a full-day total. The live code's threshold was a different, unvalidated
          // simplification, not what was actually proven (this is why _lfDeltaHigh fired on only
          // 1/704 real trades and _lfDeltaNeutral fired on 609/704 -- a full-day bar is much
          // harder to clear early in the session). Rebuilt below to sample the RUNNING cumulative
          // delta at every minute of every historical session (not just at setup-fire moments,
          // which aren't cheaply queryable here) and pool percentiles across all of those
          // (day, minute) readings -- the same underlying statistic (partial-day cumulative delta
          // at an arbitrary point in the session), just a denser, unbiased sample of it.
          // TIMEZONE BUG FIXED 2026-09-07 (same root cause as _lfOnGapQ above, found via
          // Gemini's deltaNeutral/deltaHigh reconstruction audit): this query's own 2026-08-31
          // rewrite carried over the same UTC-then-America/New_York double timezone cast on
          // price_bars_primary.ts, which already stores naive ET digits directly -- shifting
          // every et_min back 4-5 hours. The BETWEEN 570 AND 959 RTH filter below was silently
          // excluding real RTH bars and admitting wrong ones, corrupting the p25/p75 percentile
          // population that deltaNeutral/deltaHigh are thresholded against. Fixed to EXTRACT
          // directly, matching every other correct et_min computation in this file.
          const _lfDeltaPercQ = await query(`
            WITH minute_deltas AS (
              SELECT ts::date AS bar_date,
                (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS et_min,
                COALESCE(ask_volume,0) - COALESCE(bid_volume,0) AS bar_delta
              FROM price_bars_primary
              WHERE symbol='NQ'
                AND ts::date IN (
                  SELECT DISTINCT ts::date FROM price_bars_primary
                  WHERE symbol='NQ' AND ts::date < $1
                  ORDER BY ts::date DESC LIMIT 60
                )
                AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
            ), running AS (
              SELECT bar_date, et_min,
                SUM(bar_delta) OVER (PARTITION BY bar_date ORDER BY et_min) AS cum_delta
              FROM minute_deltas
            )
            SELECT
              PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ABS(cum_delta)) AS p25,
              PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ABS(cum_delta)) AS p75
            FROM running
          `, [todayET]).catch(() => ({ rows: [{}] }));
          _lfDeltaP25 = _lfDeltaPercQ.rows[0]?.p25 ?? null;
          _lfDeltaP75 = _lfDeltaPercQ.rows[0]?.p75 ?? null;
          if (_lfDeltaP25 != null) setCached(todayET, 'lfDeltaPerc', { p25: _lfDeltaP25, p75: _lfDeltaP75 });
        }
        const _lfDeltaNeutral = _lfDeltaP25 != null && _lfAbsDelta < _lfDeltaP25;
        const _lfDeltaHigh    = _lfDeltaP75 != null && _lfAbsDelta > _lfDeltaP75;
  
        // entryPressureShortCalib REMOVED 2026-09-20 -- see the sizeMultiplier closeout comment
        // at this factor's old sizing-usage site (~line 7420) for the full account; it read
        // performance_audit's ENTRY_PRESSURE_SHORT threshold weekly, solely to feed the now-
        // removed sizeMultiplier bump.

        // Pulse-score pre-computation (_pulseHighVol/_pulseDelta15/_pulseStruct/_pulseLowRots/
        // _pulseVolSigma, MC-calibrated 2026-07-08, including a real per-poll DB query for the
        // volatility baseline) REMOVED 2026-09-20 -- its only consumer, the pulseScore/
        // pulseVolSigma trade-brief fields, was itself confirmed dead (zero frontend readers
        // since the 2026-07-13 ACDView.jsx purge) and removed the same pass. See
        // docs/TRADEBRIEF_DEAD_FIELDS_CLEANUP_SPEC.md. Not to be confused with the separate,
        // real, already-shipped server/services/pulseReading.js / GET /api/pulse/reading live
        // feature -- confirmed independent (no shared import), untouched by this removal.

  return {
    priorDayProfile,
    isOvernightAligned, isOvernightCounter, isS2DoubleCounter,
    lfFirstOfDay, lfConsecLosses, lfConsecWins,
    _lfSameDirCounts, _lfNl30Bucket,
    _lfVwap, _lfVwapMean, _lfVwapStd, lfRecencyMap,
    _lfOrExpanded, _lfRegimePersist, _lfSmallGap, _lfOvOpen,
    _lfDeltaNeutral, _lfDeltaHigh,
  };
}
