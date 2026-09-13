# Placebo Test: Is the No-Timeout Edge Real or Geometric?

Population: GLOBEX, minLevels>=3, streak>=2, HIGH_VOL, stop=1.5x ATR, target=0.5x ATR, no time cap. N=929.

**Analytic driftless-random-walk baseline WR** (gambler's ruin: farDist/(near+far)): **75.0%**

| | N | WR | EV |
|---|---|---|---|
| REAL direction | 929 | 82.2% | $115.48 |
| PLACEBO (random direction) | 928 | 81.5% | $95.76 |

If PLACEBO WR is close to REAL WR (and both close to the 75.0% analytic baseline), the apparent edge is overwhelmingly geometric (asymmetric barrier distance + no time limit), not a real directional signal.