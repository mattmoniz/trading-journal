// Global look ledger (table research_looks). EVERY script that reads outcome labels from a data window (explore, sealed or forward) must log the look BEFORE reporting numbers,
// so multiplicity can be counted per family and a sealed window can be spent exactly once. Convention, see docs/AGENTIC_SYSTEM_SCOPE_20261101.md sections 4 and 9.
//   logLook({family, dataWindow, kind:'EXPLORE'|'FORWARD', tests, label, script, prereg, claimSlug, outcome, ref, notes, loggedAt})
//   spendSealedLook({family, dataWindow, label, ...})  -> inserts a SEALED row or THROWS if that (family, window) look is already spent (database-enforced, one per family per window)
//   countLooks({family, dataWindow}) -> {rows, tests}        sealedSpent(family, dataWindow) -> boolean
import { query } from '../../server/db.js';
const KINDS = ['EXPLORE', 'SEALED', 'FORWARD'];
async function insert({ family, dataWindow, kind, tests = 1, label, script = null, prereg = null, claimSlug = null, outcome = null, ref = null, notes = null, loggedAt = null }) {
  if (!family || !dataWindow || !label) throw new Error('look ledger: family, dataWindow and label are required');
  if (!KINDS.includes(kind)) throw new Error(`look ledger: kind must be one of ${KINDS.join(', ')}`);
  const r = await query(`INSERT INTO research_looks (logged_at, family, data_window, window_kind, tests, label, script, prereg, claim_slug, outcome, ref, notes)
    VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (ref) DO NOTHING RETURNING id`,
    [loggedAt, family, dataWindow, kind, tests, label, script, prereg, claimSlug, outcome, ref, notes ? JSON.stringify(notes) : null]);
  return r.rows[0]?.id ?? null;     // null = the ref already existed (idempotent backfill)
}
export const logLook = (o) => { if (o.kind === 'SEALED') throw new Error('use spendSealedLook() for a sealed window'); return insert(o); };
export async function spendSealedLook(o) {
  try { return await insert({ ...o, kind: 'SEALED' }); }
  catch (e) { if (e.code === '23505') throw new Error(`SEALED LOOK ALREADY SPENT for family=${o.family} window=${o.dataWindow}; it cannot be used again (a new family or an explicitly new window needs a written user decision)`); throw e; }
}
export async function countLooks({ family, dataWindow } = {}) {
  const r = await query(`SELECT COUNT(*)::int AS rows, COALESCE(SUM(tests),0)::int AS tests FROM research_looks WHERE ($1::text IS NULL OR family=$1) AND ($2::text IS NULL OR data_window=$2)`, [family ?? null, dataWindow ?? null]);
  return r.rows[0];
}
export async function sealedSpent(family, dataWindow) {
  const r = await query(`SELECT 1 FROM research_looks WHERE window_kind='SEALED' AND family=$1 AND data_window=$2 LIMIT 1`, [family, dataWindow]); return r.rows.length > 0;
}
