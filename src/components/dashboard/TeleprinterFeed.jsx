const fmtP = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
import React, { useState, useEffect, useRef } from 'react';

const API_URL = '/api';

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
  const isMonday = dayOfWeek === 1;

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowETStr = `${String(nowET.getHours()).padStart(2, '0')}:${String(nowET.getMinutes()).padStart(2, '0')}:${String(nowET.getSeconds()).padStart(2, '0')}`;
  const isLive = liveStatus?.active && liveStatus?.isLive;

  const shouldShowEvent = (eventTime) => !isLive || eventTime <= nowETStr;

  // 08:30 premarket
  let prepText = '';
  if (dayOfWeek === 1) {
    prepText = `☕ Monday Mean Reversion Protocol active. Mondays have a historical ${monWinRate.toFixed(1)}% win rate (${monAvgPnl < 0 ? '-' : ''}${fmtP(Math.abs(monAvgPnl))} avg P&L on live accounts). Standard breakout plays have an extremely high failure rate. Focus strictly on fading early range extensions. Risk parameters: 50% max sizing.`;
  } else if (dayOfWeek === 5) {
    prepText = `☕ Friday Capital Preservation Protocol active. Fridays carry a ${friRedRate.toFixed(1)}% historical red rate. Focus on morning Gap Fills only. Hard rule: Shut down screens by 12:30 PM ET regardless of P&L.`;
  } else if (dayOfWeek === 2 || dayOfWeek === 4) {
    prepText = `☕ ${dayOfWeek === 2 ? 'Tuesday' : 'Thursday'} Trend Sweet Spot Playbook active. Mid-week liquidity days with clean, sustained trend characteristics. Standard sizing and breakout/continuation plays fully authorized.`;
  } else if (dayOfWeek === 3) {
    prepText = "☕ Wednesday Trend Continuation Playbook active. Strong tendency for morning momentum to continue into the PM close. Ride early drives and avoid counter-trend fading before 1:30 PM.";
  } else {
    prepText = "☕ Weekend Prep Protocol active. Market closed. Review current playbook metrics.";
  }
  if (shouldShowEvent("08:30:00")) feed.push({ time: "08:30:00", type: "system", text: prepText });

  if (liveStatus?.active) {
    // 09:30 open
    const openPrice = liveStatus.currentPrice ? fmtP(liveStatus.currentPrice - (liveStatus.gapOpenValue || 0), 2) : '—';
    let openText = `🔔 RTH Market Open: NQ opened at ${openPrice}. Gap Status: ${liveStatus.gapStatus === 'INSIDE' ? 'Inside Range' : 'GAP ' + liveStatus.gapStatus} (${liveStatus.gapOpenValue?.toFixed(1) || 0} pts). `;
    if (liveStatus.gapStatus === 'UP') openText += "Upside gap — 66% stat probability of filling back to yesterday's High. Fade early drives that sweep highs and reject.";
    else if (liveStatus.gapStatus === 'DOWN') openText += "Downside gap — 69% stat probability of filling back to yesterday's Low. Watch for exhaustion on early drives.";
    else openText += "Inside yesterday's range. Responsive value area trading active. Failed sweeps of VA boundaries are primary fade setups.";
    if (shouldShowEvent("09:30:00")) feed.push({ time: "09:30:00", type: "info", text: openText });

    // 09:35 OR5
    if (liveStatus.or5Range != null) {
      let or5Text = `📊 OR5 established: ${liveStatus.or5Range.toFixed(1)} pts — ${liveStatus.or5Status}. `;
      if (liveStatus.or5Status === 'WIDE') or5Text += `WIDE (>= ${limits?.Q4_LIMIT || 91.5} pts). Breakout follow-through historically poor. Seek pullbacks and fades only.`;
      else if (liveStatus.or5Status === 'TIGHT') or5Text += `TIGHT (< ${limits?.Q1_LIMIT || 47.5} pts). Breakout follow-through elevated. Watch range extremes for high-momentum drive.`;
      else or5Text += "Normal range. Standard playbook applies.";
      if (shouldShowEvent("09:35:00")) feed.push({ time: "09:35:00", type: "info", text: or5Text });
    }

    // 10:00 sweep window
    if (shouldShowEvent("10:00:00")) {
      feed.push({ time: "10:00:00", type: "system", text: "⏰ Institutional Sweep Window: 9:55–10:05 AM pivot zone. Retail morning drives often exhaust here. Sweeps of session extreme on decreasing volume are prime reversal setups." });
    }

    // 10:30 first-hour texture
    if (liveStatus.firstHourStats) {
      const fhs = liveStatus.firstHourStats;
      let textureText = `🔬 First Hour Texture: IB range ~${fhs.avgRange ? (fhs.avgRange * 6).toFixed(1) : '0'} pts. Efficiency ${fhs.efficiency}, Choppiness ${fhs.choppinessIndex}, Reversals ${fhs.reversalRate}%. `;
      if (fhs.efficiency < 0.25 && fhs.choppinessIndex > 60) textureText += "Highly choppy — breakouts have high failure rate. Fade extremes.";
      else if (fhs.efficiency >= 0.38 && fhs.choppinessIndex < 50) textureText += "Efficient, trending — breakout/pullback plays statistically favored.";
      else textureText += "Mixed texture — standard risk parameters, no strong structural bias.";
      if (shouldShowEvent("10:30:00")) feed.push({ time: "10:30:00", type: "info", text: textureText });
    }

    // 12:30 midday
    let middayText = '';
    if (dayOfWeek === 5) middayText = "⚠️ 12:30 PM Friday Shutdown Lock: Behavioral decay window active. Flatten all positions and shut down screens. Capital preservation is the edge now.";
    else if (dayOfWeek === 1) middayText = "☕ Midday Monday: Monday chop still elevated. Turn off breakouts. Protect morning cushion.";
    else middayText = "☕ Midday: Liquidity drops 12:00–13:30 ET. Avoid new positions inside value areas. Let morning setups resolve.";
    if (shouldShowEvent("12:30:00")) feed.push({ time: "12:30:00", type: "system", text: middayText });

    // 15:30 power hour
    let pmText = dayOfWeek === 3
      ? "Wednesday PM Trend Check: Strong tendency to close in morning's direction. Do not fade a strong trend in the final hour."
      : "Power Hour: Institutional book-squaring active. Keep risk tight and manage any open runners.";
    if (shouldShowEvent("15:30:00")) feed.push({ time: "15:30:00", type: "system", text: pmText });
  }

  // Volume climax alert — fires when last bar is ≥4x trailing 20-bar average
  if (isLive && liveStatus?.volumeClimax?.active) {
    const vc = liveStatus.volumeClimax;
    const nowETStr2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nowStr = `${String(nowETStr2.getHours()).padStart(2, '0')}:${String(nowETStr2.getMinutes()).padStart(2, '0')}:${String(nowETStr2.getSeconds()).padStart(2, '0')}`;
    const dirText = vc.barDir === 'up' ? 'buying climax' : vc.barDir === 'down' ? 'selling climax' : 'volume climax';
    const levelText = vc.nearLevel ? ` at ${vc.nearLevel.label} (${vc.nearLevel.dist} pts away)` : '';
    const actionText = vc.barDir === 'up'
      ? 'Large sellers absorbing the drive. Watch for rejection and fade opportunity if price stalls.'
      : vc.barDir === 'down'
      ? 'Large buyers absorbing the drop. Watch for exhaustion and long opportunity if price stabilizes.'
      : 'Institutional activity detected. Watch for directional resolution.';
    feed.push({
      time: nowStr,
      type: 'warning',
      text: `🔥 VOLUME CLIMAX: ${vc.ratio}x normal volume (${vc.volume.toLocaleString()} vs ${vc.avgVolume.toLocaleString()} avg)${levelText} — ${dirText}. ${actionText}`,
    });
  }

  // Setup fires and resolutions
  if (setups?.list) {
    setups.list.forEach(s => {
      const firedTimeStr = s.fired_time + ":00";
      if (shouldShowEvent(firedTimeStr)) {
        feed.push({
          time: firedTimeStr, type: "alert",
          text: `🎯 Setup Fired: ${s.setup_type}. Entry ${s.entry_zone_low}–${s.entry_zone_high}. Stop: ${s.stop_level}. Target: ${s.t1_level}. Baseline WR: ${(s.baselineWr * 100).toFixed(1)}% (N=${s.sampleN}). Adjusted WR: ${(s.adjustedWr * 100).toFixed(1)}% (${s.confidence}). ${s.recommendation}`
        });
      }
      if (s.resolution) {
        const isWinner = s.resolution === 'TARGET_HIT';
        const pnlText = s.actual_pnl != null ? ` P&L: ${isWinner ? '+' : ''}$${s.actual_pnl}` : '';
        let resHour = parseInt(s.fired_time.split(':')[0]);
        let resMin = parseInt(s.fired_time.split(':')[1]) + (isWinner ? 14 : 19);
        if (resMin >= 60) { resHour += Math.floor(resMin / 60); resMin = resMin % 60; }
        const resTimeStr = `${String(resHour).padStart(2, '0')}:${String(resMin).padStart(2, '0')}:00`;
        let ctx = '';
        if (s.setup_type.includes('BREAKOUT') && isMonday) ctx = isWinner ? ' Outlier: breakout resolved despite Monday friction.' : ' Breakout failure aligns with Monday chop.';
        else if (s.setup_type.includes('BREAKOUT') && liveStatus?.or5Status === 'WIDE') ctx = isWinner ? ' Outlier: breakout resolved on wide OR day.' : ' Breakout failure correlated with wide OR.';
        if (shouldShowEvent(resTimeStr)) {
          feed.push({ time: resTimeStr, type: isWinner ? 'success' : 'danger', text: `${isWinner ? '✅' : '❌'} Setup Resolved: ${s.setup_type} hit ${isWinner ? 'Target 1' : 'Stop Loss'}.${pnlText}.${ctx}` });
        }
      }
    });
  }

  // Coiling alerts
  if (isLive && liveStatus?.coiling?.active) {
    const coil = liveStatus.coiling;
    const nowETStr2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nowStr = `${String(nowETStr2.getHours()).padStart(2, '0')}:${String(nowETStr2.getMinutes()).padStart(2, '0')}:${String(nowETStr2.getSeconds()).padStart(2, '0')}`;
    const activeSetups = setups?.list?.filter(s => s.status === 'ACTIVE').length || 0;
    const volCtx = coil.volRatio != null ? `${coil.volRatio}% of baseline` : `${coil.avgVolume} contracts/min`;

    // Level context for coil boundaries
    const levelStr = (lvl) => lvl ? ` [${lvl.label} ${lvl.dist === 0 ? 'AT' : lvl.dist + ' pts from'} ${lvl.value}]` : '';
    const highCtx = levelStr(coil.highLevel);
    const lowCtx  = levelStr(coil.lowLevel);
    const hasLevel = coil.highLevel || coil.lowLevel;
    const levelSummary = hasLevel
      ? ` Key levels: HIGH${highCtx || ' (open air)'}  |  LOW${lowCtx || ' (open air)'}.`
      : '';
    const triggerNote = (coil.highLevel || coil.lowLevel)
      ? ` Wait for a pop AT the level, not before.`
      : ` No key level at either boundary — lower-conviction pop setup.`;

    if (coil.popSurge) {
      const popBoundary = coil.popDir === 'high' ? coil.high : coil.low;
      const popLevel = coil.popDir === 'high' ? coil.highLevel : coil.lowLevel;
      const popLevelStr = popLevel ? ` (${popLevel.label} ${popLevel.dist === 0 ? 'confluence' : popLevel.dist + ' pts'})` : '';
      feed.push({ time: nowStr, type: 'danger', text: `🚨 POP TRIGGER: Volume surge (${coil.volSurgeRatio}x) at coil ${coil.popDir === 'high' ? 'HIGH' : 'LOW'} (${popBoundary})${popLevelStr}. Watch for 1-min close outside ${coil.low}–${coil.high}.` });
    }
    if (activeSetups === 0) {
      let coilText, coilType = 'warning';
      if (coil.coilPhase === 'optimal') coilText = `⚠️ COILING (${coil.durationBars} min): ${coil.range}-pt range (${coil.low}–${coil.high}), volume ${volCtx}. Sweet spot — release probable in next ${Math.max(1, 15 - coil.durationBars)} min.${levelSummary}${triggerNote}`;
      else if (coil.coilPhase === 'stale') coilText = `⚠️ COIL STALE (${coil.durationBars} min): ${coil.range}-pt coil >20 min. Transitioning to dead-zone drift. Don't anticipate breakout until volume returns.${levelSummary}`;
      else coilText = `⚠️ COILING NASCENT (${coil.durationBars} min): Early compression inside ${coil.low}–${coil.high}, volume ${volCtx}. Wait for 5+ min confirmed compression.${levelSummary}`;
      feed.push({ time: nowStr, type: coilType, text: coilText });
    }
  }

  return feed.sort((a, b) => b.time.localeCompare(a.time));
}

function FeedItem({ item }) {
  let textCol = '#cbd5e1', timeCol = '#a78bfa', bg = 'rgba(255,255,255,0.01)', borderCol = 'rgba(255,255,255,0.02)';
  if (item.type === 'success') { textCol = '#a7f3d0'; timeCol = '#10b981'; bg = 'rgba(16,185,129,0.03)'; borderCol = 'rgba(16,185,129,0.08)'; }
  else if (item.type === 'danger') { textCol = '#fca5a5'; timeCol = '#f87171'; bg = 'rgba(239,68,68,0.03)'; borderCol = 'rgba(239,68,68,0.08)'; }
  else if (item.type === 'alert') { textCol = '#e0f2fe'; timeCol = '#38bdf8'; bg = 'rgba(56,189,248,0.03)'; borderCol = 'rgba(56,189,248,0.08)'; }
  else if (item.type === 'warning') { textCol = '#fed7aa'; timeCol = '#fb923c'; bg = 'rgba(251,146,60,0.04)'; borderCol = 'rgba(251,146,60,0.12)'; }
  else if (item.type === 'system') { textCol = '#94a3b8'; timeCol = '#64748b'; }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 12px', background: bg, border: `1px solid ${borderCol}`, borderRadius: 4, fontFamily: 'monospace', fontSize: 12 }}>
      <span style={{ color: timeCol, fontWeight: 700, whiteSpace: 'nowrap' }}>[{item.time}]</span>
      <span style={{ color: textCol, lineHeight: 1.4 }}>{item.text}</span>
    </div>
  );
}

export default function TeleprinterFeed({ maxHeight = 480 }) {
  const [data, setData] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${API_URL}/antigravity/edges-context`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setData(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [data]);

  const PANEL = {
    background: 'var(--card-bg)',
    border: '1px solid rgba(139,92,246,0.3)',
    borderRadius: 10,
    padding: '14px 18px',
  };

  if (!data) {
    return (
      <div style={PANEL}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>📻 Live Commentary</div>
        <div style={{ fontSize: 12, color: '#64748b' }}>Loading...</div>
      </div>
    );
  }

  const { liveStatus, setups, limits, tradeBacktest } = data;
  const feed = buildFeed({ liveStatus, setups, limits, tradeBacktest });

  return (
    <div style={PANEL}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
        📻 Live Commentary & Feed
      </div>
      <div ref={scrollRef} style={{ maxHeight, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 6 }}>
        {feed.length === 0
          ? <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center', padding: '20px 0' }}>No events yet.</div>
          : feed.map((item, i) => <FeedItem key={i} item={item} />)
        }
      </div>
    </div>
  );
}
