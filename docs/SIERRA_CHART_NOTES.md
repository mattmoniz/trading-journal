# Sierra Chart notes

General-purpose notebook for anything about THIS SPECIFIC Sierra Chart setup that isn't
obvious from the code alone — DTC protocol behavior, data export quirks, account/instance
configuration, UI-triggered side effects, anything learned the hard way and confirmed
against real traffic/behavior, never guessed. Check this before touching
`server/services/sierraChart/`, price-bar ingestion (`sierraWatcher.js`,
`SIERRA_DATA_PATH`), or any Sierra-Chart-adjacent question. Per CLAUDE.md's standing rule,
**do not guess at Sierra Chart behavior** — if a question isn't answered here, fetch
Sierra's own docs (`reference_sierra_chart_docs.md` memory has known URLs) or test it
directly before asserting an answer.

Each entry is a short fact + where the full incident narrative lives (a CLAUDE.md hard
rule or a `docs/OPEN_THREADS.md` entry) if you need the complete story. Add a new entry
here the same session you discover a new quirk — don't let it live only in a CLAUDE.md
paragraph or an OPEN_THREADS entry that a future Sierra-Chart-specific session won't think
to search for.

## Connection / networking

- **Connect via the WSL2 NAT gateway IP, never the Windows host's real LAN IP.** A
  connection to the real LAN IP completes the TCP handshake cleanly but resets
  (`ECONNRESET`) the instant real protocol bytes are written — a hairpin-NAT signature.
  Get the right IP via `ip route show | grep default` (was `172.27.192.1` as of
  2026-09-28, can change). CLAUDE.md hard rule, "A WSL2→Windows-host TCP connection...".

## Data export / price-bar ingestion

- **Which Sierra Chart instance is "live" depends entirely on which one currently has an
  actively-driven/open chart** — the other instance's bar export (`*-BarData.txt`) just
  stops, silently, with zero error. Confirmed in both directions over 5 months. Don't
  assume `SIERRA_DATA_PATH` is wrong without asking which instance is being charted
  through right now. CLAUDE.md hard rule, "Which Sierra Chart instance is 'live'...".
- **The ingestion pipeline (`sierraWatcher.js`, 5s poll + 2s stability debounce by
  default) has real lag writing each bar into `price_bars_primary` after its minute
  closes** — a query reading "the most recently closed 1-min bar" can read one minute too
  old if it runs within the first several seconds of a new minute. ~1/3 of real RTH fires
  land in that window. CLAUDE.md hard rule, "A live/shadow query reading 'the most
  recently closed 1-min bar'...".

## Message types seen on this connection

- **Type 301 = `ORDER_UPDATE`.** The live, pushed order-status message. This app's
  `handleOrderUpdate()` is the only consumer that records `broker_pnl`/clears
  `position_open` — see "What does and doesn't generate a live push" below for the real
  gap this creates.
- **Type 306 = position snapshot entries** (seen inside a `REQUEST_CURRENT_POSITIONS`-style
  response, `brokerPositions` in a reconciliation report).
- **Type 600 = `ACCOUNT_BALANCE_UPDATE`.** Routine, high-frequency (every 1-2s during
  active trading), and this app has no handler for it — logs as
  `[sierraChart.connectionManager] DTC error: DtcClient: unhandled message Type=600`
  constantly. **Benign noise, not a connection problem** — confirmed 2026-10-13 while
  investigating an unrelated incident; don't chase this as a symptom of anything. Worth a
  no-op handler someday to stop the error-level log spam, not yet done.

## Order submission

- **`Symbol`/`Exchange` must be two genuinely separate wire fields, never one combined
  `"SYMBOL.EXCHANGE"` string with `Exchange` left empty.** Fails two DIFFERENT ways on two
  different servers: silently fills AT MARKET regardless of the real limit/stop on
  Sim1/Rithmic, rejected outright on the Trading Evaluator. Fixed at the wire-serialization
  layer only (`dtcClient.js`'s `_splitSymbolForWire()`) — every other layer
  (`order_placements.symbol`, position/fill matching, logging) keeps using the combined
  form as the app's identity key. CLAUDE.md hard rule, "DTC order SUBMISSION needs
  Symbol/Exchange...".
- **Contract year-code digit count differs by account/venue.** Rithmic/Sim1 wants 1 digit
  (`"MNQZ6"`), the Trading Evaluator wants 2 (`"MNQZ26"`) and rejects the 1-digit form
  outright. `resolveMnqFrontMonthSymbolFromEnv()` reads `DTC_SYMBOL_YEAR_DIGITS` from the
  active `config/dtc-accounts/*.env` profile — always use that wrapper, not the raw
  `resolveMnqFrontMonthSymbol()`. CLAUDE.md hard rule, "The Trading Evaluator...wants a
  2-digit contract year code...".
- **`IsAutomatedOrder`/`IsParentOrder` are `uint8_t` (0/1) in the real `DTCProtocol.h`
  struct, not booleans.** Sending a JSON `true`/`false` silently failed to register a
  parent order — the Trading Evaluator accepted the order fine either way but then
  rejected every child OCO submission referencing it ("There is no parent order for child
  OCO order"), since the server never actually saw `IsParentOrder` as set. Always send `1`
  or `0` explicitly. Found 2026-10-07, same OCO build.
- **`FreeFormText` is a real, submittable field on `s_SubmitNewSingleOrder` itself** (not
  just response/update structs) — confirmed directly against
  `/mnt/c/SierraChart/DTC/DTCProtocol.h` before using it, not assumed from having seen it
  on a received `ORDER_UPDATE`. `ORDER_FREE_FORM_TEXT_LENGTH = 48` (a `char[48]` on the
  C++ side) — truncate to 47 chars before sending to leave room for the null terminator.
  Added 2026-10-13, `dtcClient.js`'s `submitOrder()`.
- **This app always submits LIMIT, never MARKET, for a fresh entry — with one narrow,
  deliberate exception** (2026-10-13, user decision overriding a narrower DeepSeek-recommended
  fix): setup_types whose entry is a snapshot of a continuously-moving reference (running
  VWAP, session median) fire MARKET instead, since a frozen LIMIT on a moving reference goes
  stale if unfilled. See `orderSweep.js`'s `MARKET_ENTRY_SETUP_TYPES`/`wantsMarketEntry()` for
  the exact scope and why each excluded type was excluded. A stuck LIMIT entry that times out
  (90s) and hasn't moved too far (8pt) escalates to MARKET via a SEPARATE, narrower mechanism
  (`escalateUnfilledEntriesToMarket()`/`placeMarketEscalationEntryOrder()`) — this reuses the
  SAME row (UPDATE, not a second INSERT), since the one-entry-per-setup_id unique index has no
  status filter.

## Manual actions taken directly in Sierra Chart's own UI

- **Sierra Chart's "Reverse" command (Trade Window, "Reverse and Cancel") submits a MARKET
  order to flatten the existing position and cancels working orders for that symbol/account
  (except market orders).** When attached orders are involved (this app always attaches a
  stop), it's TWO separate market orders: one to flatten, one to establish the new position.
  Source: Sierra's own Trade Window documentation (fetched 2026-10-13), not inferred.
- **Orders Reverse creates carry an EMPTY `ClientOrderID` (`""`)** — confirmed directly
  against raw `order_placements_updates`/reconciliation logs, 2026-10-13. This matters a
  lot: this app's live push-event handler (`handleOrderUpdate()`, `applyOrderUpdate()`)
  only processes updates for a `ClientOrderID` it recognizes (and would even catch a
  genuinely-empty one via its `if (!clientOrderId)` "not one of ours" branch, logging it
  `UNOWNED:...`) — but these 3 Reverse-generated orders never arrived as a LIVE push at
  all. They only ever showed up later, via the periodic broker-position/open-orders
  RECONCILIATION SNAPSHOT poll (`checkPositionInvariant()`), a structurally different code
  path that does NOT call `recordBrokerPnlForSetup()`. **Net effect: a manual Reverse can
  close a real position with this app having zero live-event visibility into the fill
  price or P&L, even though it detects the MISMATCH quickly (see below).**
- **Detection of this kind of mismatch IS fast — the kill switch halts within seconds, not
  hours.** Confirmed 2026-10-13: Reverse fired at 12:54:42 ET, `checkPositionInvariant()`
  logged `UNKNOWN-TO-APP MISMATCH (TERMINAL_TRANSITION)` and halted the kill switch at
  12:54:46 — 4 seconds later. `quick-check.html`'s `checkFlagsBanner()` (30s poll, plus a
  `visibilitychange` force-refresh) surfaces "SIERRA CHART DISARMED" visibly and promptly
  too. **What's NOT automatic: recovery.** The reconciliation check's own log already
  contains the broker's real average fill price for the reversed position, but nothing
  turns that into an automatic `broker_pnl`/`active_setups.status` fix — it sits halted
  until a human manually reads the log and hand-writes the correction. This left
  `evaluateDailyLossLimit()` fail-closed-blocking all new real entries for hours on
  2026-10-13 (a trade with no `broker_pnl` is treated as "can't confirm within limit" —
  see `dllGate.js`'s own header, this is deliberate fail-closed design, not a gate bug).
  Full incident: `docs/OPEN_THREADS.md`'s 2026-10-13 entries. `OPEN_DECISION
  manual_sierra_action_no_broker_pnl_visibility_20261013` tracks whether to build automatic
  reconciliation for this exact shape (an unknown-to-app fill confidently attributable to
  the one open position).
- **Do not assume every manual Sierra Chart UI action behaves the same way as Reverse.**
  This entry is specifically about the Reverse-and-Cancel command; a different manual
  action (a plain manual flatten, modifying an order's price by hand, etc.) has not been
  observed and may propagate differently. Test or ask before assuming.

## Order lifecycle quirks

- **A real resting LIMIT entry can get CANCELED by something outside this app, fast —
  sometimes under 2 minutes after submission — with no explanation beyond "Simulated order
  canceled" in the raw message, and no app-side trigger at all.** Confirmed live
  2026-10-13: setup 134741's entry was submitted 19:05:57, canceled 19:07:30 (~93s later) —
  `journalctl` showed zero app-side activity (no escalation attempt, no restart) at that
  moment. This matters structurally, not just as a curiosity: a cancel this fast can fall
  through every resolution mechanism this app has — `resolveSetups.js`'s own chase-abandon
  only fires for an order still `status='OPEN'` after 15 minutes, which a 93-second cancel
  never satisfies (it's already `CANCELED`, not `OPEN`, by then). See `docs/OPEN_THREADS.md`'s
  2026-10-13/14 entry for the fix (`autoResolveDeadCanceledEntries()`,
  `missingOrderAutoResolve.js`) — a safety net for the symptom, not a fix for the unknown
  root cause. **Root cause not established** — don't assert a mechanism without checking
  further if this recurs.

## Account specifics

- **A prop-firm evaluation account ("Trading Evaluator" / "Simulated Futures Trading
  Service") does NOT use real retail CME margin** — a reported margin figure for this
  account type should never be checked against generic retail/SPAN reference numbers.
  CLAUDE.md hard rule, "A prop-firm evaluation account...".

## Working in this sandbox

- **The Claude Code sandbox's auto-mode classifier blocks BOTH arming and disarming a live
  order-placement kill switch**, and separately blocks direct DB writes that touch
  real-order-adjacent tables it reads as "modify shared resources" (confirmed 2026-10-13 on
  a one-row `position_open` flag correction). Don't retry via another tool/encoding when
  denied — hand the exact command to the user. CLAUDE.md hard rule, "The Claude Code
  sandbox's auto-mode classifier blocks arming/enabling...".
