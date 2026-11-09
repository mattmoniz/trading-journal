import React from 'react';

// The written next-step tree of one monitor (CLAUDE.md co-022): when it is judged, what follows if it holds, what follows if it fails.
// `n` comes from the `nextSteps` key of GET /api/setups/monitor-summary (server/services/monitorNextSteps.js); renders nothing when absent. `label` names the monitor when a card shows several.
const small = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5 };

export default function NextSteps({ n, label }) {
  if (!n) return null;
  return (
    <div style={{ ...small, marginTop: 8 }}>
      <div><b>Next{label ? ` (${label})` : ''}:</b> {n.review}</div>
      <div><b>If it holds:</b> {n.ifConfirmed}</div>
      <div><b>If it fails:</b> {n.ifFailed}</div>
    </div>
  );
}
