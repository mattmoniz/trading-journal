// Cross-references every signal_type in performance_audit against (a) whether a script that
// writes it is still scheduled anywhere, and (b) whether any live route/service code reads
// it back out. Built 2026-07-17 (OPEN_DECISION backtest_pipeline_freshness_consumption_report)
// so "is this signal_type still read/written" is a single command instead of repeated
// grep+git-log archaeology — this exact question was answered by hand at least twice this
// week (the 2026-07-16 SSOT/dead-end audit, then again during the 2026-07-17 PD2/2D_POC
// investigation) for overlapping signal_types.
//
// Scheduling has TWO independent layers in this codebase, both checked here:
//   1. server/index.js's node-cron cron.schedule(...) blocks (in-process scheduler)
//   2. the system crontab -> shell scripts in scripts/run_*.sh -> `node scripts/X.mjs` calls
// A script missing from layer 1 can still be legitimately scheduled via layer 2 (e.g.
// calibrate_touch_quality.mjs, mine_tod_patterns.mjs) -- checking only server/index.js
// (this script's own first version) produced false "orphaned" flags for exactly that reason.
//
// Writer detection: greps scripts/**/*.{js,mjs} for files that both mention
// 'performance_audit' and contain the literal signal_type string -- a real match, not a
// name-based guess. Consumption check similarly greps server/routes/** and
// server/services/** for the literal signal_type string. Both are static string greps, not
// full analysis -- a signal_type read/written only via a parameterized query
// (`signal_type = $1`, built elsewhere) won't be caught. Treat "0 found" as "worth a manual
// look", not automatic proof of dead code.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { query } from '../server/db.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some(e => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

function grepLiteral(needle, files) {
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (src.includes(needle)) hits.push(path.relative(REPO, f));
  }
  return hits;
}

// --- Layer 1: server/index.js node-cron blocks ---
function parseIndexCron(indexSrc) {
  // script path -> cron pattern, for every execSync('node scripts/X...') inside a
  // cron.schedule(...) block.
  const map = {};
  const blockStarts = [...indexSrc.matchAll(/cron\.schedule\(\s*'([^']+)'/g)];
  for (let i = 0; i < blockStarts.length; i++) {
    const start = blockStarts[i].index;
    const end = i + 1 < blockStarts.length ? blockStarts[i + 1].index : start + 1500;
    const block = indexSrc.slice(start, end);
    const cronPattern = blockStarts[i][1];
    for (const m of block.matchAll(/execSync\(`?'?node (scripts\/[\w.\-\/]+)/g)) {
      map[m[1]] = { source: 'server/index.js', cronPattern };
    }
  }
  return map;
}

// --- Layer 2: system crontab -> scripts/run_*.sh -> node scripts/X ---
function parseSystemCrontab() {
  const map = {}; // script path -> { source, cronPattern }
  let crontabText = '';
  try { crontabText = execSync('crontab -l 2>/dev/null').toString(); } catch { return map; }

  const lines = crontabText.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  for (const line of lines) {
    const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)/);
    if (!m) continue;
    const [, cronPattern, cmdPath] = m;
    if (cmdPath.endsWith('.sh')) {
      const shPath = cmdPath.startsWith('/') ? cmdPath : path.join(REPO, cmdPath);
      if (!fs.existsSync(shPath)) continue;
      const shSrc = fs.readFileSync(shPath, 'utf8');
      for (const sm of shSrc.matchAll(/node (scripts\/[\w.\-\/]+)/g)) {
        map[sm[1]] = { source: path.relative(REPO, shPath), cronPattern };
      }
    } else if (cmdPath.includes('scripts/')) {
      const scriptRel = cmdPath.slice(cmdPath.indexOf('scripts/'));
      map[scriptRel] = { source: 'crontab (direct)', cronPattern };
    }
  }
  return map;
}

async function run() {
  const indexSrc = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
  const cronMap = { ...parseIndexCron(indexSrc), ...parseSystemCrontab() };

  const allScripts = listFiles(path.join(REPO, 'scripts'), ['.js', '.mjs']);
  const liveFiles = [
    ...listFiles(path.join(REPO, 'server/routes'), ['.js']),
    ...listFiles(path.join(REPO, 'server/services'), ['.js']),
  ];

  const { rows } = await query(`
    SELECT signal_type, MAX(run_date)::text as last_run,
      COUNT(*) as row_count, (CURRENT_DATE - MAX(run_date)) as days_stale
    FROM performance_audit
    GROUP BY signal_type
    ORDER BY signal_type
  `);

  const report = rows.map(r => {
    // Find candidate writer scripts: mentions both performance_audit and this signal_type literal.
    const writers = allScripts.filter(f => {
      const src = fs.readFileSync(f, 'utf8');
      return src.includes('performance_audit') && src.includes(`'${r.signal_type}'`);
    }).map(f => path.relative(REPO, f));

    const scheduled = writers
      .map(w => cronMap[w] || cronMap[w.replace(/^scripts\//, 'scripts/')])
      .filter(Boolean);

    const consumers = grepLiteral(`'${r.signal_type}'`, liveFiles);

    return {
      signal_type: r.signal_type,
      row_count: Number(r.row_count),
      last_run: r.last_run,
      days_stale: Number(r.days_stale),
      writers,
      scheduled,
      consumed_live: consumers.length > 0,
      consumer_files: consumers,
    };
  });

  console.log(`\n=== PIPELINE FRESHNESS + CONSUMPTION REPORT (${report.length} signal_types) ===\n`);

  const flagged = [];
  for (const r of report) {
    const flags = [];
    if (r.writers.length === 0) flags.push('NO WRITER SCRIPT FOUND (may be written from acd.js directly, or truly dead)');
    if (r.writers.length > 0 && r.scheduled.length === 0) flags.push('WRITER FOUND BUT NOT SCHEDULED ANYWHERE (manual-only)');
    if (!r.consumed_live) flags.push('NO LIVE CONSUMER FOUND (grep-based, verify by hand)');
    if (r.scheduled.length > 0 && r.days_stale > 14) flags.push(`STALE (${r.days_stale}d, but has a schedule — check for silent failures)`);
    if (flags.length) flagged.push({ ...r, flags });

    const cronStr = r.scheduled.length ? r.scheduled.map(s => `${s.cronPattern}@${s.source}`).join(', ') : 'NONE';
    console.log(
      `${r.signal_type.padEnd(28)} rows=${String(r.row_count).padEnd(6)} last=${r.last_run} (${r.days_stale}d ago)  ` +
      `writer=${r.writers.length ? r.writers.join(',') : '?'}  sched=${cronStr}  consumed=${r.consumed_live ? `Y(${r.consumer_files.length})` : 'N'}` +
      (flags.length ? `  ⚠️` : '')
    );
  }

  console.log(`\n=== ${flagged.length} FLAGGED FOR REVIEW ===\n`);
  for (const r of flagged) {
    console.log(`${r.signal_type}: ${r.flags.join('; ')}`);
    if (r.consumed_live) console.log(`  consumers: ${r.consumer_files.join(', ')}`);
  }
  console.log('');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
