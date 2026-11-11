"""Assembles the paste-ready WEB brief for Argon's DESIGN critique D1 (exit arms + capitulation exit tested on the other setups) from the CURRENT files, plus the copy-button page. Run: venv/bin/python scripts/build_argon_d1_brief.py [html_out]"""
import html, sys, os
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
rd = lambda p: open(R + p).read()
d1 = rd('scratch/staged_argon_requests/design_d1_deepseek_request.md')
qa = d1[d1.index('## Question set A'):d1.index('## Format')]
setup = d1[d1.index('## Round D1'):d1.index('## Question set A')].replace('## Round D1: DESIGN critique (no code review) of two strategy questions, BEFORE anything is built or run', '## The situation')
setup = setup.replace('Read these files first:', 'The files are INCLUDED below (you cannot read the repo):')
spec = rd('scratch/argon_spec_exit_v2_20261109.md'); cap = rd('docs/CAPITULATION_EXIT_SHADOW_PREREG_20261109.md'); vac = rd('docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md'); aud = rd('docs/ARGON_REVIEW_AUDIT_ROWS28_31_20261109.md')
head = '''# DESIGN CRITIQUE (not a code review). Paste target: a NEW Argon web chat. You have NO repo or data access; ALL context is below, you cannot run anything and must not ask me to. Two strategy questions, BEFORE anything is built or run: (A) how the expansion rule should EXIT, (B) whether to test a "capitulation exit" on the user's OTHER setups now, using history, instead of waiting months for a forward shadow. Please answer in under 3,000 words, numbered by question, and be blunt. Treat any number you give as a GUESS unless it is in the files below.

## RECEIPT (first 3 lines of your answer)
State (1) the 30-bar hold length in wall-clock seconds on 2026-11-09 for the 13:31 long and for the 14:36 long (they are in the spec in FILE 1); (2) the number of REAL cluster-primary setup rows with a P&L in the 2026-06-15..2026-10-09 explore window (in "The situation"); (3) the family-wise rule and alpha of the counted tests in FILE 3.

## Corrections you should know (my errors in earlier rounds)
I told you earlier that I trade on a prop account with a $1,000 daily loss. That was WRONG: there is NO prop account today (Sim1 is a plain simulator); a possible later evaluation would trail end-of-day with no daily loss limit. Do not build any argument on account rules.

'''
body = head + setup + '\n' + qa + '''
## Format of the answer
For each question: your verdict (keep / change / drop), the reasoning, and the EXACT amendment or design text you would use (so I can paste it as a dated pre-outcome amendment). Then "The 5 most important criticisms", then "EXTRA HELP AND SUGGESTIONS" (anything we did not think of: better exit ideas, better ways to choose which setups the capitulation exit applies to, cheap outcome-blind checks to run first, how this could fool us), then "What would make you WRONG" (up to five things).

---------------------------------------------------------------------------
## FILE 1 of 4: the exit spec (written after the 2026-11-09 live trade)
''' + spec + '''

---------------------------------------------------------------------------
## FILE 2 of 4: the capitulation-exit forward-shadow pre-registration (row 30; amendments A2 and A3)
''' + cap + '''

---------------------------------------------------------------------------
## FILE 3 of 4: the extension-context and ratchet pre-registration (rows 28/29; amendments A1 to A7; the counted tests are Holm 0.10 over exactly four tests on the 513-session corpus)
''' + vac + '''

---------------------------------------------------------------------------
## FILE 4 of 4: the audit of your earlier reviews (what you said, what the data said, what I adopted or declined)
''' + aud + '\n'
open(R + 'scratch/argon_web_d1_exits_and_capitulation_20261109.md', 'w').write(body)
print(len(body), 'chars', len(body.split()), 'words')
out = sys.argv[1] if len(sys.argv) > 1 else None
if out:
    esc = html.escape(body)
    page = f'''<title>Argon Design Review, D1</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>
/* Layout: one sticky action bar over a single wrapped text column; the page exists to copy the brief in one tap. */
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
  <div class="name"><h1>D1: exit arms and capitulation exit, design brief for Argon</h1><p class="meta">Full context inline, {len(body.split()):,} words. Paste into a NEW Argon web chat. Private to you.</p></div>
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
