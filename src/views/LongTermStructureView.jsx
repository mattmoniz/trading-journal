import React, { useState, useEffect } from 'react';
import { fmtP } from '../utils/format.js';
import { isStale } from '../utils/timestamps.js';
import InfoTooltip from '../components/shared/InfoTooltip.jsx';
import { Line, Area } from 'recharts';

const API_URL = '/api';

function CompositeProfileCard() {
  const [tpo, setTpo] = React.useState(null);
  const [days, setDays] = React.useState(5);

  React.useEffect(() => {
    setTpo(null);
    fetch(`${API_URL}/composite-profile?days=${days}`).then(r => r.json()).then(setTpo).catch(() => {});
  }, [days]);

  if (!tpo) return <div style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'Arial, sans-serif', padding: '20px 0' }}>Loading composite profile…</div>;
  if (!tpo.available) return <div style={{ color: '#94a3b8', fontSize: 13 }}>No bar data available.</div>;

  const { profile, poc, vah, val, hvn, lvn, currentPrice, priceContext, priceVsVA, priceVsPoc, maxTpo } = tpo;

  // Clip profile to visible range (within ±200pts of POC for readability)
  const visMin = Math.max(Math.min(...profile.map(r => r.px)), poc - 400);
  const visMax = Math.min(Math.max(...profile.map(r => r.px)), poc + 400);
  const vis = profile.filter(r => r.px >= visMin && r.px <= visMax);

  // Show every 4th level (1-pt increments = 0.25 * 4 = 1pt spacing for display)
  const step = Math.max(1, Math.floor(vis.length / 80));
  const displayed = vis.filter((_, i) => i % step === 0);

  const barMaxW = 180; // max bar width px
  const priceColor = priceVsVA === 'ABOVE' ? '#22c55e' : priceVsVA === 'BELOW' ? '#ef4444' : '#fbbf24';

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>
      {/* Day selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[5, 10, 20].map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={{ padding: '3px 12px', fontSize: 13, borderRadius: 4, cursor: 'pointer', border: `1px solid ${days === d ? '#3b82f6' : 'var(--border-color)'}`, background: days === d ? '#3b82f6' : 'var(--input-bg)', color: days === d ? '#fff' : '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
            {d}d
          </button>
        ))}
        <span style={{ marginLeft: 8, fontSize: 13, color: '#cbd5e1', alignSelf: 'center' }}>Composite TPO — where price spent the most time</span>
      </div>

      {/* Key levels summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          ['Composite POC', fmtP(poc), '#e879f9', 'Most time spent — strongest magnet'],
          ['Composite VAH', fmtP(vah), '#22c55e', '70% value area high'],
          ['Composite VAL', fmtP(val), '#ef4444', '70% value area low'],
          ['Current', fmtP(currentPrice), priceColor, priceVsVA + ' value area'],
        ].map(([label, val2, color, sub]) => (
          <div key={label} style={{ padding: '6px 12px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${color}30`, borderRadius: 6, minWidth: 100 }}>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: 'monospace' }}>{val2 || '—'}</div>
            <div style={{ fontSize: 13, color: '#94a3b8' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Horizontal profile bars — price on left, bar extending right */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          {displayed.slice().reverse().map(row => {
            const isPoc  = Math.abs(row.px - poc) < 0.13;
            const isVah  = Math.abs(row.px - vah) < 0.13;
            const isVal  = Math.abs(row.px - val) < 0.13;
            const isHvn  = hvn.some(h => Math.abs(h - row.px) < 0.13);
            const isLvn  = lvn.some(l => Math.abs(l - row.px) < 0.13);
            const isCur  = currentPrice && Math.abs(row.px - currentPrice) < 2;
            const inVA   = row.px >= val && row.px <= vah;
            const barW   = Math.round((row.tpo / maxTpo) * barMaxW);
            const barColor = isPoc ? '#e879f9' : isHvn ? '#fbbf24' : inVA ? '#3b82f680' : '#64748b60';

            return (
              <div key={row.px} style={{ display: 'flex', alignItems: 'center', gap: 4, height: 10, marginBottom: 1 }}>
                <div style={{ width: 52, textAlign: 'right', fontSize: 11, color: isPoc ? '#e879f9' : isVah ? '#22c55e' : isVal ? '#ef4444' : isCur ? priceColor : '#374151', fontWeight: (isPoc || isVah || isVal || isCur) ? 700 : 400, flexShrink: 0, fontFamily: 'monospace' }}>
                  {(isPoc || isVah || isVal || isCur) ? fmtP(row.px) : ''}
                </div>
                <div style={{ width: barW, height: 8, background: barColor, borderRadius: 1, flexShrink: 0, minWidth: 1 }} />
                {isCur && <div style={{ width: 2, height: 12, background: priceColor, flexShrink: 0, marginLeft: -2 }} />}
                {(isPoc || isHvn || isLvn) && (
                  <div style={{ fontSize: 11, color: isPoc ? '#e879f9' : isHvn ? '#fbbf24' : '#ef4444', flexShrink: 0 }}>
                    {isPoc ? 'POC' : isHvn ? 'HVN' : 'LVN'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Context sentence */}
      {priceContext && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: `${priceColor}08`, borderLeft: `3px solid ${priceColor}`, borderRadius: '0 6px 6px 0', fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>
          {priceContext}
        </div>
      )}

      {/* HVN/LVN list */}
      {(hvn.length > 0 || lvn.length > 0) && (
        <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
          {hvn.length > 0 && <div><span style={{ color: '#fbbf24', fontWeight: 700 }}>HVN </span><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{hvn.slice(0,5).map(h=>h.toFixed(0)).join(' · ')}</span></div>}
          {lvn.length > 0 && <div><span style={{ color: '#ef4444', fontWeight: 700 }}>LVN </span><span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{lvn.slice(0,5).map(l=>l.toFixed(0)).join(' · ')}</span></div>}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 13, color: '#94a3b8' }}>
        HVN = high time node (price slows here) · LVN = low time node (price moves fast through) · POC = point of control (most time spent)
      </div>
    </div>
  );
}

// ── Playbook Reference Page ────────────────────────────────────────────────────

function LongTermStructurePage({ setCurrentView }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [howToOpen, setHowToOpen] = React.useState(false);

  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMin = nowET.getHours() * 60 + nowET.getMinutes();
  const inSession = etMin >= 9*60+30 && etMin < 16*60;

  React.useEffect(() => {
    const load = () => {
      setLoading(prev => prev === true); // only show spinner on first load
      fetch(`${API_URL}/longterm/summary`).then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(iv);
  }, []);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)', fontFamily: 'Arial, sans-serif' }}>Loading market structure…</div>;
  if (!data || data.error) return <div style={{ padding: 40, color: '#ef4444' }}>Error loading structure data.</div>;

  const { summary, valueMigration, acd, effortResult, bracketState, profileShapes, weeklyStructure } = data;

  const summaryColor = { BULLISH: '#22c55e', BEARISH: '#ef4444', TRANSITIONAL: '#fbbf24', NEUTRAL: '#94a3b8' };
  const stateColor   = { TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', TRANSITIONAL: '#fbbf24', BRACKET: '#3b82f6' };
  const shapeColor   = { ELONGATED: '#f97316', FAT: '#3b82f6', SQUAT: '#fbbf24', NONSYMMETRIC_TOP: '#a78bfa', NONSYMMETRIC_BOTTOM: '#ec4899' };
  const shapeIcon    = { ELONGATED: '▌', FAT: '▬', SQUAT: '▀', NONSYMMETRIC_TOP: '▲', NONSYMMETRIC_BOTTOM: '▼' };

  const card = (children, style = {}) => (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px', ...style }}>
      {children}
    </div>
  );

  const sectionLabel = (text, tip) => (
    <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', fontFamily: 'Arial, sans-serif', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
      {text}{tip && <InfoTooltip text={tip} />}
    </div>
  );

  // VA Migration Stack — horizontal bars with price axis + hover tooltips
  const VAStack = () => {
    const [hovered, setHovered] = React.useState(null);
    const days = (valueMigration.last10 || []).filter(d => d.vah && d.val);
    if (!days.length) return <div style={{ color: '#94a3b8', fontSize: 13 }}>No value area data — compute from price bars in settings.</div>;

    const pad = 50; // price padding either side
    const allPrices = days.flatMap(d => [d.vah, d.val]);
    const minP = Math.min(...allPrices) - pad;
    const maxP = Math.max(...allPrices) + pad;
    const priceRange = maxP - minP || 1;

    // 4 price axis labels
    const axisPrices = [0, 1, 2, 3].map(i => Math.round((minP + (priceRange * i / 3)) / 25) * 25);

    const pct = p => ((p - minP) / priceRange * 100).toFixed(2);

    return (
      <div style={{ fontFamily: 'Arial, sans-serif' }}>
        {/* Price axis */}
        <div style={{ display: 'flex', marginLeft: 44, marginBottom: 4, position: 'relative', height: 14 }}>
          {axisPrices.map(p => (
            <div key={p} style={{ position: 'absolute', left: `${pct(p)}%`, transform: 'translateX(-50%)', fontSize: 13, color: '#94a3b8' }}>{p.toLocaleString()}</div>
          ))}
        </div>

        {/* Bars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {days.map((d, i) => {
            const prev = days[i - 1];
            let color = '#64748b';
            if (prev) {
              const overlap = Math.min(d.vah, prev.vah) - Math.max(d.val, prev.val);
              if (d.poc > prev.poc && overlap < (d.vah - d.val) * 0.5) color = '#22c55e';
              else if (d.poc < prev.poc && overlap < (d.vah - d.val) * 0.5) color = '#ef4444';
            }
            const isHov = hovered === d.date;
            return (
              <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}
                onMouseEnter={() => setHovered(d.date)} onMouseLeave={() => setHovered(null)}>
                <div style={{ fontSize: 13, color: isHov ? '#94a3b8' : '#94a3b8', width: 40, textAlign: 'right', flexShrink: 0, fontFamily: 'Arial, sans-serif' }}>{d.date?.slice(5)}</div>
                <div style={{ flex: 1, position: 'relative', height: 20, background: 'rgba(255,255,255,0.02)', borderRadius: 2, cursor: 'default' }}>
                  {/* VA bar */}
                  <div style={{ position: 'absolute', left: `${pct(d.val)}%`, width: `${((d.vah - d.val) / priceRange * 100).toFixed(2)}%`, height: '100%', background: `${color}35`, border: `1px solid ${color}70`, borderRadius: 2 }} />
                  {/* POC tick */}
                  <div style={{ position: 'absolute', left: `${pct(d.poc)}%`, top: 0, width: 2, height: '100%', background: '#e879f9', borderRadius: 1 }} />
                  {/* VAH / VAL labels on hover */}
                  {isHov && <>
                    <div style={{ position: 'absolute', left: `${pct(d.val)}%`, top: '50%', transform: 'translate(-100%,-50%)', fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', paddingRight: 3 }}>{Math.round(d.val)}</div>
                    <div style={{ position: 'absolute', left: `${pct(d.vah)}%`, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', paddingLeft: 3 }}>{Math.round(d.vah)}</div>
                  </>}
                </div>
                {/* Hover tooltip */}
                {isHov && (
                  <div style={{ position: 'absolute', left: '50%', top: -70, transform: 'translateX(-50%)', background: '#1a2535', border: '1px solid rgba(100,116,139,0.5)', borderRadius: 6, padding: '6px 10px', fontSize: 13, color: '#94a3b8', zIndex: 10, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                    <div style={{ color: '#e2e8f0', fontWeight: 700, marginBottom: 3 }}>{d.date}</div>
                    <div style={{ color: '#22c55e' }}>VAH {d.fmtP(vah)}</div>
                    <div style={{ color: '#e879f9' }}>POC {d.fmtP(poc)}</div>
                    <div style={{ color: '#ef4444' }}>VAL {d.fmtP(val)}</div>
                    <div style={{ color: '#cbd5e1', marginTop: 2, fontSize: 13 }}>Range {(d.vah - d.val)?.toFixed(0)} pts</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* POC migration line */}
        <svg style={{ position: 'absolute', top: 0, left: 44, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'visible' }} />

        <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
          <span style={{ color: '#22c55e' }}>■ migrating higher</span>
          <span style={{ color: '#ef4444' }}>■ migrating lower</span>
          <span style={{ color: '#94a3b8' }}>■ overlapping</span>
          <span style={{ color: '#e879f9' }}>| POC</span>
        </div>
        <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 6, fontFamily: 'Arial, sans-serif' }}>
          Each bar = one day's value area (70% of volume). Hover for exact levels. Left edge = VAL, right edge = VAH, pink tick = POC.
        </div>
      </div>
    );
  };

  // ACD sparkline
  const ACDSparkline = () => {
    const pts = (acd.sparkline || []).slice(-30);
    if (!pts.length) return null;
    const W = 280, H = 50;
    const maxS = Math.max(...pts.map(p => Math.abs(p.score)), 4);
    const mid = H / 2;
    const step = W / (pts.length - 1 || 1);
    const pathPts = pts.map((p, i) => `${i * step},${mid - (p.score / maxS) * (mid - 4)}`).join(' ');
    return (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="#2d3748" strokeWidth={1} />
        <polyline points={pathPts} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
        {pts.map((p, i) => p.score !== 0 && (
          <circle key={i} cx={i * step} cy={mid - (p.score / maxS) * (mid - 4)} r={2}
            fill={p.score > 0 ? '#22c55e' : '#ef4444'} />
        ))}
      </svg>
    );
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto', fontFamily: 'Arial, sans-serif', fontSize: 13, color: '#94a3b8' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Long-Term Market Structure</h2>
          <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 4 }}>
            {data.generatedAt && `Updated ${formatTimestamp(data.generatedAt)}`}
            {data.generatedAt && isStale(data.generatedAt, 26) && (
              <span style={{ color: '#fbbf24', marginLeft: 8 }}>⚠ data may not reflect today's session</span>
            )}
            {' · '}
            {data.dataQuality === 'GOOD' ? <span style={{ color: '#22c55e' }}>● {data.loggedDays} days logged — good data quality</span>
              : data.dataQuality === 'LIMITED' ? <span style={{ color: '#fbbf24' }}>⚠ {data.loggedDays} days logged — limited data, readings may not be representative</span>
              : <span style={{ color: '#ef4444' }}>⚠ {data.loggedDays} days logged — insufficient data</span>}
          </div>
        </div>
        {inSession && <div style={{ fontSize: 13, color: '#fbbf24', padding: '4px 10px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5 }}>Read-only during session</div>}
      </div>

      {/* 1. Structural Summary */}
      <div style={{ padding: '14px 18px', background: `${summaryColor[summary.level]}10`, border: `2px solid ${summaryColor[summary.level]}50`, borderRadius: 10, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: summaryColor[summary.level], marginBottom: 6, letterSpacing: '0.06em' }}>
              {summary.level} STRUCTURE
              <span style={{ fontSize: 13, fontWeight: 400, color: '#cbd5e1', marginLeft: 10 }}>Structural context only — not a trade signal.</span>
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{summary.text}</div>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 12, fontSize: 13 }}>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#22c55e' }}>{summary.bull}</div><div style={{ color: '#cbd5e1' }}>bullish</div></div>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#ef4444' }}>{summary.bear}</div><div style={{ color: '#cbd5e1' }}>bearish</div></div>
            <div style={{ textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: '#cbd5e1' }}>{summary.neutral}</div><div style={{ color: '#cbd5e1' }}>neutral</div></div>
          </div>
        </div>
      </div>

      {/* 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Value Area Migration Stack */}
        {card(<>
          {sectionLabel('Value Area Migration — Last 10 Sessions', 'Dalton (Markets in Profile): the value area is the price range containing ~70% of all trading activity for a session.\n\nWhen consecutive days\' value areas migrate consistently in one direction, the market is accepting higher or lower prices. When they overlap, the market is in balance.\n\nGREEN bar: value area migrated higher vs prior day — buyers accepting higher prices.\nRED bar: value area migrated lower — sellers accepting lower prices.\nGRAY bar: value area overlaps prior day — balanced, two-sided.\n\nPOC (pink tick): point of control — the most-traded price of the session, the gravitational center.\n\nHover over any bar to see exact VAH / POC / VAL levels.')}
          <VAStack />
        </>)}

        {/* ACD Number Line */}
        {card(<>
          {sectionLabel('ACD Number Line', 'Fisher (The Logical Trader): a rolling sum of daily ACD scores over 30 sessions. Each day scores +4 (A Up + C confirmed), +1 (A Up only), 0 (no signal), -1 (A Down only), -4 (A Down + C confirmed).\n\nAbove +9 = confirmed uptrend — OTF buyers have been consistently in control for a month.\nBelow -9 = confirmed downtrend.\nBetween = ranging — day-trade only, no overnight bias.\n\n10-day tracks shorter-term momentum within the 30-day trend. When they diverge, the trend is weakening.')}
          <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>30-day</div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'monospace', color: acd.nl30 > 9 ? '#22c55e' : acd.nl30 < -9 ? '#ef4444' : '#fbbf24' }}>
                {acd.nl30 > 0 ? '+' : ''}{acd.nl30}
              </div>
              <div style={{ fontSize: 13, color: acd.nl30 > 9 ? '#22c55e' : acd.nl30 < -9 ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>{acd.nl30trend}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>10-day</div>
              <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: acd.nl10 > 9 ? '#22c55e' : acd.nl10 < -9 ? '#ef4444' : '#fbbf24' }}>
                {acd.nl10 > 0 ? '+' : ''}{acd.nl10}
              </div>
              <div style={{ fontSize: 13, color: acd.nl10 > 9 ? '#22c55e' : acd.nl10 < -9 ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>{acd.nl10trend}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 2 }}>5-day</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color: acd.nl5 > 0 ? '#22c55e' : acd.nl5 < 0 ? '#ef4444' : '#94a3b8' }}>
                {acd.nl5 > 0 ? '+' : ''}{acd.nl5}
              </div>
            </div>
          </div>
          {acd.nlDiverging && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5, fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
              ⚠ Momentum divergence — 30-day trend intact but 10-day is pulling in the opposite direction. Fisher: reduce size and tighten stops.
            </div>
          )}
          {acd.nlWeakening && !acd.nlDiverging && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 5, fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
              Momentum weakening — 10-day significantly below 30-day pace. Early warning. Not a reversal signal.
            </div>
          )}
          <ACDSparkline />
          <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginTop: 4 }}>Daily scores: last 30 sessions · above zero line = bullish day</div>
        </>)}

        {/* Volume Effort vs Result */}
        {card(<>
          {sectionLabel('Volume Effort vs Result — Last 10 Sessions', 'Weis (Trades About to Happen): every session tells a story through volume (effort) vs price range (result).\n\nABSORPTION (amber): heavy volume, narrow range. Someone is absorbing every push. In an uptrend = distribution (selling into rallies). In a downtrend = accumulation. 2+ consecutive absorption sessions = structural warning — stop adding to the trend.\n\nEASE OF MOVEMENT (blue): low volume, wide range. No resistance — price moving with conviction and little pushback. Confirms the current directional bias.\n\nNORMAL: proportionate effort and result. No signal.')}
          {effortResult.consecutiveAbsorption >= 3 && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.12)', border: '1px solid #fbbf24', borderRadius: 5, fontSize: 13, color: '#fbbf24', marginBottom: 8, fontWeight: 600 }}>
              ⚠ {effortResult.consecutiveAbsorption} consecutive ABSORPTION sessions — Weis: stop adding to the trend, reduce size. Prior directional pressure being absorbed.
            </div>
          )}
          {effortResult.consecutiveAbsorption === 2 && (
            <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 5, fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
              2 consecutive ABSORPTION sessions — elevated attention. Monitor whether pattern continues.
            </div>
          )}
          <div style={{ display: 'flex', flex: 1, gap: 3, alignItems: 'flex-end', height: 80 }}>
            {effortResult.sessions.map(s => {
              const h = Math.min(parseFloat(s.vol_ratio) * 30, 80);
              const col = s.flag === 'ABSORPTION' ? '#fbbf24' : s.flag === 'EASE_OF_MOVEMENT' ? '#3b82f6' : '#64748b';
              return (
                <div key={s.session_date || s.d} title={`${s.session_date || s.d}: vol ${s.vol_ratio}× range ${s.rng_ratio}× — ${s.flag}`}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ width: '100%', height: h, background: col, borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
                  <div style={{ fontSize: 13, color: col, fontWeight: 700, fontFamily: 'Arial, sans-serif' }}>{s.flag === 'ABSORPTION' ? 'A' : s.flag === 'EASE_OF_MOVEMENT' ? 'E' : '·'}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{(s.session_date || s.d)?.slice(5)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>
            <span style={{ color: '#fbbf24' }}>■ A=Absorption</span>
            <span style={{ color: '#3b82f6' }}>■ E=Ease of Movement</span>
            <span style={{ color: '#94a3b8' }}>■ Normal</span>
          </div>
        </>)}

        {/* Bracket / Trend State */}
        {card(<>
          {sectionLabel('Bracket / Trend State', 'Dalton + Steidlmayer: markets are in balance (bracket) roughly 75% of the time. Trending conditions are the exception.\n\nBRACKET: value areas overlapping — fade the extremes, buy VAL sell VAH, do not expect breakouts to follow through.\n\nTRENDING: value migrating consistently — go with range extensions, buy pullbacks to prior VAH (up) or sell rallies to prior VAL (down). Do not fade.\n\nTRANSITIONAL: 5-day and 10-day pictures disagree. Most dangerous condition. Reduce size significantly, favor responsive setups only, do not add contracts.')}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: stateColor[bracketState.state] || '#94a3b8', marginBottom: 4 }}>
              {bracketState.state === 'TRENDING_UP' ? '↑ TRENDING UP' : bracketState.state === 'TRENDING_DOWN' ? '↓ TRENDING DOWN' : bracketState.state === 'TRANSITIONAL' ? '⚡ TRANSITIONAL' : '↔ BRACKET'}
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif', marginBottom: 8 }}>
              Confidence: {bracketState.confidence} · {bracketState.overlaps5 ?? bracketState.overlaps10}/4 of last 5 day-pairs overlapping
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6, padding: '8px 10px', background: `${stateColor[bracketState.state] || '#64748b'}10`, borderRadius: 6, borderLeft: `3px solid ${stateColor[bracketState.state] || '#64748b'}` }}>
              {bracketState.playbook}
            </div>
            {bracketState.transitionalNote && (
              <div style={{ marginTop: 8, padding: '7px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.35)', borderRadius: 6, fontSize: 13, color: '#fbbf24', lineHeight: 1.6 }}>
                ⚡ {bracketState.transitionalNote}
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <div style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: '1px solid rgba(100,116,139,0.2)' }}>
              <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>5-day VA (primary)</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: bracketState.dir5 === 'HIGHER' ? '#22c55e' : bracketState.dir5 === 'LOWER' ? '#ef4444' : '#94a3b8' }}>{bracketState.dir5}</div>
            </div>
            <div style={{ padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: 6, border: '1px solid rgba(100,116,139,0.2)' }}>
              <div style={{ fontSize: 13, color: '#cbd5e1', fontFamily: 'Arial, sans-serif' }}>10-day VA (context)</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: bracketState.dir10 === 'HIGHER' ? '#22c55e' : bracketState.dir10 === 'LOWER' ? '#ef4444' : '#94a3b8' }}>{bracketState.dir10}</div>
            </div>
          </div>
        </>)}
      </div>

      {/* Composite TPO Profile — full width */}
      <div style={{ marginBottom: 16 }}>
        {card(<>
          {sectionLabel('Composite TPO Profile — Where Price Has Spent the Most Time',
            'A composite profile counts every 1-minute bar\'s contribution to each price level across multiple sessions. Unlike volume profiles, this is purely time-based — it shows where the market has spent the most time, independent of volume spikes.\n\nPOC (Point of Control): the price with the most time spent across all sessions — the strongest magnet. Price consistently returns here.\n\nValue Area (70%): the price range containing 70% of all time spent — the "fair value" zone. Opens above = buyers have structural advantage. Opens below = sellers do. Responsive strategies work inside this zone.\n\nHVN (High Volume Node): local peaks in the distribution. Price slows and rotates here — strong support and resistance.\n\nLVN (Low Volume Node): thin areas where price barely spent time. Price moves fast through these — expect breakouts and quick moves, not consolidation.')}
          <CompositeProfileCard />
        </>)}
      </div>

      {/* Bottom row: Weekly Structure + Profile Shapes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* Weekly Structure */}
        {card(<>
          {sectionLabel('Weekly Structure Tracker', 'Steidlmayer: Monday\'s range is the weekly Initial Balance (IB). How far the week extends beyond Monday\'s range reveals the degree of weekly OTF participation.\n\nNormal week: extends 50% beyond Monday\'s IB — moderate participation\nNormal Variation: doubles Monday\'s IB — meaningful OTF participation confirmed\nTrend week: closes near extreme, directional integrity throughout — strongest OTF conviction\n\nNW ±50% and NV ±100% are the target levels to watch for the current week.\n\nWeek type can change: a trend week Monday–Wednesday can become normal by Friday. Classification updates daily.')}
          {weeklyStructure.weekType ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: weeklyStructure.weekType === 'TREND' ? '#f97316' : weeklyStructure.weekType === 'NORMAL_VARIATION' ? '#fbbf24' : '#94a3b8' }}>
                  {weeklyStructure.weekType?.replace('_', ' ')}
                </div>
                <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>week of {weeklyStructure.weekStart}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['Mon IB High', weeklyStructure.monIBHigh?.toFixed(0)],
                  ['Mon IB Low', weeklyStructure.monIBLow?.toFixed(0)],
                  ['Week High', weeklyStructure.weekHigh?.toFixed(0)],
                  ['Week Low', weeklyStructure.weekLow?.toFixed(0)],
                  ['IB Range', weeklyStructure.monIBRange?.toFixed(0) + ' pts'],
                  ['Week Range', weeklyStructure.weekRange?.toFixed(0) + ' pts'],
                  ['NW ±50%', weeklyStructure.monIBHigh && weeklyStructure.monIBRange ? (weeklyStructure.monIBHigh + weeklyStructure.monIBRange * 0.5).toFixed(0) + ' / ' + (weeklyStructure.monIBLow - weeklyStructure.monIBRange * 0.5).toFixed(0) : '—'],
                  ['NV ±100%', weeklyStructure.monIBHigh && weeklyStructure.monIBRange ? (weeklyStructure.monIBHigh + weeklyStructure.monIBRange).toFixed(0) + ' / ' + (weeklyStructure.monIBLow - weeklyStructure.monIBRange).toFixed(0) : '—'],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(100,116,139,0.1)' }}>
                    <span style={{ color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{label}</span>
                    <span style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{val || '—'}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div style={{ color: '#cbd5e1', fontSize: 13 }}>No weekly bar data available.</div>}
        </>)}

        {/* Profile Shape Progression */}
        {card(<>
          {sectionLabel('Profile Shape Progression — Last 7 Sessions', 'Dalton (Markets in Profile): profile shape is the visual expression of market efficiency.\n\nELONGATED (▌ orange): tall, narrow profile. Directional conviction — price visiting many levels. OTF in control. Trend day type. A series = trend intact.\n\nFAT/BALANCED (▬ blue): wide horizontal profile, bell-curve shape. Market found value, two-sided trade. Normal or neutral day. A series = bracket forming or deepening.\n\nSQUAT (▀ amber): wide AND short. Auction compressing. Energy building. Precedes expansion in either direction — do not predict which way.\n\nNONSYMMETRIC TOP (▲ purple): more activity in upper half. Short covering or weak demand — often a fade opportunity at the upper boundary.\n\nNONSYMMETRIC BOTTOM (▼ pink): more activity in lower half. Long liquidation or weak supply — fade opportunity at lower boundary.\n\nKEY TRANSITION: elongated → fat series = trend slowing, balance forming. Reduce size.')}
          {profileShapes.shapes?.length ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {profileShapes.shapes.slice(-7).map(s => (
                  <div key={s.date} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 20, color: shapeColor[s.profile_shape] || '#64748b' }}>{shapeIcon[s.profile_shape] || '?'}</div>
                    <div style={{ fontSize: 13, color: shapeColor[s.profile_shape] || '#64748b', fontWeight: 700, fontFamily: 'Arial, sans-serif' }}>
                      {s.profile_shape === 'NONSYMMETRIC_TOP' ? 'Top↑' : s.profile_shape === 'NONSYMMETRIC_BOTTOM' ? 'Bot↓' : s.profile_shape || '—'}
                    </div>
                    <div style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'Arial, sans-serif' }}>{s.date?.slice(5)}</div>
                  </div>
                ))}
              </div>
              {profileShapes.shapeTransition && (
                <div style={{ padding: '6px 10px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 5, fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
                  {profileShapes.shapeTransition === 'ELONGATED_TO_FAT' && '⚡ Transition: profiles getting fatter after elongated series — trend conviction fading. Dalton: balance is forming. Reduce size.'}
                  {profileShapes.shapeTransition === 'ELONGATED_TO_SQUAT' && '⚡ Transition: squat profile after elongated series — energy compressing. Breakout possible in either direction.'}
                  {profileShapes.shapeTransition === 'FAT_TO_SQUAT' && '⚡ Transition: squat profile after balance period — bracket may be ending. Watch for directional confirmation.'}
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, fontSize: 13, flexWrap: 'wrap', fontFamily: 'Arial, sans-serif' }}>
                {[['ELONGATED','▌','#f97316'],['FAT','▬','#3b82f6'],['SQUAT','▀','#fbbf24'],['Top Heavy','▲','#a78bfa'],['Bot Heavy','▼','#ec4899']].map(([l,i,c]) => (
                  <span key={l} style={{ color: c }}>{i} {l}</span>
                ))}
              </div>
            </>
          ) : (
            <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>
              No profile shapes logged yet.<br />
              Log today's profile shape in <strong>Morning Prep → Daily Log</strong> after each session. Takes 10 seconds.
            </div>
          )}
        </>)}
      </div>

      {/* How to Read This Tab */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <button onClick={() => setHowToOpen(o => !o)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)' }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: '#cbd5e1', textTransform: 'uppercase' }}>How to Read This Tab</span>
          <span style={{ color: '#cbd5e1', fontSize: 13 }}>{howToOpen ? '▲ collapse' : '▼ expand'}</span>
        </button>
        {howToOpen && (
          <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {[
              ['The Purpose of This Tab', 'This tab shows you the bigger structural picture before your morning session. It does NOT predict price. It does NOT tell you a move is imminent. It tells you the current condition of the market across multiple timeframes so your intraday decisions have structural context.'],
              ['The Most Important Thing to Understand', 'No single component here is a signal. They are all conditions. The difference is important.\n\nA condition tells you what kind of environment you are in. A signal tells you to act.\n\nExample: ACD number line at +12 is a condition — it means the 30-day trend is bullish. It does NOT mean buy right now. Combined with value migrating higher and a trend week developing, the structural case for long bias is strengthening. But the intraday execution — the actual trade — still comes from your opening read, your ACD A signal, and your session structure confirmation.'],
              ['How to Use This Tab Without Getting Trapped', 'The most dangerous use of this tab is seeing strong bullish readings and using them to justify adding contracts or holding losing longs.\n\nStrong structural readings mean:\n• Long setups have more structural support\n• Short setups carry more counter-trend risk\n• Trend day probability is elevated\n\nStrong structural readings do NOT mean:\n• Today will be an up day\n• Any specific long trade will work\n• You should override your stop loss\n• You should add contracts'],
              ['When the Components Conflict', 'When components disagree — for example ACD number line is bullish but value migration is overlapping and effort vs result shows absorption — that conflict is important information. The market is in transition.\n\nIn a transitional reading: reduce size, favor responsive setups, do not hold trades into the next session, do not add contracts.'],
              ['The Balance to Imbalance Cycle', 'Markets alternate between balance (bracket) and imbalance (trend). A strong trend eventually slows, rotates, forms balance, then breaks into a new trend. This tab tracks where in that cycle the market is.\n\nSigns the current trend is weakening:\n• Profile shapes getting fatter after a series of elongated ones\n• Value migration slowing or stopping\n• Absorption sessions increasing\n• ACD 10-day diverging from 30-day\n• Weekly structure shifting from trend to normal variation\n\nWhen several of these align, the transition risk is elevated. This is not a reason to reverse direction immediately — it is a reason to stop adding to the trend and to use tighter stops.'],
              ['How Long Before a Breakout Should I Watch?', 'Compression and balance periods can last days, weeks, or months. Do not watch the compression and assume a breakout is imminent. A narrow bracket can stay narrow for a long time. The breakout will confirm itself — you do not need to predict it. Let the ACD A signal and value migration direction tell you which way it broke after the fact, then participate in the continuation.'],
            ].map(([title, body]) => (
              <div key={title}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginBottom: 5 }}>{title}</div>
                <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.8, whiteSpace: 'pre-line' }}>{body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


export default LongTermStructurePage;
