# Big Picture Unification — Parked Build

**Status: PARKED — both reads currently work, this is an improvement not a fix.**
Logged 2026-06-07, after the morning-narrative generation audit. Do later, after
more live reps with the pre-market walkthrough, so the regime-vs-session
relationship is designed around how it's actually used in practice.

---

## Problem (from the audit)

Two components both render a "Big Picture" read and can disagree:

- **`BigPictureSnapshot`** (App.jsx:13021) — multi-day STRUCTURAL/regime read,
  fed by `/api/longterm/summary` + `/api/composite-profile` (5/10-day value-area
  overlap, POC migration, `bracketState`). This is the rich, good one.
- **`BigPictureMorningSection`** (MorningBriefPanel.jsx:198-286) — a shallow
  4-branch TODAY'S read fed by `/api/auction-read/auto`, keyed only on
  `open_vs_prior_value` + trapped inventory. Much thinner than the Auction Read
  bias paragraph (`generatePreMarketBias`, App.jsx:11335), which uses the SAME
  inputs with far richer branching (structure×NL conflict detection,
  PULLBACK/BOUNCE framing, strong-vs-lean sub-cases).

Both reads are individually valid — they answer different questions (multi-day
regime vs. today's session) — but they're presented as undifferentiated "Big
Picture," and the today's-read block duplicates, more weakly, logic that
already exists in better form in `generatePreMarketBias`.

---

## Proposed Improvement (3 parts)

### 1. Relabel as an explicit hierarchy, not competitors
- `BigPictureSnapshot` → **"Regime / Structural (5-10 day)"**
- the today's-read block → **"Today's Read / Session"**

### 2. Unify today's-read to one source of truth
Stop using `BigPictureMorningSection`'s shallow 4-branch generator. Point
today's-read at the SAME logic that powers the Auction Read bias paragraph
(`generatePreMarketBias`, App.jsx:11335) so there is ONE canonical today's
read, displayed in both the Auction Read context and the Big Picture context,
always consistent. Collapses duplicate logic AND upgrades the weaker block.

### 3. Add a regime-vs-session divergence flag (the actual new signal)
Explicitly surface whether the multi-day regime (`bracketState` /
`BigPictureSnapshot`) and today's session read (`generatePreMarketBias`)
**AGREE** (coherent, high-conviction picture) or **CONFLICT** (e.g. regime
TRENDING_UP but today opened below value with trapped longs → potential
countertrend/pullback day within the larger trend).

Display as **REFERENCE ONLY** — informs, never auto-decides. Mirrors the
pre-market walkthrough's stack/conflict verdict and the existing
PULLBACK/BOUNCE framing already inside `generatePreMarketBias`
(App.jsx:11375-11388, the `nlConflicts` branches).

---

## Constraints / guardrails for whoever picks this up

- This touches sections prone to content-regression (the Auction Read bias
  paragraph has historically regressed to empty during cleanups — see the
  `null`-return paths at App.jsx:11336 and the generic-fallback at
  App.jsx:11390). **Collapse/unify structure, never delete substance.** Verify
  ALL existing Big Picture and Auction Read content still renders and
  populates after the change.
- The divergence flag is reference-only; it must never pre-fill or override
  the trader's own read/decision.
- One-source-of-truth requirement: after this change, "today's structural
  read" must be computed in exactly ONE place (`generatePreMarketBias` or its
  successor) and displayed wherever needed — not re-derived independently in
  `MorningBriefPanel.jsx` or anywhere else.

## Source references (from the audit, App.jsx line numbers may drift)
- `BigPictureSnapshot` — App.jsx:13021
- `generatePreMarketBias` — App.jsx:11335-11391
- `BigPictureMorningSection` — MorningBriefPanel.jsx:198-286 (`biasLine` at lines 221-227)
- `/api/longterm/summary` — server/routes/longterm.js:8-228 (bracketState tree: lines 46-103)
- `/api/auction-read/auto` — server/routes/auctionRead.js (`overnight_inventory`/`open_vs_prior_value` ~lines 332-345)
