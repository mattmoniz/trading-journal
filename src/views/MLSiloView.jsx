import React from 'react';
import { API_URL } from '../constants/api.js';

// ML meta-labeling silo comparison view -- reads GET /api/ml-silo/summary and
// /api/ml-silo/trades (server/routes/mlSilo.js), a fully isolated read-only comparison
// layer that never touches live trading (server/services/mlSiloService.js's own header has
// the full "why isolated" account). Whole-roster scope per the user's explicit request --
// this is NOT limited to the 9 currently-ACTIVE setup_types.
//
// Deliberately the single source of the comparison payload -- quick-check.html's 4th tab
// renders the SAME two endpoints, never its own re-derived aggregation, per the DeepSeek
// critique's explicit warning against reimplementing this kind of aggregation twice.
const COLOR_ALL = '#3b82f6';   // --accent-blue, this app's existing token
const COLOR_ML = '#8b5cf6';    // --accent-purple, this app's existing token
const COLOR_POSITIVE = '#22c55e'; // --color-bullish
const COLOR_NEGATIVE = '#ef4444'; // --color-bearish
const COLOR_MUTED = '#94a3b8';    // --text-muted

function fmtDollar(n) {
  if (n == null) return '--';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function StatCard({ title, color, stats }) {
  if (!stats) return null;
  const pnl = stats.total_pnl ?? 0;
  return (
    <div style={{ background: 'var(--card-bg)', border: `1px solid ${color}40`, borderRadius: 8, padding: 16, flex: 1, minWidth: 220 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color, marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: pnl >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE, marginBottom: 4 }}>
        {fmtDollar(pnl)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        N={stats.n} &middot; WR={Number(stats.win_rate ?? 0).toFixed(1)}% &middot; avg={fmtDollar(stats.avg_pnl)}
      </div>
    </div>
  );
}

// Two-series line chart (All Trades vs ML-Approved cumulative P&L). Single axis, fixed
// categorical color per series (never cycled, never repainted by a filter), a legend since
// there are 2 series, recessive gridlines, thin 2px lines per the dataviz skill's mark specs.
function EquityCurveChart({ series }) {
  const [hoverIdx, setHoverIdx] = React.useState(null);
  if (!series || series.length < 2) {
    return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Not enough data yet for a chart.</div>;
  }

  const W = 760, H = 260, padL = 60, padR = 20, padT = 20, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  const allVals = series.map(s => s.allCumPnl);
  const mlVals = series.map(s => s.mlCumPnl);
  const allValues = [...allVals, ...mlVals];
  const minY = Math.min(0, ...allValues), maxY = Math.max(0, ...allValues);
  const yRange = maxY - minY || 1;

  const x = i => padL + (i / (series.length - 1)) * innerW;
  const y = v => padT + innerH - ((v - minY) / yRange) * innerH;

  const pathFor = vals => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0);

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
        <span style={{ color: COLOR_ALL }}>&#9679; All Trades</span>
        <span style={{ color: COLOR_ML }}>&#9679; ML-Approved</span>
      </div>
      <svg width={W} height={H} onMouseLeave={() => setHoverIdx(null)}>
        {/* recessive gridlines */}
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke={COLOR_MUTED} strokeOpacity={0.3} strokeWidth={1} />
        <text x={padL - 8} y={zeroY + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">$0</text>
        <text x={padL - 8} y={y(maxY) + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">{fmtDollar(maxY)}</text>
        <text x={padL - 8} y={y(minY) + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">{fmtDollar(minY)}</text>

        <path d={pathFor(allVals)} fill="none" stroke={COLOR_ALL} strokeWidth={2} />
        <path d={pathFor(mlVals)} fill="none" stroke={COLOR_ML} strokeWidth={2} />

        {/* hover hit targets, bigger than the mark per the dataviz skill's interaction spec */}
        {series.map((s, i) => (
          <rect key={i} x={x(i) - (innerW / series.length) / 2} y={padT} width={innerW / series.length} height={innerH}
            fill="transparent" onMouseEnter={() => setHoverIdx(i)} style={{ cursor: 'pointer' }} />
        ))}
        {hoverIdx != null && (
          <>
            <line x1={x(hoverIdx)} y1={padT} x2={x(hoverIdx)} y2={padT + innerH} stroke={COLOR_MUTED} strokeOpacity={0.4} strokeWidth={1} />
            <circle cx={x(hoverIdx)} cy={y(allVals[hoverIdx])} r={4} fill={COLOR_ALL} />
            <circle cx={x(hoverIdx)} cy={y(mlVals[hoverIdx])} r={4} fill={COLOR_ML} />
          </>
        )}
      </svg>
      {hoverIdx != null && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          {series[hoverIdx].tradeDate}: All={fmtDollar(allVals[hoverIdx])}, ML={fmtDollar(mlVals[hoverIdx])}
        </div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }) {
  const color = verdict === 'TAKE' ? COLOR_POSITIVE : COLOR_MUTED;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}18`, padding: '2px 8px', borderRadius: 4 }}>
      {verdict}
    </span>
  );
}

export default function MLSiloView() {
  const [summary, setSummary] = React.useState(null);
  const [trades, setTrades] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [sample, setSample] = React.useState('test');
  const [verdictFilter, setVerdictFilter] = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    fetch(`${API_URL}/ml-silo/summary?sample=${sample}`)
      .then(r => r.json())
      .then(d => { setSummary(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [sample]);

  React.useEffect(() => {
    const qs = new URLSearchParams({ sample, limit: '100' });
    if (verdictFilter) qs.set('verdict', verdictFilter);
    fetch(`${API_URL}/ml-silo/trades?${qs.toString()}`)
      .then(r => r.json())
      .then(d => setTrades(d.trades || []))
      .catch(() => {});
  }, [sample, verdictFilter]);

  if (loading) return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading…</div>;
  if (!summary?.model) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>No trained model yet — run scripts/ml_meta_labeling/train.py.</div>;
  }

  const { model, comparison, series } = summary;
  const allStats = comparison?.allTrades;
  const takeStats = comparison?.byVerdict?.find(v => v.verdict === 'TAKE');
  const vetoStats = comparison?.byVerdict?.find(v => v.verdict === 'VETO');

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <h2 style={{ color: 'var(--text-primary)', margin: 0 }}>ML Meta-Labeling Silo</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {model.model_version} &middot; trained {model.trained_at} &middot; AUC={Number(model.test_auc).toFixed(3)}
        </div>
      </div>

      <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', borderRadius: 6, padding: 10 }}>
        Fully isolated silo — this NEVER changes what fires as a real alert. Scored across the whole
        roster ({model.train_n + model.test_n} real trades, every setup_type), not just what's
        currently ACTIVE. "Out of sample" = genuinely never seen by the model during training —
        the only honest comparison. "In sample" is the model grading its own homework.
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 8 }}>Sample:</label>
        {['test', 'train', 'all'].map(s => (
          <button key={s} onClick={() => setSample(s)}
            style={{
              marginRight: 6, padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              background: sample === s ? 'var(--accent-purple, #8b5cf6)' : 'var(--bg-hover)',
              color: sample === s ? '#fff' : 'var(--text-secondary)', border: 'none',
            }}>
            {s === 'test' ? 'Out-of-sample (honest)' : s === 'train' ? 'In-sample (optimistic)' : 'All'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard title="ALL TRADES (baseline)" color={COLOR_ALL} stats={allStats} />
        <StatCard title="ML-APPROVED (TAKE)" color={COLOR_ML} stats={takeStats} />
        <StatCard title="ML-VETOED" color={COLOR_MUTED} stats={vetoStats} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <EquityCurveChart series={series} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: 0 }}>Per-trade: why ML gated this one</h3>
        <div>
          {['', 'TAKE', 'VETO'].map(v => (
            <button key={v} onClick={() => setVerdictFilter(v)}
              style={{
                marginLeft: 6, padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                background: verdictFilter === v ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-secondary)', border: '1px solid rgba(148,163,184,0.2)',
              }}>
              {v || 'All'}
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid rgba(148,163,184,0.15)' }}>
              <th style={{ padding: '6px 8px' }}>Setup</th>
              <th style={{ padding: '6px 8px' }}>Fired</th>
              <th style={{ padding: '6px 8px' }}>ML Prob</th>
              <th style={{ padding: '6px 8px' }}>Verdict</th>
              <th style={{ padding: '6px 8px' }}>Resolution</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Real P&L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => (
              <tr key={t.id} style={{ borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--text-primary)' }}>{t.setup_type}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{t.fired_at}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{Number(t.ml_probability).toFixed(3)}</td>
                <td style={{ padding: '6px 8px' }}><VerdictBadge verdict={t.ml_verdict} /></td>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{t.resolution || '--'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: t.actual_pnl >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE }}>
                  {fmtDollar(t.actual_pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
