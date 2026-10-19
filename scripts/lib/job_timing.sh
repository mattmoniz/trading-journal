#!/bin/bash
# Shared step timer for the scheduled calibration scripts (2026-10-19). `timed_step <job> <command...>` runs the command exactly as before, passes its
# exit code through, and afterwards records the step's duration in job_timings and compares it with that step's own earlier runs
# (scripts/record_job_timing.mjs). Recording can never fail or slow the job: its errors are swallowed.
timed_step() {
  local job="$1"; shift
  local step="" a
  for a in "$@"; do case "$a" in *.mjs|*.js|*.py|*.sh) step="$(basename "$a")"; break;; esac; done
  [ -z "$step" ] && step="$(basename "$1")"
  local t0=$(date +%s)
  "$@"
  local rc=$?
  local dur=$(( $(date +%s) - t0 ))
  /usr/bin/node scripts/record_job_timing.mjs "$job" "$step" "$dur" "$rc" >/dev/null 2>&1 || true
  return $rc
}
