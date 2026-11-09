// Historical replay of the symmetric day-state machine (server/services/dayState.js), workplan item F. OUTCOME-BLIND with respect to every trading setup: it reads only 1-minute
// bars and the sessions' own open/close to label how each flagged session ended. Prints: flag rates, warm-up, activation time on named days, and how flagged sessions ended.
import { query } from '../server/db.js';
// DS_MODULE=<absolute path> replays a STAGED copy of the module (used to test fixes before they are applied to server/).
const { buildSessions, evaluateDayStates, firstActive } = await import(process.env.DS_MODULE ? 'file://' + process.env.DS_MODULE : '../server/services/dayState.js');

const DAYS = ['2026-11-05', '2026-10-22', '2026-10-08', '2026-09-08', '2026-10-13'];
async function main() {
  const rows = (await query(`SELECT to_char(ts,'YYYY-MM-DD HH24:MI') AS t, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int AS mod, high::float AS high, low::float AS low, close::float AS close
    FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2023-01-01' AND ts < '2026-11-10' ORDER BY ts`)).rows;
  const sessions = buildSessions(rows);
  const Q = process.env.DS_Q ? Number(process.env.DS_Q) : undefined;
  const res = evaluateDayStates(sessions, { q: Q });
  console.log('cutoff quantile', Q ?? 'PARAMS.Q');
  console.log(`bars ${rows.length}, sessions ${sessions.length}`);
  for (const kind of ['RTH', 'GLOBEX']) {
    const rs = res.filter((r) => r.kind === kind && r.valid && r.cut), flagged = rs.filter((r) => firstActive(r));
    const dn = flagged.filter((r) => firstActive(r).state.startsWith('DOWN')), up = flagged.filter((r) => firstActive(r).state.startsWith('UP'));
    const months = new Set(rs.map((r) => r.key.slice(0, 7))).size;
    const endsLow = (r) => { const hi = Math.max(...r.bars.map((b) => b.high)), lo = Math.min(...r.bars.map((b) => b.low)), c = r.bars[r.bars.length - 1].close, o = r.bars[0].close; return { down: c < o && (c - lo) / (hi - lo) <= 0.25, up: c > o && (hi - c) / (hi - lo) <= 0.25, recovered: (c - lo) / (hi - lo) >= 0.5 }; };
    console.log(`\n${kind}: evaluated sessions ${rs.length} (${months} months); flagged ${flagged.length} (${(100 * flagged.length / rs.length).toFixed(1)}%, ${(flagged.length / months).toFixed(2)}/month): DOWN ${dn.length}, UP ${up.length}`);
    console.log(`  DOWN flagged: ended in the lowest quarter of the range below the open ${dn.filter((r) => endsLow(r).down).length}/${dn.length}; recovered to the upper half ${dn.filter((r) => endsLow(r).recovered).length}/${dn.length}`);
    console.log(`  UP flagged: ended in the highest quarter above the open ${up.filter((r) => endsLow(r).up).length}/${up.length}; (mirror) fell back to the lower half ${up.filter((r) => !endsLow(r).recovered).length}/${up.length}`);
    const byYear = {}; for (const r of flagged) byYear[r.key.slice(0, 4)] = (byYear[r.key.slice(0, 4)] || 0) + 1; console.log('  flagged per year: ' + JSON.stringify(byYear));
    console.log(`  states of the latest session ${rs[rs.length - 1]?.key}: ${[...new Set(rs[rs.length - 1]?.states)].join(',')}`);
  }
  console.log('\nNAMED DAYS (RTH): first non-NORMAL state / bar time / minute of session');
  for (const d of DAYS) { const r = res.find((x) => x.kind === 'RTH' && x.key === d); if (!r) { console.log(`  ${d} no RTH session`); continue; } const f = firstActive(r); console.log(`  ${d}: ${f ? `${f.state} at ${f.t.slice(11)} (active from the next minute)` : 'never flagged'}${r.cut ? '' : ' (warm-up)'}`); }
  const sun = res.filter((r) => r.kind === 'GLOBEX' && r.key === '2026-11-09'); if (sun.length) { const f = firstActive(sun[0]); console.log(`\nGLOBEX session ending 2026-11-09 (Sunday night): ${f ? `${f.state} at ${f.t}` : 'never flagged'}`); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
