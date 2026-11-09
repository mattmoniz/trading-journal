// Per-event rows of the frozen flush box-width skip study (docs/FLUSH_BOX_WIDTH_SKIP_PREREG_20261109.md), extracted from scripts/study_flush_box_width_skip_20261109.mjs so the
// study and its autopsy share ONE implementation (hr-022). Behavior is unchanged: the study was re-run after the extraction and must print identical numbers.
// events = one group's events (chronological, explore window, roll weeks removed). Eligible when >= MIN_PRIOR earlier events of the same direction exist.
import { realistic, percentile } from './flushStudyLib.mjs';

export const MIN_PRIOR = 20;
export function mfeOf(s) {
  let m = 0;
  for (let i = s.entryIdx + 1; i < s.sessBars.length; i++) {
    const b = s.sessBars[i];
    const f = s.resolutionDir === 'UP' ? b.high - s.entryPrice : s.entryPrice - b.low;
    if (f > m) m = f;
  }
  return m;
}
export function buildGroupRows(ev) {
  const rows = [], prior = { LONG: [], SHORT: [] };
  for (const e of ev) {
    const sp = (e.stopDist - 50) / e.adr, hist = prior[e.dir], mfe = mfeOf(e.setup);
    if (hist.length >= MIN_PRIOR) {
      const target = percentile(hist.map((h) => h.mfe), 0.5), skip = sp > percentile(hist.map((h) => h.sp), 0.8);
      const real = realistic(e.setup, target, false), mir = realistic(e.setup, target, true);
      if (real && mir) rows.push({ date: e.date, dir: e.dir, fireMin: e.fireMin, sp, skip, pnl: real.pnl, mir: mir.pnl, target, stopDist: e.stopDist, adr: e.adr });
    }
    hist.push({ sp, mfe });
  }
  return rows;
}
