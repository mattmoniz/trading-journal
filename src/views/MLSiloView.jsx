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
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', maxWidth: W }} onMouseLeave={() => setHoverIdx(null)}>
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

// Wins/Losses/Net/Gross/Comm/Worst stats row for a raw trade array -- mirrors
// quick-check.html's computeMlRangeStats()/renderMlStatsRow() (same shape, same
// deliberate choice to NOT filter is_cluster_primary -- each level in a cluster is its own
// scored candidate here, see getRangeTrades()'s own header comment in mlSiloService.js).
function computeStatsRow(trades) {
  const decided = trades.filter(t => t.actual_pnl != null).slice()
    .sort((a, b) => (a.fired_at_str || '').localeCompare(b.fired_at_str || ''));
  let running = 0, peak = 0, maxDD = 0, worstTrade = 0, wins = 0, losses = 0;
  for (const t of decided) {
    const pnl = parseFloat(t.actual_pnl);
    running += pnl;
    if (t.resolution === 'TARGET_HIT' || (t.resolution === 'TRAIL_EXIT' && pnl >= 0)) wins++;
    else if (t.resolution === 'STOP_HIT' || (t.resolution === 'TRAIL_EXIT' && pnl < 0)) losses++;
    if (pnl < worstTrade) worstTrade = pnl;
    if (running > peak) peak = running;
    if (peak - running > maxDD) maxDD = peak - running;
  }
  const netPnl = running;
  const commission = decided.length * 2; // MNQ $1/side round-trip, matches COMMISSION_PER_TRADE elsewhere
  return { n: decided.length, wins, losses, netPnl, grossPnl: netPnl + commission, commission, maxDD, worstTrade, decided };
}

function StatsRow({ title, color, trades }) {
  const s = computeStatsRow(trades);
  if (s.n === 0) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No scored candidates in this range.</div>
      </div>
    );
  }
  const cell = (label, value, valColor, title2) => (
    <span title={title2} style={{ marginRight: 16 }}>
      {label} <b style={{ fontFamily: 'monospace', color: valColor }}>{value}</b>
    </span>
  );
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap' }}>
        {cell('Wins', s.wins, COLOR_POSITIVE)}
        {cell('Losses', s.losses, COLOR_NEGATIVE)}
        {cell('Net', fmtDollar(s.netPnl), s.netPnl >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE)}
        {cell('Gross', fmtDollar(s.grossPnl), COLOR_MUTED, 'Before commission')}
        {cell('Comm', `-$${s.commission.toFixed(0)}`, COLOR_MUTED, `$2/round-trip x ${s.n}`)}
        {cell('Worst', s.worstTrade < 0 ? fmtDollar(s.worstTrade) : '$0', s.worstTrade < 0 ? COLOR_NEGATIVE : COLOR_MUTED, 'Worst single realized trade P&L in this range')}
      </div>
    </div>
  );
}

// Per-trade equity curve for two independently-sized populations (All vs ML-Approved) --
// unlike EquityCurveChart above (day-level, both series share one x-index by trade_date),
// these two trade LISTS have different lengths (ML-Approved is a subset), so each line gets
// its own x-scale over the same plot width, same approach as quick-check.html's canvas
// version (renderMlSiloRangeEquityChart()).
function RangeEquityCurveChart({ allTrades, takeTrades, range }) {
  const allDecided = computeStatsRow(allTrades).decided;
  const takeDecided = computeStatsRow(takeTrades).decided;
  if (allDecided.length < 2) {
    return <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Not enough resolved candidates in this range.</div>;
  }
  const cumulate = (rows) => {
    let running = 0;
    const points = [0], labels = [rows[0]?.fired_at_str || ''];
    for (const t of rows) { running += parseFloat(t.actual_pnl); points.push(running); labels.push(t.fired_at_str); }
    return { points, labels };
  };
  const allSeries = cumulate(allDecided);
  const takeSeries = cumulate(takeDecided);

  const W = 760, H = 260, padL = 60, padR = 20, padT = 20, padB = 30;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const minY = Math.min(0, ...allSeries.points, ...takeSeries.points);
  const maxY = Math.max(0, ...allSeries.points, ...takeSeries.points);
  const yRange = maxY - minY || 1;
  const y = v => padT + innerH - ((v - minY) / yRange) * innerH;
  const zeroY = y(0);
  const xFor = (points) => (i) => padL + (points.length <= 1 ? 0 : (i / (points.length - 1)) * innerW);
  const pathFor = (series) => { const x = xFor(series.points); return series.points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '); };

  const useTime = range === 'today';
  const fmtLabel = (labelStr) => {
    if (!labelStr) return '';
    if (useTime) return labelStr.slice(11, 16);
    const [, mo, d] = labelStr.slice(0, 10).split('-');
    return `${mo}/${d}`;
  };
  const xTicksFor = (series) => {
    const n = Math.min(5, series.points.length);
    const x = xFor(series.points);
    return Array.from({ length: n }, (_, k) => {
      const idx = n === 1 ? 0 : Math.round((k / (n - 1)) * (series.points.length - 1));
      return { x: x(idx), label: fmtLabel(series.labels[idx]) };
    });
  };

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
        <span style={{ color: COLOR_ALL }}>&#9679; All Trades</span>
        <span style={{ color: COLOR_ML }}>&#9679; ML-Approved</span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', maxWidth: W }}>
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke={COLOR_MUTED} strokeOpacity={0.3} strokeWidth={1} />
        <text x={padL - 8} y={zeroY + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">$0</text>
        <text x={padL - 8} y={y(maxY) + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">{fmtDollar(maxY)}</text>
        <text x={padL - 8} y={y(minY) + 4} fontSize={10} fill={COLOR_MUTED} textAnchor="end">{fmtDollar(minY)}</text>
        <path d={pathFor(allSeries)} fill="none" stroke={COLOR_ALL} strokeWidth={2} />
        <path d={pathFor(takeSeries)} fill="none" stroke={COLOR_ML} strokeWidth={2} />
        {xTicksFor(allSeries).map((t, i) => (
          <text key={i} x={t.x} y={H - padB + 14} fontSize={10} fill={COLOR_MUTED} textAnchor="middle">{t.label}</text>
        ))}
      </svg>
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
  const [range, setRange] = React.useState('today');
  const [rangeData, setRangeData] = React.useState(null);
  const [stepTrailComparison, setStepTrailComparison] = React.useState(null);

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

  // Range-filterable view (Today/Week/Month/Year/All), added 2026-09-21 per user request
  // ("the same views as i see here... but for ML? with charts, pnl and different
  // timeframes") -- mirrors quick-check.html's main Performance section, applied to the
  // ML silo's two populations instead of one account.
  React.useEffect(() => {
    fetch(`${API_URL}/ml-silo/range-trades?range=${range}&sample=${sample}`)
      .then(r => r.json())
      .then(d => setRangeData(d))
      .catch(() => setRangeData(null));
  }, [range, sample]);

  // "ML gates entry, a validated trail mechanism decides how far to let it run" -- the
  // coupling step, 2026-09-21 (user's explicit "next step" request). Fetched once per
  // sample toggle (not range-scoped -- the underlying population is already thin, N<30).
  React.useEffect(() => {
    fetch(`${API_URL}/ml-silo/step-trail-comparison?sample=${sample}`)
      .then(r => r.json())
      .then(d => setStepTrailComparison(d?.comparison || null))
      .catch(() => setStepTrailComparison(null));
  }, [sample]);

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

      <h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: '0 0 8px' }}>By timeframe</h3>
      <div style={{ marginBottom: 8 }}>
        {['today', 'week', 'month', 'year', 'all'].map(r => (
          <button key={r} onClick={() => setRange(r)}
            style={{
              marginRight: 6, padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer', textTransform: 'capitalize',
              background: range === r ? 'var(--accent-purple, #8b5cf6)' : 'var(--bg-hover)',
              color: range === r ? '#fff' : 'var(--text-secondary)', border: 'none',
            }}>
            {r}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        {rangeData?.rangeLabel ? `${rangeData.rangeLabel} — ${(rangeData.trades || []).length} scored candidates` : 'Loading…'}
      </div>

      <div style={{ marginBottom: 16 }}>
        <RangeEquityCurveChart
          allTrades={rangeData?.trades || []}
          takeTrades={(rangeData?.trades || []).filter(t => t.ml_verdict === 'TAKE')}
          range={range}
        />
      </div>
      <StatsRow title="All Trades" color={COLOR_ALL} trades={rangeData?.trades || []} />
      <StatsRow title="ML-Approved" color={COLOR_ML} trades={(rangeData?.trades || []).filter(t => t.ml_verdict === 'TAKE')} />

      <h3 style={{ color: 'var(--text-primary)', fontSize: 15, margin: '24px 0 8px' }}>Overall (full out-of-sample period)</h3>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard title="ALL TRADES (baseline)" color={COLOR_ALL} stats={allStats} />
        <StatCard title="ML-APPROVED (TAKE)" color={COLOR_ML} stats={takeStats} />
        <StatCard title="ML-VETOED" color={COLOR_MUTED} stats={vetoStats} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <EquityCurveChart series={series} />
      </div>

      {stepTrailComparison && stepTrailComparison.n > 0 && (
        <div style={{ marginBottom: 24, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24' }}>
            ML + Step-Trail Coupling (research only, N={stepTrailComparison.n})
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
            Both pieces individually unvalidated — this model's own walk-forward CI still crosses zero, and
            the step-trail mechanism's own finding is PROVISIONAL, not promoted. ML-approved trades' real
            exit vs. the step-trail mechanism's own hypothetical exit. Directional only, not a basis for
            anything yet.
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Normal exit: <b style={{ fontFamily: 'monospace' }}>{fmtDollar(stepTrailComparison.normalTotal)}</b>
            {' '}&middot;{' '}
            Step-trail hypothetical: <b style={{ fontFamily: 'monospace' }}>{fmtDollar(stepTrailComparison.trailTotal)}</b>
            {' '}&middot;{' '}
            Delta:{' '}
            <b style={{
              fontFamily: 'monospace',
              color: (stepTrailComparison.trailTotal - stepTrailComparison.normalTotal) >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE,
            }}>
              {(stepTrailComparison.trailTotal - stepTrailComparison.normalTotal) >= 0 ? '+' : ''}
              {fmtDollar(stepTrailComparison.trailTotal - stepTrailComparison.normalTotal)}
            </b>
          </div>
        </div>
      )}

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
