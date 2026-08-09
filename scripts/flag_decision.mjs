// Canonical way to persist a pending PRODUCT/ARCHITECTURE DECISION as a durable,
// actively-monitored row in performance_audit (signal_type='OPEN_DECISION') instead of
// letting it live only as prose in docs/OPEN_THREADS.md, where nothing resurfaces it and
// it can sit unresolved indefinitely without anyone noticing. Built 2026-07-17 per user
// request: "anything that needs to be reevaluated should [be] flagged with something and
// actively monitored. Nothing can be buried."
//
// Deliberately a SEPARATE signal_type from RESEARCH_CLAIM (scripts/record_claim.mjs),
// not the same table rows with a different label -- the two are semantically different:
// - RESEARCH_CLAIM: a tested finding with a real N/WR/EV that might go STALE and need
//   re-verification against fresh data. Vocabulary: CONFIRMED / PROVISIONAL / STALE.
// - OPEN_DECISION: a choice awaiting human input (wire in or delete this feature? merge
//   this branch? change this cadence?) with no statistical content and no "staleness" --
//   it just sits PENDING until someone actually decides, then RESOLVED. Jamming these into
//   RESEARCH_CLAIM's rows/vocabulary would make --list a confusing mix of "here's a number
//   that might have drifted" and "here's a yes/no someone needs to answer."
// Same underlying mechanism reused deliberately (performance_audit table, JSON notes
// shape, session-start hook integration, ON CONFLICT upsert-by-day pattern) rather than
// building a parallel table/file -- this codebase already has a documented anti-pattern
// of ad hoc tables with no catalog (see docs/DB_BACKUP_CATALOG.md's own origin story).
//
// Usage:
//   import { flagDecision, resolveDecision } from './flag_decision.mjs';
//   node scripts/flag_decision.mjs --list                          (PENDING, sorted HIGH->LOW then oldest-first)
//   node scripts/flag_decision.mjs --list-all                      (include RESOLVED too)
//   node scripts/flag_decision.mjs --add '<json matching flagDecision args>'  (priority: HIGH/MEDIUM/LOW, default MEDIUM)
//   node scripts/flag_decision.mjs --resolve <slug> '<resolution text>'
//
// Priority (added 2026-07-17, same request that built this tool -- "give them a sense of
// priority"): HIGH = real data-integrity/live-correctness impact or blocks other pending
// work; MEDIUM = real value, no urgency; LOW = cleanup/nice-to-have. Set at flag time,
// preserved across re-flags of the same slug same as first_flagged_date.
import { query } from '../server/db.js';

const VALID_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];

export async function flagDecision({ slug, decisionText, sourceFile, sourceDate = null, priority = 'MEDIUM' }) {
  if (!slug || !decisionText || !sourceFile) {
    throw new Error('flagDecision requires slug, decisionText, sourceFile');
  }
  // signal_name is VARCHAR(60) -- fail fast with a clear message rather than a raw
  // "value too long for type character varying(60)" from Postgres, and rather than
  // silently truncating (two distinct 61+ char slugs could collide on the same prefix).
  if (slug.length > 60) {
    throw new Error(`flagDecision: slug '${slug}' is ${slug.length} chars, signal_name column is VARCHAR(60) -- shorten it`);
  }
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new Error(`priority must be one of ${VALID_PRIORITIES.join('/')}, got '${priority}'`);
  }
  // Preserve the original first-flagged date across re-flags of the same slug (e.g. if a
  // decision is mentioned again in a later session before being resolved) -- age since
  // FIRST flagged is the whole point, not age since most recently mentioned.
  const existing = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='OPEN_DECISION' AND signal_name=$1
    ORDER BY run_date DESC LIMIT 1
  `, [slug]);
  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;
  let firstFlagged = today;
  if (existing.rows[0]) {
    try { firstFlagged = JSON.parse(existing.rows[0].notes).first_flagged_date || today; } catch (_) {}
  }
  const notes = JSON.stringify({
    decision_text: decisionText, source_file: sourceFile, source_date: sourceDate, priority,
    status: 'PENDING', first_flagged_date: firstFlagged, last_mentioned_date: today,
  });
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, notes)
    VALUES ($1, 0, 'OPEN_DECISION', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET notes = EXCLUDED.notes
  `, [today, slug, notes]);

  // HIGH-queue soft cap (2026-08-05, user request: "worth a cap -- if everything's HIGH, the
  // ordering does no work"). Fires immediately at flag time, not just at next session start
  // (.claude/hooks/session-start.sh has the matching display-side cap) -- a mid-session flag
  // should get the same signal a fresh session would. Advisory only, same convention as
  // post-edit-filesize.sh/the docs-size check: this never blocks the flag from being written,
  // it just makes queue overload visible at the moment it happens instead of only at the next
  // session boundary.
  if (priority === 'HIGH') {
    const { rows: highCountRows } = await query(`
      SELECT COUNT(*) as n FROM (
        SELECT DISTINCT ON (signal_name) signal_name, notes::jsonb as notes
        FROM performance_audit WHERE signal_type = 'OPEN_DECISION'
        ORDER BY signal_name, run_date DESC
      ) latest
      WHERE notes->>'status' = 'PENDING' AND COALESCE(notes->>'priority', 'MEDIUM') = 'HIGH'
    `);
    const highCount = parseInt(highCountRows[0].n, 10);
    const HIGH_QUEUE_CAP = 8;
    if (highCount > HIGH_QUEUE_CAP) {
      console.warn(`⚠️  HIGH-priority OPEN_DECISION queue is now ${highCount} (cap: ${HIGH_QUEUE_CAP}). Consider whether this genuinely needs HIGH, or whether an existing HIGH item is actually resolved and should be closed out via --resolve.`);
    }
  }

  return { slug, today, firstFlagged, priority };
}

export async function resolveDecision(slug, resolutionText) {
  const existing = await query(`
    SELECT notes FROM performance_audit
    WHERE signal_type='OPEN_DECISION' AND signal_name=$1
    ORDER BY run_date DESC LIMIT 1
  `, [slug]);
  if (!existing.rows[0]) throw new Error(`No OPEN_DECISION row found for slug '${slug}'`);
  const prev = JSON.parse(existing.rows[0].notes);
  const { rows } = await query(`SELECT CURRENT_DATE::text as today`);
  const today = rows[0].today;
  const notes = JSON.stringify({
    ...prev, status: 'RESOLVED', resolution_text: resolutionText, resolved_date: today,
  });
  await query(`
    INSERT INTO performance_audit (run_date, window_days, signal_type, signal_name, notes)
    VALUES ($1, 0, 'OPEN_DECISION', $2, $3)
    ON CONFLICT (run_date, window_days, signal_type, signal_name) DO UPDATE
      SET notes = EXCLUDED.notes
  `, [today, slug, notes]);
  return { slug, today };
}

// Priority sort order: HIGH first, then MEDIUM, then LOW, then oldest-within-tier --
// matches the ordering .claude/hooks/session-start.sh's OPEN_DECISIONS section uses.
const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export async function listDecisions({ includeResolved = false } = {}) {
  // Age computed in SQL (CURRENT_DATE - date), not JS Date() -- this codebase's own hard
  // rule against naive local-timezone date arithmetic (see CLAUDE.md's parseDateTime
  // writeup) -- the CLI's own age display used to do this in JS and was fixed 2026-07-17.
  const { rows } = await query(`
    SELECT signal_name as slug, notes, run_date,
      (CURRENT_DATE - (notes::jsonb->>'first_flagged_date')::date) as age_days
    FROM performance_audit
    WHERE signal_type = 'OPEN_DECISION'
      AND run_date = (SELECT MAX(run_date) FROM performance_audit p2 WHERE p2.signal_type='OPEN_DECISION' AND p2.signal_name = performance_audit.signal_name)
    ORDER BY run_date DESC
  `);
  const parsed = rows.map(r => ({ ...r, ageDays: r.age_days, notes: JSON.parse(r.notes) }));
  const filtered = includeResolved ? parsed : parsed.filter(r => r.notes.status === 'PENDING');
  return filtered.sort((a, b) => {
    const pa = PRIORITY_RANK[a.notes.priority] ?? 1, pb = PRIORITY_RANK[b.notes.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return b.ageDays - a.ageDays; // oldest first within the same priority tier
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--list' || args[0] === '--list-all') {
    const decisions = await listDecisions({ includeResolved: args[0] === '--list-all' });
    for (const d of decisions) {
      const pri = d.notes.priority || 'MEDIUM';
      console.log(`[${pri}] [${d.notes.status}] ${d.slug} (flagged ${d.ageDays}d ago, ${d.notes.first_flagged_date})`);
      console.log(`  ${d.notes.decision_text}`);
      console.log(`  source=${d.notes.source_file}${d.notes.resolution_text ? `\n  RESOLVED: ${d.notes.resolution_text}` : ''}`);
      console.log('');
    }
    console.log(`${decisions.length} decision(s)${args[0] === '--list' ? ' pending' : ' total'}.`);
  } else if (args[0] === '--add') {
    const payload = JSON.parse(args[1]);
    console.log('Flagged:', await flagDecision(payload));
  } else if (args[0] === '--resolve') {
    console.log('Resolved:', await resolveDecision(args[1], args[2] || ''));
  } else {
    console.log("Usage: node scripts/flag_decision.mjs --list | --list-all | --add '<json>' | --resolve <slug> '<resolution>'");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
