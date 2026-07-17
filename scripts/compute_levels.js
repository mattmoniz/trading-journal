// compute_levels.js
// Computes all MGI (Market Generated Information) levels for one or more trading dates
// and writes them to the level_prices table.
//
// Levels computed per session:
//   PRIOR_DAY     : PD_VAH, PD_VAL, PD_POC, PD_HIGH, PD_LOW, PD_CLOSE, PD_IB_HIGH, PD_IB_LOW, PD_IB_MID
//   OVERNIGHT     : ONH, ONL  (Globex 18:00 prior ET → 09:29 current ET)
//   CURRENT       : OR_HIGH, OR_LOW, OR_MID, IB_HIGH, IB_LOW, IB_MID, 5D_OR_MID
//   PRIOR_DAY     : ... PD_SESSION_MID (added 2026-07-04)
//   OPENS         : DAILY_OPEN, WEEKLY_OPEN, MONTHLY_OPEN
//   VWAP          : RTH_VWAP, WEEKLY_VWAP  (24hr VWAP computed live in acd.js, not stored here)
//   PIVOT         : FLOOR_PIVOT, R1, R2, R3, S1, S2, S3
//   CAMARILLA     : CAM_R1, CAM_R2, CAM_R3, CAM_R4, CAM_S1, CAM_S2, CAM_S3, CAM_S4 (from PD H/L/C)
//   WEEKLY        : PW_HIGH, PW_LOW, PW_VAH, PW_VAL, PW_POC
//   WEEKLY_PIVOT  : WPP, WR1, WR2, WS1, WS2 (prior-week floor pivots)
//   MONTHLY       : PM_HIGH, PM_LOW, PM_VAH, PM_VAL, PM_POC
//   MONTHLY_PIVOT : MPP, MR1, MR2, MS1, MS2 (prior-month floor pivots)
//   3-MONTH       : 3M_VAH, 3M_VAL, 3M_POC
//
// CANONICAL DATA FLOW: compute_levels.js → level_prices table → backtest_unified.js + acd.js
// Adding a new level here is all that's needed to make it fully symmetric across backtest and live detection.
//
// Usage:
//   node scripts/compute_levels.js                  → compute today only
//   node scripts/compute_levels.js 2026-06-30       → compute specific date
//   node scripts/compute_levels.js --backfill       → compute all dates in developing_value_log
//   node scripts/compute_levels.js --backfill --from 2024-01-01  → backfill from date

import pg from 'pg';
import dotenv from 'dotenv';
import { computeVolumeProfileForRange } from '../server/services/developingValueService.js';
dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
  port: parseInt(process.env.DB_PORT || '5432'),
});
const q = (sql, params) => pool.query(sql, params);

// ─── Volume Profile: 70% value area, spread-volume method ─────────────────
// Reuses developingValueService.js's computeProfile() (the proven-correct
// reference implementation) via computeVolumeProfileForRange — see
// docs/OPEN_THREADS.md's value-area bucketing bug writeup for why this no
// longer buckets by each bar's low price.
async function computeValueArea(startDate, endDate) {
  const profile = await computeVolumeProfileForRange(q, { startDate, endDate });
  return profile ? { poc: profile.poc, vah: profile.vah, val: profile.val } : null;
}

// ─── Get prior business day ────────────────────────────────────────────────
async function priorBusinessDay(date) {
  const r = await q(`
    SELECT MAX(ts::date)::text AS d
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND ts::date < $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [date]);
  return r.rows[0]?.d || null;
}

// ─── Week boundaries (Mon–Fri) containing a date ──────────────────────────
function weekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - daysToMon);
  const fri = new Date(mon); fri.setUTCDate(mon.getUTCDate() + 4);
  return {
    mon: mon.toISOString().slice(0, 10),
    fri: fri.toISOString().slice(0, 10),
  };
}

// ─── Month boundaries ─────────────────────────────────────────────────────
function monthBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return {
    first: first.toISOString().slice(0, 10),
    last:  last.toISOString().slice(0, 10),
  };
}

// ─── 3-month start (approx 63 trading days back) ─────────────────────────
function threeMonthStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 3);
  return d.toISOString().slice(0, 10);
}

// ─── Core: compute all levels for one trading date ────────────────────────
async function computeLevelsForDate(date) {
  const levels = []; // { level_name, price, category }
  const add = (name, price, category) => {
    if (price != null && !isNaN(price)) levels.push({ name, price: +price, category });
  };

  // ── 1. Prior day value area + session stats ──────────────────────────────
  const pdRow = await q(`
    SELECT poc::float, vah::float, val::float,
           session_high::float, session_low::float, session_close::float
    FROM developing_value_log
    WHERE trade_date < $1
    ORDER BY trade_date DESC LIMIT 1
  `, [date]);
  const pd = pdRow.rows[0];
  if (pd) {
    add('PD_VAH',   pd.vah,           'PRIOR_DAY');
    add('PD_VAL',   pd.val,           'PRIOR_DAY');
    add('PD_POC',   pd.poc,           'PRIOR_DAY');
    add('PD_HIGH',        pd.session_high,  'PRIOR_DAY');
    add('PD_LOW',         pd.session_low,   'PRIOR_DAY');
    add('PD_CLOSE',       pd.session_close, 'PRIOR_DAY');
    if (pd.session_high && pd.session_low)
      add('PD_SESSION_MID', (pd.session_high + pd.session_low) / 2, 'PRIOR_DAY');

    // Floor pivots from PD H/L/C
    const h = pd.session_high, l = pd.session_low, c = pd.session_close;
    if (h && l && c) {
      const pivot = (h + l + c) / 3;
      const range = h - l;
      add('FLOOR_PIVOT', Math.round(pivot * 4) / 4, 'PIVOT');
      add('FLOOR_R1', Math.round((2 * pivot - l) * 4) / 4,    'PIVOT');
      add('FLOOR_R2', Math.round((pivot + range) * 4) / 4,    'PIVOT');
      add('FLOOR_R3', Math.round((h + 2 * (pivot - l)) * 4) / 4, 'PIVOT');
      add('FLOOR_S1', Math.round((2 * pivot - h) * 4) / 4,    'PIVOT');
      add('FLOOR_S2', Math.round((pivot - range) * 4) / 4,    'PIVOT');
      add('FLOOR_S3', Math.round((l - 2 * (h - pivot)) * 4) / 4, 'PIVOT');

      // Camarilla pivots from PD H/L/C
      // R3/S3 = primary reversal zones, R4/S4 = breakout levels
      const camRange = (h - l) * 1.1;
      add('CAM_R1', Math.round((c + camRange / 12) * 4) / 4, 'CAMARILLA');
      add('CAM_R2', Math.round((c + camRange / 6)  * 4) / 4, 'CAMARILLA');
      add('CAM_R3', Math.round((c + camRange / 4)  * 4) / 4, 'CAMARILLA');
      add('CAM_R4', Math.round((c + camRange / 2)  * 4) / 4, 'CAMARILLA');
      add('CAM_S1', Math.round((c - camRange / 12) * 4) / 4, 'CAMARILLA');
      add('CAM_S2', Math.round((c - camRange / 6)  * 4) / 4, 'CAMARILLA');
      add('CAM_S3', Math.round((c - camRange / 4)  * 4) / 4, 'CAMARILLA');
      add('CAM_S4', Math.round((c - camRange / 2)  * 4) / 4, 'CAMARILLA');
    }
  }

  // ── 2. Prior day IB ──────────────────────────────────────────────────────
  // Window fixed 2026-07-14: was BETWEEN 570 AND 599 (30min, 9:30-10:00), which didn't match
  // the 60min IB (570-629, 9:30-10:30) live acd.js has used since this codebase's earliest
  // commit (2026-06-01) and docs/daytype_classifier_v2_candidate.md's documented convention
  // ("Initial Balance closes" at 10:30 ET) -- a real definitional mismatch, not just a timing
  // one. See docs/KNOWN_ISSUES.md item 11.
  const priorDay = await priorBusinessDay(date);
  if (priorDay) {
    const pdIbR = await q(`
      SELECT MAX(high)::float AS h, MIN(low)::float AS l
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date = $1
        AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
    `, [priorDay]);
    const pib = pdIbR.rows[0];
    if (pib?.h && pib?.l) {
      add('PD_IB_HIGH', pib.h,                  'PRIOR_DAY');
      add('PD_IB_LOW',  pib.l,                   'PRIOR_DAY');
      add('PD_IB_MID',  (pib.h + pib.l) / 2,    'PRIOR_DAY');
    }
  }

  // ── 3. Overnight high/low (ONH/ONL) ─────────────────────────────────────
  // Globex: 18:00 ET prior day through 09:29 ET current day
  const onR = await q(`
    SELECT MAX(high)::float AS onh, MIN(low)::float AS onl
    FROM price_bars_primary
    WHERE symbol = 'NQ'
      AND (
        -- prior evening: 18:00-23:59
        (ts::date = $2 AND EXTRACT(hour FROM ts) >= 18)
        OR
        -- overnight into current morning: 00:00-09:29
        (ts::date = $1 AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) < 570)
      )
  `, [date, priorDay || date]);
  const on = onR.rows[0];
  add('ONH', on?.onh, 'OVERNIGHT');
  add('ONL', on?.onl, 'OVERNIGHT');

  // ── 4. OR high/low/mid from acd_daily_log ───────────────────────────────
  const orR = await q(`
    SELECT or_high::float AS orh, or_low::float AS orl
    FROM acd_daily_log WHERE trade_date = $1
  `, [date]);
  const or_ = orR.rows[0];
  if (or_?.orh && or_?.orl) {
    add('OR_HIGH', or_.orh,                    'CURRENT');
    add('OR_LOW',  or_.orl,                    'CURRENT');
    add('OR_MID',  (or_.orh + or_.orl) / 2,   'CURRENT');
  }

  // 5-session composite OR: MAX(or_high) / MIN(or_low) across prior 5 sessions
  const or5R = await q(`
    SELECT MAX(orh) AS hi, MIN(orl) AS lo FROM (
      SELECT or_high::float AS orh, or_low::float AS orl
      FROM acd_daily_log WHERE trade_date < $1 AND or_high IS NOT NULL
      ORDER BY trade_date DESC LIMIT 5
    ) t
  `, [date]);
  const or5 = or5R.rows[0];
  if (or5?.hi && or5?.lo) add('5D_OR_MID', (or5.hi + or5.lo) / 2, 'CURRENT');

  // ── 5. IB high/low/mid (9:30–10:30 current day) ──────────────────────────
  // Window fixed 2026-07-14: was BETWEEN 570 AND 599 (30min, 9:30-10:00) -- see the matching
  // note on the prior-day IB block above for the full explanation.
  const ibR = await q(`
    SELECT MAX(high)::float AS h, MIN(low)::float AS l
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 629
  `, [date]);
  const ib = ibR.rows[0];
  if (ib?.h && ib?.l) {
    add('IB_HIGH', ib.h,               'CURRENT');
    add('IB_LOW',  ib.l,               'CURRENT');
    add('IB_MID',  (ib.h + ib.l) / 2, 'CURRENT');
  }

  // 10-session composite IB midpoint
  const ib10R = await q(`
    SELECT AVG((h + l) / 2) AS mid FROM (
      SELECT MAX(high)::float AS h, MIN(low)::float AS l
      FROM price_bars_primary
      WHERE symbol = 'NQ' AND ts::date IN (
        SELECT DISTINCT ts::date FROM price_bars_primary
        WHERE symbol = 'NQ' AND ts::date < $1
          AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 599
        ORDER BY ts::date DESC LIMIT 10
      )
        AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 599
      GROUP BY ts::date
    ) t HAVING COUNT(*) >= 5
  `, [date]);
  if (ib10R.rows[0]?.mid) add('10D_IB_MID', parseFloat(ib10R.rows[0].mid), 'CURRENT');

  // Prior day OR midpoint (from acd_daily_log of prior session)
  const pdOrR = await q(`
    SELECT (or_high::float + or_low::float) / 2 AS mid
    FROM acd_daily_log WHERE trade_date < $1 AND or_high IS NOT NULL
    ORDER BY trade_date DESC LIMIT 1
  `, [date]);
  if (pdOrR.rows[0]?.mid) add('PD_OR_MID', pdOrR.rows[0].mid, 'PRIOR');

  // ── 6. Session opens ─────────────────────────────────────────────────────
  // Daily open (first RTH bar)
  const dailyOpenR = await q(`
    SELECT open::float AS o FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) = 570
    ORDER BY ts LIMIT 1
  `, [date]);
  add('DAILY_OPEN', dailyOpenR.rows[0]?.o, 'OPENS');

  // Weekly open (first RTH bar of the Mon–Fri week)
  const wb = weekBounds(date);
  const weekOpenR = await q(`
    SELECT open::float AS o FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) = 570
    ORDER BY ts LIMIT 1
  `, [wb.mon, wb.fri]);
  add('WEEKLY_OPEN', weekOpenR.rows[0]?.o, 'OPENS');

  // Monthly open (first RTH bar of the calendar month)
  const mb = monthBounds(date);
  const monthOpenR = await q(`
    SELECT open::float AS o FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) = 570
    ORDER BY ts LIMIT 1
  `, [mb.first, mb.last]);
  add('MONTHLY_OPEN', monthOpenR.rows[0]?.o, 'OPENS');

  // ── 7. RTH VWAP (9:30 AM → end of RTH, cumulative for the day) ──────────
  const rthVwapR = await q(`
    SELECT SUM(close::numeric * volume::numeric) / NULLIF(SUM(volume::numeric), 0) AS vwap
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date = $1
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      AND volume > 0
  `, [date]);
  add('RTH_VWAP', rthVwapR.rows[0]?.vwap ? parseFloat(rthVwapR.rows[0].vwap) : null, 'VWAP');

  // Weekly VWAP (Mon open → date, week-to-date as of the date being computed)
  // Fixed 2026-07-14: was `BETWEEN wb.mon AND wb.fri` (the week's Friday, regardless of `date`)
  // -- a genuine lookahead bug for any date before that week's Friday, since it pulled in
  // volume/price data from days that hadn't happened yet relative to `date`. Live acd.js reads
  // lp.WEEKLY_VWAP with no time gate, so in live day-by-day usage this only ever accumulated
  // through "today" anyway (future bars don't exist yet) -- the bug only bit historical
  // re-computation (--backfill), where the full week's data already exists. See
  // docs/KNOWN_ISSUES.md.
  const weekVwapR = await q(`
    SELECT SUM(close::numeric * volume::numeric) / NULLIF(SUM(volume::numeric), 0) AS vwap
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
      AND volume > 0
  `, [wb.mon, date]);
  add('WEEKLY_VWAP', weekVwapR.rows[0]?.vwap ? parseFloat(weekVwapR.rows[0].vwap) : null, 'VWAP');

  // ── 8. Prior week H/L/VA ─────────────────────────────────────────────────
  // Prior week = the Mon–Fri week before the current week
  const pwMon = new Date(wb.mon + 'T12:00:00Z');
  pwMon.setUTCDate(pwMon.getUTCDate() - 7);
  const pwFri = new Date(wb.fri + 'T12:00:00Z');
  pwFri.setUTCDate(pwFri.getUTCDate() - 7);
  const pwMonStr = pwMon.toISOString().slice(0, 10);
  const pwFriStr = pwFri.toISOString().slice(0, 10);

  const pwHlR = await q(`
    SELECT MAX(high)::float AS h, MIN(low)::float AS l
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [pwMonStr, pwFriStr]);
  const pwH = pwHlR.rows[0]?.h;
  const pwL = pwHlR.rows[0]?.l;
  add('PW_HIGH', pwH, 'WEEKLY');
  add('PW_LOW',  pwL, 'WEEKLY');
  if (pwH != null && pwL != null) add('PW_MID', (pwH + pwL) / 2, 'WEEKLY');

  const pwVA = await computeValueArea(pwMonStr, pwFriStr);
  if (pwVA) {
    add('PW_VAH', pwVA.vah, 'WEEKLY');
    add('PW_VAL', pwVA.val, 'WEEKLY');
    add('PW_POC', pwVA.poc, 'WEEKLY');
  }

  // Weekly floor pivots (PP/R1/R2/S1/S2 using prior-week H/L/close)
  const pwCloseR = await q(`
    SELECT close::float AS c FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts DESC LIMIT 1
  `, [pwMonStr, pwFriStr]);
  const pwC = pwCloseR.rows[0]?.c;
  if (pwH && pwL && pwC) {
    const wPP = (pwH + pwL + pwC) / 3;
    const wRange = pwH - pwL;
    add('WPP', Math.round(wPP * 4) / 4,                    'WEEKLY_PIVOT');
    add('WR1', Math.round((2 * wPP - pwL) * 4) / 4,        'WEEKLY_PIVOT');
    add('WR2', Math.round((wPP + wRange) * 4) / 4,         'WEEKLY_PIVOT');
    add('WS1', Math.round((2 * wPP - pwH) * 4) / 4,        'WEEKLY_PIVOT');
    add('WS2', Math.round((wPP - wRange) * 4) / 4,         'WEEKLY_PIVOT');
  }

  // ── 9. Prior month H/L/VA ────────────────────────────────────────────────
  const pmD = new Date(date + 'T12:00:00Z');
  pmD.setUTCMonth(pmD.getUTCMonth() - 1);
  const pmBounds = monthBounds(pmD.toISOString().slice(0, 10));

  const pmHlR = await q(`
    SELECT MAX(high)::float AS h, MIN(low)::float AS l
    FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
  `, [pmBounds.first, pmBounds.last]);
  const pmH = pmHlR.rows[0]?.h;
  const pmL = pmHlR.rows[0]?.l;
  add('PM_HIGH', pmH, 'MONTHLY');
  add('PM_LOW',  pmL, 'MONTHLY');

  const pmVA = await computeValueArea(pmBounds.first, pmBounds.last);
  if (pmVA) {
    add('PM_VAH', pmVA.vah, 'MONTHLY');
    add('PM_VAL', pmVA.val, 'MONTHLY');
    add('PM_POC', pmVA.poc, 'MONTHLY');
  }

  // Monthly floor pivots (PP/R1/R2/S1/S2 using prior-month H/L/close)
  const pmCloseR = await q(`
    SELECT close::float AS c FROM price_bars_primary
    WHERE symbol = 'NQ' AND ts::date BETWEEN $1 AND $2
      AND EXTRACT(hour FROM ts) * 60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ORDER BY ts DESC LIMIT 1
  `, [pmBounds.first, pmBounds.last]);
  const pmC = pmCloseR.rows[0]?.c;
  if (pmH && pmL && pmC) {
    const mPP = (pmH + pmL + pmC) / 3;
    const mRange = pmH - pmL;
    add('MPP', Math.round(mPP * 4) / 4,                    'MONTHLY_PIVOT');
    add('MR1', Math.round((2 * mPP - pmL) * 4) / 4,        'MONTHLY_PIVOT');
    add('MR2', Math.round((mPP + mRange) * 4) / 4,         'MONTHLY_PIVOT');
    add('MS1', Math.round((2 * mPP - pmH) * 4) / 4,        'MONTHLY_PIVOT');
    add('MS2', Math.round((mPP - mRange) * 4) / 4,         'MONTHLY_PIVOT');
  }

  // ── 10. 3-month VA ───────────────────────────────────────────────────────
  const m3Start = threeMonthStart(date);
  const m3VA = await computeValueArea(m3Start, date);
  if (m3VA) {
    add('3M_VAH', m3VA.vah, 'QUARTERLY');
    add('3M_VAL', m3VA.val, 'QUARTERLY');
    add('3M_POC', m3VA.poc, 'QUARTERLY');
  }

  return levels;
}

// ─── Write levels to DB ────────────────────────────────────────────────────
async function writeLevels(date, levels) {
  if (!levels.length) return;
  const values = levels.map((l, i) =>
    `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4}, NOW())`
  ).join(', ');
  const params = [date, ...levels.flatMap(l => [l.name, l.price, l.category])];
  await q(`
    INSERT INTO level_prices (trade_date, level_name, price, category, computed_at)
    VALUES ${values}
    ON CONFLICT (trade_date, level_name) DO UPDATE
      SET price = EXCLUDED.price, category = EXCLUDED.category, computed_at = NOW()
  `, params);
}

// ─── Main ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isBackfill = args.includes('--backfill');
const fromIdx = args.indexOf('--from');
const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;

if (isBackfill) {
  // Get all trading dates from developing_value_log
  const datesR = await q(`
    SELECT trade_date::text AS d FROM developing_value_log
    WHERE ($1::date IS NULL OR trade_date >= $1::date)
    ORDER BY trade_date
  `, [fromDate]);
  const dates = datesR.rows.map(r => r.d.slice(0, 10));
  console.log(`Backfilling ${dates.length} dates from ${dates[0]} to ${dates[dates.length - 1]}`);

  let done = 0;
  for (const date of dates) {
    try {
      const levels = await computeLevelsForDate(date);
      await writeLevels(date, levels);
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${dates.length} (${date})`);
    } catch (e) {
      console.error(`  ERROR ${date}: ${e.message}`);
    }
  }
  console.log(`Done. ${done} dates processed.`);
} else {
  // Single date
  const date = args[0] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log(`Computing levels for ${date}...`);
  const levels = await computeLevelsForDate(date);
  await writeLevels(date, levels);
  console.log(`Wrote ${levels.length} levels:`);
  levels.forEach(l => console.log(`  ${l.name.padEnd(16)} ${l.price}  [${l.category}]`));
}

await pool.end();
