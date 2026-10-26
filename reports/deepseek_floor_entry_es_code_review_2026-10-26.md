# Code review: floor_entry_es_agreement vs prereg (+ Amendment 1)

1. **Delay-matched control can sample the focal event's own delay.** `buildEvents` fills `pool` (line 63) from *all* fired events including the focal one, then line 71 draws `cand[Math.floor(rng()*cand.length)]` with no self-exclusion. When its own delay is drawn, the control entry equals the fire entry and `ex(e)=ret-ctl=0`, biasing E1a and the paired E1 toward zero. Fix: reject `d === B.EM[r.j]-B.EM[e.i]` (or exclude the focal entry from `cand`).

2. **E1 verdict omits the "both halves positive" gate.** The gated E1 (`summarizeSide` 96-98) computes only `seq`/`day` CIs, and `main` 134 gates E1 on `seq.lo>0 && day.lo>0`. Prereg line 24 requires both halves positive. Fix: compute chronological halves for the paired E1 (as for E2) and add `g.E1.halves.every(x=>x>0)` to the verdict.

3. **ES "missing >20% of minutes" drop not implemented.** `fire` only drops when the fire-bar ES minute is absent (`xi2===undefined`, line 37) or ES A15 is undefined; prereg line 11 requires dropping ES episodes missing >20% of minutes. Fix: in `fire`, count ES minutes present in `[e.i, j]` and return `{miss:true}` when `<80%`.

4. **`baselines()` not restricted to the event trade-date set.** Line 22 iterates all bars without excluding roll weeks / `SPARSE` / level-bearing days (prereg line 14 "same trade-date set"). Descriptive now, but biased. Fix: skip `isInsideNqRollWeek(TD[i]) || SPARSE(TD[i])` (or intersect with event days).

5. **`episodeEnd` returns bar count, `fire` compares W to elapsed minutes.** `episodeEnd` (line 26) returns `j-e.i` (index), but `fire` (line 31) tests `B.EM[j]-B.EM[e.i] <= W`. With missing bars these diverge, understating the median-duration part of W. Fix: return `B.EM[j]-B.EM[e.i]`.

6. **`fwd()` horizon off-by-one vs prereg; MFE/MAE window inconsistent.** Line 16 measures to `EM[i0]+h-1` (h-1 minutes) while prereg horizons are in minutes; `mfeMae` (line 17) spans 0..h-1 (h minutes). Fix: use `EM[i0]+h` and align `mfeMae`, or document (cancels in conditional-minus-baseline, but shifts descriptives/MFE).

7. **Strata terciles are in-sample.** Lines 79-80 compute turn/bars terciles over all fired rows (incl. hold-out), so a future event's turn size sets a past event's stratum; the cutpoints also include events later dropped for `ret[60]==null` (line 100). Fix: compute terciles on explore-period events only (or state full-sample terciles explicitly).

8. **`fire()` omits the POC/target resolution.** `findEvents` resets the sequence on `B.H[i]>=row.poc` (floorEngine 66), but `fire` never checks `e.poc`, so the "same episode/sequence" claim is not fully honored. Fix: add `if (B.H[j] >= e.poc) return null;` (low impact — the turn fires before POC).

Minor: `qnt`/`pct` use `floor(q*len)` (no interpolation); an empty `probe` yields `W=NaN` and every `fire()` returns null silently; `esMissing` mislabels "ES A15 undefined" as "minutes missing".
