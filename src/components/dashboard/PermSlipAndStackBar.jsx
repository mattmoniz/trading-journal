import React, { useState } from 'react';
import { useSharedPollData } from '../../utils/useSharedPollData';
import { useViewActive } from '../../utils/useViewActive.js';
import { SETUP_DISPLAY_LABELS } from '../../constants/setupDisplay.js';

import { API_URL } from '../../constants/api.js';
const MAX_STACK = 7;

function barColor(n) {
  return n >= MAX_STACK ? '#ef4444' : n >= 4 ? '#f97316' : '#4ade80';
}

function StackBreakdownModal({ longEntries, shortEntries, onClose }) {
  const Column = ({ label, color, entries }) => (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color, letterSpacing: '0.07em', marginBottom: 8 }}>
        {label} · {entries.length}
      </div>
      {entries.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>None</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map((s, i) => (
          <div key={i} style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.5)', border: '1px solid rgba(51,65,85,0.5)', borderRadius: 5 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>{SETUP_DISPLAY_LABELS[s.setup_type] || s.setup_type}</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{s.status}{s.resolution ? ` · ${s.resolution}` : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0f172a', border: '1.5px solid rgba(51,65,85,0.6)', borderRadius: 12, padding: '20px 24px', width: '100%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.85)', position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0', marginBottom: 4 }}>Fade Stacking Breakdown</div>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14, lineHeight: 1.5 }}>
          Every setup counted toward today's LONG/SHORT totals — includes both currently-active setups and setups already resolved/expired today (suppress-at-{MAX_STACK} counts direction-stacked risk across the whole session, not just what's open right now).
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <Column label="LONG" color="#4ade80" entries={longEntries} />
          <Column label="SHORT" color="#f87171" entries={shortEntries} />
        </div>
      </div>
    </div>
  );
}

export default function PermSlipAndStackBar() {
  // Shared with LivePlaybookCard/OvernightContextStrip/EdgeSectionsPanel — was 4
  // independent fetches of the same endpoint on every Morning Prep load, 2026-07-15.
  const isViewActive = useViewActive();
  const [edgesData] = useSharedPollData(isViewActive ? `${API_URL}/antigravity/edges-context` : null, 60000);
  const perms  = edgesData?.sessionPermissions || null;
  const setups = edgesData?.setups || null;

  // Shared with EdgeSectionsPanel/App.jsx's LiveSessionPanel — was 3 independent
  // fetches of the same endpoint on every Morning Prep load, found 2026-07-15.
  const [setupsTodayData] = useSharedPollData(isViewActive ? `${API_URL}/setups/today` : null, 60000);
  const resolved = Array.isArray(setupsTodayData?.setups)
    ? setupsTodayData.setups.filter(s => ['RESOLVED', 'EXPIRED'].includes(s.status))
    : [];

  const [showBreakdown, setShowBreakdown] = useState(false);

  const hasPerms = perms?.conditions?.length > 0;
  if (!hasPerms && !setups) return null;

  const activeList  = setups?.list || [];
  const longEntries  = [
    ...activeList.filter(s => s.direction === 'LONG'),
    ...resolved.filter(s => s.direction === 'LONG'  || s.setup_type?.endsWith('_LONG')),
  ];
  const shortEntries = [
    ...activeList.filter(s => s.direction === 'SHORT'),
    ...resolved.filter(s => s.direction === 'SHORT' || s.setup_type?.endsWith('_SHORT')),
  ];
  const longTotal   = longEntries.length;
  const shortTotal  = shortEntries.length;

  return (
    <div style={{
      display: 'flex', gap: 8, padding: '0 20px 6px',
      fontFamily: 'Arial, sans-serif', fontSize: 12,
    }}>

      {/* Permission Slip */}
      {hasPerms && (
        <div style={{
          flex: 1, padding: '6px 10px',
          background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)',
          borderRadius: 5,
        }}>
          <div style={{ fontSize: 11, color: '#6ee7b7', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
            Permission Slip
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {perms.conditions.map((c, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>{c.label}</span>
                <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: c.dir === 'LONG' ? '#22c55e' : '#ef4444' }}>{c.pct}%</span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>closes {c.dir} · N={c.n}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fade Stacking */}
      <div
        onClick={() => setShowBreakdown(true)}
        title="Click for a breakdown of which setups count toward these totals"
        style={{
          flex: 1, padding: '6px 10px', cursor: 'pointer',
          background: 'rgba(10,18,35,0.5)', border: '1px solid rgba(51,65,85,0.3)',
          borderRadius: 5,
        }}>
        <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
          Fade Stacking · suppress at {MAX_STACK}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[['LONG', longTotal], ['SHORT', shortTotal]].map(([label, count]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 11, color: '#94a3b8', width: 34, fontWeight: 700, letterSpacing: '0.06em' }}>{label}</span>
              <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(count / MAX_STACK * 100, 100)}%`, background: barColor(count), borderRadius: 3, transition: 'width 0.4s' }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: barColor(count), width: 14 }}>{count}</span>
              {count >= MAX_STACK && <span style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', letterSpacing: '0.07em' }}>SUPPRESS</span>}
            </div>
          ))}
        </div>
      </div>

      {showBreakdown && (
        <StackBreakdownModal longEntries={longEntries} shortEntries={shortEntries} onClose={() => setShowBreakdown(false)} />
      )}

    </div>
  );
}
