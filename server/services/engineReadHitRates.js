import { query } from '../db.js';

const CONFIDENCE_THRESHOLD = 20;

// Builds a lookup of historical hit rates from engine_reads, keyed by 'A_UP', 'A_DOWN',
// 'BIAS_LONG', 'BIAS_SHORT', 'BIAS_NEUTRAL'. Each entry has { overall, byBias }.
// decisive = CORRECT + WRONG outcomes (NEUTRAL excluded). confident = decisive >= 20.
export async function getHitRateLookup() {
  const rows = await query(`
    SELECT read_type, signal_value, session_bias_context,
      COUNT(*) FILTER (WHERE outcome IN ('CORRECT','WRONG')) AS decisive,
      COUNT(*) FILTER (WHERE outcome = 'CORRECT')            AS correct,
      COUNT(*)                                               AS n
    FROM engine_reads
    WHERE outcome IS NOT NULL
    GROUP BY read_type, signal_value, session_bias_context
    ORDER BY read_type, signal_value, session_bias_context
  `);

  const lookup = {};
  for (const row of rows.rows) {
    const key = row.read_type === 'A_SIGNAL'
      ? (row.signal_value === 'A_UP' ? 'A_UP' : 'A_DOWN')
      : 'BIAS_' + row.signal_value;
    if (!lookup[key]) lookup[key] = { byBias: {}, overall: null };
    const decisive = parseInt(row.decisive);
    const correct  = parseInt(row.correct);
    const n        = parseInt(row.n);
    const hitRate  = decisive >= CONFIDENCE_THRESHOLD ? Math.round((correct / decisive) * 100) : null;
    const entry    = { n, decisive, correct, hitRate, confident: decisive >= CONFIDENCE_THRESHOLD };
    if (row.read_type === 'A_SIGNAL' && row.session_bias_context) {
      lookup[key].byBias[row.session_bias_context] = entry;
    } else {
      lookup[key].overall = entry;
    }
  }
  return lookup;
}

// Format a human-readable hit rate string. Never returns a raw percentage when N<20.
export function formatHitRate(lookup, key, biasCtx) {
  const bucket = lookup[key];
  if (!bucket) return null;
  const ctxEntry = biasCtx && bucket.byBias?.[biasCtx];
  const overall  = bucket.overall;
  const use = ctxEntry?.confident ? ctxEntry : overall;
  if (!use) return null;
  if (!use.confident) return `limited sample (n=${use.decisive} decisive of ${use.n} total)`;
  const label = ctxEntry?.confident ? `in ${biasCtx} bias context` : 'overall';
  return `${use.hitRate}% plays out ${label} (n=${use.decisive} decisive of ${use.n} total)`;
}

// Builds a lookup of "level touch" outcomes from setup_correlation_cache, keyed by
// setup_key ('IBH', 'IBL', 'PD High', 'PD Low', 'PD VAH', 'PD VAL', 'VWAP Break', 'VWAP Reclaim'),
// then by bias_dir ('LONG', 'SHORT', 'NEUTRAL').
// IMPORTANT — what this measures: hit_rate = fraction of touches of that level where price moved
// >=15pts AWAY from the level (a reversal/bounce off it) within 30 bars. It is NOT a
// "breakout continuation" rate — a HIGH rate means the level tends to hold/reverse price,
// not that breaking it leads to continuation. confident = tested >= 20.
export async function getLevelTouchLookup() {
  const rows = await query(`
    SELECT bias_dir, setup_key, tested, profitable, avg_pts, hit_rate
    FROM setup_correlation_cache
  `);
  const lookup = {};
  for (const row of rows.rows) {
    const tested = parseInt(row.tested);
    const profitable = parseInt(row.profitable);
    const hitRate = tested >= CONFIDENCE_THRESHOLD ? Math.round(parseFloat(row.hit_rate) * 100) : null;
    if (!lookup[row.setup_key]) lookup[row.setup_key] = {};
    lookup[row.setup_key][row.bias_dir] = {
      n: tested, decisive: tested, correct: profitable,
      avgPts: row.avg_pts != null ? parseInt(row.avg_pts) : null,
      hitRate, confident: tested >= CONFIDENCE_THRESHOLD,
    };
  }
  return lookup;
}

// Format a level-touch reversal rate. Never returns a raw percentage when N<20.
// Describes what the stat actually measures (reversal/bounce off the level), not a
// breakout-continuation claim.
export function formatLevelTouchRate(lookup, levelKey, biasDir) {
  const entry = lookup[levelKey]?.[biasDir];
  if (!entry) return null;
  if (!entry.confident) return `limited sample (n=${entry.decisive})`;
  const ptsNote = entry.avgPts ? `, avg ${entry.avgPts}pts` : '';
  return `${entry.hitRate}% reversed/bounced ≥15pts within 30min of touching ${levelKey} in ${biasDir} bias (n=${entry.decisive}${ptsNote})`;
}

// Builds a lookup of level-confluence combo win rates from combo_stats, keyed by combo_id.
// confident = n >= 20.
export async function getComboLookup() {
  const rows = await query(`
    SELECT combo_id, label, category, tier, levels, n, win_rate
    FROM combo_stats
  `);
  const lookup = {};
  for (const row of rows.rows) {
    const n = parseInt(row.n);
    const winRate = n >= CONFIDENCE_THRESHOLD ? Math.round(parseFloat(row.win_rate)) : null;
    lookup[row.combo_id] = {
      label: row.label, category: row.category, tier: row.tier, levels: row.levels,
      n, winRate, confident: n >= CONFIDENCE_THRESHOLD,
    };
  }
  return lookup;
}

// Format a combo win rate. Never returns a raw percentage when N<20.
export function formatComboRate(lookup, comboId) {
  const entry = lookup[comboId];
  if (!entry) return null;
  if (!entry.confident) return `${entry.label}: limited sample (n=${entry.n})`;
  return `${entry.label}: ${entry.winRate}% (n=${entry.n})`;
}

// Unified entry point — one place to ask "what's the track record of this signal/setup/level."
// Returns all three sources together so callers (coach, conviction link) can pull from any of
// them with a single await, all sharing the same N>=20 confidence threshold.
export async function getAllHitRates() {
  const [engineReads, levelTouches, combos] = await Promise.all([
    getHitRateLookup(),
    getLevelTouchLookup(),
    getComboLookup(),
  ]);
  return { engineReads, levelTouches, combos };
}

export { CONFIDENCE_THRESHOLD };
