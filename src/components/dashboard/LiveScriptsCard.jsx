import React, { useState, useEffect } from 'react';

const API_URL = '/api';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
// etMin = minutes since midnight ET of the most recent bar this card's data was computed from —
// reflects data freshness (last bar ingested), not browser render/fetch time.
const fmtEtTime = (etMin) => {
  if (etMin == null) return null;
  const h24 = Math.floor(etMin / 60), m = etMin % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm} ET`;
};

const METRIC_INFO = {
  sessionChar: {
    title: 'Session Character',
    body: `How the day is classified based on price structure:\n\nALL THRESHOLDS ARE DYNAMIC — rotation count σ from trailing 90-day distribution. Rotation size = 15% of ATR(20). Everything self-calibrates.\n\n• TREND_UP — Directional up day. Price above VWAP 87% of time. Buy dips to VWAP, never fade.\n• TREND_DOWN — Directional down day. Price below VWAP 86%. Short rallies to VWAP.\n• CHOP — Rotations at +1σ above trailing mean. Rotational, no direction. Fade level touches.\n• EXTREME_CHOP — Rotations at +2σ. Violent, reduce size. Don't hold.\n• BALANCE — VWAP is fair value. Close near VWAP (-2pt avg). Fade any extension.\n• DRIFT_UP/DOWN — Slow directional drift. Lean with drift, expect VWAP reversion.`,
  },
  range: {
    title: 'Session Range',
    body: `High minus low of today's RTH session.\n\nAvg NQ daily range: ~350pt\n• <200pt = Narrow range day. Compression — breakout coming.\n• 200-400pt = Normal.\n• 400-600pt = Wide — volatile session.\n• 600pt+ = Extreme — reduce size, widen stops.`,
  },
  rangePct: {
    title: 'Range Position',
    body: `Where current price sits within today's range.\n\n• 0% = At session low\n• 50% = Middle of range\n• 100% = At session high\n\nClose in top 25%: bullish close → 67% next day up.\nClose in bottom 25%: bearish close → only 40% next day up.\n\nUsed to project tomorrow's overnight inventory (LONG_TRAPPED vs SHORT_TRAPPED).`,
  },
  rotations: {
    title: 'Rotation Count (ATR-scaled, 5-min close-to-close)',
    body: `Meaningful directional swings on 5-min closes. Rotation threshold = 15% of ATR(20), self-calibrating to current volatility.\n\nCHOP/EXTREME_CHOP classification uses σ from trailing 90-day rotation distribution:\n• Within +1σ = Normal. Level fades work.\n• +1σ = CHOP. Take profits quickly. Scalp mode.\n• +2σ = EXTREME_CHOP. Reduce size significantly.\n\nMeasured on 5-min bar closes, not 1-min high/low — counts real directional swings, not bar volatility.`,
  },
  microTrend: {
    title: 'Micro Trend (5-min)',
    body: `Last 10 five-minute bars — are lows rising or falling?\n\n• HIGHER_LOWS (green) — Bullish structure. Dips are being bought. Lean long on pullbacks.\n• LOWER_LOWS (red) — Bearish structure. Rallies are being sold. Lean short on bounces.\n• MIXED — No direction. Rotational. Fade levels both ways.\n\nThis is the short-term momentum read. It shifts faster than session character.`,
  },
  volTrend: {
    title: 'Volume Trend',
    body: `Compares 1st half vs 2nd half of session volume.\n\n• INCREASING — Energy building. Moves have follow-through. Breakouts more likely to hold.\n• DECLINING — Energy fading. Typical afternoon. Fade extensions — breakout attempts will fail.\n• STABLE — Normal volume distribution.\n\nINCREASING in PM is unusual and signals a potential late-day move.`,
  },
  er: {
    title: 'Efficiency Ratio (ER)',
    body: `Net price displacement / total bar-by-bar movement over 30 bars.\n\nMeasures how directional the market is RIGHT NOW:\n\n• ER < 0.15 — Pure chop. Overlapping bars. Fade everything.\n• ER 0.15-0.30 — Choppy. Level fades work (41% WR at levels).\n• ER 0.30-0.50 — Mixed. Normal conditions.\n• ER > 0.50 — Trending. Clean directional bars. Don't fade.\n• ER > 0.70 — Strong trend. Ride it. Fading = getting run over.\n\nUpdates every 60 seconds with live bars.`,
  },
  relVol: {
    title: 'Relative Volume (RVol)',
    body: `Cumulative session volume vs 90-day average for this exact time of day.\n\nALL THRESHOLDS ARE DYNAMIC — σ from time-of-day baseline distribution. No static numbers. As volume patterns shift, thresholds self-calibrate.\n\n• -1σ or below — Low volume. Fade everything. Breakouts fail.\n• Within +/-1σ — Normal range.\n• +1σ — Elevated. More participation. Moves have conviction.\n• +2σ — Extreme. Major event or liquidation. Wide stops.\n\nTime-of-day adjusted — sigma accounts for typical volume at each minute of the session.\n\nNQ averages ~5,600 contracts/min at 9:30, dropping to ~1,000 by lunch.`,
  },
  cumDelta: {
    title: 'Cumulative Delta',
    body: `Estimated net buying vs selling pressure for the session.\n\nALL THRESHOLDS ARE DYNAMIC — σ from trailing 30-day daily cumDelta distribution. No static numbers. Thresholds self-calibrate as market conditions shift.\n\n• Within +/-1σ — Normal range\n• +/-1σ — Moderate directional pressure\n• +/-2σ — Strong pressure (unusual for current environment)\n\nB/S ratio (buy vol / sell vol) is nearly useless — 95% of days fall between 0.95-1.05. Too tight to signal.\n\nDELTA DIVERGENCE — price down but delta positive (or vice versa) does NOT predict next-day direction. It's a same-day absorption read, not a forecasting tool.`,
  },
  flushRisk: {
    title: 'Flush Risk Score',
    body: `Composite score predicting large directional flush days within 48 hours.\n\nALL THRESHOLDS ARE DYNAMIC — each metric triggers at +1σ above its own 90-day rolling mean. No static numbers. As the market environment changes, the thresholds move with it.\n\n5 METRICS (each fires at +1σ):\n• ATR(5)/ATR(20) ratio — PRIMARY. Is recent volatility expanding vs its own history? Flushes are the CLIMAX of expansion cycles.\n• Range σ — is today's range unusually wide vs the trailing distribution?\n• NL30 σ — is the 30-day number line extended vs its own rolling range?\n• Directional streak σ — are consecutive same-direction days unusual vs recent history?\n• Gap instability σ — are overnight gaps more frequent/larger than normal?\n\nSCORE = count of metrics above +1σ (0-5).\n\n• 0-1: LOW — all metrics within normal bounds.\n• 2: MODERATE — some expansion, stay alert.\n• 3+: ELEVATED — multiple σ triggers. Prepare for directional day.\n\nKEY INSIGHT: Flushes come from volatility EXPANSION (ATR ratio climbing), not overextension (price far from mean). The system self-calibrates — what's "elevated" shifts as the market does.`,
  },
  deltaTrend: {
    title: 'Delta Trend (15-bar)',
    body: `Compares buying/selling pressure in the last 15 bars vs the prior 15 bars. Threshold is dynamic — 1σ of today's own non-overlapping 15-bar delta-window distribution, not a static number.\n\n• BUYING — Last 15 bars themselves net positive beyond σ. Real buying pressure right now.\n• SELLING — Last 15 bars themselves net negative beyond σ. Real selling pressure right now.\n• WEAKENING — Still net positive, but decelerating vs the prior window beyond σ. Buyers losing ground, not yet sellers.\n• STRENGTHENING — Still net negative, but decelerating vs the prior window beyond σ. Sellers losing ground, not yet buyers.\n• FLAT — No meaningful shift, or insufficient session data to calibrate σ yet.\n\nHISTORICAL CONTEXT (separate 252-day study, 60-bar last-hour window — not this 15-bar live feed):\nLast-hour buying shift → 71% next day UP (+0.23% avg). Last-hour selling shift → mean reverts (58% next day UP, not down). The 15-bar live feed has not been independently backtested — the 71% stat applies to a 60-bar window only.\n\nThis is the momentum of the momentum — not who's winning overall (Cum Delta), but who's gaining ground RIGHT NOW. If Cum Delta is deeply negative but Delta Trend says BUYING, sellers are exhausting.`,
  },
};

const DELTA_TREND_COLORS = {
  BUYING: '#4ade80',
  STRENGTHENING: '#86efac',
  WEAKENING: '#fca5a5',
  SELLING: '#ef4444',
};
function deltaTrendColor(trend) {
  return DELTA_TREND_COLORS[trend] || '#94a3b8';
}

function MetricModal({ metric, onClose }) {
  if (!metric) return null;
  const info = METRIC_INFO[metric];
  if (!info) return null;
  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: '20px 24px', maxWidth: 480, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{info.title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.8, color: '#cbd5e1', whiteSpace: 'pre-line' }}>{info.body}</div>
      </div>
    </div>
  );
}

export default function LiveScriptsCard({ date }) {
  const [ctx, setCtx] = useState(null);
  const [edgeData, setEdgeData] = useState(null);
  const [flushRisk, setFlushRisk] = useState(null);
  const [activeModal, setActiveModal] = useState(null);

  const fetchData = () => {
    const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/morning-brief/live-session-context/${d}`).then(r => r.json()).then(c => { if (!c?.noData) setCtx(c); }).catch(() => {});
    fetch(`${API_URL}/antigravity/edges-context`).then(r => r.json()).then(setEdgeData).catch(() => {});
    fetch(`${API_URL}/morning-brief/flush-risk/${d}`).then(r => r.json()).then(d => { if (!d.error) setFlushRisk(d); }).catch(() => {});
  };

  useEffect(() => { fetchData(); }, [date]);
  useEffect(() => {
    const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
    if (etH < 8 || etH >= 17) return;
    const interval = setInterval(fetchData, 60000);
    // Refresh immediately when new bars arrive via socket
    const sock = window._tradingSocket;
    if (sock) {
      sock.on('price-sync-progress', fetchData);
      sock.on('setup-detected', fetchData);
    }
    return () => {
      clearInterval(interval);
      if (sock) {
        sock.off('price-sync-progress', fetchData);
        sock.off('setup-detected', fetchData);
      }
    };
  }, [date]);

  if (!ctx) return null;

  const L = ctx;
  const cl = edgeData?.confluenceLevels || {};
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Flush risk is daily-granularity, not intraday-bar — its freshness is the trade date it was computed for
  const flushRiskAsOf = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
  const isMorning = etH < 13;
  const projInventory = L.closeVsOpen < -30 ? 'LONG_TRAPPED' : L.closeVsOpen > 30 ? 'SHORT_TRAPPED' : 'NEUTRAL';
  const projValue = cl.pd1?.vah && L.price > cl.pd1.vah ? 'ABOVE_VALUE' : cl.pd1?.val && L.price < cl.pd1.val ? 'BELOW_VALUE' : 'INSIDE_VALUE';

  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
      {/* Prominent live price header */}
      <div style={{ padding: '10px 14px', background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(34,197,94,0.08))', borderBottom: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: L.closeVsOpen >= 0 ? '#4ade80' : '#f87171' }}>{fmtP(L.price)}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: L.closeVsOpen >= 0 ? '#4ade80' : '#f87171' }}>{L.closeVsOpen >= 0 ? '+' : ''}{L.closeVsOpen}pt</span>
          </div>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{ts}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: '#94a3b8', flexWrap: 'wrap' }}>
          <span onClick={() => setActiveModal('sessionChar')} style={{ color: L.sessionChar === 'EXTREME_CHOP' ? '#ef4444' : L.sessionChar === 'CHOP' ? '#fbbf24' : L.sessionChar.includes('TREND') ? '#4ade80' : '#94a3b8', fontWeight: 700, cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>{L.sessionChar}</span>
          <span onClick={() => setActiveModal('range')} style={{ cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>{L.range}pt range</span>
          <span onClick={() => setActiveModal('rangePct')} style={{ cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>{L.rangePct}% of range</span>
          <span onClick={() => setActiveModal('rotations')} style={{ cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>{L.rots} rots{L.rotSigma != null ? ` (${L.rotSigma > 0 ? '+' : ''}${L.rotSigma}σ)` : ''}</span>
          <span onClick={() => setActiveModal('microTrend')} style={{ color: L.microTrend === 'HIGHER_LOWS' ? '#4ade80' : L.microTrend === 'LOWER_LOWS' ? '#f87171' : '#94a3b8', cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>{L.microTrend}</span>
          <span onClick={() => setActiveModal('volTrend')} style={{ cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>Vol {L.volTrend}</span>
          {L.relVol && <span onClick={() => setActiveModal('relVol')} style={{ cursor: 'pointer', borderBottom: '1px dotted #64748b', color: (L.relVol.sigma || 0) >= 2 ? '#fbbf24' : (L.relVol.sigma || 0) >= 1 ? '#4ade80' : (L.relVol.sigma || 0) <= -1 ? '#f87171' : '#94a3b8', fontWeight: (L.relVol.sigma || 0) >= 1 ? 700 : 400 }}>RVol {L.relVol.ratio}x</span>}
          {L.efficiencyRatio != null && <span onClick={() => setActiveModal('er')} style={{ color: L.efficiencyRatio > 0.5 ? '#4ade80' : L.efficiencyRatio < 0.2 ? '#fbbf24' : '#94a3b8', cursor: 'pointer', borderBottom: '1px dotted #64748b' }}>ER {L.efficiencyRatio}</span>}
        </div>
      </div>

      {/* VWAP σ Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '8px 14px', borderBottom: '1px solid #1e293b' }}>
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, borderLeft: `3px solid ${Math.abs(L.dailyVwapSigma || 0) >= 2 ? '#fbbf24' : Math.abs(L.dailyVwapSigma || 0) >= 1 ? '#fb923c' : '#94a3b8'}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>RTH VWAP</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: Math.abs(L.dailyVwapSigma || 0) >= 2 ? '#fbbf24' : '#cbd5e1' }}>
            {L.dailyVwapSigma != null ? `${L.dailyVwapSigma > 0 ? '+' : ''}${L.dailyVwapSigma}σ` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtP(L.vwap)} ({L.vwapDist > 0 ? '+' : ''}{L.vwapDist}pt)</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, borderLeft: `3px solid ${Math.abs(L.vwap24Sigma || 0) >= 2 ? '#fbbf24' : Math.abs(L.vwap24Sigma || 0) >= 1 ? '#fb923c' : '#94a3b8'}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>24HR VWAP</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: Math.abs(L.vwap24Sigma || 0) >= 2 ? '#fbbf24' : '#cbd5e1' }}>
            {L.vwap24Sigma != null ? `${L.vwap24Sigma > 0 ? '+' : ''}${L.vwap24Sigma}σ` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{L.vwap24 ? `${fmtP(L.vwap24)} (${L.vwap24Dist > 0 ? '+' : ''}${L.vwap24Dist}pt)` : '—'}</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, borderLeft: `3px solid ${Math.abs(L.weeklyVwapSigma || 0) >= 2 ? '#ef4444' : Math.abs(L.weeklyVwapSigma || 0) >= 1 ? '#fb923c' : '#94a3b8'}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>Weekly VWAP</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: Math.abs(L.weeklyVwapSigma || 0) >= 2 ? '#ef4444' : '#cbd5e1' }}>
            {L.weeklyVwapSigma != null ? `${L.weeklyVwapSigma > 0 ? '+' : ''}${L.weeklyVwapSigma}σ` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{L.weeklyVwap ? `${fmtP(L.weeklyVwap)} (${L.weeklyVwapSigma != null && L.weeklyVwapStd ? Math.round(L.weeklyVwapSigma * L.weeklyVwapStd) + 'pt' : L.weeklyVwapSigma != null ? Math.round(L.weeklyVwapSigma * 251) + 'pt' : '—'})` : '—'}</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
      </div>

      {/* Volume & Delta Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '8px 14px', borderBottom: '1px solid #1e293b' }}>
        {/* RVol card */}
        <div onClick={() => setActiveModal('relVol')} style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, cursor: 'pointer', borderLeft: `3px solid ${!L.relVol ? '#94a3b8' : (L.relVol.sigma || 0) >= 2 ? '#fbbf24' : (L.relVol.sigma || 0) >= 1 ? '#4ade80' : (L.relVol.sigma || 0) <= -1 ? '#60a5fa' : '#94a3b8'}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>Rel Volume</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: !L.relVol ? '#94a3b8' : (L.relVol.sigma || 0) >= 2 ? '#fbbf24' : (L.relVol.sigma || 0) >= 1 ? '#4ade80' : '#cbd5e1' }}>
            {L.relVol ? `${L.relVol.ratio}x` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{L.relVol ? `${L.relVol.label || ((L.relVol.sigma || 0) >= 1 ? 'Elevated' : (L.relVol.sigma || 0) <= -1 ? 'Low' : 'Normal')} (${L.relVol.sigma != null ? (L.relVol.sigma > 0 ? '+' : '') + L.relVol.sigma + 'σ' : '—'})` : '—'}</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
        {/* Cumulative Delta card */}
        <div onClick={() => setActiveModal('cumDelta')} style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, cursor: 'pointer', borderLeft: `3px solid ${!L.delta ? '#94a3b8' : Math.abs(L.delta.sigma || 0) >= 2 ? (L.delta.cumDelta > 0 ? '#4ade80' : '#ef4444') : Math.abs(L.delta.sigma || 0) >= 1 ? (L.delta.cumDelta > 0 ? '#86efac' : '#fca5a5') : '#94a3b8'}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>Cum Delta</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: !L.delta ? '#94a3b8' : Math.abs(L.delta.sigma || 0) >= 2 ? (L.delta.cumDelta > 0 ? '#4ade80' : '#ef4444') : Math.abs(L.delta.sigma || 0) >= 1 ? (L.delta.cumDelta > 0 ? '#86efac' : '#fca5a5') : '#cbd5e1' }}>
            {L.delta ? `${L.delta.cumDelta > 0 ? '+' : ''}${(L.delta.cumDelta / 1000).toFixed(1)}K` : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{L.delta ? `${L.delta.label || 'Normal'} (${L.delta.sigma != null ? (L.delta.sigma > 0 ? '+' : '') + L.delta.sigma + 'σ' : '—'})` : '—'}</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
        {/* Delta Trend card */}
        <div onClick={() => setActiveModal('deltaTrend')} style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, cursor: 'pointer', borderLeft: `3px solid ${!L.delta ? '#94a3b8' : deltaTrendColor(L.delta.trend)}` }}>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>Delta Trend</div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'monospace', color: !L.delta ? '#94a3b8' : deltaTrendColor(L.delta.trend) }}>
            {L.delta?.trend || '—'}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{L.delta ? `Last 15 vs prior 15 bars` : '—'}</div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {fmtEtTime(L.etMin) || '—'}</div>
        </div>
      </div>

      {/* Delta Flow Bar Chart — 15-min phases showing buying/selling story */}
      {L.deltaFlow && L.deltaFlow.length > 1 && (() => {
        const flow = L.deltaFlow;
        const maxAbs = Math.max(...flow.map(p => Math.abs(p.delta)), 1);
        const barW = Math.max(6, Math.floor((100 / flow.length) - 1));
        return (
          <div style={{ padding: '6px 14px 8px', borderBottom: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Delta Flow (15-min)
              </span>
              <span style={{ fontSize: 9, color: '#475569' }}>as of {fmtEtTime(L.etMin) || '—'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 1, height: 48 }}>
              {flow.map((p, i) => {
                const pct = Math.abs(p.delta) / maxAbs;
                const h = Math.max(2, Math.round(pct * 40));
                const isUp = p.delta >= 0;
                const clr = Math.abs(p.delta) > maxAbs * 0.6
                  ? (isUp ? '#4ade80' : '#ef4444')
                  : Math.abs(p.delta) > maxAbs * 0.25
                    ? (isUp ? '#86efac80' : '#fca5a580')
                    : '#64748b60';
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, height: '100%', justifyContent: 'flex-end' }}
                    title={`${p.time} ET | Delta: ${p.delta > 0 ? '+' : ''}${(p.delta/1000).toFixed(1)}K | Price: ${p.close}`}>
                    <div style={{
                      width: `${barW}%`, minWidth: 4, height: h,
                      background: clr, borderRadius: '2px 2px 0 0',
                    }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>{flow[0]?.time}</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>{flow[Math.floor(flow.length/2)]?.time}</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>{flow[flow.length-1]?.time}</span>
            </div>
          </div>
        );
      })()}

      {/* Flush Risk Card */}
      {flushRisk && flushRisk.score != null && (
        <div onClick={() => setActiveModal('flushRisk')} style={{
          padding: '8px 14px', borderBottom: '1px solid #1e293b', cursor: 'pointer',
          background: flushRisk.score >= 4 ? 'rgba(239,68,68,0.08)' : flushRisk.score >= 3 ? 'rgba(251,146,60,0.06)' : 'transparent',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: flushRisk.color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Flush Risk
              </span>
              <span style={{ fontSize: 16, fontWeight: 900, fontFamily: 'monospace', color: flushRisk.color }}>
                {flushRisk.score}/{flushRisk.maxScore}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: flushRisk.color }}>{flushRisk.label}</span>
            </div>
            <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>{flushRisk.probability}% within 48hr</span>
          </div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>as of {flushRiskAsOf}</div>
          {flushRisk.triggers.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              {flushRisk.triggers.map((t, i) => (
                <span key={i} style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                  background: t.weight === 'PRIMARY' ? `${flushRisk.color}20` : 'rgba(51,65,85,0.4)',
                  color: t.weight === 'PRIMARY' ? flushRisk.color : '#94a3b8',
                  fontWeight: t.weight === 'PRIMARY' ? 700 : 400,
                }}>
                  {t.name}: {t.value}
                </span>
              ))}
            </div>
          )}
          {flushRisk.score >= 3 && flushRisk.notes?.[0] && (
            <div style={{ fontSize: 12, color: flushRisk.color, marginTop: 4, fontWeight: 600 }}>
              {flushRisk.notes[flushRisk.notes.length - 1]}
            </div>
          )}
        </div>
      )}

      {/* VWAP behavior context based on session type */}
      {L.sessionChar && L.sessionChar !== 'DEVELOPING' && (
        <div style={{ padding: '4px 14px', borderBottom: '1px solid #1e293b', fontSize: 12, color: '#94a3b8' }}>
          {L.sessionChar === 'TREND_UP' && '📈 TREND UP — price above VWAP 87% of day. Buy dips TO VWAP, never fade it.'}
          {L.sessionChar === 'TREND_DOWN' && '📉 TREND DOWN — price below VWAP 86% of day. Short rallies TO VWAP, never buy.'}
          {(L.sessionChar === 'CHOP' || L.sessionChar === 'EXTREME_CHOP') && '🔀 CHOP — fade 50-100pt VWAP extensions. Crosses are noise (57% revert). Don\'t hold.'}
          {L.sessionChar === 'BALANCE' && '⚖️ BALANCE — VWAP IS fair value (close -2pt avg). Fade any extension.'}
          {L.sessionChar === 'DRIFT_UP' && '↗️ DRIFT UP — lean long, expect reversion to VWAP on pullbacks.'}
          {L.sessionChar === 'DRIFT_DOWN' && '↘️ DRIFT DOWN — lean short, expect reversion to VWAP on rallies.'}
          {Math.abs(L.weeklyVwapSigma || 0) >= 1.8 && <span style={{ color: '#ef4444', fontWeight: 700 }}> · Weekly VWAP {L.weeklyVwapSigma > 0 ? '+' : ''}{L.weeklyVwapSigma}σ — 91% next-day reversion at 2σ.</span>}
        </div>
      )}

      {/* Morning Script */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e293b' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          Morning Script (Open — 12:00 PM)
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.9, color: '#e2e8f0' }}>
          <div>1. <strong style={{ color: '#818cf8' }}>Session: {L.sessionChar}.</strong>{' '}
            {L.sessionChar === 'EXTREME_CHOP' && `${L.rots} rotations (+2σ). EXTREME chop — reduce size, don't hold.`}
            {L.sessionChar === 'CHOP' && `${L.rots} rotations (+1σ). Level fades are your play. Scalp the edges.`}
            {L.sessionChar === 'TREND_UP' && `+${L.closeVsOpen}pt from open, ${L.rangePct}% of range. Buy dips at levels.`}
            {L.sessionChar === 'TREND_DOWN' && `${L.closeVsOpen}pt from open. Fade rallies to levels.`}
            {L.sessionChar === 'BALANCE' && `Balanced. Level fades highest probability (79% WR).`}
            {L.sessionChar === 'TIGHT_IB' && `Tight IB (${L.ibRange}pt). Breakout expansion likely.`}
            {L.sessionChar === 'WIDE_IB' && `Wide IB (${L.ibRange}pt). Fade IB extremes.`}
            {L.sessionChar === 'DEVELOPING' && `OR setting up. Wait for IB close at 10:30.`}
          </div>
          <div>2. <strong style={{ color: '#818cf8' }}>VWAP: {fmtP(L.vwap)} ({L.vwapDist > 0 ? '+' : ''}{L.vwapDist}pt).</strong>{' '}
            {Math.abs(L.vwapDist) >= 50 ? 'Extended — VWAP magnet fade in play (62% WR).' : 'Near VWAP. No magnet trade.'}
          </div>
          <div>3. <strong style={{ color: '#818cf8' }}>POC: {fmtP(L.poc)} ({L.pocDist > 0 ? '+' : ''}{L.pocDist}pt).</strong>{' '}
            {Math.abs(L.pocDist) > 60 ? `Detached — expect pull toward ${fmtP(L.poc)}.` : 'Near POC. Value acceptance.'}
          </div>
          {L.ibRange && <div>4. <strong style={{ color: '#818cf8' }}>IB: {fmtP(L.ibL)}—{fmtP(L.ibH)} ({L.ibRange}pt) {L.ibBroken !== 'INSIDE' ? `BROKEN ${L.ibBroken}` : 'Holding'}.</strong></div>}
          {L.nearLevels?.length > 0 && <div>5. <strong style={{ color: '#818cf8' }}>Nearby:</strong> {L.nearLevels.map(l => `${l.name} ${fmtP(l.price)} (${l.dist > 0 ? '+' : ''}${l.dist}pt)`).join(', ')}</div>}
          {L.activeSetups?.length > 0 && <div style={{ color: '#4ade80' }}><strong>Active:</strong> {L.activeSetups.join(', ')}</div>}
        </div>
      </div>

      {/* Afternoon Script */}
      <div style={{ padding: '10px 14px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          Afternoon Script (1:00 PM — Close)
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.9, color: '#e2e8f0' }}>
          <div>1. <strong style={{ color: '#f59e0b' }}>Session: {L.sessionChar}.</strong>{' '}
            {L.sessionChar === 'EXTREME_CHOP' && `${L.rots} rotations (+2σ). EXTREME — sit out or fade POC at ${fmtP(L.poc)} with tiny size.`}
            {L.sessionChar === 'CHOP' && `${L.rots} rotations. Afternoon will contract — fade toward POC at ${fmtP(L.poc)}.`}
            {L.sessionChar === 'TREND_UP' && `Trend intact. Pullbacks to VWAP (${fmtP(L.vwap)}) are buys.`}
            {L.sessionChar === 'TREND_DOWN' && `Selling. Rallies to VWAP (${fmtP(L.vwap)}) are shorts.`}
            {L.sessionChar === 'BALANCE' && `POC at ${fmtP(L.poc)} is the afternoon magnet.`}
            {(L.sessionChar === 'WIDE_IB' || L.sessionChar === 'TIGHT_IB' || L.sessionChar === 'DEVELOPING') && `POC at ${fmtP(L.poc)} is the magnet.`}
          </div>
          <div>2. <strong style={{ color: '#f59e0b' }}>Volume: {L.volTrend}.</strong>{' '}
            {L.volTrend === 'DECLINING' ? 'Fading — fade extensions.' : L.volTrend === 'INCREASING' ? 'Increasing — stay alert for late move.' : 'Steady.'}
          </div>
          <div>3. <strong style={{ color: '#f59e0b' }}>Close projection:</strong> {L.rangePct}% of range.{' '}
            {projValue === 'ABOVE_VALUE' && <span>→ <strong style={{ color: '#4ade80' }}>ABOVE VALUE</strong> tomorrow.</span>}
            {projValue === 'BELOW_VALUE' && <span>→ <strong style={{ color: '#f87171' }}>BELOW VALUE</strong> tomorrow. IB_BEARISH 88% WR.</span>}
            {projValue === 'INSIDE_VALUE' && <span>→ <strong style={{ color: '#94a3b8' }}>NEUTRAL</strong> tomorrow.</span>}
          </div>
          <div>4. <strong style={{ color: '#f59e0b' }}>Inventory:</strong> {L.closeVsOpen > 0 ? '+' : ''}{L.closeVsOpen}pt vs open →{' '}
            {projInventory === 'LONG_TRAPPED' && <strong style={{ color: '#f87171' }}>LONG_TRAPPED</strong>}
            {projInventory === 'SHORT_TRAPPED' && <strong style={{ color: '#4ade80' }}>SHORT_TRAPPED</strong>}
            {projInventory === 'NEUTRAL' && <strong style={{ color: '#94a3b8' }}>NEUTRAL</strong>}
          </div>
        </div>
      </div>
      <MetricModal metric={activeModal} onClose={() => setActiveModal(null)} />
    </div>
  );
}
