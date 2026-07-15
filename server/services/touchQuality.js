// Shared order-flow "touch-quality" classification.
// Used by scripts/calibrate_touch_quality.mjs (historical calibration, writes
// performance_audit signal_type='TOUCH_QUALITY') AND server/routes/acd.js's live
// resolution loop (resolveSetupsByPrice) — do not reimplement this a third time,
// per CLAUDE.md's "share modules" convention (rigorDiagnostics.js precedent).
//
// Origin: docs/OPEN_THREADS.md "Touch-quality" thread, 2026-07-15. User's explicit
// guidance before building this: major structural levels draw genuine two-sided
// fighting between buyers and sellers, so heavy volume at a touch does NOT
// automatically mean "absorbed" — it can mean a fight the adverse side won. Hence
// 3 buckets, not 2 (ABSORBED vs OVERRUN are kept separate).
//
// Volume baseline reuses the existing VOLUME_SPIKE convention already in acd.js
// (90-day trailing per-minute-of-day avg/std z-score) — not a new static threshold.

async function getVolumeBaseline(queryFn, date) {
  const res = await queryFn(`
    SELECT (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))::int AS mod,
           AVG(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS avg_vol,
           STDDEV(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS std_vol
    FROM price_bars_primary
    WHERE ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date
    GROUP BY 1
  `, [date]);
  return new Map(res.rows.map(r => [r.mod, r]));
}

// windowBars: [{ mod, bid_volume, ask_volume }] — bars 1..W since touch, W = the
// setup_type's own calibrated reaction window (p25 of its bars-to-resolution).
// entry/direction: for the adverse-excursion-past-bar-1 check.
// baseline: Map from getVolumeBaseline.
// highVolZCutoff: setup_type's own calibrated tercile cutoff (from performance_audit).
// Returns null if no baseline coverage for any window bar (can't classify).
function classifyTouch({ windowBars, direction, baseline, highVolZCutoff, gaveFurtherGround }) {
  let maxZ = -Infinity;
  let adverseVol = 0, favorableVol = 0;
  for (const b of windowBars) {
    const bl = baseline.get(b.mod);
    const totalVol = (b.bid_volume || 0) + (b.ask_volume || 0);
    if (bl && bl.std_vol > 0) {
      const z = (totalVol - bl.avg_vol) / bl.std_vol;
      if (z > maxZ) maxZ = z;
    }
    const adverse   = direction === 'LONG' ? (b.bid_volume || 0) : (b.ask_volume || 0);
    const favorable = direction === 'LONG' ? (b.ask_volume || 0) : (b.bid_volume || 0);
    adverseVol += adverse;
    favorableVol += favorable;
  }
  if (maxZ === -Infinity) return null;

  const netAdverseDelta = adverseVol - favorableVol;
  if (maxZ <= highVolZCutoff) return { bucket: 'QUIET', maxVolZ: maxZ, netAdverseDelta };
  return {
    bucket: gaveFurtherGround ? 'HIGH_VOL_OVERRUN' : 'HIGH_VOL_ABSORBED',
    maxVolZ: maxZ,
    netAdverseDelta,
  };
}

export { getVolumeBaseline, classifyTouch };
