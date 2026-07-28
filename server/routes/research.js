import express from 'express';
import { listClaims } from '../../scripts/record_claim.mjs';
import { listDecisions } from '../../scripts/flag_decision.mjs';
import { query } from '../db.js';

// Research Ledger — a single page showing every tested idea/mechanism this codebase has
// recorded (RESEARCH_CLAIM: a hypothesis with a real N/WR/EV) and every pending decision
// (OPEN_DECISION: wire it in or drop it, still awaiting a human call), so the user can
// get one glimpse of "what's currently affecting the app's output and the trades that
// are/aren't firing" instead of archaeology across CLAUDE.md/OPEN_THREADS.md/performance_
// audit by hand. Added 2026-07-28 per direct user request. Reuses the existing listClaims()/
// listDecisions() from scripts/record_claim.mjs and scripts/flag_decision.mjs rather than
// re-querying performance_audit here — those are already the canonical readers.
const router = express.Router();

router.get('/research/ledger', async (req, res) => {
  try {
    const [claims, decisions] = await Promise.all([
      listClaims(),
      listDecisions({ includeResolved: true }),
    ]);
    const { rows } = await query(`SELECT CURRENT_DATE::text as d`);
    const today = rows[0].d;
    res.json({
      today,
      claims: claims.map(c => ({
        slug: c.slug,
        claimText: c.notes.claim_text,
        sourceFile: c.notes.source_file,
        sourceDate: c.notes.source_date,
        sampleSize: c.sample_size,
        winRate: c.win_rate,
        evPerTrade: c.ev_per_trade,
        rigorStatus: c.notes.rigor_status,
        status: c.notes.status,
        lastVerifiedDate: c.notes.last_verified_date,
        nextRecheckDue: c.notes.next_recheck_due,
        overdue: c.notes.next_recheck_due ? c.notes.next_recheck_due < today : false,
      })),
      decisions: decisions.map(d => ({
        slug: d.slug,
        decisionText: d.notes.decision_text,
        sourceFile: d.notes.source_file,
        sourceDate: d.notes.source_date,
        priority: d.notes.priority,
        status: d.notes.status,
        firstFlaggedDate: d.notes.first_flagged_date,
        ageDays: d.ageDays,
        resolutionText: d.notes.resolution_text ?? null,
        resolvedDate: d.notes.resolved_date ?? null,
      })),
    });
  } catch (err) {
    console.error('[research/ledger]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
