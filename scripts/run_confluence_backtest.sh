#!/bin/bash
cd /home/mmoniz/trading-journal && /usr/bin/node scripts/backtest_confluence.js
# Confluence+exhaustion interaction monitor — depends on this run's fresh VALIDATED_PAIR
# rows, so it must run right after, not on its own separate schedule. See
# scripts/backtest_confluence_exhaustion_interaction.mjs and RESEARCH_CLAIM
# confluence_exhaustion_interaction (docs/OPEN_THREADS.md 2026-07-23).
/usr/bin/node scripts/backtest_confluence_exhaustion_interaction.mjs
