import { query } from '../server/db.js';
import { directionFromType } from '../server/services/maeMfeReplay.js';
import { getVolumeBaseline } from '../server/services/touchQuality.js';
import { computeRigor, computeReplication } from '../server/services/rigorDiagnostics.js';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function replayFull(bars, entry, stop, t1, direction) {
  let resolution = 'EXPIRED', barsToResolution = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    barsToResolution = i + 1;
    const stopHit = direction === 'LONG' ? bar.low <= stop : bar.high >= stop;
    const targetHit = direction === 'LONG' ? bar.high >= t1 : bar.low <= t1;
    if (stopHit) { resolution = 'STOP_HIT'; break; }
    if (targetHit) { resolution = 'TARGET_HIT'; break; }
  }
  return { resolution, barsToResolution };
}

function summarize(label, rows) {
  const n = rows.length;
  if (n === 0) return `    ${label.padEnd(20)} n=0`;
  const wins = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const wr = (wins / n * 100).toFixed(1);
  const evs = rows.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
  const ev = evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length).toFixed(2) : 'n/a';
  const flag = n >= 20 ? '' : ' (N<20)';
  let rigorStr = '';
  if (n >= 20) {
    const rigor = computeRigor(rows, { dateField: 'dateStr', pnlFn: r => Number(r.actual_pnl) });
    rigorStr = `  clustered=${rigor.clustered} stable=${rigor.stable}`;
  }
  return `    ${label.padEnd(20)} n=${String(n).padEnd(5)} WR=${wr.padStart(5)}%  EV=$${ev}${flag}${rigorStr}`;
}

const _volBaselineCache = new Map();
async function getVolBaseline(date) {
  if (_volBaselineCache.has(date)) return _volBaselineCache.get(date);
  const b = await getVolumeBaseline(query, date);
  _volBaselineCache.set(date, b);
  return b;
}

async function main() {
  const r = await query(`
    SELECT setup_type FROM active_setups
    WHERE resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
      AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
    GROUP BY setup_type HAVING COUNT(*) >= 50
  `);
  const setupTypes = r.rows.map(x => x.setup_type);

  const pooledRising = [], pooledFading = [], pooledTooShort = [];
  const perSetupStats = [];

  for (const setupType of setupTypes) {
    const direction = directionFromType(setupType);
    const setupsRes = await query(`
      SELECT id, trade_date, fired_at, resolution, actual_pnl,
             entry_zone_low::float AS entry_low, COALESCE(entry_zone_high, entry_zone_low)::float AS entry_high,
             stop_level::float AS stop, t1_level::float AS t1
      FROM active_setups
      WHERE setup_type = $1 AND resolution_method = 'BACKFILL' AND resolution IN ('STOP_HIT', 'TARGET_HIT')
        AND entry_zone_low IS NOT NULL AND stop_level IS NOT NULL AND t1_level IS NOT NULL AND actual_pnl IS NOT NULL
      ORDER BY trade_date, fired_at
    `, [setupType]);
    const setups = setupsRes.rows;
    if (setups.length < 50) continue;

    const byDate = new Map();
    for (const s of setups) {
      const d = typeof s.trade_date === 'string' ? s.trade_date.slice(0, 10) : s.trade_date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(s);
    }

    const enriched = [];
    for (const [date, dateSetups] of byDate) {
      const barsRes = await query(`
        SELECT ts, open::float, high::float, low::float, close::float,
               COALESCE(bid_volume,0)::int AS bid_volume, COALESCE(ask_volume,0)::int AS ask_volume,
               (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date = $1 ORDER BY ts
      `, [date]);
      const allBars = barsRes.rows;
      const volBaseline = await getVolBaseline(date);
      for (const s of dateSetups) {
        const bars = allBars.filter(b => b.ts > s.fired_at);
        if (bars.length === 0) continue;
        const entry = (s.entry_low + s.entry_high) / 2;
        const { resolution, barsToResolution } = replayFull(bars, entry, s.stop, s.t1, direction);
        enriched.push({ ...s, dateStr: date, resolution, barsToResolution, bars, volBaseline });
      }
    }
    if (enriched.length === 0) continue;

    const barsToResList = enriched.map(r => r.barsToResolution).sort((a, b) => a - b);
    const windowBars = Math.max(1, Math.ceil(percentile(barsToResList, 0.25)));

    const rising = [], fading = [], tooShort = [];
    
    for (const r of enriched) {
      const win = r.bars.slice(0, Math.min(windowBars, r.barsToResolution));
      if (win.length < 2) {
        tooShort.push(r);
        continue;
      }
      
      let coverage = true;
      const zScores = [];
      for (const bar of win) {
        const bl = r.volBaseline.get(bar.mod);
        if (!bl || !(bl.std_vol > 0)) { coverage = false; break; }
        const totalVol = bar.bid_volume + bar.ask_volume;
        zScores.push((totalVol - bl.avg_vol) / bl.std_vol);
      }
      if (!coverage) continue;
      
      const half = Math.floor(win.length / 2);
      const firstHalf = zScores.slice(0, half);
      const secondHalf = zScores.slice(-half);
      
      const firstAvg = firstHalf.reduce((a,b)=>a+b,0) / half;
      const secondAvg = secondHalf.reduce((a,b)=>a+b,0) / half;
      
      if (secondAvg > firstAvg) {
        rising.push(r);
      } else {
        fading.push(r);
      }
    }

    console.log(`\n### ${setupType}`);
    console.log(summarize('RISING', rising));
    console.log(summarize('FADING', fading));
    console.log(summarize('TOO_SHORT', tooShort));

    pooledRising.push(...rising);
    pooledFading.push(...fading);
    pooledTooShort.push(...tooShort);
    
    const evOf = (arr) => {
        if (arr.length === 0) return 0;
        const evs = arr.map(r => Number(r.actual_pnl)).filter(v => Number.isFinite(v));
        return evs.length ? (evs.reduce((a, b) => a + b, 0) / evs.length) : 0;
    };
    
    perSetupStats.push({
      setupType,
      risingN: rising.length,
      fadingN: fading.length,
      risingEV: evOf(rising),
      fadingEV: evOf(fading),
      diff: evOf(rising) - evOf(fading)
    });
  }

  console.log('\n' + '='.repeat(90));
  console.log('POOLED');
  console.log('='.repeat(90));
  console.log(summarize('RISING', pooledRising));
  console.log(summarize('FADING', pooledFading));
  console.log(summarize('TOO_SHORT', pooledTooShort));
  
  // Replication Check
  const validSetups = perSetupStats.filter(s => s.risingN >= 20 && s.fadingN >= 20);
  validSetups.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  
  const selectedIds = validSetups.slice(0, 6).map(s => s.setupType);
  
  if (selectedIds.length > 0) {
      console.log('\n' + '='.repeat(90));
      console.log('REPLICATION CHECK (Top 6 absolute effect sizes with N>=20 in both arms)');
      console.log('='.repeat(90));
      const rep = computeReplication(perSetupStats, {
          idFn: s => s.setupType,
          metricFn: s => {
              if (s.risingN >= 20 && s.fadingN >= 20) {
                  return { n: s.risingN + s.fadingN, value: s.diff };
              }
              return null;
          },
          selectedIds
      });
      console.log(JSON.stringify(rep, null, 2));
      console.log(`\nReplicates? ${rep.replicates ? 'TRUE' : 'FALSE'}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
