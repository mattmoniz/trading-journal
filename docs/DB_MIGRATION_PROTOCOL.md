# Database Migration Protocol

Standing checklist for any change to live schema/data — a new column, a backfill, a
repair script, a data reconstruction. Written 2026-07-17 after building
`active_setups.origin_status` (see `docs/OPEN_THREADS.md`'s 2026-07-17 entry for the
full worked example this protocol is extracted from) — every step below is something
that was actually done that session, not aspirational.

There is no tracked migration file system in this codebase (see CLAUDE.md's "DB schema
bootstrap" note) — every table beyond the original 5 was created ad hoc directly against
the live DB. This protocol is what replaces migration files: a repeatable discipline,
not a tool.

## Before writing anything

1. **Understand why the current schema is the way it is before changing it.** `git log
   --all -S"<column name>"` / `git blame` on the table's creation or the code that reads
   it. This is the same standing rule as code changes (`feedback_git_history_before_changes`
   memory) — a schema quirk that looks wrong might be a deliberate, differently-scoped
   design choice.
2. **Check actual current column types via `information_schema`, never assume from
   `server/schema.sql`.** The file drifts the moment anyone alters a table live without
   regenerating it — treat it as a snapshot, not a source of truth, until you've
   confirmed it matches.
   ```sql
   SELECT column_name, data_type, character_maximum_length
   FROM information_schema.columns WHERE table_name='<table>';
   ```
3. **Check for an existing column/table doing something similar first.** Adding a
   second, differently-named version of something that already exists elsewhere is
   exactly the single-source-of-truth violation this codebase has been burned by
   repeatedly (the $/pt constant, 4 separate occurrences).

## Timezone/type safety — check this explicitly, every time

This codebase has a documented history of naive-timestamp bugs (see CLAUDE.md's
"Never parse a naive (no-timezone) timestamp string..." hard rule — a real incident that
silently corrupted trade times for over a month before being caught).

1. For every column involved in a date/time comparison in your migration, check its
   real type: `DATE`, `TIMESTAMP WITHOUT TIME ZONE`, or `TIMESTAMPTZ`. Don't guess from
   the column name (`trade_date` vs `fired_at` look similar but are different types in
   this schema — `trade_date` is `DATE`, `fired_at` is naive `TIMESTAMP`).
2. **Pure `DATE`-to-`DATE` comparisons are safe** — no timezone conversion happens,
   Postgres compares them directly. Prefer these where the migration logic allows it
   (e.g. reconstructing `origin_status` only ever compared `trade_date` to `run_date`,
   both `DATE`, deliberately avoiding the naive-timestamp columns).
3. **Never parse a naive `TIMESTAMP` column with JS `new Date(str)`** without explicit
   ET anchoring (`Intl.DateTimeFormat`-based, see `sierraParser.js`'s
   `etNaiveStringToUtcIso()` for the reusable pattern) — this is what caused the original
   incident. If your migration's logic can be expressed as pure SQL date comparisons
   instead of JS-side date parsing, do that; it sidesteps the whole bug class.

## Any bulk UPDATE / backfill / reconstruction

1. **Write and verify a dry-run version first** — report counts per bucket/category,
   never execute the write in the same pass. Verify the buckets sum to the total row
   count with zero overlap and zero rows left unclassified before trusting the logic.
2. **Backup before any destructive change** (`UPDATE` that overwrites existing non-null
   data, any `DELETE`): `CREATE TABLE x_backup_YYYYMMDD AS SELECT ... FROM x WHERE
   <affected rows>;` — matches the existing convention (`dead_tables_backup_20260630`,
   `active_setups_maemfe_backup_20260717`). Cheap, and the one thing that makes a
   migration reversible if the logic turns out wrong after the fact. **Add an entry to
   [docs/DB_BACKUP_CATALOG.md](DB_BACKUP_CATALOG.md) in the same commit** — what it's a
   snapshot of, why, source script. 13 backup tables existed with no index anywhere
   before this was built; don't let a 14th join them unindexed.
3. **If dispatching the reconstruction logic to Gemini** (appropriate for genuinely
   mining/reconstruction-shaped work, per CLAUDE.md's Gemini-for-mining convention):
   Gemini gets read-only access and writes a script; Claude independently re-verifies
   the dry-run numbers via a **separate, independently-written** query before trusting
   them, and Claude — never Gemini — executes the actual write against the live DB.
   Don't skip the independent re-verification just because Gemini's own script "looks"
   audited; a claim of having checked something is not the same as it being checked
   (see the `update_optimal_stops.mjs` `DEFAULT_DPP=5` incident, 2026-07-17 — a
   comment claiming "cross-checked before trusting" was itself wrong).
4. **Never guess at genuinely unrecoverable historical data.** If there's no snapshot
   history to reconstruct against for some date range, label it honestly (e.g.
   `'UNKNOWN'`) rather than approximate it via a lower-confidence proxy and present that
   as equivalent. An honest gap is more useful than a confident-looking guess.

## If the migration adds a column that needs going-forward population

1. **Grep exhaustively for every INSERT site touching the table** — don't trust a
   partial list from memory or a prior audit. `grep -rn "INSERT INTO <table>"` across
   `server/` and any active (non-archived) `scripts/`.
2. **Verify none of the table's UPDATE paths accidentally overwrite the new column** —
   especially if the new column is meant to be immutable-after-insert (like
   `origin_status`). Grep every `UPDATE <table> SET` site and confirm the new column
   isn't in any `SET` list it shouldn't be in.
3. Wire the new column into every INSERT site in the same pass — a half-wired column
   (populated at some insert sites, NULL at others) is worse than not having it, because
   it looks complete without being complete.

## After the migration

1. **Regenerate `server/schema.sql`** (command in `ARCHITECTURE.md`'s schema section).
2. **Run `node scripts/test_invariants.mjs`** — clean, or only the same pre-existing
   warnings as before your change.
3. **Restart the server, curl-check any endpoint that touches the changed table.**
4. **Check `scratch/server_errors.jsonl` for new entries post-restart** — not just "no
   error on the endpoint I tested," genuinely new entries in the error log.
5. **Spot-check actual values with a direct query**, not just "the script reported
   success." `SELECT <new column>, COUNT(*) FROM <table> GROUP BY 1` before/after is the
   minimum bar.
6. **Document**: update `ARCHITECTURE.md`'s table description with *why* the change
   exists (not just what it is), write a full entry in `docs/OPEN_THREADS.md` including
   what was explicitly deferred/not done, and if this establishes a new standing
   convention, add it to `CLAUDE.md`'s Hard Rules or Conventions section.

## The meta-rule

Every step above exists because skipping it already caused a real incident in this
codebase at some point — this isn't a hypothetical checklist. When in doubt about
whether a step is worth the time, the answer is almost always yes; the incidents this
protocol prevents (silent data corruption spanning a month, a wrong constant defended
by a false "verified" comment, a DELETE destroying provenance with zero trace) were all
each individually more expensive than the checklist step that would have caught them.
