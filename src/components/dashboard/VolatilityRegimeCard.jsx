import React, { useState, useEffect, useRef } from 'react';

const API_URL = '/api';

const VOL_CARD_TOOLTIP = `HOW THIS CARD WORKS

The card reads two things each morning:

① VOL REGIME (z-score)
  Measures how violent the opening drive is vs the last 20 sessions.
  • HIGH-VOL-DIRECTIONAL — fast, trending open. Setups win 63% (vs 42% baseline).
  • HIGH-VOL-CHOP — wide but directionless. Setups underperform baseline.
  • NORMAL-VOL — standard morning. No regime edge either way.
  • LOW-VOL — narrow, compressed open. Breakout follow-through elevated.

② MORNING TEXTURE (efficiency ratio)
  Measures how cleanly price moved — straight line vs zigzag.
  • High Efficiency (above median) → 87% of days close in morning's direction.
  • Low Efficiency (below median) → 35% reversal risk. Fades viable.

WHEN TO FIRE SETUPS

HIGH-VOL-DIRECTIONAL + High Efficiency
  → Highest conviction day. Fire trend/breakout setups in morning's direction.
     Hold runners. 87% close in same direction. Do not fade.

HIGH-VOL-DIRECTIONAL + Low Efficiency
  → Wide range but no clean lean. 50% size. Wait for cleaner structure.
     Prefer failed-breakout fades at session extremes.

HIGH-VOL-CHOP (either texture)
  → Fade mode only. No breakout chasing. Sell highs, buy lows inside range.
     Take profit at value area midpoint. No runners.

NORMAL-VOL + High Efficiency
  → Standard trend day. Play pullbacks in morning's direction.
     Do not fade the drive before 1:30 PM ET.

NORMAL-VOL + Low Efficiency
  → Balanced/rotational. Prefer failed-breakout setups.
     Both directions in play — reduce size on breakouts.

LOW-VOL + High Efficiency
  → Narrow but trending. Follow IB breakout. Tight stops.
     Post-IB expansion avg ~85 pts. Don't anticipate — let IB set, then follow.

LOW-VOL + Low Efficiency
  → Responsive trading only. Buy value area low, sell value area high.
     No directional commitment until volume confirms a break.

STATS (backtest, 362 NQ sessions)
  Post-IB expansion targets are updated weekly (Sunday cron).
  Efficiency cutoff is the session median — top 50% = High Efficiency.`;

function InfoTooltip({ text }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef(null);

  const handleMouseEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipWidth = 380;
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
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: '50%', fontSize: 9, fontWeight: 700,
        background: 'rgba(100,116,139,0.2)', color: '#94a3b8',
        border: '1px solid rgba(100,116,139,0.35)', cursor: 'help', lineHeight: 1,
      }}>i</span>
      {visible && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left,
          transform: 'translate(-50%, -100%)', marginTop: -6,
          width: 380, padding: '10px 14px', background: '#1a2535',
          border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, fontSize: 11,
          color: '#cbd5e1', boxShadow: '0 6px 20px rgba(0,0,0,0.7)',
          zIndex: 99999, pointerEvents: 'none', lineHeight: 1.65, whiteSpace: 'pre-line',
          textAlign: 'left',
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

const REGIME_STYLE = {
  'HIGH-VOL-DIRECTIONAL': { label: 'High-Vol Directional', color: '#4ade80', note: 'Phase-1 backtest: setups win 63.5% (n=74) in this regime vs ~42% baseline.' },
  'HIGH-VOL-CHOP':        { label: 'High-Vol Chop',        color: '#f87171', note: 'Phase-1 backtest: setups win 39.3% (n=117) in this regime, slightly below baseline.' },
  'NORMAL-VOL':           { label: 'Normal Volatility',    color: '#94a3b8', note: null },
  'LOW-VOL':              { label: 'Low Volatility',       color: '#60a5fa', note: null },
};

// These describe the trajectory of the vol z-score, NOT price direction.
const TREND_LABEL = {
  'settling down': { text: 'Vol ↓ settling', color: '#4ade80' },
  'ramping up':    { text: 'Vol ↑ ramping',  color: '#f87171' },
  'flat':          { text: 'Vol → stable',   color: '#94a3b8' },
  'insufficient data': { text: '', color: '#64748b' },
};

function VolChart({ history, zHigh, zLow, regimeColor, w, h, pad, showLabels }) {
  if (!history || history.length < 2) return null;
  const zs = history.map(p => p.z);
  const minZ = Math.min(...zs, zLow, -0.5) - 0.15;
  const maxZ = Math.max(...zs, zHigh, 0.5) + 0.15;
  const range = maxZ - minZ || 1;
  const toY = z => h - pad - ((z - minZ) / range) * (h - 2 * pad);
  const toX = i => pad + (i / (history.length - 1)) * (w - 2 * pad);

  const points = history.map((p, i) => `${toX(i).toFixed(1)},${toY(p.z).toFixed(1)}`).join(' ');
  const zeroY = toY(0);
  const highY = toY(zHigh);
  const lowY  = toY(zLow);
  const lastX = toX(history.length - 1);
  const lastY = toY(history[history.length - 1].z);

  const labelSize = showLabels ? 12 : 9;
  const lineW = showLabels ? 2 : 1.5;
  const dotR = showLabels ? 6 : 4;

  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {/* High zone fill */}
      <rect x={pad} y={pad} width={w - 2 * pad} height={Math.max(0, highY - pad)}
        fill="rgba(239,68,68,0.06)" />
      {/* Low zone fill */}
      <rect x={pad} y={lowY} width={w - 2 * pad} height={Math.max(0, h - pad - lowY)}
        fill="rgba(59,130,246,0.06)" />

      {/* Threshold lines */}
      <line x1={pad} y1={highY} x2={w - pad} y2={highY} stroke="rgba(239,68,68,0.5)" strokeWidth={lineW} strokeDasharray="6,4" />
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="rgba(148,163,184,0.35)" strokeWidth="1" strokeDasharray="4,4" />
      <line x1={pad} y1={lowY}  x2={w - pad} y2={lowY}  stroke="rgba(59,130,246,0.5)" strokeWidth={lineW} strokeDasharray="6,4" />

      {/* Labels */}
      <text x={pad + 4} y={highY - 5} fill="rgba(239,68,68,0.7)" fontSize={labelSize} fontWeight="600">HIGH-VOL</text>
      <text x={pad + 4} y={zeroY - 5} fill="rgba(148,163,184,0.5)" fontSize={labelSize - 1}>baseline</text>
      <text x={pad + 4} y={lowY + labelSize + 3} fill="rgba(59,130,246,0.7)" fontSize={labelSize} fontWeight="600">LOW-VOL</text>

      {/* Y-axis z-values */}
      {showLabels && <>
        <text x={w - pad - 2} y={highY - 5} textAnchor="end" fill="rgba(239,68,68,0.6)" fontSize="11">z={zHigh.toFixed(1)}</text>
        <text x={w - pad - 2} y={lowY + 14} textAnchor="end" fill="rgba(59,130,246,0.6)" fontSize="11">z={zLow.toFixed(1)}</text>
      </>}

      {/* Trend line */}
      <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth={showLabels ? 3 : 2.5} strokeLinejoin="round" strokeLinecap="round" />

      {/* Data points (modal only) */}
      {showLabels && history.map((p, i) => (
        <circle key={i} cx={toX(i)} cy={toY(p.z)} r="3" fill="#a78bfa" opacity="0.5" />
      ))}

      {/* Current dot */}
      <circle cx={lastX} cy={lastY} r={dotR + 2} fill={regimeColor} opacity="0.25" />
      <circle cx={lastX} cy={lastY} r={dotR} fill={regimeColor} />
      {showLabels && (
        <text x={lastX} y={lastY - dotR - 6} textAnchor="middle" fill={regimeColor} fontSize="13" fontWeight="700">
          z={history[history.length - 1].z.toFixed(2)}
        </text>
      )}
    </svg>
  );
}

function VolChartModal({ history, zHigh, zLow, regimeColor, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#0f172a', border: '1px solid #334155', borderRadius: 12,
        padding: '24px 28px', width: 700, maxWidth: '90vw',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Volatility Z-Score — Intraday Trend
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: '1px solid #475569', borderRadius: 4,
            color: '#94a3b8', fontSize: 13, padding: '2px 10px', cursor: 'pointer',
          }}>Close</button>
        </div>
        <VolChart history={history} zHigh={zHigh} zLow={zLow} regimeColor={regimeColor}
          w={644} h={240} pad={30} showLabels />
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: '#64748b' }}>
          <span><span style={{ color: '#a78bfa' }}>---</span> Vol z-score</span>
          <span><span style={{ color: 'rgba(239,68,68,0.7)' }}>- -</span> High-vol threshold</span>
          <span><span style={{ color: 'rgba(59,130,246,0.7)' }}>- -</span> Low-vol threshold</span>
          <span style={{ color: '#475569' }}>Shaded = regime zones</span>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ history, zHigh, zLow, regimeColor }) {
  const [open, setOpen] = useState(false);
  if (!history || history.length < 2) return null;

  return (
    <>
      <div onClick={() => setOpen(true)}
        style={{ cursor: 'pointer', borderRadius: 6, padding: 4, border: '1px solid transparent', transition: 'border-color 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.borderColor = '#475569'}
        onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'}
        title="Click to expand chart">
        <VolChart history={history} zHigh={zHigh} zLow={zLow} regimeColor={regimeColor}
          w={180} h={56} pad={6} showLabels={false} />
      </div>
      {open && (
        <VolChartModal history={history} zHigh={zHigh} zLow={zLow} regimeColor={regimeColor}
          onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function etMinToTime(etMin) {
  const h = Math.floor(etMin / 60);
  const m = etMin % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function TextureMetrics({ texture, etMin }) {
  if (!texture) return null;

  const {
    avgBarRange, baselineAvgBarRange, barRangePct,
    morningRange, baselineMorningRange, morningRangePct,
    efficiencyRatio, reversalRate, choppinessIndex, barCount,
  } = texture;

  // Morning range vs baseline — catches large absolute displacement that stdev-of-returns misses
  const rangeColor = morningRangePct == null ? '#94a3b8'
    : morningRangePct > 30 ? '#f87171'
    : morningRangePct < -20 ? '#60a5fa'
    : '#94a3b8';

  // Avg bar range color
  const barRangeColor = barRangePct == null ? '#94a3b8'
    : barRangePct > 30 ? '#f87171'
    : barRangePct < -20 ? '#60a5fa'
    : '#94a3b8';

  // Wide bars: when avg 1-min bar is large AND efficiency is low, the "choppy" label
  // understates the risk — reversals are large, not tight.
  const wideBarWarning = avgBarRange > 25 && efficiencyRatio < 0.25;

  const effColor = efficiencyRatio > 0.40 ? '#4ade80' : efficiencyRatio < 0.20 ? '#f87171' : '#94a3b8';
  const effLabel = efficiencyRatio > 0.40 ? 'directional' : efficiencyRatio < 0.20 ? 'choppy' : 'mixed';

  const chopColor = choppinessIndex == null ? '#94a3b8'
    : choppinessIndex > 61.8 ? '#f87171'
    : choppinessIndex < 38.2 ? '#4ade80'
    : '#94a3b8';
  const chopLabel = choppinessIndex == null ? '' : choppinessIndex > 61.8 ? 'coiling/choppy' : choppinessIndex < 38.2 ? 'trending' : 'mixed';

  const revPct = reversalRate * 100;
  const revColor = revPct > 60 ? '#f87171' : revPct < 40 ? '#4ade80' : '#94a3b8';
  const revLabel = revPct > 60 ? 'choppy' : revPct < 40 ? 'directional' : 'mixed';

  const windowStr = etMin
    ? `${barCount} bars, 9:30–${etMinToTime(Math.min(etMin, 960))} ET`
    : `${barCount} bars`;

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Texture{' '}
        <span style={{ fontWeight: 400, color: '#475569', textTransform: 'none', letterSpacing: 0 }}>({windowStr})</span>
      </div>

      {wideBarWarning && (
        <div style={{ fontSize: 10, color: '#fb923c', marginBottom: 5, fontWeight: 600 }}>
          Wide bars — {avgBarRange.toFixed(0)}pt swings. Widen stops.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '2px 6px' }}>
        {morningRange != null && <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Range</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: rangeColor }}>{morningRange.toFixed(0)}pt</div>
          <div style={{ fontSize: 9, color: '#64748b' }}>{morningRangePct != null ? `${morningRangePct > 0 ? '+' : ''}${morningRangePct.toFixed(0)}%` : ''}</div>
        </div>}
        <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Avg bar</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: barRangeColor }}>{avgBarRange.toFixed(1)}pt</div>
          <div style={{ fontSize: 9, color: '#64748b' }}>{barRangePct != null ? `${barRangePct > 0 ? '+' : ''}${barRangePct.toFixed(0)}%` : ''}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Eff</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: effColor }}>{efficiencyRatio.toFixed(3)}</div>
          <div style={{ fontSize: 9, color: effColor }}>{effLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Chop</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: chopColor }}>{choppinessIndex != null ? choppinessIndex.toFixed(1) : '—'}</div>
          <div style={{ fontSize: 9, color: chopColor }}>{chopLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Rev</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: revColor }}>{revPct.toFixed(0)}%</div>
          <div style={{ fontSize: 9, color: revColor }}>{revLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: '#64748b' }}>Cont</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>{(100 - revPct).toFixed(0)}%</div>
        </div>
      </div>
    </div>
  );
}

function getPlaybook(regime, isHighEff, tier, contRate, revRate) {
  const exp = tier?.avgExpansion;
  const expStr = exp ? `~${exp} pts` : '—';

  if (regime === 'HIGH-VOL-DIRECTIONAL') {
    if (isHighEff) return {
      direction: 'With morning drive',
      dirColor: '#4ade80',
      rules: [
        `${contRate}% probability day closes in morning's direction — do not fade the drive.`,
        `Post-IB expansion avg ${expStr}. Set T1/T2 at IB break + ${exp ? Math.round(exp * 0.6) : '—'} / ${expStr}.`,
        'Wide first-hour range — size down to absorb stops without exceeding daily risk cap.',
        'Counter-trend only on extreme exhaustion candles with volume divergence.',
      ],
    };
    return {
      direction: 'With morning drive (caution)',
      dirColor: '#fb923c',
      rules: [
        `High vol but choppy open — ${contRate}% continuation, ${revRate}% reversal risk.`,
        `Post-IB expansion avg ${expStr} but path will be messy. Use wider entries.`,
        'Avoid breakout chasing inside the first-hour range. Wait for IB to close cleanly outside.',
        'Scale down to 50% — high vol + low efficiency = wide stops, unpredictable fills.',
      ],
    };
  }

  if (regime === 'HIGH-VOL-CHOP') {
    return {
      direction: 'Fade extremes / neutral',
      dirColor: '#f87171',
      rules: [
        `Wide open, no clean direction — ${revRate}% reversal risk. Breakout chasing is lowest-edge play.`,
        `Post-IB expansion avg ${expStr} but both sides will be tested. Range-bound bias.`,
        'Primary play: fade sweeps of session extremes on decreasing volume.',
        'Size at 50% max. No runners — take profit at value area midpoint.',
      ],
    };
  }

  if (regime === 'LOW-VOL') {
    if (isHighEff) return {
      direction: 'With morning drive',
      dirColor: '#4ade80',
      rules: [
        `Narrow open trending cleanly — ${contRate}% continuation. Morning direction is sticky.`,
        `95% probability of IB breakout. Don't anticipate — let IB establish, then follow the break.`,
        `Post-IB expansion avg ${expStr}. Set T1 at IB break + ${exp ? Math.round(exp * 0.55) : '—'} pts.`,
        'Standard sizing. Tight stops — low vol means small bars, disciplined entries.',
      ],
    };
    return {
      direction: 'Responsive / range-bound',
      dirColor: '#60a5fa',
      rules: [
        `Narrow, choppy open — ${revRate}% reversal risk. No directional edge yet.`,
        `95% probability of IB breakout eventually, but morning texture says wait.`,
        'Responsive trading: buy VA low, sell VA high. Do not chase breaks until volume confirms.',
        'Low expansion expected. Keep T1 conservative — do not overshoot on narrow days.',
      ],
    };
  }

  // NORMAL-VOL
  if (isHighEff) return {
    direction: 'With morning drive',
    dirColor: '#4ade80',
    rules: [
      `Clean morning trend — ${contRate}% probability day closes in same direction.`,
      `Post-IB expansion avg ${expStr}. Play pullbacks in morning's direction after 10:30.`,
      'Do not fade the first-hour drive before 1:30 PM ET — continuation is statistically dominant.',
      'Standard sizing and setup filters apply.',
    ],
  };

  return {
    direction: 'Balanced / rotational',
    dirColor: '#94a3b8',
    rules: [
      `Choppy morning — ${revRate}% reversal risk. Both directions are in play.`,
      `Post-IB expansion avg ${expStr}, but expect tests of both IB boundaries.`,
      'Prioritize failed-breakout setups and responsive fades at session extremes.',
      'Reduce size on breakout entries — follow-through probability is lower on choppy opens.',
    ],
  };
}

function PredictiveStats({ data, btStats }) {
  if (!btStats || !data?.available) return null;

  const tierKey = data.regime === 'LOW-VOL' ? 'low' : data.regime?.startsWith('HIGH-VOL') ? 'high' : 'mid';
  const tier = btStats.tiers?.[tierKey];
  const tierLabel = tierKey === 'low' ? 'Low-Vol' : tierKey === 'high' ? 'High-Vol' : 'Mid-Vol';

  const efficiencyRatio = data.texture?.efficiencyRatio;
  const cutoff = btStats.efficiencyCutoff;
  const isHighEff = efficiencyRatio != null && cutoff != null && efficiencyRatio >= cutoff;
  const textureStats = isHighEff ? btStats.texture?.highEff : btStats.texture?.lowEff;
  const contRate = textureStats?.continuationRate;
  const revRate  = textureStats?.reversalRate;

  const playbook = getPlaybook(data.regime, isHighEff, tier, contRate, revRate);

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        {tier && <span style={{ fontSize: 11, color: '#64748b' }}>IB exp <strong style={{ color: '#a78bfa' }}>~{tier.avgExpansion}pt</strong></span>}
        {tier && <span style={{ fontSize: 11, color: '#64748b' }}>Day range <strong style={{ color: '#94a3b8' }}>{tier.avgDayRange}pt</strong></span>}
        {contRate != null && <span style={{ fontSize: 11, color: '#64748b' }}>Cont <strong style={{ color: contRate >= 80 ? '#4ade80' : '#94a3b8' }}>{contRate}%</strong></span>}
      </div>
      <div style={{ background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.12)', borderRadius: 5, padding: '6px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Play</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: playbook.dirColor }}>{playbook.direction}</span>
          <span style={{ fontSize: 9, color: '#334155', marginLeft: 'auto' }}>N={btStats.sessionCount}</span>
        </div>
        <ul style={{ margin: 0, padding: '0 0 0 12px', listStyle: 'disc' }}>
          {playbook.rules.map((r, i) => (
            <li key={i} style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.45, marginBottom: 1 }}>{r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function VolatilityRegimeCard() {
  const [data, setData] = useState(null);
  const [btStats, setBtStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${API_URL}/acd/volatility-regime`)
        .then(r => r.json())
        .then(d => !cancelled && setData(d))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 10000); // Poll every 10 seconds for live updates
    const sock = window._tradingSocket;
    if (sock) {
      sock.on('price-sync-progress', load);
    }
    return () => {
      cancelled = true;
      clearInterval(id);
      if (sock) {
        sock.off('price-sync-progress', load);
      }
    };
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/acd/vol-backtest-stats`)
      .then(r => r.json())
      .then(d => d && setBtStats(d))
      .catch(() => {});
  }, []);

  if (!data) return null;

  if (!data.available) {
    const isForming = data.barsLoaded !== undefined && data.barsRequired !== undefined;
    const progressPct = isForming ? Math.min(100, (data.barsLoaded / data.barsRequired) * 100) : 0;

    return (
      <div style={cardStyle}>
        <style>{`
          @keyframes pulse-yellow {
            0% {
              transform: scale(0.95);
              box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7);
            }
            70% {
              transform: scale(1);
              box-shadow: 0 0 0 5px rgba(245, 158, 11, 0);
            }
            100% {
              transform: scale(0.95);
              box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
            }
          }
        `}</style>
        <div style={titleStyle}>Volatility Regime (live)</div>
        {isForming ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                Forming ({data.barsLoaded}/{data.barsRequired}m)
                <span style={{
                  width: 6,
                  height: 6,
                  backgroundColor: '#f59e0b',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'pulse-yellow 1.8s infinite ease-in-out',
                }} />
              </span>
              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>
                {progressPct.toFixed(0)}%
              </span>
            </div>
            
            <div style={{ width: '100%', height: 5, backgroundColor: 'rgba(100,116,139,0.15)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ width: `${progressPct}%`, height: '100%', backgroundColor: '#f59e0b', borderRadius: 3, transition: 'width 0.4s ease-out' }} />
            </div>

            <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
              Accumulating regular trading hours (RTH) price bars. Needs 15 minutes of data to compute the first 5-minute standard deviation. Ready at 9:45 AM ET.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.4 }}>{data.reason}</div>
        )}
      </div>
    );
  }

  const regime = REGIME_STYLE[data.regime] || REGIME_STYLE['NORMAL-VOL'];
  const trend = TREND_LABEL[data.trend] || TREND_LABEL['insufficient data'];

  const zHigh = data.baselineSd ? (data.baselinePct80 - data.baselineMean) / data.baselineSd : 1.0;
  const zLow  = data.baselineSd ? (data.baselinePct20 - data.baselineMean) / data.baselineSd : -1.0;

  return (
    <div style={cardStyle}>
      <div style={{ ...titleStyle, display: 'flex', alignItems: 'center' }}>
        <span>Volatility Regime (live){!data.morningComplete && <span style={{ color: '#64748b', fontWeight: 400 }}> — morning window in progress</span>}</span>
        <InfoTooltip text={VOL_CARD_TOOLTIP} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: regime.color, display: 'flex', alignItems: 'center', gap: 6 }}>
            {regime.label}
            {!data.morningComplete && (
              <span style={{ fontSize: 8, fontWeight: 800, color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Developing
              </span>
            )}
            {trend.text && <span style={{ fontSize: 11, color: trend.color, fontWeight: 600 }}>{trend.text}</span>}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
            z={data.z?.toFixed(2)} · vol={data.morningVol != null ? data.morningVol.toFixed(5) : '—'}
            {data.dynamicHighThresh != null && <> · hi≥{data.dynamicHighThresh.toFixed(5)} lo≤{data.dynamicLowThresh.toFixed(5)}</>}
          </div>
        </div>
        <Sparkline history={data.history} zHigh={zHigh} zLow={zLow} regimeColor={regime.color} />
      </div>
      {regime.note && (
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, lineHeight: 1.3 }}>{regime.note}</div>
      )}
      <TextureMetrics texture={data.texture} etMin={data.etMin} />
      {data.emaSnap && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              9 EMA Snap-Back
            </span>
            {data.emaSnap.stretched && (
              <span style={{
                fontSize: 9, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
                padding: '1px 6px', borderRadius: 3,
                color: '#fbbf24', background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)',
              }}>
                STRETCHED — FADE
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '2px 6px' }}>
            <div>
              <div style={{ fontSize: 9, color: '#64748b' }}>9 EMA</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa', fontFamily: 'monospace' }}>
                {data.emaSnap.ema9.toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#64748b' }}>ATR(14)</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', fontFamily: 'monospace' }}>
                {data.emaSnap.atr14.toFixed(1)}pt
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#64748b' }}>Deviation</div>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                color: data.emaSnap.absDeviationATR >= 2.0 ? '#fbbf24' : data.emaSnap.absDeviationATR >= 1.5 ? '#fb923c' : '#94a3b8' }}>
                {data.emaSnap.deviationATR > 0 ? '+' : ''}{data.emaSnap.deviationATR.toFixed(2)} ATR
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#64748b' }}>Raw</div>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                color: data.emaSnap.deviation > 0 ? '#4ade80' : '#f87171' }}>
                {data.emaSnap.deviation > 0 ? '+' : ''}{data.emaSnap.deviation.toFixed(1)}pt
              </div>
            </div>
          </div>
          {data.emaSnap.stretched && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>
              {data.emaSnap.triggerLevel} · 96% revert within 15min (N=533)
            </div>
          )}
        </div>
      )}
      <PredictiveStats data={data} btStats={btStats} />
    </div>
  );
}

const cardStyle = {
  border: '1px solid var(--border-color, #334155)',
  borderRadius: 8,
  padding: '10px 14px',
  marginBottom: 12,
  background: 'rgba(255,255,255,0.02)',
};

const titleStyle = {
  fontSize: 11,
  fontWeight: 700,
  color: '#cbd5e1',
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
