// Direct test of the user's domain claim, split by direction: "down moves happen quickly
// and continue for ~2hrs, then TRY to retrace around 11am-noon ET (usually, sometimes
// continues). Up moves have a different character -- can grind upward all day with minor
// retracements, need conviction to hold through them rather than a clean fast move."
//
// A LONG setup gets STOP_HIT by a DOWN move (price fell through the stop) -- its
// post-stop adverse extension IS a continuing down move. A SHORT setup gets STOP_HIT by
// an UP move -- its post-stop adverse extension IS a continuing up move. So splitting
// STOP_HIT trades by setup direction (via the shared inferDirection()) and looking at
// when the adverse extension finally stops getting worse directly tests the claim:
// LONG-stop-outs (down moves against us) should taper by ~11-12; SHORT-stop-outs (up
// moves against us) should NOT show the same clean taper, consistent with "grinds all day."
//
// Same entry-price/window/MAE-MFE-filter conventions as backtest_post_resolution_sequence.mjs
// (siblings, not a reimplementation of a live service -- this is backtest-script bar-walking,
// which this codebase's other post-resolution scripts already do independently per-script).
//
// Run: node scripts/backtest_directional_taper_timing.mjs
import { query } from '../server/db.js';
import { inferDirection } from '../server/config/setupTypes.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const EXTENSION_WINDOW_BARS = 240;
const SUBSTANTIAL_EXTENSION_PTS = 50;

function etClockString(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  return `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
}
function etMinuteOfDay(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  return (+parts.find(p => p.type === 'hour').value) * 60 + (+parts.find(p => p.type === 'minute').value);
}

async function main() {
  const res = await query(`
    SELECT setup_type, fired_at, resolved_at, entry_zone_low::float as entry_zone_low,
      entry_zone_high::float as entry_zone_high, mae_points::float as mae_points, mfe_points::float as mfe_points
    FROM active_setups
    WHERE resolution = 'STOP_HIT' AND mae_points IS NOT NULL AND mfe_points IS NOT NULL
      AND mae_points <= 300 AND mfe_points <= 300 AND resolved_at IS NOT NULL AND entry_zone_low IS NOT NULL
    ORDER BY resolved_at ASC
  `);
  const trades = res.rows;
  console.log(`${trades.length} STOP_HIT trades loaded.`);

  const barsRes = await query(`SELECT ts, high::float as high, low::float as low FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), high: b.high, low: b.low }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const results = [];
  for (const trade of trades) {
    const direction = inferDirection(trade.setup_type);
    if (!direction) continue;
    const long = direction === 'LONG';
    const entry = trade.entry_zone_high ?? trade.entry_zone_low;
    const resolvedTime = new Date(trade.resolved_at).getTime();
    const resolvedEtMin = etMinuteOfDay(resolvedTime);
    const startIdx = firstIndexAfter(resolvedTime);
    const endIdx = Math.min(allBars.length, startIdx + EXTENSION_WINDOW_BARS);

    let runAdverse = trade.mae_points;
    let lastNewAdverseAt = null;
    for (let i = startIdx; i < endIdx; i++) {
      const bar = allBars[i];
      const adverse = long ? entry - bar.low : bar.high - entry;
      if (adverse > runAdverse) {
        runAdverse = adverse;
        lastNewAdverseAt = { barsSince: i - startIdx + 1, etMin: etMinuteOfDay(bar.ts) };
      }
    }
    const extension = runAdverse - trade.mae_points;
    results.push({ setup_type: trade.setup_type, direction, resolvedEtMin, extension, lastNewAdverseAt, date: trade.fired_at.toISOString().slice(0, 10) });
  }

  for (const dir of ['LONG', 'SHORT']) {
    const moveLabel = dir === 'LONG' ? 'DOWN move against a LONG' : 'UP move against a SHORT';
    const morning = results.filter(r =>
      r.direction === dir && r.resolvedEtMin < 660 && r.lastNewAdverseAt && r.extension >= SUBSTANTIAL_EXTENSION_PTS
    );
    const buckets = { 'before 10am': 0, '10-11am': 0, '11am-12pm': 0, '12-1pm': 0, 'after 1pm': 0 };
    for (const r of morning) {
      const m = r.lastNewAdverseAt.etMin;
      if (m < 600) buckets['before 10am']++;
      else if (m < 660) buckets['10-11am']++;
      else if (m < 720) buckets['11am-12pm']++;
      else if (m < 780) buckets['12-1pm']++;
      else buckets['after 1pm']++;
    }
    const pctByNoon = morning.length ? +(100 * (buckets['before 10am'] + buckets['10-11am'] + buckets['11am-12pm']) / morning.length).toFixed(1) : null;
    const avgBarsToTaper = morning.length ? +(morning.reduce((s, r) => s + r.lastNewAdverseAt.barsSince, 0) / morning.length).toFixed(1) : null;
    const medBarsToTaper = morning.length ? morning.map(r => r.lastNewAdverseAt.barsSince).sort((a,b)=>a-b)[Math.floor(morning.length/2)] : null;

    const rigor = computeRigor(morning, { pnlFn: r => r.lastNewAdverseAt.etMin < 720 ? 1 : -1 });

    console.log(`\n=== ${dir} setups stopped out (${moveLabel}), resolved before 11am, extended >=${SUBSTANTIAL_EXTENSION_PTS}pt further ===`);
    console.log(`N=${morning.length} (of ${results.filter(r => r.direction === dir && r.resolvedEtMin < 660).length} total morning ${dir} stop-outs)`);
    console.log(buckets);
    console.log(`${pctByNoon}% finish extending adverse by 12:00 ET. Avg bars-to-taper=${avgBarsToTaper} (~${avgBarsToTaper ? (avgBarsToTaper*1).toFixed(0) : '?'}min), median=${medBarsToTaper}min.`);
    console.log(`Rigor (day-clustering/stability, using <12pm-taper as the +1/-1 proxy):`, rigor);

    const today = (await query(`SELECT CURRENT_DATE::text as d`)).rows[0].d;
    await query(`
      INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, notes)
      VALUES ($1, 0, 'POST_RES_SEQ', $2, $3, $4)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET sample_size=EXCLUDED.sample_size, notes=EXCLUDED.notes
    `, [today, `taper_timing_${dir}`, morning.length, JSON.stringify({ buckets, pctByNoon, avgBarsToTaper, medBarsToTaper, rigor })]);
  }

  console.log('\nPersisted signal_type=\'POST_RES_SEQ\' signal_name=\'taper_timing_LONG\'/\'taper_timing_SHORT\'.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
