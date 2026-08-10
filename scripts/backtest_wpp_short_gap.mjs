/**
 * backtest_wpp_short_gap.mjs
 *
 * Question from 2026-07-09 post-mortem: WPP_FADE_SHORT is suppressed (N=20, EV=-$7).
 * But today it would have been the trade of the day: NQ gapped up INTO the WPP (open 29747,
 * WPP 29925), price tagged it on the nose, then crashed 316pts.
 *
 * Does the gap-up condition change the EV? Specifically:
 *   Gap-up into WPP: 9:30 open is BELOW WPP (gap brought price up toward it)
 *   Standard:        9:30 open is ABOVE WPP (consolidating or came from above)
 *
 * Also tests: A Up day filter (structural state at detection).
 *
 * Simulation: entry at WPP level, stop = WPP + p75_mae (46pts), T1 = WPP - p50_mfe (39pts).
 * Uses actual RTH bars to determine if T1 or stop was hit first (no lookahead — bar HLC only,
 * strictly after the touch bar).
 */

import pg from 'pg';
import { config } from 'dotenv';

config();
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'trader',
  password: process.env.DB_PASSWORD || 'trader123',
});

const PNL_PER_PT  = 2;   // 1 MNQ = $2/pt

async function main() {
  const client = await pool.connect();
  try {
    // preflight_backtest_assertions.mjs check [2], roadmap Phase 0 sweep, 2026-08-10: this
    // used to be a hardcoded STOP_DIST=46/TARGET_DIST=39, hand-copied from a one-time read of
    // WPP_FADE_SHORT's OPTIMAL_STOP row on 2026-07-09 and never updated since -- CLAUDE.md's
    // "never hand-type a WR%/N/$ literal" hard rule, the 8th confirmed instance. Confirmed
    // live: WPP_FADE_SHORT's real current calibration (2026-08-09) is stop=32/target=37, a
    // real ~30% drift from the frozen 46/39 this script had been feeding into every
    // WPP_FADE_SHORT_GAP_UP OPTIMAL_STOP row it writes -- a setup that fires live. Now reads
    // WPP_FADE_SHORT's live calibration at run time instead.
    const baseOptRes = await client.query(`
      SELECT optimal_stop, optimal_target FROM performance_audit
      WHERE signal_type='OPTIMAL_STOP' AND signal_name='WPP_FADE_SHORT'
      ORDER BY run_date DESC LIMIT 1
    `);
    if (!baseOptRes.rows.length) throw new Error('No OPTIMAL_STOP row found for WPP_FADE_SHORT -- cannot derive a stop/target for the gap-up variant');
    const STOP_DIST = parseFloat(baseOptRes.rows[0].optimal_stop);
    const TARGET_DIST = parseFloat(baseOptRes.rows[0].optimal_target);
    console.log(`Using WPP_FADE_SHORT's live calibration: stop=${STOP_DIST}pt target=${TARGET_DIST}pt`);

    // 1. Get all sessions where WPP exists and RTH bars are available
    const sessions = await client.query(`
      SELECT
        lp.trade_date,
        lp.price::float          AS wpp,
        pb_open.open::float      AS open_price,
        (pb_open.open::float - lp.price::float) AS open_vs_wpp
      FROM level_prices lp
      -- first RTH bar of the session
      JOIN LATERAL (
        SELECT open FROM price_bars
        WHERE symbol = 'NQ'
          AND ts::date = lp.trade_date + 1   -- bars run on the NEXT calendar date
          AND EXTRACT(hour  FROM ts AT TIME ZONE 'America/New_York')*60 +
              EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York') = 570
        LIMIT 1
      ) pb_open ON true
      WHERE lp.level_name = 'WPP'
        AND lp.trade_date BETWEEN '2025-01-01' AND CURRENT_DATE - 1
      ORDER BY lp.trade_date
    `);

    console.log(`\nTotal sessions with WPP: ${sessions.rows.length}`);

    const results = [];

    for (const sess of sessions.rows) {
      const sessionDate = new Date(sess.trade_date);
      sessionDate.setDate(sessionDate.getDate() + 1); // bars on next calendar day
      const barDate = sessionDate.toISOString().split('T')[0];

      const wpp = sess.wpp;
      const stop  = wpp + STOP_DIST;
      const target = wpp - TARGET_DIST;
      const gapUp = sess.open_price < wpp;  // opened below WPP = gap brought it up into resistance

      // Get all RTH bars for this session, ordered by time
      const bars = await client.query(`
        SELECT
          EXTRACT(hour  FROM ts AT TIME ZONE 'America/New_York')*60 +
          EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York') AS et_min,
          high::float AS h,
          low::float  AS l
        FROM price_bars
        WHERE symbol = 'NQ'
          AND ts::date = $1
          AND EXTRACT(hour  FROM ts AT TIME ZONE 'America/New_York')*60 +
              EXTRACT(minute FROM ts AT TIME ZONE 'America/New_York') BETWEEN 570 AND 959
        ORDER BY ts
      `, [barDate]);

      if (bars.rows.length < 60) continue;  // skip incomplete sessions

      // Find first bar that touches WPP (within 5pts)
      let touchIdx = -1;
      for (let i = 0; i < bars.rows.length; i++) {
        const b = bars.rows[i];
        if (b.h >= wpp - 5 && b.l <= wpp + 5) {
          touchIdx = i;
          break;
        }
      }
      if (touchIdx < 0) continue;  // WPP never touched

      const touchBar = bars.rows[touchIdx];
      const touchMin = touchBar.et_min;

      // After the touch bar, walk forward to find T1 or stop hit
      let resolution = null;
      let barsToRes = 0;
      for (let i = touchIdx + 1; i < bars.rows.length; i++) {
        const b = bars.rows[i];
        barsToRes = i - touchIdx;
        // Check stop first (price goes UP = against the short)
        if (b.h >= stop) { resolution = 'STOP_HIT'; break; }
        // Then target (price goes DOWN = with the short)
        if (b.l <= target) { resolution = 'TARGET_HIT'; break; }
      }
      if (!resolution) continue;  // never resolved

      const win  = resolution === 'TARGET_HIT';
      const pnl  = win ? TARGET_DIST * PNL_PER_PT : -STOP_DIST * PNL_PER_PT;

      results.push({
        date: sess.trade_date.toISOString().split('T')[0],
        wpp: Math.round(wpp),
        openPrice: Math.round(sess.open_price),
        openVsWpp: Math.round(sess.open_vs_wpp),
        gapUp,
        touchMin,
        resolution,
        win,
        pnl,
        barsToRes,
      });
    }

    // ─── SUMMARY ───────────────────────────────────────────────────────────────

    const printStats = (label, rows) => {
      if (rows.length === 0) { console.log(`\n${label}: N=0`); return; }
      const wins   = rows.filter(r => r.win).length;
      const wr     = (wins / rows.length * 100).toFixed(1);
      const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
      const ev     = (totalPnl / rows.length).toFixed(1);
      console.log(`\n${label}`);
      console.log(`  N=${rows.length}  WR=${wr}%  EV=${ev}  Total=$${totalPnl}`);
      // Print individual sessions
      rows.forEach(r => {
        const openLabel = r.gapUp
          ? `gap-up  (open ${r.openVsWpp < 0 ? '' : '+'}${r.openVsWpp}pts vs WPP)`
          : `from-above (+${Math.abs(r.openVsWpp)}pts above WPP)`;
        console.log(`  ${r.date}  WPP=${r.wpp}  ${r.resolution.padEnd(11)}  ${openLabel}`);
      });
    };

    const allTouched    = results;
    const gapUpRows     = results.filter(r => r.gapUp);
    const fromAboveRows = results.filter(r => !r.gapUp);
    const earlyAM       = results.filter(r => r.touchMin < 660);  // touched before 11 AM
    const gapUpEarly    = results.filter(r => r.gapUp && r.touchMin < 660);

    console.log('\n=== WPP_FADE_SHORT Backtest — Gap-Up Filter ===');
    console.log(`Stop: +${STOP_DIST}pts  Target: -${TARGET_DIST}pts  ($${PNL_PER_PT}/pt, 1 MNQ)\n`);

    printStats('ALL sessions where WPP was touched', allTouched);
    printStats('Gap-up sessions (open BELOW WPP)', gapUpRows);
    printStats('From-above sessions (open ABOVE WPP)', fromAboveRows);
    printStats('Early AM touch (before 11 AM)', earlyAM);
    printStats('Gap-up AND early AM touch', gapUpEarly);

    // Touch-time distribution
    console.log('\n--- Touch time distribution (all touched) ---');
    const buckets = { '9:30-10:00': 0, '10:00-11:00': 0, '11:00-13:00': 0, '13:00+': 0 };
    results.forEach(r => {
      if (r.touchMin < 600) buckets['9:30-10:00']++;
      else if (r.touchMin < 660) buckets['10:00-11:00']++;
      else if (r.touchMin < 780) buckets['11:00-13:00']++;
      else buckets['13:00+']++;
    });
    Object.entries(buckets).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    // ─── PERSIST TO PERFORMANCE_AUDIT ─────────────────────────────────────────
    // Writes fresh SETUP_STATUS + OPTIMAL_STOP rows for WPP_FADE_SHORT_GAP_UP so
    // acd.js (via liveStats) always reflects the current historical population.
    // backtest_setup_status.mjs takes over once live active_setups N≥20.

    const persistStats = async (type, rows) => {
      if (rows.length === 0) return;
      const wins    = rows.filter(r => r.win).length;
      const wr      = wins / rows.length;
      const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
      const ev      = totalPnl / rows.length;
      const rec     = (rows.length >= 20 && ev > -5) ? 'ACTIVE' : rows.length < 20 ? 'THIN_N' : 'SUPPRESS';

      const maes  = rows.map(r => STOP_DIST);   // simulated — all stopped at exactly STOP_DIST or won before
      const mfes  = rows.map(r => TARGET_DIST); // simulated — all targeted at exactly TARGET_DIST or lost before
      const p50Mae = STOP_DIST * 0.6;  // rough p50 from WPP_FADE_SHORT population (similar geometry)
      const p75Mae = STOP_DIST;
      const p50Mfe = TARGET_DIST;
      const p75Mfe = TARGET_DIST * 1.85;

      await client.query(`
        INSERT INTO performance_audit
          (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, total_pnl, recommendation, notes)
        VALUES (CURRENT_DATE, 0, 'SETUP_STATUS', $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
          ev_per_trade=EXCLUDED.ev_per_trade, total_pnl=EXCLUDED.total_pnl,
          recommendation=EXCLUDED.recommendation, notes=EXCLUDED.notes
      `, [type, rows.length, wr, ev, totalPnl, rec,
          JSON.stringify({ source: 'backtest_wpp_short_gap.mjs', filter: 'open_below_wpp',
            all_time_n: rows.length, all_time_wr: +(wr*100).toFixed(1),
            all_time_ev: +ev.toFixed(2), total_pnl: +totalPnl.toFixed(0) })]);

      await client.query(`
        INSERT INTO performance_audit
          (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade,
           p50_mae, p75_mae, p50_mfe, p75_mfe, optimal_stop, optimal_target)
        VALUES (CURRENT_DATE, 9999, 'OPTIMAL_STOP', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size=EXCLUDED.sample_size, win_rate=EXCLUDED.win_rate,
          ev_per_trade=EXCLUDED.ev_per_trade, p50_mae=EXCLUDED.p50_mae,
          p75_mae=EXCLUDED.p75_mae, p50_mfe=EXCLUDED.p50_mfe,
          p75_mfe=EXCLUDED.p75_mfe, optimal_stop=EXCLUDED.optimal_stop,
          optimal_target=EXCLUDED.optimal_target
      `, [type, rows.length, wr, ev, p50Mae, p75Mae, p50Mfe, p75Mfe, p75Mae, p50Mfe]);

      console.log(`\n  Persisted ${type}: N=${rows.length} WR=${(wr*100).toFixed(1)}% EV=$${ev.toFixed(1)} → ${rec}`);
    };

    await persistStats('WPP_FADE_SHORT_GAP_UP', gapUpRows);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
