"""Assembles the paste-ready web brief for Argon's round-16 CODE review (rows 28/29 counted tests) from the CURRENT files, plus the copy-button page. Run: venv/bin/python scripts/build_argon_round16_brief.py [html_out]"""
import html, sys, os
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
rd = lambda p: open(R + p).read()
tests = rd('scripts/vacuum_sim/context_exit_tests.py'); audit = rd('scripts/vacuum_sim/context_exit_blind_audit.py'); arms = audit[audit.index('def arms('):audit.index('def chain(')].rstrip()
ph = rd('scripts/vacuum_sim/context_exit_phase1.py'); consts = ph[ph.index('LAG = 14400.0'):ph.index('lines = []')].strip(); adr = ph[ph.index('def adr20('):ph.index('def session_events(')].rstrip(); prim = ph[ph.index('def primary_files('):ph.index('def classify(')].rstrip()
v2 = rd('scripts/vacuum_sim/v2.py'); v2code = v2[v2.index('def continuous('):v2.index('def run(')].rstrip()
runner = rd('scripts/run_context_exit_tests.mjs'); led = rd('scripts/lib/look_ledger.mjs'); prereg = rd('docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md')
head = '''# THIS IS A CODE REVIEW TASK. The thing under review is the PYTHON CODE in FILE 1 (and its helpers in FILES 2 to 5), checked against the SPEC in FILE 6. It is NOT a request to critique this prompt: if you start by assessing the prompt, stop and review the code. (Paste target: the Argon web chat; you have NO repo or data access, ALL code and the spec are below; you cannot run anything and must not ask me to.) Please answer in under 3,000 words and be blunt.

## RECEIPT (required, first 4 lines of your answer)
Prove you read the files: state (1) the value of `SEED`, `BOOT`, `NCTL`, `POOL` and `ALPHA` in FILE 1, (2) the `SLIP` constant and the line in `arms` that computes the entry-bar stop fill, (3) the `MIN_SEED` and `LAG` values in FILE 3, (4) the `ref` string and the `tests` value passed to `logLook` in FILE 5.

## Why this review matters
I trade 1 micro NQ contract on a plain simulator (no prop account exists today). This script runs 4 COUNTED tests of a pre-registration on 513 explore sessions (2023-03..2025-05-16): reading its results spends those tests permanently, so a bug found afterwards means a second look and another multiplicity charge. It has NOT been run on real outcomes. What I did run: a synthetic-outcome self-test under a true null (all four NOT SHOWN), a code-path check on random shifted bars, and I am running a null Monte Carlo of the whole pipeline on random bars (`--mc`, result not in yet). Bugs already found by my own re-read and FIXED in the code below (do not re-report): the Holm correction is now a step-down over exactly four tests; `lock_book` locks each arm to its own actual exit bar.

Do not guess about code behaviour: read the code below. Mark a statement GUESS only if it concerns data distributions you cannot see.

## What I want (thorough)
1. SPEC-VS-CODE. For EVERY item of the PASS rule and every amendment (A1 to A5) in FILE 6, a compact table row: item | implemented correctly / wrongly / not at all | 8 words on why. Items that are fine get one short row.
2. BUG HUNT: (a) statistics: `Days.boot`, `test_stats`, `holm`, `make_verdicts`, `control_draws`, `lock_book`, the lock-applied comparison in `run_corpus`; (b) mechanics: `arms`/`arms_all` (H, R, R2 and the mirror `Hm`); (c) lookahead and leakage: E_t, ADR20, the expanding 2/3 quantile in `classify` across BOTH corpora, random-bar pools, seeds, session boundaries; (d) selection: events dropped when `arms` returns None, undefined E, seeds, the reopen.
3. THINGS I ALREADY CHECKED (verify, do not just agree): the 1-tick gap penalty has the right sign for longs and shorts and is identical in the mirror trade; the stop is checked before the extreme update on every bar including the entry bar; the 30-bar hold ends at the close of signal bar + 30 (same as the live rule); bootstrap p-values use (1 + count) / (B + 1); `Days.boot` divides by event counts that are at least 1; winsorizing is event-level, once, outside the bootstrap; drop-top-2-days ranks days by their summed paired value.
4. THINGS I WANT YOU TO ATTACK: the control draws fall back to OTHER dates (same track and hour) when a date has no match, and the control is not day-blocked (does that make the 95th-percentile comparison too easy or too hard?); the placebo interval uses the 5th percentile while Holm uses 0.10; test A is quoted per skipped trade but the lock comparison uses per-day sums; the 2026 sign gate uses cutoffs seeded by 2023-2025 events; whether a pass of test A can occur trivially because skipping ANY subset of losing (after-cost) trades has a positive mean; the ledger and crash policy in amendment A5 and in the runner (does a crash after the look but before any statistic burn the tests, can anything evade the ledger?); whether the null Monte Carlo design is a valid test of the pipeline's Type I error and what would make it misleading.

## Format of the answer
Findings ranked BLOCKER (would invalidate or bias the counted tests), MAJOR (changes a verdict in some plausible case), MINOR. For each: the function name, what is wrong, a concrete failure scenario with numbers, and the fix (a short code snippet is welcome). Then the SPEC table. Then "EXTRA HELP AND SUGGESTIONS": anything we did not think of, cheaper or stronger designs, missing controls, outcome-blind checks to run first, ways this script could fool us, and what you would do differently.

'''
body = head + "## FILE 1 of 6: context_exit_tests.py (THE SCRIPT UNDER REVIEW)\n```python\n" + tests + "\n```\n\n## FILE 2 of 6: the `arms` function (from context_exit_blind_audit.py; `COST = 2.0`, `SLIP = 0.25`)\n```python\nCOST = 2.0; SLIP = 0.25\n" + arms + "\n```\n\n## FILE 3 of 6: constants and helpers from context_exit_phase1.py (imported as `P1`)\n```python\n" + consts + "\n\n" + adr + "\n\n" + prim + "\n```\n\n## FILE 4 of 6: event definition and series helpers from v2.py (imported as `v2`; `Fm.ema` = Sierra EMA10, `Fm.sma_sd` = SMA50 +- population SD)\n```python\n" + v2code + "\n```\n\n## FILE 5 of 6: the runner run_context_exit_tests.mjs and the ledger helper\n```javascript\n" + runner + "\n```\n```javascript\n" + led + "\n```\n\n## FILE 6 of 6: THE SPEC (the pre-registration with amendments A1 to A5)\n" + prereg + "\n"
open(R + 'scratch/argon_web_round16_counted_tests_20261109.md', 'w').write(body)
out = sys.argv[1] if len(sys.argv) > 1 else None
print(len(body), 'chars', len(body.split()), 'words')
if out:
    esc = html.escape(body)
    page = f'''<title>Argon Code Review, Round 16</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>
/* Layout: one sticky action bar over a single wrapped text column; the page exists to copy the review brief in one tap. */
:root {{ --bg:#f6f7f9; --surface:#ffffff; --fg:#1d2330; --muted:#5b6577; --line:#d9dee7; --accent:#1f5fbf; --accent-fg:#ffffff; --ok:#1b7a43; --ui:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif; --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#12161d; --surface:#181d26; --fg:#e4e8f0; --muted:#98a2b5; --line:#2b3342; --accent:#6ea2f0; --accent-fg:#0c1220; --ok:#5fcf8f; color-scheme: dark; }} }}
:root[data-theme="dark"] {{ --bg:#12161d; --surface:#181d26; --fg:#e4e8f0; --muted:#98a2b5; --line:#2b3342; --accent:#6ea2f0; --accent-fg:#0c1220; --ok:#5fcf8f; color-scheme: dark; }}
body {{ background: var(--bg); color: var(--fg); font-family: var(--ui); }}
body::before {{ content:""; position:fixed; inset:0 0 auto; height:env(safe-area-inset-top,0px); z-index:10; background:var(--surface); }}
.bar {{ position:sticky; top:env(safe-area-inset-top,0px); z-index:9; background:var(--surface); border-bottom:1px solid var(--line); padding-block:12px; padding-left:max(16px,env(safe-area-inset-left,0px)); padding-right:max(16px,env(safe-area-inset-right,0px)); }}
.bar-in {{ max-width:960px; margin:0 auto; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 16px; }}
.name {{ min-width:0; }} h1 {{ font-size:17px; line-height:1.3; margin:0; font-weight:600; text-wrap:balance; }} .meta {{ margin:2px 0 0; font-size:12.5px; color:var(--muted); }}
.actions {{ display:flex; align-items:center; gap:12px; }}
button {{ font:600 14px var(--ui); border:0; border-radius:6px; padding:10px 18px; background:var(--accent); color:var(--accent-fg); cursor:pointer; min-height:40px; }}
button:focus-visible {{ outline:3px solid var(--fg); outline-offset:2px; }} button[data-done="1"] {{ background:var(--ok); }}
#status {{ font-size:13px; color:var(--muted); min-width:7ch; }}
main {{ padding-block:20px 40px; padding-left:max(16px,env(safe-area-inset-left,0px)); padding-right:max(16px,env(safe-area-inset-right,0px)); }}
.sheet {{ max-width:960px; margin:0 auto; background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:18px; min-width:0; }}
pre {{ margin:0; font:400 12.5px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; }}
@media (max-width:480px) {{ pre {{ font-size:12px; }} .sheet {{ padding:12px; }} }}
</style>
<header class="bar"><div class="bar-in">
  <div class="name"><h1>Round 16 (v2): code review brief for Argon</h1><p class="meta">Counted-test script for rows 28 and 29, all code and the spec inline. {len(body.split()):,} words. Paste into a NEW Argon web chat. Private to you.</p></div>
  <div class="actions"><span id="status" role="status" aria-live="polite"></span><button id="copy" type="button">Copy whole brief</button></div>
</div></header>
<main><div class="sheet"><pre id="brief">{esc}</pre></div></main>
<script>
(function () {{
  var btn=document.getElementById('copy'), st=document.getElementById('status'), pre=document.getElementById('brief');
  function done(m) {{ st.textContent=m; btn.dataset.done='1'; btn.textContent='Copied'; setTimeout(function () {{ btn.dataset.done=''; btn.textContent='Copy whole brief'; st.textContent=''; }}, 2500); }}
  function selectAll() {{ var r=document.createRange(); r.selectNodeContents(pre); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }}
  btn.addEventListener('click', function () {{
    var t=pre.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {{ navigator.clipboard.writeText(t).then(function () {{ done('Copied to clipboard'); }}, function () {{ selectAll(); st.textContent='Selected: press Ctrl+C or Cmd+C'; }}); }}
    else {{ selectAll(); st.textContent='Selected: press Ctrl+C or Cmd+C'; }}
  }});
  pre.addEventListener('click', selectAll);
}})();
</script>
'''
    open(out, 'w').write(page)
