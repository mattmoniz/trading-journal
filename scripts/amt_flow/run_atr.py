"""2 x ATR14 stop variant, EXPLORE ONLY (PREREG_ATR.md frozen). Usage: ../../venv/bin/python run_atr.py"""
import numpy as np, pandas as pd, pathlib, importlib.util
import flow as F, engine as E, tpo
_sp = importlib.util.spec_from_file_location('flow_run', str(pathlib.Path(__file__).parent / 'run.py')); _m = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(_m)
metrics, ci, line, placebo, SPLIT, SEED = _m.metrics, _m.ci, _m.line, _m.placebo, _m.SPLIT, _m.SEED
from amt_s1 import overnight_ranges
HERE = pathlib.Path(__file__).parent

def main():
    rng = np.random.default_rng(SEED)
    raw = E.load_sessions(); allS = E.build_eligible(raw); ex = [s for s in allS if s['d'] <= SPLIT]; ks = sorted(raw); on = overnight_ranges(end='2026-10-27')
    for s in ex:
        r = on.loc[s['d']] if s['d'] in on.index else None
        s['onh'], s['onl'] = (float(r.hi), float(r.lo)) if (r is not None and r.n >= 500) else (None, None)
    T1 = []
    for s in ex:
        p = tpo.tpo_profile(raw[ks[ks.index(s['d']) - 1]], row=1.0); t = dict(s); t['vah'], t['val'] = p['vah'], p['val']; T1.append(t)
    print(f"Explore sessions {len(ex)}; hold-outs sealed. Stop = 2.0 x ATR14 (1-minute) from the entry; targets unchanged (A 15, B 20).")
    for label, sess in (('VOLUME-PROFILE ZONES', ex), ('TPO ZONES (1.0-pt rows)', T1)):
        by = {s['d']: s for s in sess}; zs = {s['d']: F.build_zones(s) for s in sess}; print(f"\n##### {label} with 2 x ATR14 stop")
        for kind in ('A', 'B'):
            sig, ctl, ext = [], [], []
            for s in sess:
                if not zs[s['d']]: continue
                mv = F.micro_vpoc(s['a']) if kind == 'B' else None
                sig += F.simulate(s, kind, zones=zs[s['d']], mv=mv, stop_mode='atr2'); ctl += F.simulate(s, kind, control=True, zones=zs[s['d']], mv=mv, stop_mode='atr2')
                if kind == 'A': ext += F.simulate(s, kind, zones=zs[s['d']], stop_mode='atr2ext')
            print(f" Setup {kind}"); print(line('signal ', sig, rng)); print(line('control', ctl, rng))
            print(f"     median risk {np.median([t['risk'] for t in sig]):.1f} pts (mean {np.mean([t['risk'] for t in sig]):.1f}); zero-drift win prob about {100 * np.median([t['risk'] for t in sig]) / (np.median([t['risk'] for t in sig]) + (F.A_TGT if kind == 'A' else F.B_TGT)):.0f}% vs target hits {100 * np.mean([t['reason'] == 'TGT' for t in sig]):.1f}%")
            if sig:
                real, pq, share = placebo(sig, by, kind, rng); print(f"  RANDOM-ENTRY PLACEBO (100 trials): real-stripped ${real:.2f} | placebo p5 {pq[0]:.2f} p50 {pq[1]:.2f} p95 {pq[2]:.2f} | trials >= real {share:.1f}%")
            if kind == 'A': print(line('sensitivity: stop 2xATR beyond the setup extreme', ext, rng))
            tag = 'vol' if label.startswith('VOLUME') else 'tpo'
            pd.DataFrame(sig).to_csv(HERE / f'trades_{kind}_signal_{tag}_atr2_explore.csv', index=False); pd.DataFrame(ctl).to_csv(HERE / f'trades_{kind}_control_{tag}_atr2_explore.csv', index=False)
    print('\nReading is pre-registered (PREREG_ATR.md): a lead needs CI lower bound > 0, beat placebo p95 and beat its own control. Otherwise not shown.')

if __name__ == '__main__':
    main()
