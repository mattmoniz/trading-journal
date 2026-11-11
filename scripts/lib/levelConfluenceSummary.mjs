// Summary of the level-confluence TAG logger (register row 33, docs/LEVEL_CONFLUENCE_TAGS_PREREG_20261109.md; logger scripts/level_confluence_tags.mjs) for the Monitor & Learning page (cv-110):
// key `levelConfluence` of public/learning_monitor.json. Display only; no order, no setup change. Counts progress to the floor of 20 independent tagged fires per setup; it states no verdict.
import { query } from '../../server/db.js';
const FLOOR = 20;
export async function levelConfluenceSummary() {
  try {
    const rows = (await query(`SELECT setup, count(*)::int n, count(DISTINCT trade_date)::int days, count(*) FILTER (WHERE any_defended OR pivot_hi_live OR pivot_lo_live)::int defended,
      count(*) FILTER (WHERE behind_cross_min IS NOT NULL AND behind_cross_min <= 3)::int fresh_break, percentile_cont(0.5) WITHIN GROUP (ORDER BY ahead_dist_adr)::float ahead_med, percentile_cont(0.5) WITHIN GROUP (ORDER BY any_dist_adr)::float any_med,
      extract(epoch FROM (now() - max(computed_at)))::int age_sec FROM level_confluence_tags GROUP BY 1 ORDER BY 1`)).rows;
    const deferred = (await query(`SELECT (SELECT count(*) FROM amt_tell_trades WHERE bar_rule='split' AND book='V1' AND entry_price IS NOT NULL) + (SELECT count(*) FROM vacuum_live_events) + (SELECT count(*) FROM turn_signal_events WHERE kind='S2_IGNITION') - (SELECT count(*) FROM level_confluence_tags) AS n`)).rows[0].n;
    const recent = (await query(`SELECT setup, to_char(fired_at, 'MM-DD HH24:MI') t, direction d, ahead_name, round(ahead_dist_adr::numeric, 2)::float ahead, any_name, round(any_dist_adr::numeric, 2)::float anyd, (any_defended OR pivot_hi_live OR pivot_lo_live) defended FROM level_confluence_tags ORDER BY fired_at DESC LIMIT 6`)).rows;
    return { state: 'OK', generatedAt: new Date().toISOString(), floor: FLOOR, setups: rows, untagged: Number(deferred), recent,
      rule: 'Every fire of the market setups (AMT tell, vacuum onsets, turn-signal ignitions) is tagged once, at fire time, with the nearest Tier-1 levels (prior-day and prior-week highs/lows/value edges, overnight and initial-balance extremes): the nearest level ahead and behind in the trade direction, its distance in ADR20, whether it is a defended pivot, and whether the level behind was just broken. Nothing is judged yet.',
      next: { review: 'At 20 independent tagged fires per setup (tell first, then vacuum; the turn signal needs about two months), fix the binary tags from the logged distribution in a dated amendment BEFORE reading any outcome: one contrast per setup (3 in all, Holm 0.10, forward days only).',
        ifConfirmed: 'Lower 90% bound of (context minus no context) above zero, trimmed mean above zero, survives dropping the best day: propose the level condition as a size or entry filter for that setup, with the user. Nothing changes live without the go.',
        ifFailed: 'Upper bound below zero or no difference at the floor: park it, write the autopsy by level name, side, session and how recently the level behind was broken.' },
      notes: ['Reversal setups (turn signal) treat a nearby defended level as positive confluence; breakout setups (tell, vacuum) treat clear air ahead or a just-broken level behind as positive. The sign differs by design.', `Fires not yet tagged: ${Number(deferred)} (new Globex sessions wait until the day's level rows exist).`] };
  } catch (e) { return { state: 'ERROR', error: e.message }; }
}
