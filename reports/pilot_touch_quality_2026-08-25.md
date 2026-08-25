**Execution mode: AUTONOMOUS. Do not pause, do not ask for confirmation. Execute all steps and write output when complete.**

## Touch-Quality Feature Extraction Pilot

**Idea 1/2/3 Anchor Check:** Skipped 171 trades (no static level anchor).
Setup types affected: OR5_HIGH_FADE_SHORT (anchor not yet formed), IB_HIGH_FADE_SHORT (anchor not yet formed), GLOBEX_VWAP_FADE_LONG, GLOBEX_VWAP_FADE_SHORT, OR5_MID_FADE_LONG (anchor not yet formed), OR5_MID_FADE_SHORT (anchor not yet formed), PD2_VAL_FADE_LONG, PD2_VAL_FADE_SHORT, IB_LOW_FADE_LONG (anchor not yet formed), OR5_LOW_FADE_LONG (anchor not yet formed), IB_MID_SCALP_FADE_LONG (anchor not yet formed), ZONE_EDGE_FADE, PD2_VAH_FADE_SHORT

### Quartile Analysis (Pooled N=959)

#### d_norm (N=788)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 197 | 0.000 | 0.428 | 51.3% | $-0.15 |
| Q2 | 197 | 0.432 | 1.130 | 52.3% | $-8.00 |
| Q3 | 197 | 1.133 | 20.338 | 52.8% | $6.05 |
| Q4 | 197 | 20.411 | 228.698 | 49.2% | $-0.81 |

#### depletion_frac (N=766)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 192 | 0.000 | 0.000 | 45.8% | $-6.29 |
| Q2 | 192 | 0.000 | 0.082 | 56.3% | $4.88 |
| Q3 | 192 | 0.082 | 0.285 | 54.7% | $1.17 |
| Q4 | 190 | 0.285 | 1.000 | 49.5% | $-1.02 |

#### adverseRunway (N=788)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 197 | 0.001 | 0.437 | 49.7% | $2.19 |
| Q2 | 197 | 0.438 | 1.119 | 52.8% | $0.05 |
| Q3 | 197 | 1.125 | 2.449 | 56.3% | $9.31 |
| Q4 | 197 | 2.474 | 32.478 | 46.7% | $-14.47 |

#### favorableRunway (N=788)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 197 | 0.014 | 0.561 | 51.3% | $-2.42 |
| Q2 | 197 | 0.565 | 1.185 | 48.2% | $-6.69 |
| Q3 | 197 | 1.196 | 2.226 | 52.3% | $2.80 |
| Q4 | 197 | 2.237 | 11.862 | 53.8% | $3.40 |

#### efficiency (N=959)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 240 | 0.000 | 0.171 | 49.6% | $2.14 |
| Q2 | 240 | 0.171 | 0.331 | 50.8% | $0.94 |
| Q3 | 240 | 0.333 | 0.540 | 55.0% | $5.19 |
| Q4 | 239 | 0.541 | 1.000 | 51.5% | $-4.89 |

#### overlapRatio (N=959)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 240 | 0.362 | 0.555 | 52.9% | $2.52 |
| Q2 | 240 | 0.555 | 0.606 | 53.3% | $5.95 |
| Q3 | 240 | 0.607 | 0.657 | 47.9% | $-6.56 |
| Q4 | 239 | 0.657 | 0.797 | 52.7% | $1.51 |

#### rangeVelocity (N=722)
| Quartile | N | Min | Max | WR% | EV$ |
|---|---|---|---|---|---|
| Q1 | 181 | 0.055 | 0.220 | 56.4% | $8.22 |
| Q2 | 181 | 0.220 | 0.352 | 50.8% | $-0.21 |
| Q3 | 181 | 0.353 | 0.533 | 44.8% | $-11.40 |
| Q4 | 179 | 0.535 | 1.000 | 55.9% | $9.79 |

#### isNewSessionExtreme
| Value | N | WR% | EV$ |
|---|---|---|---|
| True (Expansion touch) | 35 | 71.4% | $24.54 |
| False (Rotation touch) | 875 | 50.5% | $-0.99 |

### Correlation Matrix

| Feature | d_norm | depletion_frac | adverseRunway | favorableRunway | efficiency | overlapRatio | rangeVelocity |
|---|---|---|---|---|---|---|---|
| **d_norm** | 1.00 | -0.43 | 0.03 | 0.19 | -0.08 | 0.04 | -0.21 |
| **depletion_frac** | -0.43 | 1.00 | -0.14 | -0.18 | -0.21 | 0.06 | 0.27 |
| **adverseRunway** | 0.03 | -0.14 | 1.00 | 0.26 | 0.07 | 0.02 | -0.25 |
| **favorableRunway** | 0.19 | -0.18 | 0.26 | 1.00 | 0.06 | -0.02 | -0.36 |
| **efficiency** | -0.08 | -0.21 | 0.07 | 0.06 | 1.00 | -0.18 | 0.07 |
| **overlapRatio** | 0.04 | 0.06 | 0.02 | -0.02 | -0.18 | 1.00 | -0.10 |
| **rangeVelocity** | -0.21 | 0.27 | -0.25 | -0.36 | 0.07 | -0.10 | 1.00 |

**Flags:** No pairs exceeded |r| > 0.7 redundancy threshold.

### Conclusions

- **Idea 1 (Volatility-normalized proximity)**: DEAD (non-monotone, likely noise)
- **Idea 2 (Level liquidity depletion)**: DEAD (non-monotone, likely noise)
- **Idea 3 (Adverse Runway)**: DEAD (non-monotone, likely noise)
- **Idea 3 (Favorable Runway)**: DEAD (non-monotone, likely noise)
- **Idea 4 (Approach path geometry - Efficiency)**: DEAD (non-monotone, likely noise)
- **Idea 4 (Approach path geometry - Overlap Ratio)**: DEAD (non-monotone, likely noise)
- **Idea 6 (Range Velocity)**: DEAD (non-monotone, likely noise)

### Idea 6 Crux Control (Expansion vs Rotation by Family)

| Family | True N | True WR% | True EV$ | False N | False WR% | False EV$ |
|---|---|---|---|---|---|---|
| VALUE_NODES | 0 | 0.0% | $0.00 | 53 | 49.1% | $-17.19 |
| FLOOR_PIVOTS | 6 | 66.7% | $-4.33 | 100 | 53.0% | $1.85 |
| MORNING_EDGES | 19 | 78.9% | $47.11 | 285 | 51.9% | $3.14 |
| OTHER | 7 | 57.1% | $-2.57 | 181 | 42.5% | $-8.13 |
| PRIOR_DAY_EXTREMES | 1 | 100.0% | $82.00 | 58 | 51.7% | $9.95 |
| MATH_PIVOTS | 0 | 0.0% | $0.00 | 19 | 68.4% | $19.89 |
| PRIOR_DAY_VALUE | 2 | 50.0% | $-37.00 | 141 | 54.6% | $-0.05 |
| RANGE_EDGES | 0 | 0.0% | $0.00 | 25 | 52.0% | $-12.08 |
| TIME_OPENS | 0 | 0.0% | $0.00 | 10 | 40.0% | $-11.20 |
| VWAP | 0 | 0.0% | $0.00 | 3 | 33.3% | $-31.33 |

**Grouped by Structural Extremes:**
| Group | True N | True WR% | True EV$ | False N | False WR% | False EV$ |
|---|---|---|---|---|---|---|
| MORNING_EDGES & PRIOR_DAY_EXTREMES | 20 | 80.0% | $48.85 | 343 | 51.9% | $4.29 |
| All Other Families | 15 | 60.0% | $-7.87 | 532 | 49.6% | $-4.39 |

- **Idea 6 (Expansion vs Rotation boolean)**: DEAD. The pooled positive EV spread vanishes/reverses when conditioning on setup type/family. The signal was just rediscovering that some level types are definitionally session extremes.
