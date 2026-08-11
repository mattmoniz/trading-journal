import React, { useEffect, useState } from 'react';
import CaptureRatioPanel from './CaptureRatioPanel';

const S = {
  page: { padding: '24px 28px', maxWidth: 1200, margin: 0, color: '#e2e8f0', fontFamily: 'inherit' },
  h1: { fontSize: 24, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 },
  sub: { fontSize: 14, color: '#94a3b8', marginBottom: 28 },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12, borderBottom: '1px solid #1e293b', paddingBottom: 6 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 },
  card: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  cardTitle: { fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 },
  cardVal: { fontSize: 22, fontWeight: 700, color: '#f1f5f9' },
  cardSub: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  row: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  label: { fontSize: 13, color: '#94a3b8', minWidth: 160 },
  val: { fontSize: 13, fontWeight: 600, color: '#f1f5f9' },
  badge: (color, bg) => ({ fontSize: 11, fontWeight: 700, color, background: bg, border: `1px solid ${color}40`, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.05em', whiteSpace: 'nowrap' }),
  pill: (color) => ({ display: 'inline-block', fontSize: 12, fontWeight: 600, color, background: color + '18', borderRadius: 4, padding: '2px 8px', marginRight: 4, marginBottom: 4 }),
  factorCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
  factorName: { fontSize: 13, fontWeight: 700, color: '#e2e8f0' },
  factorEffect: { fontSize: 12, color: '#94a3b8' },
  factorStat: { fontSize: 12, fontWeight: 600 },
  suppressed: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#94a3b8', marginBottom: 4 },
  toolCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  toolTitle: { fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 },
  toolDesc: { fontSize: 13, color: '#94a3b8', lineHeight: 1.6 },
  todo: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, fontSize: 13, color: '#94a3b8' },
  todoIcon: { fontSize: 13, marginTop: 1, flexShrink: 0 },
};

import { API_URL } from '../../constants/api.js';

function EngineAccuracyPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/engine-reads/hit-rates`)
      .then(r => r.json())
      .then(d => { if (!d.error) setData(d.rates); })
      .catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const readTypes = [
    { key: 'A_UP',        label: 'A Up signal',    color: '#22c55e' },
    { key: 'A_DOWN',      label: 'A Down signal',  color: '#ef4444' },
    { key: 'BIAS_LONG',   label: 'Pre-mkt LONG',   color: '#22c55e' },
    { key: 'BIAS_SHORT',  label: 'Pre-mkt SHORT',  color: '#ef4444' },
    { key: 'BIAS_NEUTRAL',label: 'Pre-mkt NEUTRAL',color: '#94a3b8' },
  ];

  // Find best and worst sub-combo across all types
  let bestCombo = null, worstCombo = null;
  for (const rt of readTypes) {
    const bucket = data[rt.key];
    if (!bucket?.byBias) continue;
    for (const [bias, stats] of Object.entries(bucket.byBias)) {
      if (stats.decisive < 10) continue;
      const pct = Math.round(stats.hitRate * 100);
      const combo = { label: `${rt.label} + ${bias}`, pct, n: stats.decisive };
      if (!bestCombo || pct > bestCombo.pct) bestCombo = combo;
      if (!worstCombo || pct < worstCombo.pct) worstCombo = combo;
    }
  }

  const totalDecisive = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.decisive || 0), 0);
  const totalCorrect  = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.correct  || 0), 0);
  const totalN        = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.n        || 0), 0);
  const overallAcc    = totalDecisive > 0 ? Math.round(100 * totalCorrect / totalDecisive) : null;

  return (
    <div>
      {/* Summary row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: overallAcc >= 65 ? '#22c55e' : overallAcc >= 55 ? '#fbbf24' : '#ef4444' }}>{overallAcc}%</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>decisive accuracy</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#cbd5e1' }}>{totalN}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>total reads</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#22c55e' }}>{totalCorrect}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>correct</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#ef4444' }}>{totalDecisive - totalCorrect}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>wrong</div>
        </div>
      </div>

      {/* Per-type rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {readTypes.map(rt => {
          const d = data[rt.key]?.overall;
          if (!d) return null;
          const pct = Math.round(d.hitRate * 100);
          const col = pct >= 65 ? '#22c55e' : pct >= 55 ? '#fbbf24' : '#ef4444';
          const byBias = data[rt.key]?.byBias || {};
          const subRows = Object.entries(byBias)
            .filter(([, s]) => s.decisive >= 5)
            .sort((a, b) => b[1].hitRate - a[1].hitRate);
          return (
            <div key={rt.key} style={{ padding: '6px 0', borderBottom: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#cbd5e1' }}>{rt.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: col }}>
                  {pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={d.decisive}</span>
                </span>
              </div>
              {subRows.length > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 3, flexWrap: 'wrap' }}>
                  {subRows.map(([bias, s]) => {
                    const sp = Math.round(s.hitRate * 100);
                    const sc = sp >= 65 ? '#22c55e' : sp >= 55 ? '#fbbf24' : '#ef4444';
                    return (
                      <span key={bias} style={{ fontSize: 11, color: '#94a3b8' }}>
                        {bias} <span style={{ color: sc, fontWeight: 700 }}>{sp}%</span>
                        <span style={{ color: '#64748b' }}> n={s.decisive}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Best / worst combos */}
      {(bestCombo || worstCombo) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {bestCombo && (
            <div style={{ flex: 1, minWidth: 160, padding: '6px 10px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#22c55e', fontWeight: 700, marginBottom: 2 }}>Best call</div>
              <div style={{ color: '#e2e8f0' }}>{bestCombo.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#22c55e' }}>{bestCombo.pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={bestCombo.n}</span></div>
            </div>
          )}
          {worstCombo && (
            <div style={{ flex: 1, minWidth: 160, padding: '6px 10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 2 }}>Weakest call</div>
              <div style={{ color: '#e2e8f0' }}>{worstCombo.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#ef4444' }}>{worstCombo.pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={worstCombo.n}</span></div>
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>Overnight reads context-only · no mechanical sizing · 387 days backfilled</div>
    </div>
  );
}

function SetupCalibrationPanel() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch(`${API_URL}/playbook/setup-calibration`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data || !data.items?.length) {
    return (
      <div style={{ fontSize: 13, color: '#475569', fontStyle: 'italic' }}>
        Accumulating data — N≥20 per setup required before flags appear. Check back after ~4 weeks of daily reviews.
      </div>
    );
  }

  const needsAdjust = data.items.filter(i => i.flag === 'NEEDS_ADJUST');
  const calibrated = data.items.filter(i => i.flag === 'CALIBRATED');
  const accumulating = data.items.filter(i => i.flag === 'ACCUMULATING');

  return (
    <div>
      {needsAdjust.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {needsAdjust.map(item => (
            <div key={item.setup_type} style={{ background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#fca5a5' }}>{item.setup_type}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>{item.avg_rating}⭐ avg (N={item.n})</span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                stop issues: {item.stop_issues} · T1 issues: {item.t1_issues} · entry issues: {item.entry_issues}
                {item.trend_delta !== null && <span> · trend {item.trend_delta >= 0 ? '+' : ''}{item.trend_delta}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {calibrated.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {calibrated.map(item => (
            <span key={item.setup_type} style={{ fontSize: 12, background: '#052e16', border: '1px solid #14532d', borderRadius: 4, padding: '3px 8px', color: '#86efac' }}>
              ✓ {item.setup_type} {item.avg_rating}⭐ (N={item.n})
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#475569' }}>
        {accumulating.length} setups accumulating (N&lt;20): {accumulating.map(i => i.setup_type).join(', ')}
      </div>
    </div>
  );
}

function BehavioralStatsPanel() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch(`${API_URL}/playbook/behavioral-stats`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data || !data.items?.length) {
    return (
      <div style={{ fontSize: 13, color: '#475569', fontStyle: 'italic' }}>
        No behavioral data yet — runs Sunday 9:05 PM after coaching history accumulates.
      </div>
    );
  }

  const trendColor = t => t === 'WORSENING' ? '#ef4444' : t === 'IMPROVING' ? '#22c55e' : '#94a3b8';
  const trendIcon = t => t === 'WORSENING' ? '↑' : t === 'IMPROVING' ? '↓' : '→';

  return (
    <div>
      <div style={{ fontSize: 12, color: '#475569', marginBottom: 8 }}>
        N={data.items[0]?.n} sessions analyzed · Last run: {data.run_date}
      </div>
      {data.items.map(item => (
        <div key={item.theme} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ minWidth: 180, fontSize: 13, color: '#e2e8f0' }}>
            {item.theme.replace(/_/g, ' ')}
          </div>
          <div style={{ minWidth: 100 }}>
            <div style={{ height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(item.rolling_10d * 100)}%`, background: item.rolling_10d > 0.4 ? '#ef4444' : item.rolling_10d > 0.2 ? '#f59e0b' : '#22c55e', borderRadius: 3 }} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', minWidth: 100 }}>
            last10: <strong style={{ color: '#f1f5f9' }}>{Math.round(item.rolling_10d * 100)}%</strong>
            {' '}all: {Math.round(item.all_time_rate * 100)}%
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: trendColor(item.trend) }}>
            {trendIcon(item.trend)} {item.trend}
          </div>
        </div>
      ))}
    </div>
  );
}

function PipelineHealthPanel() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    fetch(`${API_URL}/playbook/pipeline-status`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const cats = ['All', 'Core', 'Context', 'Coaching', 'Specialized', 'Orphan'];
  const staleCount = data.pipelines.filter(p => p.status === 'STALE').length;
  const neverCount = data.pipelines.filter(p => p.status === 'NEVER').length;
  const orphanCount = data.pipelines.filter(p => p.status === 'ORPHAN').length;

  const visible = filter === 'All' ? data.pipelines : data.pipelines.filter(p => p.cat === filter);

  const statusColor = s => s === 'OK' ? '#22c55e' : s === 'STALE' ? '#f59e0b' : s === 'ORPHAN' ? '#475569' : '#ef4444';
  const statusBg    = s => s === 'OK' ? '#052e16' : s === 'STALE' ? '#1c1a0a' : s === 'ORPHAN' ? '#0f172a' : '#1c0a0a';
  const statusBorder= s => s === 'OK' ? '#14532d' : s === 'STALE' ? '#713f12' : s === 'ORPHAN' ? '#1e293b' : '#7f1d1d';

  return (
    <div>
      {/* Summary row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          {data.pipelines.length} tracked · as of {data.as_of}
        </div>
        {staleCount > 0 && (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', background: '#1c1a0a', border: '1px solid #713f12', borderRadius: 4, padding: '2px 8px' }}>
            {staleCount} STALE
          </span>
        )}
        {neverCount > 0 && (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 4, padding: '2px 8px' }}>
            {neverCount} NEVER RUN
          </span>
        )}
        {orphanCount > 0 && (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 4, padding: '2px 8px' }}>
            {orphanCount} ORPHAN
          </span>
        )}
        {/* Category filter */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {cats.map(c => (
            <button key={c} onClick={() => setFilter(c)} style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
              background: filter === c ? '#3b82f6' : '#1e293b',
              color: filter === c ? '#fff' : '#94a3b8',
              border: `1px solid ${filter === c ? '#3b82f6' : '#334155'}`,
            }}>{c}</button>
          ))}
        </div>
      </div>

      {/* Pipeline rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map(p => (
          <div key={p.signal_type} style={{
            background: statusBg(p.status),
            border: `1px solid ${statusBorder(p.status)}`,
            borderRadius: 6, padding: '8px 12px',
            display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: '6px 12px', alignItems: 'start',
          }}>
            {/* Left: type + status */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: statusColor(p.status), fontFamily: 'monospace', marginBottom: 2 }}>
                {p.signal_type}
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: statusColor(p.status), background: statusColor(p.status) + '18', border: `1px solid ${statusColor(p.status)}40`, borderRadius: 3, padding: '1px 5px' }}>
                {p.status}
              </span>
            </div>
            {/* Center: description + schedule */}
            <div>
              <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5, marginBottom: 2 }}>{p.desc}</div>
              <div style={{ fontSize: 11, color: '#475569' }}>
                {p.schedule} · <span style={{ fontFamily: 'monospace' }}>{p.scripts}</span>
              </div>
            </div>
            {/* Right: last run + rows */}
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: p.last_run ? '#e2e8f0' : '#475569' }}>
                {p.last_run ? p.last_run : '—'}
              </div>
              {p.days_since !== null && (
                <div style={{ fontSize: 11, color: '#64748b' }}>{p.days_since}d ago</div>
              )}
              {p.total_rows > 0 && (
                <div style={{ fontSize: 11, color: '#475569' }}>{p.total_rows.toLocaleString()} rows</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LearningDigestPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/learning-digest/recent`).then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;
  const events = data.events || [];
  if (events.length === 0) {
    return <div style={{ fontSize: 12, color: '#94a3b8' }}>Nothing new since this panel started tracking — check back after the next 4:35 PM ET run.</div>;
  }

  const meta = {
    NEW_PATTERN:              { color: '#22c55e', bg: '#052e16', label: 'NEW' },
    PATTERN_DEGRADED:         { color: '#64748b', bg: '#0f172a', label: 'RETIRED' },
    STOP_CHANGED:             { color: '#3b82f6', bg: '#0a1a2e', label: 'STOP' },
    TARGET_CHANGED:           { color: '#3b82f6', bg: '#0a1a2e', label: 'TARGET' },
    SETUP_STATUS_CHANGED:     { color: '#f59e0b', bg: '#1c1a0a', label: 'STATUS' },
    DAY_TYPE_ALPHA_CHANGED:   { color: '#a78bfa', bg: '#1a1330', label: 'SIZING' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
      {events.map((e, i) => {
        const m = meta[e.event_type] || { color: '#94a3b8', bg: '#0f172a', label: e.event_type };
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px', background: m.bg, border: `1px solid ${m.color}30`, borderRadius: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: m.color, letterSpacing: '0.05em', padding: '1px 6px', borderRadius: 3, background: m.color + '15', flexShrink: 0, marginTop: 1 }}>{m.label}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#e2e8f0' }}>{e.description}</div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Answers "why aren't all 100+ setups using the corrected target methodology" with real
// data instead of leaving it an unanswerable black box — the guardrail funnel used to be
// computed by update_optimal_stops.mjs and silently discarded (see CLAUDE.md / this
// component's own comment history, 2026-07-19). lastRunDate + schedule text are the
// concrete "not forgotten, evaluated constantly" proof: every setup_type is genuinely
// re-run on both the daily and weekly cron, not just checked once and left.
function TargetCalibrationCoveragePanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/acd/target-calibration-coverage`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const REASON_LABELS = {
    corrected_resim: { label: 'Using corrected methodology', color: '#22c55e' },
    failed_plateau_check: { label: 'Best target is an isolated spike (fails plateau check)', color: '#f59e0b' },
    no_candidate_cleared_thin_tail: { label: 'Too few trades reach target distance (thin tail)', color: '#f59e0b' },
    failed_oos_or_baseline: { label: "Doesn't beat baseline out-of-sample", color: '#f59e0b' },
    not_rigor_clean: { label: 'Day-clustered or chronologically unstable', color: '#ef4444' },
    stale_no_notes: { label: 'Not touched by the most recent run', color: '#475569' },
  };

  const daysSince = data.lastRunDate ? Math.floor((Date.now() - new Date(data.lastRunDate + 'T12:00:00Z').getTime()) / 86400000) : null;
  const orderedKeys = ['corrected_resim', 'failed_plateau_check', 'no_candidate_cleared_thin_tail', 'failed_oos_or_baseline', 'not_rigor_clean', 'stale_no_notes'];

  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>Target Calibration Coverage</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#22c55e' }}>{data.correctedResimCount}<span style={{ fontSize: 14, color: '#64748b' }}>/{data.total}</span></div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>setup_types using the corrected, guardrailed target methodology</div>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: daysSince <= 1 ? '#22c55e' : '#f59e0b', background: '#0f172a', border: `1px solid ${daysSince <= 1 ? '#14532d' : '#713f12'}`, borderRadius: 4, padding: '2px 8px' }}>
          last evaluated {data.lastRunDate} ({daysSince}d ago)
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {orderedKeys.filter(k => data.tally[k] > 0).map(k => {
          const meta = REASON_LABELS[k] || { label: k, color: '#94a3b8' };
          const examples = data.exclusionExamples[k];
          return (
            <div key={k} style={{ ...S.card, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#cbd5e1' }}>{meta.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: meta.color }}>{data.tally[k]}</span>
              </div>
              {examples?.length > 0 && (
                <div style={{ fontSize: 11, color: '#64748b' }}>e.g. {examples.slice(0, 3).join(', ')}{examples.length > 3 ? `, +${examples.length - 3} more` : ''}</div>
              )}
            </div>
          );
        })}
      </div>
      {data.widenings?.length > 0 && (
        <div style={{ ...S.card, marginBottom: 10, padding: '10px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>Is the correction actually capturing more of the move?</span>
            <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>
              <span style={{ color: '#22c55e' }}>{data.widenedCount} widened</span>
              {data.narrowedCount > 0 && <span style={{ color: '#f87171' }}> · {data.narrowedCount} narrowed</span>}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
            Each row compares this setup's own new (guardrailed, chronologically-resimulated) target against its own old (order-blind, truncated-MFE) target — no hardcoded "large move" cutoff, just each setup versus its former self.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.widenings.slice(0, 8).map(w => (
              <div key={w.signal_name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: '#cbd5e1' }}>{w.signal_name}</span>
                <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>
                  {w.oldTarget}pt → {w.newTarget}pt <span style={{ color: w.widenPct >= 0 ? '#22c55e' : '#f87171', fontWeight: 700 }}>({w.widenPct >= 0 ? '+' : ''}{w.widenPct}%)</span>
                </span>
              </div>
            ))}
            {data.widenings.length > 8 && <div style={{ fontSize: 11, color: '#475569' }}>+{data.widenings.length - 8} more</div>}
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>{data.schedule}</div>
    </div>
  );
}

// Aggregate view of computeRigor()/classifyTrend() (server/services/rigorDiagnostics.js,
// server/routes/acd.js's /acd/rigor-stability-coverage) — has been computed weekly by
// backtest_setup_status.mjs and shown per-row in BacktestView.jsx's "Stability" column
// since 2026-07-14, but nothing ever summarized it across the whole live roster in one
// place until this panel (2026-07-20). Answers "does the live setup roster's backtested
// edge actually hold up chronologically" without requiring a manual DB query.
function RigorStabilityPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/acd/rigor-stability-coverage`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const TREND_LABELS = {
    STABLE: { label: 'Stable (consistent sign)', color: '#4ade80' },
    IMPROVING: { label: 'Improving (was worse, now positive)', color: '#4ade80' },
    NOISY_BUT_STABLE: { label: 'Noisy but net-stable', color: '#94a3b8' },
    AMBIGUOUS: { label: 'Ambiguous', color: '#fbbf24' },
    THIN: { label: 'Too thin recently to classify', color: '#64748b' },
    DEGRADING: { label: 'Degrading (was better, now negative)', color: '#f87171' },
    NO_DATA: { label: 'No rigor data yet', color: '#475569' },
  };
  const orderedKeys = ['STABLE', 'IMPROVING', 'NOISY_BUT_STABLE', 'AMBIGUOUS', 'THIN', 'DEGRADING', 'NO_DATA'];
  const daysSince = data.lastRunDate ? Math.floor((Date.now() - new Date(data.lastRunDate + 'T12:00:00Z').getTime()) / 86400000) : null;

  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>Backtest Stability — Live Roster</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#f87171' }}>{data.tally.DEGRADING || 0}<span style={{ fontSize: 14, color: '#64748b' }}>/{data.total}</span></div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>setup_types currently degrading (recent EV trend worse than early history, now negative)</div>
        {daysSince != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: daysSince <= 1 ? '#22c55e' : '#f59e0b', background: '#0f172a', border: `1px solid ${daysSince <= 1 ? '#14532d' : '#713f12'}`, borderRadius: 4, padding: '2px 8px' }}>
            last evaluated {data.lastRunDate} ({daysSince}d ago)
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {orderedKeys.filter(k => data.tally[k] > 0).map(k => {
          const meta = TREND_LABELS[k];
          return (
            <div key={k} style={{ ...S.card, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#cbd5e1' }}>{meta.label}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: meta.color }}>{data.tally[k]}</span>
            </div>
          );
        })}
      </div>
      {data.degrading?.length > 0 && (
        <div style={{ ...S.card, marginBottom: 10, padding: '10px 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>Degrading — worth a look</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.degrading.map(d => (
              <div key={d.signal_name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
                <span style={{ color: '#cbd5e1' }}>{d.signal_name} (N={d.n})</span>
                <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>
                  {d.thirds ? `$${Math.round(d.thirds.ev1)} → $${Math.round(d.thirds.ev2)} → $${Math.round(d.thirds.ev3)}` : ''}
                  <span style={{ color: '#f87171', fontWeight: 700 }}> (EV ${d.ev})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
        Splits each setup's full trade history into 3 chronological thirds and checks whether EV keeps the same sign throughout. "Unstable" isn't automatically bad — IMPROVING means the edge is getting better, not worse. Informational only, does not auto-suppress. {data.schedule}
      </div>
    </div>
  );
}

// Roster-rebuild roadmap status (Phase 8, 2026-08-11) — the first and only UI surface for
// the whole multi-week rebuild (scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md). Before this
// panel, bet_class, the roster cap, and the correlation monitor existed only as
// performance_audit rows — nothing rendered them anywhere. Read-only/descriptive, same
// convention as RigorStabilityPanel above.
function RosterRebuildPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/acd/roster-rebuild-status`).then(r => r.json()).then(d => { if (!d.error) setData(d); }).catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const STAGE_LABELS = {
    LEGACY_LIVE: { label: 'Legacy live (pre-existing)', color: '#4ade80' },
    STAGE_4_ACTIVE: { label: 'Stage 4 — live at 1 contract', color: '#4ade80' },
    SHADOW: { label: 'Shadow (no real capital)', color: '#94a3b8' },
    UNSTAGED: { label: 'No stage recorded', color: '#64748b' },
  };

  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>Roster Rebuild — bet_class Status</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: data.rosterCap.liveCount > data.rosterCap.cap ? '#f87171' : '#f1f5f9' }}>
          {data.rosterCap.liveCount}<span style={{ fontSize: 14, color: '#64748b' }}>/{data.rosterCap.cap}</span>
        </div>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>live bet_classes against the roadmap's hard roster cap</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {data.betClasses.map(bc => {
          const stageMeta = STAGE_LABELS[bc.stage] || STAGE_LABELS.UNSTAGED;
          return (
            <div key={bc.betClass} style={{ ...S.card, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{bc.betClass}</span>
                <span style={S.badge(stageMeta.color, stageMeta.color + '18')}>{stageMeta.label}</span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                blended N={bc.n} (real N={bc.realN ?? 'n/a'})
                {bc.wr != null && <> · WR {bc.wr}%</>}
                {bc.ev != null && <> · EV <span style={{ color: +bc.ev >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>${bc.ev}</span></>}
                {bc.rigorClean != null && <> · rigor {bc.rigorClean ? 'clean' : 'unstable'}</>}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ ...S.card, padding: '10px 14px', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Correlation monitor</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: data.correlation.flaggedPairs.length > 0 ? 6 : 0 }}>
          {data.correlation.betClassPairsChecked} bet_class pair(s) + {data.correlation.setupTypePairsChecked} live-setup_type pair(s) checked, last run {data.correlation.lastRunDate || 'never'}.
        </div>
        {data.correlation.flaggedPairs.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.correlation.flaggedPairs.map((p, i) => (
              <div key={i} style={{ fontSize: 11, color: '#f87171' }}>
                {p.a} vs {p.b}: r={p.r.toFixed(2)} (overlap_N={p.overlapN}) — exceeds the roadmap's 0.6 diversification ceiling
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#4ade80' }}>No pair currently exceeds r=0.6 with enough overlapping real trading days to trust — either genuinely diversifying, or (more likely at this stage) too little shared real history yet to tell.</div>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
        A "bet" here is a bet_class, not an individual setup_type — the whole point of the rebuild was consolidating ~180 fragmented fade/continuation types into a handful of genuinely distinct bets so N can actually accumulate. {data.schedule}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ ...S.card, borderColor: accent ? accent + '40' : '#1e293b' }}>
      <div style={S.cardTitle}>{label}</div>
      <div style={{ ...S.cardVal, color: accent || '#f1f5f9' }}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  );
}

function FactorRow({ name, effect, stat, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #1e293b22' }}>
      <span style={{ fontSize: 13, color: '#cbd5e1', flex: 1 }}>{name}</span>
      <span style={{ fontSize: 13, color: color || '#94a3b8', fontWeight: 700, textAlign: 'right', marginLeft: 12 }}>{effect}</span>
      {stat && <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 14, minWidth: 140, textAlign: 'right' }}>{stat}</span>}
    </div>
  );
}

export default function AlphaEngineOverview() {
  const [setupStatus, setSetupStatus] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/acd/setup-status`).then(r => r.json()).then(setSetupStatus).catch(() => {});
  }, []);

  const tiers = [
    { name: 'PRIME', n: 15, pnl: '+$42.7K', color: '#22c55e', desc: 'EV ≥ $50/trade' },
    { name: 'SOLID', n: 12, pnl: '+$16.9K', color: '#3b82f6', desc: 'EV $20–49' },
    { name: 'MARGINAL', n: 15, pnl: '+$6.0K', color: '#94a3b8', desc: 'EV $0–19' },
    { name: 'WEAK', n: 8, pnl: '-$4.4K', color: '#f59e0b', desc: 'EV -$1 to -$20' },
    { name: 'KILL', n: 12, pnl: '-$27.7K', color: '#ef4444', desc: 'EV < -$20' },
  ];

  const multiplierFactors = [
    { name: 'Base (single level)', effect: '0.75×', stat: 'Floor for all trades', color: '#94a3b8' },
    { name: 'Base (2+ confluence)', effect: '1.0×', stat: 'Any 2+ levels stacking', color: '#94a3b8' },
    { name: 'Win streak ×1', effect: '+0.25', stat: '76.6% WR N=2,453', color: '#22c55e' },
    { name: 'Win streak ×2', effect: '+0.35', stat: '79.7% WR', color: '#22c55e' },
    { name: 'Win streak ×3+', effect: '+0.50', stat: '87.8% WR N=1,766', color: '#22c55e' },
    { name: 'Loss streak ×1', effect: '−0.50 (0.25× min)', stat: '47.0% WR', color: '#ef4444' },
    { name: 'Loss streak ×2', effect: '−0.65 (0.10× floor)', stat: '31.6% WR N=187', color: '#ef4444' },
    { name: 'Loss streak ×3+', effect: '0.10× (near-skip)', stat: '28.4% WR N=450', color: '#ef4444' },
    { name: 'First setup of day', effect: '+0.10', stat: '79.4% WR N=389 (best group)', color: '#a78bfa' },
    { name: 'Overnight NEUTRAL', effect: '−0.10', stat: '68.2% vs 73% aligned/counter', color: '#f59e0b' },
    { name: 'Buyers/sellers at level', effect: '+0.15', stat: 'Net delta confirming side → +6% WR', color: '#06b6d4' },
    { name: 'Elite zone (TURB + IB dir)', effect: '+0.15', stat: '78–82% WR on confirmed TURBULENT', color: '#f97316' },
    { name: 'Level recency ≤2 days', effect: '+0.15', stat: '$22 EV proven defender', color: '#22c55e' },
    { name: 'Level fresh (21d+ untested)', effect: '−0.10', stat: '60.5% WR, -$5 EV unproven', color: '#f59e0b' },
    { name: 'Verified confluence pair', effect: '+0.15', stat: 'OR_MID+DAILY_OPEN 84%, OR_LOW+IB_LOW 80%', color: '#a78bfa' },
    { name: 'INSIDE_VALUE open', effect: '−0.15', stat: '68.3% vs 72.7% outside z=−2.43', color: '#f59e0b' },
    { name: 'Day-type significance', effect: '±data-driven', stat: 'From DAY_TYPE_ALPHA rows (weekly recompute)', color: '#06b6d4' },
    { name: 'Stacking 7+ same-dir/day', effect: '0.10× (suppress)', stat: '62.4% WR -$15.7 EV N=1,922 — trend day, fades dead', color: '#ef4444' },
    { name: 'NL30 MILD_BULL/BEAR + SHORT', effect: '−0.20', stat: '61.6–62.6% WR -$17 to -$19 EV, z=−2.5 to −2.7 N=255-289', color: '#ef4444' },
    { name: 'NL30 STRONG_BEAR + SHORT', effect: '+0.10', stat: '77.7% WR +$68.1 EV z=+3.34 N=337', color: '#22c55e' },
    { name: 'NL30 STRONG_BULL + LONG', effect: '+0.10', stat: '77.6% WR +$62.0 EV z=+2.63 N=429', color: '#22c55e' },
    { name: 'NL30 MILD_BULL + LONG', effect: '+0.10', stat: '77.3% WR +$63.7 EV z=+2.06 N=299', color: '#22c55e' },
    { name: 'First visit of day to level', effect: '+0.15', stat: '78% WR +$71 EV z=+2.74 N=283 — untouched liquidity', color: '#22c55e' },
    { name: 'Level revisit 3hr+ stale', effect: '−0.25', stat: '60% WR -$35 EV z=-2.74 N=129 — liquidity picked off', color: '#ef4444' },
    { name: 'VWAP Extension (>mean+σ)', effect: '+0.15', stat: '76.2% WR +$59.7 EV z=+2.95 N=600 — fade + reversion stacked', color: '#22c55e' },
    { name: 'OR Expansion: no breach yet (BALANCE/TURBULENT)', effect: '+0.10', stat: 'BALANCE 78.9% WR N=161 z=2.03; TURBULENT 96.2% N=26 z=2.77 — liquidity intact', color: '#22c55e' },
    { name: 'Regime Persistence: TURBULENT 3-day streak (non-NEUTRAL NL30)', effect: '+0.10', stat: '84.1% WR N=157 z=3.45 (+8.9pp lift) — confirmed regime momentum', color: '#22c55e' },
    { name: 'Session-bias conflict (opposing PERMISSION_SLIP ≥65% WR)', effect: '−0.25', stat: 'CONFLICT 58.6% WR -$14.93 EV N=4,037 vs NO_CONFLICT 78.1% WR +$28.62 EV N=1,887 (z=-8.25) — holds within every day_type independently, added 2026-07-16', color: '#ef4444' },
    { name: 'Floor', effect: '0.25×', stat: 'Hard minimum', color: '#94a3b8' },
    { name: 'Ceiling', effect: '1.50×', stat: 'Hard maximum', color: '#94a3b8' },
  ];

  // Mechanism-level descriptions only — no per-setup_type WR/N/$ literals here (those
  // drift constantly as SETUP_STATUS recalibrates weekly and are rendered live below
  // from `setupStatus.suppressed` instead). Found stale 2026-07-14/15 (docs/KNOWN_ISSUES.md
  // item 11): this array used to hand-type ~10 individual setup_type WR/N/$ entries that
  // had drifted hard (e.g. claimed IB_HIGH_FADE_SHORT suppressed at 55.7% WR — it's ACTIVE
  // now; claimed PD_POC_FADE_SHORT suppressed — it's PROMOTE now). Fixed same pattern as
  // the 2026-07-13 acd.js `describeLevel()` fix: derive from already-fetched live data,
  // never hand-type a number that a weekly recompute can invalidate.
  const suppressionMechanisms = [
    { name: 'Globally suppressed setups (pipeline-driven)', reason: 'Auto-suppression engine writes SETUP_STATUS rows weekly — any setup with N≥20 and EV<-$5 fires as SHADOW. Setups flip back to ACTIVE when 90d data recovers. mondaySkip list removed 2026-07-09 — DOW edge handled by SETUP_STATUS_DOW.' },
    { name: 'TREND counter-direction fade filter', reason: 'On TREND days (≥10:30 ET, once day-type is final): fades against the IB break direction are suppressed — IB_BULLISH suppresses SHORT fades, IB_BEARISH suppresses LONG fades, and if IB direction is unknown all fades are suppressed to be safe. isTrendCounterFade() in acd.js, architecturally separate from the SETUP_STATUS pipeline — restored 2026-07-15 after being dropped from this list without a live replacement (docs/KNOWN_ISSUES.md item 11 follow-up).' },
    { name: 'S2 double-counter suppression', reason: 'Suppresses a fade only when BOTH overnight inventory AND open-vs-prior-value disagree with the fade direction (e.g. LONG fade + overnight LONG_TRAPPED + open BELOW_VALUE) — a stricter bar than either signal disagreeing alone. isS2DoubleCounter() in acd.js, also separate from SETUP_STATUS. Restored 2026-07-15, same reason as above. No live UI currently flags which specific fires were caught by this filter (open item, see the page\'s own pending list below).' },
    { name: 'WPP_FADE_SHORT_GAP_UP [conditional variant]', reason: 'Fires when session 9:30 open is BELOW WPP (gap brought price up into resistance) — resolveSetupType() in acd.js converts the base WPP_FADE_SHORT into this variant when the gap-up condition is met. Separate SETUP_STATUS + OPTIMAL_STOP rows, maintained by scripts/backtest_wpp_short_gap.mjs on the weekly cron. Live suppression status for both the base type and this variant shown below, not hand-typed here.' },
    { name: 'MOMENTUM_60m_60m family [minute-bar scanner, not a level touch]', reason: 'From the 2026-07-14 minute-bar scanner (raw momentum/volume-z extreme over a trailing window — see scripts/backtest_minute_bar_scan.mjs). Only MOMENTUM_60m_60m_TREND has a live poller (server/services/minuteBarSignalDetector.js, SHADOW pending N≥20 real live-fired trades — its SETUP_STATUS recommendation reflects a pre-live historical backtest until then, not live confirmation). The unconditioned/VOLZ variants never got a live poller built at all. MOMENTUM_60m_60m_BALANCE_FADE (day-type-conditioned counterpart, scripts/backtest_momentum60_daytype.mjs) also has no live poller — found 2026-07-16 that its recommendation has drifted between SUPPRESS and ACTIVE across recalibrations as its EV hovers near the -$5 bar, which does not matter operationally since nothing fires it live either way, but do not treat a "does not fire live" status as fixed indefinitely. Live WR/EV/N for every variant shown below, not hand-typed here.' },
  ];

  const tools = [
    {
      name: 'Level Fade Engine',
      color: '#22c55e',
      desc: '50+ key levels tracked (PD_*, CAM_*, FLOOR_*, WPP, weekly/monthly VA, overnight range, OR/IB). Server polls every 60s during 9:30–4 PM ET. Detection starts at first proximity touch (~9:34 AM post fix). INSERT is idempotent — ON CONFLICT DO NOTHING.',
    },
    {
      name: 'Optimal Stop/Target System',
      color: '#3b82f6',
      desc: 'p75_MAE → stop, p50_MFE → target, p75_MFE → T2 runner. Computed weekly from 3,801+ resolved trades via scripts/update_optimal_stops.mjs. All directional (LONG/SHORT separately). No hardcoded constants remain in the live level fade path.',
    },
    {
      name: 'Minute-Bar Signal Detector',
      color: '#f472b6',
      desc: 'Rolling-bar-window statistical extreme detector (momentum/volume-z over a trailing window vs. its own trailing-20-trading-day distribution) — not a level touch, so it has its own poller (server/services/minuteBarSignalDetector.js) modeled on the phase-change detector rather than the level-fade candidates array. Currently one signal live-eligible: MOMENTUM_60m_60m_TREND, SHADOW status pending N≥20 live trades. All combinations (profitable or not) tracked in performance_audit signal_type=\'MINUTE_BAR_SCAN\' via scripts/backtest_minute_bar_scan.mjs on weekly cron.',
    },
    {
      name: 'DAY_TYPE_ALPHA System',
      color: '#a78bfa',
      desc: 'Weekly per-(setup_type × day_type) z-score from all resolved trades. Only SIZE_UP/SIZE_DOWN/SUPPRESS rows (z≥1.5, N≥20) affect sizeMultiplier. size_delta scales with |z| × 0.07, capped 0.25. Currently: WEEKLY_VWAP_FADE_LONG BALANCE z=1.9 is the only confirmed cell.',
    },
    {
      name: 'Session Forecast Panel',
      color: '#06b6d4',
      desc: 'Pre-market intel stack: (1) Volatility forecast — P(BALANCE/TREND/TURBULENT) from ON range + prior day type. (2) Setup Anticipation — top 6 setups by fire_rate × EV for today\'s context. (3) Confluence Near Price — level pairs within 15pt of current price, N≥10 calibrated.',
    },
    {
      name: 'Nightly Latency Audit',
      color: '#f59e0b',
      desc: 'scripts/audit_setup_latency.mjs — runs at 5:15 PM ET Mon–Fri. For each setup: first bar within 15pt, lag = fired_at − first_bar. CRITICAL (>2 min), RETROACTIVE (>45 min). Alerts to scratch/gemini_alerts.txt. Fix recovered ~$44K/yr at 1 MNQ from phantom wins in retroactive IB backfill.',
    },
    {
      name: 'MAE/MFE Backfill & Replay',
      color: '#ec4899',
      desc: '3,801 rows backfilled via scripts/backfill_mae_mfe.mjs. Shared replay engine: server/services/maeMfeReplay.js. Live resolution populates mae_points, mfe_points, bars_to_resolution, resolution_bar_time on every new setup close. Weekly recompute of optimal stops/targets from accumulated data.',
    },
    {
      name: 'Context Analysis Engine',
      color: '#f97316',
      desc: 'scripts/context_analysis.js — weekly Sunday 6 AM. 136 rows in performance_audit (CONTEXT_ANALYSIS). Confirmed stable rules: no Monday fades, BALANCE-only, prefer LONG, IB_MID Friday=best. Confluence pair analysis: 520 pairs at 15pt proximity, 108 rated TRADE. Top: CAM_S2+PD_IB_HIGH 75.5% EV=$55.',
    },
    {
      name: 'Monte Carlo Optimizer',
      color: '#8b5cf6',
      desc: '5,000 paths × 180 combos × 3 filter modes. Key finding: Stop=20 sizing unit / Target=50–60pt = 100% survival across all paths. Current system params confirmed optimal. Re-run trigger: proximity window change or 20+ new trading days.',
    },
    { name: 'Engine Self-Tracking', color: '#94a3b8', _live: true },
    {
      name: 'Setup Anticipation',
      color: '#0ea5e9',
      desc: 'scripts/backtest_level_approach.js — weekly Sunday 8:30 PM. Computes P(setup fires | day_type, DOW) × avg_pnl from 906+ rows. Top-3 coverage = 77% (3 in 4 trading days, ≥1 top-3 setup fires). Shown in SessionForecastPanel. Key: BALANCE→OR_HIGH_FADE_SHORT 29% fire rate / 84% WR.',
    },
    {
      name: 'Auto-Suppression Engine',
      color: '#ef4444',
      desc: 'scripts/backtest_setup_status.mjs — weekly Sunday 9:20 PM. SUPPRESS: N≥20, EV<-$5 (no WR gate — catches high-WR structural losers). PROMOTE: 90-day WR≥52% + EV>$0 + N≥15 → restored to ACTIVE. Directly flips open active_setups rows on each run. Currently 17 types suppressed (19 SETUP_STATUS rows as of 2026-07-09). Safety net: if this stops running, losing setups accumulate silently.',
      _live: 'setupStatus',
    },
    {
      name: 'Tier Analysis System',
      color: '#94a3b8',
      desc: 'Full-year tier analysis Jul 2025–Jul 2026 (N=2,784 resolved trades). PRIME+SOLID = $59.6K/yr at 1 MNQ. Kill tier (12 setups) recovered $27.7K/yr by suppression. Alpha surgery (suppressions + TREND counter-direction filter) recovered ~$38K/yr combined. Systematic suppression now automated via Auto-Suppression Engine above.',
    },
  ];

  const pending = [
    { icon: '🔇', text: 'S2 suppression indicator — no UI tells you when a setup was killed by the double-counter filter.' },
    { icon: '📅', text: 'Shadow validation due ~2026-08-05 — IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT (both flip positive with tight stops).' },
    { icon: '🔗', text: 'Confluence pairs near price endpoint — 108 TRADE-rated pairs in JSON, no live UI surfacing which pairs overlap current price.' },
  ];

  return (
    <div style={S.page}>
      <div style={S.h1}>Alpha Engine Overview</div>
      <div style={S.sub}>Level Fade System — built Jan–Jul 2026 · All thresholds data-derived · Last alpha surgery 2026-07-09</div>

      {/* Top-line stats */}
      <div style={{ ...S.grid4, marginBottom: 28 }}>
        <StatCard label="Trades analyzed" value="4,424" sub="Nov 2023–Jul 2026 resolved" accent="#3b82f6" />
        <StatCard label="PRIME+SOLID EV" value="$68.5K/yr" sub="Jul 2025–Jul 2026 at 1 MNQ" accent="#22c55e" />
        <StatCard label="Alpha recovered" value="~$75K/yr" sub="Suppressions ($31K) + latency fix ($44K)" accent="#a78bfa" />
        <StatCard label="Active levels" value="50+" sub="PD / CAM / FLOOR / WPP / monthly" accent="#06b6d4" />
      </div>

      {/* Detection Architecture */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Detection Architecture</div>
        <div style={S.grid3}>
          <div style={S.card}>
            <div style={S.cardTitle}>Server Poll Cadence</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>15s</div>
            <div style={S.cardSub}>Full CME Globex week (Sun 6PM–Fri 5PM ET, daily 5–6PM maintenance gap excluded) · autonomous (no browser required)</div>
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>Detection Start</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>9:34 AM</div>
            <div style={S.cardSub}>After 4 RTH bars · gate lowered from 10:30 AM (60 bars) to 3 bars</div>
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>IB/OR Level Gate</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>10:30 AM</div>
            <div style={S.cardSub}>IB_HIGH/LOW and IB_MID self-gate via etMinNow ≥ 630 — legitimate formation time</div>
          </div>
        </div>
        <div style={{ ...S.card, marginTop: 10, fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          <strong style={{ color: '#e2e8f0' }}>Pre-fix (before 2026-07-05):</strong> 62% of setups fired via retroactive IB-close backfill at 10:30 AM.
          248 phantom wins in the PRECOMPUTED bucket (T1 hit before alert fired). Fix recovered <strong style={{ color: '#22c55e' }}>~$44K/yr</strong> at 1 MNQ.
          Structural phantom wins (price hits level + T1 within 60s) are not recoverable with polling — ~53 setups/180 days are in this category.
        </div>
      </div>

      {/* Target Calibration Coverage */}
      <TargetCalibrationCoveragePanel />

      {/* Backtest Stability (rigor/trend) */}
      <RigorStabilityPanel />

      {/* Roster Rebuild (bet_class, roster cap, correlation monitor) */}
      <RosterRebuildPanel />

      {/* Size Multiplier Stack */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Size Multiplier Stack</div>
        <div style={{ ...S.card, marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>
            All factors apply multiplicatively on top of the base. Floor: <strong style={{ color: '#f1f5f9' }}>0.25×</strong> · Ceiling: <strong style={{ color: '#f1f5f9' }}>1.50×</strong>
          </div>
          {multiplierFactors.map(f => (
            <FactorRow key={f.name} name={f.name} effect={f.effect} stat={f.stat} color={f.color} />
          ))}
        </div>
      </div>

      {/* Setup Tiers */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Setup Tiers (Full-Year Backtest)</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {tiers.map(t => (
            <div key={t.name} style={{ ...S.card, flex: '1 1 160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={S.badge(t.color, t.color + '18')}>{t.name}</span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>×{t.n}</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: t.pnl.startsWith('+') ? '#22c55e' : '#ef4444' }}>{t.pnl}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{t.desc} · 1 MNQ/yr</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          Badges shown live on each setup card. KILL-tier setups are fully suppressed. PRIME+SOLID combined: <strong style={{ color: '#22c55e' }}>68% WR, $54 avg EV, $59.6K/yr at 1 MNQ · ~$179K at 3 MNQ</strong>.
        </div>
      </div>

      {/* Suppression Logic */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Suppressed Setups & Filters</div>
        <div style={S.grid2}>
          {suppressionMechanisms.map(s => (
            <div key={s.name} style={S.suppressed}>
              <span style={{ color: '#ef4444', fontWeight: 700 }}>{s.name}</span>
              <span style={{ color: '#94a3b8' }}> — {s.reason}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#64748b', margin: '14px 0 6px' }}>
          Individual suppressed setup_types — live from the latest SETUP_STATUS run{setupStatus?.lastRun ? ` (${setupStatus.lastRun})` : ''}, not hand-typed:
        </div>
        {setupStatus ? (
          <div style={S.grid2}>
            {(setupStatus.suppressed ?? []).map(s => (
              <div key={s.setup_type} style={S.suppressed}>
                <span style={{ color: '#ef4444', fontWeight: 700 }}>{s.setup_type}</span>
                <span style={{ color: '#94a3b8' }}> — WR {(s.win_rate * 100).toFixed(1)}% · EV ${s.ev_per_trade?.toFixed(2)} · N={s.sample_size}</span>
              </div>
            ))}
          </div>
        ) : <div style={{ fontSize: 12, color: '#475569' }}>Loading…</div>}
      </div>

      {/* Tools */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Supporting Tools</div>
        <div style={S.grid2}>
          {tools.map(t => (
            <div key={t.name} style={S.toolCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 3, height: 16, background: t.color, borderRadius: 2, flexShrink: 0 }} />
                <div style={S.toolTitle}>{t.name}</div>
              </div>
              {t._live === 'setupStatus' ? (
                <div>
                  <div style={S.toolDesc}>{t.desc}</div>
                  {setupStatus ? (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
                      Last run: {setupStatus.lastRun ?? '—'} · {setupStatus.suppressed?.length ?? 0} suppressed
                      {setupStatus.promoted?.length > 0 && ` · ${setupStatus.promoted.length} recently promoted`}
                      {' — full live list in "Suppressed Setups & Filters" above.'}
                    </div>
                  ) : <div style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>Loading...</div>}
                </div>
              ) : t._live ? <EngineAccuracyPanel /> : <div style={S.toolDesc}>{t.desc}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Recent Learning */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Recent Learning</div>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            New patterns crossing significance, retired ones, and meaningful stop/target/sizing changes since the last run. Updated 4:35 PM ET Mon-Fri, after the day's stop/target and pattern-scan recompute.
          </div>
          <LearningDigestPanel />
        </div>
      </div>

      {/* AI Setup Calibration */}
      <div style={S.section}>
        <div style={S.sectionTitle}>AI Setup Calibration (from Daily Reviews)</div>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            Per-setup avg rating from AI daily reviews. Flags NEEDS_ADJUST when avg &lt; 3.5⭐ (N≥20). Updated Sunday 9:05 PM.
          </div>
          <SetupCalibrationPanel />
        </div>
      </div>

      {/* Behavioral Trends */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Behavioral Trends (from Coaching History)</div>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            Frequency of behavioral patterns across all coaching sessions. WORSENING = last 10 sessions &gt;10pp above prior 20.
          </div>
          <BehavioralStatsPanel />
        </div>
      </div>

      {/* Pipeline Health */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Pipeline Health</div>
        <div style={{ ...S.card, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            All calibration pipelines tracked here. STALE = last run exceeded max expected age. Core pipelines (SETUP_STATUS, OPTIMAL_STOP) weekly; LATENCY_AUDIT + AI reviews daily.
          </div>
          <PipelineHealthPanel />
        </div>
      </div>

      {/* Pending todos */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Pending / Road Map</div>
        <div style={{ ...S.card }}>
          {pending.map((p, i) => (
            <div key={i} style={S.todo}>
              <span style={S.todoIcon}>{p.icon}</span>
              <span>{p.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Capture Ratio */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Capture Ratio — Edge vs Execution</div>
        <CaptureRatioPanel />
      </div>

      {/* Footer */}
      <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 8 }}>
        All WR/EV claims: N≥20 hard floor · No static thresholds — all derived from rolling distributions · Hard rule: no lookahead in backtests
      </div>
    </div>
  );
}
