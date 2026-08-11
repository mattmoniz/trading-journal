// Forward-return check (the cheap, decisive test established in the ATR-breakout thread --
// see docs/OPEN_THREADS.md's 2026-08-11 entry) applied to a Bollinger Band squeeze instead
// of an ATR ratio. No trade machinery, no stop, no exit rule -- just: after a squeeze,
// does price behave differently than at a random moment?
//
// Bollinger bands: SMA(N) +/- K*stdev(close, N), N=20, K=2 (standard). Bandwidth =
// (upper-lower)/middle, ranked as a percentile against its own trailing 60-day distribution
// (self-calibrating, matching this codebase's no-static-thresholds rule -- same convention
// as the original Pinch pilot's range_10 percentile). Squeeze = bandwidth in the bottom
// decile of its own trailing history.
//
// Known confound flagged by DeepSeek at design time for the very first version of this
// thread: BBW conflates "quiet consolidation" with "low volatility during a smooth trend"
// (a trend can have small bar-to-bar noise while still moving steadily). Reported here as a
// secondary check (squeeze days' own net drift) rather than ignored.
import { query } from '../server/db.js';
import { recordClaim } from './record_claim.mjs';
import fs from 'fs';

const BAR_MIN = 60;
const N = 20, K = 2;

async function main() {
  const { rows } = await query(`
    SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS') as ts_str,
      open::float, high::float, low::float, close::float,
      EXTRACT(hour FROM ts)::int as hour_part, EXTRACT(minute FROM ts)::int as minute_part
    FROM price_bars_primary WHERE symbol = 'NQ' AND ts >= '2023-12-16' ORDER BY ts ASC
  `);
  const buckets = new Map();
  for (const r of rows) {
    if (r.hour_part === 17) continue;
    const bm = Math.floor(r.minute_part / BAR_MIN) * BAR_MIN;
    const id = `${r.ts_str.substring(0, 10)} ${String(r.hour_part).padStart(2, '0')}:${String(bm).padStart(2, '0')}:00`;
    if (!buckets.has(id)) buckets.set(id, { ts: id, open: r.open, high: r.high, low: r.low, close: r.close });
    else { const b = buckets.get(id); b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; }
  }
  const mBars = Array.from(buckets.values()).sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`${mBars.length} ${BAR_MIN}-min bars.`);

  // Rolling SMA/stdev of close, bandwidth
  for (let i = 0; i < mBars.length; i++) {
    if (i < N - 1) continue;
    let sum = 0;
    for (let j = i - N + 1; j <= i; j++) sum += mBars[j].close;
    const mean = sum / N;
    let sqSum = 0;
    for (let j = i - N + 1; j <= i; j++) sqSum += (mBars[j].close - mean) ** 2;
    const sd = Math.sqrt(sqSum / N);
    mBars[i].bbMiddle = mean;
    mBars[i].bbWidth = mean !== 0 ? (2 * K * sd) / mean : 0; // (upper-lower)/middle
  }

  // Trailing-60-trading-day-equivalent percentile rank of bbWidth. Using a bar-count window
  // (60 * bars/day at this width) rather than calendar days, same spirit as the Pinch
  // pilot's day-based trailing window but simpler for a single continuous bar array.
  const TRAIL_BARS = 60 * 23; // ~60 trading days * ~23 Globex+RTH bars/day at 60-min
  for (let i = 0; i < mBars.length; i++) {
    if (i < TRAIL_BARS + N) continue;
    const hist = [];
    for (let j = i - TRAIL_BARS; j < i; j++) if (mBars[j].bbWidth !== undefined) hist.push(mBars[j].bbWidth);
    if (!hist.length) continue;
    hist.sort((a, b) => a - b);
    const w = mBars[i].bbWidth;
    let count = 0;
    for (const h of hist) if (h <= w) count++;
    mBars[i].bbWidthPctile = count / hist.length;
  }

  const squeezeEvents = mBars.filter(b => b.bbWidthPctile !== undefined && b.bbWidthPctile <= 0.10);
  console.log(`Squeeze events (bottom decile bbWidth): ${squeezeEvents.length}`);

  const horizons = [1, 3, 5, 10, 20];
  const cond = {}, uncond = {};
  for (const h of horizons) { cond[h] = []; uncond[h] = []; }

  const idxOf = new Map(mBars.map((b, i) => [b.ts, i]));
  for (const ev of squeezeEvents) {
    const i = idxOf.get(ev.ts);
    const e = mBars[i].close;
    for (const h of horizons) {
      const ex = mBars[i + h];
      if (ex) cond[h].push(ex.close - e);
    }
  }
  for (let i = TRAIL_BARS + N; i < mBars.length; i++) {
    const e = mBars[i].close;
    for (const h of horizons) {
      const ex = mBars[i + h];
      if (ex) uncond[h].push(ex.close - e);
    }
  }

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  let out = `# Bollinger Squeeze Forward-Return Check (${BAR_MIN}-min, N=${N}, K=${K}, bottom decile bandwidth)\n\n`;
  out += `Squeeze events: ${squeezeEvents.length}\n\n| Horizon | N | Conditional | Unconditional | Edge | t(vs 0) |\n|---|---|---|---|---|---|\n`;

  const results = [];
  for (const h of horizons) {
    const c = cond[h], u = uncond[h];
    const mc = mean(c), mu = mean(u);
    const sdc = Math.sqrt(c.reduce((s, x) => s + (x - mc) ** 2, 0) / (c.length - 1));
    const t = sdc > 0 ? mc / (sdc / Math.sqrt(c.length)) : 0;
    out += `| ${h} bars | ${c.length} | ${mc.toFixed(2)}pt | ${mu.toFixed(2)}pt | ${(mc - mu).toFixed(2)}pt | ${t.toFixed(2)} |\n`;
    console.log(`h=${h}: N=${c.length} cond=${mc.toFixed(2)}pt uncond=${mu.toFixed(2)}pt edge=${(mc-mu).toFixed(2)}pt t=${t.toFixed(2)}`);
    results.push({ h, n: c.length, mc, mu, edge: mc - mu, t });
  }

  // Secondary check: do squeeze bars themselves cluster in trending periods (DeepSeek's
  // flagged confound)? Net drift over the prior 20 bars at each squeeze event.
  let priorDrift = [];
  for (const ev of squeezeEvents) {
    const i = idxOf.get(ev.ts);
    if (i >= 20) priorDrift.push(mBars[i].close - mBars[i - 20].close);
  }
  const meanPriorDrift = priorDrift.length ? mean(priorDrift) : 0;
  out += `\n## Confound check: net drift over the 20 bars BEFORE each squeeze\n`;
  out += `Mean prior-20-bar drift at squeeze events: ${meanPriorDrift.toFixed(2)}pt (N=${priorDrift.length})\n`;
  console.log(`Mean prior-20-bar drift at squeeze events: ${meanPriorDrift.toFixed(2)}pt`);

  fs.writeFileSync('scratch/bollinger_squeeze_forward_return_RESULTS.md', out);
  console.log('Results written to scratch/bollinger_squeeze_forward_return_RESULTS.md');

  const h1 = results.find(r => r.h === 1);
  await recordClaim({
    slug: 'bollinger_squeeze_forward_return',
    claimText: `Bollinger-band-squeeze (bottom decile 20-bar bandwidth, 60-min NQ bars) forward-return check vs unconditional baseline, no trade machinery. N=${squeezeEvents.length} squeeze events. h=1: conditional=${h1.mc.toFixed(2)}pt vs unconditional=${h1.mu.toFixed(2)}pt, edge=${h1.edge.toFixed(2)}pt, t=${h1.t.toFixed(2)}. Full horizon table (1/3/5/10/20 bars) in scratch/bollinger_squeeze_forward_return_RESULTS.md. Mean prior-20-bar drift at squeeze events=${meanPriorDrift.toFixed(2)}pt (DeepSeek's flagged confound check -- does squeeze correlate with an existing trend rather than genuine consolidation).`,
    sourceFile: 'scripts/pilot_bollinger_squeeze_forward_return.mjs',
    sampleSize: squeezeEvents.length, winRate: 0, evPerTrade: h1.edge,
    rigorStatus: 'signal_level_forward_return', status: 'PROVISIONAL',
  });
  console.log('Claim recorded.');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
