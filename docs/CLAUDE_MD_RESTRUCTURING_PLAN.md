# CLAUDE.md restructuring — executed 2026-08-12, partially

**Status as of 2026-08-12 (later same day): done for all four rule-bearing sections
(Hard rules, Conventions, Collaboration, Where to look), section by section with a
separate commit each, per the execution steps below.** `CLAUDE.md` dropped from
230 lines / 233KB to 218 lines / 99KB (~57% reduction) — every incident narrative
with a real dated bug/finding was moved verbatim into a new detail file
(`docs/HARD_RULES_DETAIL.md`, `docs/CONVENTIONS_DETAIL.md`,
`docs/COLLABORATION_DETAIL.md`), with `CLAUDE.md` keeping the condensed rule +
load-bearing mechanics + a pointer. "Where to look" needed no new detail file —
almost every entry there already pointed to `docs/OPEN_THREADS.md` or a dedicated
spec doc where the full narrative already lived, so that section only needed the
embedded blow-by-blow trimmed to what/where/current-status.

**Not fully done: `test_invariants.mjs` check `[14]`'s 40KB cap is not yet clear**
(99KB vs. a 40KB target — 2.5x over, down from 5.8x). The remaining mass is mostly
in Conventions (33KB) and Hard Rules (28KB), including two large procedural
checklists (the new-setup-type anti-hardcode gate, the confound checklist) that
were deliberately kept in full numbered-list form in `CLAUDE.md` rather than
thinned, since the plan's own categorization principle says the *rule* (here, the
procedure itself) shouldn't be thinned — only the *incident* narrative fused to it.
Closing the remaining ~60KB gap would need either accepting a WARN at this level
long-term, or a second pass that questions whether some of these procedural
checklists themselves belong in a dedicated `docs/` doc instead of `CLAUDE.md` —
a bigger structural call than this pass made, deliberately left for a future
session/explicit user decision rather than decided unilaterally here.

Read this fresh before resuming — don't trust this doc's own summaries of
`CLAUDE.md`'s current content as a substitute for re-reading the live file (same
"don't trust a pre-compaction claim" discipline `CLAUDE.md` itself documents).

## Current section sizes (line numbers as of 2026-08-12)

| Section | Lines | Approx. weight |
|---|---|---|
| Header + Dev workflow | 1-13 | small, stays as-is |
| Hard rules | 14-61 | **largest single mass** — ~48 lines, most are one dense paragraph each (300-2000+ words) |
| Conventions | 62-131 | ~70 lines, same density pattern |
| Collaboration | 132-162 | ~31 lines, same pattern |
| Where to look | 163-216 | ~54 lines — already pointer-shaped (points at docs/scripts) but many entries carry embedded narrative the target doc likely already has |
| Documentation maintenance | 217-230 | small, stays as-is |

## The categorization principle

Every dense bullet in Hard rules / Conventions / Collaboration is actually two
things fused together:
1. **The rule itself** — 1-3 sentences, evergreen, states what to do or not do.
2. **The incident narrative** — the specific bug, the date, the investigation
   steps, the numbers, the fix, sometimes a full retraction story. This is what
   makes each bullet run 300-2000+ words.

**Keep (1) in CLAUDE.md. Move (2) to a detail file, with a pointer left behind.**
A rule stated without its incident can still be followed; the incident without
the rule can't. Concretely, each CLAUDE.md bullet should end up looking like:

> **The rule, stated plainly.** One clause of why if it's load-bearing for
> applying the rule correctly (not for color). See `docs/HARD_RULES_DETAIL.md#slug`
> for the full incident.

Not every bullet needs the full treatment — a few are already short and rule-only
(e.g. "Do not guess on third-party tool behavior") and can stay untouched. Judge
each on its own; don't mechanically truncate everything to the same length.

## Proposed destination files (new)

- `docs/HARD_RULES_DETAIL.md` — full incident writeups for the "Hard rules"
  section, same order, one `##` heading per rule (slug matches a short anchor
  name CLAUDE.md's pointer can link to).
- `docs/CONVENTIONS_DETAIL.md` — same treatment for "Conventions."
- `docs/COLLABORATION_DETAIL.md` — same for "Collaboration" (Gemini/DeepSeek
  workflow incidents, audit failures, etc.) — **check first** whether this
  substantially overlaps an existing memory file (`reference_antigravity_workflow.md`
  is in Claude's own memory system, not this repo) before creating a duplicate;
  if it does, this file should point to that reference rather than re-deriving it.
- `docs/WHERE_TO_LOOK_DETAIL.md` — only for "Where to look" entries whose embedded
  narrative isn't already fully covered by the doc/script they point at. Many
  probably don't need this at all — check each one before assuming it does.

Do not invent more files than this. If a bullet's incident is already fully
documented in an existing doc it references (`docs/OPEN_THREADS.md`,
`docs/DB_BACKUP_CATALOG.md`, a spec doc, etc.), don't duplicate it into a new
detail file — just tighten the CLAUDE.md pointer to go directly to the existing doc.

## Execution steps (do section by section, not as one giant rewrite)

1. **Pick one section** (start with Hard rules — biggest payoff).
2. For each bullet: read it fresh, decide (a) rule text to keep, (b) whether its
   incident already lives elsewhere (link there, don't duplicate) or needs a new
   home in the section's `_DETAIL.md` file.
3. **Write the detail file first, with the full original text moved in verbatim**
   (not summarized/re-derived) — this is the safety net. Verify nothing was lost
   by checking the detail file's total content roughly accounts for what's being
   removed from CLAUDE.md.
4. **Only then** replace the CLAUDE.md bullet with its condensed form + pointer.
5. After each section, run `node scripts/test_invariants.mjs` and check
   `wc -l CLAUDE.md; wc -c CLAUDE.md` against the 300-line/40KB target — this
   tells you section-by-section whether you're converging, not just at the end.
6. **Commit each section separately** (per this repo's own git-commit conventions)
   rather than one enormous diff — makes it possible to review/revert one section
   without touching the others if something reads wrong after the split.
7. Once all four sections are done, re-check `test_invariants.mjs` check `[14]`
   clears clean, and do one final read-through of the resulting CLAUDE.md for
   flow (a file assembled from many small edits can read choppy even if each
   edit was individually fine).

## What NOT to do

- Don't compress rules into vaguer, shorter versions that lose the specific
  "how to apply this" detail — the goal is moving the *incident story* out, not
  thinning the *rule* itself. A rule that's too vague to act on is worse than a
  long one.
- Don't touch "Dev workflow" or "Documentation maintenance" — both are already
  short and don't have the rule+incident fusion problem.
- Don't do this as a single mega-edit in one sitting if it risks running out of
  careful attention partway through — a botched split on a file this
  consequential (loaded into every session) is worse than leaving it as-is a
  while longer. Section-by-section with commits in between is the safer shape.
- Don't forget cross-references — several bullets reference each other
  ("matching the rule above," "same lesson as X") — when a rule moves/shrinks,
  check whether anything else in the file pointed at its old wording.

## Effort estimate

This is a real, multi-hour careful-editing task given ~150 dense bullets across
the four sections, not a quick pass. Budget it as its own session (or several),
not a tail-end addition to another task.

## Result (2026-08-12)

Steps 1-6 done for all four sections, each committed separately (4 commits:
Hard Rules, Conventions, Collaboration, Where to look). Step 7's re-check: the
final read-through was done and flow held up; `test_invariants.mjs` check `[14]`
still WARNs (99KB vs. 40KB target) — improved from 5.8x over to 2.5x over, not
fully clear. Verbatim safety net confirmed intact throughout (each detail file
was generated by mechanically extracting the exact original bullet text, not
by re-summarizing from memory, so nothing was lost — only relocated). No
cross-reference broke: the only internal pointers in this file ("matching the
rule above," "see below") all still resolve to the same rule, just shorter.

If a future session wants to close the remaining ~60KB gap, the two biggest
remaining masses are the two large procedural checklists kept intact in
Conventions (new-setup-type gate, ~2.8KB; confound checklist, ~1KB) plus the
Hard Rules section overall (28KB across 35 rules, each already condensed once)
— the honest next lever isn't further per-bullet trimming (already done), it's
deciding whether some of these checklists belong in their own `docs/` file
instead of `CLAUDE.md` at all, which is a bigger structural call this pass
deliberately didn't make unilaterally.
