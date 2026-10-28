"""TPO-zone variant of the order-flow branch, EXPLORE ONLY (PREREG_TPO.md frozen). Usage: ../../venv/bin/python run_tpo.py"""
import numpy as np, pandas as pd, pathlib
import flow as F, engine as E, tpo
from run import metrics, ci, line, placebo, SPLIT, SEED
from amt_s1 import overnight_ranges
HERE = pathlib.Path(__file__).parent

def run_set(sessions, rng, label, with_placebo, by, show=True):
    zs = {s['d']: F.build_zones(s) for s in sessions}; nz = np.array([len(z) for z in zs.values()]); out = {}
    print(f"\n##### {label}: sessions with >= 1 zone {100 * np.mean(nz > 0):.1f}% (n zone-sessions {int(np.sum(nz > 0))})")
    for kind in ('A', 'B'):
        sig, ctl = [], []
        for s in sessions:
            if not zs[s['d']]: continue
            mv = F.micro_vpoc(s['a']) if kind == 'B' else None
            sig += F.simulate(s, kind, control=False, zones=zs[s['d']], mv=mv); ctl += F.simulate(s, kind, control=True, zones=zs[s['d']], mv=mv)
        out[kind] = (sig, ctl); print(f" Setup {kind}")
        print(line('signal ', sig, rng)); print(line('control', ctl, rng))
        if sig and with_placebo:
            real, pq, share = placebo(sig, by, kind, rng); print(f"  RANDOM-ENTRY PLACEBO ({100} trials): real-stripped ${real:.2f} | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real {share:.1f}%")
    return out, zs

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; ks = sorted(raw)
    on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    by = {s['d']: s for s in ex}
    def with_tpo(row):
        out = []
        for s in ex:
            p = tpo.tpo_profile(raw[ks[ks.index(s['d']) - 1]], row=row); t = dict(s); t['vah_vol'], t['val_vol'] = s['vah'], s['val']; t['vah'], t['val'] = p['vah'], p['val']; out.append(t)
        return out
    T1 = with_tpo(1.0)
    dv = np.array([abs(t['vah'] - t['vah_vol']) for t in T1]); dl = np.array([abs(t['val'] - t['val_vol']) for t in T1])
    print(f"Explore sessions {len(ex)}; hold-out sealed. TPO (1.0-pt rows) vs volume value-area edges: median |VAH diff| {np.median(dv):.1f} pts (p90 {np.percentile(dv, 90):.1f}), median |VAL diff| {np.median(dl):.1f} pts (p90 {np.percentile(dl, 90):.1f}); TPO width median {np.median([t['vah'] - t['val'] for t in T1]):.0f} vs volume {np.median([t['vah_vol'] - t['val_vol'] for t in T1]):.0f}")
    vol_out, zv = run_set(ex, rng, 'VOLUME-PROFILE ZONES (reference, same code/data)', True, by)
    tpo_out, zt = run_set(T1, rng, 'TPO ZONES (1.0-point rows)', True, {t['d']: t for t in T1})
    same = np.mean([zv[d] == zt[d] for d in zv]); print(f"\nSessions whose zone set is identical between volume and TPO: {100 * same:.1f}%")
    for row in (0.5, 2.0):                                 # descriptive sensitivity only
        run_set(with_tpo(row), rng, f'TPO ZONES sensitivity, {row}-point rows (descriptive, never selected)', False, {})
    for kind in ('A', 'B'):
        for tag, o in (('volume', vol_out), ('tpo', tpo_out)):
            pd.DataFrame(o[kind][0]).to_csv(HERE / f'trades_{kind}_signal_{tag}_explore.csv', index=False); pd.DataFrame(o[kind][1]).to_csv(HERE / f'trades_{kind}_control_{tag}_explore.csv', index=False)
    print('\nReading is pre-registered (PREREG.md / PREREG_TPO.md): a lead needs CI lower bound > 0, beat placebo p95 and beat its own control. Otherwise not shown.')

if __name__ == '__main__':
    main()
