"""PHASE 1 (outcome-blind) of docs/VACUUM_CONTEXT_EXIT_PREREG_20261109.md (rows 28+29, amendment A1). Reads NO forward price of any signal: counts, the extension E_t (backward only), and the
UNCONDITIONAL 30-bar volatility of the tape (precedent: argon_vacuum_blind_funnel). Never touches sessions >= 2026-10-12 or 2026-11-06 (asserted).
Usage: ../../venv/bin/python context_exit_phase1.py"""
import os, sys, glob, json, bisect, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2, depth_tell2 as D
LAG = 14400.0; MIN_SEED = 30; HI_PRIMARY = '2026-10-09'; LO_PRIMARY = '2026-06-15'
OUT = os.path.join(v2.OUT, 'context_exit_phase1_output.txt'); JOUT = os.path.join(v2.OUT, 'context_exit_phase1.json')
lines = []
def say(s=''): print(s); lines.append(s)

def adr20(hist_rth):
    prev = hist_rth[-Fm.K_PRIOR:]; r = [float(T['h'].max() - T['l'].min()) for T in prev]
    return float(np.mean(r)) if len(r) >= 15 else float('nan')

def session_events(S, P, n0, F, close, prs, hist_rth):
    """E0 events of one session (v2.events2, the live detector's code) with E_t. Returns a list of dicts and the unconditional 30-bar moves of the tape per track."""
    rows = v2.events2(P, n0, F, close); rows = [r for r in rows if r['fam'] == 'E0']
    en, c = S['en'], S['c']; adr = adr20(hist_rth); out = []
    for r in rows:
        if not r['track']: continue                      # REOPEN / pre-open / post strata without a track: descriptive only elsewhere
        k = r['k']; dr = r['dir']; t = en[k]; E = float('nan')
        if t >= LAG and not np.isnan(adr) and adr > 0:
            j = int(np.searchsorted(en, t - LAG, side='right')) - 1      # last bar ending at or before t - 4h, same session file
            if j >= 0: E = dr * (c[k] - c[j]) / adr
        out.append(dict(date=S['date'], track=r['track'], k=k, dir=dr, t=float(t), E=E, adr=adr))
    return out

def tape_moves(S, close):
    """Unconditional 30-bar moves, c[i+30] - o[i+1], of every bar inside each track's entry window (no signal involved). Used only for the volatility scale."""
    en, o, c = S['en'], S['o'], S['c']; n = len(c); res = {'GBX': [], 'RTH': []}
    for i in range(n - 31):
        t = en[i]
        tr = 'GBX' if 1800.0 <= t <= 55500.0 else ('RTH' if 56100.0 <= t <= close - 600.0 else None)
        if tr: res[tr].append(c[i + 30] - o[i + 1])
    return res

def run_chain(files, label, want_dates=None):
    """Mirror of v2.run: one chain of consecutive session files; returns events (scored sessions only), the sessions scored and tape moves."""
    hist = {'RTH': [], 'GBX': []}; prevS = None; evs = []; sess = []; moves = {'GBX': [], 'RTH': []}
    for p in files:
        S = Fm.load_full(p)
        if S is None: continue
        d = S['date']; assert d <= HI_PRIMARY and d != '2026-11-06', d
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        if len(prs) == 2 and prevS is not None and (want_dates is None or d in want_dates):
            P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close)
            evs += session_events(S, P, n0, F, close, prs, hist['RTH']); sess.append(d)
            m = tape_moves(S, close)
            for k in m: moves[k] += m[k]
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S
    return evs, sess, moves

def primary_files():
    srcs = {}
    for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
        for p in glob.glob(os.path.join(Fm.ROOT, pat)):
            d = os.path.basename(p)[:10]
            if '2026-04-15' <= d <= HI_PRIMARY and d != '2026-11-06': srcs.setdefault(d, p)
    dates = sorted(srcs); keep = []
    for d in dates:
        cp = os.path.join(D.C2, f'{d}.npz')
        keep.append(d)
    scored = set()
    prevS = None
    for d in dates:
        if LO_PRIMARY <= d <= HI_PRIMARY:
            cp = os.path.join(D.C2, f'{d}.npz'); S = Fm.load_full(srcs[d])
            if S is not None and os.path.exists(cp) and D.depth_arrays(S['en'], np.load(cp)) is not None: scored.add(d)
    return [srcs[d] for d in dates], scored

def classify(events):
    """Expanding classification across ALL events of a track in time order (A1.2). Adds flag: UNDEF / SEED / EXT / NONEXT, and the cutoff used."""
    by = {'GBX': [], 'RTH': []}; key = lambda e: (e['date'], e['t'])
    for e in sorted(events, key=key):
        if np.isnan(e['E']): e['flag'] = 'UNDEF'; e['cut'] = float('nan'); continue
        L = by[e['track']]
        if len(L) < MIN_SEED: e['flag'] = 'SEED'; e['cut'] = float('nan')
        else:
            q = float(np.quantile(L, 2.0 / 3.0)); e['cut'] = q; e['flag'] = 'EXT' if e['E'] >= q else 'NONEXT'
        bisect.insort(L, e['E'])

def qline(v):
    v = np.array(v); return ' '.join(f'p{int(q * 100)} {np.quantile(v, q):+.2f}' for q in (0.05, 0.25, 0.5, 0.75, 0.95)) if len(v) else 'n/a'

def mde(sig, n_events, per_day):
    w = np.array(list(per_day.values()), float); ind = 2.802 * sig / np.sqrt(max(n_events, 1)); worst = 2.802 * sig * np.sqrt((w ** 2).sum()) / max(w.sum(), 1)
    return ind, worst

def report(name, evs, sess, moves, scope):
    say(f'\n##### {name}: sessions scored {len(sess)} ({sess[0] if sess else "-"}..{sess[-1] if sess else "-"}); events (E0, in a track window) {len(evs)}')
    out = {}
    for tr in ('RTH', 'GBX'):
        e = [x for x in evs if x['track'] == tr and scope(x)]; fl = collections.Counter(x['flag'] for x in e)
        scored = [x for x in e if x['flag'] in ('EXT', 'NONEXT')]; ext = [x for x in scored if x['flag'] == 'EXT']; non = [x for x in scored if x['flag'] == 'NONEXT']
        days = {x['date'] for x in scored}; perday = collections.Counter(x['date'] for x in scored)
        # production-lock overlap: share of scored events inside the 30 bars of an earlier event of the same track (blocked live under a 30-bar hold)
        bars = sorted((x['date'], x['k']) for x in e); blocked = 0; last = {}
        for d, k in bars:
            if d in last and k <= last[d] + 30: blocked += 1
            else: last[d] = k
        mv = np.array(moves[tr]); sig = float(mv.std()) if len(mv) else float('nan'); pext = len(ext) / max(len(scored), 1)
        sA = np.sqrt(pext) * sig; iA, wA = mde(sA, len(scored), perday); iB, wB = mde(sig, len(non), collections.Counter(x['date'] for x in non))
        say(f'  [{tr}] events {len(e)}: UNDEFINED E (first 240 min of the day or no ADR) {fl["UNDEF"]}, SEED (first {MIN_SEED}) {fl["SEED"]}, scored {len(scored)} = EXTENDED {len(ext)} + NON-extended {len(non)} ({100 * pext:.1f} percent extended)')
        say(f'        active days {len(days)}; events per active day mean {np.mean(list(perday.values())) if perday else 0:.2f} max {max(perday.values()) if perday else 0}; share inside an earlier event\'s 30 bars (lock-blocked under the 30-bar hold) {100 * blocked / max(len(e), 1):.1f} percent')
        say(f'        E_t over scored events (ADR20 units): {qline([x["E"] for x in scored])}; EXTENDED mean E {np.mean([x["E"] for x in ext]) if ext else float("nan"):+.2f}; cutoff (2/3 quantile) last {scored[-1]["cut"] if scored else float("nan"):+.3f}')
        say(f'        unconditional 30-bar tape sigma {sig:.1f} pt (N bars {len(mv)}); MDE (80 percent power, one-sided-ish 2.802 x SE): test A paired mean {iA:.2f} pt if events independent / {wA:.2f} pt if each day perfectly correlated; test B (non-extended N {len(non)}, sigma = tape sigma, INDICATIVE only: the paired SD of ratchet-minus-hold is unmeasured and likely larger) {iB:.2f} / {wB:.2f} pt (cost 2.0 pt)')
        out[tr] = dict(events=len(e), undef=fl['UNDEF'], seed=fl['SEED'], scored=len(scored), ext=len(ext), non=len(non), days=len(days), blocked_share=blocked / max(len(e), 1), sigma30=sig, mde_A=[iA, wA], mde_B=[iB, wB])
    return out

def main():
    files, scored68 = primary_files()
    say(f'PRIMARY scored-date reproduction: {len(scored68)} sessions with a bar file and an aligned depth cache in {LO_PRIMARY}..{HI_PRIMARY} (the prereg and looks 193-196 say 68)')
    evP, sessP, mvP = run_chain(files, 'primary', want_dates=scored68)
    rfiles = sorted(p for p in glob.glob(os.path.join(Fm.BARS, '*.bars.tsv')) if os.path.basename(p)[:10] <= Fm.LAST_EXPLORE)
    evR, sessR, mvR = run_chain(rfiles, 'replication')
    allev = evP + evR; classify(allev)                                       # A1.2: one expanding window across both corpora, time order
    outP = report('PRIMARY (68 depth-era sessions, cutoffs from the full earlier history)', evP, sessP, mvP, lambda x: True)
    outR = report('REPLICATION (2023-03..2025-05-16)', evR, sessR, mvR, lambda x: True)
    # within-corpus-only cutoff, for information (A1.2)
    P2 = [dict(x) for x in evP]; classify(P2)
    say('\n##### INFORMATION: PRIMARY classified against its OWN earlier events only (first 30 events per track are seeds)')
    for tr in ('RTH', 'GBX'):
        c = collections.Counter(x['flag'] for x in P2 if x['track'] == tr); say(f'  [{tr}] {dict(c)}')
    # equivalence of the 500V-bar E_t with the minute-table definition on a sample (A1.1)
    import random
    sample = random.Random(20261109).sample([x for x in evR + evP if not np.isnan(x['E'])], 120)
    try:
        sys.path.insert(0, os.path.join(Fm.ROOT, 'scripts')); from datetime import datetime, timedelta
        import subprocess
        say('\n##### A1.1 equivalence check vs the minute table: done by scripts/vacuum_sim/context_exit_phase1_equiv.mjs (reads sample json)')
        json.dump([dict(date=x['date'], t=x['t'], dir=x['dir'], E=x['E'], adr=x['adr'], track=x['track']) for x in sample], open(os.path.join(v2.OUT, 'context_exit_phase1_sample.json'), 'w'))
    except Exception as e: say(f'  sample write failed: {e}')
    hist = {tr: [round(x['E'], 5) for x in sorted(allev, key=lambda e: (e['date'], e['t'])) if x['track'] == tr and not np.isnan(x['E'])] for tr in ('RTH', 'GBX')}
    json.dump(dict(through='2026-10-09', note='defined E_t of all research E0 events in time order, both corpora (seed history for the live capitulation logger cutoff)', **hist), open(os.path.join(v2.OUT, 'context_exit_E_history.json'), 'w'))
    json.dump(dict(primary=outP, replication=outR, primary_sessions=len(sessP), replication_sessions=len(sessR)), open(JOUT, 'w'), indent=1)
    open(OUT, 'w').write('\n'.join(lines) + '\n')

if __name__ == '__main__': main()
