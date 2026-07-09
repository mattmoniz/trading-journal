// Export all validated confluence pairs + sub-conditions to JSON
// Run: node scripts/export_pairs.mjs
import { query } from '../server/db.js';
import { writeFileSync } from 'fs';

const runDate = new Date().toISOString().slice(0, 10);

const [baseQ, dowQ, todQ, dtQ, windowsQ] = await Promise.all([
  query(`
    SELECT signal_name, sample_size,
      ROUND(win_rate*100, 2)::float AS wr_pct,
      ROUND(ev_per_trade::numeric, 2)::float AS ev,
      recommendation
    FROM performance_audit
    WHERE signal_type='CONTEXT_ANALYSIS'
      AND signal_name LIKE 'PAIR_%'
      AND window_days = 9999
      AND signal_name NOT LIKE '%_DOW_%'
      AND signal_name NOT LIKE '%_TOD_%'
      AND signal_name NOT LIKE '%_DT_%'
    ORDER BY ev DESC
  `),
  query(`
    SELECT signal_name, sample_size,
      ROUND(win_rate*100, 2)::float AS wr_pct,
      ROUND(ev_per_trade::numeric, 2)::float AS ev, recommendation
    FROM performance_audit
    WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_DOW_%' AND window_days=9999
    ORDER BY signal_name, ev DESC
  `),
  query(`
    SELECT signal_name, sample_size,
      ROUND(win_rate*100, 2)::float AS wr_pct,
      ROUND(ev_per_trade::numeric, 2)::float AS ev, recommendation
    FROM performance_audit
    WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_TOD_%' AND window_days=9999
    ORDER BY signal_name, ev DESC
  `),
  query(`
    SELECT signal_name, sample_size,
      ROUND(win_rate*100, 2)::float AS wr_pct,
      ROUND(ev_per_trade::numeric, 2)::float AS ev, recommendation
    FROM performance_audit
    WHERE signal_type='CONTEXT_ANALYSIS' AND signal_name LIKE 'PAIR_%_DT_%' AND window_days=9999
    ORDER BY signal_name, ev DESC
  `),
  query(`
    SELECT signal_name, window_days, sample_size,
      ROUND(win_rate*100, 2)::float AS wr_pct,
      ROUND(ev_per_trade::numeric, 2)::float AS ev, recommendation
    FROM performance_audit
    WHERE signal_type='CONTEXT_ANALYSIS'
      AND signal_name LIKE 'PAIR_%'
      AND window_days IN (365, 182, 20)
      AND signal_name NOT LIKE '%_DOW_%'
      AND signal_name NOT LIKE '%_TOD_%'
      AND signal_name NOT LIKE '%_DT_%'
    ORDER BY signal_name, window_days
  `),
]);

// Index sub-conditions by base pair name (strip PAIR_ prefix for key)
const idx = (rows, keyFn, valFn) => {
  const out = {};
  rows.forEach(r => {
    const k = keyFn(r);
    if (!out[k]) out[k] = [];
    out[k].push(valFn(r));
  });
  return out;
};

const dowByPair = idx(dowQ.rows,
  r => r.signal_name.replace(/_DOW_\w+$/, '').replace(/^PAIR_/, ''),
  r => ({ dow: r.signal_name.match(/_DOW_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation })
);
const todByPair = idx(todQ.rows,
  r => r.signal_name.replace(/_TOD_\w+$/, '').replace(/^PAIR_/, ''),
  r => ({ tod: r.signal_name.match(/_TOD_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation })
);
const dtByPair = idx(dtQ.rows,
  r => r.signal_name.replace(/_DT_\w+$/, '').replace(/^PAIR_/, ''),
  r => ({ day_type: r.signal_name.match(/_DT_(\w+)$/)?.[1], n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation })
);
const windowsByPair = {};
windowsQ.rows.forEach(r => {
  const base = r.signal_name.replace(/^PAIR_/, '');
  if (!windowsByPair[base]) windowsByPair[base] = {};
  windowsByPair[base][r.window_days] = { n: r.sample_size, wr: r.wr_pct, ev: r.ev, rec: r.recommendation };
});

const pairs = baseQ.rows.map(r => {
  const base = r.signal_name.replace(/^PAIR_/, '');
  const [l1, l2] = base.split('+');
  const dows = (dowByPair[base] || []).sort((a, b) => b.ev - a.ev);
  const tods = (todByPair[base] || []).sort((a, b) => b.ev - a.ev);
  const dts  = (dtByPair[base] || []).sort((a, b) => b.ev - a.ev);
  const wins = windowsByPair[base] || {};
  return {
    pair: base, level1: l1, level2: l2,
    n_all: r.sample_size, wr_all: r.wr_pct, ev_all: r.ev,
    recommendation: r.recommendation,
    windows: {
      '1Y':  wins[365] ? { n: wins[365].n, wr: wins[365].wr, ev: wins[365].ev } : null,
      '6M':  wins[182] ? { n: wins[182].n, wr: wins[182].wr, ev: wins[182].ev } : null,
      '20D': wins[20]  ? { n: wins[20].n,  wr: wins[20].wr,  ev: wins[20].ev  } : null,
    },
    best_dow:   dows[0] || null,
    worst_dow:  dows.length > 1 ? dows[dows.length - 1] : null,
    best_tod:   tods[0] || null,
    worst_tod:  tods.length > 1 ? tods[tods.length - 1] : null,
    best_dt:    dts[0]  || null,
    worst_dt:   dts.length > 1  ? dts[dts.length - 1]  : null,
    dow_breakdown: dows,
    tod_breakdown: tods,
    dt_breakdown:  dts,
  };
});

const output = {
  generated: runDate,
  total_pairs: pairs.length,
  proximity_pt: 15,
  min_distinct_dates: 5,
  min_n: 10,
  description: 'Confluence pairs: every combo of 2 levels within 15pt of a trade entry on the same date. All accounts, all dates.',
  pairs,
};

const outPath = `/home/mmoniz/trading-journal/scripts/output/confluence_pairs_${runDate}.json`;
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Written: ${outPath}`);
console.log(`Total: ${pairs.length} | TRADE: ${pairs.filter(p=>p.recommendation==='TRADE').length} | CUT: ${pairs.filter(p=>p.recommendation==='CUT').length} | CONTEXT: ${pairs.filter(p=>p.recommendation==='CONTEXT').length}`);
process.exit(0);
