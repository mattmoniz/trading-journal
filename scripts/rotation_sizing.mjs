import fs from 'fs';
import { query } from '../server/db.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';

const PROXIMITY = 15;

function getFormationGate(levelName) {
  if (['OR_HIGH', 'OR_LOW'].includes(levelName)) return 575;
  if (['IB_HIGH', 'IB_LOW', 'IB_MID', 'OR_MID', 'PD_IB_HIGH', 'PD_IB_LOW'].includes(levelName)) return 630;
  return 570;
}

async function run() {
  console.log('Fetching active setups...');
  const res = await query(`
    SELECT id, trade_date::text as trade_date, setup_type, fired_at, actual_pnl::float as actual_pnl 
    FROM active_setups 
    WHERE (setup_type LIKE '%_FADE_LONG' OR setup_type LIKE '%_FADE_SHORT')
      AND actual_pnl IS NOT NULL
      AND resolution IN ('WIN', 'LOSS', 'STOP_HIT', 'TARGET_HIT')
  `);
  const setups = res.rows;
  console.log(`Found ${setups.length} resolved setups.`);

  const setupsByDate = {};
  for (const s of setups) {
    if (!setupsByDate[s.trade_date]) setupsByDate[s.trade_date] = [];
    setupsByDate[s.trade_date].push(s);
  }

  const results = {}; // setup_type -> { base: [], pairs: { priorLevelDir: [] } }

  const dates = Object.keys(setupsByDate).sort();
  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    if (di % 30 === 0) console.log(`Processing day ${di + 1}/${dates.length}: ${date}`);

    const [levelPricesRes, barsRes] = await Promise.all([
      query(`SELECT level_name, price::float FROM level_prices WHERE trade_date = $1 AND price IS NOT NULL`, [date]),
      query(`
        SELECT ts, EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) as tod, high::float, low::float 
        FROM price_bars_primary 
        WHERE ts::date = $1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 570
        ORDER BY ts
      `, [date])
    ]);

    const levelPrices = {};
    for (const row of levelPricesRes.rows) levelPrices[row.level_name] = row.price;
    const bars = barsRes.rows;

    if (Object.keys(levelPrices).length < 5 || bars.length === 0) continue;

    for (const setup of setupsByDate[date]) {
      const setupLevelBase = setup.setup_type.replace('_FADE_LONG', '').replace('_FADE_SHORT', '');
      
      const priorTouches = new Set();
      
      for (const bar of bars) {
        if (new Date(bar.ts).getTime() >= new Date(setup.fired_at).getTime()) break;
        const tod = bar.tod;

        for (const [name, level] of Object.entries(levelPrices)) {
          if (level == null || !isFinite(level)) continue;
          if (tod < getFormationGate(name)) continue;

          // Don't count the setup's own level as a prior touch
          if (name === setupLevelBase) continue;

          if (Math.abs(bar.high - level) <= PROXIMITY && bar.high >= level) {
            priorTouches.add(`${name}_SHORT`);
          }
          if (Math.abs(bar.low - level) <= PROXIMITY && bar.low <= level) {
            priorTouches.add(`${name}_LONG`);
          }
        }
      }

      if (!results[setup.setup_type]) {
        results[setup.setup_type] = { base: [], pairs: {} };
      }
      
      results[setup.setup_type].base.push({ date, pnl: setup.actual_pnl });

      for (const pt of priorTouches) {
        if (!results[setup.setup_type].pairs[pt]) results[setup.setup_type].pairs[pt] = [];
        results[setup.setup_type].pairs[pt].push({ date, pnl: setup.actual_pnl });
      }
    }
  }

  const candidates = [];

  for (const [setupType, data] of Object.entries(results)) {
    if (data.base.length < 20) continue;

    const baseEv = data.base.reduce((s, x) => s + x.pnl, 0) / data.base.length;
    const baseWr = data.base.filter(x => x.pnl > 0).length / data.base.length;

    for (const [priorKey, trades] of Object.entries(data.pairs)) {
      if (trades.length < 20) continue;

      const condEv = trades.reduce((s, x) => s + x.pnl, 0) / trades.length;
      const condWr = trades.filter(x => x.pnl > 0).length / trades.length;
      const deltaEv = condEv - baseEv;

      const rigor = computeRigor(trades, {
        dateField: 'date',
        pnlFn: (t) => t.pnl
      });

      candidates.push({
        setupType,
        priorKey,
        n: trades.length,
        baseN: data.base.length,
        baseEV: baseEv,
        baseWR: baseWr,
        condEV: condEv,
        condWR: condWr,
        deltaEV: deltaEv,
        rigor
      });
    }
  }

  candidates.sort((a, b) => b.deltaEV - a.deltaEV);
  
  fs.writeFileSync('scratch/rotation_sizing_candidates.json', JSON.stringify(candidates, null, 2));
  
  // Output markdown table
  let md = '## Piece A: Rotation Sizing Candidates\n\n';
  const validCandidates = candidates.filter(c => Math.abs(c.deltaEV) > 10 && c.rigor.clean);
  if (validCandidates.length === 0) {
    md += 'No clean candidates with |deltaEV| > $10 found.\n\n';
    md += '### Top Candidates (including noisy/unstable):\n';
    md += '| Setup Type | Prior Touch | N | Base EV | Cond EV | Delta EV | Rigor |\n';
    md += '|---|---|---|---|---|---|---|\n';
    for (const c of candidates.slice(0, 15)) {
      const rigStr = c.rigor.clean ? 'CLEAN' : (c.rigor.clustered ? 'CLUST' : 'UNSTAB');
      md += `| ${c.setupType} | ${c.priorKey} | ${c.n} / ${c.baseN} | $${c.baseEV.toFixed(2)} | $${c.condEV.toFixed(2)} | **$${c.deltaEV.toFixed(2)}** | ${rigStr} (${c.rigor.top5DayPct}%) |\n`;
    }
  } else {
    md += '| Setup Type | Prior Touch | N | Base EV | Cond EV | Delta EV | Rigor |\n';
    md += '|---|---|---|---|---|---|---|\n';
    for (const c of validCandidates.slice(0, 20)) {
      const rigStr = c.rigor.clean ? 'CLEAN' : (c.rigor.clustered ? 'CLUST' : 'UNSTAB');
      md += `| ${c.setupType} | ${c.priorKey} | ${c.n} / ${c.baseN} | $${c.baseEV.toFixed(2)} | $${c.condEV.toFixed(2)} | **$${c.deltaEV.toFixed(2)}** | ${rigStr} (${c.rigor.top5DayPct}%) |\n`;
    }
  }
  md += '\n';

  fs.writeFileSync('scratch/pieceA.md', md);
  console.log('Piece A done');
  process.exit(0);
}

run().catch(console.error);
