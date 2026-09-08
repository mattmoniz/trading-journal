#!/usr/bin/env node
// Archives old content out of docs/OPEN_THREADS.md into docs/OPEN_THREADS_ARCHIVE.md.
//
// Why this exists: OPEN_THREADS.md is read at the start of every session (CLAUDE.md's own
// instruction) and had grown to 856KB / ~214K tokens by 2026-07-31 — by far the single
// largest per-session context cost in this repo, larger than CLAUDE.md itself. The file's
// own convention already marks finished threads with strikethrough + "Resolved <date>," but
// that convention leaves the text in place forever, so the file only ever grows. This script
// doesn't change what gets recorded — it just moves content old enough that it's no longer
// live working context out of the file that's auto-loaded every session, into an archive
// file that stays fully greppable/readable but isn't auto-loaded.
//
// Two archiving modes, applied per `## `-headed section:
//   1. Whole-section (original behavior): a section whose header carries a date (e.g.
//      "## ✅ 2026-08-16 — ...") and has no top-level `- ` bullets in its body is archived or
//      kept as one unit, based on that header date vs the cutoff.
//   2. Per-bullet (added 2026-09-07): a section whose body IS a list of top-level `- `
//      bullets — including "evergreen" (undated-header, NEVER_ARCHIVE_PATTERNS) sections —
//      has EACH bullet checked individually against the cutoff (using a date found in the
//      bullet's own text, falling back to the section's header date if the section has one,
//      or kept by default if no date is found anywhere). This closes a real gap found
//      2026-09-07: "## 30-day shadow validation" and "## Pending decisions / unconfirmed
//      proposals" are both NEVER_ARCHIVE evergreen headers whose bodies are actually running
//      logs of dated bullets going back months — mode 1 alone let them grow to 298KB and
//      65KB respectively, ~63% of the file's total size, entirely exempt from archiving
//      regardless of age. Mode 2 fixes this without weakening the "never archive this
//      header" guarantee — the header (and any undated bullets under it) always survives;
//      only individually-dated OLD bullets move out.
//
// Safety: nothing here is deleted. Anything genuinely still-pending should already have a
// durable OPEN_DECISION row (performance_audit, resurfaced every session by
// .claude/hooks/session-start.sh) or a RESEARCH_CLAIM row — those don't depend on this file
// at all, so archiving old narrative here doesn't create a new way for something to get
// buried. A bullet with no discoverable date is always kept (never archived) rather than
// guessed at.
//
// Usage:
//   node scripts/archive_open_threads.mjs            # dry run — prints what would move
//   node scripts/archive_open_threads.mjs --apply     # actually rewrites both files
//   node scripts/archive_open_threads.mjs --days=14   # keep the most recent 14 calendar days live (default 7)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const LIVE_PATH = join(REPO, 'docs', 'OPEN_THREADS.md');
const ARCHIVE_PATH = join(REPO, 'docs', 'OPEN_THREADS_ARCHIVE.md');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const daysArg = args.find(a => a.startsWith('--days='));
const KEEP_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

// Headers that are standing/evergreen — the HEADER itself is never archived regardless of
// date (matched case-insensitively). Their bullets are still subject to per-bullet
// archiving (mode 2 above) if they contain dated `- ` list items.
const NEVER_ARCHIVE_PATTERNS = [
  /current top priority/i,
  /pending decisions/i,
  /30-day shadow validation/i,
  /read this first/i,
];

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function parseSections(text) {
  const lines = text.split('\n');
  const firstHeaderIdx = lines.findIndex(l => l.startsWith('## '));
  const preamble = firstHeaderIdx === -1 ? text : lines.slice(0, firstHeaderIdx).join('\n');
  if (firstHeaderIdx === -1) return { preamble, sections: [] };

  const sections = [];
  let cur = null;
  for (let i = firstHeaderIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      if (cur) sections.push(cur);
      cur = { header: line, body: [], startLine: i };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { preamble, sections };
}

function sectionDate(header) {
  const m = header.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// First date found in the first ~200 chars of a bullet's own text — reliably the bullet's
// own date in this codebase's convention (e.g. "- **Title (2026-07-27).** ..." or
// "- **🔶 2026-09-04: Title** ..."), as opposed to a date mentioned later in the prose
// (which could be a much older date being referenced, e.g. "the 2024-03-07 finding was...").
function bulletDate(bulletText) {
  const m = bulletText.slice(0, 200).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Splits a section's body into { preambleLines, bullets } where bullets are top-level `- `
// items (each with all its own indented sub-lines/sub-bullets attached). Returns
// bullets: null if the body has no top-level `- ` lines at all (a plain-prose section).
function splitBullets(bodyLines) {
  const firstBulletIdx = bodyLines.findIndex(l => /^- /.test(l));
  if (firstBulletIdx === -1) return { preambleLines: bodyLines, bullets: null };

  const preambleLines = bodyLines.slice(0, firstBulletIdx);
  const bullets = [];
  let cur = null;
  for (let i = firstBulletIdx; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (/^- /.test(line)) {
      if (cur) bullets.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) bullets.push(cur);
  return { preambleLines, bullets };
}

function shouldNeverArchiveHeader(header) {
  return NEVER_ARCHIVE_PATTERNS.some(re => re.test(header));
}

function main() {
  if (!existsSync(LIVE_PATH)) {
    console.error(`Not found: ${LIVE_PATH}`);
    process.exit(1);
  }
  const raw = readFileSync(LIVE_PATH, 'utf8');
  const { preamble, sections } = parseSections(raw);

  const today = todayET();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const keptSections = [];       // { header, body: string[] } to stay live
  const archivedWholeSections = []; // whole sections archived as a unit (mode 1)
  const archivedBulletBatches = []; // { header, bullets: string[][] } — per-bullet archives (mode 2)

  for (const s of sections) {
    const hDate = sectionDate(s.header);
    const neverArchiveHeader = shouldNeverArchiveHeader(s.header);
    const { preambleLines, bullets } = splitBullets(s.body);

    if (bullets === null) {
      // Plain-prose section — mode 1, whole-section-by-header-date (unchanged from before).
      if (!hDate) {
        keptSections.push(s); // no date anywhere — evergreen, always kept
      } else if (neverArchiveHeader) {
        keptSections.push(s);
      } else if (hDate < cutoffStr) {
        archivedWholeSections.push(s);
      } else {
        keptSections.push(s);
      }
      continue;
    }

    // Bulleted section — mode 2, per-bullet dating. A bullet with no date of its own falls
    // back to the section's header date (if any); if neither has a date, it's always kept.
    const keepBullets = [];
    const archiveBullets = [];
    for (const b of bullets) {
      const bText = b.join('\n');
      const d = bulletDate(bText) || hDate;
      if (d && d < cutoffStr) {
        archiveBullets.push(b);
      } else {
        keepBullets.push(b);
      }
    }

    if (archiveBullets.length) {
      archivedBulletBatches.push({ header: s.header, bullets: archiveBullets });
    }

    // Nothing left worth keeping and the header itself is old and not exempt — drop the
    // whole section (matches mode 1's behavior for a fully-archived dated section).
    if (keepBullets.length === 0 && preambleLines.every(l => l.trim() === '') && !neverArchiveHeader && hDate && hDate < cutoffStr) {
      continue;
    }

    // Reconstruct the kept body: preamble lines + kept bullets (each bullet separated by a
    // blank line, original relative order preserved).
    const newBody = [...preambleLines, ...keepBullets.flatMap((b, i) => i === 0 ? b : ['', ...b])];
    keptSections.push({ header: s.header, body: newBody });
  }

  const origBytes = Buffer.byteLength(raw, 'utf8');
  const wholeArchiveBytes = archivedWholeSections.reduce((sum, s) => sum + Buffer.byteLength(s.header + '\n' + s.body.join('\n'), 'utf8'), 0);
  const bulletArchiveBytes = archivedBulletBatches.reduce((sum, batch) => sum + batch.bullets.reduce((s2, b) => s2 + Buffer.byteLength(b.join('\n'), 'utf8'), 0), 0);
  const totalArchiveBytes = wholeArchiveBytes + bulletArchiveBytes;
  const totalArchivedCount = archivedWholeSections.length + archivedBulletBatches.reduce((s, b) => s + b.bullets.length, 0);

  console.log(`OPEN_THREADS.md archiving — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  Cutoff: keep content dated >= ${cutoffStr} (last ${KEEP_DAYS} calendar days), archive older`);
  console.log(`  Total sections: ${sections.length} | Whole sections archived: ${archivedWholeSections.length} | Bullets archived (from ${archivedBulletBatches.length} sections): ${archivedBulletBatches.reduce((s, b) => s + b.bullets.length, 0)}`);
  console.log(`  Current file size: ${(origBytes / 1024).toFixed(1)}KB`);
  console.log(`  Would remove: ${(totalArchiveBytes / 1024).toFixed(1)}KB (~${Math.round(totalArchiveBytes / 4)} tokens)`);
  console.log(`  Resulting live file size: ${((origBytes - totalArchiveBytes) / 1024).toFixed(1)}KB`);
  console.log('');
  if (archivedWholeSections.length) {
    console.log('Whole sections to archive (oldest first):');
    for (const s of archivedWholeSections) {
      console.log(`  [${sectionDate(s.header)}] ${s.header.replace(/^## /, '').slice(0, 100)}`);
    }
  }
  if (archivedBulletBatches.length) {
    console.log('Bullets to archive out of evergreen/bulleted sections:');
    for (const batch of archivedBulletBatches) {
      console.log(`  ${batch.bullets.length} bullet(s) from "${batch.header.replace(/^## /, '').slice(0, 80)}"`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to actually write the files.');
    return;
  }

  if (totalArchivedCount === 0) {
    console.log('\nNothing to archive.');
    return;
  }

  // Append archived content to the archive file.
  const archiveHeader = existsSync(ARCHIVE_PATH)
    ? ''
    : '# Open Threads Archive\n\nSections/bullets moved out of docs/OPEN_THREADS.md by scripts/archive_open_threads.mjs once old enough to no longer be live working context. Nothing here is deleted — this file is not auto-loaded at session start, but remains fully greppable. Anything genuinely still-pending should have its own OPEN_DECISION/RESEARCH_CLAIM row (performance_audit), which does not depend on this file.\n';
  let archiveAppend = archiveHeader + `\n---\n## Archive batch: ${today} (cutoff ${cutoffStr}, keep last ${KEEP_DAYS} days)\n`;

  if (archivedWholeSections.length) {
    archiveAppend += '\n' + archivedWholeSections.map(s => s.header + '\n' + s.body.join('\n')).join('\n') + '\n';
  }
  for (const batch of archivedBulletBatches) {
    archiveAppend += `\n### From "${batch.header.replace(/^## /, '')}"\n\n`;
    archiveAppend += batch.bullets.map(b => b.join('\n')).join('\n') + '\n';
  }

  writeFileSync(ARCHIVE_PATH, existsSync(ARCHIVE_PATH) ? readFileSync(ARCHIVE_PATH, 'utf8') + archiveAppend : archiveAppend, 'utf8');

  // Rewrite the live file: preamble + kept sections, original relative order preserved.
  let newPreamble = preamble;
  if (!newPreamble.includes('OPEN_THREADS_ARCHIVE.md')) {
    newPreamble = newPreamble.replace(
      /^# Open Threads \/ Pending Work\n/,
      `# Open Threads / Pending Work\n\nOlder resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via \`node scripts/archive_open_threads.mjs --apply\`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by \`OPEN_DECISION\`/\`RESEARCH_CLAIM\` rows regardless, so archiving here never buries anything. Since 2026-09-07 this also applies per-bullet inside evergreen sections (\"30-day shadow validation\", \"Pending decisions\") — not just whole dated sections.\n\n`
    );
  }
  const newBody = keptSections.map(s => s.header + '\n' + s.body.join('\n')).join('\n');
  const newLive = newPreamble + newBody + '\n';
  writeFileSync(LIVE_PATH, newLive, 'utf8');

  console.log(`\nDone. ${totalArchivedCount} item(s) moved to ${ARCHIVE_PATH}.`);
  console.log(`OPEN_THREADS.md: ${(origBytes / 1024).toFixed(1)}KB -> ${(Buffer.byteLength(newLive, 'utf8') / 1024).toFixed(1)}KB`);
}

main();
