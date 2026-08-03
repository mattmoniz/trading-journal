#!/usr/bin/env node
// Archives old dated sections out of docs/OPEN_THREADS.md into docs/OPEN_THREADS_ARCHIVE.md.
//
// Why this exists: OPEN_THREADS.md is read at the start of every session (CLAUDE.md's own
// instruction) and had grown to 856KB / ~214K tokens by 2026-07-31 — by far the single
// largest per-session context cost in this repo, larger than CLAUDE.md itself. The file's
// own convention already marks finished threads with strikethrough + "Resolved <date>," but
// that convention leaves the text in place forever, so the file only ever grows. This script
// doesn't change what gets recorded — it just moves sections old enough that they're no
// longer live working context out of the file that's auto-loaded every session, into an
// archive file that stays fully greppable/readable but isn't auto-loaded.
//
// Safety: nothing here is deleted. Anything genuinely still-pending should already have a
// durable OPEN_DECISION row (performance_audit, resurfaced every session by
// .claude/hooks/session-start.sh) or a RESEARCH_CLAIM row — those don't depend on this file
// at all, so archiving old narrative here doesn't create a new way for something to get
// buried. Certain evergreen/standing sections (no date in the header, or explicitly the
// current top-priority section) are never archived regardless of age.
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

// Headers that are standing/evergreen — never archived regardless of date, matched
// case-insensitively against the header line.
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

function shouldNeverArchive(header) {
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

  const toArchive = [];
  const toKeep = [];

  for (const s of sections) {
    const date = sectionDate(s.header);
    if (!date) {
      toKeep.push(s); // no date in header — evergreen, always kept
      continue;
    }
    if (shouldNeverArchive(s.header)) {
      toKeep.push(s);
      continue;
    }
    if (date < cutoffStr) {
      toArchive.push(s);
    } else {
      toKeep.push(s);
    }
  }

  const origBytes = Buffer.byteLength(raw, 'utf8');
  const archiveBytes = toArchive.reduce((sum, s) => sum + Buffer.byteLength(s.header + '\n' + s.body.join('\n'), 'utf8'), 0);

  console.log(`OPEN_THREADS.md archiving — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  Cutoff: keep sections dated >= ${cutoffStr} (last ${KEEP_DAYS} calendar days), archive older`);
  console.log(`  Total sections: ${sections.length} | Archiving: ${toArchive.length} | Keeping: ${toKeep.length}`);
  console.log(`  Current file size: ${(origBytes / 1024).toFixed(1)}KB`);
  console.log(`  Would remove: ${(archiveBytes / 1024).toFixed(1)}KB (~${Math.round(archiveBytes / 4)} tokens)`);
  console.log(`  Resulting live file size: ${((origBytes - archiveBytes) / 1024).toFixed(1)}KB`);
  console.log('');
  if (toArchive.length) {
    console.log('Sections to archive (oldest first):');
    for (const s of toArchive) {
      console.log(`  [${sectionDate(s.header)}] ${s.header.replace(/^## /, '').slice(0, 100)}`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to actually write the files.');
    return;
  }

  if (toArchive.length === 0) {
    console.log('\nNothing to archive.');
    return;
  }

  // Append archived sections to the archive file, oldest-first, under a batch header.
  const archiveHeader = existsSync(ARCHIVE_PATH)
    ? ''
    : '# Open Threads Archive\n\nSections moved out of docs/OPEN_THREADS.md by scripts/archive_open_threads.mjs once old enough to no longer be live working context. Nothing here is deleted — this file is not auto-loaded at session start, but remains fully greppable. Anything genuinely still-pending should have its own OPEN_DECISION/RESEARCH_CLAIM row (performance_audit), which does not depend on this file.\n';
  const batchNote = `\n---\n## Archive batch: ${today} (moved ${toArchive.length} sections older than ${cutoffStr})\n`;
  const archivedText = toArchive.map(s => s.header + '\n' + s.body.join('\n')).join('\n');
  const archiveAppend = archiveHeader + batchNote + '\n' + archivedText + '\n';

  writeFileSync(ARCHIVE_PATH, existsSync(ARCHIVE_PATH) ? readFileSync(ARCHIVE_PATH, 'utf8') + archiveAppend : archiveAppend, 'utf8');

  // Rewrite the live file: preamble + kept sections, original relative order preserved.
  let newPreamble = preamble;
  if (!newPreamble.includes('OPEN_THREADS_ARCHIVE.md')) {
    newPreamble = newPreamble.replace(
      /^# Open Threads \/ Pending Work\n/,
      `# Open Threads / Pending Work\n\nOlder resolved/superseded threads are periodically moved to [OPEN_THREADS_ARCHIVE.md](OPEN_THREADS_ARCHIVE.md) (via \`node scripts/archive_open_threads.mjs --apply\`) to keep this file's per-session read cost down — nothing is deleted, just relocated. Still-pending items are backed by \`OPEN_DECISION\`/\`RESEARCH_CLAIM\` rows regardless, so archiving here never buries anything.\n\n`
    );
  }
  const newBody = toKeep.map(s => s.header + '\n' + s.body.join('\n')).join('\n');
  const newLive = newPreamble + newBody + '\n';
  writeFileSync(LIVE_PATH, newLive, 'utf8');

  console.log(`\nDone. ${toArchive.length} sections moved to ${ARCHIVE_PATH}.`);
  console.log(`OPEN_THREADS.md: ${(origBytes / 1024).toFixed(1)}KB -> ${(Buffer.byteLength(newLive, 'utf8') / 1024).toFixed(1)}KB`);
}

main();
