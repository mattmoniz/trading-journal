# CLAUDE.md archive: Dev workflow (verbatim, moved 2026-11-01)

Back to [CLAUDE.md](../../CLAUDE.md).

## Index
- [dw-001](#dw-001) Single-instance server takeover lives in ONE place: scripts/lib/server-lifecycle.sh

---

<a id="dw-001"></a>

- **Single-instance server takeover lives in ONE place: `scripts/lib/server-lifecycle.sh`** (`cleanup_ports`/`stop_systemd_server`/`handback_on_exit`/`start_health_monitor`), sourced by `start.sh`, `restart.sh`, `stop.sh`, and `scripts/dev-server-guard.sh` (what `npm run server` now actually runs). Found 2026-08-18: `restart.sh` had silently duplicated `start.sh`'s cleanup logic by hand and drifted out of sync (missing the systemd-stop-first step and the EXIT-trap handback), and bare `npm run server` had none of this at all — together these let 5 simultaneous `nodemon` supervisors pile up from separate sessions across one day, fighting over port 3002 and each other until `trading-journal-server.service` tripped its failure-burst limit and went permanently `failed` mid-RTH, with zero live setups firing `ACTIVE` all day as a result. **Never reimplement any piece of this by hand in a new entry point — source the shared lib.** `.claude/hooks/session-start.sh` also has a standing backstop that loudly flags >1 simultaneous `nodemon server/index.js` supervisor if something still bypasses all of the above.
