// Keeps research organized as tests and variants are added (user, 2026-11-04: "make sure that everything stays organized as we test and move forward").
// Fails (exit 1) when: (1) a docs/*PREREG*|*SCOPE*|*DESIGN* file dated 2026-10-25 or later is missing from the generated docs/RESEARCH_INDEX.md; (2) a Monitor & Learning card on the phone page has no
// entry in server/services/monitorNextSteps.js and is not listed as covered; (3) a row of docs/IMPROVEMENT_REGISTER_*.md has no cheapest-next-test or retire rule; (4) a research_looks row with tests has no recorded claim. Usage: node scripts/check_research_organized.mjs   (also run by .claude/hooks/check-docs-drift.sh)
import { readdir, readFile } from 'node:fs/promises';
const R = new URL('../', import.meta.url).pathname;
const read = async (p) => { try { return await readFile(R + p, 'utf8'); } catch { return ''; } };
const problems = [];

const INDEX_DOCS = ['docs/OPEN_THREADS.md', 'docs/OPEN_THREADS_ARCHIVE.md', 'docs/CLAUDE_MD_ARCHIVE/where_to_look.md'];
const registers = (await readdir(R + 'docs')).filter((f) => /^IMPROVEMENT_REGISTER_\d+\.md$/.test(f));
const handoffs = (await readdir(R + 'docs')).filter((f) => /^HANDOFF_\d+_NEXT_SESSION\.md$/.test(f));
const indexText = (await Promise.all([...INDEX_DOCS, ...registers.map((f) => 'docs/' + f), ...handoffs.map((f) => 'docs/' + f)].map(read))).join('\n');

// (1) every pre-registration, scope or design document from the current research arc must be in the generated docs/RESEARCH_INDEX.md (rebuild: node scripts/build_research_index.mjs)
const idx = await read('docs/RESEARCH_INDEX.md');
if (!idx) problems.push('docs/RESEARCH_INDEX.md is missing: run node scripts/build_research_index.mjs');
for (const f of await readdir(R + 'docs')) {
  const m = f.match(/(PREREG|SCOPE|DESIGN).*_(20\d{6})\.md$/);
  if (!m || m[2] < '20261025' || /^(IMPROVEMENT_REGISTER|HANDOFF|RESEARCH_INDEX)/.test(f)) continue;
  if (!idx.includes('## ' + f.replace(/\.md$/, ''))) problems.push(`docs/${f} is not in docs/RESEARCH_INDEX.md: rebuild it (node scripts/build_research_index.mjs)`);
}

// (2) every card on the phone Monitor tab needs a written next-step tree (CLAUDE.md co-022) or an explicit "covered by" line
const COVERED = { // card id -> the nextSteps key that renders on it, or the reason it needs none
  'vl-box': 'vacuumLive (the card renders its own Next lines from the vacuumLive payload, scripts/lib/vacuumLiveSummary.mjs; candidate queue Q4-5 holds the same tree)',
  'av-box': 'argonShadow (the card renders its own Next lines from the argonShadow payload, scripts/lib/argonShadowSummary.mjs; improvement register row 19 and CANDIDATE_QUEUE Q4-4 hold the same tree)', 'av-explore': 'details of av-box',
  'sm-box': 'structureModel (the card renders its own Next lines from the structureModel payload, public/structure_model.json; the same tree is registered in monitorNextSteps.js)',
  'lm-cum': 'scoreboard', 'lm-fire': 'scoreboard', 'lm-ml': 'mlUnseen', 'lm-bots': 'bot+tell', 'lm-delay': 'delay', 'lm-race': 'passRace', 'dc-box': 'dayContext', 'oa-box': 'own R.next (ovnArmsSummary)',
  'tc-box': 'tellContext', 'tw-box': 'tellShadow', 'mon-scoreboard': 'details of lm-cum', 'mon-ml': 'details of lm-ml', 'mon-forward': 'forecast+regime', 'mon-gates': 'gates',
  'dc-levels': 'details of dc-box', 'oa-nights': 'details of oa-box', 'tell-alarms': 'Tell tab: integrity alarms, an alert not a test', 'tell-status': 'Tell tab: detector status, not a test',
};
const page = await read('server/public/quick-check.html');
const ids = [...new Set([...page.matchAll(/mon(?:Box|Details)\('([a-z-]+)'/g)].map((x) => x[1]))];
for (const id of ids) if (!COVERED[id]) problems.push(`card '${id}' on quick-check.html has no next-step tree: add an entry to server/services/monitorNextSteps.js and list it in COVERED in this script`);
const nsSrc = await read('server/services/monitorNextSteps.js');
for (const k of Object.values(COVERED).flatMap((v) => v.split(/[+ ]/)).filter((v) => /^[a-zA-Z]+$/.test(v) && ['scoreboard', 'mlUnseen', 'bot', 'tell', 'delay', 'passRace', 'dayContext', 'tellContext', 'tellShadow', 'forecast', 'regime', 'gates', 'structureModel'].includes(v))) {
  if (!new RegExp(`out\\.${k}\\s*=`).test(nsSrc)) problems.push(`monitorNextSteps.js has no entry out.${k}`);
}

// (3) every register row needs a cheapest next test and a retire rule (cells 5 and 6 of the table)
for (const f of registers) {
  const rows = (await read('docs/' + f)).split('\n').filter((l) => /^\|\s*\d+[a-z]?\s*\|/.test(l));
  for (const l of rows) {
    const c = l.split('|').map((x) => x.trim()); // c[0]='' c[1]=# ... c[5]=cheapest next test c[6]=retire if
    const closed = /RETIRED/.test(c[7] || ''); if (!c[5] || (!closed && /^(tbd|n\/a|none|-)?$/i.test(c[5])) || !c[6] || /^(tbd|n\/a|none|-)?$/i.test(c[6])) problems.push(`${f} row ${c[1]} lacks a cheapest next test or a retire rule`);
  }
}

// (4) every look since 2026-10-25 needs a claim: its own claim_slug/ref, or a claim whose slug or text names its family (hr-024: record every tested claim)
try {
  const { query } = await import('../server/db.js');
  const lk = (await query(`SELECT id, family, claim_slug, ref, prereg, script FROM research_looks WHERE logged_at::date >= DATE '2026-10-25' AND tests > 0`)).rows;
  const cl = (await query(`SELECT string_agg(signal_name || ' ' || COALESCE(notes::jsonb->>'claim_text',''), ' ') t FROM performance_audit WHERE signal_type='RESEARCH_CLAIM'`)).rows[0].t || '';
  const srcs = (await query(`SELECT DISTINCT notes::jsonb->>'source_file' f FROM performance_audit WHERE signal_type='RESEARCH_CLAIM'`)).rows.map((r) => r.f).filter(Boolean);
  const slugs = (await query(`SELECT DISTINCT signal_name s FROM performance_audit WHERE signal_type='RESEARCH_CLAIM'`)).rows.map((r) => r.s);
  const named = (l) => { const base = l.family.replace(/_\d{8}$/, ''), head = base.split('_').slice(0, 3).join('_'); return slugs.some((x) => x.startsWith(base) || x.startsWith(head)); };
  const scriptStem = (l) => (l.script || '').split('/').pop().replace(/\.[a-z]+$/, '');
  const docOf = (l) => (l.prereg || '').match(/docs\/[A-Za-z0-9_]+\.md/)?.[0];
  const miss = [...new Set(lk.filter((l) => !(l.claim_slug && cl.includes(l.claim_slug)) && !(l.ref && cl.includes(l.ref)) && !cl.includes(l.family) && !named(l) && !(scriptStem(l).length > 6 && srcs.some((f) => f.includes(scriptStem(l)))) && !(docOf(l) && srcs.some((f) => f.includes(docOf(l))))).map((l) => l.family))];
  for (const f of miss) problems.push(`look family '${f}' has no recorded claim (record one with recordClaim(), hr-024)`);
  process.stdout.write(`checked ${lk.length} looks with tests since 2026-10-25\n`);
} catch (e) { problems.push('look-ledger check could not run: ' + e.message.split('\n')[0]); }

console.log(problems.length ? `${problems.length} PROBLEM(S):\n- ${problems.join('\n- ')}` : 'research organization check: all clear');
process.exit(problems.length ? 1 : 0);
