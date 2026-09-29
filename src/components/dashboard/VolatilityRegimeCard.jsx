import React, { useState, useEffect, useRef } from 'react';
import { useSharedPollData } from '../../utils/useSharedPollData.js';
import { useViewActive } from '../../utils/useViewActive.js';

import { API_URL } from '../../constants/api.js';

// Stripped 2026-09-28 (DeepSeek Batch 1b review): every "63%"/"42%"/"87%"/"35%"/"362 NQ
// sessions" figure below was a hand-typed literal frozen at whatever the backtest showed the
// day this tooltip was written -- CLAUDE.md's "never hand-type a WR%/N/$ literal" rule,
// recurred here as the 8th-9th+ instance. Kept the qualitative shape of each rule (what
// texture/regime combination the playbook favors) since that's a real, live-computed
// classification (see the Playbook section below, whose rules pull tier/rate figures from
// vol_backtest_cache live) -- only the frozen numbers were removed, not the logic.
const VOL_CARD_TOOLTIP = `HOW THIS CARD WORKS

This card reads two things each morning:

① VOL REGIME (z-score) -- see "Morning Regime Playbook" below
  Measures how violent the opening drive is vs the last 20 sessions.
  • HIGH-VOL-DIRECTIONAL — fast, trending open.
  • HIGH-VOL-CHOP — wide but directionless. Historically the weaker regime for setups.
  • NORMAL-VOL — standard morning. No regime edge either way.
  • LOW-VOL — narrow, compressed open. Breakout follow-through tends to be elevated.

② MORNING TEXTURE (efficiency ratio)
  Measures how cleanly price moved — straight line vs zigzag.
  • High Efficiency (above the session median) → continuation more likely.
  • Low Efficiency (below the session median) → reversal risk elevated, fades more viable.

The live Cont/Rev %, N, and IB expansion figures shown in the Playbook section below are
pulled fresh from the weekly backtest cache each load, with an "as of" date -- not fixed
here, since a frozen number in this tooltip would silently go stale the next time that
backtest updates.`;

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
        width: 14, height: 14, borderRadius: '50%', fontSize: 11, fontWeight: 700,
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

// `note` stripped of its hand-typed WR%/N figures 2026-09-28 (DeepSeek Batch 1b review) --
// see the Playbook section below for the live equivalent (Cont/Rev %, N, pulled fresh from
// vol_backtest_cache with an "as of" date, not frozen prose).
// GARCH forward-looking scale -- ADDED 2026-09-28 (DeepSeek Batch 1b review). Deliberately no
// qualitative label (see CLAUDE.md's volatilityRegime.js entry: a HOT/WARM/NORMAL/COOL/COLD
// label was tested and found non-predictive, removed the same day it was built) -- mirrors
// quick-check.html's own GARCH card exactly (raw scale, band context, roll-week-pause note,
// "informational only" framing), not a re-derived version of it.
function GarchHeadline({ garch }) {
  if (!garch?.regime) return null;
  const { scale, band, rollWeekPaused, rollWeekResumesAfter, degenerateFallback, asOfClose } = garch.regime;
  const favorable = (garch.favorableSetups || []).filter(s => s.favorableToday);
  return (
    <div style={{ ...cardStyle, marginBottom: 8 }}>
      <div style={titleStyle}>Volatility (GARCH forward scale)</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#e2e8f0', fontFamily: 'monospace' }}>
          {scale.toFixed(2)}x{degenerateFallback ? ' ⚠' : ''}
        </span>
        <span style={{ fontSize: 11, color: '#64748b' }}>recent range {band.p01.toFixed(2)}–{band.p99.toFixed(2)}x</span>
        {rollWeekPaused && (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>
            ⏸ paused for NQ's quarterly contract roll{rollWeekResumesAfter ? ` — resumes after ${rollWeekResumesAfter}` : ''}
          </span>
        )}
        {!rollWeekPaused && favorable.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#4ade80' }}>
            ✓ favors {favorable[0].label}{favorable.length > 1 ? ` +${favorable.length - 1}` : ''}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
        Informational only, not a trading signal — as of {asOfClose}.
      </div>
    </div>
  );
}

const REGIME_STYLE = {
  'HIGH-VOL-DIRECTIONAL': { label: 'High-Vol Directional', color: '#4ade80', note: 'Fast, trending open — historically the stronger regime for setups. See Playbook below for live figures.' },
  'HIGH-VOL-CHOP':        { label: 'High-Vol Chop',        color: '#f87171', note: 'Wide but directionless open — historically the weaker regime for setups. See Playbook below for live figures.' },
  'NORMAL-VOL':           { label: 'Normal Volatility',    color: '#94a3b8', note: null },
  'LOW-VOL':              { label: 'Low Volatility',       color: '#60a5fa', note: null },
};

// These describe the trajectory of the vol z-score, NOT price direction.
const TREND_LABEL = {
  'settling down': { text: 'Vol ↓ settling', color: '#4ade80' },
  'ramping up':    { text: 'Vol ↑ ramping',  color: '#f87171' },
  'flat':          { text: 'Vol → stable',   color: '#94a3b8' },
  'insufficient data': { text: '', color: '#94a3b8' },
};

function VolChart({ history, zHigh, zLow, regimeColor, w, h, pad, showLabels }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!history || history.length < 2) return null;
  const zs = history.map(p => p.z);
  const minZ = Math.min(...zs, zLow, -0.5) - 0.15;
  const maxZ = Math.max(...zs, zHigh, 0.5) + 0.15;
  const range = maxZ - minZ || 1;
  const xPad = showLabels ? 50 : pad;
  const toY = z => h - pad - ((z - minZ) / range) * (h - 2 * pad);
  const toX = i => xPad + (i / (history.length - 1)) * (w - xPad - pad);

  const fmtTime = (etMin) => {
    if (etMin == null) return '';
    const hh = Math.floor(etMin / 60), mm = etMin % 60;
    const h12 = hh > 12 ? hh - 12 : hh;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  };

  const points = history.map((p, i) => `${toX(i).toFixed(1)},${toY(p.z).toFixed(1)}`).join(' ');
  const zeroY = toY(0);
  const highY = toY(zHigh);
  const lowY  = toY(zLow);
  const lastX = toX(history.length - 1);
  const lastY = toY(history[history.length - 1].z);

  const labelSize = showLabels ? 12 : 9;
  const lineW = showLabels ? 2 : 1.5;
  const dotR = showLabels ? 6 : 4;

  const handleMouse = (e) => {
    if (!showLabels) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let closest = 0, closestDist = Infinity;
    for (let i = 0; i < history.length; i++) {
      const dist = Math.abs(toX(i) - mx);
      if (dist < closestDist) { closestDist = dist; closest = i; }
    }
    setHoverIdx(closestDist < 30 ? closest : null);
  };

  const hp = hoverIdx != null ? history[hoverIdx] : null;
  const hx = hoverIdx != null ? toX(hoverIdx) : 0;
  const hy = hoverIdx != null ? toY(hp.z) : 0;

  return (
    <svg width={w} height={h} style={{ display: 'block' }}
      onMouseMove={showLabels ? handleMouse : undefined}
      onMouseLeave={showLabels ? () => setHoverIdx(null) : undefined}>
      {/* High zone fill */}
      <rect x={xPad} y={pad} width={w - xPad - pad} height={Math.max(0, highY - pad)}
        fill="rgba(239,68,68,0.06)" />
      {/* Low zone fill */}
      <rect x={xPad} y={lowY} width={w - xPad - pad} height={Math.max(0, h - pad - lowY)}
        fill="rgba(59,130,246,0.06)" />

      {/* Threshold lines */}
      <line x1={xPad} y1={highY} x2={w - pad} y2={highY} stroke="rgba(239,68,68,0.5)" strokeWidth={lineW} strokeDasharray="6,4" />
      <line x1={xPad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="rgba(148,163,184,0.35)" strokeWidth="1" strokeDasharray="4,4" />
      <line x1={xPad} y1={lowY}  x2={w - pad} y2={lowY}  stroke="rgba(59,130,246,0.5)" strokeWidth={lineW} strokeDasharray="6,4" />

      {/* Labels */}
      <text x={xPad + 4} y={highY - 5} fill="rgba(239,68,68,0.7)" fontSize={labelSize} fontWeight="600">HIGH-VOL</text>
      <text x={xPad + 4} y={zeroY - 5} fill="rgba(148,163,184,0.5)" fontSize={labelSize - 1}>baseline</text>
      <text x={xPad + 4} y={lowY + labelSize + 3} fill="rgba(59,130,246,0.7)" fontSize={labelSize} fontWeight="600">LOW-VOL</text>

      {/* Y-axis z-values */}
      {showLabels && <>
        <text x={w - pad - 2} y={highY - 5} textAnchor="end" fill="rgba(239,68,68,0.6)" fontSize="11">z={zHigh.toFixed(1)}</text>
        <text x={w - pad - 2} y={lowY + 14} textAnchor="end" fill="rgba(59,130,246,0.6)" fontSize="11">z={zLow.toFixed(1)}</text>
      </>}

      {/* X-axis time labels (modal only) */}
      {showLabels && history.map((p, i) => {
        if (i % Math.max(1, Math.floor(history.length / 6)) !== 0 && i !== history.length - 1) return null;
        return <text key={i} x={toX(i)} y={h - 6} textAnchor="middle" fill="#94a3b8" fontSize="10">{fmtTime(p.etMin)}</text>;
      })}

      {/* Trend line */}
      <polyline points={points} fill="none" stroke="#a78bfa" strokeWidth={showLabels ? 3 : 2.5} strokeLinejoin="round" strokeLinecap="round" />

      {/* Data points (modal only) */}
      {showLabels && history.map((p, i) => (
        <circle key={i} cx={toX(i)} cy={toY(p.z)} r="3" fill="#a78bfa" opacity={hoverIdx === i ? 1 : 0.5} />
      ))}

      {/* Crosshair on hover */}
      {showLabels && hp && (
        <>
          <line x1={hx} y1={pad} x2={hx} y2={h - pad} stroke="rgba(226,232,240,0.3)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1={xPad} y1={hy} x2={w - pad} y2={hy} stroke="rgba(226,232,240,0.3)" strokeWidth="1" strokeDasharray="3,3" />
          <circle cx={hx} cy={hy} r="5" fill="#a78bfa" stroke="#e2e8f0" strokeWidth="2" />
          <rect x={hx - 50} y={hy - 36} width="100" height="30" rx="4" fill="rgba(15,23,42,0.9)" stroke="#64748b" />
          <text x={hx} y={hy - 22} textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="700">{fmtTime(hp.etMin)}</text>
          <text x={hx} y={hy - 10} textAnchor="middle" fill="#a78bfa" fontSize="11" fontWeight="600">z={hp.z.toFixed(2)}</text>
        </>
      )}

      {/* Current dot */}
      {hoverIdx !== history.length - 1 && <>
        <circle cx={lastX} cy={lastY} r={dotR + 2} fill={regimeColor} opacity="0.25" />
        <circle cx={lastX} cy={lastY} r={dotR} fill={regimeColor} />
        {showLabels && (
          <text x={lastX} y={lastY - dotR - 6} textAnchor="middle" fill={regimeColor} fontSize="13" fontWeight="700">
            z={history[history.length - 1].z.toFixed(2)}
          </text>
        )}
      </>}
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
            background: 'transparent', border: '1px solid #64748b', borderRadius: 4,
            color: '#94a3b8', fontSize: 13, padding: '2px 10px', cursor: 'pointer',
          }}>Close</button>
        </div>
        <VolChart history={history} zHigh={zHigh} zLow={zLow} regimeColor={regimeColor}
          w={644} h={240} pad={30} showLabels />
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: '#94a3b8' }}>
          <span><span style={{ color: '#a78bfa' }}>---</span> Vol z-score</span>
          <span><span style={{ color: 'rgba(239,68,68,0.7)' }}>- -</span> High-vol threshold</span>
          <span><span style={{ color: 'rgba(59,130,246,0.7)' }}>- -</span> Low-vol threshold</span>
          <span style={{ color: '#94a3b8' }}>Shaded = regime zones</span>
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
        onMouseEnter={e => e.currentTarget.style.borderColor = '#64748b'}
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
    morningEfficiency,
  } = texture;
  const playER = morningEfficiency != null ? morningEfficiency : efficiencyRatio;

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
      <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Texture{' '}
        <span style={{ fontWeight: 400, color: '#94a3b8', textTransform: 'none', letterSpacing: 0 }}>({windowStr})</span>
      </div>

      {wideBarWarning && (
        <div style={{ fontSize: 12, color: '#fb923c', marginBottom: 5, fontWeight: 600 }}>
          Wide bars — {avgBarRange.toFixed(0)}pt swings. Widen stops.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '2px 6px' }}>
        {morningRange != null && <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Range</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: rangeColor }}>{morningRange.toFixed(0)}pt</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{morningRangePct != null ? `${morningRangePct > 0 ? '+' : ''}${morningRangePct.toFixed(0)}%` : ''}</div>
        </div>}
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Avg bar</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: barRangeColor }}>{avgBarRange.toFixed(1)}pt</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{barRangePct != null ? `${barRangePct > 0 ? '+' : ''}${barRangePct.toFixed(0)}%` : ''}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{morningEfficiency != null ? 'AM Eff' : 'Eff'}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: playER > 0.40 ? '#4ade80' : playER < 0.20 ? '#f87171' : '#94a3b8' }}>{playER.toFixed(3)}</div>
          <div style={{ fontSize: 11, color: playER > 0.40 ? '#4ade80' : playER < 0.20 ? '#f87171' : '#94a3b8' }}>{playER > 0.40 ? 'directional' : playER < 0.20 ? 'choppy' : 'mixed'}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Chop</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: chopColor }}>{choppinessIndex != null ? choppinessIndex.toFixed(1) : '—'}</div>
          <div style={{ fontSize: 11, color: chopColor }}>{chopLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Rev</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: revColor }}>{revPct.toFixed(0)}%</div>
          <div style={{ fontSize: 11, color: revColor }}>{revLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Cont</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>{(100 - revPct).toFixed(0)}%</div>
        </div>
      </div>
    </div>
  );
}

function getPlaybook(regime, isHighEff, tier, contRate, revRate, texture) {
  const exp = tier?.avgExpansion;
  const expStr = exp ? `~${exp} pts` : '—';
  const isFlushThenBalance = texture && texture.morningEfficiency != null
    && texture.morningEfficiency > 0.15 && texture.efficiencyRatio < 0.10
    && texture.sessionRange > 400;

  if (regime === 'HIGH-VOL-DIRECTIONAL') {
    if (isFlushThenBalance) return {
      direction: 'Flush then balance',
      dirColor: '#a78bfa',
      rules: [
        `Morning flush drove ${Math.round(texture.sessionRange)}pt range — the big move is done. 85% close in flush direction.`,
        'STOP TRADING the balance zone. Reversal trades are negative EV on flush days.',
        'Wait for balance resolution (~11:30-noon avg). Re-enter only in flush direction on breakout.',
        'Counter-trade the retrace at R1/S1 levels only — target VWAP, not new extremes. Expires ~1:30 PM.',
      ],
    };
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
  const morningEfficiency = data.texture?.morningEfficiency;
  const cutoff = btStats.efficiencyCutoff;
  // Use morning ER for playbook decisions — full-session ER gets diluted by afternoon chop on flush days
  const playER = morningEfficiency != null ? morningEfficiency : efficiencyRatio;
  const isHighEff = playER != null && cutoff != null && playER >= cutoff;
  const textureStats = isHighEff ? btStats.texture?.highEff : btStats.texture?.lowEff;
  const contRate = textureStats?.continuationRate;
  const revRate  = textureStats?.reversalRate;

  const playbook = getPlaybook(data.regime, isHighEff, tier, contRate, revRate, data.texture);

  // Staleness caption -- ADDED 2026-09-28 (DeepSeek Batch 1b review, finding #6): btStats
  // comes from vol_backtest_cache with no "as of" date previously surfaced anywhere -- if the
  // weekly cron stops, this card would keep showing old expansion targets/rates indefinitely
  // with no indication they'd gone stale. `cachedAt` was already returned by the backend
  // (GET /api/acd/vol-backtest-stats), just never rendered.
  const cachedAtStr = btStats.cachedAt
    ? new Date(btStats.cachedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
    : null;

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        {tier && <span style={{ fontSize: 11, color: '#94a3b8' }}>IB exp <strong style={{ color: '#a78bfa' }}>~{tier.avgExpansion}pt</strong></span>}
        {tier && <span style={{ fontSize: 11, color: '#94a3b8' }}>Day range <strong style={{ color: '#94a3b8' }}>{tier.avgDayRange}pt</strong></span>}
        {contRate != null && <span style={{ fontSize: 11, color: '#94a3b8' }}>Cont <strong style={{ color: contRate >= 80 ? '#4ade80' : '#94a3b8' }}>{contRate}%</strong></span>}
      </div>
      <div style={{ background: 'rgba(167,139,250,0.04)', border: '1px solid rgba(167,139,250,0.12)', borderRadius: 5, padding: '6px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Play</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: playbook.dirColor }}>{playbook.direction}</span>
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>N={textureStats?.n ?? btStats.sessionCount}</span>
        </div>
        <ul style={{ margin: 0, padding: '0 0 0 12px', listStyle: 'disc' }}>
          {playbook.rules.map((r, i) => (
            <li key={i} style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.45, marginBottom: 1 }}>{r}</li>
          ))}
        </ul>
        {cachedAtStr && (
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4, textAlign: 'right' }}>backtest as of {cachedAtStr}</div>
        )}
      </div>
    </div>
  );
}

export default function VolatilityRegimeCard() {
  const isViewActive = useViewActive();
  const [data, setData] = useState(null);
  const [btStats, setBtStats] = useState(null);
  // GARCH forward-looking scale -- ADDED 2026-09-28 (DeepSeek Batch 1b review, user's explicit
  // call): this card previously showed ONLY the z-score morning-regime classifier
  // (volatilityRegimeService.js) as "Volatility Regime (live)", a completely different, parallel
  // system from the GARCH(1,1) walk-forward monitor (server/services/volatilityRegime.js) that
  // CLAUDE.md documents as deliberately shipping WITHOUT a qualitative label after being tested
  // and found non-predictive with one -- two sources of truth for "what is volatility doing
  // right now" shown nowhere near each other. Now the card's own headline reading; the z-score
  // regime (which DOES have a real, separately-validated use of its own -- gating C_STANDALONE,
  // acdCandidateBuilder.js) is demoted to the "Morning Regime Playbook" section below, clearly
  // labeled as a distinct, earlier mechanism rather than presented as if it were the same thing.
  const [garch, setGarch] = useState(null);
  // 5min cadence matches quick-check.html's own GARCH card -- nightly-cron-written, not
  // meaningfully fresher than that between runs.
  useEffect(() => {
    if (!isViewActive) return;
    let cancelled = false;
    const loadGarch = () => {
      fetch(`${API_URL}/volatility/regime`)
        .then(r => r.json())
        .then(d => !cancelled && setGarch(d))
        .catch(() => {});
    };
    loadGarch();
    const id = setInterval(loadGarch, 300000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isViewActive]);

  useEffect(() => {
    if (!isViewActive) return;
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
  }, [isViewActive]);

  useEffect(() => {
    fetch(`${API_URL}/acd/vol-backtest-stats`)
      .then(r => r.json())
      .then(d => d && setBtStats(d))
      .catch(() => {});
  }, []);

  // Was an independent 30s poll of live-session-context — found alongside 5 other
  // components doing the exact same thing (2026-07-15). Deduped onto the shared
  // subscription hook.
  const todayDateVRC = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [liveCtxRaw] = useSharedPollData(isViewActive ? `${API_URL}/morning-brief/live-session-context/${todayDateVRC}` : null, 30000);
  const liveCtx = liveCtxRaw?.noData ? null : liveCtxRaw;

  if (!data) {
    return (
      <>
        <GarchHeadline garch={garch} />
        <div style={{ ...cardStyle, opacity: 0.5 }}>
          <div style={titleStyle}>Morning Regime Playbook (z-score)</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>
        </div>
      </>
    );
  }

  if (!data.available) {
    // RTH = 9:30 AM (570) to 4:00 PM (960) ET
    const isRTH = data.etMin != null && data.etMin >= 570 && data.etMin < 960;
    const isForming = isRTH && data.barsLoaded !== undefined && data.barsRequired !== undefined;
    const progressPct = isForming ? Math.min(100, (data.barsLoaded / data.barsRequired) * 100) : 0;

    if (!isRTH) {
      // RTH-only by design (this classifier is computed from the RTH session's own opening
      // volatility baseline) — but "Market Closed" overclaims outside RTH, since Globex
      // trades most of the week and this system actively detects overnight level fades then.
      // Found 2026-07-19 alongside a related bug in DayOfWeekPlaybookCard.jsx. The GARCH
      // headline above is NOT RTH-only (it's a daily forward reading), so it still renders here.
      return (
        <>
          <GarchHeadline garch={garch} />
          <div style={{ ...cardStyle, opacity: 0.6 }}>
            <div style={titleStyle}>Morning Regime Playbook (z-score)</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 3 }}>RTH Only</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Computed from the RTH open — available Mon–Fri 9:30 AM–4:00 PM ET</div>
          </div>
        </>
      );
    }

    return (
      <>
        <GarchHeadline garch={garch} />
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
        <div style={titleStyle}>Morning Regime Playbook (z-score)</div>
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
              <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
                {progressPct.toFixed(0)}%
              </span>
            </div>

            <div style={{ width: '100%', height: 5, backgroundColor: 'rgba(100,116,139,0.15)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ width: `${progressPct}%`, height: '100%', backgroundColor: '#f59e0b', borderRadius: 3, transition: 'width 0.4s ease-out' }} />
            </div>

            <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4 }}>
              Accumulating RTH price bars. Ready at 9:45 AM ET.
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{data.reason}</div>
        )}
        </div>
      </>
    );
  }

  const regime = REGIME_STYLE[data.regime] || REGIME_STYLE['NORMAL-VOL'];
  const trend = TREND_LABEL[data.trend] || TREND_LABEL['insufficient data'];

  const zHigh = data.baselineSd ? (data.baselinePct80 - data.baselineMean) / data.baselineSd : 1.0;
  const zLow  = data.baselineSd ? (data.baselinePct20 - data.baselineMean) / data.baselineSd : -1.0;

  return (
    <>
    <GarchHeadline garch={garch} />
    <div style={cardStyle}>
      <div style={{ ...titleStyle, display: 'flex', alignItems: 'center' }}>
        <span>Morning Regime Playbook (z-score){!data.morningComplete && <span style={{ color: '#94a3b8', fontWeight: 400 }}> — morning window in progress</span>}</span>
        <InfoTooltip text={VOL_CARD_TOOLTIP} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: regime.color, display: 'flex', alignItems: 'center', gap: 6 }}>
            {regime.label}
            {!data.morningComplete && (
              <span style={{ fontSize: 11, fontWeight: 800, color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.3)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Developing
              </span>
            )}
            {trend.text && <span style={{ fontSize: 11, color: trend.color, fontWeight: 600 }}>{trend.text}</span>}
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
            z={data.z?.toFixed(2)} · vol={data.morningVol != null ? data.morningVol.toFixed(5) : '—'}
            {data.dynamicHighThresh != null && <> · hi≥{data.dynamicHighThresh.toFixed(5)} lo≤{data.dynamicLowThresh.toFixed(5)}</>}
          </div>
        </div>
        <Sparkline history={data.history} zHigh={zHigh} zLow={zLow} regimeColor={regime.color} />
      </div>
      {regime.note && (
        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, lineHeight: 1.3 }}>{regime.note}</div>
      )}
      <TextureMetrics texture={data.texture} etMin={data.etMin} />
      {data.emaSnap && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              VWAP Distance
            </span>
            {data.emaSnap.stretched && (
              <span style={{
                fontSize: 11, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
                padding: '1px 6px', borderRadius: 3,
                color: '#fbbf24', background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)',
              }}>
                60pt+ — FADE TO VWAP
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2px 6px' }}>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>VWAP</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#a78bfa', fontFamily: 'monospace' }}>
                {data.emaSnap.vwap?.toLocaleString('en-US') || data.emaSnap.ema9?.toLocaleString('en-US', { maximumFractionDigits: 0 }) || '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>Distance</div>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                color: data.emaSnap.absDeviationATR >= 60 ? '#fbbf24' : data.emaSnap.absDeviationATR >= 40 ? '#fb923c' : '#94a3b8' }}>
                {data.emaSnap.deviation > 0 ? '+' : ''}{Math.round(data.emaSnap.deviation)}pt
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>Side</div>
              <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                color: data.emaSnap.direction === 'ABOVE' ? '#4ade80' : '#f87171' }}>
                {data.emaSnap.direction}
              </div>
            </div>
          </div>
          {data.emaSnap.stretched && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>
              {data.emaSnap.triggerLevel} · 20pt target, 30pt stop
            </div>
          )}
        </div>
      )}
      {liveCtx && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #1e293b' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            {[
              { label: 'RTH VWAP', sigma: liveCtx.dailyVwapSigma, price: liveCtx.vwap, dist: liveCtx.vwapDist, alertAt: 2 },
              { label: '24HR VWAP', sigma: liveCtx.vwap24Sigma, price: liveCtx.vwap24, dist: liveCtx.vwap24Dist, alertAt: 2 },
              { label: 'Wkly VWAP', sigma: liveCtx.weeklyVwapSigma, price: liveCtx.weeklyVwap, dist: liveCtx.weeklyVwapSigma != null && liveCtx.weeklyVwapStd ? Math.round(liveCtx.weeklyVwapSigma * liveCtx.weeklyVwapStd) : null, alertAt: 1.8 },
            ].map(({ label, sigma, price, dist }) => {
              const abs = Math.abs(sigma || 0);
              const borderColor = abs >= 2 ? '#fbbf24' : abs >= 1 ? '#fb923c' : '#334155';
              const sigmaColor  = abs >= 2 ? '#fbbf24' : abs >= 1 ? '#fb923c' : '#94a3b8';
              return (
                <div key={label} style={{ padding: '5px 7px', background: 'rgba(15,23,42,0.5)', borderRadius: 4, borderLeft: `3px solid ${borderColor}` }}>
                  <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                  <div style={{ fontSize: 15, fontWeight: 800, fontFamily: 'monospace', color: sigmaColor, lineHeight: 1.1 }}>
                    {sigma != null ? `${sigma > 0 ? '+' : ''}${sigma}σ` : '—'}
                  </div>
                  {dist != null && (
                    <div style={{ fontSize: 10, color: '#475569' }}>{dist > 0 ? '+' : ''}{dist}pt</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <PredictiveStats data={data} btStats={btStats} />
    </div>
    </>
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
