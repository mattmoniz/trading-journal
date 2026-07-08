#!/bin/bash
cd /home/mmoniz/trading-journal && /usr/bin/node scripts/mine_session_bias.mjs && /usr/bin/node scripts/backtest_level_patterns.mjs && /usr/bin/node scripts/mine_tod_patterns.mjs && /usr/bin/node scripts/mine_behavioral_patterns.mjs
