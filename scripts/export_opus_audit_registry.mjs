// One-time export for an external (Opus) audit of self-deception patterns in this codebase's
// research history, 2026-08-05. Builds a flat, mechanically-classified registry of every
// RESEARCH_CLAIM and OPEN_DECISION row so an idea "killed by the instrument" (a now-known-broken
// piece of calibration machinery) can be told apart from an idea genuinely killed by evidence.
//
// Three specific defects, all discovered/fixed on 2026-08-04, are the "now-known-broken
// machinery" this export cross-references against:
//   1. optimal_stop_candidate_grid_self_censoring_feedback_loop -- sweepOptimalStopAndTarget()'s
//      MAE-percentile candidate grid is right-censored by whatever stop was live when each trade
//      fired (tight stop -> tight censored MAE -> tight candidate grid -> tight stop again).
//      Discovered/committed 2026-08-04 18:22:51 ET (git 2ef7b36).
//   2. live_stop_population_synthetic_composition_audit_20260804 -- this system's highest-volume
//      live setups have their stop built on 93-97% synthetic BACKFILL data, not the general
//      "~80% of active_setups is synthetic" fact (known since 2026-07-17), but the deeper finding
//      that origin_status-filtering alone doesn't leave enough real N to trust. Discovered/
//      committed 2026-08-04 17:32:35 ET (git e12238f).
//   3. optimal_stop_100pct_unguarded_fallback_needs_new_formula -- the circuit-breaker incident:
//      an origin_status data-correctness fix on 2026-08-02 had a second-order effect that pushed
//      ~100% of live setup_types onto an unguarded, chronologically order-blind base sweep.
//      Discovered/shipped 2026-08-04 16:09:26-16:29:02 ET (git eecdc94/7534fe7).
// performance_audit.run_date is a DATE column (no time-of-day), so the finest safe cutoff
// available from the data itself is "same calendar day or earlier" -- every claim/decision dated
// 2026-08-04 or later is flagged separately for manual same-day cross-check, never silently
// bucketed either way.
//
// Usage: node scripts/export_opus_audit_registry.mjs
// Writes scratch/opus_registry_export/registry.md (the main artifact) and
// scratch/opus_registry_export/registry.json (same data, machine-readable).
import fs from 'fs';
import { listClaims } from './record_claim.mjs';
import { listDecisions } from './flag_decision.mjs';

const OUT_DIR = 'scratch/opus_registry_export';
const DEFECT_CUTOFF_DATE = '2026-08-04'; // claims/decisions dated on/after this need manual same-day time cross-check

// ── Machinery-touch detectors (mechanical keyword match against the full text) ──────────────
const RX_MAE_PERCENTILE = /\bMAE\b.*percentile|percentile.*\bMAE\b|p75_mae|p50_mfe|mae_points.*percentile|unconstrained MAE|censor(ed|ing)|self-censoring|MAE.?\/.?MFE percentile/i;
const RX_ACTIVE_SETUPS_N = /active_setups|origin_status|BACKFILL|synthetic (data|population|trade)|real N|origin.?status/i;
const RX_BASE_SWEEP = /sweepOptimalStopAndTarget|OPTIMAL_STOP\b|optimal_stop\b|optimal_target\b|update_optimal_stops\.mjs|EV-sweep|EV sweep/i;

// ── R:R / big-move subject-matter detector (tight-ish, to avoid matching everything) ────────
const RX_RR_OR_BIGMOVE = /optimal.?stop|optimal.?target|stop.?siz|target.?siz|\bR:?R\b|risk.?reward|\brunner\b|\btrail(ing)?\b|breakeven|big.?move|tail.?mfe|outsized|large.?range|top.?quartile.?range|compression|volatility.?(regime|squeeze|cluster)|scale.?out|circuit breaker|\bMFE\b|\bMAE\b/i;

// ── Rejection-reason classifier: priority order matters -- check for instrument-fault signals
// FIRST (contaminated data, logic bug, failed gate), only fall to "genuinely negative on clean
// data" if none of those fire. A claim can trip multiple categories; we report the highest-
// priority one, since the audit's purpose is finding instrument faults, not an exhaustive tag set.
function classifyRejectionReason(text, status) {
  const isPositive = /\b(CONFIRMED|VALIDATED|VERIFIED)\b/.test(status || '') && !/reject|debunk|revers|negative|does not hold|refuted|FAIL(ED)?\b/i.test(text);
  // A claim recording a real positive finding isn't a "rejection" at all -- the 5-way taxonomy
  // is specifically about ideas that were killed. Flag separately rather than force a bucket.
  const explicitlyPositive = /RESULT:\s*(POSITIVE|a real positive|CONFIRMED)/i.test(text)
    || /found a real,? (positive|clean)/i.test(text)
    || /real,? positive,? (result|effect|finding)/i.test(text)
    || /real,? positive,? consistent improvement/i.test(text);
  if (isPositive || explicitlyPositive) return 'POSITIVE_FINDING_NOT_A_REJECTION';

  // Added 2026-08-05 per external review: "a load-bearing assumption was tested and it failed" is
  // neither a rejected idea (it wasn't proposing something new) nor a positive finding (the result
  // is bad news) -- the original 5-way taxonomy had no bucket for this and such rows fell to N/A,
  // silently excluding exactly the kind of row a self-deception audit most needs to surface.
  if (/calibrat(ion|ing) makes things WORSE|does not generalize (with|to)|net.?negative|flat negative|not.{0,20}ready|legacy.{0,20}(is )?healthy|healthy.{0,40}legacy|core premise|too thin.{0,30}net/i.test(text)
      && /held-?out|walk-?forward|genuinely new data|fresh holdout/i.test(text)) {
    return 'SYSTEM_PREMISE_FAILED';
  }

  if (/contaminat|synthetic|BACKFILL-origin|ES contamination|unfiltered by origin_status|93-97% synthetic|censor(ed|ing)|self-censoring/i.test(text)) {
    return 'contaminated-data';
  }
  if (/\bbug\b|fixed before|off-by-one|lookahead (leak|artifact|bug)|reimplementation(s)? disagree|missing ORDER BY|tie-?break.*(bug|gap)|wrong \$\/pt|hardcoded.*wrong|fabricat/i.test(text)) {
    return 'logic-bug';
  }
  if (/rigor\.clean\s*=?\s*(false|FALSE)|fails? (computeRigor|rigor)|not rigor.?clean|does not replicate|replicates\s*[:=]\s*false|failed (the )?plateau check|fails? replication|day-?clustering/i.test(text)) {
    return 'failed-gate';
  }
  if (/\bN\s*(is|=|<)\s*(too )?(thin|small)|underpowered|too (little|thin) data|small sample|THIN_N|not enough (real )?(data|N|trades)|too few (real )?trades/i.test(text)) {
    return 'data-limited';
  }
  if (/REJECTED|debunk|refuted|reversed|negative|does not hold|closed negative|clean negative|genuinely negative|\bFAIL(ED)?\b|does NOT (generalize|clear|survive)|verdict:\s*FAIL|0\s*(of|\/)\s*\d+.*(pass|surviv|clear)/i.test(text)) {
    return 'genuinely-negative-clean';
  }
  return 'UNCLASSIFIED';
}

function extractVerdict(text) {
  // Prefer an explicit "RESULT:" sentence if the claim author used that convention (common in
  // this codebase's own claim-writing style); else take the first ~220 chars.
  const m = text.match(/RESULT:\s*([^.]*(?:\.[^.]*){0,2})/i);
  if (m) return m[1].trim().slice(0, 240);
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function extractN(sampleSize, text) {
  if (sampleSize != null) return sampleSize;
  const m = text.match(/N\s*=\s*(\d[\d,]*)/);
  return m ? m[1].replace(/,/g, '') : null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const claims = await listClaims();
  const decisions = await listDecisions({ includeResolved: true });

  const rows = [];

  for (const c of claims) {
    const text = c.notes?.claim_text || '';
    const status = c.notes?.status || '';
    const date = c.run_date || c.notes?.last_verified_date || null;
    const touchesMae = RX_MAE_PERCENTILE.test(text);
    const touchesActiveSetupsN = RX_ACTIVE_SETUPS_N.test(text);
    const touchesBaseSweep = RX_BASE_SWEEP.test(text);
    const touchesAnyBrokenMachinery = touchesMae || touchesActiveSetupsN || touchesBaseSweep;
    const targetsRrOrBigmove = RX_RR_OR_BIGMOVE.test(text);
    const preDefectDiscovery = date != null && date < DEFECT_CUTOFF_DATE;
    const sameDayAsDefect = date === DEFECT_CUTOFF_DATE;
    const rejectionReason = classifyRejectionReason(text, status);
    // Only a CONFIDENTLY-classified rejection qualifies -- UNCLASSIFIED means the classifier
    // couldn't even tell whether this was a rejection at all, so it can't be asserted onto a
    // "this rejection might not hold" list. Those rows still get flagged (see
    // needsManualRejectionCheck below) rather than silently dropped.
    const isConfidentRejection = !['POSITIVE_FINDING_NOT_A_REJECTION', 'UNCLASSIFIED'].includes(rejectionReason);
    const onRevisitList = isConfidentRejection && touchesAnyBrokenMachinery && targetsRrOrBigmove && preDefectDiscovery;
    const needsManualRejectionCheck = rejectionReason === 'UNCLASSIFIED' && touchesAnyBrokenMachinery && targetsRrOrBigmove && preDefectDiscovery;

    rows.push({
      type: 'RESEARCH_CLAIM',
      id: c.slug,
      date,
      status,
      verdict: extractVerdict(text),
      n: extractN(c.sample_size, text),
      hasUnblockCondition: c.notes?.unblock_condition != null,
      rejectionReasonClass: rejectionReason,
      touchesMaePercentile: touchesMae,
      touchesActiveSetupsN: touchesActiveSetupsN,
      touchesBaseSweep: touchesBaseSweep,
      targetsRrOrBigmove,
      preDefectDiscovery,
      sameDayAsDefectNeedsManualCheck: sameDayAsDefect && touchesAnyBrokenMachinery,
      onRevisitList,
      needsManualRejectionCheck,
    });
  }

  for (const d of decisions) {
    const text = (d.notes?.decision_text || '') + ' ' + (d.notes?.resolution_text || '');
    const status = d.notes?.status || '';
    const date = d.notes?.first_flagged_date || d.run_date || null;
    const touchesMae = RX_MAE_PERCENTILE.test(text);
    const touchesActiveSetupsN = RX_ACTIVE_SETUPS_N.test(text);
    const touchesBaseSweep = RX_BASE_SWEEP.test(text);
    const touchesAnyBrokenMachinery = touchesMae || touchesActiveSetupsN || touchesBaseSweep;
    const targetsRrOrBigmove = RX_RR_OR_BIGMOVE.test(text);
    const preDefectDiscovery = date != null && date < DEFECT_CUTOFF_DATE;
    const sameDayAsDefect = date === DEFECT_CUTOFF_DATE;
    // Decisions aren't "rejected ideas" in the RESEARCH_CLAIM sense -- only a RESOLVED decision
    // whose resolution reads as a negative/rejection is even eligible for the revisit list.
    const resolvedNegative = status === 'RESOLVED' && /reject|revert|does not hold|debunk|negative|refuted|closed negative|makes things WORSE|does not generalize/i.test(d.notes?.resolution_text || '');
    const decisionClass = resolvedNegative ? classifyRejectionReason(text, status) : 'N/A (not a tested claim)';
    const onRevisitList = resolvedNegative && decisionClass !== 'UNCLASSIFIED' && decisionClass !== 'POSITIVE_FINDING_NOT_A_REJECTION' && touchesAnyBrokenMachinery && targetsRrOrBigmove && preDefectDiscovery;

    rows.push({
      type: 'OPEN_DECISION',
      id: d.slug,
      date,
      status: status + (d.notes?.priority ? ` (${d.notes.priority})` : ''),
      verdict: extractVerdict(text),
      n: extractN(null, text),
      hasUnblockCondition: 'N/A (decisions don\'t use unblock_condition)',
      rejectionReasonClass: decisionClass,
      touchesMaePercentile: touchesMae,
      touchesActiveSetupsN: touchesActiveSetupsN,
      touchesBaseSweep: touchesBaseSweep,
      targetsRrOrBigmove,
      preDefectDiscovery,
      sameDayAsDefectNeedsManualCheck: sameDayAsDefect && touchesAnyBrokenMachinery,
      onRevisitList,
      needsManualRejectionCheck: false,
    });
  }

  // ── Write JSON (full fidelity) ──────────────────────────────────────────────────────────
  fs.writeFileSync(`${OUT_DIR}/registry.json`, JSON.stringify(rows, null, 2));

  // ── Write Markdown table (the primary read artifact) ────────────────────────────────────
  const revisitList = rows.filter(r => r.onRevisitList);
  const sameDayFlags = rows.filter(r => r.sameDayAsDefectNeedsManualCheck && !r.onRevisitList);
  const manualRejectionCheck = rows.filter(r => r.needsManualRejectionCheck && !r.onRevisitList && !r.sameDayAsDefectNeedsManualCheck);
  const classCounts = {};
  for (const r of rows) classCounts[r.rejectionReasonClass] = (classCounts[r.rejectionReasonClass] || 0) + 1;

  let md = `# RESEARCH_CLAIM / OPEN_DECISION Registry Export\n\n`;
  md += `Generated ${new Date().toISOString()} by \`scripts/export_opus_audit_registry.mjs\`. ${rows.length} total rows (${claims.length} RESEARCH_CLAIM, ${decisions.length} OPEN_DECISION).\n\n`;
  md += `**Defect cutoff date: ${DEFECT_CUTOFF_DATE}** (all 3 known defects discovered same calendar day, between 16:09-18:22 ET; \`run_date\` has no time-of-day, so rows dated exactly on the cutoff are flagged for manual same-day check rather than silently bucketed).\n\n`;
  md += `## Rejection-reason class counts (all rows)\n\n`;
  for (const [k, v] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) md += `- \`${k}\`: ${v}\n`;
  md += `\n## Revisit list (${revisitList.length} rows) — rejected on now-known-broken machinery, predates discovery, targets R:R or big-move\n\n`;
  if (revisitList.length === 0) md += `_None met all four filter conditions._\n\n`;
  else {
    md += `| Type | ID | Date | Class | Machinery touched | Verdict |\n|---|---|---|---|---|---|\n`;
    for (const r of revisitList) {
      const machinery = [r.touchesMaePercentile && 'MAE%ile', r.touchesActiveSetupsN && 'active_setups N', r.touchesBaseSweep && 'base sweep'].filter(Boolean).join(', ');
      md += `| ${r.type} | \`${r.id}\` | ${r.date} | ${r.rejectionReasonClass} | ${machinery} | ${r.verdict.replace(/\|/g, '\\|')} |\n`;
    }
    md += `\n`;
  }
  md += `## Same-day-as-defect, machinery-touching — needs manual time check (${sameDayFlags.length} rows)\n\n`;
  md += `Dated exactly ${DEFECT_CUTOFF_DATE} and touches a defect-relevant area, but \`run_date\` has no time-of-day so it can't be mechanically placed before/after the ~16:09-18:22 ET discovery window without reading the row directly.\n\n`;
  if (sameDayFlags.length === 0) md += `_None._\n\n`;
  else {
    md += `| Type | ID | Class | Verdict |\n|---|---|---|---|\n`;
    for (const r of sameDayFlags) md += `| ${r.type} | \`${r.id}\` | ${r.rejectionReasonClass} | ${r.verdict.replace(/\|/g, '\\|')} |\n`;
    md += `\n`;
  }
  md += `## Ambiguous — touches broken machinery + pre-defect + R:R/bigmove, but classifier couldn't confirm it was even a rejection (${manualRejectionCheck.length} rows)\n\n`;
  md += `These are NOT asserted onto the revisit list (that requires a confidently-classified rejection) but the mechanical filter can't rule them out either — worth a manual read before dismissing.\n\n`;
  if (manualRejectionCheck.length === 0) md += `_None._\n\n`;
  else {
    md += `| Type | ID | Date | Status | Verdict |\n|---|---|---|---|---|\n`;
    for (const r of manualRejectionCheck) md += `| ${r.type} | \`${r.id}\` | ${r.date} | ${r.status} | ${r.verdict.replace(/\|/g, '\\|')} |\n`;
    md += `\n`;
  }
  md += `## Everything else — "rejection may not hold" recorded, not re-run (${rows.length - revisitList.length - sameDayFlags.length - manualRejectionCheck.length} rows)\n\n`;
  md += `Full flat table, all fields, sorted by type then date descending.\n\n`;
  md += `| Type | ID | Date | Status | N | Unblock cond. | Class | MAE%ile | active_setups N | base sweep | R:R/bigmove | pre-defect | Verdict |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const rest = rows.filter(r => !r.onRevisitList && !r.sameDayAsDefectNeedsManualCheck && !r.needsManualRejectionCheck).sort((a, b) => (a.type === b.type ? (b.date || '').localeCompare(a.date || '') : a.type.localeCompare(b.type)));
  for (const r of rest) {
    md += `| ${r.type} | \`${r.id}\` | ${r.date || ''} | ${r.status} | ${r.n ?? ''} | ${r.hasUnblockCondition === true ? 'yes' : r.hasUnblockCondition === false ? 'no' : r.hasUnblockCondition} | ${r.rejectionReasonClass} | ${r.touchesMaePercentile ? 'x' : ''} | ${r.touchesActiveSetupsN ? 'x' : ''} | ${r.touchesBaseSweep ? 'x' : ''} | ${r.targetsRrOrBigmove ? 'x' : ''} | ${r.preDefectDiscovery ? 'x' : ''} | ${r.verdict.replace(/\|/g, '\\|')} |\n`;
  }

  fs.writeFileSync(`${OUT_DIR}/registry.md`, md);
  console.log(`Wrote ${OUT_DIR}/registry.md and registry.json`);
  console.log(`Total rows: ${rows.length}. Revisit list: ${revisitList.length}. Same-day-needs-check: ${sameDayFlags.length}.`);
  console.log('Class counts:', classCounts);
}
main().catch(e => { console.error(e); process.exit(1); });
