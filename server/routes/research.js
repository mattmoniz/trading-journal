import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listClaims } from '../../scripts/record_claim.mjs';
import { listDecisions } from '../../scripts/flag_decision.mjs';
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';

// Research Ledger — a single page showing every tested idea/mechanism this codebase has
// recorded (RESEARCH_CLAIM: a hypothesis with a real N/WR/EV) and every pending decision
// (OPEN_DECISION: wire it in or drop it, still awaiting a human call), so the user can
// get one glimpse of "what's currently affecting the app's output and the trades that
// are/aren't firing" instead of archaeology across CLAUDE.md/OPEN_THREADS.md/performance_
// audit by hand. Added 2026-07-28 per direct user request. Reuses the existing listClaims()/
// listDecisions() from scripts/record_claim.mjs and scripts/flag_decision.mjs rather than
// re-querying performance_audit here — those are already the canonical readers.
//
// "Wired live" column (added same day, first version was missing this -- the user's
// direct point was that a claim's own CONFIRMED/PROVISIONAL status doesn't tell you
// whether it's actually affecting live output): this codebase has a real, existing
// citation convention -- when a RESEARCH_CLAIM's finding gets implemented, the live code
// comment cites the exact slug ("RESEARCH_CLAIM <slug>", verified live e.g.
// server/routes/acd.js:414/474/3442, src/views/ACDView.jsx:673). A literal grep for each
// slug across server/routes, server/services, and src is therefore a real signal for "is
// this specific finding wired in," not just a generic signal_type-level check like
// audit_pipeline_freshness.mjs's (which answers a coarser, less useful question here --
// most RESEARCH_CLAIM rows are never re-read live directly, their FINDING gets
// hand-implemented as separate code instead).
const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const LIVE_CODE_DIRS = ['server/routes', 'server/services', 'src'];
const CORPUS_TTL_MS = 10 * 60 * 1000; // 10min -- short enough a same-session code change shows up soon

function walkFiles(dir, exts, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some(ext => e.name.endsWith(ext))) out.push(full);
  }
}

function getLiveCodeCorpus() {
  const cached = cacheGet('researchLedgerCorpus');
  if (cached) return cached;
  const files = [];
  for (const d of LIVE_CODE_DIRS) walkFiles(path.join(REPO_ROOT, d), ['.js', '.jsx', '.mjs'], files);
  const corpus = files.map(f => ({
    file: path.relative(REPO_ROOT, f),
    content: fs.readFileSync(f, 'utf8'),
  }));
  return cacheSet('researchLedgerCorpus', corpus, CORPUS_TTL_MS);
}

function findWiring(slug) {
  const corpus = getLiveCodeCorpus();
  const matches = corpus.filter(c => c.content.includes(slug)).map(c => c.file);
  return { wiredLive: matches.length > 0, wiredFiles: matches };
}

const PREVIEW_LEN = 220;
const preview = (s) => !s ? '' : (s.length > PREVIEW_LEN ? s.slice(0, PREVIEW_LEN).trim() + '…' : s);

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
      claims: claims.map(c => {
        const { wiredLive, wiredFiles } = findWiring(c.slug);
        return {
          slug: c.slug,
          claimPreview: preview(c.notes.claim_text),
          claimTruncated: (c.notes.claim_text?.length || 0) > PREVIEW_LEN,
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
          wiredLive, wiredFiles,
        };
      }),
      decisions: decisions.map(d => {
        const { wiredLive, wiredFiles } = findWiring(d.slug);
        return {
          slug: d.slug,
          decisionPreview: preview(d.notes.decision_text),
          decisionTruncated: (d.notes.decision_text?.length || 0) > PREVIEW_LEN,
          sourceFile: d.notes.source_file,
          sourceDate: d.notes.source_date,
          priority: d.notes.priority,
          status: d.notes.status,
          firstFlaggedDate: d.notes.first_flagged_date,
          ageDays: d.ageDays,
          hasResolution: d.notes.resolution_text != null,
          resolvedDate: d.notes.resolved_date ?? null,
          wiredLive, wiredFiles,
        };
      }),
    });
  } catch (err) {
    console.error('[research/ledger]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/research/ledger/:type/:slug — full untruncated text, fetched lazily only when
// a row is expanded (the list endpoint above ships a short preview to keep payload size
// bounded as this ledger grows -- 152 claims + 120 decisions already runs ~650KB/1.8s
// shipping full text for every row up front).
router.get('/research/ledger/:type/:slug', async (req, res) => {
  try {
    const { type, slug } = req.params;
    if (type === 'claim') {
      const claims = await listClaims();
      const c = claims.find(x => x.slug === slug);
      if (!c) return res.status(404).json({ error: 'not found' });
      res.json({ claimText: c.notes.claim_text });
    } else if (type === 'decision') {
      const decisions = await listDecisions({ includeResolved: true });
      const d = decisions.find(x => x.slug === slug);
      if (!d) return res.status(404).json({ error: 'not found' });
      res.json({ decisionText: d.notes.decision_text, resolutionText: d.notes.resolution_text ?? null });
    } else {
      res.status(400).json({ error: 'type must be claim or decision' });
    }
  } catch (err) {
    console.error('[research/ledger/detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
