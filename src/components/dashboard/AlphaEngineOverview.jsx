import React, { useEffect, useState } from 'react';
import CaptureRatioPanel from './CaptureRatioPanel';

const S = {
  page: { padding: '24px 28px', maxWidth: 1200, margin: 0, color: '#e2e8f0', fontFamily: 'inherit' },
  h1: { fontSize: 24, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 },
  sub: { fontSize: 14, color: '#94a3b8', marginBottom: 28 },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 15, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12, borderBottom: '1px solid #1e293b', paddingBottom: 6 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 },
  card: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  cardTitle: { fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 },
  cardVal: { fontSize: 22, fontWeight: 700, color: '#f1f5f9' },
  cardSub: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  row: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  label: { fontSize: 13, color: '#94a3b8', minWidth: 160 },
  val: { fontSize: 13, fontWeight: 600, color: '#f1f5f9' },
  badge: (color, bg) => ({ fontSize: 11, fontWeight: 700, color, background: bg, border: `1px solid ${color}40`, borderRadius: 4, padding: '2px 7px', letterSpacing: '0.05em', whiteSpace: 'nowrap' }),
  pill: (color) => ({ display: 'inline-block', fontSize: 12, fontWeight: 600, color, background: color + '18', borderRadius: 4, padding: '2px 8px', marginRight: 4, marginBottom: 4 }),
  factorCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
  factorName: { fontSize: 13, fontWeight: 700, color: '#e2e8f0' },
  factorEffect: { fontSize: 12, color: '#94a3b8' },
  factorStat: { fontSize: 12, fontWeight: 600 },
  suppressed: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#94a3b8', marginBottom: 4 },
  toolCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  toolTitle: { fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 },
  toolDesc: { fontSize: 13, color: '#94a3b8', lineHeight: 1.6 },
  todo: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, fontSize: 13, color: '#94a3b8' },
  todoIcon: { fontSize: 13, marginTop: 1, flexShrink: 0 },
};

const API_URL = '/api';

function EngineAccuracyPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/engine-reads/hit-rates`)
      .then(r => r.json())
      .then(d => { if (!d.error) setData(d.rates); })
      .catch(() => {});
  }, []);

  if (!data) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading…</div>;

  const readTypes = [
    { key: 'A_UP',        label: 'A Up signal',    color: '#22c55e' },
    { key: 'A_DOWN',      label: 'A Down signal',  color: '#ef4444' },
    { key: 'BIAS_LONG',   label: 'Pre-mkt LONG',   color: '#22c55e' },
    { key: 'BIAS_SHORT',  label: 'Pre-mkt SHORT',  color: '#ef4444' },
    { key: 'BIAS_NEUTRAL',label: 'Pre-mkt NEUTRAL',color: '#94a3b8' },
  ];

  // Find best and worst sub-combo across all types
  let bestCombo = null, worstCombo = null;
  for (const rt of readTypes) {
    const bucket = data[rt.key];
    if (!bucket?.byBias) continue;
    for (const [bias, stats] of Object.entries(bucket.byBias)) {
      if (stats.decisive < 10) continue;
      const pct = Math.round(stats.hitRate * 100);
      const combo = { label: `${rt.label} + ${bias}`, pct, n: stats.decisive };
      if (!bestCombo || pct > bestCombo.pct) bestCombo = combo;
      if (!worstCombo || pct < worstCombo.pct) worstCombo = combo;
    }
  }

  const totalDecisive = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.decisive || 0), 0);
  const totalCorrect  = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.correct  || 0), 0);
  const totalN        = readTypes.reduce((s, rt) => s + (data[rt.key]?.overall?.n        || 0), 0);
  const overallAcc    = totalDecisive > 0 ? Math.round(100 * totalCorrect / totalDecisive) : null;

  return (
    <div>
      {/* Summary row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: overallAcc >= 65 ? '#22c55e' : overallAcc >= 55 ? '#fbbf24' : '#ef4444' }}>{overallAcc}%</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>decisive accuracy</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#cbd5e1' }}>{totalN}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>total reads</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#22c55e' }}>{totalCorrect}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>correct</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: '#ef4444' }}>{totalDecisive - totalCorrect}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>wrong</div>
        </div>
      </div>

      {/* Per-type rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {readTypes.map(rt => {
          const d = data[rt.key]?.overall;
          if (!d) return null;
          const pct = Math.round(d.hitRate * 100);
          const col = pct >= 65 ? '#22c55e' : pct >= 55 ? '#fbbf24' : '#ef4444';
          const byBias = data[rt.key]?.byBias || {};
          const subRows = Object.entries(byBias)
            .filter(([, s]) => s.decisive >= 5)
            .sort((a, b) => b[1].hitRate - a[1].hitRate);
          return (
            <div key={rt.key} style={{ padding: '6px 0', borderBottom: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#cbd5e1' }}>{rt.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: col }}>
                  {pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={d.decisive}</span>
                </span>
              </div>
              {subRows.length > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 3, flexWrap: 'wrap' }}>
                  {subRows.map(([bias, s]) => {
                    const sp = Math.round(s.hitRate * 100);
                    const sc = sp >= 65 ? '#22c55e' : sp >= 55 ? '#fbbf24' : '#ef4444';
                    return (
                      <span key={bias} style={{ fontSize: 11, color: '#94a3b8' }}>
                        {bias} <span style={{ color: sc, fontWeight: 700 }}>{sp}%</span>
                        <span style={{ color: '#64748b' }}> n={s.decisive}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Best / worst combos */}
      {(bestCombo || worstCombo) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {bestCombo && (
            <div style={{ flex: 1, minWidth: 160, padding: '6px 10px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#22c55e', fontWeight: 700, marginBottom: 2 }}>Best call</div>
              <div style={{ color: '#e2e8f0' }}>{bestCombo.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#22c55e' }}>{bestCombo.pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={bestCombo.n}</span></div>
            </div>
          )}
          {worstCombo && (
            <div style={{ flex: 1, minWidth: 160, padding: '6px 10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 2 }}>Weakest call</div>
              <div style={{ color: '#e2e8f0' }}>{worstCombo.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 700, color: '#ef4444' }}>{worstCombo.pct}% <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8' }}>N={worstCombo.n}</span></div>
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>Overnight reads context-only · no mechanical sizing · 387 days backfilled</div>
    </div>
  );
}

function SetupCalibrationPanel() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/playbook/setup-calibration').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data || !data.items?.length) {
    return (
      <div style={{ fontSize: 13, color: '#475569', fontStyle: 'italic' }}>
        Accumulating data — N≥20 per setup required before flags appear. Check back after ~4 weeks of daily reviews.
      </div>
    );
  }

  const needsAdjust = data.items.filter(i => i.flag === 'NEEDS_ADJUST');
  const calibrated = data.items.filter(i => i.flag === 'CALIBRATED');
  const accumulating = data.items.filter(i => i.flag === 'ACCUMULATING');

  return (
    <div>
      {needsAdjust.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {needsAdjust.map(item => (
            <div key={item.setup_type} style={{ background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#fca5a5' }}>{item.setup_type}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#ef4444' }}>{item.avg_rating}⭐ avg (N={item.n})</span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                stop issues: {item.stop_issues} · T1 issues: {item.t1_issues} · entry issues: {item.entry_issues}
                {item.trend_delta !== null && <span> · trend {item.trend_delta >= 0 ? '+' : ''}{item.trend_delta}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {calibrated.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {calibrated.map(item => (
            <span key={item.setup_type} style={{ fontSize: 12, background: '#052e16', border: '1px solid #14532d', borderRadius: 4, padding: '3px 8px', color: '#86efac' }}>
              ✓ {item.setup_type} {item.avg_rating}⭐ (N={item.n})
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#475569' }}>
        {accumulating.length} setups accumulating (N&lt;20): {accumulating.map(i => i.setup_type).join(', ')}
      </div>
    </div>
  );
}

function BehavioralStatsPanel() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/playbook/behavioral-stats').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  if (!data || !data.items?.length) {
    return (
      <div style={{ fontSize: 13, color: '#475569', fontStyle: 'italic' }}>
        No behavioral data yet — runs Sunday 9:05 PM after coaching history accumulates.
      </div>
    );
  }

  const trendColor = t => t === 'WORSENING' ? '#ef4444' : t === 'IMPROVING' ? '#22c55e' : '#94a3b8';
  const trendIcon = t => t === 'WORSENING' ? '↑' : t === 'IMPROVING' ? '↓' : '→';

  return (
    <div>
      <div style={{ fontSize: 12, color: '#475569', marginBottom: 8 }}>
        N={data.items[0]?.n} sessions analyzed · Last run: {data.run_date}
      </div>
      {data.items.map(item => (
        <div key={item.theme} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ minWidth: 180, fontSize: 13, color: '#e2e8f0' }}>
            {item.theme.replace(/_/g, ' ')}
          </div>
          <div style={{ minWidth: 100 }}>
            <div style={{ height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(item.rolling_10d * 100)}%`, background: item.rolling_10d > 0.4 ? '#ef4444' : item.rolling_10d > 0.2 ? '#f59e0b' : '#22c55e', borderRadius: 3 }} />
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', minWidth: 100 }}>
            last10: <strong style={{ color: '#f1f5f9' }}>{Math.round(item.rolling_10d * 100)}%</strong>
            {' '}all: {Math.round(item.all_time_rate * 100)}%
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: trendColor(item.trend) }}>
            {trendIcon(item.trend)} {item.trend}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ ...S.card, borderColor: accent ? accent + '40' : '#1e293b' }}>
      <div style={S.cardTitle}>{label}</div>
      <div style={{ ...S.cardVal, color: accent || '#f1f5f9' }}>{value}</div>
      {sub && <div style={S.cardSub}>{sub}</div>}
    </div>
  );
}

function FactorRow({ name, effect, stat, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #1e293b22' }}>
      <span style={{ fontSize: 13, color: '#cbd5e1', flex: 1 }}>{name}</span>
      <span style={{ fontSize: 13, color: color || '#94a3b8', fontWeight: 700, textAlign: 'right', marginLeft: 12 }}>{effect}</span>
      {stat && <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 14, minWidth: 140, textAlign: 'right' }}>{stat}</span>}
    </div>
  );
}

export default function AlphaEngineOverview() {
  const [liveStats, setLiveStats] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);

  useEffect(() => {
    fetch('/api/acd/engine-summary').then(r => r.json()).then(setLiveStats).catch(() => {});
    fetch('/api/acd/setup-status').then(r => r.json()).then(setSetupStatus).catch(() => {});
  }, []);

  const tiers = [
    { name: 'PRIME', n: 15, pnl: '+$42.7K', color: '#22c55e', desc: 'EV ≥ $50/trade' },
    { name: 'SOLID', n: 12, pnl: '+$16.9K', color: '#3b82f6', desc: 'EV $20–49' },
    { name: 'MARGINAL', n: 15, pnl: '+$6.0K', color: '#94a3b8', desc: 'EV $0–19' },
    { name: 'WEAK', n: 8, pnl: '-$4.4K', color: '#f59e0b', desc: 'EV -$1 to -$20' },
    { name: 'KILL', n: 12, pnl: '-$27.7K', color: '#ef4444', desc: 'EV < -$20' },
  ];

  const multiplierFactors = [
    { name: 'Base (single level)', effect: '0.75×', stat: 'Floor for all trades', color: '#94a3b8' },
    { name: 'Base (2+ confluence)', effect: '1.0×', stat: 'Any 2+ levels stacking', color: '#94a3b8' },
    { name: 'Win streak ×1', effect: '+0.25', stat: '76.6% WR N=2,453', color: '#22c55e' },
    { name: 'Win streak ×2', effect: '+0.35', stat: '79.7% WR', color: '#22c55e' },
    { name: 'Win streak ×3+', effect: '+0.50', stat: '87.8% WR N=1,766', color: '#22c55e' },
    { name: 'Loss streak ×1', effect: '−0.50 (0.25× min)', stat: '47.0% WR', color: '#ef4444' },
    { name: 'Loss streak ×2', effect: '−0.65 (0.10× floor)', stat: '31.6% WR N=187', color: '#ef4444' },
    { name: 'Loss streak ×3+', effect: '0.10× (near-skip)', stat: '28.4% WR N=450', color: '#ef4444' },
    { name: 'First setup of day', effect: '+0.10', stat: '79.4% WR N=389 (best group)', color: '#a78bfa' },
    { name: 'Overnight NEUTRAL', effect: '−0.10', stat: '68.2% vs 73% aligned/counter', color: '#f59e0b' },
    { name: 'Buyers/sellers at level', effect: '+0.15', stat: 'Net delta confirming side → +6% WR', color: '#06b6d4' },
    { name: 'Elite zone (TURB + IB dir)', effect: '+0.15', stat: '78–82% WR on confirmed TURBULENT', color: '#f97316' },
    { name: 'Level recency ≤2 days', effect: '+0.15', stat: '$22 EV proven defender', color: '#22c55e' },
    { name: 'Level fresh (21d+ untested)', effect: '−0.10', stat: '60.5% WR, -$5 EV unproven', color: '#f59e0b' },
    { name: 'Verified confluence pair', effect: '+0.15', stat: 'OR_MID+DAILY_OPEN 84%, OR_LOW+IB_LOW 80%', color: '#a78bfa' },
    { name: 'INSIDE_VALUE open', effect: '−0.15', stat: '68.3% vs 72.7% outside z=−2.43', color: '#f59e0b' },
    { name: 'Day-type significance', effect: '±data-driven', stat: 'From DAY_TYPE_ALPHA rows (weekly recompute)', color: '#06b6d4' },
    { name: 'Stacking 7+ same-dir/day', effect: '0.10× (suppress)', stat: '62.4% WR -$15.7 EV N=1,922 — trend day, fades dead', color: '#ef4444' },
    { name: 'NL30 MILD_BULL/BEAR + SHORT', effect: '−0.20', stat: '61.6–62.6% WR -$17 to -$19 EV, z=−2.5 to −2.7 N=255-289', color: '#ef4444' },
    { name: 'NL30 STRONG_BEAR + SHORT', effect: '+0.10', stat: '77.7% WR +$68.1 EV z=+3.34 N=337', color: '#22c55e' },
    { name: 'NL30 STRONG_BULL + LONG', effect: '+0.10', stat: '77.6% WR +$62.0 EV z=+2.63 N=429', color: '#22c55e' },
    { name: 'NL30 MILD_BULL + LONG', effect: '+0.10', stat: '77.3% WR +$63.7 EV z=+2.06 N=299', color: '#22c55e' },
    { name: 'First visit of day to level', effect: '+0.15', stat: '78% WR +$71 EV z=+2.74 N=283 — untouched liquidity', color: '#22c55e' },
    { name: 'Level revisit 3hr+ stale', effect: '−0.25', stat: '60% WR -$35 EV z=-2.74 N=129 — liquidity picked off', color: '#ef4444' },
    { name: 'VWAP Extension (>mean+σ)', effect: '+0.15', stat: '76.2% WR +$59.7 EV z=+2.95 N=600 — fade + reversion stacked', color: '#22c55e' },
    { name: 'OR Expansion: no breach yet (BALANCE/TURBULENT)', effect: '+0.10', stat: 'BALANCE 78.9% WR N=161 z=2.03; TURBULENT 96.2% N=26 z=2.77 — liquidity intact', color: '#22c55e' },
    { name: 'Regime Persistence: TURBULENT 3-day streak (non-NEUTRAL NL30)', effect: '+0.10', stat: '84.1% WR N=157 z=3.45 (+8.9pp lift) — confirmed regime momentum', color: '#22c55e' },
    { name: 'Floor', effect: '0.25×', stat: 'Hard minimum', color: '#94a3b8' },
    { name: 'Ceiling', effect: '1.50×', stat: 'Hard maximum', color: '#94a3b8' },
  ];

  const suppressed = [
    { name: 'IB_HIGH_FADE_SHORT', reason: '55.7% WR N=79, EV=−$35 — stop width kills SHORT side' },
    { name: 'OR_MID_AFTER_IB_FADE_SHORT', reason: '61.7% WR N=60, EV=−$32' },
    { name: 'PD_POC_FADE_SHORT', reason: '52.9% WR N=34, EV=−$30' },
    { name: 'IB_MID_SCALP_FADE_SHORT', reason: '63.6% WR N=66, EV=−$16 (stop width)' },
    { name: 'PD_VAH_FADE_SHORT', reason: '60.0% WR N=45, EV=−$16 — SHORT side fails' },
    { name: 'CAM_R4_FADE_LONG', reason: '64.3% WR N=28, EV=−$28 — fading extreme resistance' },
    { name: 'CAM_R1_FADE_LONG / SHORT', reason: '61–62% WR, EV=−$16 to −$17' },
    { name: 'CAM_S2_FADE_SHORT', reason: '60.0% WR N=30, EV=−$23' },
    { name: 'IB_MID_SCALP_FADE_LONG', reason: 'BALANCE/TURBULENT only — TREND re-enabled (82% WR)' },
    { name: 'TREND counter-direction fades', reason: 'SHORT on UP-trend / LONG on DOWN-trend: 55–61% WR, −$28 to −$52 EV, −$17.5K/yr' },
    { name: 'S2 double-counter', reason: 'Both overnight inventory AND open-vs-value disagree: 54% WR → suppressed' },
    { name: 'Monday IB/OR/FLOOR_PIVOT/PD_SESSION_MID', reason: 'Monday-specific suppression list — different market structure' },
  ];

  const tools = [
    {
      name: 'Level Fade Engine',
      color: '#22c55e',
      desc: '50+ key levels tracked (PD_*, CAM_*, FLOOR_*, WPP, weekly/monthly VA, overnight range, OR/IB). Server polls every 60s during 9:30–4 PM ET. Detection starts at first proximity touch (~9:34 AM post fix). INSERT is idempotent — ON CONFLICT DO NOTHING.',
    },
    {
      name: 'Optimal Stop/Target System',
      color: '#3b82f6',
      desc: 'p75_MAE → stop, p50_MFE → target, p75_MFE → T2 runner. Computed weekly from 3,801+ resolved trades via scripts/update_optimal_stops.mjs. All directional (LONG/SHORT separately). No hardcoded constants remain in the live level fade path.',
    },
    {
      name: 'DAY_TYPE_ALPHA System',
      color: '#a78bfa',
      desc: 'Weekly per-(setup_type × day_type) z-score from all resolved trades. Only SIZE_UP/SIZE_DOWN/SUPPRESS rows (z≥1.5, N≥20) affect sizeMultiplier. size_delta scales with |z| × 0.07, capped 0.25. Currently: WEEKLY_VWAP_FADE_LONG BALANCE z=1.9 is the only confirmed cell.',
    },
    {
      name: 'Session Forecast Panel',
      color: '#06b6d4',
      desc: 'Pre-market intel stack: (1) Volatility forecast — P(BALANCE/TREND/TURBULENT) from ON range + prior day type. (2) Setup Anticipation — top 6 setups by fire_rate × EV for today\'s context. (3) Confluence Near Price — level pairs within 15pt of current price, N≥10 calibrated.',
    },
    {
      name: 'Nightly Latency Audit',
      color: '#f59e0b',
      desc: 'scripts/audit_setup_latency.mjs — runs at 5:15 PM ET Mon–Fri. For each setup: first bar within 15pt, lag = fired_at − first_bar. CRITICAL (>2 min), RETROACTIVE (>45 min). Alerts to scratch/gemini_alerts.txt. Fix recovered ~$44K/yr at 1 MNQ from phantom wins in retroactive IB backfill.',
    },
    {
      name: 'MAE/MFE Backfill & Replay',
      color: '#ec4899',
      desc: '3,801 rows backfilled via scripts/backfill_mae_mfe.mjs. Shared replay engine: server/services/maeMfeReplay.js. Live resolution populates mae_points, mfe_points, bars_to_resolution, resolution_bar_time on every new setup close. Weekly recompute of optimal stops/targets from accumulated data.',
    },
    {
      name: 'Context Analysis Engine',
      color: '#f97316',
      desc: 'scripts/context_analysis.js — weekly Sunday 6 AM. 136 rows in performance_audit (CONTEXT_ANALYSIS). Confirmed stable rules: no Monday fades, BALANCE-only, prefer LONG, IB_MID Friday=best. Confluence pair analysis: 520 pairs at 15pt proximity, 108 rated TRADE. Top: CAM_S2+PD_IB_HIGH 75.5% EV=$55.',
    },
    {
      name: 'Monte Carlo Optimizer',
      color: '#8b5cf6',
      desc: '5,000 paths × 180 combos × 3 filter modes. Key finding: Stop=20 sizing unit / Target=50–60pt = 100% survival across all paths. Current system params confirmed optimal. Re-run trigger: proximity window change or 20+ new trading days.',
    },
    { name: 'Engine Self-Tracking', color: '#94a3b8', _live: true },
    {
      name: 'Setup Anticipation',
      color: '#0ea5e9',
      desc: 'scripts/backtest_level_approach.js — weekly Sunday 8:30 PM. Computes P(setup fires | day_type, DOW) × avg_pnl from 906+ rows. Top-3 coverage = 77% (3 in 4 trading days, ≥1 top-3 setup fires). Shown in SessionForecastPanel. Key: BALANCE→OR_HIGH_FADE_SHORT 29% fire rate / 84% WR.',
    },
    {
      name: 'Auto-Suppression Engine',
      color: '#ef4444',
      desc: 'scripts/backtest_setup_status.mjs — weekly Sunday 9:17 PM. SUPPRESS: N≥50, WR<48%, EV<-$5 → new setups fire as SHADOW. PROMOTE: recent 90-day WR≥52% + EV>$0 + N≥15 → restored to ACTIVE. Directly flips open active_setups rows on each run. Safety net: if this stops running, losing setups accumulate silently.',
      _live: 'setupStatus',
    },
    {
      name: 'Tier Analysis System',
      color: '#94a3b8',
      desc: 'Full-year tier analysis Jul 2025–Jul 2026 (N=2,784 resolved trades). PRIME+SOLID = $59.6K/yr at 1 MNQ. Kill tier (12 setups) recovered $27.7K/yr by suppression. Alpha surgery (suppressions + TREND counter-direction filter) recovered ~$38K/yr combined. Systematic suppression now automated via Auto-Suppression Engine above.',
    },
  ];

  const pending = [
    { icon: '🔇', text: 'S2 suppression indicator — no UI tells you when a setup was killed by the double-counter filter.' },
    { icon: '📅', text: 'Shadow validation due ~2026-08-05 — IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT (both flip positive with tight stops).' },
    { icon: '🔗', text: 'Confluence pairs near price endpoint — 108 TRADE-rated pairs in JSON, no live UI surfacing which pairs overlap current price.' },
  ];

  return (
    <div style={S.page}>
      <div style={S.h1}>Alpha Engine Overview</div>
      <div style={S.sub}>Level Fade System — built Jan–Jul 2026 · All thresholds data-derived · Last alpha surgery 2026-07-05</div>

      {/* Top-line stats */}
      <div style={{ ...S.grid4, marginBottom: 28 }}>
        <StatCard label="Trades analyzed" value="2,784" sub="Jul 2025–Jul 2026 resolved" accent="#3b82f6" />
        <StatCard label="PRIME+SOLID EV" value="$59.6K/yr" sub="At 1 MNQ contract" accent="#22c55e" />
        <StatCard label="Alpha recovered" value="~$82K/yr" sub="Suppressions + latency fix" accent="#a78bfa" />
        <StatCard label="Active levels" value="50+" sub="PD / CAM / FLOOR / WPP / monthly" accent="#06b6d4" />
      </div>

      {/* Detection Architecture */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Detection Architecture</div>
        <div style={S.grid3}>
          <div style={S.card}>
            <div style={S.cardTitle}>Server Poll Cadence</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>60s</div>
            <div style={S.cardSub}>9:30–4:00 PM ET Mon–Fri · autonomous (no browser required)</div>
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>Detection Start</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>9:34 AM</div>
            <div style={S.cardSub}>After 4 RTH bars · gate lowered from 10:30 AM (60 bars) to 3 bars</div>
          </div>
          <div style={S.card}>
            <div style={S.cardTitle}>IB/OR Level Gate</div>
            <div style={{ ...S.cardVal, fontSize: 18 }}>10:30 AM</div>
            <div style={S.cardSub}>IB_HIGH/LOW and IB_MID self-gate via etMinNow ≥ 630 — legitimate formation time</div>
          </div>
        </div>
        <div style={{ ...S.card, marginTop: 10, fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
          <strong style={{ color: '#e2e8f0' }}>Pre-fix (before 2026-07-05):</strong> 62% of setups fired via retroactive IB-close backfill at 10:30 AM.
          248 phantom wins in the PRECOMPUTED bucket (T1 hit before alert fired). Fix recovered <strong style={{ color: '#22c55e' }}>~$44K/yr</strong> at 1 MNQ.
          Structural phantom wins (price hits level + T1 within 60s) are not recoverable with polling — ~53 setups/180 days are in this category.
        </div>
      </div>

      {/* Size Multiplier Stack */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Size Multiplier Stack</div>
        <div style={{ ...S.card, marginBottom: 10 }}>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>
            All factors apply multiplicatively on top of the base. Floor: <strong style={{ color: '#f1f5f9' }}>0.25×</strong> · Ceiling: <strong style={{ color: '#f1f5f9' }}>1.50×</strong>
          </div>
          {multiplierFactors.map(f => (
            <FactorRow key={f.name} name={f.name} effect={f.effect} stat={f.stat} color={f.color} />
          ))}
        </div>
      </div>

      {/* Setup Tiers */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Setup Tiers (Full-Year Backtest)</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {tiers.map(t => (
            <div key={t.name} style={{ ...S.card, flex: '1 1 160px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={S.badge(t.color, t.color + '18')}>{t.name}</span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>×{t.n}</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: t.pnl.startsWith('+') ? '#22c55e' : '#ef4444' }}>{t.pnl}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{t.desc} · 1 MNQ/yr</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          Badges shown live on each setup card. KILL-tier setups are fully suppressed. PRIME+SOLID combined: <strong style={{ color: '#22c55e' }}>68% WR, $54 avg EV, $59.6K/yr at 1 MNQ · ~$179K at 3 MNQ</strong>.
        </div>
      </div>

      {/* Suppression Logic */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Suppressed Setups & Filters</div>
        <div style={S.grid2}>
          {suppressed.map(s => (
            <div key={s.name} style={S.suppressed}>
              <span style={{ color: '#ef4444', fontWeight: 700 }}>{s.name}</span>
              <span style={{ color: '#94a3b8' }}> — {s.reason}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tools */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Supporting Tools</div>
        <div style={S.grid2}>
          {tools.map(t => (
            <div key={t.name} style={S.toolCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 3, height: 16, background: t.color, borderRadius: 2, flexShrink: 0 }} />
                <div style={S.toolTitle}>{t.name}</div>
              </div>
              {t._live === 'setupStatus' ? (
                <div>
                  <div style={S.toolDesc}>{t.desc}</div>
                  {setupStatus ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                        Last run: {setupStatus.lastRun ?? '—'} · {setupStatus.suppressed?.length ?? 0} suppressed
                        {setupStatus.promoted?.length > 0 && ` · ${setupStatus.promoted.length} recently promoted`}
                      </div>
                      {(setupStatus.suppressed ?? []).map(s => (
                        <div key={s.setup_type} style={{ fontSize: 11, color: '#ef4444', marginBottom: 2 }}>
                          ✕ {s.setup_type} — WR {(s.win_rate * 100).toFixed(1)}% · EV ${s.ev_per_trade?.toFixed(0)} · N={s.sample_size}
                        </div>
                      ))}
                    </div>
                  ) : <div style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>Loading...</div>}
                </div>
              ) : t._live ? <EngineAccuracyPanel /> : <div style={S.toolDesc}>{t.desc}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* AI Setup Calibration */}
      <div style={S.section}>
        <div style={S.sectionTitle}>AI Setup Calibration (from Daily Reviews)</div>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            Per-setup avg rating from AI daily reviews. Flags NEEDS_ADJUST when avg &lt; 3.5⭐ (N≥20). Updated Sunday 9:05 PM.
          </div>
          <SetupCalibrationPanel />
        </div>
      </div>

      {/* Behavioral Trends */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Behavioral Trends (from Coaching History)</div>
        <div style={S.card}>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
            Frequency of behavioral patterns across all coaching sessions. WORSENING = last 10 sessions &gt;10pp above prior 20.
          </div>
          <BehavioralStatsPanel />
        </div>
      </div>

      {/* Pending todos */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Pending / Road Map</div>
        <div style={{ ...S.card }}>
          {pending.map((p, i) => (
            <div key={i} style={S.todo}>
              <span style={S.todoIcon}>{p.icon}</span>
              <span>{p.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Capture Ratio */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Capture Ratio — Edge vs Execution</div>
        <CaptureRatioPanel />
      </div>

      {/* Footer */}
      <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 8 }}>
        All WR/EV claims: N≥20 hard floor · No static thresholds — all derived from rolling distributions · Hard rule: no lookahead in backtests
      </div>
    </div>
  );
}
