import { flagDecision } from '../flag_decision.mjs';
await flagDecision({
  slug: 'amt_deepseek_critique_pending_20261028',
  decisionText: 'A DeepSeek critique of AMT options 1 and 3 (and S1) is QUEUED to run at 04:00 UTC (00:00 ET, off-peak) via a detached waiter (scratch/dispatch_deepseek_offpeak.sh, log scratch/dispatch_deepseek_offpeak.log, request scratch/claude_request_deepseek.md, response scratch/deepseek_response.md plus a dated copy scratch/deepseek_response_YYYYMMDD_HHMMSS.md). It asks for: code/definition bugs, design, what was missed, power, process, an honest verdict, and (the user explicit ask) a fidelity audit of every AMT test run so far plus a faithful, pre-registered AMT test program of at most 6 tests. If the process is missing (ps -eo pid,cmd | grep dispatch_deepseek_offpeak) and no dated response exists after 04:30 UTC, re-run ./scripts/invoke_deepseek.sh 25m during an off-peak window (04:00-06:00 or 10:00-01:00 UTC weekdays; DEEPSEEK_ALLOW_PEAK=1 only if the user says to pay surge). When the response lands: read it, audit its claims against the code before relaying (a DeepSeek file may have a huge trailing thinking-trace line; the real answer is earlier), report to the user, then resolve this decision. Waiting on: the clock, not the user.',
  sourceFile: 'scratch/claude_request_deepseek.md', sourceDate: '2026-10-28',
});
process.exit(0);
