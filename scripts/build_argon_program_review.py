"""Builds the 3-part paste-ready WEB dossier for Argon's comprehensive program review plus ONE copy-button page with a button per part. Run: venv/bin/python scripts/build_argon_program_review.py [html_out]"""
import html, sys, os
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
rd = lambda p: open(R + p).read()
intro = rd('scratch/argon_program_dossier_intro_20261109.md'); stats = rd('scratch/argon_program_stats_20261109.txt'); work = rd('docs/WORKPLAN_20261109.md'); claude = rd('CLAUDE.md'); reg = rd('docs/IMPROVEMENT_REGISTER_20261104.md')
p1 = intro + "## STATS BLOCK (from the database on 2026-11-09 evening; ledger = `research_looks`)\n```\n" + stats + "```\n\n---------------------------------------------------------------------------\n## THE WORK PLAN OF 2026-11-09 (single tracker; the log at the bottom is chronological, newest last)\n" + work + "\n\nEND OF PART 1. Reply only 'RECEIVED PART 1' plus one line on anything unreadable or truncated.\n"
p2 = "# COMPREHENSIVE PROGRAM REVIEW: PART 2 of 3\nThis is `CLAUDE.md`, the project's rule index (each line ends with an id such as hr-004; the full text of every rule lives in an archive I do not paste). It is the process you are asked to audit in Part 1 task B and C. Hard rules (hr-), conventions (cv-), collaboration (co-), where-to-look (wl-).\n\n" + claude + "\n\nEND OF PART 2. Reply only 'RECEIVED PART 2' plus one line on anything unreadable or truncated.\n"
L = reg.split('\n'); cut = next(i for i, l in enumerate(L) if l.startswith('| 17 |')); tbl = next(i for i, l in enumerate(L) if l.startswith('| # |')); reg1 = '\n'.join(L[:cut]); reg2 = '\n'.join(L[tbl:tbl + 2] + L[cut:])
p3 = "# COMPREHENSIVE PROGRAM REVIEW: PART 3 of 4\nThis is the IMPROVEMENT REGISTER (first half: rows 1 to 16): every research thread, monitor and forward test with what the evidence says, the salvageable part, the cheapest next test, the retire rule and the status (rows 1 to 32 in total; rows 28 to 32 were registered or built on 2026-11-09). It is the evidence base for Part 1 task A. A row with no named next test is a defect by my own rule.\n\n" + reg1 + "\n\nEND OF PART 3. Reply only 'RECEIVED PART 3' plus one line on anything unreadable or truncated.\n"
p4 = "# COMPREHENSIVE PROGRAM REVIEW: PART 4 of 4\nSecond half of the IMPROVEMENT REGISTER (rows 17 to 32; the table header is repeated).\n\n" + reg2 + "\n\n## ALSO AVAILABLE ON REQUEST (not pasted, tell me which you want and I will paste it): the pre-registrations of rows 28/29, 30 and 31 with amendments A1 to A7; the audit of your earlier web reviews; the exit spec; the counted-test script and the review it received; the open-threads log (250 KB).\n\nEND OF PART 4\nNow write the full review defined at the end of Part 1 (tasks A to F, at most 3,500 words, ranked findings).\n"
os.makedirs(R + 'scratch/argon_program_review', exist_ok=True)
for i, t in enumerate((p1, p2, p3, p4), 1): open(R + f'scratch/argon_program_review/part{i}_of_3.md', 'w').write(t)
print([len(t.split()) for t in (p1, p2, p3, p4)], 'words per part')
out = sys.argv[1] if len(sys.argv) > 1 else None
if out:
    def block(i, t): return f'<section class="part"><div class="parthead"><h2>Part {i} of 4</h2><span class="meta">{len(t.split()):,} words</span><button type="button" class="copy" data-target="p{i}">Copy part {i}</button><span class="status" role="status" aria-live="polite"></span></div><pre id="p{i}">{html.escape(t)}</pre></section>'
    page = f'''<title>Argon Program Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>
/* Layout: three stacked parts, each with its own sticky-free header and copy button; paste them into one Argon chat in order. */
:root {{ --bg:#f6f7f9; --surface:#ffffff; --fg:#1d2330; --muted:#5b6577; --line:#d9dee7; --accent:#1f5fbf; --accent-fg:#ffffff; --ok:#1b7a43; --ui:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif; --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#12161d; --surface:#181d26; --fg:#e4e8f0; --muted:#98a2b5; --line:#2b3342; --accent:#6ea2f0; --accent-fg:#0c1220; --ok:#5fcf8f; color-scheme: dark; }} }}
:root[data-theme="dark"] {{ --bg:#12161d; --surface:#181d26; --fg:#e4e8f0; --muted:#98a2b5; --line:#2b3342; --accent:#6ea2f0; --accent-fg:#0c1220; --ok:#5fcf8f; color-scheme: dark; }}
body {{ background: var(--bg); color: var(--fg); font-family: var(--ui); }}
main {{ padding-block:20px 40px; padding-left:max(16px,env(safe-area-inset-left,0px)); padding-right:max(16px,env(safe-area-inset-right,0px)); }}
.wrap {{ max-width:960px; margin:0 auto; display:flex; flex-direction:column; gap:20px; }}
h1 {{ font-size:19px; margin:0 0 4px; text-wrap:balance; }} .lead {{ margin:0; font-size:13.5px; color:var(--muted); line-height:1.5; }}
.part {{ background:var(--surface); border:1px solid var(--line); border-radius:8px; min-width:0; }}
.parthead {{ display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; padding:12px 16px; border-bottom:1px solid var(--line); }}
.parthead h2 {{ font-size:15px; margin:0; }} .meta {{ font-size:12.5px; color:var(--muted); }} .status {{ font-size:13px; color:var(--muted); }}
button.copy {{ margin-left:auto; font:600 14px var(--ui); border:0; border-radius:6px; padding:10px 18px; background:var(--accent); color:var(--accent-fg); cursor:pointer; min-height:40px; }}
button.copy:focus-visible {{ outline:3px solid var(--fg); outline-offset:2px; }} button.copy[data-done="1"] {{ background:var(--ok); }}
pre {{ margin:0; padding:16px; font:400 12.5px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; max-height:420px; overflow:auto; }}
@media (max-width:480px) {{ pre {{ font-size:12px; padding:12px; }} }}
</style>
<main><div class="wrap">
<div><h1>Comprehensive program review for Argon</h1><p class="lead">Four pastes, in order, into ONE new Argon web chat. Argon replies only "RECEIVED PART n" after parts 1 to 3 and writes the full review after part 4. Each part scrolls inside its box; the Copy button copies the whole part. Private to you.</p></div>
{block(1, p1)}{block(2, p2)}{block(3, p3)}{block(4, p4)}
</div></main>
<script>
(function () {{
  function selectAll(pre) {{ var r=document.createRange(); r.selectNodeContents(pre); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }}
  Array.prototype.forEach.call(document.querySelectorAll('button.copy'), function (btn) {{
    var pre=document.getElementById(btn.dataset.target), st=btn.parentNode.querySelector('.status');
    btn.addEventListener('click', function () {{
      var t=pre.textContent, label=btn.textContent;
      function done() {{ st.textContent='Copied'; btn.dataset.done='1'; btn.textContent='Copied'; setTimeout(function () {{ btn.dataset.done=''; btn.textContent=label; st.textContent=''; }}, 2500); }}
      if (navigator.clipboard && navigator.clipboard.writeText) {{ navigator.clipboard.writeText(t).then(done, function () {{ selectAll(pre); st.textContent='Selected: press Ctrl+C or Cmd+C'; }}); }}
      else {{ selectAll(pre); st.textContent='Selected: press Ctrl+C or Cmd+C'; }}
    }});
    pre.addEventListener('click', function () {{ selectAll(pre); }});
  }});
}})();
</script>
'''
    open(out, 'w').write(page)
