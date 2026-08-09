// Pre-flight assertion script for backtest/calibration/mining scripts (docs/remediation_plan.md
// §4.1). 43% of this codebase's rejected RESEARCH_CLAIM findings (64 of 148, per
// docs/audit_registry_export/registry.md) died to one of a small, recurring set of logic bugs
// or contaminated-data confounds -- documented as a recurring pattern back on 2026-07-21 and
// hit at least 3 more times since, most recently tonight (2026-08-05:
// scripts/backtest_rth_calibration_genuine_holdout.mjs's order-blind evaluation loop). A written
// convention hasn't stopped it; this is the actual gate.
//
// Static-grep based, same convention/caveat as scripts/audit_pipeline_freshness.mjs: it misses
// anything expressed indirectly (a helper function imported from elsewhere, a parameterized
// column name) -- treat a flag as "worth a look before trusting this script's numbers," not
// proof of a bug. Advisory (WARN), never blocks -- this is a pre-commit-adjacent review aid, not
// a gate that can false-positive-block real work.
//
// Run standalone: node scripts/preflight_backtest_assertions.mjs [path-glob-optional]
// Run against one new script before trusting its output: node scripts/preflight_backtest_assertions.mjs scripts/backtest_foo.mjs
import fs from 'fs';
import path from 'path';

const targetArg = process.argv[2];
const SCRIPTS_DIR = path.resolve(new URL('.', import.meta.url).pathname);

async function listTargets() {
  if (targetArg) return [path.resolve(targetArg)];
  const prefixes = ['backtest_', 'calibrate_', 'mine_', 'pilot_'];
  const exts = ['.mjs', '.js'];
  const files = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(name => prefixes.some(p => name.startsWith(p)) && exts.some(e => name.endsWith(e)))
    .map(name => path.join(SCRIPTS_DIR, name));
  return files.sort();
}

// Assertion 1: origin_status filter present in the trade query, if the script queries
// active_setups at all.
function checkOriginStatusFilter(src) {
  if (!/FROM\s+active_setups/i.test(src)) return null; // doesn't query the table -- N/A
  if (/origin_status/i.test(src)) return null; // present somewhere -- good enough for a static check
  return 'queries active_setups but never mentions origin_status anywhere in the file -- likely includes synthetic BACKFILL rows unfiltered (see CLAUDE.md\'s origin_status hard rule)';
}

// Assertion 2: baseline resimulated in-script, never read from a stored column as-is.
// Heuristic: flags a stored EV-like column read (optimal_stop/optimal_target/ev_per_trade)
// used without any bar-walk/resimulation machinery also present in the same file.
function checkBaselineResimulated(src) {
  const readsStoredEv = /\b(optimal_stop|optimal_target|ev_per_trade)\b/.test(src) && /FROM\s+performance_audit/i.test(src);
  if (!readsStoredEv) return null;
  const looksLikeResim = /\bresolve\s*\(/.test(src) || /computeCorrectedTarget/.test(src) ||
    /sweepOptimalStopAndTarget(Chronological)?\s*\(/.test(src) || /precomputeCrossovers/.test(src) ||
    /for\s*\([^)]*bars?\.length/i.test(src); // a manual bar-walk loop
  if (looksLikeResim) return null;
  return 'reads a stored optimal_stop/optimal_target/ev_per_trade value from performance_audit but shows no sign of resimulating anything (no resolve()/computeCorrectedTarget/bar-walk loop found) -- if this value is used as a comparison baseline, verify it was computed by the SAME method as whatever it\'s being compared against (see the backtest_scaleout_runner.mjs baseline-mismatch incident, CLAUDE.md)';
}

// Assertion 3: explicit ORDER BY wherever chronological order matters (fired_at/ts referenced).
function checkOrderBy(src) {
  const referencesTimeCol = /\b(fired_at|\bts\b)\b/.test(src);
  if (!referencesTimeCol) return null;
  if (/ORDER\s+BY[^;]*\b(fired_at|ts)\b/i.test(src)) return null;
  return 'references fired_at/ts but no SQL query in the file has an ORDER BY on that column -- if any logic depends on chronological sequence, an unordered result set can silently break it';
}

// Assertion 4: no same-day or future data in any derived field -- proxy check for the
// unbounded price_bars_primary query lookahead vector. (The naive-JS-UTC-date issue used to
// live here too -- split into its own assertion 7 below, 2026-08-05, after this combined
// check let the pattern hide: it fired on scripts/backtest_day_type_alpha.js under this
// check's generic "lookahead" label, easy to skim past, on the same day this codebase's
// $/pt constant already had 4+ prior confirmed instances of "a hard rule exists in CLAUDE.md
// and the code violates it anyway" -- a rule that only lives in prose doesn't hold; giving
// each documented anti-pattern its own numbered, specifically-worded assertion is what does.)
function checkNoLookahead(src) {
  if (!/FROM\s+price_bars_primary/i.test(src)) return null;
  const hasLowerBound = /ts\s*>=/.test(src);
  const hasUpperBound = /ts\s*</.test(src) || /ts\s*<=/.test(src);
  if (hasLowerBound && !hasUpperBound) {
    return 'queries price_bars_primary with a lower-bound-only ts filter and no upper bound -- unbounded VIEW scan (CLAUDE.md hard rule) and a common vector for accidentally including future data';
  }
  return null;
}

// Assertion 5: $/pt constants match MNQ (LIVE_INSTRUMENT), not a hardcoded literal.
function checkDollarsPerPoint(src) {
  const hasHardcodedDpp = /\b(const|let)\s+(PT|DPP|dollarsPerPoint|PNL_PER_POINT)\s*=\s*(5|10|20|50)\b/.test(src);
  if (!hasHardcodedDpp) return null;
  const importsLiveInstrument = /LIVE_INSTRUMENT/.test(src);
  if (importsLiveInstrument) return null; // has both -- likely a documented fallback, not a live bug
  return 'hardcodes a $/pt-shaped constant to a value other than 2 (MNQ\'s real $/pt) with no LIVE_INSTRUMENT import anywhere in the file -- verify this isn\'t the wrong-$/pt-constant bug class (CLAUDE.md, 4+ prior confirmed instances)';
}

// Assertion 6 (added 2026-08-05, this codebase's own extension beyond the original 5 -- the
// concrete defect that motivated building this whole script): outcome determination must go
// through a shared, genuinely order-aware resolver, never an inline mae/mfe threshold check.
function checkSharedResolver(src) {
  const hasInlineOrderBlindCheck = /\bmae(_points)?\s*>\s*\w*stop\w*/.test(src) && /\bmfe(_points)?\s*>=?\s*\w*target\w*/.test(src);
  if (!hasInlineOrderBlindCheck) return null;
  const usesSharedResolver = /\bresolve\s*\(/.test(src) || /computeEvAtStopTargetChronological/.test(src) || /sweepOptimalStopAndTargetChronological/.test(src);
  if (usesSharedResolver) return null; // has the pattern AND the real resolver -- likely a comment/docstring or a guarded fallback path
  return 'has an inline `mae > stop` / `mfe >= target`-shaped comparison with no shared chronological resolver (resolve()/computeEvAtStopTargetChronological/sweepOptimalStopAndTargetChronological) imported -- this is the exact order-blindness confound found in scripts/backtest_rth_calibration_genuine_holdout.mjs and scripts/update_optimal_stops.mjs\'s old sweepOptimalStopAndTarget() 2026-08-05: two arms with different stop widths compared via mae_points/mfe_points alone systematically favors the wider one, since neither value carries which happened first';
}

// Assertion 7 (added 2026-08-05, split out of assertion 4 -- see its comment): run_date/
// trading-day derivation must come from SQL CURRENT_DATE, never JS new Date().toISOString().
// This exact anti-pattern was found live in scripts/backtest_day_type_alpha.js the same
// night (wrote run_date=2026-08-06 while the real ET trading day was still 08-05, at 21:54
// EDT) -- the hard rule already existed in CLAUDE.md and the code violated it anyway. Given
// its own dedicated check, not folded into a broader "lookahead" label, specifically so it
// doesn't get skimmed past the way it did living inside assertion 4.
function checkRunDateDerivation(src) {
  if (!/new Date\(\)\.toISOString\(\)/.test(src)) return null;
  return 'new Date().toISOString() found -- naive JS-UTC date arithmetic, not CURRENT_DATE, can silently drift a trading-day boundary (CLAUDE.md\'s parseDateTime hard rule). Confirmed live 2026-08-05 in scripts/backtest_day_type_alpha.js: a 21:54 EDT run wrote run_date one full calendar day ahead of the real ET trading day.';
}

const CHECKS = [
  { id: 1, name: 'origin_status filter present', fn: checkOriginStatusFilter },
  { id: 2, name: 'baseline resimulated, not read raw', fn: checkBaselineResimulated },
  { id: 3, name: 'explicit ORDER BY for chronological data', fn: checkOrderBy },
  { id: 4, name: 'no unbounded price_bars_primary lookahead', fn: checkNoLookahead },
  { id: 5, name: '$/pt matches MNQ', fn: checkDollarsPerPoint },
  { id: 6, name: 'shared order-aware resolver, not inline mae/mfe check', fn: checkSharedResolver },
  { id: 7, name: 'run_date from CURRENT_DATE, not new Date().toISOString()', fn: checkRunDateDerivation },
];

const targets = await listTargets();
let totalFlags = 0;
const perFileFlags = {};

for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);
  const flags = [];
  for (const check of CHECKS) {
    const msg = check.fn(src);
    if (msg) flags.push({ id: check.id, name: check.name, msg });
  }
  if (flags.length) {
    perFileFlags[rel] = flags;
    totalFlags += flags.length;
  }
}

if (targetArg) {
  // Single-file mode: print full detail always, even if clean.
  const rel = path.relative(process.cwd(), targets[0]);
  const flags = perFileFlags[rel];
  console.log(`\nPreflight check: ${rel}`);
  if (!flags) { console.log('  ok -- no flags on any of the 6 checks (static analysis, not a proof of correctness)'); }
  else {
    for (const f of flags) console.log(`  [${f.id}] WARN ${f.name}: ${f.msg}`);
  }
  process.exit(0);
}

console.log(`Preflight assertion sweep: ${targets.length} backtest/calibration/mining scripts checked.`);
console.log(`${Object.keys(perFileFlags).length} file(s) with at least one flag, ${totalFlags} flag(s) total.\n`);

// Aggregate by check id so the "which defect is most common" question (the original point of
// the 43% figure) is answerable directly from this output, not just a per-file wall of text.
const byCheck = {};
for (const flags of Object.values(perFileFlags)) {
  for (const f of flags) (byCheck[f.id] ||= []).push(f);
}
for (const check of CHECKS) {
  const hits = byCheck[check.id] || [];
  console.log(`[${check.id}] ${check.name}: ${hits.length} file(s) flagged`);
}

console.log('\nRun with a single file path to see full detail for one script:');
console.log('  node scripts/preflight_backtest_assertions.mjs scripts/backtest_foo.mjs\n');

if (process.env.PREFLIGHT_VERBOSE) {
  for (const [rel, flags] of Object.entries(perFileFlags)) {
    console.log(`\n${rel}`);
    for (const f of flags) console.log(`  [${f.id}] ${f.name}: ${f.msg}`);
  }
}

process.exit(0);
