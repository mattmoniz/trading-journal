import React, { useState, useEffect, useRef } from 'react';
import { usePollData } from '../../utils/usePollData.js';
const fmtP = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtTime = (iso) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return null; }
};

import { API_URL } from '../../constants/api.js';

function buildFeed({ liveStatus, setups, limits, tradeBacktest }) {
  const feed = [];

  const monStats = tradeBacktest?.allTime?.dowStats?.[1] || { winRate: 40.0, avgPnl: -339 };
  const friStats = tradeBacktest?.allTime?.dowStats?.[5] || { winRate: 36.4, avgPnl: 374 };
  const monWinRate = monStats.winRate;
  const monAvgPnl = monStats.avgPnl;
  const friRedRate = 100 - friStats.winRate;

  const todayETStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const targetDateStr = setups?.isFallback ? todayETStr : (setups?.date || liveStatus?.date || todayETStr);
  const parts = targetDateStr.split('-');
  const targetD = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
  const dayOfWeek = targetD.getDay();

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowETStr = `${String(nowET.getHours()).padStart(2, '0')}:${String(nowET.getMinutes()).padStart(2, '0')}:${String(nowET.getSeconds()).padStart(2, '0')}`;
  const isLive = liveStatus?.active && liveStatus?.isLive;
  const shouldShowEvent = (eventTime) => !isLive || eventTime <= nowETStr;

  // Pre-market prep
  let prepText = '';
  if (dayOfWeek === 1) prepText = `Monday Mean Reversion Protocol active. Mondays have a historical ${monWinRate.toFixed(1)}% win rate (${monAvgPnl < 0 ? '-' : ''}$${fmtP(Math.abs(monAvgPnl))} avg P&L). Standard breakout plays have an extremely high failure rate. Focus strictly on fading early range extensions. Risk parameters: 50% max sizing.`;
  else if (dayOfWeek === 5) prepText = `Friday Capital Preservation Protocol active. Fridays carry a ${friRedRate.toFixed(1)}% historical red rate. Focus on morning Gap Fills only. Hard rule: Shut down screens by 12:30 PM ET regardless of P&L.`;
  else if (dayOfWeek === 2 || dayOfWeek === 4) prepText = `${dayOfWeek === 2 ? 'Tuesday' : 'Thursday'} Trend Sweet Spot Playbook active. Mid-week liquidity days with clean, sustained trend characteristics. Standard sizing and breakout/continuation plays fully authorized.`;
  else if (dayOfWeek === 3) prepText = "Wednesday Trend Continuation Playbook active. Strong tendency for morning momentum to continue into the PM close. Ride early drives and avoid counter-trend fading before 1:30 PM.";
  else prepText = "Weekend Prep Protocol active. Market closed. Review current playbook metrics and verify setup detections in the Chart Review sub-tab.";
  if (shouldShowEvent("08:30:00")) feed.push({ time: "08:30:00", type: "system", text: prepText });

  if (liveStatus?.active) {
    const openPrice = liveStatus.currentPrice ? fmtP(liveStatus.currentPrice - (liveStatus.gapOpenValue || 0), 2) : '—';
    let openText = `RTH Market Open: NQ opened at ${openPrice}. Gap Status: ${liveStatus.gapStatus === 'INSIDE' ? 'Inside Range' : 'GAP ' + liveStatus.gapStatus} (${liveStatus.gapOpenValue?.toFixed(1) || 0} pts). `;
    if (liveStatus.gapStatus === 'UP') openText += "Upside gap — 66% stat probability of filling back to yesterday's High. Fade early drives that sweep highs and reject.";
    else if (liveStatus.gapStatus === 'DOWN') openText += "Downside gap — 69% stat probability of filling back to yesterday's Low. Watch for exhaustion on early drives.";
    else openText += "Inside yesterday's range. Responsive value area trading active. Failed sweeps of VA boundaries are primary fade setups.";
    if (shouldShowEvent("09:30:00")) feed.push({ time: "09:30:00", type: "info", text: openText });

    if (liveStatus.or5Range != null) {
      let or5Text = `OR5 established: ${liveStatus.or5Range.toFixed(1)} pts — ${liveStatus.or5Status}. `;
      if (liveStatus.or5Status === 'WIDE') or5Text += `WIDE (>= ${limits?.Q4_LIMIT || 91.5} pts). Breakout follow-through historically poor. Seek pullbacks and fades only.`;
      else if (liveStatus.or5Status === 'TIGHT') or5Text += `TIGHT (< ${limits?.Q1_LIMIT || 47.5} pts). Breakout follow-through elevated. Watch range extremes for high-momentum drive.`;
      else or5Text += "Normal range. Standard playbook applies.";
      if (shouldShowEvent("09:35:00")) feed.push({ time: "09:35:00", type: "info", text: or5Text });
    }

    if (shouldShowEvent("10:00:00")) feed.push({ time: "10:00:00", type: "system", text: "Institutional Sweep Window: 9:55–10:05 AM pivot zone. Retail morning drives often exhaust here. Sweeps of session extreme on decreasing volume are prime reversal setups." });

    if (liveStatus.firstHourStats) {
      const fhs = liveStatus.firstHourStats;
      let textureText = `First Hour Texture: IB range ~${fhs.avgRange ? (fhs.avgRange * 6).toFixed(1) : '0'} pts. Efficiency ${fhs.efficiency}, Choppiness ${fhs.choppinessIndex}, Reversals ${fhs.reversalRate}%. `;
      if (fhs.efficiency < 0.25 && fhs.choppinessIndex > 60) textureText += "Highly choppy — breakouts have high failure rate. Fade extremes.";
      else if (fhs.efficiency >= 0.38 && fhs.choppinessIndex < 50) textureText += "Efficient, trending — breakout/pullback plays statistically favored.";
      else textureText += "Mixed texture — standard risk parameters, no strong structural bias.";
      if (shouldShowEvent("10:30:00")) feed.push({ time: "10:30:00", type: "info", text: textureText });
    }

    let middayText = '';
    if (dayOfWeek === 5) middayText = "12:30 PM Friday Shutdown Lock: Behavioral decay window active. Flatten all positions and shut down screens. Capital preservation is the edge now.";
    else if (dayOfWeek === 1) middayText = "Midday Monday: Monday chop still elevated. Turn off breakouts. Protect morning cushion.";
    else middayText = "Midday: Liquidity drops 12:00–13:30 ET. Avoid new positions inside value areas. Let morning setups resolve.";
    if (shouldShowEvent("12:30:00")) feed.push({ time: "12:30:00", type: "system", text: middayText });

    let pmText = dayOfWeek === 3
      ? "Wednesday PM Trend Check: Strong tendency to close in morning's direction. Do not fade a strong trend in the final hour."
      : "Power Hour: Institutional book-squaring active. Keep risk tight and manage any open runners.";
    if (shouldShowEvent("15:30:00")) feed.push({ time: "15:30:00", type: "system", text: pmText });
  }

  // Volume climax
  if (isLive && liveStatus?.volumeClimax?.active) {
    const vc = liveStatus.volumeClimax;
    const nowStr = `${String(nowET.getHours()).padStart(2, '0')}:${String(nowET.getMinutes()).padStart(2, '0')}:${String(nowET.getSeconds()).padStart(2, '0')}`;
    const dirText = vc.barDir === 'up' ? 'buying climax' : vc.barDir === 'down' ? 'selling climax' : 'volume climax';
    const levelText = vc.nearLevel ? ` at ${vc.nearLevel.label} (${vc.nearLevel.dist} pts away)` : '';
    const actionText = vc.barDir === 'up' ? 'Large sellers absorbing the drive. Watch for rejection and fade opportunity if price stalls.' : vc.barDir === 'down' ? 'Large buyers absorbing the drop. Watch for exhaustion and long opportunity if price stabilizes.' : 'Institutional activity detected. Watch for directional resolution.';
    feed.push({ time: nowStr, type: 'warning', text: `VOLUME CLIMAX: ${vc.ratio}x normal volume (${vc.volume.toLocaleString()} vs ${vc.avgVolume.toLocaleString()} avg)${levelText} — ${dirText}. ${actionText}` });
  }

  // Coil alerts
  if (isLive && liveStatus?.coiling?.active) {
    const coil = liveStatus.coiling;
    const nowStr = `${String(nowET.getHours()).padStart(2, '0')}:${String(nowET.getMinutes()).padStart(2, '0')}:${String(nowET.getSeconds()).padStart(2, '0')}`;
    const activeSetups = setups?.list?.filter(s => s.status === 'ACTIVE').length || 0;
    const volCtx = coil.volRatio != null ? `${coil.volRatio}% of baseline` : `${coil.avgVolume} contracts/min`;
    const levelStr = (lvl) => lvl ? ` [${lvl.label} ${lvl.dist === 0 ? 'AT' : lvl.dist + ' pts from'} ${lvl.value}]` : '';
    const highCtx = levelStr(coil.highLevel), lowCtx = levelStr(coil.lowLevel);
    const levelSummary = (coil.highLevel || coil.lowLevel) ? ` Key levels: HIGH${highCtx || ' (open air)'}  |  LOW${lowCtx || ' (open air)'}.` : '';
    const triggerNote = (coil.highLevel || coil.lowLevel) ? ` Wait for a pop AT the level, not before.` : ` No key level at either boundary — lower-conviction pop setup.`;
    if (coil.popSurge) {
      const popBoundary = coil.popDir === 'high' ? coil.high : coil.low;
      const popLevel = coil.popDir === 'high' ? coil.highLevel : coil.lowLevel;
      const popLevelStr = popLevel ? ` (${popLevel.label} ${popLevel.dist === 0 ? 'confluence' : popLevel.dist + ' pts'})` : '';
      feed.push({ time: nowStr, type: 'danger', text: `POP TRIGGER: Volume surge (${coil.volSurgeRatio}x) at coil ${coil.popDir === 'high' ? 'HIGH' : 'LOW'} (${popBoundary})${popLevelStr}. Watch for 1-min close outside ${coil.low}–${coil.high}.` });
    }
    if (activeSetups === 0) {
      let coilText;
      if (coil.coilPhase === 'optimal') coilText = `COILING (${coil.durationBars} min): ${coil.range}-pt range (${coil.low}–${coil.high}), volume ${volCtx}. Sweet spot — release probable in next ${Math.max(1, 15 - coil.durationBars)} min.${levelSummary}${triggerNote}`;
      else if (coil.coilPhase === 'stale') coilText = `COIL STALE (${coil.durationBars} min): ${coil.range}-pt coil >20 min. Transitioning to dead-zone drift.${levelSummary}`;
      else coilText = `COILING NASCENT (${coil.durationBars} min): Early compression inside ${coil.low}–${coil.high}, volume ${volCtx}. Wait for 5+ min confirmed compression.${levelSummary}`;
      feed.push({ time: nowStr, type: 'warning', text: coilText });
    }
  }

  // Setup fired / resolved events
  if (setups?.list) {
    for (const s of setups.list) {
      if (s.status === 'SHADOW') continue;
      const firedTime = fmtTime(s.fired_at);
      if (firedTime) {
        const wr = s.history?.winRate ?? s.win_rate;
        const n  = s.history?.occurrences ?? s.occurrences;
        const ev = s.history?.avgPnl ?? s.avg_pnl;
        const sizeMult = s.sizeMultiplier ?? 1.0;
        const adjWr = wr != null ? Math.min(wr * (sizeMult > 1 ? 1.05 : sizeMult < 0.5 ? 0.92 : 1), 0.99) : null;
        const confidence = sizeMult >= 1.3 ? 'HIGH' : sizeMult >= 0.9 ? 'MEDIUM' : 'LOW';
        const rec = sizeMult >= 1.3 ? 'Size up — multiple confirming factors.' : sizeMult <= 0.3 ? 'Reduce size — adverse conditions.' : 'Standard context — no significant adjustments.';
        const entryLow = s.entry_zone_low ?? s.entry;
        const entryHigh = s.entry_zone_high ?? s.entry;
        const stop = s.stop_price ?? s.stop;
        const target = s.target_price ?? s.target;
        let text = `Setup Fired: ${s.setup_type} detected. Entry zone: ${fmtP(entryLow, 2)} – ${fmtP(entryHigh, 2)}.`;
        if (stop != null) text += ` Stop Loss: ${fmtP(stop, 2)}.`;
        if (target != null) text += ` Target: ${fmtP(target, 2)}.`;
        if (wr != null) text += ` Baseline WR: ${(wr * 100).toFixed(1)}% (N=${n ?? '—'}).`;
        if (adjWr != null) text += ` Adjusted WR: ${(adjWr * 100).toFixed(1)}% (Confidence: ${confidence}).`;
        text += ` Recommendation: ${rec}`;
        feed.push({ time: firedTime, type: 'fired', text });
      }
      if (s.resolution && (s.resolved_at || s.resolvedAt)) {
        const resolvedTime = fmtTime(s.resolved_at || s.resolvedAt);
        if (resolvedTime) {
          const isStop = s.resolution === 'STOP_HIT';
          feed.push({ time: resolvedTime, type: isStop ? 'stop_hit' : 'target_hit', text: `Setup Resolved: ${s.setup_type} hit ${isStop ? 'Stop Loss' : 'Target'}.` });
        }
      }
    }
  }

  return feed.sort((a, b) => b.time.localeCompare(a.time));
}

const TYPE_META = {
  fired:      { icon: '●', color: '#f97316', dim: '#7c3200' },
  stop_hit:   { icon: '✕', color: '#f87171', dim: '#7f1d1d' },
  target_hit: { icon: '✓', color: '#4ade80', dim: '#14532d' },
  warning:    { icon: '⚠', color: '#fbbf24', dim: '#78350f' },
  danger:     { icon: '⚡', color: '#f87171', dim: '#7f1d1d' },
  info:       { icon: '▶', color: '#38bdf8', dim: '#0c4a6e' },
  system:     { icon: '·', color: '#94a3b8', dim: 'transparent' },
};

function FeedItem({ item }) {
  const meta = TYPE_META[item.type] || TYPE_META.system;
  return (
    <div style={{
      display: 'flex', gap: 0, alignItems: 'baseline',
      padding: '5px 14px',
      borderBottom: '1px solid rgba(255,255,255,0.03)',
      fontFamily: '"Roboto Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.5,
    }}>
      <span style={{ color: meta.color, fontWeight: 700, whiteSpace: 'nowrap', marginRight: 8 }}>
        [{item.time}]
      </span>
      <span style={{ color: meta.color, marginRight: 6, flexShrink: 0, fontWeight: 700 }}>
        {meta.icon}
      </span>
      <span style={{ color: item.type === 'system' ? '#64748b' : item.type === 'fired' ? '#fdba74' : item.type === 'stop_hit' ? '#fca5a5' : item.type === 'target_hit' ? '#a7f3d0' : item.type === 'warning' ? '#fde68a' : item.type === 'danger' ? '#fca5a5' : '#bae6fd', lineHeight: 1.5 }}>
        {item.text}
      </span>
    </div>
  );
}

export default function TeleprinterFeed({ maxHeight = 480 }) {
  const data = usePollData(`${API_URL}/antigravity/edges-context`, 30000);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [data]);

  if (!data) {
    return (
      <div style={{ background: '#050a14', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ padding: '8px 14px', background: '#080f1e', borderBottom: '1px solid rgba(255,255,255,0.06)', fontFamily: 'monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#22d3ee' }}>
          📡 ANTIGRAVITY LIVE COMMENTARY &amp; TELEPRINTER FEED
        </div>
        <div style={{ padding: '12px 14px', fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>Initializing feed...</div>
      </div>
    );
  }

  const { liveStatus, setups, limits, tradeBacktest } = data;
  const feed = buildFeed({ liveStatus, setups, limits, tradeBacktest });

  return (
    <div style={{ background: '#050a14', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '8px 14px',
        background: '#080f1e',
        borderBottom: '1px solid rgba(34,211,238,0.15)',
        fontFamily: '"Roboto Mono", "Courier New", monospace',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.1em',
        color: '#22d3ee',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ opacity: 0.8 }}>📡</span>
        ANTIGRAVITY LIVE COMMENTARY &amp; TELEPRINTER FEED
      </div>

      {/* Feed */}
      <div ref={scrollRef} style={{ maxHeight, overflowY: 'auto' }}>
        {feed.length === 0
          ? <div style={{ padding: '16px 14px', fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>No events yet.</div>
          : feed.map((item, i) => <FeedItem key={i} item={item} />)
        }
      </div>
    </div>
  );
}
