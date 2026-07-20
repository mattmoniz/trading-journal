// Canonical way to persist a research/exploratory finding as a durable, re-checkable
// row in performance_audit (signal_type='RESEARCH_CLAIM') instead of letting it live
// only as prose in docs/OPEN_THREADS.md or a scratch file, where it has no lifecycle
// and nothing ever re-verifies it. Built 2026-07-16 per an Opus consultation on making
// this codebase's "system learning" persist across sessions instead of evaporating.
//
// This complements, not replaces, the existing calibration-tier tables (SETUP_STATUS,
// OPTIMAL_STOP, DAY_TYPE_ALPHA, CONTEXT_ANALYSIS, VOL_REGIME_HIST, etc.) — those already
// have their own lifecycle. RESEARCH_CLAIM is for everything else: exploratory findings
// (day-of-week effects, retracement stats, library comparisons) that are real and
// N-backed but don't fit any existing signal_type.
//
// Usage:
//   import { recordClaim } from './record_claim.mjs'; await recordClaim({ ... });
//   node scripts/record_claim.mjs --list                 (show all claims + staleness)
//   node scripts/record_claim.mjs --add '<json matching recordClaim args>'
import { query } from '../server/db.js';

const RECHECK_INTERVAL_DAYS = 30;

export async function recordClaim({
  slug, claimText, sourceFile, sourceDate = null, sampleSize = null,
  winRate = null, evPerTrade = null, rigorStatus = 'not_checked', status = 'PROVISIONAL',
}) {
  if (!slug || !claimText || !sourceFile) {
    throw new Error('recordClaim requires slug, claimText, sourceFile');
  }
  // signal_name is VARCHAR(60) -- fail fast with a clear message rather than a raw
  // "value too long for type character varying(60)" from Postgres, and rather than
  // silently truncating (two distinct 61+ char slugs could collide on the same prefix).
  if (slug.length > 60) {
    throw new Error(`recordClaim: slug '${slug}' is ${slug.length} chars, signal_name column is VARCHAR(60) -- shorten it`);
  }
  const { rows } = await query(`SELECT CURRENT_DATE::text as today, (CURRENT_DATE + INTERVAL '${RECHECK_INTERVAL_DAYS} days')::date::text as next_recheck`);
  const { today, next_recheck } = rows[0];
  const notes = JSON.stringify({
    claim_text: claimText, source_file: sourceFile, source_date: sourceDate,
    rigor_status: rigorStatus, status, last_verified_date: today, next_recheck_due: next_recheck,
  });
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, sample_size, win_rate, ev_per_trade, notes)
    VALUES ($1, 0, 'RESEARCH_CLAIM', $2, $3, $4, $5, $6)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET sample_size = EXCLUDED.sample_size, win_rate = EXCLUDED.win_rate,
          ev_per_trade = EXCLUDED.ev_per_trade, notes = EXCLUDED.notes
  `, [today, slug, sampleSize, winRate, evPerTrade, notes]);
  return { slug, today, next_recheck };
}

export async function listClaims() {
  const { rows } = await query(`
    SELECT signal_name as slug, sample_size, win_rate, ev_per_trade, notes, run_date
    FROM performance_audit
    WHERE signal_type = 'RESEARCH_CLAIM'
      AND run_date = (SELECT MAX(run_date) FROM performance_audit p2 WHERE p2.signal_type='RESEARCH_CLAIM' AND p2.signal_name = performance_audit.signal_name)
    ORDER BY run_date DESC
  `);
  return rows.map(r => ({ ...r, notes: JSON.parse(r.notes) }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    const claims = await listClaims();
    const { rows } = await query(`SELECT CURRENT_DATE::text as d`);
    const today = rows[0].d;
    for (const c of claims) {
      const overdue = c.notes.next_recheck_due && c.notes.next_recheck_due < today;
      console.log(`[${c.notes.status}${overdue ? ' — OVERDUE FOR RECHECK' : ''}] ${c.slug}`);
      console.log(`  ${c.notes.claim_text}`);
      console.log(`  N=${c.sample_size ?? '?'} WR=${c.win_rate ?? '?'} EV=${c.ev_per_trade ?? '?'} rigor=${c.notes.rigor_status} source=${c.notes.source_file} next_recheck=${c.notes.next_recheck_due}`);
      console.log('');
    }
    console.log(`${claims.length} claims total.`);
  } else if (args[0] === '--add') {
    const payload = JSON.parse(args[1]);
    const result = await recordClaim(payload);
    console.log('Recorded:', result);
  } else {
    console.log('Usage: node scripts/record_claim.mjs --list | --add \'<json>\'');
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
