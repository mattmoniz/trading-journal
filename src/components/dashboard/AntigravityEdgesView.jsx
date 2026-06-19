const fmtP = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
import React, { useState, useEffect } from 'react';

const API_URL = '/api';

function InfoTooltip({ text }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = React.useRef(null);

  if (!text) return null;

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipWidth = 320;
      const left = Math.min(
        Math.max(tooltipWidth / 2 + 8, rect.left + rect.width / 2),
        window.innerWidth - tooltipWidth / 2 - 8
      );
      setPos({ top: rect.top - 8, left });
    }
    setVisible(true);
  };

  return (
    <span ref={ref} style={{ display: 'inline-block', marginLeft: 6, verticalAlign: 'middle', flexShrink: 0 }}
      onMouseEnter={handleMouseEnter} onMouseLeave={() => setVisible(false)}
      onClick={() => setVisible(v => !v)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 700,
        background: 'rgba(100,116,139,0.2)', color: '#94a3b8',
        border: '1px solid rgba(100,116,139,0.35)', cursor: 'help', lineHeight: 1 }}>i</span>
      {visible && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translate(-50%, -100%)', marginTop: -6,
          width: 320, padding: '10px 13px', background: '#1a2535',
          border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, fontSize: 13,
          color: '#cbd5e1', boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
          zIndex: 99999, pointerEvents: 'none', lineHeight: 1.7, whiteSpace: 'pre-line',
          textAlign: 'left' }}>
          {text}
        </div>
      )}
    </span>
  );
}

export default function AntigravityEdgesView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [improvementsExpanded, setImprovementsExpanded] = useState(false);
  const [selectedBacktestWindow, setSelectedBacktestWindow] = useState('last30');
  const feedScrollRef = React.useRef(null);

  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = 0;
    }
  }, [data]);

  const fetchContext = () => {
    setLoading(true);
    fetch(`${API_URL}/antigravity/edges-context`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch edges context');
        return res.json();
      })
      .then(json => {
        setData(json);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchContext();
  }, []);

  if (loading) {
    return (
      <div style={loadingStyle}>
        <div style={spinnerStyle}></div>
        <div style={{ marginTop: 16, color: '#94a3b8', fontSize: 14 }}>Scanning price bars and computing edges...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorStyle}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444' }}>Error loading edges</div>
        <div style={{ color: '#64748b', marginTop: 4 }}>{error}</div>
        <button style={retryButton} onClick={fetchContext}>Retry</button>
      </div>
    );
  }

  const { windows, liveStatus, limits, setups, tradeBacktest, pd2VA, confluenceLevels } = data;
  const last30 = windows?.last30;
  const last60 = windows?.last60;
  const last90 = windows?.last90;
  const allTime = windows?.allTime;

  const activeBacktest = tradeBacktest?.[selectedBacktestWindow] || {
    baselinePnl: 0,
    rule1Pnl: 0,
    rule1TradesBlocked: 0,
    rule1Delta: 0,
    rule2Pnl: 0,
    rule2TradesModified: 0,
    rule2Delta: 0,
    rule3Pnl: 0,
    rule3DaysStoppedEarly: 0,
    rule3Delta: 0,
    combinedPnl: 0,
    combinedDelta: 0
  };

  const monStats = tradeBacktest?.allTime?.dowStats?.[1] || { winRate: 40.0, avgPnl: -339 };
  const friStats = tradeBacktest?.allTime?.dowStats?.[5] || { winRate: 36.4, avgPnl: 374 };

  const monWinRate = monStats.winRate;
  const monAvgPnl = monStats.avgPnl;
  const friRedRate = (100 - friStats.winRate);

  // Determine current day-of-week guidelines
  const todayETStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const targetDateStr = setups?.isFallback ? todayETStr : (setups?.date || liveStatus?.date || todayETStr);
  const targetDateParts = targetDateStr.split('-');
  const targetD = new Date(parseInt(targetDateParts[0]), parseInt(targetDateParts[1]) - 1, parseInt(targetDateParts[2]), 12, 0, 0);
  const dayOfWeek = targetD.getDay(); // 0=Sunday, 1=Monday, ...
  const isMonday = dayOfWeek === 1;
  const isFriday = dayOfWeek === 5;

  const getPlaybookDirective = () => {
    if (dayOfWeek === 1) {
      return {
        title: "Monday Mean Reversion Protocol",
        alert: "⚠️ HIGH LOSS RISK DAY",
        text: `Mondays represent a historical loss rate (${monWinRate.toFixed(1)}% WR, ${monAvgPnl < 0 ? '-' : ''}${fmtP(Math.abs(monAvgPnl))} avg P&L on live accounts). Standard breakout plays have an extremely high failure rate. Focus strictly on fading early range extensions. Use 50% max sizing. Avoid breakouts before 11:00 AM ET.`,
        recs: ["FAILED_AUCTION_LONG/SHORT", "VALUE_AREA_RESPONSIVE_LONG/SHORT", "TRT_LONG/SHORT"]
      };
    }
    if (dayOfWeek === 5) {
      return {
        title: "Friday Capital Preservation Protocol",
        alert: "⚠️ AFTERNOON SQUARING RISK",
        text: `Fridays have a ${friRedRate.toFixed(1)}% red rate for your account due to afternoon givebacks. Keep stops tight and lock in gains early. Expect sharp afternoon reversals of the morning trend ('Friday -> AM Reverses in PM') as institutions square books before the weekend. Shut screens by 12:30 PM ET.`,
        recs: ["GAP_UP/DOWN_FILL", "VALUE_AREA_RESPONSIVE_LONG"]
      };
    }
    if (dayOfWeek === 2 || dayOfWeek === 4) { // Tue/Thu
      return {
        title: `${dayOfWeek === 2 ? 'Tuesday' : 'Thursday'} Trend Sweet Spot Playbook`,
        alert: "✅ MID-WEEK LIQUIDITY SWEET SPOT",
        text: "Elevated statistical probability of clean, sustained trends. Standard position sizes and risk parameters are fully authorized. Play standard breakout, trend-following, and key level touch setups.",
        recs: ["IB_BULLISH/BEARISH", "OPEN_DRIVE_LONG/SHORT", "BRACKET_BREAKOUT_LONG/SHORT"]
      };
    }
    if (dayOfWeek === 3) { // Wed
      return {
        title: "Wednesday Trend Continuation Playbook",
        alert: "✅ MORNING MOMENTUM RUNNERS",
        text: "Wednesdays show a strong statistical tendency for morning momentum to continue into the PM session ('Wednesday -> AM Continues into PM'). Ride morning momentum and avoid counter-trend fading of strong morning trends early in the afternoon.",
        recs: ["IB_BULLISH/BEARISH", "OPEN_TEST_DRIVE_LONG/SHORT"]
      };
    }
    return {
      title: "Weekend Prep Protocol",
      alert: "☕ MARKET CLOSED",
      text: "Waiting for regular market hours. Use this time to check your Morning Brief and complete the Pre-Market Walkthrough checklist.",
      recs: []
    };
  };

  const getPotentialSetups = () => {
    if (!liveStatus || !liveStatus.active) return [];
    const list = [];
    const firedTypes = new Set((setups?.list || []).map(s => s.setup_type));

    // 1. Gap Fill Setup
    if (liveStatus.gapStatus === 'UP' && !firedTypes.has('GAP_UP_FILL') && !firedTypes.has('GAP_UP_FILL_SHORT')) {
      list.push({
        id: 'pot-gap-up',
        setup_type: 'POTENTIAL GAP UP FILL (SHORT)',
        confidence: 'HIGH',
        condition: `NQ opened with an upside Gap of ${liveStatus.gapOpenValue?.toFixed(1)} pts.`,
        trigger: 'Price exhaustively sweeps morning high, reclaims opening print, and drives lower.',
        recommendation: `Look to fade early RTH highs. Play pullbacks/fades back towards yesterday\'s High. Target: yesterday\'s High.`
      });
    } else if (liveStatus.gapStatus === 'DOWN' && !firedTypes.has('GAP_DOWN_FILL') && !firedTypes.has('GAP_DOWN_FILL_LONG')) {
      list.push({
        id: 'pot-gap-down',
        setup_type: 'POTENTIAL GAP DOWN FILL (LONG)',
        confidence: 'HIGH',
        condition: `NQ opened with a downside Gap of ${liveStatus.gapOpenValue?.toFixed(1)} pts.`,
        trigger: 'Price exhaustively sweeps morning low, reclaims opening print, and drives higher.',
        recommendation: `Look to buy pullbacks/extensions after reclaiming the open. Target: yesterday\'s Low.`
      });
    }

    // 2. Initial Balance breakout potential
    const isEarly = (liveStatus.barsCount || 0) <= 120; // First 2 hours
    if (isEarly) {
      if (liveStatus.or5Status === 'TIGHT') {
        if (!firedTypes.has('IB_BULLISH')) {
          list.push({
            id: 'pot-ib-bull',
            setup_type: 'POTENTIAL IB BREAKOUT LONG',
            confidence: 'HIGH',
            condition: `OR5 is TIGHT (${liveStatus.or5Range?.toFixed(1)} pts), increasing clean breakout probabilities.`,
            trigger: 'Price breaks and holds above the 10:30 AM range high.',
            recommendation: 'Target 100% / 200% expansions. Standard size allowed. Enter on candle close above IB High.'
          });
        }
        if (!firedTypes.has('IB_BEARISH')) {
          list.push({
            id: 'pot-ib-bear',
            setup_type: 'POTENTIAL IB BREAKOUT SHORT',
            confidence: 'HIGH',
            condition: `OR5 is TIGHT (${liveStatus.or5Range?.toFixed(1)} pts), increasing clean breakdown probabilities.`,
            trigger: 'Price breaks and holds below the 10:30 AM range low.',
            recommendation: 'Target 100% / 200% expansions. Standard size allowed. Enter on candle close below IB Low.'
          });
        }
      } else if (liveStatus.or5Status === 'WIDE') {
        if (!firedTypes.has('TRT_LONG') && !firedTypes.has('TRT_LONG_V2')) {
          list.push({
            id: 'pot-trt-long',
            setup_type: 'POTENTIAL TRAPPED SHORTS (TRT LONG)',
            confidence: 'MEDIUM',
            condition: `OR5 is WIDE (${liveStatus.or5Range?.toFixed(1)} pts). Standard breakouts have a high failure rate in wide ranges. Reversal is the dominant edge.`,
            trigger: 'Price attempts breakout lower (A Down), rejects, and reclaims the opening range high.',
            recommendation: 'Target opposite side IB. Stop at session low. Keep risk tight.'
          });
        }
        if (!firedTypes.has('TRT_SHORT') && !firedTypes.has('TRT_SHORT_V2')) {
          list.push({
            id: 'pot-trt-short',
            setup_type: 'POTENTIAL TRAPPED LONGS (TRT SHORT)',
            confidence: 'MEDIUM',
            condition: `OR5 is WIDE (${liveStatus.or5Range?.toFixed(1)} pts). Standard breakouts have a high failure rate in wide ranges. Reversal is the dominant edge.`,
            trigger: 'Price attempts breakout higher (A Up), rejects, and reclaims the opening range low.',
            recommendation: 'Target opposite side IB. Stop at session high. Keep risk tight.'
          });
        }
      }
    }

    return list;
  };

  const TOP_IMPROVEMENTS = [
    { rank: 1, cat: 'Risk', name: 'Sierra Chart DTC Pre-Trade Sizing Rules', impact: '30% - 35%', desc: 'Connect the server to Sierra Chart\'s DTC port and block or reduce order sizes by 50% automatically if the daily loss limit or drawdown threshold is crossed.' },
    { rank: 2, cat: 'Risk', name: 'Automated Position Flattening on Up-and-Done', impact: '25%', desc: 'Send an active webhook command to Sierra Chart to instantly flatten all open positions and cancel working orders once your daily profit targets are met.' },
    { rank: 3, cat: 'Risk', name: 'Pre-Session Walkthrough Gate', impact: '15%', desc: 'Block all trade ingestion from Sierra Chart until the user has checked off the morning brief and pre-market walkthrough checklist on the frontend.' },
    { rank: 4, cat: 'Risk', name: 'Strict Size Deceleration Gate', impact: '20%', desc: 'Programmatically restrict maximum contract sizes inside your dashboard when running P&L is in a drawdown (< -$400).' },
    { rank: 5, cat: 'Risk', name: 'Forced Post-Loss Cooling Lockout', impact: '15%', desc: 'Implement a hard lockout page on the dashboard for 15 minutes following a daily loss limit breach to prevent emotional revenge-trading.' },
    { rank: 6, cat: 'Backtesting', name: 'Integrate Drawdown & Stop-Outs in Confluence Backtests', impact: '35% - 40%', desc: 'Simulate minute-by-minute price movement after a level touch instead of assuming buy-and-hold to RTH close. If an ATR-based stop is hit first, log it as a loss to eliminate holding bias.' },
    { rank: 7, cat: 'Backtesting', name: 'Implement Out-of-Sample (OOS) Data Splitting', impact: '25%', desc: 'Enforce a 70/30 split (70% training/IS, 30% testing/OOS) in the Scenario Tester/Parameter Optimizer to prevent overfitting parameter curves to historical noise.' },
    { rank: 8, cat: 'Backtesting', name: 'Add Walk-Forward Optimization (WFO)', impact: '20%', desc: 'Automate rolling backtest windows (optimize on 3 months, test on the next 1 month) to see if parameters remain robust as market regimes shift.' },
    { rank: 9, cat: 'Backtesting', name: 'Incorporate Slippage & Commissions in Results', impact: '15%', desc: 'Add standard 1.0-tick slippage and exchange commission ($2.46/side per NQ contract) to all backtests to ensure net profitability is positive in execution.' },
    { rank: 10, cat: 'Backtesting', name: 'Recharts Monte Carlo UI Area Charts', impact: '15%', desc: 'Replace the ASCII histogram in the Scenario Tester with a rich area chart visualizing drawdown distributions and probability curves.' },
    { rank: 11, cat: 'Database', name: 'Eliminate Type Casting in WHERE Clauses (Seq Scan Fix)', impact: '85% - 90%', desc: 'Rewrite SQL queries containing ts::date = $1 to explicit range searches (ts >= $1 AND ts < $2) to utilize indexes and avoid Seq Scans on 600,000+ rows.' },
    { rank: 12, cat: 'Database', name: 'Add Derived Index Columns to price_bars', impact: '75%', desc: 'Add trade_date (DATE) and et_min (INT) columns to price_bars during ingestion and index them to speed up RTH session queries.' },
    { rank: 13, cat: 'Database', name: 'Enforce Database-Level Unique Constraints', impact: '60%', desc: 'Add a composite unique index (symbol, ts) on price_bars to prevent duplicate bar insertion on watcher recycles.' },
    { rank: 14, cat: 'Database', name: 'Implement File Stability Checks in Ingestion', impact: '50%', desc: 'Ensure chokidar doesn\'t read half-written text files by verifying the file size has not changed for at least 1 second.' },
    { rank: 15, cat: 'Database', name: 'Database Connection Pool Recycling', impact: '30%', desc: 'Implement connection recycling and error listeners on the pg Pool to prevent database connection timeouts on long sessions.' }
  ];

  return (
    <div style={containerStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Antigravity Trading Dashboard</h1>
          <p style={subtitleStyle}>
            Dynamic setups, dynamic confidence adjustments, and lookback metrics based on real price bar history.
          </p>
        </div>
        <button style={refreshButton} onClick={fetchContext}>
          ↻ Refresh Analysis
        </button>
      </header>

      {/* SECTION 1: LIVE SESSION GUARDRAILS */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>☀️ Today's Live Session Guardrails</h2>
        
        {liveStatus?.active ? (
          <div style={liveCardStyle(liveStatus.or5Status)}>
            <div style={liveCardHeaderStyle}>
              <span style={liveStatus.isLive ? liveBadgeStyle : historicalBadgeStyle}>
                {liveStatus.isLive ? 'LIVE SESSION ACTIVE' : `HISTORICAL REPLAY - ${liveStatus.date}`}
              </span>
              <span style={priceLabelStyle}>NQ Close: <strong style={{ color: '#fff' }}>{liveStatus.fmtP(liveStatus.currentPrice, 2)}</strong></span>
            </div>
            
            <div style={grid3Style}>
              {/* OR5 Status */}
              <div style={cardItemStyle}>
                <div style={cardItemLabelStyle}>5-Min Opening Range (OR5)</div>
                <div style={cardItemValueStyle(liveStatus.or5Status)}>
                  {liveStatus.or5Range?.toFixed(1)} pts
                  <span style={subtextStyle(liveStatus.or5Status)}>({liveStatus.or5Status})</span>
                  {liveStatus.coiling?.active && (
                    <span
                      style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: liveStatus.coiling.popSurge ? '#f87171' : '#fb923c' }}
                      title={`Coiling ${liveStatus.coiling.durationBars}min: ${liveStatus.coiling.range}pt range, volume at ${liveStatus.coiling.volRatio}% of baseline`}
                    >
                      {liveStatus.coiling.popSurge ? 'POP ⚡' : `COILING ${liveStatus.coiling.durationBars}m ⚠`}
                    </span>
                  )}
                </div>
                <p style={cardItemDescStyle}>
                  {liveStatus.or5Status === 'WIDE' 
                    ? `⚠️ Range is WIDE (>${limits?.Q4_LIMIT || 91.5} pts). Breakout follow-through has a high historical failure rate. Seek pullbacks/fades only.` 
                    : liveStatus.or5Status === 'TIGHT'
                    ? `✅ Range is TIGHT (<${limits?.Q1_LIMIT || 47.5} pts). Clean breakout follow-through probability is statistically elevated.`
                    : 'Range is normal. Breakouts have average probability of follow-through.'}
                </p>
              </div>

              {/* Gap Status */}
              <div style={cardItemStyle}>
                <div style={cardItemLabelStyle}>RTH Opening Gap</div>
                <div style={cardItemValueStyle(liveStatus.gapStatus === 'INSIDE' ? 'NORMAL' : 'WIDE')}>
                  {liveStatus.gapStatus === 'INSIDE' ? 'INSIDE RANGE' : `GAP ${liveStatus.gapStatus}`}
                  {liveStatus.gapOpenValue > 0 && <span style={subtextStyle('NORMAL')}> ({liveStatus.gapOpenValue.toFixed(1)} pts)</span>}
                </div>
                <p style={cardItemDescStyle}>
                  {liveStatus.gapStatus === 'UP' || liveStatus.gapStatus === 'DOWN'
                    ? `⚠️ NQ opened with a gap. Historically, NQ fills this gap ~66-69% of the time. Look to fade early drive extremes.`
                    : 'Opened inside yesterday\'s range. Look for failed sweeps of yesterday\'s high/low (30% occurrence).'}
                </p>
              </div>

              {/* Weekday Transition */}
              <div style={cardItemStyle}>
                <div style={cardItemLabelStyle}>Weekday Transition</div>
                <div style={cardItemValueStyle(isMonday || isFriday ? 'WIDE' : 'TIGHT')}>
                  {isMonday ? 'MONDAY' : isFriday ? 'FRIDAY' : 'MID-WEEK'}
                </div>
                <p style={cardItemDescStyle}>
                  {isMonday 
                    ? `⚠️ Mondays have a historical ${monWinRate.toFixed(1)}% win rate (${monAvgPnl < 0 ? '-' : ''}${fmtP(Math.abs(monAvgPnl))} avg P&L on live accounts). Avoid breakouts entirely, use 50% size, focus on reversion.`
                    : isFriday
                    ? `⚠️ Fridays have a ${friRedRate.toFixed(1)}% historical red rate for you. Keep risk tight and focus on capital preservation.`
                    : 'Tuesday-Thursday is your sweet spot. Standard risk parameters allowed.'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div style={noLiveCardStyle}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>☕ Market Closed</div>
            <div style={{ color: '#94a3b8', fontSize: 12 }}>
              Live guardrails activate during Regular Trading Hours (9:30 AM – 4:00 PM ET) when fresh price bars are ingested.
            </div>
          </div>
        )}

        {/* TODAY'S PLAYBOOK PROTOCOL DIRECTIVE BANNER */}
        {(() => {
          const pd = getPlaybookDirective();
          return (
            <div style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.06) 0%, rgba(15,23,42,0.4) 100%)',
              border: '1px solid rgba(139,92,246,0.2)',
              borderRadius: '8px',
              padding: '14px 18px',
              marginTop: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', fontWeight: '800', color: '#a78bfa', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🧠</span> {pd.title}
                </span>
                <span style={{
                  fontSize: '9px',
                  fontWeight: '800',
                  background: pd.alert.includes('⚠️') ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)',
                  color: pd.alert.includes('⚠️') ? '#f87171' : '#34d399',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  letterSpacing: '0.03em'
                }}>
                  {pd.alert}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '12px', color: '#cbd5e1', lineHeight: '1.5' }}>
                {pd.text}
              </p>
              {pd.recs.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '10px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Focus Setups:</span>
                  {pd.recs.map(r => (
                    <span key={r} style={{ fontSize: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', color: '#94a3b8', padding: '1px 6px', borderRadius: '4px', fontWeight: '600' }}>
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </section>

      {/* SECTION 2: LIVE COMMENTARY TELEPRINTER */}
      <section style={{ ...sectionStyle, marginBottom: '32px' }}>
        <h2 style={sectionTitleStyle}>📻 Antigravity Live Commentary & Teleprinter Feed</h2>
        <div style={{
          background: 'rgba(15, 23, 42, 0.4)',
          border: '1px solid var(--border-color)',
          borderRadius: '8px',
          padding: '16px',
          fontFamily: 'Arial, sans-serif'
        }}>
          {/* Scrollable feed list */}
          <div ref={feedScrollRef} style={{
            maxHeight: '220px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            paddingRight: '6px'
          }}>
            {(() => {
              const feed = [];
              const todayETStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
              const targetDateStr = setups?.isFallback ? todayETStr : (setups?.date || liveStatus?.date || todayETStr);
              const parts = targetDateStr.split('-');
              const todayD = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
              const dayOfWeek = todayD.getDay(); // 0=Sunday, 1=Monday, ...
              const isMonday = dayOfWeek === 1;
              const isFriday = dayOfWeek === 5;

              const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const nowETStr = `${String(nowET.getHours()).padStart(2, '0')}:${String(nowET.getMinutes()).padStart(2, '0')}:${String(nowET.getSeconds()).padStart(2, '0')}`;
              const isLive = liveStatus?.active && liveStatus?.isLive;

              const shouldShowEvent = (eventTime) => {
                if (!isLive) return true; // Show all events for historical replay
                return eventTime <= nowETStr;
              };

              // 08:30:00 (Premarket Prep)
              let prepText = "";
              if (dayOfWeek === 1) {
                prepText = `☕ Monday Mean Reversion Protocol active. Mondays have a historical ${monWinRate.toFixed(1)}% win rate (${monAvgPnl < 0 ? '-' : ''}${fmtP(Math.abs(monAvgPnl))} avg P&L on live accounts). Standard breakout plays have an extremely high failure rate. Focus strictly on fading early range extensions. Risk parameters: 50% max sizing. Do not execute breakouts before 11:00 AM ET. Sierra Chart pre-trade sizing rules must be active to restrict size automatically.`;
              } else if (dayOfWeek === 5) {
                prepText = `☕ Friday Capital Preservation Protocol active. Fridays carry a ${friRedRate.toFixed(1)}% historical red rate, mostly driven by overtrading and givebacks in the afternoon close squaring window. Focus strictly on morning Gap Fills. Hard rule: Shut down screens by 12:30 PM ET regardless of P&L. No new entries after 12:00 PM.`;
              } else if (dayOfWeek === 2 || dayOfWeek === 4) {
                prepText = `☕ ${dayOfWeek === 2 ? 'Tuesday' : 'Thursday'} Trend Sweet Spot Playbook active. Tuesday/Thursday are mid-week liquidity days showing clean, sustained trend characteristics. Standard sizing and breakout/continuation plays are fully authorized. Seek high-probability Initial Balance breakouts and key level touches.`;
              } else if (dayOfWeek === 3) {
                prepText = "☕ Wednesday Trend Continuation Playbook active. Wednesdays show a strong statistical tendency for morning momentum to continue through the afternoon close ('Wednesday -> AM Continues into PM'). Ride early drives and avoid counter-trend fading of strong morning trends before 1:30 PM.";
              } else {
                prepText = "☕ Weekend Prep Protocol active. Market closed. Review current playbook metrics and verify setup detections in the Chart Review sub-tab.";
              }

              if (shouldShowEvent("08:30:00")) {
                feed.push({
                  time: "08:30:00",
                  type: "system",
                  text: prepText
                });
              }

              // Base open event
              if (liveStatus?.active) {
                const openPrice = liveStatus.currentPrice ? fmtP(liveStatus.currentPrice - (liveStatus.gapOpenValue || 0), 2) : '30,333.50';
                let openText = `🔔 RTH Market Open: NQ opened at ${openPrice}. Gap Status: ${liveStatus.gapStatus === 'INSIDE' ? 'Inside Range' : 'GAP ' + liveStatus.gapStatus} (${liveStatus.gapOpenValue?.toFixed(1) || 0} pts). `;
                if (liveStatus.gapStatus === 'UP') {
                  openText += "An upside gap opens with a 66% statistical probability of filling back to yesterday's High. The playbook directive is to look to fade early drives that sweep highs and reject, targeting yesterday's range boundaries.";
                } else if (liveStatus.gapStatus === 'DOWN') {
                  openText += "A downside gap opens with a 69% statistical probability of filling back to yesterday's Low. The playbook directive is to watch for exhaustion on early downward drives and look to buy reclamation of the opening print, targeting yesterday's Low.";
                } else {
                  openText += "NQ opened inside yesterday's range. Responsive value area trading is active. Sweeps of yesterday's High or Low show a 30% failure rate; look for failed sweeps of value area boundaries to fade back to the POC.";
                }
                
                if (shouldShowEvent("09:30:00")) {
                  feed.push({
                    time: "09:30:00",
                    type: "info",
                    text: openText
                  });
                }

                // OR5 event
                if (liveStatus.or5Range != null) {
                  let or5Text = `📊 Opening 5-Minute Range established: ${liveStatus.or5Range.toFixed(1)} pts. Classified as ${liveStatus.or5Status}. `;
                  if (liveStatus.or5Status === 'WIDE') {
                    or5Text += `The range is WIDE (>= ${limits?.Q4_LIMIT || 91.5} pts). This indicates high volatility absorption. Breakout follow-through has an elevated historical failure rate. Avoid chasing breakout lines. Focus on pullbacks to the VWAP, VAH/VAL, or fading range boundaries.`;
                  } else if (liveStatus.or5Status === 'TIGHT') {
                    or5Text += `The range is TIGHT (< ${limits?.Q1_LIMIT || 47.5} pts). This is a classic coil setup. Clean breakout follow-through probability is statistically elevated. Watch the range extremes for a high-momentum breakout drive.`;
                  } else {
                    or5Text += "The range is normal. Expected trend follow-through is average. Standard playbook execution rules apply.";
                  }
                  
                  if (shouldShowEvent("09:35:00")) {
                    feed.push({
                      time: "09:35:00",
                      type: "info",
                      text: or5Text
                    });
                  }
                }

                // 10:00:00 AM sweep window
                if (shouldShowEvent("10:00:00")) {
                  feed.push({
                    time: "10:00:00",
                    type: "system",
                    text: "⏰ Institutional Sweep Window: The 10:00 AM pivot window is active. Historically, retail morning drives from 9:30 to 9:55 AM exhaust in this 10-minute window (9:55 - 10:05). Sweeps of the session extreme on decreasing volume are prime setups for high-probability reversals."
                  });
                }

                // First Hour Texture Metrics (10:30:00)
                if (liveStatus.firstHourStats) {
                  const fhs = liveStatus.firstHourStats;
                  let textureText = `🔬 First Hour Market Texture Audit: The Initial Balance is set (IB range: ${fhs.avgRange ? (fhs.avgRange * 6).toFixed(1) : '0.0'} pts). `;
                  textureText += `Kaufman Efficiency Ratio: ${fhs.efficiency}. `;
                  textureText += `Choppiness Index: ${fhs.choppinessIndex}. `;
                  textureText += `Reversal Rate: ${fhs.reversalRate}%. `;
                  
                  let textureDesc = "";
                  if (fhs.efficiency < 0.25 && fhs.choppinessIndex > 60) {
                    textureDesc = "The first hour texture confirms a highly choppy, whippy environment with low net directional progress. Breakouts have a high failure rate; seek mean-reversion fades near key levels.";
                  } else if (fhs.efficiency >= 0.38 && fhs.choppinessIndex < 50) {
                    textureDesc = "The first hour texture confirms an efficient, trending environment. Trend-aligned breakout setups and pullbacks are statistically favored.";
                  } else {
                    textureDesc = "The first hour texture is transitional/mixed. Volatility and direction are balanced; standard risk management parameters apply with no strong structural bias.";
                  }
                  textureText += textureDesc;
                  
                  if (shouldShowEvent("10:30:00")) {
                    feed.push({
                      time: "10:30:00",
                      type: "info",
                      text: textureText
                    });
                  }
                }

                // Midday Lock & Behavioral Decay (12:30:00)
                let middayText = "";
                if (dayOfWeek === 5) {
                  middayText = "⚠️ 12:30 PM ET Friday Shutdown Lock: The behavioral decay window is now active. Historically, 77.0% of your Friday losses are generated in the afternoon by forcing trades into thin weekend liquidity. Shut down Sierra Chart and flatten all positions. Capital preservation is your primary edge.";
                } else if (dayOfWeek === 1) {
                  middayText = "☕ Midday Monday Check: Standard Monday chop remains high. Turn off breakouts. If you are green, protect your cushion. Do not give back morning gains.";
                } else {
                  middayText = "☕ Midday Check: Market liquidity typically drops during the lunch hour (12:00 - 13:30 ET). Avoid entering new positions inside value areas. Let morning setups resolve.";
                }
                
                if (shouldShowEvent("12:30:00")) {
                  feed.push({
                    time: "12:30:00",
                    type: "system",
                    text: middayText
                  });
                }

                // PM Trend / Power Hour (15:30:00)
                let pmText = "";
                if (dayOfWeek === 3) {
                  pmText = "Wednesday PM Trend Check: Wednesday shows a strong statistical tendency to close in the direction of the morning momentum ('Wednesday -> AM Continues into PM'). Do not fade a strong directional trend in the final hour.";
                } else {
                  pmText = "Power Hour Check: Final hour of trading. Institutional book-squaring is active. Keep risk tight and manage any open runner contracts.";
                }
                
                if (shouldShowEvent("15:30:00")) {
                  feed.push({
                    time: "15:30:00",
                    type: "system",
                    text: pmText
                  });
                }
              }

              // Setups fired & resolved
              if (setups?.list) {
                setups.list.forEach(s => {
                  // Fired
                  const firedTimeStr = s.fired_time + ":00";
                  if (shouldShowEvent(firedTimeStr)) {
                    feed.push({
                      time: firedTimeStr,
                      type: "alert",
                      text: `🎯 Setup Fired: ${s.setup_type} detected. Entry zone: ${s.entry_zone_low} - ${s.entry_zone_high}. Stop Loss: ${s.stop_level}. Target: ${s.t1_level}. Baseline WR: ${(s.baselineWr * 100).toFixed(1)}% (N=${s.sampleN}). Adjusted WR: ${(s.adjustedWr * 100).toFixed(1)}% (Confidence: ${s.confidence}). Recommendation: ${s.recommendation}`
                    });
                  }

                  // Resolved
                  if (s.resolution) {
                    const isWinner = s.resolution === 'TARGET_HIT';
                    const pnlText = s.actual_pnl != null ? ` P&L: ${isWinner ? '+' : ''}$${s.actual_pnl}` : '';
                    
                    // Estimate a resolution offset time
                    let resHour = parseInt(s.fired_time.split(':')[0]);
                    let resMin = parseInt(s.fired_time.split(':')[1]) + (isWinner ? 14 : 19);
                    if (resMin >= 60) {
                      resHour += Math.floor(resMin / 60);
                      resMin = resMin % 60;
                    }
                    const resTimeStr = `${String(resHour).padStart(2, '0')}:${String(resMin).padStart(2, '0')}:00`;

                    let resolutionContext = "";
                    if (s.setup_type.includes('BREAKOUT') && isMonday) {
                      resolutionContext = isWinner 
                        ? " Outlier: Early Bracket Breakout Long successfully resolved despite Monday friction."
                        : " Breakout failure on Monday is statistically aligned with Monday chop guidelines.";
                    } else if (s.setup_type.includes('BREAKOUT') && liveStatus?.or5Status === 'WIDE') {
                      resolutionContext = isWinner
                        ? " Outlier: Breakout resolved successfully on a wide OR day."
                        : " Breakout failure is correlated with the wide opening range (elevated failure rate).";
                    }

                    if (shouldShowEvent(resTimeStr)) {
                      feed.push({
                        time: resTimeStr,
                        type: isWinner ? 'success' : 'danger',
                        text: `${isWinner ? '✅' : '❌'} Setup Resolved: ${s.setup_type} hit ${isWinner ? 'Target 1' : 'Stop Loss'}.${pnlText}.${resolutionContext}`
                      });
                    }
                  }
                });
              }

              // Coiling alerts — phase-aware, injected at current time
              if (isLive && liveStatus?.coiling?.active) {
                const coil = liveStatus.coiling;
                const activeSetupsCount = setups?.list?.filter(s => s.status === 'ACTIVE').length || 0;
                const volCtx = coil.volRatio != null ? `${coil.volRatio}% of session baseline` : `${coil.avgVolume} contracts/min`;

                // Level context helpers
                const levelStr = (lvl) => lvl ? ` [${lvl.label} ${lvl.dist === 0 ? 'AT' : lvl.dist + ' pts from'} ${lvl.value}]` : '';
                const highCtx = levelStr(coil.highLevel);
                const lowCtx  = levelStr(coil.lowLevel);
                const levelSummary = (coil.highLevel || coil.lowLevel)
                  ? ` Key levels — HIGH${highCtx || ' (open air)'}  |  LOW${lowCtx || ' (open air)'}.`
                  : '';
                const triggerNote = (coil.highLevel || coil.lowLevel)
                  ? ` Wait for price to test the level before entering — the level IS the trigger.`
                  : ` No key level at either boundary — lower-conviction pop setup.`;

                // Pop trigger alert — highest priority, always shown
                if (coil.popSurge) {
                  const popBoundary = coil.popDir === 'high' ? coil.high : coil.low;
                  const popLevel = coil.popDir === 'high' ? coil.highLevel : coil.lowLevel;
                  const popLevelStr = popLevel ? ` (${popLevel.label} confluence, ${popLevel.dist} pts)` : '';
                  feed.push({
                    time: nowETStr,
                    type: 'danger',
                    text: `🚨 POP TRIGGER: Volume surge (${coil.volSurgeRatio}x) at coil ${coil.popDir === 'high' ? 'HIGH' : 'LOW'} (${popBoundary})${popLevelStr}. Large participants re-entered the book. Watch for a 1-min close outside ${coil.low}–${coil.high} — that's the breakout confirmation.`
                  });
                }

                // Stand-aside alert when no setups active
                if (activeSetupsCount === 0) {
                  let coilText, coilType;
                  if (coil.coilPhase === 'optimal') {
                    coilText = `⚠️ COILING (${coil.durationBars} min): NQ compressing inside a ${coil.range}-pt range (${coil.low}–${coil.high}), volume ${volCtx}. Sweet spot — release probable in next ${Math.max(1, 15 - coil.durationBars)} min.${levelSummary}${triggerNote}`;
                    coilType = 'warning';
                  } else if (coil.coilPhase === 'stale') {
                    coilText = `⚠️ COIL STALE (${coil.durationBars} min): The ${coil.range}-pt coil has lasted >20 min. Transitioning to dead-zone drift. Don't anticipate a breakout until volume picks back up.${levelSummary}`;
                    coilType = 'warning';
                  } else {
                    coilText = `⚠️ COILING NASCENT (${coil.durationBars} min): NQ beginning to coil inside ${coil.low}–${coil.high}, volume ${volCtx}. Wait for 5+ min confirmed compression.${levelSummary}`;
                    coilType = 'warning';
                  }
                  feed.push({ time: nowETStr, type: coilType, text: coilText });
                }
              }

              // Sort by timestamp (descending: newest first)
              const sorted = feed.sort((a, b) => b.time.localeCompare(a.time));

              return sorted.map((item, idx) => {
                let textCol = '#cbd5e1';
                let timeCol = '#a78bfa';
                let bg = 'rgba(255, 255, 255, 0.01)';
                let borderCol = 'rgba(255, 255, 255, 0.02)';

                if (item.type === 'success') { textCol = '#a7f3d0'; timeCol = '#10b981'; bg = 'rgba(16, 185, 129, 0.03)'; borderCol = 'rgba(16, 185, 129, 0.08)'; }
                else if (item.type === 'danger') { textCol = '#fca5a5'; timeCol = '#f87171'; bg = 'rgba(239, 68, 68, 0.03)'; borderCol = 'rgba(239, 68, 68, 0.08)'; }
                else if (item.type === 'alert') { textCol = '#e0f2fe'; timeCol = '#38bdf8'; bg = 'rgba(56, 189, 248, 0.03)'; borderCol = 'rgba(56, 189, 248, 0.08)'; }
                else if (item.type === 'warning') { textCol = '#fed7aa'; timeCol = '#fb923c'; bg = 'rgba(251, 146, 60, 0.04)'; borderCol = 'rgba(251, 146, 60, 0.12)'; }
                else if (item.type === 'system') { textCol = '#94a3b8'; timeCol = '#64748b'; }

                return (
                  <div key={idx} style={{
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start',
                    padding: '8px 12px',
                    background: bg,
                    border: `1px solid ${borderCol}`,
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    fontSize: '12px'
                  }}>
                    <span style={{ color: timeCol, fontWeight: '700', whiteSpace: 'nowrap' }}>
                      [{item.time}]
                    </span>
                    <span style={{ color: textCol, lineHeight: '1.4' }}>
                      {item.text}
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </section>

      {/* SECTION: HISTORICAL BACKTEST */}
      {tradeBacktest && (
        <section style={{ ...sectionStyle, marginBottom: '32px' }}>
          <div style={backtestHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>📊 Historical Edge Impact on Your Trades</h2>
              <p style={{ ...subtitleStyle, marginTop: '2px' }}>
                Simulating how Antigravity's trading edges would have modified your actual execution history.
              </p>
            </div>
            
            {/* Window selector tabs */}
            <div style={tabGroupStyle}>
              {[
                { key: 'last30', label: `Last 30 Days (${tradeBacktest.last30?.windowSize || 0}d)` },
                { key: 'last60', label: `Last 60 Days (${tradeBacktest.last60?.windowSize || 0}d)` },
                { key: 'last90', label: `Last 90 Days (${tradeBacktest.last90?.windowSize || 0}d)` },
                { key: 'allTime', label: `All-Time (${tradeBacktest.allTime?.windowSize || 0}d)` }
              ].map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setSelectedBacktestWindow(tab.key)}
                  style={tabButtonStyle(selectedBacktestWindow === tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div style={backtestCardStyle}>
            {/* Main Stats Comparison Row */}
            <div style={mainStatsContainerStyle}>
              {/* Baseline */}
              <div style={mainStatBoxStyle}>
                <div style={cardItemLabelStyle}>Baseline P&L (Your Actual Results)</div>
                <div style={{ ...cardItemValueStyle(activeBacktest.baselinePnl >= 0 ? 'TIGHT' : 'WIDE'), fontSize: '24px', marginTop: '6px' }}>
                  ${activeBacktest.baselinePnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                  Total historical net performance in this period.
                </div>
              </div>

              {/* Arrow Indicator */}
              <div style={arrowContainerStyle}>
                <span style={{ fontSize: '20px', color: '#4f46e5' }}>➔</span>
              </div>

              {/* Combined Edge P&L */}
              <div style={mainStatBoxStyle}>
                <div style={cardItemLabelStyle}>Simulated Antigravity P&L (All Rules Active)</div>
                <div style={{ ...cardItemValueStyle(activeBacktest.combinedPnl >= 0 ? 'TIGHT' : 'WIDE'), fontSize: '24px', marginTop: '6px', color: activeBacktest.combinedPnl >= 0 ? '#10b981' : '#f87171' }}>
                  ${activeBacktest.combinedPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px' }}>
                  P&L after applying Monday block, size decel, & trailing locks.
                </div>
              </div>

              {/* Net Capital Saved / Improvement */}
              <div style={savingsBoxStyle(activeBacktest.combinedDelta >= 0)}>
                <div style={{ ...cardItemLabelStyle, color: '#a7f3d0' }}>Net Capital Saved / Added</div>
                <div style={savingsValueStyle}>
                  +${activeBacktest.combinedDelta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ fontSize: '10px', color: '#6ee7b7', marginTop: '4px', fontWeight: '500' }}>
                  🔥 P&L improvement of {((activeBacktest.combinedDelta / Math.abs(activeBacktest.baselinePnl || 1)) * 100).toFixed(1)}% vs baseline
                </div>
              </div>
            </div>

            {/* Individual Rule Breakdown Grid */}
            <h3 style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '20px 0 12px 0', fontWeight: '700' }}>
              Individual Edge Performance Details
            </h3>
            
            <div style={grid3Style}>
              {/* Rule 1: Monday Breakout Restriction */}
              <div style={ruleBreakdownCardStyle}>
                <div style={ruleTitleContainer}>
                  <span style={ruleNumBadge}>1</span>
                  <strong style={ruleNameStyle}>Monday Breakout Restriction</strong>
                </div>
                <p style={ruleDescStyle}>
                  Avoids breakout entries entirely on Mondays pre-11 AM due to high failure rates.
                </p>
                <div style={ruleMetricsRow}>
                  <div>
                    <div style={ruleMetricLabel}>Simulated P&L</div>
                    <div style={{ ...ruleMetricValue, color: activeBacktest.rule1Pnl >= 0 ? '#34d399' : '#f87171' }}>
                      ${activeBacktest.rule1Pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Trades Blocked</div>
                    <div style={ruleMetricValue}>{activeBacktest.rule1TradesBlocked}</div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Net Savings</div>
                    <div style={{ ...ruleMetricValue, color: '#34d399' }}>
                      +${activeBacktest.rule1Delta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Rule 2: Position Size Deceleration */}
              <div style={ruleBreakdownCardStyle}>
                <div style={ruleTitleContainer}>
                  <span style={ruleNumBadge}>2</span>
                  <strong style={ruleNameStyle}>Size Deceleration Rule</strong>
                </div>
                <p style={ruleDescStyle}>
                  Reduces contract sizing by 50% for the rest of the day once session P&L drops below -$400.
                </p>
                <div style={ruleMetricsRow}>
                  <div>
                    <div style={ruleMetricLabel}>Simulated P&L</div>
                    <div style={{ ...ruleMetricValue, color: activeBacktest.rule2Pnl >= 0 ? '#34d399' : '#f87171' }}>
                      ${activeBacktest.rule2Pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Trades Reduced</div>
                    <div style={ruleMetricValue}>{activeBacktest.rule2TradesModified}</div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Net Savings</div>
                    <div style={{ ...ruleMetricValue, color: '#34d399' }}>
                      +${activeBacktest.rule2Delta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Rule 3: Daily Cushion Lock */}
              <div style={ruleBreakdownCardStyle}>
                <div style={ruleTitleContainer}>
                  <span style={ruleNumBadge}>3</span>
                  <strong style={ruleNameStyle}>Daily Cushion Trail Locks</strong>
                </div>
                <p style={ruleDescStyle}>
                  Locks in profits: if day reaches +$500, lock +$250; if day reaches +$800, lock +$500.
                </p>
                <div style={ruleMetricsRow}>
                  <div>
                    <div style={ruleMetricLabel}>Simulated P&L</div>
                    <div style={{ ...ruleMetricValue, color: activeBacktest.rule3Pnl >= 0 ? '#34d399' : '#f87171' }}>
                      ${activeBacktest.rule3Pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Days Locked Early</div>
                    <div style={ruleMetricValue}>{activeBacktest.rule3DaysStoppedEarly}</div>
                  </div>
                  <div>
                    <div style={ruleMetricLabel}>Net Savings</div>
                    <div style={{ ...ruleMetricValue, color: '#34d399' }}>
                      +${activeBacktest.rule3Delta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* TWO COLUMN GRID */}
      <div style={dashboardGridStyle}>
        
        {/* LEFT COLUMN: ACTIVE SETUPS (THE TRUST BUILDER) */}
        <div>
          {/* CONFLUENCE LEVELS — Controlled-test-validated edge boosters */}
          {confluenceLevels && (() => {
            const price = liveStatus?.currentPrice;
            const PROX = 25;
            const levels = [
              { name: 'PD-2 VAH', val: confluenceLevels.pd2?.vah, target: 15, hitRate: 83, exp: 45, ctrlDelta: 44.8, role: 'resistance', color: '#f87171' },
              { name: 'PD-2 VAL', val: confluenceLevels.pd2?.val, target: 75, hitRate: 33, exp: 55, ctrlDelta: 20.5, role: 'support', color: '#4ade80' },
              { name: 'PW Low', val: confluenceLevels.pw?.low, target: 100, hitRate: 33, exp: 100, ctrlDelta: 15.0, role: 'support', color: '#4ade80' },
              { name: 'PD-3 VAH', val: confluenceLevels.pd3?.vah, target: 15, hitRate: 85, exp: 48, ctrlDelta: 14.7, role: 'resistance', color: '#f87171' },
              { name: 'PD-1 VAH', val: confluenceLevels.pd1?.vah, target: 30, hitRate: 52, exp: 31, ctrlDelta: 9.6, role: 'resistance', color: '#fb923c' },
              { name: 'PD-1 POC', val: confluenceLevels.pd1?.poc, target: 20, hitRate: 62, exp: 25, ctrlDelta: 9.0, role: 'magnet', color: '#a78bfa' },
              { name: 'OR Mid', val: confluenceLevels.orMid, target: 20, hitRate: 69, exp: 38, ctrlDelta: 6.9, role: 'pivot', color: '#60a5fa' },
              { name: 'PW High', val: confluenceLevels.pw?.high, target: 15, hitRate: 72, exp: 26, ctrlDelta: 5.1, role: 'resistance', color: '#fb923c' },
            ].filter(l => l.val != null);

            const confTooltip = `CONFLUENCE LEVELS (Controlled-Test-Validated)\n\nThese levels independently improve setup win rates after controlling for setup type, day type, and NL30 alignment. The "Controlled Δ" is the edge contribution of JUST the level, isolated from all other factors.\n\nMETHODOLOGY: Controlled confluence test\n• For each level, compare setup WR when near (±25pt) vs away\n• Control group: same setup type + same day type + same NL30 bucket\n• This isolates the level's independent contribution\n\nTARGET CALIBRATION:\n• Each target is optimized for maximum expectancy at a 20pt stop\n• Hit rate = % of trades reaching target within 20 bars (20 min)\n• Exp = expected value per contract after accounting for stop losses\n\nANTI-CONFLUENCE (levels that HURT setups):\n• IB High: -23.9% controlled delta — setups near IB High perform worse\n• IB Low: -28.1% controlled delta — worst anti-confluence\n• These levels should REDUCE conviction, not increase it\n\nCONFLUENCE COUNT:\n• 0 levels: 48.2% WR\n• 2+ levels: 45.0% WR but better risk (MAE -29pt vs -65pt)\n• 4+ levels: 57.9% WR — high conviction\n• 5+ levels: 61.5% WR — highest conviction zone`;

            const nearCount = levels.filter(l => price && Math.abs(price - l.val) <= PROX).length;

            return (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <h2 style={{ ...sectionTitleStyle, margin: 0 }}>
                    📐 Confluence Levels
                    <InfoTooltip text={confTooltip} />
                  </h2>
                  {nearCount > 0 && (
                    <span style={{ fontSize: 10, fontWeight: 800, color: nearCount >= 3 ? '#10b981' : '#fbbf24',
                      background: nearCount >= 3 ? 'rgba(16,185,129,0.15)' : 'rgba(251,191,36,0.15)',
                      border: `1px solid ${nearCount >= 3 ? 'rgba(16,185,129,0.3)' : 'rgba(251,191,36,0.3)'}`,
                      padding: '2px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                      {nearCount} ACTIVE CONFLUENCE{nearCount > 1 ? 'S' : ''}
                    </span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {levels.map(l => {
                    const dist = price ? Math.round(price - l.val) : null;
                    const isNear = dist != null && Math.abs(dist) <= PROX;
                    return (
                      <div key={l.name} style={{
                        padding: '10px 12px', borderRadius: 6,
                        background: isNear ? 'rgba(251,191,36,0.08)' : 'rgba(30,41,59,0.15)',
                        border: `1px solid ${isNear ? 'rgba(251,191,36,0.3)' : 'rgba(148,163,184,0.1)'}`,
                        borderLeft: `3px solid ${l.color}`,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#e2e8f0' }}>{l.name}</span>
                          {isNear && <span style={{ fontSize: 8, fontWeight: 800, color: '#fbbf24', background: 'rgba(251,191,36,0.15)', padding: '1px 5px', borderRadius: 3 }}>ACTIVE</span>}
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: l.color, fontFamily: 'monospace' }}>
                          {l.val.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                          {dist != null ? `${dist > 0 ? '+' : ''}${dist}pt away` : '—'}
                          {' · '}T: {l.target}pt ({l.hitRate}% hit) · ${l.exp}/ct
                        </div>
                        <div style={{ fontSize: 9, color: l.ctrlDelta > 10 ? '#10b981' : '#94a3b8', marginTop: 1 }}>
                          Controlled Δ: +{l.ctrlDelta.toFixed(1)}% independent edge
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <h2 style={sectionTitleStyle}>
            🎯 Today's Actionable Setups
            {setups?.isFallback && <span style={fallbackBadgeStyle}>Recent Session: {setups.date}</span>}
          </h2>
          
          {setups?.list?.length > 0 ? (
            <div style={setupGridStyle}>
              {setups.list.map(s => {
                const confColor = s.confidence === 'HIGH' ? '#10b981' : s.confidence === 'MEDIUM' ? '#3b82f6' : s.confidence === 'LOW' ? '#f59e0b' : '#ef4444';
                const confBg = s.confidence === 'HIGH' ? 'rgba(16,185,129,0.1)' : s.confidence === 'MEDIUM' ? 'rgba(59,130,246,0.1)' : s.confidence === 'LOW' ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)';
                
                return (
                  <div key={s.id} style={setupCardStyle(s.confidence)}>
                    <div style={setupHeaderStyle}>
                      <span style={setupTypeStyle}>{s.setup_type}</span>
                      <span style={setupBadgeStyle(confColor, confBg)}>{s.confidence} CONFIDENCE</span>
                    </div>

                    <div style={setupMetricsGrid}>
                      <div>
                        <div style={metricLabelStyle}>Baseline WR</div>
                        <div style={metricValueStyle}>{(s.baselineWr * 100).toFixed(1)}% <span style={sampleLabel}>(N={s.sampleN})</span></div>
                      </div>
                      <div>
                        <div style={metricLabelStyle}>Heuristic WR *</div>
                        <div style={{ ...metricValueStyle, color: confColor }}>{(s.adjustedWr * 100).toFixed(1)}%</div>
                      </div>
                      <div>
                        <div style={metricLabelStyle}>Fired At</div>
                        <div style={metricValueStyle}>{s.fired_time} ET</div>
                      </div>
                    </div>

                    <div style={setupLevelsGrid}>
                      <div><strong>Entry Zone:</strong> {fmtP(s.entry_zone_low, 2)} - {fmtP(s.entry_zone_high, 2)}</div>
                      <div><strong>Stop-Loss:</strong> <span style={{ color: '#f87171' }}>{fmtP(s.stop_level, 2)}</span></div>
                      <div><strong>Target (T1):</strong> <span style={{ color: '#34d399' }}>{fmtP(s.t1_level, 2)}</span></div>
                    </div>

                    <div style={recBoxStyle(s.confidence)}>
                      {s.recommendation}
                    </div>

                    <div style={{ fontSize: '9px', color: '#64748b', marginTop: '8px', textAlign: 'right', fontStyle: 'italic' }}>
                      * Heuristic WR uses qualitative coaching assumptions, not database measurements.
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={noLiveCardStyle}>
              <div style={{ fontSize: 14, color: '#94a3b8' }}>No setups active or detected.</div>
            </div>
          )}

          {/* POTENTIAL SETUPS WATCHLIST */}
          <h2 style={{ ...sectionTitleStyle, marginTop: '28px' }}>
            👀 Potential Setup Watchlist (Could Fulfill Soon)
          </h2>
          
          {getPotentialSetups().length > 0 ? (
            <div style={setupGridStyle}>
              {getPotentialSetups().map(s => {
                const confColor = s.confidence === 'HIGH' ? '#10b981' : '#3b82f6';
                const confBg = s.confidence === 'HIGH' ? 'rgba(16,185,129,0.1)' : 'rgba(59,130,246,0.1)';
                
                return (
                  <div key={s.id} style={{ ...setupCardStyle(s.confidence), borderLeft: `3px solid ${confColor}`, background: 'rgba(15,23,42,0.3)', padding: '16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)', borderLeftWidth: '3px', borderLeftColor: confColor }}>
                    <div style={setupHeaderStyle}>
                      <span style={{ ...setupTypeStyle, color: '#94a3b8' }}>{s.setup_type}</span>
                      <span style={setupBadgeStyle(confColor, confBg)}>PENDING</span>
                    </div>

                    <div style={{ fontSize: '11px', color: '#cbd5e1', marginBottom: '8px', padding: '6px 10px', background: 'rgba(255,255,255,0.01)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.02)', lineHeight: '1.4' }}>
                      <strong>Condition:</strong> {s.condition}
                    </div>

                    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px', lineHeight: '1.4' }}>
                      <strong>If Fulfills:</strong> {s.trigger}
                    </div>

                    <div style={{ ...recBoxStyle(s.confidence), borderLeft: `2px solid #8b5cf6`, background: 'rgba(139,92,246,0.05)', padding: '8px 12px', borderRadius: '4px', fontSize: '11px', lineHeight: '1.4' }}>
                      <strong>Directive:</strong> {s.recommendation}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={noLiveCardStyle}>
              <div style={{ fontSize: 13, color: '#64748b' }}>
                {liveStatus?.active 
                  ? 'No high-probability potential setups pending right now.' 
                  : 'RTH session not active. Watchlist will initialize at 9:30 AM ET.'}
              </div>
            </div>
          )}
          {/* 9 EMA SNAP-BACK EDGE */}
          <h2 style={{ ...sectionTitleStyle, marginTop: '28px' }}>
            🧲 9 EMA Snap-Back Edge (Mean Reversion)
          </h2>
          {(() => {
            const snap = liveStatus?.emaSnap;
            if (!snap) return (
              <div style={noLiveCardStyle}>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  {liveStatus?.active ? 'Waiting for enough 5-min bars to compute 9 EMA + ATR(14)...' : 'RTH session not active. Snap-back monitor initializes at 9:45 AM ET.'}
                </div>
              </div>
            );

            const isStretched = snap.stretched;
            const devColor = snap.absDeviationATR >= 2.5 ? '#ef4444' : snap.absDeviationATR >= 2.0 ? '#fbbf24' : snap.absDeviationATR >= 1.5 ? '#fb923c' : '#94a3b8';
            const confLevel = snap.absDeviationATR >= 2.5 ? 'HIGH' : snap.absDeviationATR >= 2.0 ? 'MEDIUM' : 'LOW';
            const confColor = confLevel === 'HIGH' ? '#10b981' : confLevel === 'MEDIUM' ? '#3b82f6' : '#64748b';
            const confBg = confLevel === 'HIGH' ? 'rgba(16,185,129,0.1)' : confLevel === 'MEDIUM' ? 'rgba(59,130,246,0.1)' : 'rgba(100,116,139,0.1)';
            const dirLabel = snap.direction === 'ABOVE' ? 'SHORT (fade back to EMA)' : 'LONG (fade back to EMA)';
            const dirColor = snap.direction === 'ABOVE' ? '#f87171' : '#34d399';

            return (
              <div style={setupCardStyle(isStretched ? confLevel : null)}>
                <div style={setupHeaderStyle}>
                  <span style={setupTypeStyle}>
                    9 EMA SNAP-BACK
                    <InfoTooltip text={`9 EMA SNAP-BACK (Mean Reversion)\n\nWhen the 5-min close stretches ≥2.0 ATR(14) from the 9-period EMA, price snaps back toward the EMA 96.2% of the time within 15 minutes (3 bars).\n\nBACKTEST (12 months, NQ 5-min):\n• ≥2.0 ATR: 96.2% revert, N=533\n• ≥2.5 ATR: 99.1% revert, N=228\n• ≥3.0 ATR: 99.1% revert, N=109\n• Baseline revert rate: 72.7%\n• Edge vs baseline: +23.5%\n\nWorks on ALL day types:\n• TREND: 93.3% revert\n• BALANCE: 94.9% revert\n• TURBULENT: 92.8% revert\n\nEXECUTION:\n1. Wait for 5-min bar to CLOSE at ≥2.0 ATR from 9 EMA\n2. Enter opposite direction (fade the stretch)\n3. Target: the 9 EMA value\n4. Stop: session extreme or 1 ATR beyond entry\n5. Hold 3-5 bars max (15-25 min) — this is a scalp\n\nThe edge is in the snap-back, not continuation. Take profit at the EMA.`} />
                  </span>
                  <span style={setupBadgeStyle(isStretched ? confColor : '#64748b', isStretched ? confBg : 'rgba(100,116,139,0.1)')}>
                    {isStretched ? `${confLevel} — FADE TRIGGER` : 'MONITORING'}
                  </span>
                </div>

                <div style={setupMetricsGrid}>
                  <div>
                    <div style={metricLabelStyle}>9 EMA</div>
                    <div style={{ ...metricValueStyle, color: '#a78bfa', fontFamily: 'monospace' }}>
                      {snap.ema9.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>5m ATR(14)</div>
                    <div style={{ ...metricValueStyle, fontFamily: 'monospace' }}>
                      {snap.atr14.toFixed(1)} pts
                    </div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>Deviation</div>
                    <div style={{ ...metricValueStyle, color: devColor, fontFamily: 'monospace' }}>
                      {snap.deviationATR > 0 ? '+' : ''}{snap.deviationATR.toFixed(2)} ATR
                    </div>
                  </div>
                </div>

                {isStretched ? (
                  <>
                    <div style={setupLevelsGrid}>
                      <div><strong>Direction:</strong> <span style={{ color: dirColor, fontWeight: 700 }}>{dirLabel}</span></div>
                      <div><strong>Entry:</strong> Current price ({snap.price.toLocaleString('en-US', { maximumFractionDigits: 0 })})</div>
                      <div><strong>Target:</strong> <span style={{ color: '#a78bfa' }}>9 EMA ({snap.ema9.toLocaleString('en-US', { maximumFractionDigits: 0 })})</span></div>
                    </div>
                    <div style={recBoxStyle(confLevel)}>
                      Price is {snap.absDeviationATR.toFixed(1)}× ATR {snap.direction === 'ABOVE' ? 'above' : 'below'} the 9 EMA —
                      {snap.absDeviationATR >= 2.5 ? ' extreme stretch. 99.1% revert rate (N=228). High conviction fade.' : ' stretched. 96.2% revert rate within 15 min (N=533). Fade toward EMA.'}
                      {' '}Scalp only — take profit at EMA, do not hold for continuation. Stop at session {snap.direction === 'ABOVE' ? 'high' : 'low'} or {snap.atr14.toFixed(0)}pt beyond entry.
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: '#64748b', padding: '8px 0' }}>
                    Deviation is {snap.absDeviationATR.toFixed(2)} ATR — below the 2.0 ATR trigger threshold. No fade signal active.
                    {snap.absDeviationATR >= 1.5 && <span style={{ color: '#fb923c', fontWeight: 600 }}> Approaching trigger zone.</span>}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: '6px' }}>
                  <div>
                    <div style={metricLabelStyle}>≥2.0 ATR</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>96.2% <span style={sampleLabel}>(N=533)</span></div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>≥2.5 ATR</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>99.1% <span style={sampleLabel}>(N=228)</span></div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>≥3.0 ATR</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>99.1% <span style={sampleLabel}>(N=109)</span></div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>Baseline</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>72.7%</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* BULLISH ABSORPTION EDGE */}
          <h2 style={{ ...sectionTitleStyle, marginTop: '28px' }}>
            🛡️ Bullish Absorption (Support Hold + RSI Rising)
          </h2>
          {(() => {
            const abs = liveStatus?.absorption;
            const absTooltip = `BULLISH ABSORPTION\n\nWHAT IT IS:\nPrice held at support — 4+ bars cluster at the same low (within 5pt). RSI RISING while price flat = sellers exhausting, buyers accumulating.\n\nBACKTEST (2.5 years, NQ 5-min):\n• ALL: 71.4% WR at 5 bars (+18.4%), N=35\n• BALANCE days: 73.9% WR at 20 bars (+20.9%), N=23\n• Near PD-1 VA: 90.9% WR (N=11)\n• Calibrated: 25pt stop / 40pt target = 50% WR, $31/trade\n  OR: 25pt stop / 20pt target = 72% WR, $32/trade (scalp)\n\nCONTEXT: BALANCE days only (TREND overruns support). Bearish absorption (at resistance) has NO edge on NQ.\n\nWATCH SEQUENCE:\n1. WATCHING: 3+ bars clustering at support, RSI rising >3pt\n2. CONFIRMED: 4+ bars at support, RSI rising >5pt, price flat\n3. FIRE: Enter long. Stop 25pt below. Target 40pt (runner) or 20pt (scalp).\n4. HOLD: 5-20 bars. This is a RUNNER — avg MFE 90-125pt at 20 bars.\n5. Near PD-1 VA = highest conviction (90.9%)`;
            const isActive = abs?.detected;
            const isWatching = abs?.watching;
            return (
              <div style={setupCardStyle(isActive ? 'HIGH' : isWatching ? 'MEDIUM' : null)}>
                <div style={setupHeaderStyle}>
                  <span style={setupTypeStyle}>
                    ABSORPTION LONG
                    <InfoTooltip text={absTooltip} />
                  </span>
                  <span style={setupBadgeStyle(
                    isActive ? '#10b981' : isWatching ? '#fbbf24' : '#64748b',
                    isActive ? 'rgba(16,185,129,0.1)' : isWatching ? 'rgba(251,191,36,0.1)' : 'rgba(100,116,139,0.1)'
                  )}>
                    {isActive ? '⚡ ABSORPTION CONFIRMED — FIRE' : isWatching ? '👀 WATCHING — Building' : 'MONITORING'}
                  </span>
                </div>
                {abs ? (
                  <>
                    <div style={setupMetricsGrid}>
                      <div><div style={metricLabelStyle}>Support Cluster</div><div style={{ ...metricValueStyle, color: abs.lowCluster >= 4 ? '#10b981' : '#fbbf24' }}>{abs.lowCluster} bars at {abs.supportLevel?.toLocaleString('en-US')}</div></div>
                      <div><div style={metricLabelStyle}>RSI Drift</div><div style={{ ...metricValueStyle, color: abs.rsiDrift > 5 ? '#10b981' : '#fbbf24' }}>+{abs.rsiDrift} (rising)</div></div>
                      <div><div style={metricLabelStyle}>Range</div><div style={metricValueStyle}>{abs.wRange}pt</div></div>
                    </div>
                    <div style={setupLevelsGrid}>
                      <div><strong>Stop:</strong> <span style={{ color: '#f87171' }}>25pt below entry</span></div>
                      <div><strong>Target:</strong> <span style={{ color: '#34d399' }}>40pt (runner) or 20pt (scalp)</span></div>
                      <div><strong>Context:</strong> <span style={{ color: '#f59e0b' }}>BALANCE days only</span></div>
                    </div>
                    <div style={recBoxStyle(isActive ? 'HIGH' : 'MEDIUM')}>
                      {isActive
                        ? `Bullish absorption CONFIRMED: ${abs.lowCluster} bars held at support (${abs.supportLevel?.toLocaleString('en-US')}), RSI rising +${abs.rsiDrift}. Sellers exhausting. Enter long with 25pt stop, target 40pt runner. 71.4% WR at 5 bars. Hold 5-20 bars — this is a runner, not a scalp.`
                        : `Absorption BUILDING: ${abs.lowCluster} bars clustering at support, RSI drifting +${abs.rsiDrift}. Not yet confirmed (need 4+ bars, RSI >5). Wait for full confirmation before entering.`
                      }
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: '#64748b', padding: '8px 0' }}>
                    No absorption pattern detected. Requires: 4+ bars clustering at support with RSI rising while price stays flat.
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: '6px' }}>
                  <div><div style={metricLabelStyle}>5-bar WR</div><div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>71.4%</div></div>
                  <div><div style={metricLabelStyle}>BALANCE 20bar</div><div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>73.9%</div></div>
                  <div><div style={metricLabelStyle}>Calibrated</div><div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>25/40pt</div></div>
                  <div><div style={metricLabelStyle}>Exp/trade</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>$31</div></div>
                </div>
              </div>
            );
          })()}

          {/* COIL SURGE EDGE */}
          <h2 style={{ ...sectionTitleStyle, marginTop: '28px' }}>
            🌀 Coil Surge → VWAP Fade
          </h2>
          {(() => {
            const cs = liveStatus?.coilSurge;
            const coilTooltip = `COIL SURGE → VWAP FADE\n\nWHAT IT IS:\nPrice compresses into a tight range (<40pt) with volume drying up (<40% of baseline). When volume surges back (≥2.5x baseline), the expansion pushes price — but the DESTINATION is VWAP 75% of the time, regardless of pop direction.\n\nTHE TRADE:\nDon't follow the pop direction. Fade TOWARD VWAP.\n• Price above VWAP → short toward VWAP\n• Price below VWAP → long toward VWAP\n• Stop: coil range extreme + 5pt\n• Target: VWAP\n• R:R avg: 3.08:1\n\nBACKTEST (12mo, controlled):\n• ALL: 52.7% WR at 10 bars, +$24/trade expectancy\n• TREND days: 65.3% WR (+16.1% vs baseline) ✅✅\n• NL30 aligned: 60.0% WR (+9.2%)\n• Surge ≥2.5x: 58.7% WR at 3 bars\n• BALANCE days: 48.3% — NO EDGE, suppressed\n\nCONTEXT GATE:\nOnly fires on TREND days or NL30-aligned. Suppressed on BALANCE (coin flip). The coil on a trend day is a consolidation WITHIN the trend — the expansion continues toward VWAP in the trend direction.\n\nWATCH SEQUENCE:\n1. WATCHING: Coil detected, volume drying up\n2. ALERT: Volume surge ≥2.5x baseline detected\n3. CHECK: Confirm direction (which side of VWAP?)\n4. FIRE: Enter fade toward VWAP\n5. MANAGE: Hold 10 bars max. Take profit at VWAP or 50%+ reversion.\n\nVWAP hit within 10 bars: 26% (but VWAP hit before stop: 74.6% overall).\nExpiry: 10 bars — edge decays past that as stop rate catches up.`;

            if (!cs?.detected) return (
              <div style={noLiveCardStyle}>
                <div style={{ fontSize: 13, color: '#64748b' }}>
                  {liveStatus?.active ? 'No coiling detected in current session.' : 'RTH session not active.'}
                </div>
              </div>
            );

            const isSurging = cs.surging;
            return (
              <div style={setupCardStyle(isSurging ? 'HIGH' : 'MEDIUM')}>
                <div style={setupHeaderStyle}>
                  <span style={setupTypeStyle}>
                    COIL SURGE → VWAP FADE
                    <InfoTooltip text={coilTooltip} />
                  </span>
                  <span style={setupBadgeStyle(
                    isSurging ? '#10b981' : '#fbbf24',
                    isSurging ? 'rgba(16,185,129,0.1)' : 'rgba(251,191,36,0.1)'
                  )}>
                    {isSurging ? '⚡ VOLUME SURGING' : '👀 COILING — WATCHING'}
                  </span>
                </div>
                <div style={setupMetricsGrid}>
                  <div>
                    <div style={metricLabelStyle}>Coil Range</div>
                    <div style={{ ...metricValueStyle, fontFamily: 'monospace' }}>{cs.coilRange}pt</div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>Vol vs Baseline</div>
                    <div style={{ ...metricValueStyle, color: cs.volRatio < 40 ? '#4ade80' : '#94a3b8' }}>{cs.volRatio}%</div>
                  </div>
                  <div>
                    <div style={metricLabelStyle}>Surge Ratio</div>
                    <div style={{ ...metricValueStyle, color: isSurging ? '#10b981' : '#64748b', fontFamily: 'monospace' }}>
                      {cs.surgeRatio}x {isSurging ? '✅' : ''}
                    </div>
                  </div>
                </div>
                {cs.vwap && (
                  <div style={setupLevelsGrid}>
                    <div><strong>VWAP Target:</strong> <span style={{ color: '#a78bfa', fontWeight: 700 }}>{cs.vwap?.toLocaleString('en-US')}</span></div>
                    <div><strong>Distance:</strong> {cs.distToVwap > 0 ? '+' : ''}{cs.distToVwap}pt</div>
                    <div><strong>Direction:</strong> <span style={{ color: cs.distToVwap < 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>{cs.direction}</span></div>
                  </div>
                )}
                <div style={recBoxStyle(isSurging ? 'HIGH' : 'MEDIUM')}>
                  {isSurging
                    ? `Volume surge detected (${cs.surgeRatio}x baseline). Price is ${Math.abs(cs.distToVwap)}pt ${cs.distToVwap > 0 ? 'above' : 'below'} VWAP. Fade ${cs.distToVwap > 0 ? 'short' : 'long'} toward VWAP (${cs.vwap}). TREND days: 65.3% WR. Stop at coil range extreme. Hold 10 bars max.`
                    : `Coiling detected — volume at ${cs.volRatio}% of baseline in a ${cs.coilRange}pt range. Waiting for volume surge (≥2.5x baseline). When surge fires, fade toward VWAP (${cs.vwap}). Do NOT enter until surge confirms.`
                  }
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: '6px' }}>
                  <div><div style={metricLabelStyle}>TREND WR</div><div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>65.3%</div></div>
                  <div><div style={metricLabelStyle}>NL30 Aligned</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>60.0%</div></div>
                  <div><div style={metricLabelStyle}>Avg R:R</div><div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa' }}>3.08</div></div>
                  <div><div style={metricLabelStyle}>Exp/trade</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>+$24</div></div>
                </div>
              </div>
            );
          })()}

          {/* 15min RSI DIVERGENCE EDGES */}
          <h2 style={{ ...sectionTitleStyle, marginTop: '28px' }}>
            📉 15-Min RSI Divergence (Scalp Reversal)
          </h2>
          {(() => {
            const rsiBullTooltip = `RSI BULLISH DIVERGENCE (5-min)\n\nWHAT IT IS:\nPrice makes a LOWER swing low, but RSI(14) makes a HIGHER swing low. Selling pressure weakening.\n\nTHE TRIGGER:\nDivergence alone is a CONDITION. Wait for CONFIRMATION BAR — next 5-min bar must close HIGHER.\n\nCONTROLLED TEST (5-min, 12mo):\n• Controlled WR: 54.8% vs 53.1% baseline = +1.7% independent edge\n• MARGINAL — only works on BALANCE days (62% WR, N=42)\n• TURBULENT: 44% — fails\n• RSI > 40: 61% WR (better when NOT oversold)\n• RSI ≤ 30: 25% WR — counterintuitively terrible\n\nCONTEXT GATE: BALANCE days only. Skip TURBULENT.\n\nEXECUTION:\n1. 5-min divergence forms (lower low + higher RSI low)\n2. WAIT for next bar to close HIGHER (confirmation)\n3. Enter long. Stop below swing low. Target 2R or VA midpoint.\n4. Hold 3-5 bars (15-25 min). Scalp only.\n\nFREQUENCY: 0.34/day (27% of days)`;

            const rsiBearTooltip = `RSI BEARISH DIVERGENCE (5-min)\n\nWHAT IT IS:\nPrice makes a HIGHER swing high, but RSI(14) makes a LOWER swing high. Buying pressure weakening — institutional distribution.\n\nTHE TRIGGER:\nWait for CONFIRMATION BAR — next 5-min bar must close LOWER.\n\nCONTROLLED TEST (5-min, 12mo):\n• Controlled WR: 51.9% vs 46.9% baseline = +5.0% independent edge\n• Best at 3 bars: 57.9% WR (+11.0%) — scalp window\n• TREND days: 55% WR (N=40) — works\n• RSI 50-60: 61% WR — better at midrange than extreme overbought\n• RSI ≥ 70: 44% — worse at extremes\n\nCONTEXT: Fire on TREND and BALANCE. Suppress TURBULENT.\n\nEXECUTION:\n1. 5-min divergence forms (higher high + lower RSI high)\n2. WAIT for next bar to close LOWER (confirmation)\n3. Enter short. Stop above swing high. Target 2R or VA midpoint.\n4. Hold 2-3 bars (10-15 min). Scalp only — edge decays fast.\n5. Do NOT re-enter on persisting divergence.\n\nFREQUENCY: 0.61/day (43% of days)`;

            // We don't have live RSI div detection on the frontend — show the static edge card
            // with live status from liveStatus if available
            const dayType = liveStatus?.dayType || null;
            const isBalance = !dayType || dayType === 'BALANCE';

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Bullish Divergence Card */}
                <div style={setupCardStyle('MEDIUM')}>
                  <div style={setupHeaderStyle}>
                    <span style={setupTypeStyle}>
                      RSI BULLISH DIVERGENCE (5min)
                      <InfoTooltip text={rsiBullTooltip} />
                    </span>
                    <span style={setupBadgeStyle('#3b82f6', 'rgba(59,130,246,0.1)')}>SCALP REVERSAL</span>
                  </div>
                  <div style={setupMetricsGrid}>
                    <div>
                      <div style={metricLabelStyle}>Controlled Δ</div>
                      <div style={{ ...metricValueStyle, color: '#f59e0b' }}>+1.7% <span style={sampleLabel}>(marginal)</span></div>
                    </div>
                    <div>
                      <div style={metricLabelStyle}>BALANCE WR</div>
                      <div style={{ ...metricValueStyle, color: '#34d399' }}>62% <span style={sampleLabel}>(N=42)</span></div>
                    </div>
                    <div>
                      <div style={metricLabelStyle}>Frequency</div>
                      <div style={metricValueStyle}>0.34/day</div>
                    </div>
                  </div>
                  <div style={setupLevelsGrid}>
                    <div><strong>Signal:</strong> 5-min lower low + higher RSI low</div>
                    <div><strong>Trigger:</strong> <span style={{ color: '#10b981', fontWeight: 700 }}>Next 5-min bar closes HIGHER</span></div>
                    <div><strong>Context:</strong> <span style={{ color: isBalance ? '#34d399' : '#f59e0b' }}>{isBalance ? 'BALANCE — 62% WR ✅' : dayType + ' — skip (marginal edge)'}</span></div>
                  </div>
                  <div style={recBoxStyle('MEDIUM')}>
                    <strong>How to trade:</strong> BALANCE days only — marginal +1.7% controlled edge overall, but 62% on BALANCE. Wait for 5-min confirmation bar to close higher. Enter long, stop below swing low, target 2R or VA midpoint. Hold 3-5 bars max (15-25 min). RSI > 40 works better (61%) than oversold (25%). Scalp only.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: '6px' }}>
                    <div><div style={metricLabelStyle}>Ctrl Δ</div><div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>+1.7%</div></div>
                    <div><div style={metricLabelStyle}>BALANCE</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>62%</div></div>
                    <div><div style={metricLabelStyle}>RSI>40</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>61%</div></div>
                    <div><div style={metricLabelStyle}>Baseline</div><div style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>53.1%</div></div>
                  </div>
                </div>

                {/* Bearish Divergence Card */}
                <div style={setupCardStyle('HIGH')}>
                  <div style={setupHeaderStyle}>
                    <span style={setupTypeStyle}>
                      RSI BEARISH DIVERGENCE (5min)
                      <InfoTooltip text={rsiBearTooltip} />
                    </span>
                    <span style={setupBadgeStyle('#10b981', 'rgba(16,185,129,0.1)')}>HIGH EDGE — BALANCE DAYS</span>
                  </div>
                  <div style={setupMetricsGrid}>
                    <div>
                      <div style={metricLabelStyle}>Controlled Δ</div>
                      <div style={{ ...metricValueStyle, color: '#34d399' }}>+5.0% <span style={sampleLabel}>(real edge)</span></div>
                    </div>
                    <div>
                      <div style={metricLabelStyle}>3-bar WR</div>
                      <div style={{ ...metricValueStyle, color: '#10b981' }}>57.9% <span style={sampleLabel}>(+11.0%)</span></div>
                    </div>
                    <div>
                      <div style={metricLabelStyle}>Frequency</div>
                      <div style={metricValueStyle}>0.61/day</div>
                    </div>
                  </div>
                  <div style={setupLevelsGrid}>
                    <div><strong>Signal:</strong> 5-min higher high + lower RSI high</div>
                    <div><strong>Trigger:</strong> <span style={{ color: '#10b981', fontWeight: 700 }}>Next 5-min bar closes LOWER</span></div>
                    <div><strong>Context:</strong> TREND (55%) and BALANCE (51%). Skip TURBULENT.</div>
                  </div>
                  <div style={recBoxStyle('HIGH')}>
                    <strong>How to trade:</strong> Price making new highs but RSI declining — institutional distribution. Wait for 5-min confirmation bar to close LOWER. Enter short, stop above swing high, target 2R or VA midpoint. Hold 2-3 bars MAX (10-15 min) — the edge is strongest at 3 bars (+11%) and decays fast. RSI 50-60 works better (61%) than extreme overbought (44%). Do NOT re-enter on persisting divergence.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)', borderRadius: '6px' }}>
                    <div><div style={metricLabelStyle}>3bar</div><div style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>57.9%</div></div>
                    <div><div style={metricLabelStyle}>Ctrl Δ</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>+5.0%</div></div>
                    <div><div style={metricLabelStyle}>RSI 50-60</div><div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>61%</div></div>
                    <div><div style={metricLabelStyle}>Baseline</div><div style={{ fontSize: 12, fontWeight: 700, color: '#64748b' }}>46.9%</div></div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* RIGHT COLUMN: LOOKBACK TABLE & AUDIT ACCORDION */}
        <div>
          {/* LOOKBACK TABLE */}
          <h2 style={sectionTitleStyle}>📊 Dynamic Lookback Comparison</h2>
          <div style={{ ...tableContainerStyle, marginBottom: 24 }}>
            <table style={tableStyle}>
              <thead>
                <tr style={tableHeaderRowStyle}>
                  <th style={tableHeaderStyle}>Pattern / Edge</th>
                  <th style={tableHeaderStyle}>Last 30d</th>
                  <th style={tableHeaderStyle}>Last 90d</th>
                  <th style={tableHeaderStyle}>All-Time</th>
                </tr>
              </thead>
              <tbody>
                <tr style={tableRowStyle}>
                  <td style={tableColHeaderStyle}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <strong>Gap Up Fills</strong>
                      <InfoTooltip text={`Gap Up Fill (66% - 69% Probability)

Trigger: NQ opens above yesterday's High.

Mechanics: If the initial opening drive up fails to find aggressive buyers, a counter-offensive sell is triggered when the price reclaims the open. Target is yesterday's High (completing the gap fill).

Risk: Stop-loss at session High. Target yesterday's High.`} />
                    </div>
                    <span style={toolStyle}>Fill rate relative to yesterday High</span>
                  </td>
                  <td style={cellStyle()}>{last30?.gapUpFillPct}%</td>
                  <td style={cellStyle()}>{last90?.gapUpFillPct}%</td>
                  <td style={cellStyle()}>{allTime?.gapUpFillPct}%</td>
                </tr>
                <tr style={tableRowStyle}>
                  <td style={tableColHeaderStyle}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <strong>Gap Down Fills</strong>
                      <InfoTooltip text={`Gap Down Fill (66% - 69% Probability)

Trigger: NQ opens below yesterday's Low.

Mechanics: If the initial opening drive down fails to find aggressive sellers, a buy is triggered when the price reclaims the open. Target is yesterday's Low (completing the gap fill).

Risk: Stop-loss at session Low. Target yesterday's Low.`} />
                    </div>
                    <span style={toolStyle}>Fill rate relative to yesterday Low</span>
                  </td>
                  <td style={cellStyle()}>{last30?.gapDownFillPct}%</td>
                  <td style={cellStyle()}>{last90?.gapDownFillPct}%</td>
                  <td style={cellStyle()}>{allTime?.gapDownFillPct}%</td>
                </tr>
                <tr style={tableRowStyle}>
                  <td style={tableColHeaderStyle}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <strong>Failed sweeps</strong>
                      <InfoTooltip text={`Failed Sweeps (~30% Occurrence)

Trigger: Price sweeps yesterday's limits (High/Low) but fails to sustain acceptance, reversing back inside the range.

Mechanics: Reversal setup indicating lack of aggressive boundary participants. Target is the opposite side of the range.

Risk: Tight stop-loss just beyond the failed sweep extreme.`} />
                    </div>
                    <span style={toolStyle}>Fails after sweeping yesterday limits</span>
                  </td>
                  <td style={cellStyle()}>{last30?.sweepPct}%</td>
                  <td style={cellStyle()}>{last90?.sweepPct}%</td>
                  <td style={cellStyle()}>{allTime?.sweepPct}%</td>
                </tr>
                <tr style={tableRowStyle}>
                  <td style={tableColHeaderStyle}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <strong>10:00 AM Pivot</strong>
                      <InfoTooltip text={`10:00 AM Pivot / Turning Point (~52% Probability)

Trigger: Daily High or Low is established between 9:55 AM and 10:05 AM ET.

Mechanics: Morning retail drive exhausts as institutional volume enters. Often creates sharp rejections or double tops/bottoms.

Risk: Enter reversal plays with stop-loss at the extreme of the 10:00 AM pivot wick.`} />
                    </div>
                    <span style={toolStyle}>H/L printed between 9:55-10:05</span>
                  </td>
                  <td style={cellStyle()}>{last30?.pivotPct}%</td>
                  <td style={cellStyle()}>{last90?.pivotPct}%</td>
                  <td style={cellStyle()}>{allTime?.pivotPct}%</td>
                </tr>
                <tr style={tableRowStyle}>
                  <td style={tableColHeaderStyle}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <strong>Wide OR Follow-thru</strong>
                      <InfoTooltip text={`Wide OR Breakout (Low Success Rate)

Trigger: Opening range (OR5) exceeds Q4 limit.

Mechanics: Wide opening ranges indicate high volatility but also mean the day's expected extension has already occurred. Breakouts have an elevated historical failure rate. Fades or Trapped setups (TRT) are the dominant edge.

Risk: Avoid trend-following breakouts; enter only fading reversals with tight risk.`} />
                    </div>
                    <span style={toolStyle}>Success of breakouts on wide OR5 days</span>
                  </td>
                  <td style={cellStyle(null, true)}>{last30?.wideRunPct}%</td>
                  <td style={cellStyle(null, true)}>{last90?.wideRunPct}%</td>
                  <td style={cellStyle(null, true)}>{allTime?.wideRunPct}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* CODEBASE IMPROVEMENTS AUDIT ACCORDION */}
          <div style={auditCardStyle}>
            <button 
              style={accordionHeaderStyle} 
              onClick={() => setImprovementsExpanded(!improvementsExpanded)}
            >
              <span style={{ fontWeight: 700, fontSize: 13, color: '#f8fafc' }}>
                💡 TOP 50 IMPROVEMENTS ROADMAP (COMPRESSED SUMMARY)
              </span>
              <span>{improvementsExpanded ? '▼' : '►'}</span>
            </button>

            {improvementsExpanded && (
              <div style={accordionContentStyle}>
                <p style={{ fontSize: 11, color: '#94a3b8', margin: '0 0 12px 0' }}>
                  Full 50 improvements list is saved in your directory: <strong>/home/mmoniz/top_codebase_improvements_ranked.md</strong>
                </p>
                {TOP_IMPROVEMENTS.map(item => (
                  <div key={item.rank} style={auditItemStyle}>
                    <div style={auditItemHeader}>
                      <span style={rankBadge}>{item.rank}</span>
                      <span style={auditItemName}>{item.name}</span>
                      <span style={impactBadgeStyle(item.impact)}>Impact: {item.impact}</span>
                      <span style={auditCatBadge}>{item.cat}</span>
                    </div>
                    <p style={auditItemDesc}>{item.desc}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── CSS Styles in JS ─────────────────────────────────────────────────────────

const containerStyle = {
  padding: '24px',
  color: '#cbd5e1',
  fontFamily: 'Inter, system-ui, sans-serif',
  background: '#0f172a',
  minHeight: '100vh',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid #1e293b',
  paddingBottom: '16px',
  marginBottom: '24px',
};

const titleStyle = {
  fontSize: '24px',
  fontWeight: '800',
  color: '#f8fafc',
  margin: 0,
};

const subtitleStyle = {
  fontSize: '12px',
  color: '#94a3b8',
  margin: '4px 0 0 0',
};

const refreshButton = {
  background: '#312e81',
  border: '1px solid #4f46e5',
  color: '#e0e7ff',
  padding: '8px 16px',
  borderRadius: '6px',
  fontWeight: '600',
  cursor: 'pointer',
  fontSize: '12px',
  transition: 'all 0.2s',
};

const retryButton = {
  background: '#1e293b',
  border: '1px solid #334155',
  color: '#cbd5e1',
  padding: '6px 16px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
  marginTop: '12px',
};

const sectionStyle = {
  marginBottom: '24px',
};

const sectionTitleStyle = {
  fontSize: '14px',
  fontWeight: '700',
  color: '#cbd5e1',
  marginBottom: '16px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const fallbackBadgeStyle = {
  fontSize: '10px',
  fontWeight: '600',
  background: 'rgba(245,158,11,0.15)',
  border: '1px solid rgba(245,158,11,0.35)',
  color: '#f59e0b',
  padding: '2px 8px',
  borderRadius: '4px',
};

const noLiveCardStyle = {
  background: 'rgba(30,41,59,0.3)',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  padding: '20px',
  textAlign: 'center',
};

const liveCardStyle = (status) => ({
  background: status === 'WIDE' 
    ? 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(15,23,42,0.3) 100%)'
    : status === 'TIGHT'
    ? 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(15,23,42,0.3) 100%)'
    : 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(15,23,42,0.3) 100%)',
  border: status === 'WIDE' 
    ? '1px solid rgba(239,68,68,0.25)' 
    : status === 'TIGHT'
    ? '1px solid rgba(16,185,129,0.25)' 
    : '1px solid rgba(59,130,246,0.25)',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
});

const liveCardHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  paddingBottom: '12px',
  marginBottom: '16px',
};

const liveBadgeStyle = {
  fontSize: '10px',
  fontWeight: '800',
  background: '#ef4444',
  color: '#fff',
  padding: '3px 8px',
  borderRadius: '4px',
  letterSpacing: '0.05em',
};

const historicalBadgeStyle = {
  fontSize: '10px',
  fontWeight: '800',
  background: 'rgba(59, 130, 246, 0.2)',
  border: '1px solid rgba(59, 130, 246, 0.4)',
  color: '#60a5fa',
  padding: '3px 8px',
  borderRadius: '4px',
  letterSpacing: '0.05em',
};

const priceLabelStyle = {
  fontSize: '11px',
  color: '#94a3b8',
};

const grid3Style = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: '16px',
};

const cardItemStyle = {
  background: 'rgba(15,23,42,0.6)',
  border: '1px solid rgba(255,255,255,0.03)',
  borderRadius: '6px',
  padding: '16px',
};

const cardItemLabelStyle = {
  fontSize: '10px',
  color: '#64748b',
  textTransform: 'uppercase',
  fontWeight: '700',
  letterSpacing: '0.04em',
};

const cardItemValueStyle = (status) => ({
  fontSize: '18px',
  fontWeight: '800',
  color: status === 'WIDE' ? '#f87171' : status === 'TIGHT' ? '#34d399' : '#e2e8f0',
  marginTop: '4px',
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
});

const subtextStyle = (status) => ({
  fontSize: '11px',
  fontWeight: '500',
  color: status === 'WIDE' ? '#f87171' : status === 'TIGHT' ? '#34d399' : '#94a3b8',
});

const cardItemDescStyle = {
  fontSize: '11px',
  color: '#94a3b8',
  lineHeight: '1.45',
  marginTop: '10px',
  marginBottom: 0,
};

const dashboardGridStyle = {
  display: 'grid',
  gridTemplateColumns: '1.2fr 1fr',
  gap: '24px',
  alignItems: 'start',
};

const setupGridStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
};

const setupCardStyle = (conf) => ({
  background: 'rgba(30,41,59,0.15)',
  border: conf === 'HIGH' 
    ? '1px solid rgba(16,185,129,0.2)' 
    : conf === 'AVOID'
    ? '1px solid rgba(239,68,68,0.25)'
    : '1px solid rgba(148,163,184,0.15)',
  borderRadius: '8px',
  padding: '16px',
  boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
});

const setupHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '12px',
};

const setupTypeStyle = {
  fontSize: '14px',
  fontWeight: '800',
  color: '#f1f5f9',
};

const setupBadgeStyle = (color, bg) => ({
  fontSize: '10px',
  fontWeight: '800',
  color,
  background: bg,
  padding: '2px 8px',
  borderRadius: '4px',
  letterSpacing: '0.04em',
});

const setupMetricsGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '12px',
  background: 'rgba(15,23,42,0.4)',
  padding: '10px',
  borderRadius: '6px',
  marginBottom: '12px',
};

const metricLabelStyle = {
  fontSize: '9px',
  color: '#64748b',
  textTransform: 'uppercase',
  fontWeight: '700',
};

const metricValueStyle = {
  fontSize: '13px',
  fontWeight: '700',
  color: '#e2e8f0',
  marginTop: '2px',
};

const sampleLabel = {
  fontSize: '10px',
  color: '#475569',
  fontWeight: '400',
};

const setupLevelsGrid = {
  fontSize: '12px',
  color: '#94a3b8',
  display: 'flex',
  justifyContent: 'space-between',
  paddingBottom: '12px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  marginBottom: '12px',
};

const recBoxStyle = (conf) => ({
  background: conf === 'AVOID' 
    ? 'rgba(239,68,68,0.08)' 
    : conf === 'HIGH'
    ? 'rgba(16,185,129,0.08)'
    : 'rgba(30,41,59,0.4)',
  border: conf === 'AVOID'
    ? '1px solid rgba(239,68,68,0.2)'
    : conf === 'HIGH'
    ? '1px solid rgba(16,185,129,0.2)'
    : '1px solid rgba(255,255,255,0.03)',
  padding: '10px 12px',
  borderRadius: '6px',
  fontSize: '11px',
  lineHeight: '1.45',
  color: conf === 'AVOID' ? '#f87171' : conf === 'HIGH' ? '#a7f3d0' : '#cbd5e1',
});

const tableContainerStyle = {
  background: 'rgba(30,41,59,0.2)',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  overflow: 'hidden',
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  textAlign: 'left',
  fontSize: '12px',
};

const tableHeaderRowStyle = {
  background: '#1e293b',
  borderBottom: '1px solid #334155',
};

const tableHeaderStyle = {
  padding: '10px 14px',
  fontWeight: '700',
  color: '#cbd5e1',
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const tableRowStyle = {
  borderBottom: '1px solid #1e293b',
};

const tableColHeaderStyle = {
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  maxWidth: '240px',
};

const toolStyle = {
  fontSize: '10px',
  color: '#64748b',
  fontWeight: '400',
  marginTop: '2px',
};

const cellStyle = (status = null, isBad = false) => ({
  padding: '12px 14px',
  fontWeight: '600',
  color: isBad ? '#f87171' : '#f8fafc',
});

const auditCardStyle = {
  background: 'rgba(30,41,59,0.2)',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  overflow: 'hidden',
};

const accordionHeaderStyle = {
  width: '100%',
  background: '#1e293b',
  border: 'none',
  padding: '12px 16px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  cursor: 'pointer',
  color: '#cbd5e1',
};

const accordionContentStyle = {
  padding: '16px',
  maxHeight: '400px',
  overflowY: 'auto',
  background: 'rgba(15,23,42,0.3)',
};

const auditItemStyle = {
  borderBottom: '1px solid #1e293b',
  paddingBottom: '10px',
  marginBottom: '10px',
};

const auditItemHeader = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '4px',
};

const rankBadge = {
  background: '#4f46e5',
  color: '#fff',
  fontSize: '10px',
  fontWeight: '700',
  width: '18px',
  height: '18px',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const auditItemName = {
  fontWeight: '700',
  color: '#e2e8f0',
  fontSize: '12px',
};

const auditCatBadge = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: '#94a3b8',
  fontSize: '9px',
  padding: '1px 5px',
  borderRadius: '3px',
  marginLeft: 'auto',
};

const auditItemDesc = {
  fontSize: '11px',
  color: '#94a3b8',
  margin: 0,
  lineHeight: '1.4',
};

const impactBadgeStyle = (val) => ({
  background: 'rgba(99,102,241,0.12)',
  border: '1px solid rgba(99,102,241,0.3)',
  color: '#a5b4fc',
  fontSize: '9px',
  fontWeight: '700',
  padding: '1px 5px',
  borderRadius: '3px',
  marginLeft: '8px'
});

const loadingStyle = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: '400px',
  background: '#0f172a',
};

const spinnerStyle = {
  width: '32px',
  height: '32px',
  border: '3px solid rgba(255,255,255,0.05)',
  borderTop: '3px solid #4f46e5',
  borderRadius: '50%',
  animation: 'spin 1s linear infinite',
};

const errorStyle = {
  padding: '40px',
  textAlign: 'center',
  background: '#0f172a',
  minHeight: '400px',
};

const backtestHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '16px',
};

const tabGroupStyle = {
  display: 'flex',
  background: '#1e293b',
  borderRadius: '6px',
  padding: '2px',
  border: '1px solid #334155',
};

const tabButtonStyle = (isActive) => ({
  background: isActive ? '#4f46e5' : 'transparent',
  border: 'none',
  color: isActive ? '#ffffff' : '#94a3b8',
  padding: '6px 12px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: '600',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
});

const backtestCardStyle = {
  background: 'linear-gradient(135deg, rgba(30,41,59,0.2) 0%, rgba(15,23,42,0.4) 100%)',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
};

const mainStatsContainerStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr 1.2fr',
  gap: '20px',
  alignItems: 'center',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  paddingBottom: '20px',
};

const mainStatBoxStyle = {
  background: 'rgba(15,23,42,0.4)',
  border: '1px solid rgba(255,255,255,0.03)',
  borderRadius: '6px',
  padding: '16px',
};

const arrowContainerStyle = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
};

const savingsBoxStyle = (isPositive) => ({
  background: 'linear-gradient(135deg, rgba(16,185,129,0.1) 0%, rgba(15,23,42,0.4) 100%)',
  border: '1px solid rgba(16,185,129,0.3)',
  borderRadius: '6px',
  padding: '16px',
});

const savingsValueStyle = {
  fontSize: '26px',
  fontWeight: '800',
  color: '#10b981',
  marginTop: '6px',
};

const ruleBreakdownCardStyle = {
  background: 'rgba(15,23,42,0.4)',
  border: '1px solid rgba(255,255,255,0.03)',
  borderRadius: '6px',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
};

const ruleTitleContainer = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '8px',
};

const ruleNumBadge = {
  background: '#312e81',
  color: '#818cf8',
  fontSize: '9px',
  fontWeight: '800',
  width: '16px',
  height: '16px',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid rgba(129,140,248,0.2)',
};

const ruleNameStyle = {
  fontSize: '12px',
  fontWeight: '700',
  color: '#e2e8f0',
};

const ruleDescStyle = {
  fontSize: '11px',
  color: '#94a3b8',
  margin: '0 0 16px 0',
  lineHeight: '1.4',
  flexGrow: 1,
};

const ruleMetricsRow = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: '8px',
  background: 'rgba(15,23,42,0.6)',
  padding: '8px 10px',
  borderRadius: '4px',
  border: '1px solid rgba(255,255,255,0.02)',
};

const ruleMetricLabel = {
  fontSize: '8px',
  color: '#64748b',
  textTransform: 'uppercase',
  fontWeight: '700',
  letterSpacing: '0.04em',
};

const ruleMetricValue = {
  fontSize: '11px',
  fontWeight: '700',
  color: '#f8fafc',
  marginTop: '2px',
};
