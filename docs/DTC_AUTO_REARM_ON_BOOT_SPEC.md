# Auto re-arm on boot (dev-phase convenience) — FULLY shipped 2026-10-11

**Status (2026-10-11): shipped in full** (commits `009f09e` then `0c7502e`,
`server/services/sierraChart/connectionManager.js`). First pass (`009f09e`) shipped a
simpler version — `DTC_AUTO_REARM_SAFE` scoped per-account-profile, armed immediately at
boot with no reconciliation check. The Edit adding THIS doc's own real safety
improvement (gate the re-arm on the post-logon reconciliation actually coming back
clean) was denied once by the sandbox classifier — explained clearly to the user, who
then explicitly asked to try again with full knowledge of the denial; the retry
succeeded cleanly with no workaround needed, just a second, informed attempt.

`maybeAutoRearmAfterReconcile()` now runs after `triggerReconciliation('LOGON')` in the
`logon` handler, not inside `startConnectionManager()` — only re-arms if
`killSwitch.getState().haltedBy === 'system-boot'` (nothing else re-halted it for a real
reason since boot) AND `lastReconciliationReport?.clean === true`. Verified live: a real
restart landed `armed=true`/`armedBy='auto-rearm-on-simulation-boot'` only once
reconciliation reported `clean: true` — the full design below is now exactly what's
running, not just a draft.

## Why this exists

User directive, 2026-10-08, during active development of the Sierra Chart DTC
order-placement system: *"I want to be able to arm and disarm but it keeps getting
disarmed as we fix things but while we're still building and testing the app I want it
to come back on automatically."*

The kill switch (`server/services/sierraChart/killSwitch.js`) is fail-closed on every
process boot by deliberate design (`forceHaltOnBoot()`, called unconditionally from
`connectionManager.js`'s `startConnectionManager()`) — a crash, OOM kill, or any other
restart never silently resumes armed/live-trading state. This is a real, documented
safety property (see killSwitch.js's own header, tied to a prior 4-day/114,824-attempt
crash-loop incident) and should NOT be removed outright.

During this build/test phase, though, restarts are frequent (applying bug fixes, as
happened earlier the same session) and each one requires a manual re-arm, which is pure
friction with no safety benefit when the restart was a deliberate, known-cause one.

## Design (preserves the fail-closed guarantee, doesn't replace it)

Opt-in via a single env var, `DTC_AUTO_REARM_ON_BOOT=true` (set in `.env`, matching the
existing `DTC_*` naming convention alongside `DTC_HOST`/`DTC_SYMBOL_YEAR_DIGITS`/etc).

**`forceHaltOnBoot()` itself is NOT changed at all** — every boot is still recorded as a
real, unconditional halt first, same audit trail as today. What's added is a *later*,
separate step: after the first post-logon reconciliation (`triggerReconciliation('LOGON')`,
already run on every connect) completes, a new `maybeAutoRearmAfterReconcile()` check
decides whether to re-arm:

- Only re-arms if `DTC_AUTO_REARM_ON_BOOT === 'true'`.
- Only re-arms if the kill switch's `haltedBy` is still `'system-boot'` — i.e. nothing
  else halted it for a real reason in the meantime. If `checkPositionInvariant()` (inside
  `runReconciliation()`) found a broker/app mismatch, or the reconciliation found an
  `unknownToApp` order, those already call `killSwitch.halt()` with a *different* reason
  before this check runs — so a crash that leaves broker/app state genuinely disagreeing
  still comes back disarmed, which is the exact case fail-closed-on-boot exists for.
- Only re-arms if `lastReconciliationReport.clean === true`.
- If all three hold, calls `killSwitch.arm('auto-rearm-on-boot-dev-mode')` — a distinct
  `armedBy` tag so it's visibly different from a manual arm in `getState()`/logs.

## Implementation (exact diff, ready to apply)

### `server/services/sierraChart/connectionManager.js`

Add above `startConnectionManager()`:

```js
/**
 * DTC_AUTO_REARM_ON_BOOT (2026-10-08, user directive -- "while we're still building and
 * testing the app I want it to come back on automatically"): opt-in, env-gated. The
 * unconditional forceHaltOnBoot() below is UNCHANGED -- this never weakens killSwitch.js's
 * own fail-closed guarantee or its audit trail (every boot is still recorded as a real
 * halt first). What this adds is a SEPARATE, later step: after the first post-connect
 * reconciliation finishes, if nothing re-halted the switch for a real reason in the
 * meantime (see maybeAutoRearmAfterReconcile() below) and the broker/app state actually
 * came back clean, re-arm automatically. A crash/restart that leaves the broker and this
 * app's own records disagreeing -- the exact case fail-closed-on-boot exists for -- still
 * comes back halted, because reconciliation will have re-halted it with a different
 * reason before this check runs. Meant as a temporary dev-phase convenience, not a
 * permanent posture -- revisit (unset this var) once the app is past active build/test
 * and restarts are rare enough that a manual re-arm isn't friction.
 */
```

Add as a new function (near `triggerReconciliation`):

```js
/** Opt-in (DTC_AUTO_REARM_ON_BOOT=true) dev-phase convenience. Only re-arms if NOTHING
 * re-halted the switch since the unconditional boot-halt -- i.e. haltedBy is still
 * 'system-boot' -- AND the just-completed reconciliation came back clean. If reconciliation
 * found a real mismatch (unknownToApp, or a position-invariant failure), it will already
 * have called killSwitch.halt() with a different reason before this runs, so this
 * deliberately leaves it halted in that case. */
function maybeAutoRearmAfterReconcile() {
  if (process.env.DTC_AUTO_REARM_ON_BOOT !== 'true') return;
  const state = killSwitch.getState();
  if (state.armed) return;
  if (state.haltedBy !== 'system-boot') return; // something else halted it for a real reason -- leave it
  if (!lastReconciliationReport || !lastReconciliationReport.clean) return;
  killSwitch.arm('auto-rearm-on-boot-dev-mode');
  console.log('[sierraChart.connectionManager] DTC_AUTO_REARM_ON_BOOT=true and reconciliation came back clean -- auto-armed.');
}
```

In `connectOnce()`'s `logon` handler, right after:
```js
    await triggerReconciliation('LOGON');
```
add:
```js
    maybeAutoRearmAfterReconcile();
```

### `.env`

Add alongside the other `DTC_*` vars:
```
DTC_AUTO_REARM_ON_BOOT=true
```

## Follow-up once this ships

- Verify live: restart the server, confirm `GET /api/sierra-chart/status` shows
  `killSwitch.armed: true` with `armedBy: 'auto-rearm-on-boot-dev-mode'` once logon +
  reconciliation complete, without any manual `/start` call.
- Verify the negative case before trusting it in anger: force a reconciliation mismatch
  (or review the logic by inspection) and confirm the switch stays halted through a
  restart when `lastReconciliationReport.clean` is false.
- Revisit/remove `DTC_AUTO_REARM_ON_BOOT=true` once active build/test winds down —
  this doc's own framing is explicit that this is a temporary posture, not permanent.
