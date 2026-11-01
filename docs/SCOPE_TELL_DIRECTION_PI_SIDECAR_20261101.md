# Scope: tell direction follow-up, Raspberry Pi depth/monitor project, sidecar start fix (2026-11-01)

Nothing here places orders, arms the kill switch or opens the sealed hold-out. Each item lists what it needs from the user.

## A. Tell direction follow-up (research only)
Evidence so far (claims `amt_tell_direction_delta_flow_not_shown_20261101`, `amt_tell_first_break_side_above_control_20261101`): the tell does not point the wrong way on average (first break on its side 73.6 vs 60.6 percent for a moving-only control), the opposite side is not better, a causal delta read adds nothing; most of the first-break lift is geometry (the tell pointing at the NEARER range edge breaks that side 86 percent, at the FAR edge 29 percent, control 20).
Candidate next test (a lead from a post-hoc subgroup, so it needs its own prereg before any money number): take the tell only when it points at the nearer range edge (ties and the failed-break-back context handled by a frozen rule); outcome = the existing realistic-fill V1 trade; baselines = the tell without the filter and a near-edge-only moving control; explore only; one look at the sealed hold-out only with the user's go.
Needs from the user: the exact definition of "absorbed/defended areas" they want as a direction chooser (the repo's absorption marks are one candidate), and the DDY Delta Heatmap settings if a replica of the delta flip is wanted. Peak-and-fail with stuffed shorts waits on depth (see B).

## B. Raspberry Pi: depth archive and monitors (optional, no trading role)
Facts: Sierra writes `.depth` files on the Windows PC (about 1 GB per full day; ~100 NQ sessions from mid-June 2026, still recording), so the PC remains the recorder; if it sleeps nothing records (CLAUDE.md WSL2 sleep note).
What the Pi could do: (1) nightly copy and compress of new depth files to its own storage, plus a per-second summary (`scripts/depth_persec_20261021.mjs` already exists) so depth studies run on small files; (2) monitors that alert on feed staleness, a missing tick/depth file, sidecar down, reconciliation misfires; (3) later, a host for the sidecar if the PC is unreliable.
What it must not do: run the decision engine, hold broker credentials, or place orders.
Open questions for the user: which Pi (model, RAM), how much attached storage, whether it can reach the PC over the LAN (a share or rsync), and where alerts should go (the quick-check page, a push notification). Without these, step 1 is a design only.
Depth claims will rest on roughly 100 sessions at most, so the first deliverable is data safekeeping, not a test.

## C. Sidecar NO_TICK_FILE at the evening session start
Cause (verified in code and the alarm table, 2026-11-01): `bootstrap.primary_paths` accepts a tick file only if `_sniff_layout(path, trade_date)` finds records whose ET calendar date equals the session's trade date. A session for trade date D starts at 18:00 ET on D-1, so no such record exists until midnight; the sidecar raises NO_TICK_FILE every 10 minutes from 18:00 to midnight and starts only after midnight. The 10-30 session still finalised correctly (tail_backwards 0, baseline 20, RTH volume difference 0.00 percent against the database), so no tell data was lost: the tailer reads from D-1 on start.
Effect today: false alarms and a sidecar not running for the evening hours; Stage 1 reads RTH only, so no signal is missed. It becomes a real gap if the Globex arm is ever activated.
Proposed fix: sniff the layout on D-1 (or the first record of the file at or after D-1 18:00) when the session has not reached midnight; layout does not change inside one file. Then re-run `scripts/amt_tell_live/parity_day.py` and the recovery test, and restart the sidecar after market hours (a server restart disarms the Sierra switch; re-arm only on the user's go).
Needs the user's go for the restart.
