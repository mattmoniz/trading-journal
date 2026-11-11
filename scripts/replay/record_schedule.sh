#!/bin/bash
# Record detection passes at given HHMM times into scratch/replay_golden/ (one fresh process per pass; reads only, writes suppressed; see lib.mjs).
#   scripts/replay/record_schedule.sh 0940 1035 1135
cd "$(dirname "$0")/../.." || exit 1
for t in "$@"; do
  until [ "$(date +%H%M)" -ge "$t" ]; do sleep 20; done
  out="scratch/replay_golden/$(date +%Y%m%d)_${t}.json"
  node scripts/replay/record_pass.mjs "$out" --route "${REPLAY_ROUTE:-server/routes/acd.js}" 2>&1 | grep -v '^✅'
done
