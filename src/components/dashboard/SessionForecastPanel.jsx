import React, { useState, useEffect } from 'react';

const API_URL = '/api';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

// DOW_PLAYBOOKS removed — replaced by live backtested data from /api/morning-brief/scalp-playbook


function DailyRecap({ date }) {
  const [recap, setRecap] = useState(null);
  useEffect(() => {
    fetch(`${API_URL}/morning-brief/scalp-recap/${date}`).then(r => r.json()).then(setRecap).catch(() => {});
  }, [date]);
  if (!recap || (!recap.levelScalps?.length && !recap.vwapTrades?.length && !recap.pipelineSetups?.length)) return null;
  const sc = recap.scorecard;
  const totalTrades = sc.scalps.trades + sc.vwapMagnet.trades + sc.pipeline.trades;
  if (totalTrades === 0) return null;
  const pnlColor = sc.totalPnl > 0 ? '#4ade80' : sc.totalPnl < 0 ? '#f87171' : '#94a3b8';
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.12)', borderRadius: 6, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Daily Recap</span>
        <span style={{ fontSize: 9, color: '#475569' }}>{new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <span style={{ fontSize: 14, fontWeight: 800, fontFamily: 'monospace', color: pnlColor }}>${sc.totalPnl.toLocaleString()}</span>
      </div>
      {recap.session && (
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
          {recap.session.type} · {recap.session.range}pt range · {recap.session.rotations} rotations · Closed at {recap.session.closePct}%
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
        {[
          { label: 'Level Scalps', ...sc.scalps },
          { label: 'VWAP Magnet', ...sc.vwapMagnet },
          { label: 'Pipeline', ...sc.pipeline },
        ].map((cat, i) => (
          <div key={i} style={{ padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
            <div style={{ fontSize: 9, color: '#64748b', fontWeight: 600 }}>{cat.label}</div>
            <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: cat.pnl > 0 ? '#4ade80' : cat.pnl < 0 ? '#f87171' : '#94a3b8' }}>
              {cat.trades > 0 ? `${cat.wins}W/${cat.losses}L · $${cat.pnl.toLocaleString()}` : 'No trades'}
            </div>
          </div>
        ))}
      </div>
      {recap.levelScalps?.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>Level Trades</div>
          {recap.levelScalps.map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: 11 }}>
              <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{s.time} {s.level} ({fmtP(s.levelPrice)})</span>
              <span>
                <span style={{ color: s.result === 'WIN' ? '#4ade80' : '#f87171', fontWeight: 700 }}>{s.result} ${s.result === 'WIN' ? (s.pnl * 2 - 1) : (-Math.abs(s.pnl) * 2 - 1)}</span>
                <span style={{ color: '#64748b' }}> MFE {s.mfe}pt</span>
              </span>
            </div>
          ))}
        </>
      )}
      {recap.vwapTrades?.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginTop: 6, marginBottom: 2 }}>VWAP Magnet Trades</div>
          {recap.vwapTrades.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: 11 }}>
              <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{t.time} {t.direction} ({t.vwapDist}pt ext)</span>
              <span style={{ color: t.result === 'WIN' ? '#4ade80' : '#f87171', fontWeight: 700 }}>{t.result} ${t.result === 'WIN' ? (t.pnl * 2 - 1) : (-Math.abs(t.pnl) * 2 - 1)}</span>
            </div>
          ))}
        </>
      )}
      {recap.pipelineSetups?.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginTop: 6, marginBottom: 2 }}>Pipeline Setups</div>
          {recap.pipelineSetups.map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: 11 }}>
              <span style={{ color: '#cbd5e1', fontFamily: 'monospace' }}>{s.setup.replace(/_/g, ' ')}</span>
              <span style={{ color: s.resolution === 'WIN' || s.resolution === 'TARGET_HIT' ? '#4ade80' : s.resolution === 'LOSS' || s.resolution === 'STOP_HIT' ? '#f87171' : '#fbbf24', fontWeight: 700 }}>
                {s.resolution} {s.pnl != null ? `$${s.pnl}` : ''}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function SessionForecastPanel({ date }) {
  const [forecast, setForecast] = useState(null);
  const [edgeData, setEdgeData] = useState(null);
  const [loading, setLoading] = useState(true);

  const [scalpPlaybook, setScalpPlaybook] = useState(null);
  const [liveCtx, setLiveCtx] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_URL}/morning-brief/forecast/${date}`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/antigravity/edges-context`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/morning-brief/scalp-playbook/${date}`).then(r => r.json()).catch(() => null),
      fetch(`${API_URL}/morning-brief/live-session-context/${date}`).then(r => r.json()).catch(() => null),
    ]).then(([fc, ed, sp, lc]) => {
      setForecast(fc);
      setEdgeData(ed);
      setScalpPlaybook(sp);
      setLiveCtx(lc?.noData ? null : lc);
    }).finally(() => setLoading(false));
  }, [date]);

  // Auto-refresh live context every 60 seconds during RTH
  useEffect(() => {
    const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
    if (etH < 9 || etH >= 16) return;
    const interval = setInterval(() => {
      fetch(`${API_URL}/morning-brief/live-session-context/${date}`).then(r => r.json()).then(lc => {
        if (!lc?.noData) setLiveCtx(lc);
      }).catch(() => {});
    }, 60000);
    return () => clearInterval(interval);
  }, [date]);

  if (loading) return <div style={{ fontSize: 12, color: '#64748b', padding: '10px 0' }}>Loading forecast...</div>;
  if (!forecast && !edgeData) return <div style={{ fontSize: 12, color: '#64748b' }}>No forecast data available.</div>;

  const oc = edgeData?.overnightContext || {};
  const cl = edgeData?.confluenceLevels || {};
  const ls = edgeData?.liveStatus || {};
  const price = ls.currentPrice;
  const bz = forecast?.balanceZone;
  const atr = forecast?.atr14;
  const rp = forecast?.rangePosition;
  const rps = forecast?.rangePositions || {};
  const bracketAge = forecast?.bracketAge || 0;
  const dow = new Date(date + 'T12:00:00').getDay();
  // playbook now comes from scalpPlaybook (live data)

  // Build key levels with behavioral notes
  const keyLevels = [];
  if (cl.pd1?.vah) keyLevels.push({ price: cl.pd1.vah, name: '2D VAH', behavior: 'Resistance. 4-5 retests, 5-bar dwell. Watch for absorption.', color: '#fb923c' });
  if (cl.pd1?.val) keyLevels.push({ price: cl.pd1.val, name: '2D VAL', behavior: 'Support. 2 retests, 2-bar dwell. Holds or breaks fast.', color: '#4ade80' });
  if (cl.pd1?.poc) keyLevels.push({ price: cl.pd1.poc, name: '2D POC', behavior: 'Magnet. Expect touch within 51 min. Arrives fast (16pt/bar), dwells 1 bar, departs slow.', color: '#a78bfa' });
  if (cl.pd1?.high) keyLevels.push({ price: cl.pd1.high, name: '2D High', behavior: 'Resistance. First test is the key read.', color: '#f87171' });
  if (cl.pd1?.low) keyLevels.push({ price: cl.pd1.low, name: '2D Low', behavior: 'Support. Sweep below = potential failed auction long.', color: '#4ade80' });
  if (cl.pd2?.vah) keyLevels.push({ price: cl.pd2.vah, name: 'PD-2 VAH', behavior: 'Strongest confluence (+44.8%). Scalp target 15pt.', color: '#f87171' });
  if (cl.pd2?.val) keyLevels.push({ price: cl.pd2.val, name: 'PD-2 VAL', behavior: 'Extension target +20.5%. Let runners go.', color: '#4ade80' });
  if (cl.orMid) keyLevels.push({ price: cl.orMid, name: 'OR Mid', behavior: 'Pivot. With absorption: 60% WR. Log via Quick Trade Log.', color: '#60a5fa' });
  if (cl.pw?.high) keyLevels.push({ price: cl.pw.high, name: 'PW High', behavior: 'Weekly resistance.', color: '#fb923c' });
  if (cl.pw?.low) keyLevels.push({ price: cl.pw.low, name: 'PW Low', behavior: 'Weekly support. +15% controlled edge.', color: '#4ade80' });

  // Floor pivots
  if (cl.floorPivots) {
    const fp = cl.floorPivots;
    if (fp.pp) keyLevels.push({ price: fp.pp, name: 'Floor PP', behavior: 'Directional pivot. Bias shifts above/below.', color: '#94a3b8' });
    if (fp.s1) keyLevels.push({ price: fp.s1, name: 'Floor S1', behavior: 'First support.', color: '#64748b' });
    if (fp.s3) keyLevels.push({ price: fp.s3, name: 'Floor S3', behavior: 'Extreme support. 12% of days. Strong reaction.', color: '#475569' });
    if (fp.r1) keyLevels.push({ price: fp.r1, name: 'Floor R1', behavior: 'First resistance.', color: '#64748b' });
  }

  // Sort by price descending
  keyLevels.sort((a, b) => b.price - a.price);

  // Prior day character
  let priorDayChar = null;
  if (oc.prior_day_profile === 'NONTREND') priorDayChar = { label: 'NONTREND', note: 'Prior day extreme balance. Today RESOLVES — first sustained move has 61% WR.', color: '#fbbf24' };
  else if (oc.prior_day_profile === 'TREND') priorDayChar = { label: 'TREND', note: 'Prior day trended. Continuation bias — pullback entries, not fades.', color: '#22c55e' };
  else if (oc.prior_day_profile === 'NEUTRAL') priorDayChar = { label: 'NEUTRAL', note: 'Prior day balanced. Unfinished business at yesterday\'s extremes.', color: '#94a3b8' };

  const invLabel = oc.overnight_inventory?.replace(/_/g, ' ') || '';
  const ovpLabel = oc.open_vs_prior_value?.replace(/_/g, ' ') || '';
  const aligned = (oc.overnight_inventory === 'SHORT_TRAPPED' && oc.open_vs_prior_value === 'ABOVE_VALUE') ||
                  (oc.overnight_inventory === 'LONG_TRAPPED' && oc.open_vs_prior_value === 'BELOW_VALUE');

  const sectionSt = { marginBottom: 12 };
  const labelSt = { fontSize: 11, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 };
  const cardSt = { padding: '10px 12px', background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(51,65,85,0.3)', borderRadius: 6, marginBottom: 6 };

  return (
    <div style={{ fontSize: 12, color: '#cbd5e1' }}>
      {/* Macro warning */}
      {forecast?.isMacroDay && (
        <div style={{ padding: '10px 14px', background: 'rgba(234,88,12,0.12)', border: '1px solid rgba(234,88,12,0.4)', borderRadius: 6, color: '#f97316', marginBottom: 12 }}>
          <strong>MACRO OVERRIDE:</strong> {forecast.macroEvents?.map(e => `${e.event_type} at ${e.event_time?.slice(0,5)} ET`).join(', ')}. Calendar stats secondary — expect high-vol expansion.
        </div>
      )}

      {/* Overnight context */}
      {(oc.overnight_inventory || oc.open_vs_prior_value) && (
        <div style={{ ...cardSt, borderLeft: `3px solid ${aligned ? '#22c55e' : '#f59e0b'}` }}>
          <div style={labelSt}>Overnight Structure</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap' }}>
            {oc.overnight_inventory && <span>Inventory: <strong style={{ color: oc.overnight_inventory === 'SHORT_TRAPPED' ? '#22c55e' : oc.overnight_inventory === 'LONG_TRAPPED' ? '#ef4444' : '#94a3b8' }}>{invLabel}</strong></span>}
            {oc.open_vs_prior_value && <span>Open: <strong style={{ color: oc.open_vs_prior_value === 'ABOVE_VALUE' ? '#22c55e' : oc.open_vs_prior_value === 'BELOW_VALUE' ? '#ef4444' : '#94a3b8' }}>{ovpLabel}</strong></span>}
            {oc.prior_day_profile && <span>Prior Day: <strong style={{ color: priorDayChar?.color || '#94a3b8' }}>{oc.prior_day_profile}</strong></span>}
          </div>
          {aligned && <div style={{ fontSize: 11, color: '#22c55e', marginTop: 4 }}>Both aligned — 63% WR (N=113). Size up.</div>}
          {priorDayChar?.label === 'NONTREND' && <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>{priorDayChar.note}</div>}
        </div>
      )}

      {/* Balance zone + session character */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div style={cardSt}>
          <div style={labelSt}>Balance Zone</div>
          {bz?.active ? (
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div><strong style={{ color: '#10b981', fontFamily: 'monospace' }}>{fmtP(bz.low)} — {fmtP(bz.high)}</strong> <span style={{ color: '#64748b' }}>({Math.round(bz.high - bz.low)}pt, {bz.age} days)</span></div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>80% close inside. Fade edges. Excursions snap back within 3 bars (65%).</div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#f59e0b' }}>No active zone. Value migrating — directional day possible. First sustained move is high conviction.</div>
          )}
        </div>
        <div style={cardSt}>
          <div style={labelSt}>Session Expectation</div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            {priorDayChar ? (
              <div style={{ color: priorDayChar.color }}>{priorDayChar.note}</div>
            ) : (
              <div style={{ color: '#94a3b8' }}>Standard session. Responsive at VA edges, breakout on strong A signal.</div>
            )}
            {atr && <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>ATR(14): {Math.round(atr)}pt avg daily range</div>}
          </div>
        </div>
      </div>

      {/* Multi-timeframe range position */}
      {(rps.d5 || rps.d10 || rps.d20) && (
        <div style={cardSt}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={labelSt}>Range Position (Multi-Timeframe)</div>
            {bracketAge > 0 && <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700 }}>Bracket age: {bracketAge} days inside 20d range</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
            {[['5-Day', rps.d5], ['10-Day', rps.d10], ['20-Day', rps.d20]].map(([label, r]) => {
              if (!r) return null;
              const qColor = r.quintile === 'BOTTOM' ? '#4ade80' : r.quintile === 'LOWER' ? '#f87171' : r.quintile === 'TOP' ? '#f59e0b' : '#cbd5e1';
              return (
                <div key={label} style={{ padding: '6px 8px', background: 'rgba(15,23,42,0.5)', borderRadius: 4, border: `1px solid ${qColor}20` }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>{fmtP(r.lo)} — {fmtP(r.hi)}</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: qColor }}>{r.pct}% — {r.quintile}</div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>{Math.round(r.range)}pt range</div>
                </div>
              );
            })}
          </div>
          {rp && (
            <>
              <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#94a3b8', flexWrap: 'wrap', marginBottom: 4 }}>
                <span>Next day up: <strong style={{ color: rp.upPct >= 60 ? '#4ade80' : rp.upPct <= 45 ? '#f87171' : '#cbd5e1' }}>{rp.upPct}%</strong></span>
                <span>Avg move: <strong style={{ color: rp.avgMove > 0 ? '#4ade80' : '#f87171' }}>{rp.avgMove > 0 ? '+' : ''}{rp.avgMove}pt</strong></span>
                <span>Expected range: <strong>{rp.avgRange}pt</strong></span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {rp.quintile === 'BOTTOM' && 'Bottom of 20-day range. Strong mean-reversion zone — 71% up, +170pt avg. Bounce setups are high conviction.'}
                {rp.quintile === 'LOWER' && 'Lower range. Danger zone — 44% up, -52pt avg. Downtrends accelerate here. Cautious with longs.'}
                {rp.quintile === 'MIDDLE' && 'Middle of range. Balanced — setups work best here (51% WR). Standard playbook.'}
                {rp.quintile === 'UPPER' && 'Upper range. Slight upward bias. Neutral — play what you see.'}
                {rp.quintile === 'TOP' && 'Top of 20-day range. 59% up — strength tends to continue. But large selloffs from here create the biggest drops.'}
              </div>
              {(() => {
                const d5 = rps.d5, d10 = rps.d10, d20 = rps.d20;
                if (!d5 || !d10 || !d20) return null;
                const allTop = d5.quintile === 'TOP' && d10.quintile === 'TOP' && d20.quintile === 'TOP';
                const allBot = d5.quintile === 'BOTTOM' && d10.quintile === 'BOTTOM' && d20.quintile === 'BOTTOM';
                const diverging = (d5.quintile === 'BOTTOM' && d20.quintile === 'TOP') || (d5.quintile === 'TOP' && d20.quintile === 'BOTTOM');
                if (allTop) return <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4, fontWeight: 600 }}>All timeframes at TOP — extended. Watch for exhaustion / reversal signals.</div>;
                if (allBot) return <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4, fontWeight: 600 }}>All timeframes at BOTTOM — compressed. Strong bounce expected.</div>;
                if (diverging) return <div style={{ fontSize: 11, color: '#818cf8', marginTop: 4, fontWeight: 600 }}>Timeframes diverging — 5d and 20d disagree. Short-term vs long-term in conflict. Reduce size until aligned.</div>;
                return null;
              })()}
              {bracketAge >= 5 && <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>Bracket held {bracketAge} days — compression building. Breakout energy accumulating. When it breaks, expect expanded range.</div>}
            </>
          )}
        </div>
      )}

      {/* Scalp Playbook moved to Dashboard tab — see ScalpPlaybookCard.jsx */}
      {false && (
        <div>
          <div style={{ fontSize: 12, lineHeight: 1.7, color: '#cbd5e1' }}>
            {scalpPlaybook.priorSession && (
              <div style={{ marginBottom: 6, fontSize: 11, color: '#94a3b8' }}>
                Prior session: {scalpPlaybook.priorSession.type} ({scalpPlaybook.priorSession.range}pt, closed at {scalpPlaybook.priorSession.closePct}%)
                {scalpPlaybook.overnight && ` · Overnight: ${scalpPlaybook.overnight.overnight_inventory || '—'}, ${scalpPlaybook.overnight.open_vs_prior_value || '—'}`}
              </div>
            )}

            {scalpPlaybook.topDowCombos.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#4ade80', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {scalpPlaybook.dayOfWeek} Best Level Fades
                </div>
                {scalpPlaybook.topDowCombos.map((p, i) => {
                  const parts = p.pattern.split('×');
                  const level = parts[0]?.replace(':', '')?.replace(/^level_x_\w+/, '') || parts[0];
                  const levelName = level.split(':').pop();
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: p.wr >= 75 ? '#4ade80' : p.wr >= 65 ? '#fbbf24' : '#cbd5e1' }}>
                        {levelName}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>
                        <span style={{ color: p.wr >= 75 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>{p.wr}%</span> WR · N={p.n} · ${p.pnl?.toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {scalpPlaybook.bestHours.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Best Level × Time Windows
                </div>
                {scalpPlaybook.bestHours.slice(0, 5).map((p, i) => {
                  const parts = p.pattern.split(':').pop().split('×');
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#cbd5e1' }}>
                        {parts[0]} @ {parts[1]}
                      </span>
                      <span style={{ fontSize: 11 }}>
                        <span style={{ color: p.wr >= 75 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>{p.wr}%</span> WR · N={p.n}
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {scalpPlaybook.contextSpecific?.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Context-Specific (Overnight + Day Type)
                </div>
                {scalpPlaybook.contextSpecific.slice(0, 4).map((p, i) => {
                  const label = p.pattern.split(':').pop();
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#cbd5e1' }}>{label}</span>
                      <span style={{ fontSize: 11 }}>
                        <span style={{ color: p.wr >= 75 ? '#4ade80' : '#fbbf24', fontWeight: 700 }}>{p.wr}%</span> · N={p.n}
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {scalpPlaybook.pipelineSetups?.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#f472b6', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Pipeline Setups to Watch
                </div>
                {scalpPlaybook.nextDayTendency && (
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
                    After {scalpPlaybook.nextDayTendency.afterType}: {scalpPlaybook.nextDayTendency.upPct}% up days, ~{scalpPlaybook.nextDayTendency.avgNextRange}pt range (N={scalpPlaybook.nextDayTendency.n})
                  </div>
                )}
                {scalpPlaybook.pipelineSetups.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0' }}>
                      {s.setup.replace(/_/g, ' ')}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>
                      {s.fires} fires on {scalpPlaybook.dayOfWeek}s
                      {s.wr != null && <> · <span style={{ color: s.wr >= 60 ? '#4ade80' : s.wr >= 50 ? '#fbbf24' : '#f87171', fontWeight: 700 }}>{s.wr}%</span></>}
                      {s.avgPnl != null && <> · ${s.avgPnl}</>}
                    </span>
                  </div>
                ))}
                {scalpPlaybook.setupContextCombos?.filter(c => c.wr >= 60).length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>HIGH-CONVICTION COMBOS:</div>
                    {scalpPlaybook.setupContextCombos.filter(c => c.wr >= 60).slice(0, 4).map((c, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#e2e8f0', marginTop: 1 }}>
                        {c.setup.replace(/_/g, ' ')} × {c.context} — <span style={{ color: '#4ade80', fontWeight: 700 }}>{c.wr}%</span> (N={c.n})
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {scalpPlaybook.coilWatch?.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#f97316', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Coil Watch — Drought Setups
                </div>
                {scalpPlaybook.coilWatch.map((c, i) => (
                  <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: c.coiled ? '#f97316' : '#e2e8f0' }}>
                        {c.setup.replace(/_/g, ' ')}
                      </span>
                      <span style={{ fontSize: 11 }}>
                        <span style={{ color: c.currentStreak >= 6 ? '#f97316' : '#fbbf24', fontWeight: 700 }}>{c.currentStreak} consecutive losses</span>
                      </span>
                    </div>
                    {c.coiled && c.coilRatio && (
                      <div style={{ fontSize: 10, color: '#f97316', marginTop: 1 }}>
                        COILED — next win avg ${c.avgDroughtWin} ({c.coilRatio}x normal ${c.avgWin}). Hold for runner.
                      </div>
                    )}
                    {!c.coiled && (
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
                        Avg win: ${c.avgWin} · {c.totalFires} total fires
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {scalpPlaybook.overnightProfile && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#06b6d4', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Overnight Structure
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '2px 6px', marginBottom: 4 }}>
                  {[
                    { label: 'Range', value: `${scalpPlaybook.overnightProfile.range}pt`, color: '#cbd5e1' },
                    { label: 'Direction', value: scalpPlaybook.overnightProfile.direction, color: scalpPlaybook.overnightProfile.direction === 'UP' ? '#4ade80' : '#f87171' },
                    { label: 'ON POC', value: scalpPlaybook.overnightProfile.poc?.toLocaleString(), color: '#a78bfa' },
                    { label: 'Close %', value: `${scalpPlaybook.overnightProfile.closePosition}%`, color: '#cbd5e1' },
                  ].map((item, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 9, color: '#64748b' }}>{item.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: item.color }}>{item.value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                  ON VA: {scalpPlaybook.overnightProfile.val?.toLocaleString()} — {scalpPlaybook.overnightProfile.vah?.toLocaleString()} · Close: {scalpPlaybook.overnightProfile.close?.toLocaleString()}
                </div>
              </>
            )}

            {scalpPlaybook.balanceZones?.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', marginTop: 8, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Active Balance Zones (VA Overlaps)
                </div>
                {scalpPlaybook.balanceZones.map((z, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#c4b5fd' }}>
                      {z.low?.toLocaleString()} — {z.high?.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>
                      {z.width}pt zone · edges fade 84%
                    </span>
                  </div>
                ))}
              </>
            )}

            {scalpPlaybook.newDiscoveries?.length > 0 && (
              <div style={{ marginTop: 8, padding: '4px 8px', background: 'rgba(251,191,36,0.1)', borderRadius: 4, border: '1px solid rgba(251,191,36,0.2)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase' }}>New Patterns Detected</div>
                {scalpPlaybook.newDiscoveries.map((p, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#fbbf24', marginTop: 2 }}>
                    {p.pattern.split(':').pop()} — {p.wr}% WR (N={p.n})
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* First hour script */}
      <div style={{ padding: '10px 12px', background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={labelSt}>Morning Script (Open — 12:00 PM)</div>
          <span style={{ fontSize: 9, color: '#475569' }}>{new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7, color: '#cbd5e1' }}>
          <div>1. <strong style={{ color: '#818cf8' }}>Overnight positioning.</strong> {oc.overnight_inventory ? `${invLabel}. ${oc.overnight_inventory === 'SHORT_TRAPPED' ? 'Shorts squeezed — buying fuel early. Expect upward drift into first level test.' : oc.overnight_inventory === 'LONG_TRAPPED' ? 'Longs trapped — selling pressure builds. Expect downward drift. Watch for capitulation volume.' : 'Neutral — no trapped participants. Wait for OR to establish direction.'}` : 'Check overnight close vs today\'s VA before the bell.'}</div>
          {cl.pd1?.poc && <div>2. <strong style={{ color: '#818cf8' }}>POC magnet at {fmtP(cl.pd1.poc)}.</strong> Expect touch within 51 min (91% of days). Price arrives fast (16pt/bar), barely pauses (1 bar dwell), then drifts away slowly. Use as a target for your first trade, not an entry level.</div>}
          {cl.pd1?.vah && cl.pd1?.val && <div>3. <strong style={{ color: '#818cf8' }}>VA edge test.</strong> If price reaches VAH (<strong>{fmtP(cl.pd1.vah)}</strong>): expect 4-5 retests over ~5 bars. Volume should increase 1.37x at the edge — that confirms it's a real test. VAL (<strong>{fmtP(cl.pd1.val)}</strong>) resolves faster — 2 retests, 2-bar dwell. Holds or breaks decisively.</div>}
          {scalpPlaybook?.pipelineSetups?.length > 0 && (() => {
            const best = scalpPlaybook.pipelineSetups[0];
            return <div>4. <strong style={{ color: '#818cf8' }}>{scalpPlaybook.dayOfWeek} setup edge.</strong> {best.setup.replace(/_/g, ' ')} has best odds{best.wr != null ? ` (${best.wr}% WR, N=${best.n})` : ` (${best.fires} fires)`}. <span style={{ color: '#94a3b8' }}>Window: {best.timeWindow}.</span></div>;
          })()}
          <div>5. <strong style={{ color: '#818cf8' }}>Zone gravity rules.</strong> If price leaves a balance zone: 65% return within 5 bars, 83% within 15. Average excursion before snapping back: 29pt. If still outside after 15 bars → breakout is likely real (only 17% return after that).</div>
          <div>6. <strong style={{ color: '#818cf8' }}>10:30 AM — IB close.</strong> The Initial Balance is set. IB range defines the session framework. If IB is tight (under 47pt) → breakout expansion likely. If IB is wide (over 91pt) → range day, fade the IB extremes.</div>
          <div>7. <strong style={{ color: '#818cf8' }}>10:30 AM — 12:00 PM: the resolution window.</strong> This is when the morning thesis either confirms or fails. If the A signal held and IB broke in the same direction → trend developing. If the A signal failed → reassess. Most setups fire by noon.</div>
        </div>
      </div>

      {/* Midday / Afternoon script */}
      <div style={{ padding: '10px 12px', background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.12)', borderRadius: 6, marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={labelSt}>Afternoon Script (1:00 PM — Close)</div>
          <span style={{ fontSize: 9, color: '#475569' }}>{new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7, color: '#cbd5e1' }}>
          <div>1. <strong style={{ color: '#f59e0b' }}>Developing POC is today's magnet.</strong> Afternoon volume drops — price mean-reverts toward wherever today's volume concentrated. Watch where your chart shows the thickest profile.</div>
          <div>2. <strong style={{ color: '#f59e0b' }}>Stop initiating after 1:30 PM</strong> unless a clear failed auction or TRT is still active (120-min expiry). Afternoon breakout attempts have low follow-through.</div>
          <div>3. <strong style={{ color: '#f59e0b' }}>Where price closes shapes tomorrow.</strong></div>
          <div style={{ paddingLeft: 16, fontSize: 11, lineHeight: 1.6, color: '#94a3b8' }}>
            {cl.pd1?.vah && <div>• Close above <strong style={{ color: '#e2e8f0' }}>{fmtP(cl.pd1.vah)}</strong> (2D VAH) → tomorrow opens ABOVE VALUE. Bullish setups get 61% aligned WR.</div>}
            {cl.pd1?.val && <div>• Close below <strong style={{ color: '#e2e8f0' }}>{fmtP(cl.pd1.val)}</strong> (2D VAL) → tomorrow opens BELOW VALUE. IB_BEARISH at 88% WR.</div>}
            <div>• Close inside VA → tomorrow opens NEUTRAL. No strong directional tilt.</div>
          </div>
          <div>4. <strong style={{ color: '#f59e0b' }}>Closing price determines overnight inventory.</strong></div>
          <div style={{ paddingLeft: 16, fontSize: 11, lineHeight: 1.6, color: '#94a3b8' }}>
            <div>• Close well below today's open → <strong style={{ color: '#ef4444' }}>LONG_TRAPPED</strong> tomorrow. Buyers from today under pressure.</div>
            <div>• Close near today's open → <strong style={{ color: '#94a3b8' }}>NEUTRAL</strong> tomorrow. No trapped participants.</div>
            <div>• Close well above today's open → <strong style={{ color: '#22c55e' }}>SHORT_TRAPPED</strong> tomorrow. Sellers squeezed.</div>
          </div>
          {dow === 5 && <div>5. <strong style={{ color: '#ef4444' }}>Friday PM: lock gains by 12:30.</strong> Afternoon squaring creates reversals that eat Friday profits.</div>}
          {dow !== 5 && <div>5. <strong style={{ color: '#f59e0b' }}>3:00-4:00 PM closing auction.</strong> MOC orders create directional flow. If price is below today's POC, closing sellers may push lower. If above, closing buyers may push higher.</div>}
        </div>
      </div>

      {/* Daily Recap — how did today's playbook projections do? */}
      {(() => {
        const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
        if (etH < 16) return null;
        return <DailyRecap date={date} />;
      })()}

      {/* Evening script — only after 4:00 PM ET when the close is final */}
      {(() => { const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date())); return etH < 16 ? null : true; })() &&
      <div style={{ padding: '10px 12px', background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.12)', borderRadius: 6, marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={labelSt}>Evening Read (Closing the Loop → Tomorrow)</div>
          <span style={{ fontSize: 9, color: '#475569' }}>{new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.7, color: '#cbd5e1' }}>
          <div>1. <strong style={{ color: '#a78bfa' }}>Today's session character.</strong> {bz?.active
            ? `Price spent the session inside a ${bz.age}-day balance zone (${fmtP(bz.low)}–${fmtP(bz.high)}). ${priorDayChar?.label === 'NONTREND' ? 'The NONTREND resolution played out — did the first move sustain or reverse?' : 'Balance held — range rules carried the day.'}`
            : `No balance zone active. ${priorDayChar?.label === 'NONTREND' ? 'NONTREND resolution — today should have been directional. Did it trend?' : 'Value was migrating — did a new range establish or did the trend continue?'}`
          }</div>
          <div>2. <strong style={{ color: '#a78bfa' }}>What the close tells us.</strong></div>
          <div style={{ paddingLeft: 16, fontSize: 11, lineHeight: 1.6, color: '#94a3b8' }}>
            {cl.pd1?.vah && <div>• Close above <strong style={{ color: '#e2e8f0' }}>{fmtP(cl.pd1.vah)}</strong> → tomorrow: <strong style={{ color: '#22c55e' }}>ABOVE VALUE</strong>. Value accepted higher. Bullish aligned setups at 61% WR.</div>}
            {cl.pd1?.val && <div>• Close below <strong style={{ color: '#e2e8f0' }}>{fmtP(cl.pd1.val)}</strong> → tomorrow: <strong style={{ color: '#ef4444' }}>BELOW VALUE</strong>. Value rejected. IB_BEARISH at 88% WR (strongest condition).</div>}
            <div>• Close inside VA → tomorrow: <strong style={{ color: '#94a3b8' }}>NEUTRAL</strong>. Balanced — no strong structural tilt.</div>
          </div>
          <div>3. <strong style={{ color: '#a78bfa' }}>Overnight inventory forming.</strong> Today opened at {price ? fmtP(ls.sessionOpen || price) : '—'}. If closing well below the open → <strong style={{ color: '#ef4444' }}>LONG_TRAPPED</strong> tomorrow. Today's buyers are underwater — forced selling creates directional fuel. If closing near the open → <strong style={{ color: '#94a3b8' }}>NEUTRAL</strong>. If closing well above → <strong style={{ color: '#22c55e' }}>SHORT_TRAPPED</strong>.</div>
          {(() => {
            const nextDow = dow === 5 ? 1 : dow + 1;
            const nextDowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][nextDow];
            if (dow === 6 || dow === 0) return null;
            const tomorrowBest = scalpPlaybook?.pipelineSetups?.[0];
            return (
              <div>4. <strong style={{ color: '#a78bfa' }}>Tomorrow's playbook ({nextDowName}).</strong> {tomorrowBest ? `${tomorrowBest.setup.replace(/_/g, ' ')} has best odds${tomorrowBest.wr != null ? ` (${tomorrowBest.wr}% WR, N=${tomorrowBest.n})` : ''}. Window: ${tomorrowBest.timeWindow}.` : 'Loading...'}</div>
            );
          })()}
          <div>5. <strong style={{ color: '#a78bfa' }}>Scenario to watch.</strong> {(() => {
            const nextDow = dow === 5 ? 1 : dow + 1;
            const nextDowName2 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][(dow + 1) % 7];
            const tmBest = scalpPlaybook?.pipelineSetups?.[0];
            if (cl.pd1?.val && price && price < cl.pd1.val) {
              return `Price closing below VAL (${fmtP(cl.pd1.val)}) → tomorrow opens BELOW VALUE with likely LONG_TRAPPED inventory. ${tmBest ? `If ${tmBest.setup.replace(/_/g, ' ')} fires on ${nextDowName2} with that alignment → highest conviction setup of the week.` : ''} Watch for the reversal after early selling exhausts.`;
            }
            if (cl.pd1?.vah && price && price > cl.pd1.vah) {
              return `Price closing above VAH (${fmtP(cl.pd1.vah)}) → value migrating higher. Tomorrow's shorts face structural headwind. Look for continuation longs on pullbacks to today's VAH as support.`;
            }
            return `Price closing inside VA → tomorrow starts neutral. Direction will be set by overnight activity and the first 30 minutes. Wait for the morning read to build conviction.`;
          })()}</div>
        </div>
      </div>}
    </div>
  );
}
