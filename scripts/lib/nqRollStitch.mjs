// Data-derived NQ contract-stitch list for RESEARCH scripts (built 2026-11-10 after the Fable review audit,
// docs/FABLE_REVIEW_AUDIT_20261110.md, claim nq_roll_stitch_list_incomplete_20261110).
//
// Why this exists: acdShared.getNqRollWeekDates() is a CALENDAR rule (2nd Thursday .. Monday before the 3rd
// Friday). It answers "is the live front month about to switch", and LIVE code keeps using it. It does NOT say
// where price_bars_primary actually switches contract: the stitch sits wherever price_bars_contract_calendar
// changed, which is up to 6 days before or 1 day after that window, and three early stitches are outside it
// altogether. A study that measures a price change ACROSS a stitch books a 165-513 point jump that never traded.
//
// What it reports, all read from the bars themselves (no typed dates):
//   stitches:  every bar whose `contract` differs from the previous bar's (the labelled switch), with the price
//              step (open minus previous close) and the size of any data hole it spans.
//   bad_dates: dates whose minute bars are not clean one-per-minute bars of one contract, by two measured signs:
//     MIXED_BARS  raw price_bars holds more than one row per minute for the calendar contract (volume-bar rows
//                 with off-second timestamps were loaded under the same label, 2025-06-01..2025-08-25 and
//                 2026-04-28/29). The view's minute close is then the close of a volume bar that ENDS LATER
//                 (seconds in RTH, minutes overnight): a look-ahead in `close`, and volume is inflated (hr-070).
//     STEP_RATIO  the 99th percentile of |open - previous close| between adjacent minutes exceeds the day's median
//                 bar range. Clean days sit at 0.2-0.8 (max 0.83 over 1,069 days), broken days at 1.1-22: the two
//                 groups do not overlap, 1.0 is the gap between them and means "1 in 100 adjacent opens jumps by
//                 more than a typical whole bar". Catches 2025-05-29/30 (mixed prices, steps of 40-90 points),
//                 2023-03-03..08 and 2025-09-16..19 (thin wrong-month rows).
//
// KNOWN GAP (docs/NQ_RAW_BAR_REPAIR_20261110.md): the label-based stitch list cannot see the real NQM25>NQU25 jump of about +222 points at
// 2025-06-15/16, because the rows 2025-05-29..06-13 are labelled NQU25 but hold NQM25 prices. touchesBadDate() covers it (all of
// 2025-05-29..2025-08-25 are bad dates); crossesStitch() alone does not. The planned repair makes it a real label change.
// Use crossesStitch(data, t0, t1) with t0 = the EARLIEST bar the computation reads (lookback start) and
// t1 = the last (exit). unsafeDates() is the per-date form (stitch dates plus bad_dates) for scripts that skip by
// date. The JSON written by scripts/build_nq_roll_stitches.mjs is the copy Python reads (scripts/lib/nq_roll_stitch.py).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NQ_STITCH_FILE = path.join(HERE, 'data', 'nq_roll_stitches.json');
export const STEP_RATIO_BAD = 1.0; // data-integrity separator between two non-overlapping groups (see header), not a trading threshold
const MIN_BARS_FOR_RATIO = 300;     // a date needs enough bars for a 99th percentile

const ms = (t) => Date.parse(t.replace(' ', 'T') + 'Z'); // naive ET strings compared as if UTC: only differences matter
const addMonth = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); };

// Streams price_bars_primary one month at a time (both bounds, cv-009; hr-028) and returns { stitches, bad_dates }.
export async function scanNqStitches(query, { from, to, symbol = 'NQ' } = {}) {
  const stitches = [], bad = new Map();
  let prev = null, day = null, steps = [], ranges = [];
  const pct = (arr, p) => { const v = [...arr].sort((x, y) => x - y); const i = p * (v.length - 1), lo = Math.floor(i); return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo); };
  const closeDay = () => {
    if (day && ranges.length >= MIN_BARS_FOR_RATIO && steps.length >= MIN_BARS_FOR_RATIO) {
      const med = pct(ranges, 0.5), ratio = med > 0 ? pct(steps, 0.99) / med : Infinity;
      if (ratio > STEP_RATIO_BAD) {
        // merge, never overwrite: the last date of a month is closed AFTER that month's MIXED_BARS query ran (fixed 2026-11-10: 2025-06-30 and 2025-07-31 had lost MIXED_BARS)
        const e = bad.get(day) || { date: day, reasons: [] };
        e.reasons.unshift('STEP_RATIO'); e.step_ratio = +ratio.toFixed(2); bad.set(day, e);
      }
    }
    steps = []; ranges = [];
  };
  let a = from.slice(0, 8) + '01';
  while (a < to) {
    const b = addMonth(a);
    const r = await query(
      `SELECT ts::text t, contract k, open::float o, high::float h, low::float l, close::float c
         FROM price_bars_primary WHERE symbol = $1 AND ts >= $2::date AND ts < $3::date ORDER BY ts`, [symbol, a, b]);
    for (const x of r.rows) {
      const d = x.t.slice(0, 10);
      if (d !== day) { closeDay(); day = d; }
      if (prev) {
        const dtMin = (ms(x.t) - ms(prev.t)) / 60000, step = x.o - prev.c;
        if (x.k !== prev.k) stitches.push({ ts: x.t, prev_ts: prev.t, from: prev.k, to: x.k, step_pts: +step.toFixed(2), hole_min: dtMin });
        else if (dtMin <= 1) steps.push(Math.abs(step));
      }
      ranges.push(x.h - x.l); prev = x;
    }
    // raw rows per minute for the calendar contract (the view's own join), same month
    const m = await query(
      `SELECT pb.ts::date::text d, count(*)::int n, count(DISTINCT date_trunc('minute', pb.ts))::int mins
         FROM price_bars pb JOIN price_bars_contract_calendar cc ON cc.symbol = pb.symbol AND cc.trade_date = pb.ts::date AND cc.contract = pb.contract
        WHERE pb.symbol = $1 AND pb.ts >= $2::date AND pb.ts < $3::date GROUP BY 1 HAVING count(*) > count(DISTINCT date_trunc('minute', pb.ts))`, [symbol, a, b]);
    for (const x of m.rows) {
      const e = bad.get(x.d) || { date: x.d, reasons: [] };
      e.reasons.push('MIXED_BARS'); e.extra_raw_rows = x.n - x.mins; bad.set(x.d, e);
    }
    a = b;
  }
  closeDay();
  // both reasons are merged per date (closeDay of a month's last date runs after that month's MIXED_BARS query); order by date
  return { stitches, bad_dates: [...bad.values()].sort((x, y) => (x.date < y.date ? -1 : 1)) };
}

export function loadNqStitches(file = NQ_STITCH_FILE) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// Every labelled stitch instant, as { ts, prev_ts }.
export function stitchInstants(data) {
  return data.stitches.map(s => ({ ts: s.ts, prev_ts: s.prev_ts })).sort((x, y) => (x.ts < y.ts ? -1 : 1));
}

const norm = (t) => String(t).replace('T', ' ').slice(0, 19);

// True when a price difference taken between t0 and t1 (naive ET 'YYYY-MM-DD HH:MM:SS', t0 <= t1) spans a stitch:
// the first bar of the new contract is after t0 and at or before t1.
export function crossesStitch(data, t0, t1) {
  const a = norm(t0), b = norm(t1);
  return data.stitches.some(s => s.ts > a && s.ts <= b);
}

// True when any calendar date from t0 to t1 is a bad-bar date (MIXED_BARS or STEP_RATIO).
export function touchesBadDate(data, t0, t1) {
  const a = norm(t0).slice(0, 10), b = norm(t1).slice(0, 10);
  return data.bad_dates.some(x => x.date >= a && x.date <= b);
}

// Per-date form: the date of each stitch bar and of the bar before it (widened by daysBefore / daysAfter), plus
// every bad-bar date unless includeBadDates is false. Returns a Set of 'YYYY-MM-DD'.
export function unsafeDates(data, { daysBefore = 0, daysAfter = 0, includeBadDates = true } = {}) {
  const out = new Set();
  const add = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); out.add(x.toISOString().slice(0, 10)); };
  for (const s of data.stitches) {
    const d1 = s.ts.slice(0, 10), d0 = s.prev_ts.slice(0, 10);
    for (let k = -daysBefore; k <= 0; k++) add(d0, k);
    for (let k = 0; k <= daysAfter; k++) add(d1, k);
  }
  if (includeBadDates) for (const x of data.bad_dates) out.add(x.date);
  return out;
}
