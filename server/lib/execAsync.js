// Non-blocking replacement for child_process.execSync in the web process (Fable audit F03, 2026-11-10).
// execSync froze the Node event loop for the whole child run (loop.maxMs 18-60 s at 08:03, 09:33, 11:03,
// 16:11, 17:17 in perf_snapshots), delaying fill handling, the 15 s detection poll and the DTC heartbeat.
// Same contract as execSync for callers: resolves with stdout (string) or rejects with an Error whose
// message names the command and exit state; `timeout` kills the child (SIGTERM) and rejects.
import { exec } from 'child_process';

export function execAsync(cmd, { cwd = process.cwd(), timeout = 0, maxBuffer = 50 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (stderr) process.stderr.write(stderr);
      if (err) {
        const tail = String(stderr || '').trim().split('\n').slice(-3).join(' | ');
        const reason = err.killed ? `timed out after ${timeout} ms` : `exit ${err.code}${tail ? `: ${tail}` : ''}`;
        const e = new Error(`Command failed: ${cmd} (${reason})`);
        e.code = err.killed ? 'ETIMEDOUT' : err.code;
        e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}
