// Extracted 2026-07-13 from ACDView.jsx so CalendarView.jsx doesn't have to import a
// utility function from the (huge, non-lazy) ACDView module just to reuse it — that
// import defeated the point of this branch's code-splitting work by pulling ACDView's
// whole module graph into CalendarView's chunk.

const SETUP_HITRATE_MAP = {
  IB_BULLISH:                  { levelKey: 'IBH',    note: 'IB High hold/reversal rate — not a breakout-continuation rate' },
  IB_BEARISH:                  { levelKey: 'IBL',    note: 'IB Low hold/reversal rate — not a breakout-continuation rate' },
  VALUE_AREA_RESPONSIVE_LONG:  { levelKey: 'PD VAL', note: 'PD VAL bounce rate — directly measures this responsive-long premise' },
  VALUE_AREA_RESPONSIVE_SHORT: { levelKey: 'PD VAH', note: 'PD VAH bounce rate — directly measures this responsive-short premise' },
};

// Pulls the tracked hit-rate entry for a setup type from getAllHitRates().levelTouches,
// using the live session bias as the bias_dir bucket (falls back to NEUTRAL, then any
// available bucket). Returns { tracked: false } when no unified stat applies to this setup.
export function getSetupConviction(setupType, hitRatesData, bias) {
  const map = SETUP_HITRATE_MAP[setupType];
  if (!map || !hitRatesData?.levelTouches) return { tracked: false };
  const buckets = hitRatesData.levelTouches[map.levelKey];
  if (!buckets) return { tracked: false };
  const biasKey = (bias === 'LONG' || bias === 'SHORT') ? bias : 'NEUTRAL';
  const entry = buckets[biasKey] || buckets.NEUTRAL || buckets.LONG || buckets.SHORT;
  if (!entry) return { tracked: false };
  return {
    tracked: true,
    n: entry.decisive,
    hitRate: entry.confident ? entry.hitRate : null,
    confident: entry.confident,
    note: map.note,
  };
}
