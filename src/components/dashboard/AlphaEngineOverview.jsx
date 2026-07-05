import React, { useEffect, useState } from 'react';

const S = {
  page: { padding: '24px 28px', maxWidth: 1100, margin: '0 auto', color: '#e2e8f0', fontFamily: 'inherit' },
  h1: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 },
  sub: { fontSize: 13, color: '#94a3b8', marginBottom: 28 },
  section: { marginBottom: 32 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: '#94a3b8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12, borderBottom: '1px solid #1e293b', paddingBottom: 6 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 },
  card: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  cardTitle: { fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 },
  cardVal: { fontSize: 22, fontWeight: 700, color: '#f1f5f9' },
  cardSub: { fontSize: 11, color: '#64748b', marginTop: 2 },
  row: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  label: { fontSize: 12, color: '#94a3b8', minWidth: 160 },
  val: { fontSize: 12, fontWeight: 600, color: '#f1f5f9' },
  badge: (color, bg) => ({ fontSize: 10, fontWeight: 700, color, background: bg, border: `1px solid ${color}40`, borderRadius: 4, padding: '1px 6px', letterSpacing: '0.05em', whiteSpace: 'nowrap' }),
  pill: (color) => ({ display: 'inline-block', fontSize: 11, fontWeight: 600, color, background: color + '18', borderRadius: 4, padding: '2px 8px', marginRight: 4, marginBottom: 4 }),
  factorCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 },
  factorName: { fontSize: 12, fontWeight: 700, color: '#e2e8f0' },
  factorEffect: { fontSize: 11, color: '#94a3b8' },
  factorStat: { fontSize: 11, fontWeight: 600 },
  suppressed: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#94a3b8', marginBottom: 4 },
  toolCard: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '14px 16px' },
  toolTitle: { fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 },
  toolDesc: { fontSize: 11, color: '#94a3b8', lineHeight: 1.5 },
  todo: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, fontSize: 12, color: '#94a3b8' },
  todoIcon: { fontSize: 12, marginTop: 1, flexShrink: 0 },
};

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
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1e293b11' }}>
      <span style={{ fontSize: 12, color: '#cbd5e1', flex: 1 }}>{name}</span>
      <span style={{ fontSize: 11, color: color || '#94a3b8', fontWeight: 600, textAlign: 'right', marginLeft: 8 }}>{effect}</span>
      {stat && <span style={{ fontSize: 10, color: '#475569', marginLeft: 10, minWidth: 120, textAlign: 'right' }}>{stat}</span>}
    </div>
  );
}

export default function AlphaEngineOverview() {
  const [liveStats, setLiveStats] = useState(null);

  useEffect(() => {
    fetch('/api/acd/engine-summary').then(r => r.json()).then(setLiveStats).catch(() => {});
  }, []);

  const tiers = [
    { name: 'PRIME', n: 15, pnl: '+$42.7K', color: '#22c55e', desc: 'EV ≥ $50/trade' },
    { name: 'SOLID', n: 12, pnl: '+$16.9K', color: '#3b82f6', desc: 'EV $20–49' },
    { name: 'MARGINAL', n: 15, pnl: '+$6.0K', color: '#64748b', desc: 'EV $0–19' },
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
    { name: 'Stacking (7-8 same-dir/day)', effect: '+0.10', stat: '77% WR at stacking count 7-8', color: '#22c55e' },
    { name: 'Floor', effect: '0.25×', stat: 'Hard minimum', color: '#475569' },
    { name: 'Ceiling', effect: '1.50×', stat: 'Hard maximum', color: '#475569' },
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
    {
      name: 'Engine Self-Tracking',
      color: '#64748b',
      desc: '248 rows in engine_reads (Jan–Jul 2026). 107 CORRECT / 63 WRONG / 78 NEUTRAL = ~63% accuracy on decisive calls. Overnight reads auto-saved, 387 days backfilled. Context-only (no mechanical sizing from overnight reads alone).',
    },
    {
      name: 'Setup Anticipation',
      color: '#0ea5e9',
      desc: 'scripts/backtest_level_approach.js — weekly Sunday 8:30 PM. Computes P(setup fires | day_type, DOW) × avg_pnl from 906+ rows. Top-3 coverage = 77% (3 in 4 trading days, ≥1 top-3 setup fires). Shown in SessionForecastPanel. Key: BALANCE→OR_HIGH_FADE_SHORT 29% fire rate / 84% WR.',
    },
    {
      name: 'Shadow Validation System',
      color: '#475569',
      desc: '17 removed setups persist with status=SHADOW for forward testing. Resolution against price runs automatically. Promoted to ACTIVE at positive EV over 30+ forward trades. Next review: ~2026-08-05 for IB_MID_SCALP_FADE_SHORT and OR_MID_AFTER_IB_FADE_SHORT (both flip positive with tight stops).',
    },
    {
      name: 'Tier Analysis System',
      color: '#ef4444',
      desc: 'Full-year tier analysis Jul 2025–Jul 2026 (N=2,784 resolved trades). PRIME+SOLID = $59.6K/yr at 1 MNQ. Kill tier (12 setups) recovered $27.7K/yr by suppression. Alpha surgery (suppressions + TREND counter-direction filter) recovered ~$38K/yr combined. OPEN_TEST_DRIVE and C_STANDALONE_UP force-nulled.',
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
        <div style={{ ...S.card, marginTop: 10, fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
          <strong style={{ color: '#e2e8f0' }}>Pre-fix (before 2026-07-05):</strong> 62% of setups fired via retroactive IB-close backfill at 10:30 AM.
          248 phantom wins in the PRECOMPUTED bucket (T1 hit before alert fired). Fix recovered <strong style={{ color: '#22c55e' }}>~$44K/yr</strong> at 1 MNQ.
          Structural phantom wins (price hits level + T1 within 60s) are not recoverable with polling — ~53 setups/180 days are in this category.
        </div>
      </div>

      {/* Size Multiplier Stack */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Size Multiplier Stack</div>
        <div style={{ ...S.card, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
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
                <span style={{ fontSize: 11, color: '#64748b' }}>×{t.n}</span>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: t.pnl.startsWith('+') ? '#22c55e' : '#ef4444' }}>{t.pnl}</div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{t.desc} · 1 MNQ/yr</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
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
              <span style={{ color: '#64748b' }}> — {s.reason}</span>
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
              <div style={S.toolDesc}>{t.desc}</div>
            </div>
          ))}
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

      {/* Footer */}
      <div style={{ fontSize: 10, color: '#334155', textAlign: 'center', marginTop: 8 }}>
        All WR/EV claims: N≥20 hard floor · No static thresholds — all derived from rolling distributions · Hard rule: no lookahead in backtests
      </div>
    </div>
  );
}
