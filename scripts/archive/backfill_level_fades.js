// backfill_level_fades.js
// Populates active_setups with historical level fade detections back to 2023-11-16.
//
// Uses:
//   level_prices — canonical level prices per trade_date (source of truth)
//   price_bars   — 1-min NQ bars for detection and resolution
//   performance_audit — data-derived stop (p75_mae) and T1 (p50_mfe) per level type
//
// Detection logic mirrors backtest_unified.js detectLevelFades():
//   - No entries before IB close (10:30 AM ET = tod 630)
//   - No entries after noon (tod 720)
//   - Touch threshold: ±15pt from close to level
//   - Direction: prev_close > level → approach from above → SHORT fade
//   - Each level fires at most once per session (first touch only)
//   - Confluence count: how many OTHER levels fired on the same bar
//
// P&L uses NQ contract value: $5/pt, $5 commission/round-trip
//
// ⚠️ WRONG — found 2026-07-14, do not copy this convention into new scripts. This journal
// actually trades MNQ: $2/pt, $1 commission/round-trip (matches server/routes/acd.js's live
// resolution path, `const PNL_PER_POINT = 2; // MNQ = $2/point`). $5/pt matches neither MNQ
// ($2) nor standard NQ ($20) — an uncaught error, not a deliberate choice, confirmed with the
// user. This propagated into every scripts/repair_*.mjs script before being caught and fixed
// (scripts/repair_dollars_per_point.mjs rescaled the resulting data). See docs/KNOWN_ISSUES.md.
//
// Run: node scripts/backfill_level_fades.js [--dry-run] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]

import pg from 'pg';
const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'trading_journal', user: 'trader', password: 'trader123' });
const q = (t, p) => pool.query(t, p);

const PT = 5;   // $ per NQ point -- WRONG, see the header note above. Should be 2 (MNQ).
const COMM = 5; // commission per round-trip -- WRONG, see the header note above. Should be 1.

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fromDate = args.find(a => a.startsWith('--from='))?.slice(7) || null;
const toDate   = args.find(a => a.startsWith('--to='))?.slice(5)   || null;

const IB_CLOSE = 630; // 10:30 AM ET in minutes from midnight
const AM_CUT   = 720; // noon — no new entries after this
const SESSION_END = 780; // 1:00 PM ET — resolution window end

// ── Performance audit params per level type ───────────────────────────────────
// Mapped from performance_audit WHERE signal_type IN ('LEVEL_FADE_AUDIT','MIDPOINT_FADE_AUDIT')
// Key = level_name in level_prices, value = { stopDist, t1Dist, winRate, sessions, auditName }
const LEVEL_PARAMS = {
  OR_HIGH:        { stopDist: 76.25, t1Dist: 41.00, auditName: 'OR_HIGH',        setupSuffix: 'OR_HIGH_FADE' },
  OR_LOW:         { stopDist: 69.63, t1Dist: 36.00, auditName: 'OR_LOW',         setupSuffix: 'OR_LOW_FADE' },
  IB_HIGH:        { stopDist: 52.44, t1Dist: 30.38, auditName: 'IB_HIGH',        setupSuffix: 'IB_HIGH_FADE' },
  IB_LOW:         { stopDist: 67.63, t1Dist: 34.00, auditName: 'IB_LOW',         setupSuffix: 'IB_LOW_FADE' },
  IB_MID:         { stopDist: 56.25, t1Dist: 29.00, auditName: 'IB_MID',         setupSuffix: 'IB_MID_SCALP_FADE' },
  PD_VAH:         { stopDist: 66.75, t1Dist: 39.00, auditName: 'PD_VAH',         setupSuffix: 'PD_VAH_FADE' },
  PD_VAL:         { stopDist: 83.25, t1Dist: 46.25, auditName: 'PD_VAL',         setupSuffix: 'PD_VAL_FADE' },
  PD_POC:         { stopDist: 72.88, t1Dist: 43.50, auditName: 'PD_POC',         setupSuffix: 'PD_POC_FADE' },
  FLOOR_PIVOT:    { stopDist: 77.94, t1Dist: 50.25, auditName: 'FLOOR_PIVOT',    setupSuffix: 'FLOOR_PIVOT_FADE' },
  FLOOR_R1:       { stopDist: 68.25, t1Dist: 33.38, auditName: 'FLOOR_R1',       setupSuffix: 'FLOOR_R1_FADE' },
  FLOOR_S1:       { stopDist: 75.00, t1Dist: 44.50, auditName: 'FLOOR_S1',       setupSuffix: 'FLOOR_S1_FADE' },
  OR_MID:         { stopDist: 62.00, t1Dist: 30.25, auditName: 'OR_MID_AFTER_IB',setupSuffix: 'OR_MID_AFTER_IB_FADE' },
  PD_IB_MID:      { stopDist: 56.25, t1Dist: 29.00, auditName: 'IB_MID',         setupSuffix: 'PD_IB_MID_FADE' },  // proxy: IB_MID params
  PD_OR_MID:      { stopDist: 77.88, t1Dist: 45.00, auditName: 'PD_MID',         setupSuffix: 'PD_OR_MID_FADE' },
  // Added 2026-07-04 — confirmed in level_prices, params from UNIFIED_BACKTEST window_days=9999
  PD_IB_HIGH:     { stopDist: 81.10, t1Dist: 40.10, auditName: 'PD_IB_HIGH',     setupSuffix: 'PD_IB_HIGH_FADE' },
  PD_IB_LOW:      { stopDist: 67.30, t1Dist: 41.30, auditName: 'PD_IB_LOW',      setupSuffix: 'PD_IB_LOW_FADE' },
  WEEKLY_VWAP:    { stopDist: 67.30, t1Dist: 41.00, auditName: 'WEEKLY_VWAP',    setupSuffix: 'WEEKLY_VWAP_FADE' },
  // Added 2026-07-04; 5D_OR_MID marginal EV (kept for reference); PD_SESSION_MID params from PD_IB_AUDIT p75_mae/p50_mfe
  '5D_OR_MID':    { stopDist: 62.00, t1Dist: 30.25, auditName: '5D_OR_MID',      setupSuffix: '5D_OR_MID_FADE' },
  PD_SESSION_MID: { stopDist: 82.25, t1Dist: 48.50, auditName: 'PD_SESSION_MID', setupSuffix: 'PD_SESSION_MID_FADE' },
  // Weekly/monthly floor pivots + Camarilla — added 2026-07-04 for confluence backtest coverage
  // Params from SYSTEM_BACKTEST p75_mae/p50_mfe (window_days=9999)
  WS1:      { stopDist: 62.81, t1Dist: 41.88, auditName: 'WS1',    setupSuffix: 'WS1_FADE' },
  WS2:      { stopDist: 76.50, t1Dist: 44.25, auditName: 'WS2',    setupSuffix: 'WS2_FADE' },
  WR1:      { stopDist: 61.63, t1Dist: 38.50, auditName: 'WR1',    setupSuffix: 'WR1_FADE' },
  WR2:      { stopDist: 80.50, t1Dist: 41.00, auditName: 'WR2',    setupSuffix: 'WR2_FADE' },
  WPP:      { stopDist: 78.63, t1Dist: 33.25, auditName: 'WPP',    setupSuffix: 'WPP_FADE' },
  MPP:      { stopDist: 74.25, t1Dist: 41.00, auditName: 'MPP',    setupSuffix: 'MPP_FADE' },
  MR1:      { stopDist: 56.13, t1Dist: 40.63, auditName: 'MR1',    setupSuffix: 'MR1_FADE' },
  MR2:      { stopDist: 63.50, t1Dist: 17.00, auditName: 'MR2',    setupSuffix: 'MR2_FADE' },
  MS1:      { stopDist: 87.31, t1Dist: 41.00, auditName: 'MS1',    setupSuffix: 'MS1_FADE' },
  MS2:      { stopDist: 47.69, t1Dist: 47.13, auditName: 'MS2',    setupSuffix: 'MS2_FADE' },
  CAM_R1:   { stopDist: 65.88, t1Dist: 37.13, auditName: 'CAM_R1', setupSuffix: 'CAM_R1_FADE' },
  CAM_R2:   { stopDist: 69.50, t1Dist: 37.50, auditName: 'CAM_R2', setupSuffix: 'CAM_R2_FADE' },
  CAM_R3:   { stopDist: 78.13, t1Dist: 39.25, auditName: 'CAM_R3', setupSuffix: 'CAM_R3_FADE' },
  CAM_R4:   { stopDist: 85.44, t1Dist: 40.38, auditName: 'CAM_R4', setupSuffix: 'CAM_R4_FADE' },
  CAM_S1:   { stopDist: 76.44, t1Dist: 40.63, auditName: 'CAM_S1', setupSuffix: 'CAM_S1_FADE' },
  CAM_S2:   { stopDist: 71.50, t1Dist: 41.75, auditName: 'CAM_S2', setupSuffix: 'CAM_S2_FADE' },
  CAM_S3:   { stopDist: 92.44, t1Dist: 40.25, auditName: 'CAM_S3', setupSuffix: 'CAM_S3_FADE' },
  CAM_S4:   { stopDist: 87.25, t1Dist: 40.63, auditName: 'CAM_S4', setupSuffix: 'CAM_S4_FADE' },
};

// Enriched with win_rate and sessions from performance_audit at runtime
const perfParams = {};

// ── Level detection (mirrors backtest_unified.js detectLevelFades) ─────────────
function detectLevelFades(bars, levels) {
  const fires = [];
  const fired = new Set();

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    if (b.tod < IB_CLOSE) continue;
    if (b.tod >= AM_CUT)  break;

    for (const [levelName, lvl] of Object.entries(levels)) {
      if (lvl == null || fired.has(levelName)) continue;
      if (Math.abs(b.close - lvl) > 15) continue;

      // Direction matches acd.js convention: FROM_ABOVE (price fell to level) → LONG (fade the fall)
      const fromAbove = prev.close > lvl;
      const dir = fromAbove ? 'LONG' : 'SHORT';
      fires.push({ levelName, dir, barIdx: i, barTs: b.ts, entryPx: b.close, levelPx: lvl });
      fired.add(levelName);
    }
  }

  // Tag confluence: how many other levels fired on the same bar
  for (const f of fires) {
    f.confluenceCount = fires.filter(o => o.barIdx === f.barIdx && o !== f).length;
  }

  return fires;
}

// ── Resolution: walk bars from fire bar to session end ────────────────────────
function resolve(bars, fromIdx, isLong, stop, t1) {
  for (let i = fromIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.tod > SESSION_END) break;

    const stopHit   = isLong ? b.low  <= stop : b.high >= stop;
    const targetHit = isLong ? b.high >= t1   : b.low  <= t1;

    if (stopHit && targetHit) {
      // Same bar: conservative — stop wins unless open favors target
      const towardT1 = isLong ? b.open > stop : b.open < stop;
      if (towardT1) return { resolution: 'TARGET_HIT', resolvedAt: b.ts };
      return { resolution: 'STOP_HIT', resolvedAt: b.ts };
    }
    if (targetHit) return { resolution: 'TARGET_HIT', resolvedAt: b.ts };
    if (stopHit)   return { resolution: 'STOP_HIT',   resolvedAt: b.ts };
  }
  return { resolution: 'TIME_EXPIRED', resolvedAt: null };
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log(`Backfill Level Fades${DRY_RUN ? ' [DRY RUN]' : ''}`);

// Load performance_audit params (win_rate + sessions for each level)
const paRows = await q(`
  SELECT signal_name, win_rate::float, sample_size::int
  FROM performance_audit
  WHERE signal_type IN ('LEVEL_FADE_AUDIT', 'MIDPOINT_FADE_AUDIT')
`);
for (const row of paRows.rows) {
  perfParams[row.signal_name] = { winRate: row.win_rate, sessions: row.sample_size };
}
console.log(`Loaded ${paRows.rows.length} performance_audit entries`);

// Get all trade dates where we have both level_prices and bars, in range
const dateConditions = [];
if (fromDate) dateConditions.push(`trade_date >= '${fromDate}'`);
if (toDate)   dateConditions.push(`trade_date <= '${toDate}'`);
const dateWhere = dateConditions.length ? `AND ${dateConditions.join(' AND ')}` : '';

const datesR = await q(`
  SELECT DISTINCT trade_date::text as d
  FROM level_prices
  WHERE trade_date < CURRENT_DATE
  ${dateWhere}
  ORDER BY d
`);
const dates = datesR.rows.map(r => r.d);
console.log(`Processing ${dates.length} trading dates (${dates[0]} → ${dates[dates.length - 1]})`);

// Check existing level fade entries to skip re-inserting
const existR = await q(`
  SELECT trade_date::text, setup_type FROM active_setups
  WHERE setup_type LIKE '%FADE%' AND status != 'SHADOW'
`);
const existSet = new Set(existR.rows.map(r => `${r.trade_date}|${r.setup_type}`));
console.log(`${existSet.size} level fade entries already exist — will skip those`);

let inserted = 0, skipped = 0, noFire = 0;
const statsByType = {};

for (const date of dates) {
  // Load this session's bars (RTH + some buffer: 9:30-13:15 ET)
  const barsR = await q(`
    SELECT ts::text as ts, open::float, high::float, low::float, close::float,
           EXTRACT(hour FROM ts)::int * 60 + EXTRACT(minute FROM ts)::int as tod
    FROM price_bars
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 795
    ORDER BY ts
  `, [date]);
  const bars = barsR.rows;
  if (bars.length < 30) { noFire++; continue; }

  // Load all level prices for this date
  const lpR = await q(`
    SELECT level_name, price::float FROM level_prices WHERE trade_date = $1
  `, [date]);
  if (!lpR.rows.length) { noFire++; continue; }

  const lp = {};
  for (const row of lpR.rows) lp[row.level_name] = row.price;

  // Build the levels map from LEVEL_PARAMS (only levels we have data for)
  const levels = {};
  for (const levelName of Object.keys(LEVEL_PARAMS)) {
    if (lp[levelName] != null) levels[levelName] = lp[levelName];
  }

  const fires = detectLevelFades(bars, levels);
  if (!fires.length) { noFire++; continue; }

  for (const fire of fires) {
    const params = LEVEL_PARAMS[fire.levelName];
    if (!params) continue;

    const isLong = fire.dir === 'LONG';
    const entry  = Math.round(fire.entryPx * 4) / 4; // quarter-point precision

    const stopDist = params.stopDist;
    const t1Dist   = params.t1Dist;

    const stop = isLong ? entry - stopDist : entry + stopDist;
    const t1   = isLong ? entry + t1Dist   : entry - t1Dist;

    const setupType = `${params.setupSuffix}_${fire.dir}`;

    // Skip if already exists
    const key = `${date}|${setupType}`;
    if (existSet.has(key)) { skipped++; continue; }

    // Validate levels (stop and T1 must be on correct sides)
    if (isLong && (stop >= entry || t1 <= entry)) continue;
    if (!isLong && (stop <= entry || t1 >= entry)) continue;

    const { resolution, resolvedAt } = resolve(bars, fire.barIdx, isLong, stop, t1);

    // P&L
    let pnl = null;
    if (resolution === 'TARGET_HIT') pnl = Math.round((t1Dist * PT - COMM) * 100) / 100;
    if (resolution === 'STOP_HIT')   pnl = Math.round((-stopDist * PT - COMM) * 100) / 100;
    if (resolution === 'TIME_EXPIRED') pnl = 0;

    const status = resolution === 'TIME_EXPIRED' ? 'EXPIRED' : 'RESOLVED';
    const pa = perfParams[params.auditName] || {};

    // fired_at: the bar's ts is already naive local ET (no TZ conversion needed)
    const firedAt  = fire.barTs;
    const expiresAt = `${date} 13:00:00`;
    const t1Label = `T1: ${t1Dist}pt (p50 MFE) · Stop: ${stopDist}pt (p75 MAE)`;

    if (!statsByType[setupType]) statsByType[setupType] = { total: 0, wins: 0, losses: 0, pnl: 0 };
    statsByType[setupType].total++;
    if (resolution === 'TARGET_HIT') statsByType[setupType].wins++;
    if (resolution === 'STOP_HIT')   statsByType[setupType].losses++;
    statsByType[setupType].pnl += pnl || 0;

    if (!DRY_RUN) {
      await q(`
        INSERT INTO active_setups (
          trade_date, setup_type, fired_at, expires_at, resolved_at,
          status, resolution,
          entry_zone_low, stop_level, t1_level, t1_label,
          structural_level_touched, structural_level_type,
          price_at_detection,
          historical_win_rate, historical_sessions, historical_source,
          confluence_score_at_detection,
          actual_pnl, resolution_method
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,
          $8,$9,$10,$11,
          $12,$13,
          $14,
          $15,$16,$17,
          $18,
          $19,$20
        )
        ON CONFLICT DO NOTHING
      `, [
        date, setupType, firedAt, expiresAt, resolvedAt,
        status, resolution,
        entry, stop, t1, t1Label,
        fire.levelPx, fire.levelName,
        entry,
        pa.winRate ?? null, pa.sessions ?? null, 'LEVEL_FADE_AUDIT',
        fire.confluenceCount,
        pnl, 'BACKFILL',
      ]);
      existSet.add(key);
      inserted++;
    } else {
      console.log(`  DRY: ${date} ${setupType} entry=${entry} stop=${stop} t1=${t1} → ${resolution} pnl=${pnl}`);
      inserted++;
    }
  }

  if (inserted % 100 === 0 && inserted > 0) process.stdout.write(`  ${inserted} inserted...\r`);
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}`);
console.log(`Dates processed: ${dates.length} | No-fire: ${noFire} | Skipped (existing): ${skipped}`);
console.log(`${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted} level fade entries`);

console.log(`\nBy setup type:`);
for (const [type, s] of Object.entries(statsByType).sort((a, b) => b[1].total - a[1].total)) {
  const wr = s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100).toFixed(1) : 'n/a';
  console.log(`  ${type.padEnd(36)} n=${String(s.total).padEnd(4)} WR=${wr.padEnd(5)}% PnL=$${Math.round(s.pnl).toLocaleString()}`);
}

await pool.end();
