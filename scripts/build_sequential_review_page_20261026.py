"""Builds the 'Sequential Run Check' artifact page from the same template as the Defended Level Review, with run-specific wording (13 cards: this morning's floor + 12 seeded runs)."""
import json, re
ev = json.load(open('scratch/sequential_review_events_20261026.json'))
t = open('reports/artifacts_20261026/defended_review_template.html').read()
t = t.replace('<title>Defended Level Review</title>', '<title>Sequential Run Check</title>').replace('<h1>Defended Level Review</h1>', '<h1>Sequential Run Check</h1>')
t = re.sub(r'<section class="panel"><h2>Questions for you.*?</section>\n', '', t, flags=re.S)
t = re.sub(r'<p class="intro">.*?</p>', '<p class="intro">Each card is a run of <strong>four or more sequential four-hour bars</strong> whose lows end at about the same price, with every close staying above the lowest low. The chart stops at the bar where the run reaches four. <strong>S01 is this morning\'s floor</strong>: is it what you meant? For the others, tap <strong>Looks defended</strong> if you would call it obviously defended, <strong>Not defended</strong> if not, <strong>Unsure</strong> if you cannot tell, and say what is off in a few words.</p>', t, count=1, flags=re.S)
t = t.replace('data-v="take">Take<', 'data-v="take">Looks defended<').replace('data-v="skip">Not mine<', 'data-v="skip">Not defended<')
t = t.replace('<span>defense bars <b>${ev.K}</b></span><span>separate approaches <b>${ev.A}</b></span>', '${ev.run ? `<span>sequential bars <b>${ev.K}</b></span>` : `<span>defense bars <b>${ev.K}</b></span><span>separate approaches <b>${ev.A}</b></span>`}')
t = t.replace('<span>bar close <b>${ev.date}</b></span>', '<span>fires at the close of the bar on <b>${ev.date}</b></span>')
t = re.sub(r'<p id="moreP">.*?</p>', '', t, flags=re.S).replace("document.getElementById('more').addEventListener", "if (document.getElementById('more')) document.getElementById('more').addEventListener")
t = t.replace('Black markers = bars that defended the level.', 'Black markers = the bars of the run.')
open('scratch/sequential_review_page_20261026.html', 'w').write(t.replace('__DATA__', json.dumps(ev, separators=(',', ':'))))
print(len(ev), 'cards')
