// Shared permission-slip matching logic — extracted 2026-07-14 from antigravityEdges.js
// (which had this inline for the dashboard's Permission Slip banner) so acd.js's level-fade
// engine can check the same live-matched conditions before firing, instead of a second
// hand-written copy. See "share modules when appropriate" in CLAUDE.md.
//
// PERMISSION_SLIP rows (performance_audit, written weekly by backtest_permission_slips.mjs)
// each have notes.requires = { day_type, a_up_fired, a_down_fired, c_up_confirmed,
// c_down_confirmed, fh_dir } — every non-null field must match today's live value; null means
// "any". Multiple rows can match a given direction; the most specific (most non-null
// requirements) wins, tie-broken by win_rate.

export function matchPermissionSlips(today, rows) {
  const { dayType = null, aUpFired = false, aDownFired = false, cUpConfirmed = false, cDownConfirmed = false, firstHourDir = null } = today;

  const matches = (req) => {
    if (req.day_type && dayType !== req.day_type) return false;
    if (req.a_up_fired && !aUpFired) return false;
    if (req.a_down_fired && !aDownFired) return false;
    if (req.c_up_confirmed && !cUpConfirmed) return false;
    if (req.c_down_confirmed && !cDownConfirmed) return false;
    if (req.fh_dir && firstHourDir !== req.fh_dir) return false;
    return true;
  };
  const specificity = (req) => Object.values(req).filter(v => v !== null && v !== undefined).length;

  const result = { LONG: null, SHORT: null };
  for (const dir of ['LONG', 'SHORT']) {
    const best = rows
      .filter(r => r.recommendation === dir)
      .map(r => { try { return { ...r, meta: JSON.parse(r.notes) }; } catch { return null; } })
      .filter(r => r && matches(r.meta.requires))
      .sort((a, b) => {
        const ds = specificity(b.meta.requires) - specificity(a.meta.requires);
        return ds !== 0 ? ds : b.win_rate - a.win_rate;
      })[0];
    if (best) {
      result[dir] = { label: best.meta.label, winRate: best.win_rate, n: best.sample_size, direction: best.recommendation };
    }
  }
  return result;
}
