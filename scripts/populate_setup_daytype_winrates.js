// Populates setup_daytype_winrates from the full-history setup-detection replay
// (/tmp/all_setups_replay.json, produced by scripts/replay_all_setups.js).
// Source of truth for the setup-card "conditional edge by day type" display
// (replaces the fabricated SETUP_BASELINES / acd_baseline win rates).
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const data = JSON.parse(fs.readFileSync('/tmp/all_setups_replay.json', 'utf8'));
const computedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const allTypes = [...new Set(data.map(r => r.type))];

function summarize(rows) {
  const targetHit = rows.filter(r => r.resolution === 'TARGET_HIT').length;
  const stopHit = rows.filter(r => r.resolution === 'STOP_HIT').length;
  const expired = rows.filter(r => r.resolution === 'EXPIRED').length;
  const decidedN = targetHit + stopHit;
  const winRate = decidedN > 0 ? targetHit / decidedN : null;
  return { n: rows.length, decidedN, targetHit, stopHit, expired, winRate };
}

await q(`DELETE FROM setup_daytype_winrates WHERE computed_date = $1`, [computedDate]);

let inserted = 0;
for (const type of allTypes) {
  const typeRows = data.filter(r => r.type === type);

  // OVERALL (blended, all day types combined)
  const overall = summarize(typeRows);
  await q(`
    INSERT INTO setup_daytype_winrates (setup_type, day_type, n, decided_n, target_hit, stop_hit, expired, win_rate, limited_sample, computed_date)
    VALUES ($1,'OVERALL',$2,$3,$4,$5,$6,$7,$8,$9)
  `, [type, overall.n, overall.decidedN, overall.targetHit, overall.stopHit, overall.expired, overall.winRate, overall.decidedN < 20, computedDate]);
  inserted++;

  // Per ground-truth day type
  for (const dt of ['TREND', 'BALANCE', 'TURBULENT']) {
    const subset = typeRows.filter(r => r.dayType === dt);
    if (!subset.length) continue;
    const s = summarize(subset);
    await q(`
      INSERT INTO setup_daytype_winrates (setup_type, day_type, n, decided_n, target_hit, stop_hit, expired, win_rate, limited_sample, computed_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [type, dt, s.n, s.decidedN, s.targetHit, s.stopHit, s.expired, s.winRate, s.decidedN < 20, computedDate]);
    inserted++;
  }
}

console.log(`Inserted ${inserted} rows (computed_date=${computedDate}) for ${allTypes.length} setup types.`);
await pool.end();
