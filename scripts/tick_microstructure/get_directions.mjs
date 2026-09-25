// Small bridge so the Python tick pipeline can use the REAL, canonical inferDirection()
// (server/config/setupTypes.js) instead of reimplementing its LONG/SHORT/BULLISH/BEARISH
// regex logic in Python -- per this codebase's own "export the real function, never
// reimplement live-derived classification logic inline" rule. Reads setup_type strings
// (one per line) from stdin, writes {setup_type: 'LONG'|'SHORT'|null} JSON to stdout.
import { inferDirection } from '../../server/config/setupTypes.js';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin });
const out = {};
for await (const line of rl) {
  const t = line.trim();
  if (t) out[t] = inferDirection(t);
}
process.stdout.write(JSON.stringify(out));
