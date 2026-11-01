"""One-shot analysis of the blind side calls (PREREG_SIDE_CALLS.md frozen 2026-11-01). Run ONCE on the exported ratings; do not re-run as ratings arrive.
Usage: ../../venv/bin/python analyze_side_calls.py RATINGS (a JSON array file, or a directory of one-doc-per-file JSON exports) [--key PATH]   (default key: scratch/side_calls_20261101/key.json)"""
import sys, os, json, glob
import numpy as np
from scipy.stats import beta
KEY = '/home/mmoniz/trading-journal/scratch/side_calls_20261101/key.json'; SEED, DRAWS = 20261101, 20000

def load_ratings(p):
    if os.path.isdir(p):
        out = []
        for f in sorted(glob.glob(os.path.join(p, '**', '*.json'), recursive=True)): out.append(json.load(open(f)))
        return out
    d = json.load(open(p)); return d if isinstance(d, list) else list(d.values())

def cp(k, n, a=0.05):
    if n == 0: return float('nan'), float('nan')
    return (0.0 if k == 0 else beta.ppf(a / 2, k, n - k + 1)), (1.0 if k == n else beta.ppf(1 - a / 2, k + 1, n - k))

def perm_p(x, rng):
    """within-item sign flip null of the mean signed move; one-sided p for mean > 0 and the null's 95th percentile"""
    x = np.asarray(x); obs = x.mean(); null = np.array([(x * rng.choice([-1, 1], len(x))).mean() for _ in range(DRAWS)])
    return obs, float((null >= obs).mean()), float(np.percentile(null, 95))

def stats(label, items, key, h, rng, detail=True):
    xs = [it['d'] * key[it['id']]['fwd_long'][h] for it in items if key[it['id']]['fwd_long'].get(h) is not None]
    if not xs: print(f'  {label}: no calls'); return None
    xs = np.array(xs); obs, p, p95 = perm_p(xs, rng); k = int((xs > 0).sum()); n = int((xs != 0).sum()); lo, hi = cp(k, n)
    print(f"  {label:44s} n={len(xs):3d}  mean signed {h}m move {obs:+.3f} ATR20 (null p95 {p95:+.3f}, one-sided p {p:.3f})  hit {k}/{n} = {100 * k / max(n, 1):.0f}% CI [{100 * lo:.0f}, {100 * hi:.0f}]")
    return dict(mean=obs, p=p, lo=lo, n=len(xs))

def main():
    rp = sys.argv[1]; key_path = sys.argv[sys.argv.index('--key') + 1] if '--key' in sys.argv else KEY
    key = json.load(open(key_path)); R = [r for r in load_ratings(rp) if r.get('id') in key]; rng = np.random.default_rng(SEED)
    calls = [dict(r, d=1 if r['call'] == 'LONG' else -1) for r in R if r['call'] in ('LONG', 'SHORT')]
    tell = [c for c in calls if key[c['id']]['tell']]; ctrl = [c for c in calls if not key[c['id']]['tell']]
    print(f"ratings {len(R)} of {len(key)} items; calls LONG/SHORT {len(calls)} (tell items {len(tell)}, control items {len(ctrl)}); skips {sum(r['call'] == 'SKIP' for r in R)}; recognised {sum(bool(r.get('recognised')) for r in R)}")
    print('\n=== PRIMARY and secondary horizons, TELL moments, called side ===')
    res = {h: stats(f'tell items, trader calls', tell, key, h, rng) for h in ('60', '30', '15')}
    print('\n=== the tell own direction on the same tell items (what the machine would have done) ===')
    for h in ('60', '30', '15'):
        ti = [dict(id=c['id'], d=key[c['id']]['tell_dirs'][0]) for c in tell if len(key[c['id']]['tell_dirs']) == 1]; stats('tell direction on called tell items', ti, key, h, rng)
    ag = [c['d'] == key[c['id']]['tell_dirs'][0] for c in tell if len(key[c['id']]['tell_dirs']) == 1]
    if ag: print(f"  agreement between the trader call and the tell direction: {sum(ag)}/{len(ag)} = {100 * np.mean(ag):.0f}%")
    print('\n=== CONTROL moments (no tell), called side ==='); [stats('control items, trader calls', ctrl, key, h, rng) for h in ('60', '30', '15')]
    print('\n=== sensitivities (descriptive) ===')
    for lab, f in (('high confidence', lambda c: c.get('conf') == 'high'), ('low confidence', lambda c: c.get('conf') == 'low'), ('not recognised', lambda c: not c.get('recognised'))):
        stats(f'tell items, {lab}', [c for c in tell if f(c)], key, '60', rng)
    cues = sorted({q for c in calls for q in c.get('cues', [])})
    for q in cues: stats(f'tell+control items, cue: {q[:30]}', [c for c in calls if q in c.get('cues', [])], key, '60', rng)
    pr = res['60']; ok = bool(pr and pr['p'] < 0.05 and pr['lo'] > 0.5 and res['30'] and res['15'] and np.sign(res['30']['mean']) == np.sign(res['15']['mean']) == 1)
    print(f"\nREADING (pre-registered): {'LEAD' if ok else 'not shown'}; resolution: with {len(tell)} tell calls only a large side skill (mean about +0.15-0.2 ATR20, hit rate near 70 percent) could be seen; a null means not large, never no skill.")

if __name__ == '__main__': main()
