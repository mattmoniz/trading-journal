import React, { useState, useEffect } from 'react';

const API_URL = '/api';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function LiveScriptsCard({ date }) {
  const [ctx, setCtx] = useState(null);
  const [edgeData, setEdgeData] = useState(null);

  const fetchData = () => {
    const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    fetch(`${API_URL}/morning-brief/live-session-context/${d}`).then(r => r.json()).then(c => { if (!c?.noData) setCtx(c); }).catch(() => {});
    fetch(`${API_URL}/antigravity/edges-context`).then(r => r.json()).then(setEdgeData).catch(() => {});
  };

  useEffect(() => { fetchData(); }, [date]);
  useEffect(() => {
    const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
    if (etH < 9 || etH >= 16) return;
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [date]);

  if (!ctx) return null;

  const L = ctx;
  const cl = edgeData?.confluenceLevels || {};
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
          <span style={{ fontSize: 9, color: '#64748b' }}>{ts}</span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11, color: '#94a3b8', flexWrap: 'wrap' }}>
          <span title={`Session character: ${L.sessionChar}.\nCHOP = rotational, fade levels.\nTREND_UP/DOWN = directional, don't fade.\nBALANCE = VWAP is fair value.\nEXTREME_CHOP = violent rotations, reduce size.`} style={{ color: L.sessionChar === 'CHOP' ? '#fbbf24' : L.sessionChar.includes('TREND') ? '#4ade80' : '#94a3b8', fontWeight: 700, cursor: 'help' }}>{L.sessionChar}</span>
          <span title={`Today's session range from high to low.\nAvg NQ daily range ~350pt.\n<200pt = narrow, >500pt = wide/volatile.`} style={{ cursor: 'help' }}>{L.range}pt range</span>
          <span title={`Current price position within today's range.\n0% = at session low, 100% = at session high.\n<25% = lower quarter (bearish close forming).\n>75% = upper quarter (bullish close forming).`} style={{ cursor: 'help' }}>{L.rangePct}% of range</span>
          <span title={`65pt+ rotations today.\n<10 = quiet/trending day.\n15-25 = normal chop.\n25+ = extreme chop, reduce size.\n40+ = violent — sit on hands.`} style={{ cursor: 'help' }}>{L.rots} rotations</span>
          <span title={`5-min micro trend (last 10 bars).\nHIGHER_LOWS = bullish structure, dips are bought.\nLOWER_LOWS = bearish structure, rallies are sold.\nMIXED = no direction, rotational.`} style={{ color: L.microTrend === 'HIGHER_LOWS' ? '#4ade80' : L.microTrend === 'LOWER_LOWS' ? '#f87171' : '#94a3b8', cursor: 'help' }}>{L.microTrend}</span>
          <span title={`Volume trend (1st half vs 2nd half of session).\nINCREASING = energy building, moves have follow-through.\nDECLINING = energy fading, breakouts will fail.\nSTABLE = normal volume.`} style={{ cursor: 'help' }}>Vol {L.volTrend}</span>
          {L.efficiencyRatio != null && <span title={`Efficiency Ratio (30-bar rolling).\nMeasures directional conviction: net move / total move.\nER < 0.2 = choppy, overlapping bars. Fade levels.\nER 0.2-0.5 = mixed, normal.\nER > 0.5 = trending, clean moves. Don't fade.\nER > 0.7 = strong trend, ride it.`} style={{ color: L.efficiencyRatio > 0.5 ? '#4ade80' : L.efficiencyRatio < 0.2 ? '#fbbf24' : '#94a3b8', cursor: 'help' }}>ER {L.efficiencyRatio}</span>}
        </div>
      </div>

      {/* VWAP σ Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 14px', borderBottom: '1px solid #1e293b' }}>
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, borderLeft: `3px solid ${Math.abs(L.dailyVwapSigma || 0) >= 2 ? '#fbbf24' : Math.abs(L.dailyVwapSigma || 0) >= 1 ? '#fb923c' : '#64748b'}` }}>
          <div style={{ fontSize: 9, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>Daily VWAP</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: Math.abs(L.dailyVwapSigma || 0) >= 2 ? '#fbbf24' : '#cbd5e1' }}>
            {L.dailyVwapSigma != null ? `${L.dailyVwapSigma > 0 ? '+' : ''}${L.dailyVwapSigma}σ` : '—'}
          </div>
          <div style={{ fontSize: 10, color: '#64748b' }}>{fmtP(L.vwap)} ({L.vwapDist > 0 ? '+' : ''}{L.vwapDist}pt)</div>
        </div>
        <div style={{ padding: '6px 8px', background: 'rgba(30,41,59,0.3)', borderRadius: 4, borderLeft: `3px solid ${Math.abs(L.weeklyVwapSigma || 0) >= 2 ? '#ef4444' : Math.abs(L.weeklyVwapSigma || 0) >= 1 ? '#fb923c' : '#64748b'}` }}>
          <div style={{ fontSize: 9, color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>Weekly VWAP</div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: Math.abs(L.weeklyVwapSigma || 0) >= 2 ? '#ef4444' : '#cbd5e1' }}>
            {L.weeklyVwapSigma != null ? `${L.weeklyVwapSigma > 0 ? '+' : ''}${L.weeklyVwapSigma}σ` : '—'}
          </div>
          <div style={{ fontSize: 10, color: '#64748b' }}>{L.weeklyVwap ? `${fmtP(L.weeklyVwap)} (${L.weeklyVwapSigma != null ? Math.round(L.weeklyVwapSigma * 251) + 'pt' : '—'})` : '—'}</div>
        </div>
      </div>

      {/* VWAP behavior context based on session type */}
      {L.sessionChar && L.sessionChar !== 'DEVELOPING' && (
        <div style={{ padding: '4px 14px', borderBottom: '1px solid #1e293b', fontSize: 10, color: '#94a3b8' }}>
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
        <div style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          Morning Script (Open — 12:00 PM)
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.7, color: '#cbd5e1' }}>
          <div>1. <strong style={{ color: '#818cf8' }}>Session: {L.sessionChar}.</strong>{' '}
            {L.sessionChar === 'CHOP' && `${L.rots} rotations. Level fades are your play. Scalp the edges.`}
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
        <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          Afternoon Script (1:00 PM — Close)
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.7, color: '#cbd5e1' }}>
          <div>1. <strong style={{ color: '#f59e0b' }}>Session: {L.sessionChar}.</strong>{' '}
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
    </div>
  );
}
