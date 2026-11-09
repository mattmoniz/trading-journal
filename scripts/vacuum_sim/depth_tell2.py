"""Q4-5 corrected real-depth run (prereg amendment A4, five counted tests). Explore = depth-era sessions 2026-06-15..2026-10-09 with a depth_cache2 file; the confirmation sessions (>= 2026-10-12, and 2026-11-06 never) are REFUSED.
Real Ratio = EMA10(TR) / EMA10(bid_all + ask_all) on one CONTINUOUS series (previous session + current; depth forward-filled, no lookahead). Exits use the V0 rules: stop 2.5 x EMA10(TR)[signal bar], structural failure, 65 percent retrace, ROC10 zero cross, hook INSIDE the band with the Ratio down 0.25 sd (sd frozen at entry). Points; cost 2.0 pt."""
import sys, os, glob, json, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import features as Fm, v2
LO, HI = '2026-06-15', '2026-10-09'; B = 3000; COST = 2.0; MAXB = 60; C2 = os.path.join(v2.OUT, 'depth_cache2')

def ffill(a):
    m = ~np.isnan(a)
    if not m.any(): return a
    ii = np.where(m, np.arange(len(a)), 0); np.maximum.accumulate(ii, out=ii); out = a[ii]; out[:int(np.argmax(m))] = np.nan; return out
def depth_arrays(en, cache):
    """Cache fields aligned to the session bars by POSITION (the cache was built from the same bar file: its first m bars are the session's first m bars; checked by end time), forward-filled afterwards. An empty book (0) is missing data. Returns None on a mismatch."""
    m = len(cache['en'])
    if m > len(en) or not np.allclose(en[:m], cache['en'], atol=1e-6): return None
    out = {}
    for k in ('bid_all', 'ask_all', 'bid10', 'ask10', 'bid5', 'ask5'):
        a = np.full(len(en), np.nan); a[:m] = cache[k]; a[a <= 0] = np.nan; out[k] = ffill(a)
    return out
def real_ratio(F, depth_all):
    n = len(depth_all); ratio = np.full(n, np.nan); first = np.where(~np.isnan(depth_all))[0]
    if len(first) < 100: return None
    f0 = first[0]; ratio[f0:] = F['etr'][f0:] / np.maximum(Fm.ema(depth_all[f0:]), 1e-6)
    rm, rs = Fm.sma_sd(ratio); return ratio, (ratio - rm) / np.where(rs > 1e-12, rs, np.nan), rs
def onset(m): return m & ~np.r_[False, m[:-1]]

def trade_exit(P, F, a, e, dr, flat, ema20, wave_origin, sd_ratio, cadj=None, use_hook=True, maxb=None):
    """V0 exits for a position entered at Open[e] after a signal on bar a. Returns (exit_bar, exit_price, reason) or None. Stop 2.5 x EMA10(TR)[a] is checked on the bar's high/low (fill at the stop, or at the bar open when it gaps through,
    except on the entry bar where the stop is the fill); the other exits are evaluated on the bar CLOSE."""
    h, l, c, o, etr, roc, zq, ratio = P['h'], P['l'], P['c'], P['o'], F['etr'], F['roc'], F['zroc'], F['ratio']
    if e > flat or np.isnan(sd_ratio) or np.isnan(etr[a]): return None
    cx = c if cadj is None else cadj; SLIP = 0.25; entry = o[e]; stop = entry - dr * 2.5 * etr[a]; pk = ratio[a]; ext = h[a] if dr == 1 else l[a]; last = min(e + (maxb or MAXB) - 1, flat)
    for t in range(e, last + 1):
        ext = max(ext, h[t]) if dr == 1 else min(ext, l[t])
        if dr == 1 and l[t] <= stop: return t, (stop if t == e else min(stop, o[t])) - SLIP, 'stop'          # fill at the stop (or the open if it gapped through) plus 1 tick adverse
        if dr == -1 and h[t] >= stop: return t, (stop if t == e else max(stop, o[t])) + SLIP, 'stop'
        pk = max(pk, ratio[t])
        if dr * (cx[t] - ema20[t]) < -0.5 * etr[t] and dr * zq[t] < -0.25: return t, c[t], 'structure'
        if dr * (ext - c[t]) > 0.65 * max(dr * (ext - wave_origin), 2.0 * etr[a]) and dr * (ext - wave_origin) > 0: return t, c[t], 'retrace'
        if dr * roc[t] <= 0: return t, c[t], 'zero'
        if use_hook and dr * zq[t] <= 1.8 and (pk - ratio[t]) >= 0.25 * sd_ratio: return t, c[t], 'hook'          # use_hook=False = V0 Hold_Multi_Wave: hold through the hook, exit on stop / structure / retrace / ROC zero-cross / cap
    return last, c[last], 'cap'

def fade_exit(P, F, a, b, dr, flat, ext):
    """Fade of a push (direction dr) entered AGAINST it at Open[b+1] (decided at the close of bar b: no look at the next open); stop = wave extreme +- 0.5 x EMA10(TR)[b], hit on the bar high/low (fill at the stop or the open if gapped, plus 1 tick adverse;
    a gap beyond the stop at the entry open is an immediate stop-out at that open); exit when the push's ROC10 crosses zero (close) or after 30 bars / the hard flat."""
    h, l, c, o, etr, roc = P['h'], P['l'], P['c'], P['o'], F['etr'], F['roc']; e = b + 1; fd = -dr; SLIP = 0.25
    if e > flat or np.isnan(etr[b]): return None
    stop = ext + dr * 0.5 * etr[b]; entry = o[e]; last = min(e + 29, flat)
    if (dr == 1 and entry >= stop): return e, entry - SLIP * 0 + SLIP, fd, entry
    if (dr == -1 and entry <= stop): return e, entry - SLIP, fd, entry
    for t in range(e, last + 1):
        if dr == 1 and h[t] >= stop: return t, (stop if t == e else max(stop, o[t])) + SLIP, fd, entry
        if dr == -1 and l[t] <= stop: return t, (stop if t == e else min(stop, o[t])) - SLIP, fd, entry
        if dr * roc[t] <= 0: return t, c[t], fd, entry
    return last, c[last], fd, entry

def hour_range_struct(prev):
    K = len(prev); vals = []; wts = []; hrs = []
    for P in prev:
        x = P['h'] - P['l']; vals.append(x); wts.append(np.full(len(x), 1.0 / (K * len(x)))); hrs.append(Fm.hour_et(P['en']))
    x = np.concatenate(vals); w = np.concatenate(wts); h = np.concatenate(hrs); out = {}
    for hh in np.unique(h):
        m = h == hh; i = np.argsort(x[m], kind='stable'); out[int(hh)] = (x[m][i], np.cumsum(w[m][i]) / w[m].sum())
    return out
def cdf_at(struct, hour, v):
    e = struct.get(int(hour))
    if e is None: return np.nan
    j = np.searchsorted(e[0], v, side='right') - 1; return float(e[1][j]) if j >= 0 else 0.0

def main():
    srcs = {}
    for pat in ('scratch/volbars500_holdout_20261103/*.bars.tsv', 'scratch/amt_tell_live/*.split.bars.tsv', 'scratch/argon_vacuum_live/priors/*.bars.tsv'):
        for p in glob.glob(os.path.join(Fm.ROOT, pat)):
            d = os.path.basename(p)[:10]
            if '2026-04-15' <= d <= HI: srcs.setdefault(d, p)
    dates = sorted(srcs); assert max(dates) <= HI and '2026-11-06' not in dates
    rec = collections.defaultdict(list); hist = {'RTH': [], 'GBX': []}; prevS = None; prevd = None; nsess = 0; skipped = []
    rng = np.random.default_rng(20261109)
    for d in dates:
        S = Fm.load_full(srcs[d])
        if S is None: continue
        tsp = Fm.track_split(S); close = Fm.EARLY_CLOSE if d in Fm.EARLY else Fm.CLOSE; prs = {}
        for name in ('RTH', 'GBX'):
            prev = hist[name][-Fm.K_PRIOR:]
            if len(prev) >= Fm.K_PRIOR: prs[name] = Fm.priors_of(prev)
        cp = os.path.join(C2, f'{d}.npz')
        if LO <= d <= HI and len(prs) == 2 and os.path.exists(cp) and prevS is not None:
            P, n0, reset = v2.continuous(prevS, S); F = v2.feats(P, n0, reset, prs, close); n = len(P['c']); F['etr'] = Fm.ema(F['tr'])
            dc = depth_arrays(S['en'], np.load(cp)); pcp = os.path.join(C2, f'{prevd}.npz'); dp = depth_arrays(prevS['en'], np.load(pcp)) if os.path.exists(pcp) else None
            rr = None
            if dc is None: skipped.append(d)
            else:
                cont = {k: np.concatenate([dp[k] if dp is not None else np.full(len(prevS['en']), np.nan), dc[k]]) for k in dc}; rr = real_ratio(F, ffill(cont['bid_all'] + cont['ask_all']))
            if rr is not None:
                F['ratio'], F['zr'], F['rs'] = rr; nsess += 1
                en, c, h, l, o = P['en'], P['c'], P['h'], P['l'], P['o']; idx = np.arange(n); z = F['zroc']; zr = F['zr']
                gap = np.zeros(n)
                for i in np.where(reset)[0]:
                    if i > 0: gap[i:] += o[i] - c[i - 1]
                cx = c - gap; ema20 = Fm.ema(cx, 20)                                                   # structural test and 3-bar move on the gap-masked close (rolls and session gaps never count as price)
                ok = (idx >= n0) & ~np.isnan(z) & ~np.isnan(zr)
                prev_ok = np.r_[False, ~np.isnan(z[:-1]) & ~np.isnan(zr[:-1])]
                rth_w = ok & (en >= 56100.0) & (en <= close - 600.0); gbx_w = ok & (en <= 55500.0)
                dd = np.where(F['roc'] > 0, 1, np.where(F['roc'] < 0, -1, 0)); c0u = ~np.isnan(z) & (np.abs(z) > Fm.Z_ROC) & (np.sign(z) == dd)   # UNMASKED: a window edge can never create an onset
                on0 = onset(c0u) & prev_ok; ontc = onset(c0u & ~np.isnan(zr) & (zr > Fm.Z_RATIO)) & prev_ok
                flow = np.where(dd > 0, F['fl_l'], F['fl_s'])
                fast = np.nan_to_num(F['pace'], nan=1.0) <= 1 / 3; fast &= ~np.isnan(F['pace']); f3 = fast & np.r_[False, fast[:-1]] & np.r_[False, False, fast[:-2]]
                nf5 = np.zeros(n)
                for j in range(3, 8): nf5 += np.r_[np.zeros(j, bool), fast[:-j]]
                move = np.full(n, np.nan); move[3:] = cx[3:] - cx[:-3]; moved = ~np.isnan(move) & (np.abs(move) >= F['etr']) & (move != 0)
                bursts = f3 & ~np.r_[False, f3[:-1]] & (nf5 <= 2) & moved                                              # A1: the burst MUST have moved price
                ag = np.where(dd > 0, cont['ask10'] - cont['bid10'], cont['bid10'] - cont['ask10']); tot = cont['ask10'] + cont['bid10']; skew = ag / np.where(tot > 0, tot, np.nan)   # + = more depth AHEAD of the push
                flat_rth = int(np.where(en <= close - 300.0)[0].max()); flat_gbx = int(np.where(en <= 55790.0)[0].max())
                def f30(a, flat): return None if a + 1 > flat else (c[min(a + 30, flat)] - o[a + 1])
                def extras(a, flat, dr, key):
                    e = a + 1; seg = slice(e, min(a + 30, flat) + 1); en_t = en[a] + 300.0; j = min(n0 + int(np.searchsorted(en[n0:], en_t)), flat)      # search the CURRENT session only: the continuous end-time array is not monotonic across the reset
                    mfe = (h[seg].max() - o[e]) if dr == 1 else (o[e] - l[seg].min()); mae = (o[e] - l[seg].min()) if dr == 1 else (h[seg].max() - o[e])
                    rec[key + '|mfe'].append((d, float(mfe))); rec[key + '|mae'].append((d, float(mae))); rec[key + '|h300'].append((d, float(dr * (c[j] - o[e]))))
                hs = hour_range_struct(hist['RTH'][-Fm.K_PRIOR:])
                E0 = on0 & rth_w; TC = ontc & rth_w; FULL = TC & F['user_fast'] & flow
                for fam, m in (('E0', E0), ('FULL', FULL)):
                    lock = -1
                    for a in np.where(m)[0]:
                        dr = int(dd[a]); r = f30(a, flat_rth)
                        if r is None: continue
                        rec[fam + '|f30'].append((d, dr * r)); extras(a, flat_rth, dr, fam)
                        if fam == 'E0': rec['E0s|f30'].append((d, dr * r, float(skew[a]) if not np.isnan(skew[a]) else np.nan))
                        if a + 1 > lock:
                            wo = float(l[max(n0, a - 3):a + 1].min()) if dr == 1 else float(h[max(n0, a - 3):a + 1].max()); ex = trade_exit(P, F, a, a + 1, dr, flat_rth, ema20, wo, F['rs'][a], cx)
                            if ex is not None: lock = ex[0]; rec[fam + '|net'].append((d, dr * (ex[1] - o[a + 1]) - COST)); rec[fam + '|why'].append(ex[2])
                for a in np.where(rth_w & bursts)[0]:
                    r = f30(a, flat_rth)
                    if r is None: continue
                    dr = int(np.sign(move[a])); rec['BTHIN|f30' if zr[a] > 1.0 else ('BTHICK|f30' if zr[a] <= 0 else 'BMID|f30')].append((d, dr * r))
                G0 = on0 & gbx_w; GT = ontc & gbx_w                                                                     # A3: Globex incl. the 18:00 reopen
                for fam, m in (('G0', G0), ('GT', GT)):
                    for a in np.where(m)[0]:
                        r = f30(a, flat_gbx)
                        if r is None: continue
                        dr = int(dd[a]); rec[fam + '|f30'].append((d, dr * r)); extras(a, flat_gbx, dr, fam)
                        if fam == 'GT' and en[a] < 5400.0: rec['GTreopen|f30'].append((d, dr * r))
                def find_b(a, dr):
                    for t in range(a + 1, min(a + 4, flat_rth) + 1):
                        if dr * (c[t] - c[t - 1]) < 0 or (not np.isnan(z[t]) and dr * z[t] <= 1.8): return t
                    return None
                def fade_at(a):
                    dr = int(dd[a]); b = find_b(a, dr)
                    if b is None: return None
                    ext = float(h[max(n0, a - 3):b + 1].max()) if dr == 1 else float(l[max(n0, a - 3):b + 1].min()); ex = fade_exit(P, F, a, b, dr, flat_rth, ext)
                    return None if ex is None else (ex, ex[2] * (ex[1] - ex[3]) - COST, b + 1)
                lock0 = lock1 = -1; win_idx = np.where(rth_w & ~np.isnan(z) & (dd != 0))[0]
                for a in np.where(E0)[0]:
                    f = fade_at(a)
                    if f is None: continue
                    ex, pnl, e = f; cdf = cdf_at(hs, int(Fm.hour_et(np.array([en[a]]))[0]), h[a] - l[a]) if hs else np.nan
                    cond = (zr[a] < -1.0) or (not np.isnan(cdf) and cdf >= 0.8)
                    if e > lock0: lock0 = ex[0]; rec['F0|net'].append((d, pnl))
                    if cond and e > lock1:
                        lock1 = ex[0]; rec['F1|net'].append((d, pnl)); hr = int(Fm.hour_et(np.array([en[a]]))[0]); pool = [x for x in win_idx if int(Fm.hour_et(np.array([en[x]]))[0]) == hr and x != a]
                        got = []
                        for x in rng.permutation(pool)[:12]:
                            g = fade_at(int(x))
                            if g is not None: got.append(g[1])
                            if len(got) >= 3: break
                        if got: rec['FC|net'].append((d, float(np.mean(got))))                                           # matched random-bar fade: same session, same clock hour, same entry/exit rules
        for name, T in tsp.items(): hist[name].append(T)
        prevS = S; prevd = d
    if skipped: print('WARNING: sessions skipped (depth cache not aligned with the bar file):', skipped)
    return rec, nsess

def dstats(l):
    o = collections.defaultdict(lambda: [0.0, 0])
    for x in l: o[x[0]][0] += x[1]; o[x[0]][1] += 1
    return o
def diff(a, b, seed):
    da, db = dstats(a), dstats(b); ds = sorted(set(da) | set(db))
    if not a or not b: return None
    A = np.array([da.get(x, [0.0, 0]) for x in ds]); Bm = np.array([db.get(x, [0.0, 0]) for x in ds]); n = len(ds)
    pt = A[:, 0].sum() / A[:, 1].sum() - Bm[:, 0].sum() / Bm[:, 1].sum(); rng = np.random.default_rng(seed); out = []
    for _ in range(B):
        i = rng.integers(0, n, n); sa, na, sb, nb = A[i, 0].sum(), A[i, 1].sum(), Bm[i, 0].sum(), Bm[i, 1].sum()
        if na and nb: out.append(sa / na - sb / nb)
    out = np.array(out); return pt, float(np.quantile(out, .025)), float(np.quantile(out, .975)), float((1 + (out <= 0).sum()) / (len(out) + 1))
def mean_ci(l, seed):
    d = dstats(l); ds = sorted(d)
    if not ds: return None
    A = np.array([d[x] for x in ds]); rng = np.random.default_rng(seed); n = len(ds); ms = []
    for _ in range(B):
        i = rng.integers(0, n, n); s, m = A[i, 0].sum(), A[i, 1].sum()
        if m: ms.append(s / m)
    return A[:, 0].sum() / A[:, 1].sum(), float(np.quantile(ms, .025)), float(np.quantile(ms, .975)), int(A[:, 1].sum()), n
def halves(l):
    ds = sorted({x[0] for x in l}); h = set(ds[:len(ds) // 2]); a = [x[1] for x in l if x[0] in h]; b = [x[1] for x in l if x[0] not in h]
    return (float(np.mean(a)) if a else float('nan'), float(np.mean(b)) if b else float('nan'))
def dist(l):
    v = np.array([x[1] for x in l]); w = v[v > 0].sum(); lo = -v[v < 0].sum()
    return f'N {len(v)} mean {v.mean():+.2f} median {np.median(v):+.2f} win {np.mean(v > 0):.2f} PF {w / lo if lo else float("inf"):.2f} p90 {np.quantile(v, .9):+.1f} p95 {np.quantile(v, .95):+.1f}'

if __name__ == '__main__':
    rec, nsess = main()
    print(f'CORRECTED real-depth run (A4). explore sessions scored {nsess} ({LO}..{HI}); continuation = signed 30-bar change from Open[t+1] (pt); trades net of {COST} pt.')
    for g in ('E0', 'FULL', 'BTHIN', 'BMID', 'BTHICK', 'G0', 'GT', 'GTreopen'):
        m = mean_ci(rec[g + '|f30'], 3)
        if m: h1, h2 = halves(rec[g + '|f30']); print(f'  {g:8s} N {m[3]:5d} days {m[4]:3d} mean {m[0]:+6.2f} [{m[1]:+.2f}, {m[2]:+.2f}] halves {h1:+.2f} / {h2:+.2f}')
    for g in ('E0', 'FULL', 'F0', 'F1', 'FC'):
        if rec[g + '|net']: print(f'  TRADES {g:4s}: {dist(rec[g + "|net"])}' + (f'  exits {dict(collections.Counter(rec[g + "|why"]))}' if rec.get(g + '|why') else ''))
    ez = [x for x in rec['E0s|f30'] if not np.isnan(x[2])]; thin_ahead = []; thick_ahead = []; seen = []
    for x in ez:                                                                                            # chronological; cutoffs from PAST events only (no whole-sample quantiles)
        if len(seen) >= 100:
            lo_q, hi_q = np.quantile(seen, .2), np.quantile(seen, .8)
            if x[2] <= lo_q: thin_ahead.append((x[0], x[1]))
            elif x[2] >= hi_q: thick_ahead.append((x[0], x[1]))
        seen.append(x[2])
    T = [('A1 burst(moved) thin book - thick book', rec['BTHIN|f30'], rec['BTHICK|f30']), ('A2 FULL rule net - E0 net (corrected exits)', rec['FULL|net'], rec['E0|net']), ('A3 Globex thrust - Globex E0 (real Ratio, incl. reopen)', rec['GT|f30'], rec['G0|f30']),
         ('A4 thin-ahead quintile - thick-ahead quintile (L10 skew, expanding cutoffs)', thin_ahead, thick_ahead), ('A5 conditioned fade net - matched random-bar fade net', rec['F1|net'], rec['FC|net'])]
    for g in ('E0', 'FULL', 'G0', 'GT'):
        if rec[g + '|mfe']: print(f'  DESCRIPTIVE {g}: mean MFE30 {np.mean([x[1] for x in rec[g + "|mfe"]]):+.1f}  mean MAE30 {np.mean([x[1] for x in rec[g + "|mae"]]):+.1f}  mean 300 s continuation {np.mean([x[1] for x in rec[g + "|h300"]]):+.2f}')
    res = []; pv = []
    for i, (name, a, b) in enumerate(T):
        r = diff(a, b, 950 + i)
        if r is None: print(f'  {name}: not enough'); continue
        res.append((name, r)); pv.append((r[3], len(res) - 1)); print(f'  {name}: diff {r[0]:+.2f} pt [{r[1]:+.2f}, {r[2]:+.2f}] one-sided p {r[3]:.4f} (N {len(a)} vs {len(b)})')
    for g in ('F1', 'FC', 'F0'):
        if rec[g + '|net']:
            m = mean_ci(rec[g + '|net'], 77); m3 = mean_ci([(x[0], x[1] - 1.0) for x in rec[g + '|net']], 78); print(f'  FADE {g} net mean {m[0]:+.2f} [{m[1]:+.2f}, {m[2]:+.2f}] (N {m[3]}, days {m[4]}); at 3.0 pt cost {m3[0]:+.2f} [{m3[1]:+.2f}, {m3[2]:+.2f}]')
    order = sorted(pv); m = len(order); keep = set()
    for rank, (p, idx) in enumerate(order):
        if p <= 0.10 / (m - rank): keep.add(idx)
        else: break
    print(f'Holm 0.10 over {m} tests: survivors: ' + (', '.join(res[i][0] for i in sorted(keep)) or 'none'))
    json.dump([dict(test=n, diff=r[0], lo=r[1], hi=r[2], p=r[3], holm=i in keep) for i, (n, r) in enumerate(res)], open(os.path.join(v2.OUT, 'depth_tell2_summary.json'), 'w'), indent=1)
