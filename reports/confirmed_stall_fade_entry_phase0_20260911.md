# Confirmed-Stall Fade Entry — Phase 0, All Levels

Tests: does waiting for a stall (4-bar quiet range, live p10 threshold=0.0665x ATR) to form at a level, then entering only once price breaks through that stall's own extreme in the fade direction, beat (a) immediate entry at first touch and (b) a blind time-delay control (same avg delay, no logic)? Mean forward move in the fade direction / ATR at +240min, same population (touches that produced a confirmed stall+break) for all 3 arms.

| Level | Dir | Touches | Confirmed | AvgDelay(min) | IMMEDIATE | STALL_CONFIRMED | BLIND_DELAY | Beats Both? | Clust% |
|---|---|---|---|---|---|---|---|---|---|
| CAM_R3 | SHORT | 127 | 35 | 170 | -0.106 | 0.078 | 0.083 | no | 14% |
| PD_POC | SHORT | 126 | 32 | 181 | 0.011 | 0.185 | 0.158 | YES | 16% |
| PD_CLOSE | SHORT | 136 | 37 | 185 | -0.040 | 0.133 | 0.140 | no | 14% |
| PD_OR_MID | SHORT | 112 | 33 | 198 | -0.087 | 0.065 | 0.058 | YES | 15% |
| PD_IB_MID | SHORT | 110 | 29 | 192 | -0.055 | 0.091 | 0.050 | YES | 17% |
| PD_SESSION_MID | SHORT | 123 | 33 | 192 | -0.021 | 0.124 | 0.167 | no | 15% |
| CAM_R4 | SHORT | 107 | 30 | 155 | -0.021 | 0.115 | 0.199 | no | 17% |
| RTH_VWAP | SHORT | 221 | 55 | 184 | -0.026 | 0.107 | 0.111 | no | 9% |
| 5D_OR_MID | SHORT | 73 | 19 | 168 | -0.138 | -0.007 | 0.029 | no | 26% |
| DAILY_OPEN | SHORT | 212 | 42 | 180 | -0.070 | 0.055 | 0.065 | no | 12% |
| WEEKLY_VWAP | SHORT | 166 | 39 | 175 | -0.038 | 0.082 | 0.100 | no | 13% |
| FLOOR_PIVOT | SHORT | 126 | 34 | 193 | -0.036 | 0.075 | 0.136 | no | 15% |
| CAM_R1 | SHORT | 133 | 31 | 177 | -0.054 | 0.049 | 0.039 | YES | 16% |
| OR5_MID | SHORT | 186 | 35 | 177 | -0.062 | 0.036 | 0.065 | no | 14% |
| ONH | SHORT | 142 | 41 | 149 | -0.060 | 0.036 | 0.024 | YES | 12% |
| WEEKLY_OPEN | SHORT | 85 | 20 | 172 | -0.163 | -0.071 | -0.036 | no | 25% |
| PD_HIGH | SHORT | 115 | 28 | 153 | -0.005 | 0.085 | 0.095 | no | 18% |
| FLOOR_R1 | SHORT | 113 | 32 | 158 | -0.042 | 0.047 | 0.031 | YES | 16% |
| OR5_HIGH | SHORT | 169 | 36 | 170 | -0.073 | 0.008 | -0.005 | YES | 14% |
| CAM_R2 | SHORT | 136 | 32 | 161 | -0.061 | 0.009 | 0.030 | no | 16% |
| PD_IB_HIGH | SHORT | 113 | 33 | 169 | 0.042 | 0.112 | 0.136 | no | 15% |
| MONTHLY_VWAP | SHORT | 97 | 23 | 168 | -0.048 | 0.017 | 0.054 | no | 22% |
| PD_VAH | SHORT | 138 | 39 | 170 | 0.042 | 0.099 | 0.122 | no | 13% |
| PW_VAH | SHORT | 66 | 22 | 138 | -0.097 | -0.044 | -0.087 | YES | 23% |
| FLOOR_R2 | SHORT | 58 | 28 | 148 | -0.095 | -0.061 | -0.013 | no | 18% |
| IB_HIGH | SHORT | 142 | 60 | 167 | -0.009 | 0.020 | 0.043 | no | 8% |
| PW_HIGH | SHORT | 50 | 18 | 153 | -0.066 | -0.086 | -0.044 | no | 28% |
| OR5_LOW | LONG | 186 | 41 | 205 | 0.131 | 0.035 | 0.072 | no | 12% |
| 5D_OR_MID | LONG | 73 | 17 | 182 | 0.101 | -0.002 | 0.060 | no | 29% |
| WR1 | SHORT | 43 | 15 | 128 | 0.310 | 0.171 | 0.216 | no | 33% |
| WPP | LONG | 77 | 15 | 156 | 0.279 | 0.135 | 0.145 | no | 33% |
| OR5_MID | LONG | 186 | 36 | 189 | 0.135 | -0.015 | 0.040 | no | 14% |
| IB_LOW | LONG | 125 | 45 | 165 | 0.012 | -0.141 | -0.117 | no | 11% |
| PD_IB_LOW | LONG | 97 | 26 | 185 | 0.268 | 0.103 | -0.051 | no | 19% |
| RTH_VWAP | LONG | 221 | 62 | 183 | 0.074 | -0.097 | -0.048 | no | 8% |
| FLOOR_PIVOT | LONG | 126 | 43 | 192 | 0.105 | -0.070 | -0.032 | no | 12% |
| CAM_S3 | LONG | 123 | 29 | 200 | 0.057 | -0.121 | -0.044 | no | 17% |
| WEEKLY_VWAP | LONG | 166 | 46 | 188 | 0.040 | -0.139 | -0.027 | no | 11% |
| PD_IB_MID | LONG | 110 | 32 | 204 | 0.163 | -0.019 | 0.062 | no | 16% |
| WEEKLY_OPEN | LONG | 85 | 23 | 182 | 0.347 | 0.164 | 0.177 | no | 22% |
| DAILY_OPEN | LONG | 212 | 46 | 202 | 0.134 | -0.049 | -0.026 | no | 11% |
| MONTHLY_VWAP | LONG | 97 | 27 | 164 | 0.159 | -0.032 | 0.012 | no | 19% |
| PD_OR_MID | LONG | 112 | 35 | 199 | 0.162 | -0.035 | 0.048 | no | 14% |
| PD_POC | LONG | 126 | 38 | 212 | 0.070 | -0.146 | -0.084 | no | 13% |
| PD_SESSION_MID | LONG | 123 | 40 | 196 | 0.104 | -0.118 | -0.065 | no | 13% |
| ONL | LONG | 145 | 34 | 195 | 0.116 | -0.120 | -0.117 | no | 15% |
| PD_CLOSE | LONG | 136 | 47 | 194 | 0.141 | -0.103 | -0.049 | no | 11% |
| CAM_S2 | LONG | 132 | 33 | 208 | 0.098 | -0.160 | -0.107 | no | 15% |
| PD_VAL | LONG | 119 | 28 | 201 | 0.106 | -0.166 | -0.026 | no | 18% |
| PD_LOW | LONG | 87 | 16 | 184 | 0.410 | 0.096 | -0.007 | no | 31% |
| CAM_S1 | LONG | 136 | 41 | 205 | 0.189 | -0.132 | -0.082 | no | 12% |

**8 of 51 pairs: STALL_CONFIRMED beats both alternatives.**