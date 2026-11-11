// Records the 2026-11-10 night choices the user delegated ("i'll defer to you on these three for the best options for me").
import { resolveDecision } from './flag_decision.mjs';
async function main() {
  const r = await resolveDecision('tell_geometry_null_forward_edge_not_stored_20261110',
    'CHOSEN 2026-11-10 night (user delegated): option (b), recompute the range edge and the session bars for every live fire from the tick files with the SAME functions the research used (trade.boundary, tell_replay_lib), flagged in the output as a reconstruction. Option (a), persisting the edge in the sidecar at fire time, is added at the next planned sidecar restart as a cross-check, not now. The forward-read script itself is not built yet (first read at 150 fires of the explore rule bar_rule=split, book=V1; 69 on 2026-11-10); build it before the count reaches about 130.');
  console.log('resolved', r.slug);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
