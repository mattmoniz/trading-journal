// Confirmed-compression redesign: does requiring ATR(20)<ATR(30) to PERSIST for K
// consecutive bars (not just the single bar immediately before entry) produce a real edge,
// tested across bar widths {5,15,30,60}? Direct user critique (2026-08-11): a single-bar
// crossing isn't evidence of a genuine compression regime, it could just be noise around
// the threshold. Reuses the corrected fill-resolution logic verified in
// pilot_atr_compression_breakout_mtf.mjs (1-min same-bar-stop disambiguation, entry
// anchored to the entry bar's own open) -- both fixes carried forward, not re-litigated.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const RT = LIVE_INSTRUMENT.commissionPerRoundTrip;

async function buildBars(BAR_MIN) {
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
    bar.compressed = bar.atr20 != null && bar.atr30 != null && bar.atr20 < bar.atr30;
  }
  return mBars;
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

function runBacktest(mBars, { confirmK, ambigMode }) {
  let trades = [], position = null, entryBarIdx = null;
  let ambigCount = 0, unambigCount = 0;
  for (let i = 30; i < mBars.length - 1; i++) {
    const prevBar = mBars[i - 1], bar = mBars[i];
    if (position) {
      if (bar.low <= position.stop) {
        const exitPrice = Math.min(bar.open, position.stop);
        trades.push({ pnl: ((exitPrice - position.entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
        position = null;
      } else if (bar.isFridayExit) {
        trades.push({ pnl: ((bar.close - position.entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts });
        position = null;
      }
      continue;
    }
    // Confirmed-compression filter: last confirmK bars (ending at prevBar) all compressed.
    if (i - confirmK < 0) continue;
    let allCompressed = true;
    for (let k = 0; k < confirmK; k++) {
      if (!mBars[i - 1 - k].compressed) { allCompressed = false; break; }
    }
    if (!allCompressed) continue;

    const buyLevel = bar.open + (2 * prevBar.atr20);
    if (bar.high < buyLevel) continue;
    const entryPrice = Math.max(bar.open, buyLevel);
    const stop = entryPrice - (0.5 * prevBar.atr20);

    let sameBarOut = false;
    if (bar.low <= stop) {
      const res = resolveEntryFill(bar, buyLevel, stop);
      if (res === 'AMBIG') { ambigCount++; sameBarOut = ambigMode === 'pessimistic'; }
      else if (res === 'UNAMBIG') { unambigCount++; sameBarOut = true; }
    }
    if (sameBarOut) {
      trades.push({ pnl: ((stop - entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: bar.ts });
      continue;
    }
    position = { entryPrice, stop };
    entryBarIdx = i;
    if (bar.isFridayExit) {
      trades.push({ pnl: ((bar.close - entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: bar.ts });
      position = null;
    }
  }
  return { trades, ambigCount, unambigCount };
}

function stats(trades) {
  if (!trades.length) return { N: 0, WR: 0, EV: 0, t: 0 };
  const N = trades.length;
  const WR = trades.filter(t => t.pnl > 0).length / N;
  const EV = trades.reduce((s, t) => s + t.pnl, 0) / N;
  const sd = Math.sqrt(trades.reduce((s, t) => s + (t.pnl - EV) ** 2, 0) / Math.max(1, N - 1));
  const t = sd > 0 ? EV / (sd / Math.sqrt(N)) : 0;
  return { N, WR, EV, t };
}

async function main() {
  const widths = [5, 15, 30, 60];
  const confirmKs = [1, 2, 3, 5];
  let out = `# Confirmed-Compression Sweep (long-only, pessimistic + optimistic bounds)\n\n`;
  out += `Tests whether requiring ATR(20)<ATR(30) to persist for K consecutive bars (not just\n`;
  out += `the single bar before entry) produces a real edge, across bar widths. Same corrected\n`;
  out += `fill-resolution logic as the main script (1-min same-bar-stop disambiguation).\n\n`;
  out += `| Width | Confirm K | Mode | N | WR | EV | t |\n|---|---|---|---|---|---|---|\n`;

  const allResults = [];
  for (const w of widths) {
    console.log(`Building ${w}-min bars...`);
    const mBars = await buildBars(w);
    for (const k of confirmKs) {
      for (const mode of ['pessimistic', 'optimistic']) {
        const { trades } = runBacktest(mBars, { confirmK: k, ambigMode: mode });
        const s = stats(trades);
        out += `| ${w}m | ${k} | ${mode} | ${s.N} | ${(s.WR * 100).toFixed(1)}% | $${s.EV.toFixed(2)} | ${s.t.toFixed(2)} |\n`;
        allResults.push({ w, k, mode, s, trades });
        console.log(`  ${w}m K=${k} ${mode}: N=${s.N} EV=$${s.EV.toFixed(2)} t=${s.t.toFixed(2)}`);
      }
    }
  }

  // Best pessimistic cell with N>=20 (floor per this codebase's standing rule)
  const viable = allResults.filter(r => r.mode === 'pessimistic' && r.s.N >= 20);
  const best = viable.length ? viable.reduce((max, r) => r.s.EV > max.s.EV ? r : max) : null;
  if (best) {
    const rigor = computeRigor(best.trades, { dateField: 'date', pnlFn: t => t.pnl });
    out += `\n## Best pessimistic cell with N>=20: ${best.w}m, confirmK=${best.k}\n\n`;
    out += `N=${best.s.N}, WR=${(best.s.WR*100).toFixed(1)}%, EV=$${best.s.EV.toFixed(2)}, t=${best.s.t.toFixed(2)}\n\n`;
    out += '```json\n' + JSON.stringify(rigor, null, 2) + '\n```\n';
    console.log(`\nBest viable cell: ${best.w}m K=${best.k} EV=$${best.s.EV.toFixed(2)} N=${best.s.N} rigor.clean=${rigor.clean}`);

    fs.writeFileSync('scratch/atr_breakout_confirmed_compression_RESULTS.md', out);
    await recordClaim({
      slug: 'atr_breakout_confirmed_compression',
      claimText: `Confirmed-compression sweep (K consecutive bars, not single-bar crossing) across widths {5,15,30,60}min x K in {1,2,3,5}, corrected fill engine. Best cell with N>=20: ${best.w}min, confirmK=${best.k}, EV=$${best.s.EV.toFixed(2)}/trade (N=${best.s.N}, t=${best.s.t.toFixed(2)}), rigor ${rigor.clean ? 'clean' : 'NOT clean'} (thirds: ${JSON.stringify(rigor.thirds)}). Full ${allResults.length}-cell sweep in scratch/atr_breakout_confirmed_compression_RESULTS.md -- read the full table before trusting the "best" cell alone, this is an exploratory grid, not a single pre-registered test.`,
      sourceFile: 'scripts/pilot_atr_breakout_confirmed_compression.mjs',
      sampleSize: best.s.N, winRate: best.s.WR, evPerTrade: best.s.EV,
      rigorStatus: rigor.clean ? 'clean' : 'failed', status: 'PROVISIONAL',
    });
  } else {
    fs.writeFileSync('scratch/atr_breakout_confirmed_compression_RESULTS.md', out + '\n\nNo cell reached N>=20.\n');
    console.log('No cell reached N>=20.');
    await recordClaim({
      slug: 'atr_breakout_confirmed_compression',
      claimText: `Confirmed-compression sweep across widths {5,15,30,60}min x K in {1,2,3,5}, corrected fill engine. NO cell reached the N>=20 floor -- requiring multi-bar persistence shrinks the eligible population too far to draw any conclusion. Full sweep in scratch/atr_breakout_confirmed_compression_RESULTS.md.`,
      sourceFile: 'scripts/pilot_atr_breakout_confirmed_compression.mjs',
      sampleSize: 0, winRate: 0, evPerTrade: 0, rigorStatus: 'underpowered', status: 'PROVISIONAL',
    });
  }
  console.log('Results written to scratch/atr_breakout_confirmed_compression_RESULTS.md');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
