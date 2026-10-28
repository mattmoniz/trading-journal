import numpy as np
import tpo
def sess(spans):
    a = {k: np.full(390, 105.0) for k in 'hl'}
    for b, (lo, hi) in enumerate(spans): a['l'][b * 30:b * 30 + 30] = lo; a['h'][b * 30:b * 30 + 30] = hi
    return a
spans = [(98.0, 112.9)] + [(100.0, 110.9)] * 11 + [(99.0, 111.9)]
p = tpo.tpo_profile(sess(spans))
# rows: 98 ->1 (b0), 99 ->2, 100..110 -> 13, 111 -> 2, 112 -> 1 ; total 149; POC = row 105 (closest to the middle of 98..112); VA rows 101..109 (hand-derived)
assert p['total'] == 149 and p['poc'] == 105.0 and p['val'] == 101.0 and abs(p['vah'] - 109.75) < 1e-9, p
print('ok TPO POC and value area match the hand derivation')
q = tpo.tpo_profile(sess([(100.0, 100.9)] * 13)); assert q['val'] == 100.0 and abs(q['vah'] - 100.75) < 1e-9, q
print('ok single-row profile'); print('ALL TPO TESTS PASSED')
