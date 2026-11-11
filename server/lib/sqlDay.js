// Index-friendly "this calendar day" predicate (Fable audit F11, 2026-11-10; CLAUDE.md cv-009). `ts::date = $1` forces a scan of the whole history table
// (measured 134-167 ms per call on price_bars_primary); the range form is the same rows (ts is `timestamp without time zone`) and 20-24 ms. Verified
// identical (count, max high, min low, sum volume) on 5 dates by scripts/test_sql_day.mjs. Use inside a template literal:
//   `... WHERE symbol='NQ' AND ${dayEq('ts', '$1')} ...`   // the placeholder may be text or date
export const dayEq = (col, ph) => `${col} >= ${ph}::date AND ${col} < ${ph}::date + 1`;
