import React, { useState, useEffect } from 'react';

const API_URL = '/api';

const DIR_STYLE = {
  LONG:     { color: '#4ade80', bg: 'rgba(34,197,94,0.1)',   label: 'LONG'     },
  SHORT:    { color: '#f87171', bg: 'rgba(239,68,68,0.1)',   label: 'SHORT'    },
  CONTINUE: { color: '#a78bfa', bg: 'rgba(139,92,246,0.1)', label: 'CONTINUE' },
  REVERSE:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: 'REVERSE'  },
};

// ≥70%: full display with action note
// 65-69%: dimmed, "context" badge, no action note
// <65%: hidden
const STRONG_THRESHOLD = 70;
const CONTEXT_THRESHOLD = 65;

function DriftBadge({ drift, pct, pct_30d, n_30d, driftWarn }) {
  if (driftWarn) {
    return (
      <span style={{ fontSize: 10, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>
        ⚠ drift
      </span>
    );
  }
  if (drift == null || pct_30d == null) return null;
  const absDrift = Math.abs(drift);
  if (absDrift < 10) return null; // only show when significant

  const isDown = drift < 0;
  const color  = isDown ? '#f87171' : '#4ade80';
  const bg     = isDown ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)';
  return (
    <span title={`Last 30 days: ${pct_30d}% (N=${n_30d}) vs ${pct}% historical`}
      style={{ fontSize: 10, color, background: bg, padding: '1px 5px', borderRadius: 3, fontWeight: 600, cursor: 'default' }}>
      {isDown ? '↓' : '↑'}{absDrift}% recently
    </span>
  );
}

export default function SessionBiasPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = () =>
      fetch(`${API_URL}/antigravity/edges-context`)
        .then(r => r.json())
        .then(d => setData(d))
        .catch(() => {});
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, []);

  const bias = data?.sessionBias;
  const perms = data?.sessionPermissions?.conditions;

  const visibleBias = bias?.filter(s => s.pct >= CONTEXT_THRESHOLD) ?? [];
  if (!visibleBias.length && !perms?.length) return null;

  return (
    <div style={{
      padding: '10px 12px',
      background: 'rgba(15,23,42,0.5)',
      border: '1px solid rgba(51,65,85,0.4)',
      borderRadius: 6,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#818cf8',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
      }}>
        Session Signals
      </div>

      {/* Session bias stats */}
      {visibleBias.map((s, i) => {
        const ds = DIR_STYLE[s.dir] || DIR_STYLE.LONG;
        const isStrong  = s.pct >= STRONG_THRESHOLD;
        const isContext = !isStrong;
        const pctDisplay = `${s.pct}% ${ds.label}`;
        return (
          <div key={i} style={{
            padding: '5px 0',
            borderBottom: i < visibleBias.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
            opacity: isContext ? 0.55 : 1,
          }}>
            {/* Row 1: label + badges + pct */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#cbd5e1', flex: 1, minWidth: 0 }}>{s.label}</span>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
                {isContext && (
                  <span style={{ fontSize: 10, color: '#64748b', background: 'rgba(100,116,139,0.15)', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>
                    context
                  </span>
                )}
                {s.computed && (
                  <span style={{ fontSize: 10, color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>
                    live
                  </span>
                )}
                <DriftBadge drift={s.drift} pct={s.pct} pct_30d={s.pct_30d} n_30d={s.n_30d} driftWarn={s.driftWarn} />
                <span style={{
                  fontSize: 12, fontWeight: 700, color: ds.color,
                  background: ds.bg, padding: '1px 6px', borderRadius: 4,
                }}>
                  {pctDisplay}
                </span>
                <span style={{ fontSize: 11, color: '#475569' }}>N={s.n}</span>
              </div>
            </div>
            {/* Row 2: drift detail line */}
            {isStrong && s.drift != null && Math.abs(s.drift) >= 10 && s.pct_30d != null && (
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1, paddingLeft: 1 }}>
                Recent 30 days: {s.pct_30d}% (N={s.n_30d}) vs {s.pct}% historical
              </div>
            )}
            {/* Row 3: action note */}
            {isStrong && s.action && (
              <div style={{ fontSize: 11, color: s.driftWarn ? '#fbbf24' : '#64748b', marginTop: 2, paddingLeft: 1, lineHeight: 1.4 }}>
                → {s.action}
              </div>
            )}
          </div>
        );
      })}

      {/* ACD permission slip stats */}
      {perms?.length > 0 && (
        <>
          {visibleBias.length > 0 && (
            <div style={{ height: 1, background: 'rgba(51,65,85,0.5)', margin: '6px 0' }} />
          )}
          {perms.map((p, i) => {
            const ds = DIR_STYLE[p.dir] || DIR_STYLE.LONG;
            return (
              <div key={i} style={{
                padding: '4px 0',
                borderBottom: i < perms.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#cbd5e1' }}>{p.label}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{
                      fontSize: 12, fontWeight: 700, color: ds.color,
                      background: ds.bg, padding: '1px 6px', borderRadius: 4,
                    }}>
                      {p.pct}% {ds.label}
                    </span>
                    <span style={{ fontSize: 11, color: '#475569' }}>N={p.n}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
