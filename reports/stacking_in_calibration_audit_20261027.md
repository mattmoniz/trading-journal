# Stacking audit -- REAL rows 8440 (247 setup types); within-setup Mode 1 keeps 7618 (9.7% removed); rows with an unknown direction are kept as-is: 0

A. Per-setup stat gate (>=5 distinct real days): 177 setup types tested on the raw rows; SUPPRESS on raw 5, SUPPRESS after dedup 5; decision flips 0; types that fall below 5 days after dedup 0; types whose real N drops by more than 10% 57; median real N change 0.958 of raw.
| Setup type | Raw N / EV / CI upper / clustered / SUPPRESS | Dedup N / EV / CI upper / clustered / SUPPRESS |
|---|---|---|
| IB_BEARISH | 148 / -6.80 / 4.30 / true / false | 93 / -12.73 / -0.83 / true / false |
| GLOBEX_VWAP_MAGNET_LONG | 174 / -4.59 / 6.02 / true / false | 135 / -5.78 / 6.33 / true / false |
| VWAP_MAGNET_LONG | 91 / -0.19 / 19.17 / true / false | 61 / -0.93 / 19.81 / true / false |
| IB_BULLISH | 76 / 10.79 / 29.46 / true / false | 47 / 12.04 / 40.13 / true / false |
| RTH_VWAP_FADE_SHORT | 124 / -13.76 / 10.26 / false / false | 95 / -17.87 / 2.92 / false / false |
| GLOBEX_VWAP_MAGNET_SHORT | 114 / -1.93 / 17.73 / true / false | 87 / 1.60 / 23.48 / true / false |
| RTH_VWAP_FADE_LONG | 143 / -6.32 / 3.14 / false / false | 117 / -7.82 / 2.58 / false / false |
| FAILED_AUCTION_LONG | 123 / 1.90 / 13.85 / true / false | 102 / 1.24 / 14.74 / true / false |
(no decision flips; the table lists the 8 types that lose the most rows to dedup)
Real EV: raw vs dedup, mean absolute change over tested types 2.45 dollars; sign changes 7; CI-upper moves across zero 4.
Types whose CI upper bound crosses zero after dedup (the decision stays because of the clustering guard, or the type is manually suppressed):
| Setup type | Raw: N / CI upper / clustered | Dedup: N / CI upper / clustered |
|---|---|---|
| 10D_IB_MID_FADE_SHORT | 25 / 4.36 / true | 21 / -3.33 / true |
| IB_BEARISH | 148 / 4.30 / true | 93 / -0.83 / true |
| MONTHLY_VWAP_FADE_SHORT | 32 / -6.80 / true | 17 / 13.11 / true |
| CAM_R3_FADE_LONG | 32 / 3.39 / true | 30 / -0.81 / true |

B. bet_class VALUE_FADE override (POOLED_TRADE_FILTER, trigger = N >= 200 and EV < 0):
| Population | N | EV per trade | Override triggers? |
|---|---|---|---|
| raw pooled rows | 3782 | -1.06 | true |
| within-setup Mode 1 | 3607 | -0.85 | true |
| Mode 1 across all VALUE_FADE rows (one open trade per direction per day) | 1995 | -1.77 | true |

C. Context: raw REAL rows 8440; within-setup stacking 822; the larger cross-setup stacking (several setup types firing on one touch, the 43 percent seen on ACTIVE rows) is deliberate real-N credit and is not removed by within-setup Mode 1.
