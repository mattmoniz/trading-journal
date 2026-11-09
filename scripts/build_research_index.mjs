// Builds docs/RESEARCH_INDEX.md: one entry per pre-registration / scope / design document dated 2026-10-25 or later, joined to the look ledger (research_looks) and the recorded claims
// (performance_audit RESEARCH_CLAIM), so that every test and variant is findable from one place (user, 2026-11-04). Generated: never edit by hand; rerun after adding a doc, a look or a claim.
// The verdict shown is the claim's own text and rigor status (first 230 characters), not a summary written here. Usage: node scripts/build_research_index.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { query } from '../server/db.js';
const R = new URL('../', import.meta.url).pathname, SINCE = '20261025';
const isDoc = (f) => /(PREREG|_SCOPE_|_DESIGN_|SCOPE|DESIGN).*_(20\d{6})\.md$/.test(f) && f.match(/_(20\d{6})\.md$/)[1] >= SINCE && !/^(IMPROVEMENT_REGISTER|HANDOFF|RESEARCH_INDEX)/.test(f);
const docs = (await readdir(R + 'docs')).filter(isDoc).sort((a, b) => a.match(/_(20\d{6})\.md$/)[1].localeCompare(b.match(/_(20\d{6})\.md$/)[1]) || a.localeCompare(b));
const looks = (await query(`SELECT id, family, prereg, script, tests, kind_label, data_window, window_kind, claim_slug, ref, logged_at::date::text d FROM (SELECT id, family, prereg, script, tests, label kind_label, data_window, window_kind, claim_slug, ref, logged_at FROM research_looks) x WHERE logged_at::date >= DATE '2026-10-25' ORDER BY id`)).rows;
const claims = (await query(`SELECT signal_name slug, run_date::text d, notes FROM performance_audit WHERE signal_type='RESEARCH_CLAIM' AND (notes::jsonb->>'source_date') >= '2026-10-25' ORDER BY run_date, id`)).rows
  .map((c) => ({ slug: c.slug, ...(typeof c.notes === 'string' ? JSON.parse(c.notes) : c.notes) }));
const latest = new Map(claims.map((c) => [c.slug, c])); claims.length = 0; claims.push(...latest.values()); // weekly rechecks add a row per slug: keep the newest
const title = async (f) => ((await readFile(R + 'docs/' + f, 'utf8')).split('\n').find((l) => l.startsWith('#')) || f).replace(/^#+\s*/, '').slice(0, 140);
const one = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 230);
const out = [`# Research index (generated ${new Date().toISOString().slice(0, 10)} by scripts/build_research_index.mjs; do not edit by hand)`, '',
  'One entry per pre-registration, scope or design document dated 2026-10-25 or later. Looks come from the ledger `research_looks`, claims from `RESEARCH_CLAIM`. The text after "claim" is the claim\'s own wording, not a summary. Rebuild after adding a doc, a look or a claim; `scripts/check_research_organized.mjs` fails if this file is stale or a doc is missing.', '',
  `${docs.length} documents · ${looks.length} looks since 2026-10-25 · ${claims.length} claims since 2026-10-25`, ''];
const used = new Set();
for (const f of docs) {
  const my = looks.filter((l) => l.prereg && l.prereg.includes(f)); my.forEach((l) => used.add(l.id));
  const cl = claims.filter((c) => c.source_file && c.source_file.includes(f));
  out.push(`## ${f.replace(/\.md$/, '')}`, `${await title(f)}`);
  out.push(my.length ? `- Looks (${my.length}): ${my.map((l) => `#${l.id} ${l.family} (${l.window_kind}, ${l.tests} tests, ${l.d})`).join('; ')}` : '- Looks: none logged against this doc (design/scope, or run under another prereg)');
  out.push(cl.length ? `- Claims (${cl.length}):` : '- Claims: none recorded against this doc');
  for (const c of cl.slice(-6)) out.push(`  - \`${c.slug}\` [${c.rigor_status || 'n/a'}${c.status ? ' / ' + c.status : ''}]: ${one(c.claim_text)}`);
  if (cl.length > 6) out.push(`  - (${cl.length - 6} earlier claims on this doc; query RESEARCH_CLAIM by source_file)`);
  out.push('');
}
const orphan = looks.filter((l) => !used.has(l.id));
out.push('## Looks not tied to a document listed above', 'Run under an older prereg, a script-level prereg, or none. Each needs a prereg reference when the work is touched again.', '');
for (const l of orphan) out.push(`- #${l.id} ${l.d} \`${l.family}\` (${l.window_kind}, ${l.tests} tests) prereg: ${l.prereg || 'none'}; script: ${l.script || 'n/a'}; claim: ${l.claim_slug || l.ref || 'none'}`);
await writeFile(R + 'docs/RESEARCH_INDEX.md', out.join('\n') + '\n');
console.log(`wrote docs/RESEARCH_INDEX.md: ${docs.length} docs, ${looks.length} looks (${orphan.length} not tied to a listed doc), ${claims.length} claims`);
process.exit(0);
