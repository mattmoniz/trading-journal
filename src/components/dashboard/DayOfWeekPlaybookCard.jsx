import React from 'react';

export default function DayOfWeekPlaybookCard({ todayData, forecast }) {
  const etDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const dow = new Date(etDateStr + 'T12:00:00').getDay();
  const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const monStats = todayData?.tradeBacktest?.allTime?.dowStats?.[1] || { winRate: 40.0, avgPnl: -339 };
  const friStats = todayData?.tradeBacktest?.allTime?.dowStats?.[5] || { winRate: 36.4, avgPnl: 374 };

  const pd = dow === 1 ? {
    title: 'Monday Mean Reversion Protocol',
    alert: '⚠️ HIGH LOSS RISK DAY',
    text: `Mondays represent a historical loss rate (${monStats.winRate.toFixed(1)}% WR, $${Math.abs(monStats.avgPnl).toFixed(0)} avg P&L on live accounts). Standard breakout plays have an extremely high failure rate. Focus strictly on fading early range extensions. Use 50% max sizing.`,
    recs: ['FAILED_AUCTION_LONG/SHORT', 'VALUE_AREA_RESPONSIVE_LONG/SHORT', 'TRT_LONG/SHORT'],
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.05)',
  } : dow === 5 ? {
    title: 'Friday Capital Preservation Protocol',
    alert: '⚠️ AFTERNOON SQUARING RISK',
    text: `Fridays have a ${(100 - friStats.winRate).toFixed(1)}% red rate due to afternoon profit givebacks. Keep stops tight, lock in gains early. Shut screens by 12:30 PM ET.`,
    recs: ['GAP_UP/DOWN_FILL', 'VALUE_AREA_RESPONSIVE_LONG'],
    color: '#f59e0b',
    bg: 'rgba(245, 158, 11, 0.05)',
  } : (dow === 2 || dow === 4) ? {
    title: `${dowNames[dow]} Trend Sweet Spot Playbook`,
    alert: '✅ MID-WEEK LIQUIDITY SWEET SPOT',
    text: 'Elevated statistical probability of clean, sustained trends. Standard position sizes and risk parameters are fully authorized. Play standard breakout, trend-following, and key level touch setups.',
    recs: ['IB_BULLISH/BEARISH', 'OPEN_DRIVE_LONG/SHORT', 'BRACKET_BREAKOUT_LONG/SHORT'],
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.05)',
  } : dow === 3 ? {
    title: 'Wednesday Trend Continuation Playbook',
    alert: '✅ MORNING MOMENTUM RUNNERS',
    text: 'Wednesdays show a strong tendency for morning momentum to continue into the PM session. Ride morning momentum and avoid counter-trend fading before 1:30 PM ET.',
    recs: ['IB_BULLISH/BEARISH', 'OPEN_TEST_DRIVE_LONG/SHORT'],
    color: '#10b981',
    bg: 'rgba(16, 185, 129, 0.05)',
  } : {
    title: 'Weekend Replay & Review',
    alert: '☕ MARKET CLOSED',
    text: 'Use this time to review your week\'s performance, study the telemetry, and log any missing trade notes.',
    recs: [],
    color: '#94a3b8',
    bg: 'rgba(148, 163, 184, 0.05)',
  };

  const isWarn = pd.alert.includes('⚠️');

  return (
    <div style={{ ...cardStyle, background: `linear-gradient(135deg, ${pd.bg} 0%, rgba(15, 23, 42, 0.4) 100%)`, border: `1px solid ${isWarn ? 'rgba(245, 158, 11, 0.3)' : 'rgba(99, 102, 241, 0.2)'}` }}>
      <div style={headerStyle}>
        <span style={{ fontSize: 14, fontWeight: 800, color: pd.color, display: 'flex', alignItems: 'center', gap: 6 }}>
          🧠 {pd.title}
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 800,
          background: isWarn ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
          color: isWarn ? '#f87171' : '#34d399',
          padding: '2px 8px',
          borderRadius: 4,
          letterSpacing: '0.03em'
        }}>
          {pd.alert}
        </span>
      </div>

      <p style={descStyle}>{pd.text}</p>

      {pd.recs.length > 0 && (
        <div style={recsContainerStyle}>
          <span style={recsTitleStyle}>Focus Setups:</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {pd.recs.map(r => (
              <span key={r} style={badgeStyle}>{r}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  borderRadius: 10,
  padding: '14px 18px',
  fontFamily: 'Arial, sans-serif'
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10
};

const descStyle = {
  margin: '0 0 12px',
  fontSize: 12.5,
  color: '#cbd5e1',
  lineHeight: 1.6
};

const recsContainerStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderTop: '1px solid rgba(255, 255, 255, 0.05)',
  paddingTop: 8
};

const recsTitleStyle = {
  fontSize: 12,
  color: '#94a3b8',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em'
};

const badgeStyle = {
  fontSize: 12,
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
  color: '#94a3b8',
  padding: '2px 8px',
  borderRadius: 4,
  fontWeight: 600
};
