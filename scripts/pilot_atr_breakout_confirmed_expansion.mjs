// Reframed redesign per direct user request: stop trying to ANTICIPATE compression
// resolving into a breakout (every anticipatory version this session failed -- see
// docs/OPEN_THREADS.md's 2026-08-11 ATR-breakout retraction entry) and instead REACT once
// expansion is already confirmed. Two structural changes from every prior version:
//
// 1. Entry requires a bar CLOSE beyond the trigger level (not an intrabar touch), and the
//    actual fill happens at the FOLLOWING bar's OPEN. This isn't just a rule change -- it
//    structurally eliminates the same-bar-stop-fill ambiguity that sank the anticipatory
//    version: an open is provably the first price of its own bar, so checking that same
//    bar's low against a stop set at entry is no longer a guess about intrabar ordering.
// 2. Stop is sized off the REAL structure of the breakout (the swing low of the compression
//    -> confirmation sequence), not an ATR fraction -- the ATR-based stop was independently
//    shown this session to sit inside the entry bar's own noise at every width tried.
//
// Tests WITH and WITHOUT the compression precondition (does it still add nothing under a
// completely different entry/stop mechanic, or was its failure specific to the old
// mechanic?) at two bar widths. Long-only. MNQ economics.
import { query } from '../server/db.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const DPP = LIVE_INSTRUMENT.dollarsPerPoint;
const RT = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MAX_LOOKAHEAD = 5; // bars to wait for confirmation before giving up on this signal

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
    if (!buckets.has(id)) buckets.set(id, { ts: id, open: r.open, high: r.high, low: r.low, close: r.close, dayOfWeek: r.dow });
    else { const b = buckets.get(id); b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; }
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

function runBacktest(mBars, { requireCompression }) {
  let trades = [], position = null, entryBarIdx = null;
  let signalsSeen = 0, confirmedCount = 0, timedOut = 0;

  for (let i = 30; i < mBars.length - 1; i++) {
    const bar = mBars[i];

    if (position) {
      if (bar.low <= position.stop) {
        // Legitimate, unambiguous: position opened at a prior bar's OPEN, so this bar's
        // low (whenever in the bar it occurred) is necessarily after entry.
        const exitPrice = Math.min(bar.open, position.stop);
        trades.push({ pnl: ((exitPrice - position.entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts, reason: 'STOP' });
        position = null;
      } else if (bar.isFridayExit) {
        trades.push({ pnl: ((bar.close - position.entryPrice) * DPP) - RT, date: bar.ts.substring(0, 10), entryTime: mBars[entryBarIdx].ts, reason: 'FRIDAY_CLOSE' });
        position = null;
      }
      continue;
    }

    // Signal bar: bar i itself is the "compression" reference (or, if not required, just
    // any bar can seed a trigger level -- the "no compression" control still needs SOME
    // trigger level to test against, so it uses the same ATR-offset construction, just
    // without gating on bar.compressed).
    if (requireCompression && !bar.compressed) continue;
    signalsSeen++;

    const triggerLevel = bar.open + (2 * bar.atr20);
    // Scan forward up to MAX_LOOKAHEAD bars for the first CLOSE beyond the trigger.
    let confirmIdx = -1;
    let structuralLow = bar.low;
    for (let k = 1; k <= MAX_LOOKAHEAD && i + k < mBars.length; k++) {
      const b = mBars[i + k];
      structuralLow = Math.min(structuralLow, b.low);
      if (b.close >= triggerLevel) { confirmIdx = i + k; break; }
    }
    if (confirmIdx === -1) { timedOut++; continue; }
    confirmedCount++;

    const entryBar = mBars[confirmIdx + 1];
    if (!entryBar) continue; // ran off the end of history
    const entryPrice = entryBar.open;
    const stop = structuralLow; // swing low of the compression->confirmation sequence

    position = { entryPrice, stop };
    entryBarIdx = confirmIdx + 1;
    // BUG FIX (Opus consultation 7, 2026-08-11): the outer loop's `i` must jump to the real
    // entry bar here. Without this, the next iteration (i+1) re-enters the `if (position)`
    // exit-check block against a bar that's still INSIDE the signal->confirmation window --
    // chronologically BEFORE the real entry -- and since `stop` is exactly that window's own
    // minimum low, the check is guaranteed to fire (falsely) on whichever bar set that
    // minimum, whenever it isn't the signal bar itself. Measured impact before this fix:
    // 42.7% of "trades" at 60m/compression were exiting before they were entered, and were
    // more than 100% of the reported loss (see docs/OPUS_AUDIT_PROMPT_7.md /
    // scratch/opus_audit_7_results.md for the full account) -- this single line is the fix.
    i = entryBarIdx;
    // Same-bar check on the entry bar IS legitimate here (see header comment) -- entry is
    // at this bar's own open, so its own low (whenever it occurs) is provably after entry.
    if (entryBar.low <= stop) {
      const exitPrice = Math.min(entryBar.open, stop);
      trades.push({ pnl: ((exitPrice - entryPrice) * DPP) - RT, date: entryBar.ts.substring(0, 10), entryTime: entryBar.ts, reason: 'STOP_ENTRY_BAR' });
      position = null;
      continue;
    }
    if (entryBar.isFridayExit) {
      trades.push({ pnl: ((entryBar.close - entryPrice) * DPP) - RT, date: entryBar.ts.substring(0, 10), entryTime: entryBar.ts, reason: 'FRIDAY_ENTRY_BAR' });
      position = null;
    }
  }
  return { trades, signalsSeen, confirmedCount, timedOut };
}

function stats(trades) {
  if (!trades.length) return { N: 0, WR: 0, EV: 0, t: 0 };
  const N = trades.length;
  const WR = trades.filter(t => t.pnl > 0).length / N;
  const EV = trades.reduce((s, t) => s + t.pnl, 0) / N;
  const sd = Math.sqrt(trades.reduce((s, t) => s + (t.pnl - EV) ** 2, 0) / Math.max(1, N - 1));
  const t = sd > 0 ? EV / (sd / Math.sqrt(N)) : 0;
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const winners = trades.filter(x => x.pnl > 0).length;
  return { N, WR, EV, t, drop1: sorted.length > 1 ? sorted.slice(1).reduce((s,x)=>s+x.pnl,0)/(sorted.length-1) : null, winners };
}

async function main() {
  const widths = [60, 15];
  let out = `# Confirmed-Expansion Redesign (react to breakout, don't anticipate it)\n\n`;
  out += `Entry: after a bar CLOSES beyond Open+2xATR20 (within ${MAX_LOOKAHEAD} bars of the\n`;
  out += `signal bar), enter at the FOLLOWING bar's open. Stop: structural swing low of the\n`;
  out += `compression->confirmation sequence, not an ATR fraction. No target, ride to Friday.\n\n`;

  const results = [];
  for (const w of widths) {
    console.log(`Building ${w}-min bars...`);
    const mBars = await buildBars(w);
    for (const requireCompression of [true, false]) {
      const r = runBacktest(mBars, { requireCompression });
      const s = stats(r.trades);
      const label = `${w}m, compression=${requireCompression ? 'REQUIRED' : 'NOT required (control)'}`;
      out += `## ${label}\n`;
      out += `Signals seen=${r.signalsSeen}, confirmed within ${MAX_LOOKAHEAD} bars=${r.confirmedCount} (${r.signalsSeen ? (r.confirmedCount/r.signalsSeen*100).toFixed(1) : 0}%), timed out=${r.timedOut}\n\n`;
      out += `N=${s.N}, WR=${(s.WR*100).toFixed(1)}%, EV=$${s.EV.toFixed(2)}, t=${s.t.toFixed(2)}, winners=${s.winners}${s.drop1!==null?`, drop-top1=$${s.drop1.toFixed(2)}`:''}\n\n`;
      console.log(`${label}: N=${s.N} EV=$${s.EV.toFixed(2)} t=${s.t.toFixed(2)} (confirmed ${r.confirmedCount}/${r.signalsSeen})`);
      results.push({ w, requireCompression, s, trades: r.trades, r });
    }
  }

  // Buy-and-hold reference (same for all, but recompute once at 60m for the header)
  const ref = await buildBars(60);
  const firstBar = ref[30], lastBar = ref[ref.length - 1];
  const bnhTotal = ((lastBar.close - firstBar.open) * DPP) - RT;
  out += `## Buy-and-Hold Reference\nTotal=$${bnhTotal.toFixed(2)}\n\n`;

  const best = results.filter(r => r.s.N >= 20).reduce((max, r) => (!max || r.s.EV > max.s.EV) ? r : max, null);
  if (best) {
    const rigor = computeRigor(best.trades, { dateField: 'date', pnlFn: t => t.pnl });
    out += `## Best cell with N>=20: ${best.w}m, compression=${best.requireCompression}\n\n`;
    out += '```json\n' + JSON.stringify(rigor, null, 2) + '\n```\n';
    console.log(`\nBest cell: ${best.w}m compression=${best.requireCompression} EV=$${best.s.EV.toFixed(2)} N=${best.s.N} rigor.clean=${rigor.clean}`);

    await recordClaim({
      slug: 'atr_breakout_confirmed_expansion',
      claimText: `Confirmed-expansion redesign (react to a closed breakout, enter at next bar's open, structural swing-low stop -- not an ATR fraction). Tested with/without compression precondition at 60m/15m. Best N>=20 cell: ${best.w}m, compression=${best.requireCompression}, N=${best.s.N}, EV=$${best.s.EV.toFixed(2)}, t=${best.s.t.toFixed(2)}, rigor ${rigor.clean?'clean':'NOT clean'}. Full 4-cell table in scratch/atr_breakout_confirmed_expansion_RESULTS.md. B&H reference over the same window: $${bnhTotal.toFixed(2)}.`,
      sourceFile: 'scripts/pilot_atr_breakout_confirmed_expansion.mjs',
      sampleSize: best.s.N, winRate: best.s.WR, evPerTrade: best.s.EV,
      rigorStatus: rigor.clean ? 'clean' : 'failed', status: 'PROVISIONAL',
    });
  } else {
    console.log('\nNo cell reached N>=20.');
    await recordClaim({
      slug: 'atr_breakout_confirmed_expansion',
      claimText: `Confirmed-expansion redesign, tested with/without compression precondition at 60m/15m. NO cell reached N>=20 -- requiring a confirmed CLOSE beyond the trigger (not just an intrabar touch) within ${MAX_LOOKAHEAD} bars shrinks the eligible population too far for a real conclusion at either width. Full table in scratch/atr_breakout_confirmed_expansion_RESULTS.md.`,
      sourceFile: 'scripts/pilot_atr_breakout_confirmed_expansion.mjs',
      sampleSize: 0, winRate: 0, evPerTrade: 0, rigorStatus: 'underpowered', status: 'PROVISIONAL',
    });
  }

  fs.writeFileSync('scratch/atr_breakout_confirmed_expansion_RESULTS.md', out);
  console.log('Results written to scratch/atr_breakout_confirmed_expansion_RESULTS.md');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
