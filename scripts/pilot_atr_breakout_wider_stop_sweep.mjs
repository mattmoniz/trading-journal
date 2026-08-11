// Wider-stop redesign test, per Opus consultation 6's one constructive continuation
// (docs/OPUS_AUDIT_PROMPT_6.md / scratch/opus_audit_6_results.md, section 4): the 0.5x ATR
// stop sits inside the entry bar's own noise (median 36pt stop on a bar that must travel
// ~145pt to trigger) -- sweep it wider instead of abandoning the strategy outright. Reuses
// the exact corrected fill-resolution logic from pilot_atr_compression_breakout_mtf.mjs
// (1-min same-bar-stop disambiguation, entry anchored to the entry bar's own open) --
// only the stop multiplier is swept. 60-min bars only (the one timeframe/direction that
// showed any life pre-correction); long-only (the tested direction).
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const BAR_MIN = 60;

async function main() {
  const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
  const RT = LIVE_INSTRUMENT.commissionPerRoundTrip;

  const { rows } = await query(`
    SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      open::float, high::float, low::float, close::float,
      EXTRACT(hour FROM ts)::int as hour_part, EXTRACT(minute FROM ts)::int as minute_part,
      EXTRACT(dow FROM ts)::int as dow
    FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= '2023-12-16' ORDER BY ts ASC
  `);

  const buckets = new Map();
  for (const r of rows) {
    if (r.hour_part === 17) continue;
    const bm = Math.floor(r.minute_part / BAR_MIN) * BAR_MIN;
    const id = `${r.ts_str.substring(0, 10)} ${String(r.hour_part).padStart(2, '0')}:${String(bm).padStart(2, '0')}:00`;
    if (!buckets.has(id)) buckets.set(id, { ts: id, open: r.open, high: r.high, low: r.low, close: r.close, dayOfWeek: r.dow, mins: [r] });
    else { const b = buckets.get(id); b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; b.mins.push(r); }
  }
  const mBars = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));

  for (let i = 0; i < mBars.length; i++) {
    const bar = mBars[i];
    bar.tr = i === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - mBars[i - 1].close), Math.abs(bar.low - mBars[i - 1].close));
  }
  function addWilderATR(bars, period, field) {
    let sumTR = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i < period) { sumTR += bars[i].tr; if (i === period - 1) bars[i][field] = sumTR / period; }
      else bars[i][field] = (bars[i - 1][field] * (period - 1) + bars[i].tr) / period;
    }
  }
  addWilderATR(mBars, 20, 'atr20');
  addWilderATR(mBars, 30, 'atr30');
  for (let i = 0; i < mBars.length; i++) {
    const bar = mBars[i], nextBar = mBars[i + 1];
    bar.isFridayExit = bar.dayOfWeek === 5 && (!nextBar || nextBar.dayOfWeek !== 5);
  }

  function resolveEntryFill(bar, triggerLevel, stop) {
    let entered = false;
    for (const m of bar.mins) {
      if (!entered) {
        if (m.high >= triggerLevel) { entered = true; if (m.low <= stop) return 'AMBIG'; }
      } else if (m.low <= stop) return 'UNAMBIG';
    }
    return null;
  }

  function runBacktest({ stopMult, useFilter, ambigMode }) {
    let trades = [], position = null, entryBarIdx = null;
    let ambigCount = 0, unambigCount = 0;
    for (let i = 30; i < mBars.length - 1; i++) {
      const prevBar = mBars[i - 1], bar = mBars[i];
      if (position) {
        if (bar.low <= position.stop) {
          const exitPrice = Math.min(bar.open, position.stop);
          const pts = exitPrice - position.entryPrice;
          trades.push({ pnl: (pts * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
          position = null;
        } else if (bar.isFridayExit) {
          const pts = bar.close - position.entryPrice;
          trades.push({ pnl: (pts * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
          position = null;
        }
        continue;
      }
      if (useFilter && !(prevBar.atr20 < prevBar.atr30)) continue;
      const buyLevel = bar.open + (2 * prevBar.atr20);
      if (bar.high < buyLevel) continue;
      const entryPrice = Math.max(bar.open, buyLevel);
      const stop = entryPrice - (stopMult * prevBar.atr20);

      let sameBarOut = false;
      if (bar.low <= stop) {
        const res = resolveEntryFill(bar, buyLevel, stop);
        if (res === 'AMBIG') { ambigCount++; sameBarOut = ambigMode === 'pessimistic'; }
        else if (res === 'UNAMBIG') { unambigCount++; sameBarOut = true; }
      }
      if (sameBarOut) {
        const pts = stop - entryPrice;
        trades.push({ pnl: (pts * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: bar.ts });
        continue;
      }
      position = { entryPrice, stop };
      entryBarIdx = i;
      if (bar.isFridayExit) {
        const pts = bar.close - entryPrice;
        trades.push({ pnl: (pts * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: bar.ts });
        position = null;
      }
    }
    return { trades, ambigCount, unambigCount };
  }

  function stats(trades) {
    if (!trades.length) return { N: 0, WR: 0, EV: 0, t: 0, sorted: [] };
    const N = trades.length;
    const WR = trades.filter(t => t.pnl > 0).length / N;
    const EV = trades.reduce((s, t) => s + t.pnl, 0) / N;
    const sd = Math.sqrt(trades.reduce((s, t) => s + (t.pnl - EV) ** 2, 0) / Math.max(1, N - 1));
    const t = sd > 0 ? EV / (sd / Math.sqrt(N)) : 0;
    const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
    const dropK = k => { const r = sorted.slice(k); return r.length ? r.reduce((s, x) => s + x.pnl, 0) / r.length : null; };
    return { N, WR, EV, t, sorted, drop1: dropK(1), drop3: dropK(3), winners: trades.filter(x => x.pnl > 0).length };
  }

  const stopMults = [0.5, 0.75, 1.0, 1.5, 2.0];
  let out = `# Wider-Stop Sweep (60-min, long-only, filter ON unless noted)\n\n`;
  out += `| Stop Mult | Mode | N | WR | EV | t | drop1 | drop3 | winners | ambig | unambig |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;

  const rows_ = [];
  for (const sm of stopMults) {
    for (const mode of ['pessimistic', 'optimistic']) {
      const r = runBacktest({ stopMult: sm, useFilter: true, ambigMode: mode });
      const s = stats(r.trades);
      out += `| ${sm}x | ${mode} | ${s.N} | ${(s.WR * 100).toFixed(1)}% | $${s.EV.toFixed(2)} | ${s.t.toFixed(2)} | ${s.drop1 !== null ? '$' + s.drop1.toFixed(2) : '--'} | ${s.drop3 !== null ? '$' + s.drop3.toFixed(2) : '--'} | ${s.winners} | ${r.ambigCount} | ${r.unambigCount} |\n`;
      rows_.push({ sm, mode, s, trades: r.trades, ambigCount: r.ambigCount });
    }
  }

  out += `\n## No-filter control at each stop width (pessimistic)\n\n`;
  out += `| Stop Mult | N | WR | EV | t |\n|---|---|---|---|---|\n`;
  for (const sm of stopMults) {
    const r = runBacktest({ stopMult: sm, useFilter: false, ambigMode: 'pessimistic' });
    const s = stats(r.trades);
    out += `| ${sm}x | ${s.N} | ${(s.WR * 100).toFixed(1)}% | $${s.EV.toFixed(2)} | ${s.t.toFixed(2)} |\n`;
  }

  // Chronological thirds for the best-EV pessimistic cell
  const bestPess = rows_.filter(r => r.mode === 'pessimistic').reduce((max, r) => r.s.EV > max.s.EV ? r : max);
  const rigor = computeRigor(bestPess.trades, { dateField: 'date', pnlFn: t => t.pnl });
  out += `\n## Chronological stability, best pessimistic cell (${bestPess.sm}x stop)\n\n`;
  out += '```json\n' + JSON.stringify(rigor, null, 2) + '\n```\n';

  fs.writeFileSync('scratch/atr_breakout_wider_stop_sweep_RESULTS.md', out);
  console.log(out);
  console.log('Results written to scratch/atr_breakout_wider_stop_sweep_RESULTS.md');

  await recordClaim({
    slug: 'atr_breakout_wider_stop_sweep',
    claimText: `Wider-stop redesign (60-min, long-only, filter ON) on the CORRECTED fill engine, per Opus consultation 6's constructive redesign recommendation. Swept stop multiplier {0.5,0.75,1.0,1.5,2.0}x ATR20. Best pessimistic cell: ${bestPess.sm}x stop, N=${bestPess.s.N}, WR=${(bestPess.s.WR*100).toFixed(1)}%, EV=$${bestPess.s.EV.toFixed(2)}, t=${bestPess.s.t.toFixed(2)}. Rigor: ${rigor.clean ? 'clean' : 'NOT clean'} (thirds: ${JSON.stringify(rigor.thirds)}). Full sweep table in scratch/atr_breakout_wider_stop_sweep_RESULTS.md.`,
    sourceFile: 'scripts/pilot_atr_breakout_wider_stop_sweep.mjs',
    sampleSize: bestPess.s.N,
    winRate: bestPess.s.WR,
    evPerTrade: bestPess.s.EV,
    rigorStatus: rigor.clean ? 'clean' : 'failed',
    status: 'PROVISIONAL',
  });
  console.log('Claim recorded.');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
