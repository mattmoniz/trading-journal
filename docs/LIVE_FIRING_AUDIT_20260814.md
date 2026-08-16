# Live-Firing Audit — why trades fire on "overall" but not "live" (response to Claude)

Requested by the user, 2026-08-14: *"my trading app is not firing all live trades. There may
be a blocker, because many trades are firing on overall and I believe some of them should be in
live firing. Audit the rules and code, find out why some trades haven't been firing in live,
and report a full summary plus any other bugs."*

This document is the audit report. It states what was tested, what was found, and the concrete
code to fix each bug. Nothing here edits app code — it is for your (Claude's) review before any
change is applied.

---

## TL;DR verdict

There are two layers to the answer.

1. **Mostly by design.** Only setup types rated `ACTIVE` by the `SETUP_STATUS` pipeline fire
   live (`origin_status='ACTIVE'`); everything else fires `SHADOW` (background-only) or is
   `BACKFILL`/`UNKNOWN`. Right now **19 of 214 types are ACTIVE**; **179 are THIN_N + 14
   SUPPRESS + 2 DAY_TYPE_MANAGED**. So ~93–97% of everything that fires is, by rule, not live.

2. **But there are real bugs** that make the live roster *smaller and less trustworthy than it
   should be*:
   - **F1 (CRITICAL):** the cascade-breaker "audit" inserts full, resolving SHADOW trades
     (~1,042 rows, ~74–149/day) that contaminate `SETUP_STATUS` `real_n`/`real_ev`.
   - **F2 (CRITICAL):** that same audit can hijack a live fire into a SHADOW row on cascade days.
   - **F3 (HIGH):** the `shadowCandidates` array hardcodes ~20 event setups (incl.
     `STOP_SWEEP_LONG`, which is **rated ACTIVE**) to SHADOW-only with **no promotion path**
     despite a comment claiming one exists.
   - **F4 (MED):** `VALUE_FADE` bet-class override suppresses types whose own real EV is only
     mildly negative; `FAILED_AUCTION_LONG` (blended +$7.50) needs a specific look.
   - **F5 (LOW):** a stale comment now states the opposite of the truth.

---

## What I tested

Read-only. Direct DB queries against `trading_journal` (Postgres) + full reads of
`server/routes/acd.js`, `server/config/setupTypes.js`, `scripts/backtest_setup_status.mjs`,
`server/services/minuteBarSignalDetector.js`, `server/schema.sql`, `quick-check.html`, and the
relevant `docs/OPEN_THREADS.md` / `docs/DASHBOARD_AUDIT_20260813.md` entries.

Key numbers pulled from the live DB:

| origin_status | count |
|---|---|
| BACKFILL | 15,879 |
| SHADOW | 1,947 |
| UNKNOWN | 1,497 |
| ACTIVE | 362 |

| SETUP_STATUS recommendation | # types |
|---|---|
| THIN_N (shadow-only) | 179 |
| ACTIVE (live) | 19 |
| SUPPRESS (shadow-only) | 14 |
| DAY_TYPE_MANAGED | 2 |

Daily fires since 2026-08-04: **4–15 ACTIVE** vs **43–184 SHADOW** per day.

---

## Findings table

| # | location | what's wrong | severity |
|---|---|---|---|
| F1 | `server/routes/acd.js:6600-6639` | Cascade-breaker "audit" computes full entry/stop/target/expiry and inserts an open SHADOW row per near level. 972 of 1,042 rows resolve `PRICE_CLEAN` (TARGET_HIT/STOP_HIT/TIME_EXPIRED) with real P&L and count toward `SETUP_STATUS` `real_n`/`real_ev`. | **CRITICAL (data integrity)** |
| F2 | `server/routes/acd.js:8393-8428` | `existingSetup` reuse query matches `status IN ('ACTIVE','SHADOW')` with no audit exclusion — a freshly-inserted cascade SHADOW row for the winner's type is reused instead of firing a new ACTIVE row. | **CRITICAL (lost live fires)** |
| F3 | `server/routes/acd.js:7685-7723` + `8613-8645` | `candidates` (can fire ACTIVE) has only 2 entries; ~20 event setups live in `shadowCandidates` which is hardcoded `'SHADOW','SHADOW'` with no promotion code. `STOP_SWEEP_LONG` is rated ACTIVE yet has **0** ACTIVE rows ever. | **HIGH (structural)** |
| F4 | `scripts/backtest_setup_status.mjs:406-422` | `VALUE_FADE` bet-class override suppresses individually-mild types (`VWAP_MAGNET_*`, `RTH_VWAP_FADE_SHORT`, `IB_MID_SCALP_FADE_LONG` at real EV −$0.79…−$2.81); `FAILED_AUCTION_LONG` (blended +$7.50) doesn't obviously fit. | **MED (review)** |
| F5 | `server/routes/acd.js:1389-1392` | Stale comment claims cascade/suppressed-audit rows have "no entry/stop/target to resolve against" — false since commit `6f82d3c`. | **LOW (docs)** |

---

## F1 — Cascade-breaker audit fires full resolving trades (CRITICAL)

**Evidence:** `SELECT resolution, count(*), round(avg(actual_pnl),2) FROM active_setups WHERE
suppression_reason='CASCADE_BREAKER' GROUP BY resolution` → TARGET_HIT 527 (+$43,044),
STOP_HIT 445 (−$42,737), TIME_EXPIRED 60 (−$682); 972 rows `resolution_method='PRICE_CLEAN'`.
`backtest_setup_status.mjs:163` counts `origin_status IN ('ACTIVE','SHADOW')` with
`resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')` as `real_n` — so these phantom trades
are in the SUPPRESS/THIN_N/ACTIVE decision. Per-type share: RTH_VWAP_FADE_SHORT 38/40,
RTH_VWAP_FADE_LONG 53/62, CAM_S1_FADE_LONG 33/34 of "real" resolved trades are cascade audit.

**Fix** — make it a terminal, level-less audit marker (schema allows nulls for every column
omitted: `entry_zone_low/stop_level/t1_level/expires_at/resolution/resolved_at` are all
nullable in `server/schema.sql:304-316`). Replace the block at `acd.js:6600-6639`:

```js
          // downstream gating (the `!cascadeBreaker.active` check further below) was removed.
          // FIXED 2026-08-14 (live-firing audit): the old audit block computed full
          // entry/stop/target/expiry and inserted an OPEN SHADOW row per near level
          // (commit 6f82d3c), which (1) resolved with real P&L and counted toward
          // SETUP_STATUS real_n/real_ev — contaminating SUPPRESS/THIN_N/ACTIVE with ~1,000
          // phantom trades — and (2) was eligible to be reused by the existingSetup check
          // below, hijacking the winner's live ACTIVE fire. Now a terminal, level-less audit
          // marker: never resolves, never counts toward real_n (real_n requires resolution IN
          // TARGET_HIT/STOP_HIT/TIME_EXPIRED), and status='EXPIRED' is not IN ('ACTIVE','SHADOW')
          // so the reuse query can't match it. Deduped per (trade_date, setup_type) so a
          // cascade window logs each level once, not once per 15s poll.
          if (cascadeBreaker.active && nearLevels.length > 0) {
            const cbIsLong = approachDir === 'FROM_ABOVE';
            const cbDir = cbIsLong ? 'LONG' : 'SHORT';
            for (const lv of nearLevels) {
              const cbType = resolveSetupType(`${lv.name}_${cbDir}`, lv);
              await query(`
                INSERT INTO active_setups (
                  trade_date, setup_type, fired_at, price_at_detection,
                  status, origin_status, suppression_reason, resolution, resolved_at
                )
                SELECT $1, $2, NOW(), $3, 'EXPIRED', 'SHADOW', 'CASCADE_BREAKER', 'NO_EXPIRY_SET', NOW()
                WHERE NOT EXISTS (
                  SELECT 1 FROM active_setups
                  WHERE trade_date = $1 AND setup_type = $2 AND suppression_reason = 'CASCADE_BREAKER'
                )
              `, [todayET, cbType, currentPrice]).catch(() => {});
            }
          }
```

After applying: **re-baseline `SETUP_STATUS`** (run `scripts/backtest_setup_status.mjs` once)
because ~972 phantom trades are currently baked into the live decisions.

---

## F2 — Cascade audit hijacks the live fire (CRITICAL)

**Evidence:** in the same request, F1's audit inserts an open SHADOW row for *every* near level
— including the level that is about to win — *before* the main insert runs. The main insert then
reuses it:

```js
// acd.js:8393-8397
SELECT ... FROM active_setups
WHERE trade_date=$1 AND setup_type=$2 AND status IN ('ACTIVE','SHADOW')
ORDER BY fired_at DESC LIMIT 1

// acd.js:8418 — reuse instead of inserting fresh ACTIVE
if (existingSetup.rows.length) { /* serve the SHADOW row */ }
else { /* insert fresh ACTIVE/SHADOW */ }
```

Corroborated in the DB: on 2026-08-14 (cascade-heavy), live-rated types fired **0 ACTIVE** and
only cascade SHADOW rows — `RTH_VWAP_FADE_LONG` 0/6, `OR5_LOW_FADE_LONG` 0/4, `IB_LOW_FADE_LONG`
0/2 — while `PD_VAH_FADE_SHORT` (which fired before the cascade window) got 1 ACTIVE + 4 audit.

**Fix (defense-in-depth on top of F1; F1 alone removes the cascade rows from the
`status IN ('ACTIVE','SHADOW')` match set, this also guards the suppressed-near-level audit
rows at `acd.js:7171`):**

```js
      const existingSetup = await query(`
        SELECT id, fired_at::text as fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label
        FROM active_setups WHERE trade_date=$1 AND setup_type=$2 AND status IN ('ACTIVE','SHADOW')
          AND (suppression_reason IS NULL OR suppression_reason = 'PERFORMANCE_BELOW_THRESHOLD'
               OR suppression_reason IN ('REFIRE_COOLDOWN','POST_RTH_DEAD_ZONE'))
        ORDER BY fired_at DESC LIMIT 1
      `, [todayET, active.type]);
```

Rationale: a "real" fire has `suppression_reason` NULL (normal ACTIVE) or one of the
`forceShadow` reasons (`PERFORMANCE_BELOW_THRESHOLD`/`REFIRE_COOLDOWN`/`POST_RTH_DEAD_ZONE`,
set at `acd.js:8493-8496`). Every audit-only reason (`CASCADE_BREAKER`, `SUPPRESSED_FADE`,
`CLUSTER_ALREADY_FIRED`, `SAME_TYPE_REFIRE_COOLDOWN`, `DOW_SUPPRESSED`, `S2_DOUBLE_COUNTER`,
`TREND_COUNTER_FADE`, `SUPPRESSED_OTHER`) is excluded from reuse.

---

## F3 — shadowCandidates hardcoded SHADOW-only, no promotion path (HIGH)

**Evidence:** the live-capable `candidates` array has exactly two entries
(`levelScalpSetup`, `ibSetup`):

```js
// acd.js:7685-7697
const candidates = [ levelScalpSetup, (ibSetup && !suppressed && !dowSuppressed) ? ibSetup : null ];
// acd.js:7701-7723 — everything else
const shadowCandidates = [ stopSweepSetup, failedSweepReversalSetup, vwapMagnetSetup, ... ];
```

The `shadowCandidates` comment says "Promoted to ACTIVE when positive EV over 30+ forward
trades" — **no such promotion code exists** (`grep promot` finds only the overnight/stackvol
gates and the `backtest_setup_status.mjs` recommendation flip, none of which touch this array).
The persist hardcodes `'SHADOW','SHADOW'` (`acd.js:8629-8632`).

DB proof that this is a real (not just theoretical) inconsistency:

| setup_type | SETUP_STATUS | ACTIVE rows (ever) | SHADOW rows |
|---|---|---|---|
| STOP_SWEEP_LONG | **ACTIVE** (N=39, EV=+$0.40) | **0** | 35 |
| VWAP_MAGNET_LONG | SUPPRESS | 0 | 84 |
| FAILED_AUCTION_LONG | SUPPRESS | 0 | 42 |
| C_PAIRED_SHORT | THIN_N | 0 | 23 |
| ZONE_EDGE_FADE | — | 0 | 18 |

This is the **same anti-pattern the codebase already fixed once** in `getShadowSetupTypes`
(`acd.js:9097-9104`: OPEN_DRIVE_SHORT / VALUE_AREA_RESPONSIVE_* were "hardcoded here as
permanently shadow while the live pipeline had already promoted all three to ACTIVE") — but the
*firing* list (`shadowCandidates`) was never migrated to read `SETUP_STATUS`.

**Fix** — apply the same one-definition-of-shadow rule at insert time (a type the pipeline has
promoted to ACTIVE and that isn't DOW-suppressed today fires live):

```js
      if (shadowCandidates.length > 0) {
        (async () => {
          const vaMap = await getValueAreaRegimeMap(todayET).catch(() => ({}));
          const shadowFireTags = await computeFireTags(todayET, 'RTH', etMin);
          for (const shadow of shadowCandidates) {
            if (!shadow || shadow.type === active?.type) continue;
            const isLongS = shadow.direction === 'LONG';
            const riskOk = shadow.stop == null || (isLongS ? shadow.stop < shadow.entry : shadow.stop > shadow.entry);
            if (!riskOk) {
              logGatedCandidate({ tradeDate: todayET, setupType: shadow.type, gateName: 'RISK_CHECK_SHADOW', gateReason: `non-positive risk: stop ${shadow.stop} vs entry ${shadow.entry} (${shadow.direction})`, entry: shadow.entry, stop: shadow.stop, target: shadow.target });
              continue;
            }
            let sT1 = shadow.target;
            if (sT1 != null && ((isLongS && sT1 <= shadow.entry) || (!isLongS && sT1 >= shadow.entry))) sT1 = null;
            // FIXED 2026-08-14: shadowCandidates were hardcoded 'SHADOW','SHADOW' with no
            // promotion path (the "promoted after 30+ forward trades" comment was never
            // implemented). A type the SETUP_STATUS pipeline has promoted to ACTIVE (not in
            // _suppressedSetups, not DOW-suppressed today) now fires live — the same
            // one-definition-of-shadow principle as getShadowSetupTypes (~acd.js:9097).
            const shadowIsLive = !liveStats._suppressedSetups?.has(shadow.type)
              && !liveStats._dowSuppressToday?.has(shadow.type);
            const st = shadowIsLive ? 'ACTIVE' : 'SHADOW';
            const regimeStamp = computeRegimeStamp(shadow.entry, vaMap);
            await query(`
              INSERT INTO active_setups (trade_date, setup_type, fired_at, expires_at,
                entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status, origin_status, ${REGIME_STAMP_COLS.join(', ')}, ${FIRE_TAG_COLS.join(', ')}, bet_class)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, ${REGIME_STAMP_COLS.map((_, i) => `$${11 + i}`).join(', ')},
                ${FIRE_TAG_COLS.map((_, i) => `$${11 + REGIME_STAMP_COLS.length + i}`).join(', ')},
                $${11 + REGIME_STAMP_COLS.length + FIRE_TAG_COLS.length})
              ON CONFLICT DO NOTHING
            `, [
              todayET, shadow.type, firedAtTs, computeExpiry(shadow.type),
              shadow.entry, shadow.entry, shadow.stop, sT1, shadow.targetLabel || null,
              st,
              ...regimeStampValues(regimeStamp),
              ...fireTagValues(shadowFireTags),
              getBetClass(shadow.type),
            ]).catch(() => {});
          }
        })();
      }
```

**Two caveats you must resolve before shipping F3:**
1. This is a *design decision* — it makes ~20 event setups eligible to fire live for the first
   time. It is exactly what the user is asking for, but blast radius is large; ship behind a
   flag or review the per-type list first.
2. `STOP_SWEEP_LONG/SHORT` are flagged **"PAUSED 2026-08-05"** pending a target-calibration fix
   (`OPEN_DECISION stop_sweep_long_calibrated_target_pause_or_keep`). If that pause still
   stands, either (a) exclude the STOP_SWEEP types explicitly from the live flip until
   un-paused, or (b) re-rate them (they shouldn't sit at `ACTIVE` while the detector is paused
   — that's the inconsistency this audit is flagging either way).

---

## F4 — VALUE_FADE bet-class override suppresses mildly-negative types (MED, review)

`backtest_setup_status.mjs:406-422` batch-suppresses any `VALUE_FADE` type whose pooled family
EV is negative at N≥200, unless the type's own real EV is ≥0. Result — these are SHADOW-only
despite individually-mild records:

| type | blended EV | real EV | real N |
|---|---|---|---|
| VWAP_MAGNET_LONG | −$1.26 | −$1.24 | 79 |
| VWAP_MAGNET_SHORT | +$0.30 | −$2.00 | 36 |
| RTH_VWAP_FADE_SHORT | +$1.72 | −$0.79 | 38 |
| IB_MID_SCALP_FADE_LONG | +$1.05 | −$2.81 | 39 |
| FAILED_AUCTION_LONG | +$7.50 | ? | 47 |

This is a documented, deliberate decision (roadmap Phase 8 I6), so it may be correct as-is —
but `FAILED_AUCTION_LONG` (blended +$7.50, N=47) deserves a specific look against the override's
own "own EV ≥ 0" escape hatch. **No code change proposed here** — a review/decision item, not a
bug fix. (Note: F1's re-baseline will change these real EVs, so do F4 *after* F1.)

---

## F5 — stale comment (LOW)

`acd.js:1389-1392` says the CASCADE_BREAKER / suppressed-near-level audit rows "log a
suppressed level touch as evidence with **no entry/stop/target to resolve against** — genuinely
un-scoreable." False since `6f82d3c` gave those rows full levels. Reword to match F1's fix
(terminal audit markers).

---

## Suggested order of work

1. **F1** (cascade audit → terminal) + **F5** (comment) — small, safe, removes the phantom-trade
   contamination.
2. **Re-baseline `SETUP_STATUS`** (`node scripts/backtest_setup_status.mjs`) so the roster
   reflects clean real_n/real_ev.
3. **F2** (existingSetup guard) — belt-and-suspenders for lost live fires.
4. **F3** (shadowCandidates promotion) — the user-facing "more trades should fire live" fix;
   resolve the STOP_SWEEP pause decision first.
5. **F4** — review `FAILED_AUCTION_LONG` after the re-baseline.

Open question for you: should `shadowCandidates` types graduate live automatically (F3) or stay
shadow-only and have their `SETUP_STATUS` ratings corrected so the "rated ACTIVE but never fires
live" inconsistency can't recur? The latter is the smaller change; the former is what the user's
report is really pointing at.