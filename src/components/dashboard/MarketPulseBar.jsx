import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useViewActive } from '../../utils/useViewActive.js';
import { useSharedPollData } from '../../utils/useSharedPollData.js';

import { API_URL } from '../../constants/api.js';
const POLL_MS = 30000;

const C = {
  green:  '#10b981',
  amber:  '#f59e0b',
  red:    '#ef4444',
  blue:   '#6366f1',
  muted:  '#64748b',
  text:   '#e2e8f0',
  dim:    '#94a3b8',
  bg:     'rgba(15,23,42,0.96)',
  border: 'rgba(255,255,255,0.07)',
};

function verdictColor(v) {
  if (v === 'ENGAGE')      return C.green;
  if (v === 'STAND_ASIDE') return C.red;
  return C.amber;
}

function sigmaColor(s) {
  const abs = Math.abs(s || 0);
  return abs >= 1.5 ? C.amber : abs >= 1 ? '#fb923c' : C.muted;
}

function rangeBar(current, p25, p50, p75) {
  if (!current || !p75) return null;
  const max = p75 * 1.5;
  const pct = Math.min((current / max) * 100, 100);
  const color = current > p75 ? C.red : current > p50 ? C.amber : C.green;
  return (
    <div style={{ position: 'relative', height: 5, background: 'rgba(255,255,255,0.07)', borderRadius: 3, width: 70, flexShrink: 0 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s' }} />
      {[p25, p50, p75].map((p, i) => (
        <div key={i} style={{ position: 'absolute', left: `${Math.min((p / max) * 100, 100)}%`, top: -1, height: 7, width: 1, background: 'rgba(255,255,255,0.25)' }} />
      ))}
    </div>
  );
}

// ── Popover rendered below a clicked chip ──────────────────────────────────────
function ChipPopover({ rect, content, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  const popWidth = 340;
  const centered = rect.left + rect.width / 2 - popWidth / 2;
  const left = Math.max(8, Math.min(centered, window.innerWidth - popWidth - 8));
  // Portaled to document.body — found 2026-07-16 (user screenshot) rendering far
  // off-position when nested inside the sticky, flex-wrapping chip row (ContextChips'
  // own copy in particular). position:fixed should be viewport-relative regardless of
  // DOM nesting, but portaling sidesteps any ancestor stacking-context quirk (transform/
  // filter/contain on something in that tree) rather than chasing the exact cause.
  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', top: rect.bottom + 6, left,
      background: '#111827', border: '1px solid rgba(255,255,255,0.22)',
      borderRadius: 8, padding: '14px 16px', zIndex: 10001,
      boxShadow: '0 12px 40px rgba(0,0,0,0.75)', minWidth: 250, maxWidth: 340,
    }}>
      {content}
    </div>,
    document.body
  );
}

function PopRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', gap: 16 }}>
      <span style={{ fontSize: 12, color: '#94a3b8' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || C.text, fontVariantNumeric: 'tabular-nums' }}>{value ?? '—'}</span>
    </div>
  );
}

function PopNote({ text }) {
  return (
    <>
      <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '8px 0' }} />
      <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>{text}</div>
    </>
  );
}

// ── Uniform chip ───────────────────────────────────────────────────────────────
// flashSpeed: 'fast' (2.5s, urgent spikes) | 'slow' (6s, default subtle glow)
function DataChip({ label, value, sub, subColor, color, flash, flashColor, extra, flashSpeed = 'slow', onClick, active }) {
  const fc  = flashColor || color || C.amber;
  const spd = flashSpeed === 'fast' ? '2.5s' : '6s';
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '5px 12px', borderRadius: 6,
        border: active ? '1px solid rgba(255,255,255,0.28)' : flash ? `1px solid ${fc}66` : `1px solid ${C.border}`,
        background: active ? 'rgba(255,255,255,0.09)' : flash ? `${fc}14` : 'rgba(255,255,255,0.03)',
        animation: flash ? `pulse ${spd} ease-in-out infinite` : 'none',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: color || C.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {extra}
      {sub && <span style={{ fontSize: 11, fontWeight: 700, color: subColor || C.muted, textTransform: 'uppercase' }}>{sub}</span>}
    </div>
  );
}

// ── Size chip ──────────────────────────────────────────────────────────────────
function SizeChip() {
  const isViewActive = useViewActive();
  const [base,    setBase]    = useState(() => parseInt(localStorage.getItem('baseContracts') || '2'));
  const [editing, setEditing] = useState(false);

  // Canonical (fastest, 15s) shared poller for /acd/setup-detection — App.jsx's
  // LiveSessionPanel and TradeAlertBanner's health check both subscribe to this
  // same cache entry now instead of firing their own fetches (found 2026-07-15;
  // the ?date= param some of them used has no effect server-side — the endpoint's
  // own response cache is keyed by a constant string, not the query string).
  const [setupData] = useSharedPollData(isViewActive ? `${API_URL}/acd/setup-detection` : null, 15000);
  const setup = setupData?.setup && !setupData.setup.isExpired ? setupData.setup : null;

  const changeBase = (val) => {
    const n = Math.max(1, Math.min(50, parseInt(val) || 1));
    setBase(n);
    localStorage.setItem('baseContracts', String(n));
    setEditing(false);
  };

  // standDown (loss-streak-based SKIP trigger) removed server-side 2026-09-05 -- its premise
  // was rigorously re-tested and refuted (see acd.js's sizeFactorsAtDetection comment). SKIP now
  // only reflects a genuine sizeMultiplier===0 floor from another, still-valid factor.
  const mult    = setup?.sizeMultiplier ?? null;
  const hasSetup = setup != null && mult !== null;
  const rec     = hasSetup ? (mult === 0 ? 0 : Math.max(1, Math.round(base * mult))) : null;
  const verdict = !hasSetup ? null
    : mult === 0                     ? { label: 'SKIP',    color: C.red,    icon: '⛔' }
    : mult >= 1.1               ? { label: 'TAKE IT', color: C.green,  icon: '✅' }
    : mult >= 0.85              ? { label: 'STD',     color: '#60a5fa', icon: '▶' }
    : mult >= 0.5               ? { label: 'CUT',     color: C.amber,  icon: '⚠' }
    :                             { label: 'TINY',    color: '#f97316', icon: '⬇' };

  const flash = hasSetup && (mult >= 1.1 || mult === 0);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 5, flexShrink: 0,
      border: verdict ? `1px solid ${verdict.color}55` : `1px solid ${C.border}`,
      background: verdict ? `${verdict.color}10` : 'rgba(255,255,255,0.03)',
      animation: flash ? 'pulse 1.2s ease-in-out infinite' : 'none',
    }}>
      <span style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: 'uppercase' }}>Size</span>
      {editing ? (
        <input type="number" defaultValue={base} min={1} max={50} autoFocus
          style={{ width: 28, fontSize: 12, fontWeight: 700, background: 'transparent', border: 'none', outline: 'none', color: C.text, fontVariantNumeric: 'tabular-nums', padding: 0 }}
          onBlur={e => changeBase(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') changeBase(e.target.value); if (e.key === 'Escape') setEditing(false); }} />
      ) : (
        <span onClick={() => setEditing(true)} title="Click to set base contracts"
          style={{ fontSize: 12, fontWeight: 700, color: C.dim, cursor: 'text', borderBottom: '1px dashed rgba(100,116,139,0.35)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {base}
        </span>
      )}
      {hasSetup ? (
        <>
          <span style={{ fontSize: 11, color: C.muted }}>→</span>
          <span style={{ fontSize: 14, fontWeight: 800, color: verdict.color, fontVariantNumeric: 'tabular-nums' }}>
            {rec === 0 ? 'SKIP' : `${rec} ct`}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, color: verdict.color }}>{verdict.icon} {verdict.label}</span>
          <span style={{ fontSize: 10, color: C.muted }}>({mult.toFixed(2)}×)</span>
        </>
      ) : (
        <span style={{ fontSize: 11, color: '#334155', fontWeight: 600 }}>ct</span>
      )}
    </div>
  );
}

// ── All context chips — inline, each clickable for full detail ─────────────────
function ContextChips({ date }) {
  const isViewActive = useViewActive();
  const [ovn,        setOvn]        = useState(null);
  const [popover,    setPopover]    = useState(null); // { key, rect, content }
  const d = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // live-session-context and acd/trend-watch were independent fetches here too —
  // this component was missed by the 2026-07-15 sweep that deduped everywhere
  // else, found while re-measuring 2026-07-15. flush-risk and auction-read/auto
  // don't have another subscriber elsewhere yet, so they stay a local poll.
  const [ctxRaw]     = useSharedPollData(isViewActive ? `${API_URL}/morning-brief/live-session-context/${d}` : null, 30000);
  const ctx = ctxRaw?.noData ? null : ctxRaw;
  const [trendWatchRaw] = useSharedPollData(isViewActive ? `${API_URL}/acd/trend-watch` : null, 60000);
  const trendWatch = trendWatchRaw?.error ? null : trendWatchRaw;
  const [flush,      setFlush]      = useState(null);

  useEffect(() => {
    if (!isViewActive) return;
    const load = async () => {
      const [flushR, autoR] = await Promise.all([
        fetch(`${API_URL}/morning-brief/flush-risk/${d}`).then(r => r.json()).catch(() => ({})),
        fetch(`${API_URL}/auction-read/auto`).then(r => r.json()).catch(() => ({})),
      ]);
      if (!flushR?.error) setFlush(flushR);
      const { overnight_inventory: inv, open_vs_prior_value: ovp, prior_day_profile: pdp,
              value_area_high: vah, value_area_low: val_, poc, inventory_reason: invReason } = autoR || {};
      if (inv || ovp || pdp) setOvn({ inv, ovp, pdp, vah, val: val_, poc, invReason });
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => clearInterval(iv);
  }, [d, isViewActive]);

  const openPop = (key, e, content) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover(prev => prev?.key === key ? null : { key, rect, content });
  };

  const chips = [];

  if (ctx) {
    const L = ctx;

    // Session character
    if (L.sessionChar) {
      const cc = L.sessionChar === 'EXTREME_CHOP' ? C.red : L.sessionChar === 'CHOP' ? C.amber
        : L.sessionChar?.includes('TREND') ? C.green : C.dim;
      const ibClr = L.ibClass === 'WIDE' ? C.red : L.ibClass === 'TIGHT' ? C.green : C.dim;
      chips.push(
        <DataChip key="char" label="Session" value={L.sessionChar.replace(/_/g, ' ')} color={cc}
          active={popover?.key === 'char'}
          onClick={e => openPop('char', e, (
            <div>
              <PopRow label="Session"    value={L.sessionChar?.replace(/_/g,' ')} color={cc} />
              {L.ibClass     && <PopRow label="IB width"   value={`${L.ibClass}${L.ibRange != null ? ` (${L.ibRange.toFixed(0)}pt)` : ''}`} color={ibClr} />}
              {L.sessionRange != null && <PopRow label="Range"      value={`${L.sessionRange.toFixed(0)}pt`} />}
              {L.rangePct    != null && <PopRow label="% of IB"    value={`${L.rangePct.toFixed(0)}%`} />}
              {L.rotations   != null && <PopRow label="Rotations"  value={`${L.rotations}${L.rotationSigma != null ? ` (${L.rotationSigma > 0?'+':''}${L.rotationSigma.toFixed(1)}σ)` : ''}`} />}
              {L.er          != null && <PopRow label="Efficiency" value={L.er.toFixed(2)} />}
            </div>
          ))}
        />
      );
    }

    // RTH VWAP σ
    if (L.dailyVwapSigma != null) {
      const clr = sigmaColor(L.dailyVwapSigma);
      const fl  = Math.abs(L.dailyVwapSigma) >= 1.5;
      chips.push(
        <DataChip key="rvwap" label="RVWAP" value={`${L.dailyVwapSigma > 0?'+':''}${L.dailyVwapSigma}σ`}
          color={clr} flash={fl} flashColor={C.amber}
          active={popover?.key === 'rvwap'}
          onClick={e => openPop('rvwap', e, (
            <div>
              <PopRow label="RTH VWAP σ"  value={`${L.dailyVwapSigma > 0?'+':''}${L.dailyVwapSigma}σ`} color={clr} />
              {L.dailyVwapPrice != null && <PopRow label="Price"      value={L.dailyVwapPrice.toFixed(2)} />}
              {L.dailyVwapDist  != null && <PopRow label="Distance"   value={`${L.dailyVwapDist > 0?'+':''}${L.dailyVwapDist.toFixed(0)}pt`} color={L.dailyVwapDist > 0 ? C.green : C.red} />}
              <PopNote text="Pulses when |σ| ≥ 1.5 — price stretched vs session VWAP" />
            </div>
          ))}
        />
      );
    }

    // 24HR VWAP σ
    if (L.vwap24Sigma != null) {
      const clr = sigmaColor(L.vwap24Sigma);
      const fl  = Math.abs(L.vwap24Sigma) >= 1.5;
      chips.push(
        <DataChip key="vwap24" label="24H" value={`${L.vwap24Sigma > 0?'+':''}${L.vwap24Sigma}σ`}
          color={clr} flash={fl} flashColor={C.amber}
          active={popover?.key === 'vwap24'}
          onClick={e => openPop('vwap24', e, (
            <div>
              <PopRow label="24HR VWAP σ" value={`${L.vwap24Sigma > 0?'+':''}${L.vwap24Sigma}σ`} color={clr} />
              {L.vwap24Price != null && <PopRow label="Price"     value={L.vwap24Price.toFixed(2)} />}
              {L.vwap24Dist  != null && <PopRow label="Distance"  value={`${L.vwap24Dist > 0?'+':''}${L.vwap24Dist.toFixed(0)}pt`} color={L.vwap24Dist > 0 ? C.green : C.red} />}
              <PopNote text="Pulses when |σ| ≥ 1.5 — overnight context stretch" />
            </div>
          ))}
        />
      );
    }

    // Weekly VWAP σ
    if (L.weeklyVwapSigma != null) {
      const clr = sigmaColor(L.weeklyVwapSigma);
      const fl  = Math.abs(L.weeklyVwapSigma) >= 1.5;
      chips.push(
        <DataChip key="wkvwap" label="WK VWAP" value={`${L.weeklyVwapSigma > 0?'+':''}${L.weeklyVwapSigma}σ`}
          color={clr} flash={fl} flashColor={C.amber}
          active={popover?.key === 'wkvwap'}
          onClick={e => openPop('wkvwap', e, (
            <div>
              <PopRow label="Weekly VWAP σ" value={`${L.weeklyVwapSigma > 0?'+':''}${L.weeklyVwapSigma}σ`} color={clr} />
              {L.weeklyVwapPrice != null && <PopRow label="Price"    value={L.weeklyVwapPrice.toFixed(2)} />}
              {L.weeklyVwapDist  != null && <PopRow label="Distance" value={`${L.weeklyVwapDist > 0?'+':''}${L.weeklyVwapDist.toFixed(0)}pt`} color={L.weeklyVwapDist > 0 ? C.green : C.red} />}
              <PopNote text="Pulses when |σ| ≥ 1.5 — weekly mean-reversion signal" />
            </div>
          ))}
        />
      );
    }

    // Micro structure
    if (L.microTrend && L.microTrend !== 'NEUTRAL') {
      const mc = L.microTrend === 'HIGHER_LOWS' ? C.green : L.microTrend === 'LOWER_LOWS' ? C.red : C.amber;
      chips.push(
        <DataChip key="mt" label="Struct" value={L.microTrend.replace(/_/g, ' ')} color={mc}
          flash={true} flashColor={mc}
          active={popover?.key === 'mt'}
          onClick={e => openPop('mt', e, (
            <div>
              <PopRow label="Structure"   value={L.microTrend?.replace(/_/g,' ')} color={mc} />
              {L.er != null && <PopRow label="Efficiency" value={L.er.toFixed(2)} />}
              <PopNote text={L.microTrend === 'HIGHER_LOWS' ? 'Buyers absorbing pullbacks — lean long' : 'Sellers defending bounces — lean short'} />
            </div>
          ))}
        />
      );
    }

    // Delta signal
    if (L.delta?.trend) {
      const dc = (L.delta.trend === 'BUYING' || L.delta.trend === 'STRENGTHENING') ? C.green
        : (L.delta.trend === 'SELLING' || L.delta.trend === 'WEAKENING') ? C.red : C.muted;
      chips.push(
        <DataChip key="dt" label="Δ" value={L.delta.trend} color={dc}
          flash={L.delta.trend !== 'FLAT'} flashColor={dc}
          active={popover?.key === 'dt'}
          onClick={e => openPop('dt', e, (
            <div>
              <PopRow label="Delta signal" value={L.delta.trend} color={dc} />
              {L.delta.cumDelta   != null && <PopRow label="Cum delta"  value={`${L.delta.cumDelta > 0?'+':''}${L.delta.cumDelta.toLocaleString()}`} color={L.delta.cumDelta > 0 ? C.green : C.red} />}
              {L.delta.sigma      != null && <PopRow label="Δ σ"        value={`${L.delta.sigma > 0?'+':''}${L.delta.sigma.toFixed(1)}σ`} />}
              {L.delta.deltaClass && <PopRow label="Class"      value={L.delta.deltaClass} />}
              <PopNote text="Pulses when directional — flat delta = no conviction" />
            </div>
          ))}
        />
      );
    }
  }

  // Big Move alert — prior TURBULENT + delta confirming
  if (ovn?.pdp === 'TURBULENT') {
    const deltaConfirmed = trendWatch?.conditions?.find(c => c.key === 'deltaConfirmed')?.met === true;
    const bmColor = deltaConfirmed ? C.amber : '#f97316';
    const bmLabel = deltaConfirmed ? 'BIG MOVE' : 'PRIOR TURB';
    const bmValue = deltaConfirmed ? 'TURB+Δ ★' : 'TURBULENT';
    chips.push(
      <DataChip key="turbdelta" label={bmLabel} value={bmValue} color={bmColor}
        flash={true} flashColor={bmColor} flashSpeed={deltaConfirmed ? 'fast' : 'slow'}
        active={popover?.key === 'turbdelta'}
        onClick={e => openPop('turbdelta', e, (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: bmColor, marginBottom: 6 }}>
              {deltaConfirmed ? '★ BIG MOVE SIGNAL' : '⚡ Prior Day: TURBULENT'}
            </div>
            <PopRow label="Prior day" value="TURBULENT" color={C.amber} />
            <PopRow label="Delta" value={deltaConfirmed ? 'CONFIRMED ✓' : 'not yet confirmed'} color={deltaConfirmed ? C.green : C.muted} />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '6px 0' }} />
            {deltaConfirmed ? (
              <>
                <div style={{ fontSize: 11, color: C.text, lineHeight: 1.6, marginBottom: 6 }}>
                  Both conditions met. Strongest large-move signal in the dataset (N=21).
                </div>
                <PopRow label="Expected p50 range" value="450pt" color={C.text} />
                <PopRow label="Expected p75 range" value="526pt" color={C.amber} />
                <PopRow label="Sessions >400pt" value="52%" color={C.amber} />
                <PopNote text="Watch for A signal to lock in direction. Once A signal + delta align, the move is typically underway. Size up in trend direction — fade edge is OFF." />
              </>
            ) : (
              <>
                <div style={{ fontSize: 11, color: C.text, lineHeight: 1.6, marginBottom: 6 }}>
                  Prior TURBULENT day. Large follow-through likely when delta confirms. Watch for: A signal fire + cumulative delta crossing into top/bottom quartile.
                </div>
                <PopRow label="Prior TURB p75 range" value="522pt" color={C.text} />
                <PopRow label="% sessions >400pt" value="48%" color={C.text} />
                <PopNote text="Delta confirmation pending. When it fires, this chip pulses fast and updates to BIG MOVE. Until then, treat as elevated volatility — standard size." />
              </>
            )}
          </div>
        ))}
      />
    );
  }

  // Flush risk
  if (flush?.score != null) {
    const fc = flush.score >= 4 ? C.red : flush.score >= 2 ? C.amber : C.muted;
    chips.push(
      <DataChip key="flush" label="Flush" value={`${flush.score}/${flush.maxScore || 5}`}
        color={fc} sub={flush.label} subColor={fc}
        flash={flush.score >= 3} flashColor={C.red} flashSpeed="fast"
        active={popover?.key === 'flush'}
        onClick={e => openPop('flush', e, (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: fc, marginBottom: 6 }}>
              Flush Risk {flush.score}/{flush.maxScore || 5} — {flush.label || ''}
            </div>
            {flush.components?.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 0' }}>
                <span style={{ fontSize: 12, color: c.met ? C.green : C.muted }}>{c.met ? '✓' : '○'}</span>
                <span style={{ fontSize: 11, color: c.met ? C.text : C.muted }}>{c.name}</span>
              </div>
            ))}
            <PopNote text="Pulses fast at ≥ 3/5 — cascade flush risk elevated" />
          </div>
        ))}
      />
    );
  }

  // Overnight inventory
  if (ovn?.inv) {
    const ic = ovn.inv === 'SHORT_TRAPPED' ? C.green : ovn.inv === 'LONG_TRAPPED' ? C.red : C.muted;
    const il = ovn.inv === 'SHORT_TRAPPED' ? 'SHORT TRAP' : ovn.inv === 'LONG_TRAPPED' ? 'LONG TRAP' : 'NEUTRAL';
    chips.push(
      <DataChip key="inv" label="INV" value={il} color={ic}
        active={popover?.key === 'inv'}
        onClick={e => openPop('inv', e, (
          <div>
            <PopRow label="Inventory"   value={il} color={ic} />
            {ovn.pdp && <PopRow label="Prior day"  value={ovn.pdp} />}
            {ovn.ovp && <PopRow label="Open vs VA" value={ovn.ovp?.replace(/_/g,' ')} color={ovn.ovp === 'ABOVE_VALUE' ? C.green : ovn.ovp === 'BELOW_VALUE' ? C.red : C.muted} />}
            {ovn.invReason && (
              <>
                <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '6px 0' }} />
                <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5 }}>{ovn.invReason}</div>
              </>
            )}
            <PopNote text="Overnight inventory classification — set at open, static for the session" />
          </div>
        ))}
      />
    );
  }

  // Open vs value area
  if (ovn?.ovp) {
    const oc = ovn.ovp === 'ABOVE_VALUE' ? C.green : ovn.ovp === 'BELOW_VALUE' ? C.red : C.muted;
    const ol = ovn.ovp === 'ABOVE_VALUE' ? '↑ VA' : ovn.ovp === 'BELOW_VALUE' ? '↓ VA' : '= VA';
    chips.push(
      <DataChip key="ovp" label="vs VA" value={ol} color={oc}
        active={popover?.key === 'ovp'}
        onClick={e => openPop('ovp', e, (
          <div>
            <PopRow label="Open vs VA" value={ovn.ovp?.replace(/_/g,' ')} color={oc} />
            {ovn.vah != null && <PopRow label="VAH"       value={ovn.vah.toFixed(2)} />}
            {ovn.poc != null && <PopRow label="POC"       value={ovn.poc.toFixed(2)} />}
            {ovn.val != null && <PopRow label="VAL"       value={ovn.val.toFixed(2)} />}
            <PopNote text="Outside value = directional conviction; inside = rotation likely" />
          </div>
        ))}
      />
    );
  }

  return (
    <>
      {chips}
      {popover && (
        <ChipPopover rect={popover.rect} content={popover.content} onClose={() => setPopover(null)} />
      )}
    </>
  );
}

// ── Live Read Modal ────────────────────────────────────────────────────────────
export function LiveReadModal({ onClose, suggestedPrice }) {
  const [direction, setDirection] = useState(null);
  const [price, setPrice] = useState(suggestedPrice ? String(Math.round(suggestedPrice * 100) / 100) : '');
  const [note,  setNote]  = useState('');
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  const submit = async () => {
    if (!direction || !price) return;
    setSaving(true);
    try {
      await fetch(`${API_URL}/live-reads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, entryPrice: parseFloat(price), note }),
      });
      setSaved(true);
      setTimeout(onClose, 800);
    } catch { setSaving(false); }
  };

  const btnStyle = (dir) => ({
    flex: 1, padding: '12px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
    fontSize: 15, fontWeight: 700, letterSpacing: '0.05em',
    background: direction === dir ? (dir === 'LONG' ? C.green : C.red) : 'rgba(255,255,255,0.07)',
    color: direction === dir ? '#fff' : C.dim, transition: 'all 0.15s',
  });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#0f172a', border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, width: 320, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Log Live Read</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button style={btnStyle('LONG')}  onClick={() => setDirection('LONG')}>▲ LONG</button>
          <button style={btnStyle('SHORT')} onClick={() => setDirection('SHORT')}>▼ SHORT</button>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Entry Price {suggestedPrice ? <span style={{ color: C.muted }}>(suggested: {suggestedPrice.toFixed(2)})</span> : ''}
          </label>
          <input type="number" step="0.25" value={price} onChange={e => setPrice(e.target.value)}
            placeholder="e.g. 21840.50" autoFocus
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: `1px solid ${C.border}`, color: C.text, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>What you're seeing (optional)</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
            placeholder="vwap holding, near IB mid, delta weak, expecting recoil…"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: `1px solid ${C.border}`, color: C.text, fontSize: 13, resize: 'none', boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit' }} />
        </div>
        <button onClick={submit} disabled={!direction || !price || saving}
          style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none',
            background: saved ? C.green : (!direction || !price) ? 'rgba(255,255,255,0.06)' : C.blue,
            color: (!direction || !price) ? C.muted : '#fff',
            fontWeight: 700, fontSize: 14, cursor: (!direction || !price) ? 'default' : 'pointer', transition: 'background 0.2s' }}>
          {saved ? '✓ Logged' : saving ? 'Saving…' : 'Log Read'}
        </button>
      </div>
    </div>
  );
}

// ── Main bar ───────────────────────────────────────────────────────────────────
export default function MarketPulseBar() {
  const isViewActive = useViewActive();
  const [showModal, setShowModal] = useState(false);
  const [pop,       setPop]       = useState(null);
  const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const openPop = (key, e, content) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPop(prev => prev?.key === key ? null : { key, rect, content });
  };

  // Shares its poll cycle with App.jsx's always-mounted SidebarVerdictChip
  // (same URL/interval) instead of an independent fetch — see
  // docs/OPEN_THREADS.md, dedup pass 2026-07-15.
  const [pulseData] = useSharedPollData(isViewActive ? `${API_URL}/market/pulse` : null, POLL_MS);
  const pulse = pulseData?.error ? null : pulseData;

  if (!pulse) return null;

  const { currentPrice, ptsFromOpen, sessionRange, sessionDelta, deltaSign, deltaClass,
          rangeP25, rangeP50, rangeP75, rangeClass, rvol, rvolSigma, verdict, verdictDir } = pulse;

  const moveColor    = rangeClass === 'EXTENDED' ? C.red : rangeClass === 'QUIET' ? C.muted : C.amber;
  const deltaColor   = deltaClass === 'HIGH' ? (deltaSign === 'BUYING' ? C.green : C.red) : C.dim;
  const deltaArrow   = deltaSign === 'BUYING' ? '▲' : deltaSign === 'SELLING' ? '▼' : '—';
  const fromOpenStr  = ptsFromOpen != null ? `${ptsFromOpen >= 0 ? '+' : ''}${ptsFromOpen.toFixed(0)}pt` : '—';
  const fromOpenClr  = ptsFromOpen == null ? C.muted : ptsFromOpen > 0 ? C.green : ptsFromOpen < 0 ? C.red : C.muted;
  const rangeLabel   = rangeClass === 'EXTENDED' ? 'BIG' : rangeClass === 'QUIET' ? 'QUIET' : 'NORMAL';
  // RVol: time-adjusted (sigma from 90-day per-minute baseline). Spike = σ ≥ 1.0
  const rvolColor    = rvolSigma >= 2 ? C.red : rvolSigma >= 1 ? C.amber : rvolSigma < -0.5 ? C.muted : C.dim;
  const rvolFlash    = rvolSigma != null && rvolSigma >= 1.0;
  const rvolLabel    = rvolSigma >= 2 ? 'EXTREME' : rvolSigma >= 1 ? 'SPIKE' : '';

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 5,
        background: C.bg, borderBottom: `1px solid ${C.border}`,
        padding: '5px 14px', fontSize: 12, userSelect: 'none',
        backdropFilter: 'blur(10px)', position: 'sticky', top: 0, zIndex: 100,
      }}>

        {/* Market data */}
        <DataChip label="NQ" value={currentPrice ? currentPrice.toFixed(2) : '—'}
          sub={fromOpenStr} subColor={fromOpenClr} color={C.text}
          flash={Math.abs(ptsFromOpen || 0) >= 60}
          flashColor={ptsFromOpen >= 0 ? C.green : C.red} flashSpeed="fast"
          active={pop?.key === 'nq'}
          onClick={e => openPop('nq', e, (
            <div>
              <PopRow label="Price"     value={currentPrice?.toFixed(2)} color={C.text} />
              <PopRow label="From open" value={fromOpenStr} color={fromOpenClr} />
              <PopNote text="Distance from today's RTH open. Flashes at ±60pt — signals momentum or trapped participants building pressure." />
            </div>
          ))}
        />
        <DataChip label="Range" value={sessionRange ? `${sessionRange.toFixed(0)}pt` : '—'}
          sub={rangeLabel} subColor={moveColor} color={moveColor}
          flash={rangeClass === 'EXTENDED'} flashColor={C.red} flashSpeed="fast"
          extra={rangeBar(sessionRange, rangeP25, rangeP50, rangeP75)}
          active={pop?.key === 'range'}
          onClick={e => openPop('range', e, (
            <div>
              <PopRow label="Session range" value={sessionRange ? `${sessionRange.toFixed(0)}pt` : '—'} color={moveColor} />
              <PopRow label="Class"         value={rangeLabel} color={moveColor} />
              <PopRow label="p25 / p50 / p75" value={`${rangeP25?.toFixed(0)} / ${rangeP50?.toFixed(0)} / ${rangeP75?.toFixed(0)}pt`} />
              <PopNote text="Range vs 90-day distribution. EXTENDED = above p75 (big move day). QUIET = below p25 (low conviction, wait for expansion). Flashes red when extended." />
            </div>
          ))}
        />
        <DataChip label="CumΔ"
          value={sessionDelta != null ? `${deltaArrow} ${Math.abs(sessionDelta).toLocaleString()}` : '—'}
          sub={deltaClass !== 'NORMAL' ? deltaClass : null} subColor={deltaColor}
          color={deltaColor} flash={deltaClass === 'HIGH'} flashColor={deltaColor} flashSpeed="fast"
          active={pop?.key === 'cumd'}
          onClick={e => openPop('cumd', e, (
            <div>
              <PopRow label="Cum delta"  value={sessionDelta != null ? `${sessionDelta > 0?'+':''}${sessionDelta.toLocaleString()}` : '—'} color={deltaColor} />
              <PopRow label="Direction"  value={deltaSign || '—'} color={deltaColor} />
              <PopRow label="Class"      value={deltaClass} color={deltaColor} />
              <PopNote text="Cumulative order flow (ask vol − bid vol) since RTH open. HIGH class = top/bottom quartile of 60-day history. Strong positive delta on a prior-TURB day = big move signal." />
            </div>
          ))}
        />
        {rvol != null && (
          <DataChip label="RVol" value={`${rvol.toFixed(1)}×`}
            sub={rvolLabel || undefined} subColor={rvolColor}
            color={rvolColor}
            flash={rvolFlash} flashColor={rvolSigma >= 2 ? C.red : C.amber}
            flashSpeed={rvolSigma >= 2 ? 'fast' : 'slow'}
            active={pop?.key === 'rvol'}
            onClick={e => openPop('rvol', e, (
              <div>
                <PopRow label="Rel volume"   value={`${rvol.toFixed(1)}×`} color={rvolColor} />
                <PopRow label="σ vs baseline" value={rvolSigma != null ? `${rvolSigma > 0?'+':''}${rvolSigma.toFixed(1)}σ` : '—'} color={rvolColor} />
                <PopNote text="Time-adjusted volume vs 90-day same-minute baseline. SPIKE (1σ+) = elevated participation. EXTREME (2σ+) = institutional conviction or flush risk. High RVol on A signal bar = stronger follow-through." />
              </div>
            ))}
          />
        )}

        <SizeChip />

        <div style={{ width: 1, height: 18, background: C.border, flexShrink: 0, margin: '0 2px' }} />

        {/* Session + overnight context — all inline, click each for detail */}
        <ContextChips date={dateStr} />

        {/* Log read */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setShowModal(true)}
            style={{ padding: '3px 10px', borderRadius: 5, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)', color: C.dim, fontSize: 11, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = C.border; }}>
            + Log Read
          </button>
        </div>

      </div>

      {pop && <ChipPopover rect={pop.rect} content={pop.content} onClose={() => setPop(null)} />}
      {showModal && <LiveReadModal onClose={() => setShowModal(false)} suggestedPrice={pulse.currentPrice} />}
    </>
  );
}
