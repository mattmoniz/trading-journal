#!/bin/bash
cd /home/mmoniz/trading-journal && /usr/bin/node scripts/backtest_confluence.js
# Confluence+exhaustion interaction monitor — depends on this run's fresh VALIDATED_PAIR
# rows, so it must run right after, not on its own separate schedule. See
# scripts/backtest_confluence_exhaustion_interaction.mjs and RESEARCH_CLAIM
# confluence_exhaustion_interaction (docs/OPEN_THREADS.md 2026-07-23).
/usr/bin/node scripts/backtest_confluence_exhaustion_interaction.mjs
# Globex/overnight counterpart -- writes CONFLUENCE_AUDIT_OVERNIGHT VALIDATED_PAIR rows
# that detectGlobexSetup() (server/routes/acd.js) reads live for its sizeMultiplier
# bonus. Independent of the RTH run above (backtest_confluence_exhaustion_interaction.mjs
# only reads CONFLUENCE_AUDIT, not _OVERNIGHT), so ordering doesn't matter -- appended
# last. Added 2026-08-19, resolves OPEN_DECISION confluence_globex_calibration_never_scheduled
# (this script had never been on any schedule since it was built 2026-07-22, ~4wk stale
# as a live sizing input).
/usr/bin/node scripts/backtest_confluence_globex.js
