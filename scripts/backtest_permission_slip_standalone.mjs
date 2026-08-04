// =============================================================================
// Permission Slip as a standalone trade — real entry-timing EV test.
//
// Direct follow-up to backtest_permission_slips.mjs, whose own header is explicit
// about what it measures: "session closes in predicted direction = close_400 >
// open_930." That's a directional-bias stat computed from the 9:30 open — it is
// NOT a trade, because none of a_up_fired/c_up_confirmed/fh_dir are known at 9:30.
// A real trade can only enter once the qualifying condition set actually confirms,
// which can be well into the morning — capturing a smaller, differently-priced
// remainder of the session, not the full 9:30->4:00 move the 65-82% win rates
// were computed against.
//
// Found and flagged independently by both Gemini and DeepSeek (blind, parallel
// design critiques, 2026-08-03) as THE open question before trusting this idea at
// all. This script answers it directly: real entry at the moment the LAST required
// condition confirms (not the open), real point distance to close, real $/pt and
// commission — compared side-by-side against the original open-anchored stat for
// the identical population, so the gap (if any) is visible, not just asserted.
//
// Entry timing is causal by construction: a_up_fired/a_down_fired have real
// intraday timestamps (a_up_time/a_down_time, already persisted in acd_daily_log).
// c_up_confirmed/c_down_confirmed did NOT have a timestamp anywhere in this
// codebase until this session — computeACDFromBars() (server/services/acdService.js)
// already computes c_up_confirmed causally (a simple forward bar walk, breaking at
// the first qualifying close), so capturing cUpTime/cDownTime at that same break
// point was a one-line, purely-additive change to the real function (never
// reimplemented) rather than a second copy of this logic. fh_dir's confirmation
// time is fixed and trivial (first 30-min close, ~10:00 ET) so it's computed
// directly from bars here rather than needing its own service function.
//
// Reuses computeACDFromBars() for aUpFired/aUpTime/aDownFired/aDownTime/
// cUpConfirmed/cUpTime/cDownConfirmed/cDownTime — never reimplemented. fh_dir and
// the trade simulation (entry price, walk to close) use the same bulk-loaded NQ
// bar array every other backtest script in this codebase uses.
// =============================================================================

import { query } from '../server/db.js';
import { computeACDFromBars, getBestACDParams } from '../server/services/acdService.js';
import { computeRigor } from '../server/services/rigorDiagnostics.js';
import { LIVE_INSTRUMENT } from '../server/config/instruments.js';
import { recordClaim } from './record_claim.mjs';

const PNL_PER_POINT = LIVE_INSTRUMENT.dollarsPerPoint;
const COMMISSION = LIVE_INSTRUMENT.commissionPerRoundTrip;
const MIN_N = 20;

// Mirrors backtest_permission_slips.mjs's own best-populated bucket shapes
// (day-type-conditioned sub-buckets deliberately excluded from this first pass —
// smaller N, and the point of this script is answering the entry-timing question
// on the buckets that already have the strongest headline numbers).
const BUCKETS = [
  { name: 'LONG_AUP',            dir: 'LONG',  requires: ['aUp'] },
  { name: 'LONG_AUP_CUP',        dir: 'LONG',  requires: ['aUp', 'cUp'] },
  { name: 'LONG_AUP_FHUP',       dir: 'LONG',  requires: ['aUp', 'fh'] },
  { name: 'LONG_AUP_CUP_FHUP',   dir: 'LONG',  requires: ['aUp', 'cUp', 'fh'] },
  { name: 'LONG_FHUP',           dir: 'LONG',  requires: ['fh'] },
  { name: 'SHORT_ADN',           dir: 'SHORT', requires: ['aDn'] },
  { name: 'SHORT_ADN_CDN',       dir: 'SHORT', requires: ['aDn', 'cDn'] },
  { name: 'SHORT_ADN_FHDO',      dir: 'SHORT', requires: ['aDn', 'fh'] },
  { name: 'SHORT_ADN_CDN_FHDO',  dir: 'SHORT', requires: ['aDn', 'cDn', 'fh'] },
  { name: 'SHORT_FHDO',          dir: 'SHORT', requires: ['fh'] },
];

function timeToMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  console.log('Loading ACD params...');
  const { orMins, aMult, sustainMins } = await getBestACDParams();
  console.log(`Using orMins=${orMins} aMult=${aMult} sustainMins=${sustainMins}`);

  console.log('Loading trade dates...');
  const datesRes = await query(`SELECT trade_date::text FROM acd_daily_log WHERE trade_date < CURRENT_DATE ORDER BY trade_date ASC`);
  const dates = datesRes.rows.map(r => r.trade_date);
  console.log(`${dates.length} historical trading days.`);

  console.log('Loading NQ bars...');
  const barsRes = await query(`SELECT ts, open::float as open, high::float as high, low::float as low, close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts ASC`);
  const allBars = barsRes.rows.map(b => ({ ts: new Date(b.ts).getTime(), dateObj: new Date(b.ts), open: b.open, high: b.high, low: b.low, close: b.close }));

  function firstIndexAfter(t) {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].ts <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function minsET(dateObj) {
    // Bars are stored naive-ET (confirmed convention elsewhere in this codebase's
    // Sierra Chart pipeline) — read UTC getters directly against the naive value.
    return dateObj.getUTCHours() * 60 + dateObj.getUTCMinutes();
  }

  console.log('Computing per-day ACD signals + trade simulation...');
  const perDay = [];
  let processed = 0;
  for (const date of dates) {
    const acd = await computeACDFromBars(date, orMins, aMult, sustainMins);
    if (!acd) continue;

    const dayStartMs = new Date(`${date}T00:00:00`).getTime();
    const dayBars = [];
    let idx = firstIndexAfter(dayStartMs);
    while (idx < allBars.length && allBars[idx].ts < dayStartMs + 24 * 3600 * 1000) { dayBars.push(allBars[idx]); idx++; }
    const rthBars = dayBars.filter(b => minsET(b.dateObj) >= 570 && minsET(b.dateObj) <= 960);
    if (rthBars.length < 30) continue;

    const open930 = rthBars.find(b => minsET(b.dateObj) === 570)?.open ?? rthBars[0].open;
    const bar1000 = rthBars.filter(b => minsET(b.dateObj) >= 599 && minsET(b.dateObj) <= 601).slice(-1)[0];
    const close1000 = bar1000?.close ?? null;
    const fhDir = close1000 == null ? null : (close1000 > open930 ? 'UP' : close1000 < open930 ? 'DOWN' : null);
    const fhTimeMin = 601; // fh_dir knowable at ~10:01 ET, matching the original definition's 599-601 window

    const closeBar = rthBars.filter(b => minsET(b.dateObj) >= 959 && minsET(b.dateObj) <= 961).slice(-1)[0];
    const close400 = closeBar?.close ?? rthBars[rthBars.length - 1].close;

    perDay.push({
      date, rthBars, open930, close400,
      aUp: acd.aUpFired, aUpMin: timeToMin(acd.aUpTime),
      aDn: acd.aDownFired, aDnMin: timeToMin(acd.aDownTime),
      cUp: acd.cUpConfirmed, cUpMin: timeToMin(acd.cUpTime),
      cDn: acd.cDownConfirmed, cDnMin: timeToMin(acd.cDownTime),
      fh: fhDir, fhMin: fhDir ? fhTimeMin : null,
    });
    processed++;
    if (processed % 100 === 0) console.log(`  ...${processed}/${dates.length}`);
  }
  console.log(`${perDay.length} days with usable RTH bar data.`);

  console.log('\nRunning buckets (real entry timing vs. original open-anchored stat)...\n');
  const results = [];

  for (const bucket of BUCKETS) {
    const long = bucket.dir === 'LONG';
    const events = [];      // real-entry EV events
    const openAnchored = [];  // original "close_400 vs open_930" for the SAME population, for comparison

    for (const d of perDay) {
      // Check qualification + find the confirmation minute of each required signal
      let qualifies = true;
      let latestConfirmMin = -Infinity;
      for (const req of bucket.requires) {
        if (req === 'aUp') { if (!d.aUp) { qualifies = false; break; } latestConfirmMin = Math.max(latestConfirmMin, d.aUpMin ?? Infinity); }
        if (req === 'aDn') { if (!d.aDn) { qualifies = false; break; } latestConfirmMin = Math.max(latestConfirmMin, d.aDnMin ?? Infinity); }
        if (req === 'cUp') { if (!d.cUp) { qualifies = false; break; } latestConfirmMin = Math.max(latestConfirmMin, d.cUpMin ?? Infinity); }
        if (req === 'cDn') { if (!d.cDn) { qualifies = false; break; } latestConfirmMin = Math.max(latestConfirmMin, d.cDnMin ?? Infinity); }
        if (req === 'fh')  { if (d.fh !== (long ? 'UP' : 'DOWN')) { qualifies = false; break; } latestConfirmMin = Math.max(latestConfirmMin, d.fhMin ?? Infinity); }
      }
      if (!qualifies || !isFinite(latestConfirmMin)) continue;

      // Original (lookahead) stat: does close_400 beat open_930 in the predicted direction?
      const openAnchoredWin = long ? d.close400 > d.open930 : d.close400 < d.open930;
      openAnchored.push({ date: d.date, win: openAnchoredWin });

      // Real entry: open of the first RTH bar strictly after the confirmation minute.
      const entryBar = d.rthBars.find(b => minsET(b.dateObj) > latestConfirmMin);
      if (!entryBar) continue; // confirmed too late in the session to actually enter
      const entry = entryBar.open;
      const exit = d.close400;
      const signedPoints = long ? (exit - entry) : (entry - exit);
      const pnl = signedPoints * PNL_PER_POINT - COMMISSION;
      events.push({ date: d.date, pnl, signedPoints, entryMin: minsET(entryBar.dateObj) });
    }

    if (events.length < MIN_N) {
      console.log(`${bucket.name}: N=${events.length} < ${MIN_N}, skipped (thin)`);
      continue;
    }

    const realWins = events.filter(e => e.pnl > 0).length;
    const realWR = realWins / events.length;
    const realEv = events.reduce((s, e) => s + e.pnl, 0) / events.length;
    const openWR = openAnchored.filter(e => e.win).length / openAnchored.length;
    const avgEntryMin = Math.round(events.reduce((s, e) => s + e.entryMin, 0) / events.length);
    const entryClock = `${String(Math.floor(avgEntryMin / 60)).padStart(2, '0')}:${String(avgEntryMin % 60).padStart(2, '0')}`;

    const rigor = computeRigor(events, { dateField: 'date', pnlFn: e => e.pnl });

    results.push({ bucket: bucket.name, n: events.length, realWR, realEv, openWR, avgEntryClock: entryClock, rigor });
    console.log(`${bucket.name}: N=${events.length}  avgEntry=${entryClock}ET  openAnchoredWR=${(openWR*100).toFixed(1)}%  realWR=${(realWR*100).toFixed(1)}%  realEV=$${realEv.toFixed(2)}  rigorClean=${rigor.clean}`);
  }

  console.log('\n=== Summary: original open-anchored WR vs. real entry-timed EV ===\n');
  for (const r of results) {
    console.log(`${r.bucket}: openWR=${(r.openWR*100).toFixed(1)}% -> realWR=${(r.realWR*100).toFixed(1)}%, realEV=$${r.realEv.toFixed(2)}/trade, N=${r.n}, avgEntry=${r.avgEntryClock}ET, rigorClean=${r.rigor.clean}`);
  }

  const survivors = results.filter(r => r.realEv > 0 && r.rigor.clean);
  console.log(`\n${survivors.length}/${results.length} buckets are both real-EV-positive AND rigor-clean.`);

  const todayRow = await query(`SELECT CURRENT_DATE::text as d`);
  await recordClaim({
    slug: 'permission_slip_standalone_real_entry_timing',
    claimText: `Tested whether PERMISSION_SLIP's 65-82% "closes in predicted direction from 9:30 open" stat survives real entry timing (enter at the open of the bar after the LAST required condition actually confirms, not at 9:30). Both Gemini and DeepSeek independently flagged this as the key open question before trusting the idea. Result across ${results.length} tested buckets (N>=20 each): ${survivors.length} are both real-EV-positive and rigor-clean. ` +
      results.map(r => `${r.bucket}(N=${r.n},openWR=${(r.openWR*100).toFixed(0)}%->realWR=${(r.realWR*100).toFixed(0)}%,realEV=$${r.realEv.toFixed(2)},rigor=${r.rigor.clean})`).join('; '),
    sourceFile: 'scripts/backtest_permission_slip_standalone.mjs',
    sourceDate: todayRow.rows[0].d,
    sampleSize: results.reduce((s, r) => s + r.n, 0),
    rigorStatus: 'computeRigor_per_bucket',
    status: survivors.length > 0 ? 'PROVISIONAL' : 'CONFIRMED',
  });

  console.log('\nRecorded RESEARCH_CLAIM permission_slip_standalone_real_entry_timing.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
