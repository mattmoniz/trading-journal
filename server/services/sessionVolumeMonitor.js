// Session-wide volume elevation monitor -- the piece from the very start of the 2026-09-09
// investigation that never got built: "the system needs to acknowledge and watch for
// elevated Globex volume." Distinct from pivotConfluenceAnalysis.js's touchVolZ/breakVolZ,
// which read volume at a single bar/pivot -- this reads the WHOLE session so far (RTH or
// Globex) against the same 90-day per-minute-of-day baseline, matching the by-hand
// calculation that found the 2026-09-09 overnight flush ran 37.6% above normal.
//
// Informational only -- does not gate or size anything live. Own file per CLAUDE.md's
// "isolate non-trading features" convention (matches volatilityRegime.js/pulseReading.js).
import { query } from '../db.js';
import { getVolumeBaseline } from './touchQuality.js';
import { getSessionBarsSinceOpen } from '../routes/acd.js';

export async function getSessionVolumeElevation() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMinNow = nowET.getHours() * 60 + nowET.getMinutes();
  const todayET = nowET.toLocaleDateString('en-CA');
  // Same RTH/Globex boundary convention as acd.js's building-strength-live endpoint.
  const boundaryMod = (etMinNow >= 570 && etMinNow < 1080) ? 570 : 1080;
  const session = boundaryMod === 570 ? 'RTH' : 'GLOBEX';

  const bars = await getSessionBarsSinceOpen(boundaryMod);
  if (bars.length < 3) {
    return { session, barsInSession: bars.length, pctAboveNormal: null, note: 'Not enough bars yet this session.' };
  }

  const baseline = await getVolumeBaseline(query, todayET);
  let actualTotal = 0, expectedTotal = 0, coveredBars = 0;
  for (const b of bars) {
    const bl = baseline.get(b.mod);
    if (bl) { actualTotal += b.volume; expectedTotal += bl.avg_vol; coveredBars++; }
  }
  const pctAboveNormal = expectedTotal > 0 ? ((actualTotal - expectedTotal) / expectedTotal) * 100 : null;

  return {
    session,
    barsInSession: bars.length,
    coveredBars,
    actualTotal,
    expectedTotal: Math.round(expectedTotal),
    pctAboveNormal: pctAboveNormal != null ? Math.round(pctAboveNormal * 10) / 10 : null,
    note: 'Session-wide volume vs. the 90-day per-minute-of-day baseline, from session open through now. Informational only.',
  };
}
