import React, { useState } from 'react';
import { useSharedPollData } from '../../utils/useSharedPollData.js';
import { useViewActive } from '../../utils/useViewActive.js';
import InfoTooltip from '../shared/InfoTooltip.jsx';

import { API_URL } from '../../constants/api.js';

function fmtP(p) { return p != null ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; }

const C = {
  green: '#4ade80', amber: '#fbbf24', red: '#f87171', blue: '#38bdf8',
  text: '#e2e8f0', dim: '#94a3b8', muted: '#64748b', border: 'rgba(51,65,85,0.4)',
};

function Chip({ label, value, color, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '5px 8px',
      background: active ? 'rgba(56,189,248,0.08)' : 'rgba(30,41,59,0.5)',
      border: active ? '1px solid rgba(56,189,248,0.35)' : '1px solid rgba(51,65,85,0.3)',
      borderRadius: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      cursor: 'pointer', transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: 11, color: C.dim, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || C.text, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function DetailRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
      <span style={{ fontSize: 12, color: C.dim }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || C.text, fontVariantNumeric: 'tabular-nums' }}>{value ?? '—'}</span>
    </div>
  );
}

const CHIP_DETAIL = {
  rotations: (rots, ctx) => {
    const tier = rots <= 1 ? { label: 'TRENDING', color: C.green, note: 'One-directional. Ride the move — pullback entries only. Counter-fades high risk.' }
      : rots <= 3 ? { label: 'BALANCED', color: C.amber, note: 'Two-way price action. Fade edges, responsive levels. First touch is the best touch.' }
      : { label: 'CHOPPY', color: C.red, note: 'Multiple reversals. Reduce size, widen mental stops. Avoid breakout entries.' };
    return (
      <>
        <DetailRow label="Rotations today" value={rots ?? '—'} color={tier.color} />
        <DetailRow label="Classification" value={tier.label} color={tier.color} />
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 0' }} />
        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>{tier.note}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Reference: ≤1 = trending · 2–3 = balanced · ≥4 = choppy</div>
      </>
    );
  },
  volume: (relVol) => {
    const tier = (relVol?.sigma || 0) >= 2 ? { label: 'EXTREME', color: C.red }
      : (relVol?.sigma || 0) >= 1.5 ? { label: 'SPIKE', color: C.amber }
      : (relVol?.sigma || 0) >= 1 ? { label: 'ELEVATED', color: '#fb923c' }
      : { label: 'NORMAL', color: C.dim };
    return (
      <>
        <DetailRow label="Rel volume" value={relVol ? `${relVol.ratio}×` : '—'} color={tier.color} />
        <DetailRow label="σ vs baseline" value={relVol?.sigma != null ? `${relVol.sigma > 0 ? '+' : ''}${relVol.sigma.toFixed(1)}σ` : '—'} color={tier.color} />
        <DetailRow label="Cum vol" value={relVol?.cumVol != null ? relVol.cumVol.toLocaleString() : '—'} />
        <DetailRow label="Class" value={relVol?.label || tier.label} color={tier.color} />
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 0' }} />
        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
          Time-adjusted vs 90-day same-minute baseline.{' '}
          {tier.label === 'SPIKE' || tier.label === 'EXTREME'
            ? 'Elevated participation — confirms directional moves. High RVol on A signal bar = stronger follow-through.'
            : tier.label === 'ELEVATED'
            ? 'Above average — watch for follow-through confirmation.'
            : 'Normal participation. Moves less reliable without volume expansion.'}
        </div>
      </>
    );
  },
  delta: (delta) => {
    const notes = {
      BUYING:        'Net buyers dominant. Supports long fades and upside setups. Watch for weakening.',
      SELLING:       'Net sellers dominant. Supports short fades and downside setups. Watch for weakening.',
      STRENGTHENING: 'Flow accelerating in current direction — institutional conviction growing.',
      WEAKENING:     'Flow reversing direction. Possible exhaustion — counter-move risk elevated.',
      FLAT:          'No net conviction. Market in discovery — fade edges carefully, quick profits.',
    };
    const c = delta?.trend === 'BUYING' || delta?.trend === 'STRENGTHENING' ? C.green
      : delta?.trend === 'SELLING' || delta?.trend === 'WEAKENING' ? C.red : C.dim;
    return (
      <>
        <DetailRow label="Trend" value={delta?.trend || '—'} color={c} />
        {delta?.cumDelta != null && <DetailRow label="Cum delta" value={`${delta.cumDelta > 0 ? '+' : ''}${delta.cumDelta.toLocaleString()}`} color={c} />}
        {delta?.sigma != null && <DetailRow label="Δ σ" value={`${delta.sigma > 0 ? '+' : ''}${delta.sigma.toFixed(1)}σ`} />}
        {delta?.label && <DetailRow label="Class" value={delta.label} />}
        {delta?.buySellRatio != null && <DetailRow label="Buy/sell ratio" value={delta.buySellRatio.toFixed(2)} />}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 0' }} />
        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
          {notes[delta?.trend] || 'Cumulative order flow (ask vol − bid vol) since RTH open.'}
        </div>
      </>
    );
  },
  structure: (microTrend, ctx) => {
    const notes = {
      HIGHER_LOWS: 'Buyers absorbing every pullback. Lean long — add on dips, not breakouts. Shorts covering = fuel.',
      LOWER_HIGHS: 'Sellers defending every bounce. Lean short — fade rallies. Longs stopping out = fuel.',
      MIXED:       'No structural edge. Both directions in play — responsive fades at extremes. Avoid trend entries.',
    };
    const c = microTrend === 'HIGHER_LOWS' ? C.green : microTrend === 'LOWER_HIGHS' ? C.red : C.dim;
    return (
      <>
        <DetailRow label="Pattern" value={microTrend?.replace('_', ' ') || '—'} color={c} />
        {ctx?.efficiencyRatio != null && <DetailRow label="Efficiency ratio" value={ctx.efficiencyRatio.toFixed(2)} />}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '6px 0' }} />
        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.6 }}>
          {notes[microTrend] || 'Micro price structure based on recent swing highs/lows.'}
        </div>
      </>
    );
  },
};

export default function SessionPulseCard() {
  // Was an independent 30s poll of live-session-context — found alongside 5 other
  // components doing the exact same thing (2026-07-15, while investigating why
  // Morning Prep fires ~118 concurrent requests on mount). Deduped onto the shared
  // subscription hook.
  const isViewActive = useViewActive();
  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [ctxRaw] = useSharedPollData(isViewActive ? `${API_URL}/morning-brief/live-session-context/${todayDate}` : null, 30000);
  const ctx = ctxRaw?.noData ? null : ctxRaw;
  const [sel, setSel]   = useState(null);

  if (!ctx) return null;

  const { rots, delta, relVol, sessionChar, microTrend, price, closeVsOpen, rangePct, range, open } = ctx;

  const isDirectional  = sessionChar?.includes('TREND') || (rots != null && rots <= 1 && Math.abs(closeVsOpen || 0) > 80);
  const volExtreme     = (relVol?.sigma || 0) >= 1.5;
  const deltaFading    = delta?.trend === 'WEAKENING' || delta?.trend === 'FLAT' || delta?.trend === 'BUYING';
  const higherLows     = microTrend === 'HIGHER_LOWS';
  const lowerHighs     = microTrend === 'LOWER_HIGHS';
  const exhaustionScore = [isDirectional, volExtreme, deltaFading, higherLows || lowerHighs].filter(Boolean).length;

  const isDownSession = (closeVsOpen || 0) < -80;
  const isUpSession   = (closeVsOpen || 0) > 80;
  const sessionOpen   = open || (isDownSession ? (price - closeVsOpen) : null);

  let retraceDisplay = null;
  if (sessionOpen && range && rangePct != null && Math.abs(closeVsOpen || 0) > 80) {
    const morningDrop = Math.abs(closeVsOpen);
    const p25Target   = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.46) : (sessionOpen + morningDrop - morningDrop * 0.46);
    const medTarget   = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.68) : (sessionOpen + morningDrop - morningDrop * 0.68);
    const p75Target   = isDownSession ? (sessionOpen - morningDrop + morningDrop * 0.88) : (sessionOpen + morningDrop - morningDrop * 0.88);
    const counterMove = isDownSession ? (price - (sessionOpen - morningDrop)) : ((sessionOpen + morningDrop) - price);
    const retracePct  = Math.max(0, Math.min(105, counterMove / morningDrop * 100));
    if (counterMove > 20) {
      retraceDisplay = { morningDrop: Math.round(morningDrop), counterMove: Math.round(counterMove), retracePct: Math.round(retracePct), p25Target: Math.round(p25Target), medTarget: Math.round(medTarget), p75Target: Math.round(p75Target), isDown: isDownSession };
    }
  }

  const volColor   = volExtreme ? C.amber : (relVol?.sigma || 0) >= 1 ? '#fb923c' : C.muted;
  const rotColor   = (rots ?? 0) <= 1 ? C.red : (rots ?? 0) <= 2 ? C.amber : C.green;
  const deltaColor = delta?.trend === 'BUYING' || delta?.trend === 'STRENGTHENING' ? C.green
    : delta?.trend === 'WEAKENING' ? C.amber : delta?.trend === 'FLAT' ? C.dim : C.red;
  const mtColor    = higherLows ? C.green : lowerHighs ? C.red : C.dim;
  const exhaustBorderColor = exhaustionScore >= 3 ? '#f59e0b' : exhaustionScore >= 2 ? '#475569' : C.border;

  const toggle = (key) => setSel(s => s === key ? null : key);

  const detailContent = sel === 'rotations' ? CHIP_DETAIL.rotations(rots, ctx)
    : sel === 'volume'    ? CHIP_DETAIL.volume(relVol)
    : sel === 'delta'     ? CHIP_DETAIL.delta(delta)
    : sel === 'structure' ? CHIP_DETAIL.structure(microTrend, ctx)
    : null;

  return (
    <div style={{ padding: '8px 10px', background: 'rgba(15,23,42,0.6)', border: `1px solid ${exhaustBorderColor}`, borderRadius: 6, transition: 'border-color 0.3s' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center' }}>
          Session Pulse
          <InfoTooltip tooltip={{
            text: 'A live read of how today\'s session is behaving, updated continuously.\n\n• ROTATIONS — how many meaningful back-and-forth swings so far. Low = trending/one-directional. High = choppy, range-bound.\n• VOLUME — today\'s volume vs. a normal session (1.0x = average).\n• DELTA — net buying vs. selling pressure right now (FLAT/BUYING/SELLING).\n• STRUCTURE — the shape price is tracing (e.g. higher lows, lower highs, mixed).\n\nClick any of the 4 boxes below for a fuller explanation of what that specific reading means right now.',
          }} />
        </div>
        <div style={{ fontSize: 12, color: C.dim }}>
          {sessionChar?.replace(/_/g, ' ') || '—'}
        </div>
      </div>

      {/* Exhaustion alert */}
      {exhaustionScore >= 3 && (
        <div style={{ padding: '6px 8px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 4, marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.amber, marginBottom: 2 }}>
            ⚡ {isDownSession ? 'FLUSH' : 'SPIKE'} EXHAUSTION — {exhaustionScore}/4 signals
          </div>
          <div style={{ fontSize: 12, color: '#cbd5e1' }}>
            {[
              isDirectional && 'directional session',
              volExtreme && `vol ${relVol?.sigma?.toFixed(1)}σ`,
              deltaFading && `delta ${delta?.trend?.toLowerCase()}`,
              higherLows && 'higher lows',
              lowerHighs && 'lower highs',
            ].filter(Boolean).join(' · ')}
          </div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 3 }}>
            Median counter-move: <span style={{ color: C.amber, fontWeight: 700 }}>374pt</span> when delta diverges · 89% had 150pt+ bounce
          </div>
        </div>
      )}

      {/* 4 clickable chips */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: detailContent ? 0 : 6 }}>
        <Chip label="Rotations" value={rots ?? '—'} color={rotColor}   active={sel === 'rotations'} onClick={() => toggle('rotations')} />
        <Chip label="Volume"    value={relVol ? `${relVol.ratio}x` : '—'} color={volColor} active={sel === 'volume'} onClick={() => toggle('volume')} />
        <Chip label="Delta"     value={delta?.trend || '—'} color={deltaColor} active={sel === 'delta'} onClick={() => toggle('delta')} />
        <Chip label="Structure" value={microTrend?.replace('_', ' ') || '—'} color={mtColor} active={sel === 'structure'} onClick={() => toggle('structure')} />
      </div>

      {/* Inline detail panel */}
      {detailContent && (
        <div style={{ padding: '8px 10px', background: 'rgba(15,23,42,0.7)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 4, marginTop: 4, marginBottom: 6 }}>
          {detailContent}
        </div>
      )}

      {/* Counter-move tracker */}
      {retraceDisplay && (
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.4)', borderRadius: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Counter-Move Tracker
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              {retraceDisplay.counterMove}pt · <span style={{ color: retraceDisplay.retracePct >= 88 ? C.amber : retraceDisplay.retracePct >= 68 ? C.green : C.dim }}>{retraceDisplay.retracePct}%</span>
            </div>
          </div>
          <div style={{ position: 'relative', height: 6, background: 'rgba(51,65,85,0.5)', borderRadius: 3, marginBottom: 6 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min(retraceDisplay.retracePct, 100)}%`, background: retraceDisplay.retracePct >= 88 ? C.amber : retraceDisplay.retracePct >= 68 ? C.green : '#60a5fa', borderRadius: 3, transition: 'width 0.5s' }} />
            <div style={{ position: 'absolute', left: '46%', top: -2, width: 1, height: 10, background: '#475569' }} />
            <div style={{ position: 'absolute', left: '68%', top: -2, width: 1, height: 10, background: '#64748b' }} />
            <div style={{ position: 'absolute', left: '88%', top: -2, width: 1, height: 10, background: C.dim }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, fontSize: 12 }}>
            <div style={{ color: retraceDisplay.retracePct >= 46 ? C.green : C.dim }}>P25 {fmtP(retraceDisplay.p25Target)}</div>
            <div style={{ color: retraceDisplay.retracePct >= 68 ? C.green : C.dim, textAlign: 'center' }}>MED {fmtP(retraceDisplay.medTarget)}</div>
            <div style={{ color: retraceDisplay.retracePct >= 88 ? C.amber : C.dim, textAlign: 'right' }}>P75 {fmtP(retraceDisplay.p75Target)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
