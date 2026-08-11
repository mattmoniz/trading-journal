/**
 * Correlation monitor — roster-rebuild roadmap Phase 8, I5 (2026-08-11).
 * scratch/MASTER_OPUS_ROSTER_REBUILD_ROADMAP.md Part 4 I5 / Part 6.5 / Part 9.
 *
 * "This is the mechanism that prevents silently rebuilding a one-bet book. It is also how
 * you verify that B, C, D, E are actually diversifying rather than repackaging." Stage 4's
 * own gate requires "correlation checked against every existing live type — must be under
 * 0.6" before any bet_class can go live at real capital.
 *
 * CADENCE — Part 4's own I5 line says "Daily job"; Part 6.5's cadence table says
 * "Weekly | Correlation matrix". These two lines of the SAME document disagree. Resolved
 * WEEKLY (run_weekly_backtests.sh), matching Part 6.5's authoritative table and the same
 * reasoning already used and accepted for scripts/backtest_bet_class_status.mjs: real N
 * (especially per-pair OVERLAP n, see below) grows far too slowly for daily runs to add
 * anything over weekly. DeepSeek design-critique confirmed this reading before this script
 * was written (scratch/deepseek_response.md, 2026-08-11).
 *
 * METHODOLOGY — DeepSeek's design critique (same file) found the originally-planned
 * approach (0-fill every calendar day, gate on each side's own real_n>=20) was WRONG in a
 * way that would have produced actively misleading numbers: zero-filling non-trading days
 * INFLATES apparent correlation between two sparse-firing types, because shared "both
 * didn't fire" days dominate the covariance/variance for any low-frequency pair — the
 * opposite of what a diversification monitor should report. Fixed per that critique:
 *
 *   - Correlation is computed ONLY over days where BOTH series had >=1 resolved real trade
 *     (no 0-fill at all) — "when they both fire, do they move together?", which is the
 *     actual diversification question, not "do they both mostly not fire on the same days."
 *   - The gate is on OVERLAP_N (days with a real trade on both sides), not each side's own
 *     solo real_n — two N=500 types that only ever overlap on 4 days give a meaningless r
 *     regardless of how large each side's total is. OVERLAP_MIN_N=20 matches this
 *     codebase's standing N>=20 hard floor.
 *   - This also sidesteps the "missing week = system outage, not a flat P&L day" risk
 *     DeepSeek separately flagged (issue 3) — with no 0-fill, an outage week simply
 *     contributes zero rows to either series, exactly as it should.
 *
 * SCOPE — two independent matrices, matching the roadmap's "per-type (and per-bet_class)":
 *   - bet_class-level: all BET_CLASSES except UNCLASSIFIED (5 classes as of 2026-08-11).
 *     FAILED_SWEEP_REVERSAL/OPENING_DRIVE_15MIN are SHADOW-only with zero real fires as of
 *     this build — they will report too_thin_overlap for every pair until real data
 *     accumulates, which is correct, not a bug to silence.
 *   - setup_type-level: restricted to the individual setup_types currently NOT
 *     SUPPRESS/THIN_N per the latest SETUP_STATUS row (21 as of 2026-08-11) — the full
 *     ~180-type universe would reproduce the exact N-fragmentation problem this whole
 *     rebuild exists to fix, just at the correlation-matrix layer instead of the
 *     calibration layer. This population is a live query result, not a static registry —
 *     it WILL drift week to week as SETUP_STATUS promotes/suppresses types, so the exact
 *     contributing type list is persisted in each run's `notes` JSON (DeepSeek issue 5) so
 *     a future reader can tell whether a week-over-week r change is real or a population
 *     artifact.
 *
 * Both matrices use separate signal_type values (DeepSeek issue 4 — a shared signal_type
 * risked an ON CONFLICT collision between a bet_class pair and a setup_type pair that
 * happened to produce the same signal_name string).
 *
 * POPULATION FILTER — same real-trade filter as backtest_bet_class_status.mjs
 * (origin_status IN ('ACTIVE','SHADOW'), resolution IN ('TARGET_HIT','STOP_HIT',
 * 'TIME_EXPIRED'), actual_pnl IS NOT NULL) PLUS an explicit exclusion of
 * resolution_method IN ('MARK_TO_MARKET','RECOVERY_MTM') — roadmap Part 7 failure mode #9
 * ("Unbounded MTM... N=101 spanning -$1,799 to +$1,958... Exclude or flag in every pooled
 * number"). A correlation coefficient is far more outlier-sensitive than a mean EV, so this
 * script applies the exclusion explicitly rather than inheriting bet_class_status.mjs's own
 * (pre-existing, out of this script's scope) gap on that specific filter.
 *
 * ALERTING — any pair with overlap_N >= OVERLAP_MIN_N and |r| > ALERT_THRESHOLD (0.6, the
 * roadmap's own Stage 4 ceiling) appends a line to scratch/gemini_alerts.txt, same format
 * convention as scripts/audit_setup_latency.mjs. Alert-only — does not suppress, resize, or
 * gate anything live (Part 6.5: "Weekly | Correlation matrix | ... | Alert only | Flags
 * redundant bets").
 *
 * Writes signal_type='CORRELATION_MONITOR_BET_CLASS' / 'CORRELATION_MONITOR_SETUP_TYPE'
 * rows to performance_audit, one per pair, signal_name='<A>|<B>' via pairSignalName()
 * (alphabetically ordered so a pair is never double-counted under both orderings; shortened
 * + hash-disambiguated when the plain join would exceed the VARCHAR(60) column -- see that
 * function's own comment).
 *
 * Run:  node scripts/monitor_bet_correlation.mjs
 * Cron: weekly (run_weekly_backtests.sh), after backtest_bet_class_status.mjs.
 */

import { query } from '../server/db.js';
import pool from '../server/db.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { BET_CLASSES } from '../server/config/setupTypes.js';

const OVERLAP_MIN_N = 20;
const ALERT_THRESHOLD = 0.6;
const ALERTS_FILE = path.resolve('scratch/gemini_alerts.txt');

const REAL_TRADE_FILTER = `
  resolution IN ('TARGET_HIT','STOP_HIT','TIME_EXPIRED')
  AND actual_pnl IS NOT NULL
  AND origin_status IN ('ACTIVE','SHADOW')
  AND (resolution_method IS NULL OR resolution_method NOT IN ('MARK_TO_MARKET','RECOVERY_MTM'))
`;

function nowET() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).replace(',', '');
}

// Pearson correlation over paired (x[i], y[i]) values -- no external stats lib, this
// codebase's own convention (see rigorDiagnostics.js) is to hand-roll small, auditable math
// rather than pull in a dependency for a one-function need.
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null; // one series is constant -- correlation undefined, not 0
  return num / Math.sqrt(dx2 * dy2);
}

// signal_name is VARCHAR(60). Worst-case real pair ("MOMENTUM_60m_60m_BALANCE_FADE" vs
// "OR_MID_AFTER_IB_FADE_SHORT") already produces a 61-char name with a plain "A__vs__B"
// join -- confirmed by direct computation over the live 21-type roster, not a hypothetical.
// A silent .slice(0,60) truncation risks two DIFFERENT long pairs colliding on the same
// truncated prefix and overwriting each other's row (same collision class CLAUDE.md's
// record_claim.mjs slug guard exists to prevent) -- but unlike that guard, these names are
// machine-generated from a fixed live-type list, not human-authored, so a deterministic
// shorten-and-disambiguate is the right fix here rather than a hard fail.
function pairSignalName(a, b) {
  const [x, y] = [a, b].sort();
  const full = `${x}|${y}`;
  if (full.length <= 60) return full;
  const hash = crypto.createHash('md5').update(full).digest('hex').slice(0, 6);
  const budget = 60 - 1 - hash.length; // -1 for the '#' before the hash
  const half = Math.floor((budget - 1) / 2); // -1 for the '|' separator between halves
  return `${x.slice(0, half)}|${y.slice(0, half)}#${hash}`.slice(0, 60);
}

// Given two Map<date, pnl>, return { overlapN, r } computed ONLY on days both fired.
function correlateSeries(mapA, mapB) {
  const xs = [], ys = [];
  for (const [date, pnlA] of mapA) {
    if (mapB.has(date)) {
      xs.push(pnlA);
      ys.push(mapB.get(date));
    }
  }
  const overlapN = xs.length;
  if (overlapN < OVERLAP_MIN_N) return { overlapN, r: null, tooThin: true };
  return { overlapN, r: pearson(xs, ys), tooThin: false };
}

async function buildDailyPnlSeries(groupCol, whereExtra = '', params = []) {
  const { rows } = await query(`
    SELECT ${groupCol} AS grp, trade_date::text AS date, SUM(actual_pnl)::float AS pnl
    FROM active_setups
    WHERE ${REAL_TRADE_FILTER} ${whereExtra}
    GROUP BY ${groupCol}, trade_date
  `, params);
  const byGroup = new Map();
  for (const r of rows) {
    if (!r.grp) continue;
    if (!byGroup.has(r.grp)) byGroup.set(r.grp, new Map());
    byGroup.get(r.grp).set(r.date, r.pnl);
  }
  return byGroup;
}

async function runMatrix({ signalType, seriesByGroup, groups, today, alertLines }) {
  console.log(`\n[monitor_bet_correlation] ${signalType} — ${groups.length} group(s): ${groups.join(', ')}`);
  const pairResults = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      const mapA = seriesByGroup.get(a) || new Map();
      const mapB = seriesByGroup.get(b) || new Map();
      const { overlapN, r, tooThin } = correlateSeries(mapA, mapB);
      const signalName = pairSignalName(a, b);
      const label = tooThin
        ? `overlap_N=${overlapN} < ${OVERLAP_MIN_N} -- too thin to trust`
        : `overlap_N=${overlapN}  r=${r === null ? 'undefined (constant series)' : r.toFixed(3)}`;
      console.log(`  ${a} vs ${b}: ${label}`);

      const notes = {
        // Full, untruncated names -- signal_name itself may be a shortened+hashed form
        // (pairSignalName()) when the plain "A|B" join exceeds VARCHAR(60).
        a, b,
        overlapN,
        tooThin,
        r: r === null ? null : +r.toFixed(4),
        aTotalDays: mapA.size,
        bTotalDays: mapB.size,
        groupAtRunTime: groups,
      };
      await query(`
        INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, ev_per_trade, recommendation, notes)
        VALUES ($1, 0, $2, $3, $4, $5, 'ANALYSIS_ONLY', $6)
        ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE SET
          sample_size=$4, ev_per_trade=$5, recommendation='ANALYSIS_ONLY', notes=$6
      `, [today, signalType, signalName, overlapN, r, JSON.stringify(notes)]);

      pairResults.push({ a, b, overlapN, r, tooThin });
      if (!tooThin && r !== null && Math.abs(r) > ALERT_THRESHOLD) {
        alertLines.push(`[${nowET()} ET] [CORRELATION_ALERT] ${signalType}: ${a} vs ${b} r=${r.toFixed(3)} (overlap_N=${overlapN}) exceeds the roadmap's 0.6 Stage-4 ceiling\n`);
      }
    }
  }
  return pairResults;
}

async function run() {
  const { rows: [{ today }] } = await query(`SELECT CURRENT_DATE::text as today`);
  const alertLines = [];

  // ── bet_class matrix ──────────────────────────────────────────────────────────────
  const betClasses = BET_CLASSES.filter(c => c !== 'UNCLASSIFIED');
  const betClassSeries = await buildDailyPnlSeries('bet_class', "AND bet_class IS NOT NULL AND bet_class != 'UNCLASSIFIED'");
  await runMatrix({
    signalType: 'CORRELATION_MONITOR_BET_CLASS',
    seriesByGroup: betClassSeries,
    groups: betClasses,
    today,
    alertLines,
  });

  // ── setup_type matrix, restricted to currently-live (non-SUPPRESS/THIN_N) types ────
  const liveTypesQ = await query(`
    SELECT DISTINCT ON (signal_name) signal_name, recommendation
    FROM performance_audit
    WHERE signal_type = 'SETUP_STATUS'
    ORDER BY signal_name, run_date DESC
  `);
  const liveTypes = liveTypesQ.rows
    .filter(r => !['SUPPRESS', 'THIN_N'].includes(r.recommendation))
    .map(r => r.signal_name);

  if (liveTypes.length < 2) {
    console.log(`\n[monitor_bet_correlation] only ${liveTypes.length} live setup_type(s) -- skipping setup_type matrix`);
  } else {
    const setupTypeSeries = await buildDailyPnlSeries(
      'setup_type',
      `AND setup_type = ANY($1)`,
      [liveTypes],
    );
    await runMatrix({
      signalType: 'CORRELATION_MONITOR_SETUP_TYPE',
      seriesByGroup: setupTypeSeries,
      groups: liveTypes,
      today,
      alertLines,
    });
  }

  if (alertLines.length > 0) {
    fs.appendFileSync(ALERTS_FILE, alertLines.join(''));
    console.log(`\n⚠ ${alertLines.length} correlation alert(s) written to scratch/gemini_alerts.txt`);
    alertLines.forEach(l => console.log(l.trim()));
  } else {
    console.log(`\n[monitor_bet_correlation] no pair exceeded r=${ALERT_THRESHOLD} with overlap_N>=${OVERLAP_MIN_N}`);
  }

  console.log(`\n[monitor_bet_correlation] done`);
  await pool.end();
}

run().catch(e => { console.error('[monitor_bet_correlation] ERROR:', e.message); process.exit(1); });
