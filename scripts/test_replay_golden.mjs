// Golden detection replay test (Fable audit F27/F32, 2026-11-11): replays every recorded pass in scratch/replay_golden/ against the CURRENT route code and requires identical decisions
// (same writes, same response, no unrecorded read). Run before and after any change to the detection pass that is meant to change NO decision. A deliberate decision change shows up here as
// a diff by design: re-record afterwards (scripts/replay/record_schedule.sh). Env REPLAY_ROUTE replays against another copy of the route file (e.g. a pre-refactor snapshot).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = new URL('../scratch/replay_golden/', import.meta.url).pathname;
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
if (!files.length) { console.log('no recordings in scratch/replay_golden/: record some with scripts/replay/record_schedule.sh (skipped)'); process.exit(0); }
let bad = 0;
for (const f of files) {
  const args = ['scripts/replay/replay_pass.mjs', path.join(dir, f)];
  if (process.env.REPLAY_ROUTE) args.push('--route', process.env.REPLAY_ROUTE);
  const r = spawnSync('node', args, { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 180000 });
  const lines = (r.stdout || '').split('\n').filter((l) => l && !l.startsWith('✅'));
  console.log(r.status === 0 ? 'PASS' : 'FAIL', f, '-', (lines.find((l) => l.startsWith('replay ')) || r.stderr || '').slice(0, 200));
  if (r.status !== 0) { bad++; for (const l of lines.filter((l) => l.startsWith('  ')).slice(0, 8)) console.log('   ', l); }
}
console.log(`${files.length - bad} of ${files.length} recorded passes replay identically`);
process.exit(bad ? 1 : 0);
