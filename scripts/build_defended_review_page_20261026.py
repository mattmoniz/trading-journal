"""Builds the Defended Level Review artifact page: template + scratch/defended_review_events_20261026.json (made by sample_defended_events_for_review_20261026.mjs; deterministic, seeded).
Assigns batch A (30 cards: 10 per approach-count stratum, 5 floors + 5 tops) shown first and batch B (the other 30) behind a 'show more' button. Output: scratch/defended_review_page_20261026.html"""
import json, hashlib
ev = json.load(open('scratch/defended_review_events_20261026.json'))
h = lambda k: int(hashlib.md5(k.encode()).hexdigest(), 16)
for st in sorted({e['stratum'] for e in ev}):
    for side in ('floor', 'top'):
        grp = sorted([e for e in ev if e['stratum'] == st and e['side'] == side], key=lambda e: h(e['key']))
        for i, e in enumerate(grp): e['batch'] = 'A' if i < 5 else 'B'
ev.sort(key=lambda e: (e['batch'], h(e['key'] + 'order')))
for i, e in enumerate(ev): e['id'] = 'E%02d' % (i + 1)
t = open('reports/artifacts_20261026/defended_review_template.html').read()
open('scratch/defended_review_page_20261026.html', 'w').write(t.replace('__DATA__', json.dumps(ev, separators=(',', ':'))))
json.dump([{k: e[k] for k in ('id', 'key', 'side', 'date', 'level', 'lines', 'K', 'A', 'relVol', 'stratum', 'batch')} for e in ev], open('reports/defended_review_sample_index_20261026.json', 'w'), indent=1)
print(len(ev), sum(e['batch'] == 'A' for e in ev), 'in batch A')
