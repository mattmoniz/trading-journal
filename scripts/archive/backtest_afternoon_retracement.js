// backtest_afternoon_retracement.js
// Backtest: What happens in the afternoon after the morning establishes a directional move?
import { query } from '../server/db.js';

const PNL_PER_POINT = 2;    // $2 per NQ point (micro)
const COMMISSION = 1;        // $1 round trip

// ─── helpers ───────────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n, d) { return d ? ((n / d) * 100).toFixed(1) + '%' : 'N/A'; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function fmt(v) { return typeof v === 'number' ? v.toFixed(2) : v; }
function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// ─── main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('='.repeat(100));
  console.log('  AFTERNOON RETRACEMENT BACKTEST — NQ Futures');
  console.log('  Morning = 9:30-12:30 ET  |  Afternoon = 12:30-4:00 ET');
  console.log('  Period: last ~1 year of data');
  console.log('='.repeat(100));
  console.log();

  // ─── 1. Fetch session OHLC data ─────────────────────────────────────────────
  // Morning session: minutes 570 (9:30) to 749 (12:29)
  // Afternoon session: minutes 750 (12:30) to 959 (3:59)
  const sql = `
    WITH daily_bars AS (
      SELECT
        ts::date AS trade_date,
        EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) AS minute_of_day,
        ts, open, high, low, close, volume
      FROM price_bars_primary
      WHERE ts >= NOW() - INTERVAL '14 months'
        AND EXTRACT(dow FROM ts) BETWEEN 1 AND 5
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959
    ),
    morning AS (
      SELECT
        trade_date,
        (ARRAY_AGG(open ORDER BY ts ASC))[1] AS m_open,
        MAX(high) AS m_high,
        MIN(low) AS m_low,
        (ARRAY_AGG(close ORDER BY ts DESC))[1] AS m_close,
        SUM(volume) AS m_volume,
        COUNT(*) AS m_bars
      FROM daily_bars
      WHERE minute_of_day BETWEEN 570 AND 749
      GROUP BY trade_date
      HAVING COUNT(*) >= 150  -- need substantial bars
    ),
    afternoon AS (
      SELECT
        trade_date,
        (ARRAY_AGG(open ORDER BY ts ASC))[1] AS a_open,
        MAX(high) AS a_high,
        MIN(low) AS a_low,
        (ARRAY_AGG(close ORDER BY ts DESC))[1] AS a_close,
        SUM(volume) AS a_volume,
        COUNT(*) AS a_bars
      FROM daily_bars
      WHERE minute_of_day BETWEEN 750 AND 959
      GROUP BY trade_date
      HAVING COUNT(*) >= 150
    ),
    afternoon_detail AS (
      SELECT
        trade_date,
        ts,
        minute_of_day,
        high,
        low,
        close
      FROM daily_bars
      WHERE minute_of_day BETWEEN 750 AND 959
    )
    SELECT
      m.trade_date,
      m.m_open, m.m_high, m.m_low, m.m_close, m.m_volume, m.m_bars,
      a.a_open, a.a_high, a.a_low, a.a_close, a.a_volume, a.a_bars
    FROM morning m
    JOIN afternoon a ON m.trade_date = a.trade_date
    ORDER BY m.trade_date;
  `;

  const { rows } = await query(sql);
  console.log(`Loaded ${rows.length} complete trading days\n`);

  // Also fetch afternoon bar-by-bar data for time-of-retracement analysis
  const detailSql = `
    SELECT
      ts::date AS trade_date,
      EXTRACT(hour FROM ts) AS hr,
      EXTRACT(minute FROM ts) AS mn,
      EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) AS minute_of_day,
      high, low, close
    FROM price_bars_primary
    WHERE ts >= NOW() - INTERVAL '14 months'
      AND EXTRACT(dow FROM ts) BETWEEN 1 AND 5
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 750 AND 959
    ORDER BY ts;
  `;
  const detailRes = await query(detailSql);
  // Group detail bars by date (trade_date comes back as 'YYYY-MM-DD' string from type parser)
  const detailByDate = {};
  for (const r of detailRes.rows) {
    const d = String(r.trade_date);
    if (!detailByDate[d]) detailByDate[d] = [];
    detailByDate[d].push(r);
  }

  // Also fetch morning bar-by-bar for rotation count and close-in-range
  const morningDetailSql = `
    SELECT
      ts::date AS trade_date,
      ts, high, low, close, volume
    FROM price_bars_primary
    WHERE ts >= NOW() - INTERVAL '14 months'
      AND EXTRACT(dow FROM ts) BETWEEN 1 AND 5
      AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 749
    ORDER BY ts;
  `;
  const morningDetailRes = await query(morningDetailSql);
  const morningDetailByDate = {};
  for (const r of morningDetailRes.rows) {
    const d = String(r.trade_date);
    if (!morningDetailByDate[d]) morningDetailByDate[d] = [];
    morningDetailByDate[d].push(r);
  }

  // ─── Process each day ────────────────────────────────────────────────────────
  const days = [];

  for (const r of rows) {
    const mOpen = parseFloat(r.m_open);
    const mHigh = parseFloat(r.m_high);
    const mLow = parseFloat(r.m_low);
    const mClose = parseFloat(r.m_close);
    const mVolume = parseInt(r.m_volume);

    const aOpen = parseFloat(r.a_open);
    const aHigh = parseFloat(r.a_high);
    const aLow = parseFloat(r.a_low);
    const aClose = parseFloat(r.a_close);
    const aVolume = parseInt(r.a_volume);

    const mMove = mClose - mOpen;
    const mRange = mHigh - mLow;
    const aMove = aClose - aOpen;
    const aRange = aHigh - aLow;
    const mMag = Math.abs(mMove);

    // Classify morning
    let morningDir;
    if (mMove > 50) morningDir = 'UP';
    else if (mMove < -50) morningDir = 'DOWN';
    else morningDir = 'FLAT';

    // Retracement calculation for directional mornings
    let retracementPct = null;
    let maxRetracementPct = null;
    let continuationPct = null;
    let afternoonDirection = null; // 'CONTINUATION' or 'RETRACEMENT'
    let peakRetracementMinute = null;

    const dateStr = String(r.trade_date);
    const aftBars = detailByDate[dateStr] || [];

    if (morningDir !== 'FLAT') {
      if (morningDir === 'UP') {
        // Morning went UP. Retracement = afternoon drops below morning close
        const aftMoveAgainst = Math.max(0, mClose - aLow);   // how far below mClose
        const aftMoveWith = Math.max(0, aHigh - mClose);      // how far above mClose
        maxRetracementPct = (aftMoveAgainst / mMag) * 100;

        // Close-based retracement
        const closeRetrace = Math.max(0, mClose - aClose);
        retracementPct = (closeRetrace / mMag) * 100;

        // Did afternoon continue or retrace on close?
        if (aClose >= mClose) {
          afternoonDirection = 'CONTINUATION';
          continuationPct = ((aClose - mClose) / mMag) * 100;
        } else {
          afternoonDirection = 'RETRACEMENT';
          continuationPct = -((mClose - aClose) / mMag) * 100;
        }

        // Find peak retracement time
        let maxRetraceVal = 0;
        for (const bar of aftBars) {
          const retraceAmt = Math.max(0, mClose - parseFloat(bar.low));
          if (retraceAmt > maxRetraceVal) {
            maxRetraceVal = retraceAmt;
            peakRetracementMinute = parseInt(bar.minute_of_day);
          }
        }
      } else {
        // Morning went DOWN. Retracement = afternoon rallies above morning close
        const aftMoveAgainst = Math.max(0, aHigh - mClose);   // how far above mClose
        const aftMoveWith = Math.max(0, mClose - aLow);       // how far below mClose
        maxRetracementPct = (aftMoveAgainst / mMag) * 100;

        const closeRetrace = Math.max(0, aClose - mClose);
        retracementPct = (closeRetrace / mMag) * 100;

        if (aClose <= mClose) {
          afternoonDirection = 'CONTINUATION';
          continuationPct = ((mClose - aClose) / mMag) * 100;
        } else {
          afternoonDirection = 'RETRACEMENT';
          continuationPct = -((aClose - mClose) / mMag) * 100;
        }

        let maxRetraceVal = 0;
        for (const bar of aftBars) {
          const retraceAmt = Math.max(0, parseFloat(bar.high) - mClose);
          if (retraceAmt > maxRetraceVal) {
            maxRetraceVal = retraceAmt;
            peakRetracementMinute = parseInt(bar.minute_of_day);
          }
        }
      }
    }

    // Morning rotation count (# times price crosses VWAP-like mid)
    const mornBars = morningDetailByDate[dateStr] || [];
    let rotationCount = 0;
    if (mornBars.length > 1) {
      const midpoint = (mHigh + mLow) / 2;
      let lastSide = parseFloat(mornBars[0].close) >= midpoint ? 'above' : 'below';
      for (let i = 1; i < mornBars.length; i++) {
        const side = parseFloat(mornBars[i].close) >= midpoint ? 'above' : 'below';
        if (side !== lastSide) {
          rotationCount++;
          lastSide = side;
        }
      }
    }

    // Morning close position in range (0 = closed at low, 1 = closed at high)
    const mCloseInRange = mRange > 0 ? (mClose - mLow) / mRange : 0.5;

    days.push({
      date: dateStr,
      mOpen, mHigh, mLow, mClose, mMove, mRange, mMag, mVolume,
      aOpen, aHigh, aLow, aClose, aMove, aRange, aVolume,
      morningDir,
      retracementPct,
      maxRetracementPct,
      continuationPct,
      afternoonDirection,
      peakRetracementMinute,
      rotationCount,
      mCloseInRange,
    });
  }

  // ─── 2. SECTION: Overall Morning Classification ─────────────────────────────
  const upDays = days.filter(d => d.morningDir === 'UP');
  const downDays = days.filter(d => d.morningDir === 'DOWN');
  const flatDays = days.filter(d => d.morningDir === 'FLAT');
  const directionalDays = days.filter(d => d.morningDir !== 'FLAT');

  console.log('━'.repeat(100));
  console.log('  SECTION 1: MORNING SESSION CLASSIFICATION');
  console.log('━'.repeat(100));
  console.log(`  Total days analyzed:  ${days.length}`);
  console.log(`  UP mornings (>50pt):  ${upDays.length} (${pct(upDays.length, days.length)})`);
  console.log(`  DOWN mornings (<-50): ${downDays.length} (${pct(downDays.length, days.length)})`);
  console.log(`  FLAT mornings:        ${flatDays.length} (${pct(flatDays.length, days.length)})`);
  console.log();
  console.log(`  Avg UP morning move:   +${avg(upDays.map(d => d.mMove)).toFixed(1)} pts (range: ${avg(upDays.map(d => d.mRange)).toFixed(1)})`);
  console.log(`  Avg DOWN morning move: ${avg(downDays.map(d => d.mMove)).toFixed(1)} pts (range: ${avg(downDays.map(d => d.mRange)).toFixed(1)})`);
  console.log(`  Avg FLAT morning move: ${avg(flatDays.map(d => d.mMove)).toFixed(1)} pts (range: ${avg(flatDays.map(d => d.mRange)).toFixed(1)})`);
  console.log();

  // ─── 3. SECTION: Retracement by Morning Move Size ──────────────────────────
  console.log('━'.repeat(100));
  console.log('  SECTION 2: AFTERNOON RETRACEMENT BY MORNING MOVE SIZE');
  console.log('━'.repeat(100));

  const buckets = [
    { label: 'Small (50-150pt)', filter: d => d.mMag >= 50 && d.mMag < 150 },
    { label: 'Medium (150-300pt)', filter: d => d.mMag >= 150 && d.mMag < 300 },
    { label: 'Large (300-500pt)', filter: d => d.mMag >= 300 && d.mMag < 500 },
    { label: 'Flush/Drive (500pt+)', filter: d => d.mMag >= 500 },
  ];

  for (const bucket of buckets) {
    const subset = directionalDays.filter(bucket.filter);
    if (subset.length === 0) {
      console.log(`\n  ${bucket.label}: N=0\n`);
      continue;
    }

    const maxRetraces = subset.map(d => d.maxRetracementPct);
    const closeRetraces = subset.map(d => d.retracementPct);

    console.log(`\n  ${bucket.label} (N=${subset.length})`);
    console.log(`  ${'─'.repeat(60)}`);
    console.log(`  Max retracement (intraday):  avg=${avg(maxRetraces).toFixed(1)}%  med=${median(maxRetraces).toFixed(1)}%`);
    console.log(`  Close-based retracement:     avg=${avg(closeRetraces).toFixed(1)}%  med=${median(closeRetraces).toFixed(1)}%`);
    console.log(`  Retrace >50% (max):   ${pct(maxRetraces.filter(r => r > 50).length, subset.length)} of days`);
    console.log(`  Retrace >75% (max):   ${pct(maxRetraces.filter(r => r > 75).length, subset.length)} of days`);
    console.log(`  Full retrace >100%:   ${pct(maxRetraces.filter(r => r > 100).length, subset.length)} of days`);
    console.log(`  Retrace >150%:        ${pct(maxRetraces.filter(r => r > 150).length, subset.length)} of days (overshoot)`);
  }

  // ─── 4. SECTION: Continuation vs Retracement ────────────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 3: CONTINUATION vs RETRACEMENT (on close)');
  console.log('━'.repeat(100));

  const contDays = directionalDays.filter(d => d.afternoonDirection === 'CONTINUATION');
  const retDays = directionalDays.filter(d => d.afternoonDirection === 'RETRACEMENT');

  console.log(`\n  Afternoons that CONTINUE morning direction: ${contDays.length} (${pct(contDays.length, directionalDays.length)})`);
  console.log(`  Afternoons that RETRACE morning direction:  ${retDays.length} (${pct(retDays.length, directionalDays.length)})`);

  const contAmts = contDays.map(d => d.continuationPct);
  const retAmts = retDays.map(d => Math.abs(d.continuationPct));

  console.log(`\n  Continuation extent (% of morning move added):`);
  console.log(`    Avg: ${avg(contAmts).toFixed(1)}%   Median: ${median(contAmts).toFixed(1)}%   P75: ${percentile(contAmts, 75).toFixed(1)}%   P90: ${percentile(contAmts, 90).toFixed(1)}%`);

  console.log(`\n  Retracement extent (% of morning move given back):`);
  console.log(`    Avg: ${avg(retAmts).toFixed(1)}%   Median: ${median(retAmts).toFixed(1)}%   P75: ${percentile(retAmts, 75).toFixed(1)}%   P90: ${percentile(retAmts, 90).toFixed(1)}%`);

  // By direction
  for (const dir of ['UP', 'DOWN']) {
    const sub = directionalDays.filter(d => d.morningDir === dir);
    const cont = sub.filter(d => d.afternoonDirection === 'CONTINUATION');
    const ret = sub.filter(d => d.afternoonDirection === 'RETRACEMENT');
    console.log(`\n  After ${dir} morning (N=${sub.length}):`);
    console.log(`    Continue: ${cont.length} (${pct(cont.length, sub.length)})  avg extent: ${avg(cont.map(d => d.continuationPct)).toFixed(1)}%`);
    console.log(`    Retrace:  ${ret.length} (${pct(ret.length, sub.length)})  avg extent: ${avg(ret.map(d => Math.abs(d.continuationPct))).toFixed(1)}%`);
  }

  // ─── 5. SECTION: Retracement by Move Size — Cont vs Ret Breakdown ──────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 3b: CONTINUATION vs RETRACEMENT BY MOVE SIZE');
  console.log('━'.repeat(100));

  for (const bucket of buckets) {
    const subset = directionalDays.filter(bucket.filter);
    if (subset.length < 5) continue;
    const cont = subset.filter(d => d.afternoonDirection === 'CONTINUATION');
    const ret = subset.filter(d => d.afternoonDirection === 'RETRACEMENT');
    console.log(`\n  ${bucket.label} (N=${subset.length})`);
    console.log(`    Continue: ${cont.length} (${pct(cont.length, subset.length)})  avg add: ${avg(cont.map(d => d.continuationPct)).toFixed(1)}%`);
    console.log(`    Retrace:  ${ret.length} (${pct(ret.length, subset.length)})  avg giveback: ${avg(ret.map(d => Math.abs(d.continuationPct))).toFixed(1)}%`);
  }

  // ─── 6. SECTION: Time of Peak Retracement ──────────────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 4: WHEN DOES PEAK RETRACEMENT HAPPEN?');
  console.log('━'.repeat(100));

  const timeSlots = [
    { label: '12:30-1:00 PM', min: 750, max: 779 },
    { label: '1:00-1:30 PM',  min: 780, max: 809 },
    { label: '1:30-2:00 PM',  min: 810, max: 839 },
    { label: '2:00-2:30 PM',  min: 840, max: 869 },
    { label: '2:30-3:00 PM',  min: 870, max: 899 },
    { label: '3:00-3:30 PM',  min: 900, max: 929 },
    { label: '3:30-4:00 PM',  min: 930, max: 959 },
  ];

  // Only days with meaningful retracement (>10% of morning move)
  const retracingDays = directionalDays.filter(d => d.maxRetracementPct > 10 && d.peakRetracementMinute != null);

  console.log(`\n  ${pad('Time Window', 20)} ${padL('Count', 8)} ${padL('% of Total', 12)} ${padL('Avg MaxRet%', 14)}`);
  console.log(`  ${'─'.repeat(60)}`);

  for (const slot of timeSlots) {
    const inSlot = retracingDays.filter(d => d.peakRetracementMinute >= slot.min && d.peakRetracementMinute <= slot.max);
    const avgMax = avg(inSlot.map(d => d.maxRetracementPct));
    console.log(`  ${pad(slot.label, 20)} ${padL(inSlot.length, 8)} ${padL(pct(inSlot.length, retracingDays.length), 12)} ${padL(avgMax.toFixed(1) + '%', 14)}`);
  }

  // ─── 7. SECTION: Retracement by Day Characteristics ────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 5: RETRACEMENT BY DAY CHARACTERISTICS');
  console.log('━'.repeat(100));

  // 5a. RVol (relative volume)
  const allMornVols = days.map(d => d.mVolume);
  const avgMornVol = avg(allMornVols);
  const highRVol = directionalDays.filter(d => d.mVolume > avgMornVol * 1.2);
  const lowRVol = directionalDays.filter(d => d.mVolume < avgMornVol * 0.8);

  console.log(`\n  5a. Morning RVol (avg morning volume = ${Math.round(avgMornVol).toLocaleString()})`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  High RVol (>1.2x avg) — N=${highRVol.length}`);
  console.log(`    Max retracement: avg=${avg(highRVol.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(highRVol.map(d => d.maxRetracementPct)).toFixed(1)}%`);
  console.log(`    Continuation rate: ${pct(highRVol.filter(d => d.afternoonDirection === 'CONTINUATION').length, highRVol.length)}`);
  console.log(`  Low RVol (<0.8x avg) — N=${lowRVol.length}`);
  console.log(`    Max retracement: avg=${avg(lowRVol.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(lowRVol.map(d => d.maxRetracementPct)).toFixed(1)}%`);
  console.log(`    Continuation rate: ${pct(lowRVol.filter(d => d.afternoonDirection === 'CONTINUATION').length, lowRVol.length)}`);

  // 5b. Morning rotation count
  const lowRot = directionalDays.filter(d => d.rotationCount <= 4);
  const midRot = directionalDays.filter(d => d.rotationCount >= 5 && d.rotationCount <= 10);
  const highRot = directionalDays.filter(d => d.rotationCount > 10);

  console.log(`\n  5b. Morning Rotation Count (crosses of session midpoint)`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const [label, subset] of [['Low (0-4)', lowRot], ['Mid (5-10)', midRot], ['High (11+)', highRot]]) {
    if (subset.length === 0) continue;
    console.log(`  ${label} rotations — N=${subset.length}`);
    console.log(`    Max retracement: avg=${avg(subset.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(subset.map(d => d.maxRetracementPct)).toFixed(1)}%`);
    console.log(`    Continuation rate: ${pct(subset.filter(d => d.afternoonDirection === 'CONTINUATION').length, subset.length)}`);
  }

  // 5c. Morning close position in range
  const closedAtLows = directionalDays.filter(d =>
    (d.morningDir === 'DOWN' && d.mCloseInRange < 0.25) ||
    (d.morningDir === 'UP' && d.mCloseInRange > 0.75)
  );
  const closedMidRange = directionalDays.filter(d => d.mCloseInRange >= 0.25 && d.mCloseInRange <= 0.75);
  const closedAgainst = directionalDays.filter(d =>
    (d.morningDir === 'DOWN' && d.mCloseInRange > 0.75) ||
    (d.morningDir === 'UP' && d.mCloseInRange < 0.25)
  );

  console.log(`\n  5c. Morning Close Position in Range`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Closed at extremes (with trend) — N=${closedAtLows.length}`);
  console.log(`    Max retracement: avg=${avg(closedAtLows.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(closedAtLows.map(d => d.maxRetracementPct)).toFixed(1)}%`);
  console.log(`    Continuation rate: ${pct(closedAtLows.filter(d => d.afternoonDirection === 'CONTINUATION').length, closedAtLows.length)}`);

  console.log(`  Closed mid-range — N=${closedMidRange.length}`);
  console.log(`    Max retracement: avg=${avg(closedMidRange.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(closedMidRange.map(d => d.maxRetracementPct)).toFixed(1)}%`);
  console.log(`    Continuation rate: ${pct(closedMidRange.filter(d => d.afternoonDirection === 'CONTINUATION').length, closedMidRange.length)}`);

  console.log(`  Closed against trend (extended then pulled back) — N=${closedAgainst.length}`);
  console.log(`    Max retracement: avg=${avg(closedAgainst.map(d => d.maxRetracementPct)).toFixed(1)}%  med=${median(closedAgainst.map(d => d.maxRetracementPct)).toFixed(1)}%`);
  console.log(`    Continuation rate: ${pct(closedAgainst.filter(d => d.afternoonDirection === 'CONTINUATION').length, closedAgainst.length)}`);

  // ─── 8. SECTION: The Money Question ────────────────────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 6: THE MONEY QUESTION — HOLD THROUGH LUNCH OR TAKE PROFITS?');
  console.log('━'.repeat(100));

  // Scenario A: Take profits at 12:30 (pocket the morning move)
  // Scenario B: Hold through close (keep position to 3:59)
  // Scenario C: Take half at 12:30, hold half to close

  console.log(`\n  Assume you caught the morning move perfectly (entry at 9:30 open, direction = morning direction).`);
  console.log(`  PNL_PER_POINT = $${PNL_PER_POINT}, COMMISSION = $${COMMISSION}/RT\n`);

  for (const bucket of buckets) {
    const subset = directionalDays.filter(bucket.filter);
    if (subset.length < 5) continue;

    console.log(`\n  ── ${bucket.label} (N=${subset.length}) ──`);

    const scenarioA_pnls = []; // take profits at 12:30
    const scenarioB_pnls = []; // hold to close
    const scenarioC_pnls = []; // half and half

    for (const d of subset) {
      const morningPnl = d.mMag * PNL_PER_POINT - COMMISSION;

      // Full day move (9:30 open to 4:00 close)
      let fullDayMove;
      if (d.morningDir === 'UP') {
        fullDayMove = d.aClose - d.mOpen;
      } else {
        fullDayMove = d.mOpen - d.aClose;
      }
      const fullDayPnl = fullDayMove * PNL_PER_POINT - COMMISSION;

      // Scenario A: pocket morning move
      scenarioA_pnls.push(morningPnl);

      // Scenario B: hold to close (full day result)
      scenarioB_pnls.push(fullDayPnl);

      // Scenario C: half at 12:30, half at close
      const halfMorning = (d.mMag * PNL_PER_POINT) / 2 - COMMISSION;
      const halfHold = (fullDayMove * PNL_PER_POINT) / 2 - COMMISSION;
      scenarioC_pnls.push(halfMorning + halfHold);
    }

    const printScenario = (label, pnls) => {
      const wins = pnls.filter(p => p > 0).length;
      console.log(`    ${label}:`);
      console.log(`      Avg P&L: $${avg(pnls).toFixed(2)}  |  Med: $${median(pnls).toFixed(2)}  |  Total: $${pnls.reduce((a, b) => a + b, 0).toFixed(2)}`);
      console.log(`      Win Rate: ${pct(wins, pnls.length)}  |  Best: $${Math.max(...pnls).toFixed(2)}  |  Worst: $${Math.min(...pnls).toFixed(2)}`);
    };

    printScenario('A) Take profits at 12:30', scenarioA_pnls);
    printScenario('B) Hold through to 4:00 close', scenarioB_pnls);
    printScenario('C) Half at 12:30, half at close', scenarioC_pnls);

    // EV comparison
    const evDiff = avg(scenarioB_pnls) - avg(scenarioA_pnls);
    console.log(`\n    EV of holding vs taking: $${evDiff.toFixed(2)}/trade (${evDiff > 0 ? 'HOLD' : 'TAKE PROFITS'} wins)`);
  }

  // ─── 9. SECTION: Detailed "hold or fold" by morning close position ────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 6b: HOLD vs TAKE — CONDITIONED ON MORNING CLOSE POSITION');
  console.log('━'.repeat(100));

  for (const [label, subset] of [
    ['Closed at extremes (with trend)', closedAtLows],
    ['Closed mid-range', closedMidRange],
    ['Closed against trend', closedAgainst]
  ]) {
    if (subset.length < 5) continue;
    const scenA = subset.map(d => d.mMag * PNL_PER_POINT - COMMISSION);
    const scenB = subset.map(d => {
      const fdm = d.morningDir === 'UP' ? (d.aClose - d.mOpen) : (d.mOpen - d.aClose);
      return fdm * PNL_PER_POINT - COMMISSION;
    });
    console.log(`\n  ${label} (N=${subset.length})`);
    console.log(`    Take at 12:30 — Avg: $${avg(scenA).toFixed(2)}  Med: $${median(scenA).toFixed(2)}`);
    console.log(`    Hold to close  — Avg: $${avg(scenB).toFixed(2)}  Med: $${median(scenB).toFixed(2)}`);
    console.log(`    EV diff: $${(avg(scenB) - avg(scenA)).toFixed(2)} (${avg(scenB) > avg(scenA) ? 'HOLD' : 'TAKE'} wins)`);
  }

  // ─── 10. SECTION: Maximum Adverse Excursion if holding ─────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 7: MAX ADVERSE EXCURSION IF HOLDING THROUGH AFTERNOON');
  console.log('━'.repeat(100));
  console.log(`\n  If you hold from 12:30, how much heat (drawdown from morning close) do you take?`);

  for (const bucket of buckets) {
    const subset = directionalDays.filter(bucket.filter);
    if (subset.length < 5) continue;

    const maes = subset.map(d => {
      if (d.morningDir === 'UP') return Math.max(0, d.mClose - d.aLow);
      else return Math.max(0, d.aHigh - d.mClose);
    });

    console.log(`\n  ${bucket.label} (N=${subset.length})`);
    console.log(`    MAE:  avg=${avg(maes).toFixed(1)}pt  med=${median(maes).toFixed(1)}pt  P75=${percentile(maes, 75).toFixed(1)}pt  P90=${percentile(maes, 90).toFixed(1)}pt  max=${Math.max(...maes).toFixed(1)}pt`);
    console.log(`    MAE$: avg=$${(avg(maes) * PNL_PER_POINT).toFixed(2)}  P90=$${(percentile(maes, 90) * PNL_PER_POINT).toFixed(2)}  max=$${(Math.max(...maes) * PNL_PER_POINT).toFixed(2)}`);
  }

  // ─── 11. SECTION: Progressive Exit Analysis ───────────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  SECTION 8: PROGRESSIVE TIME-BASED EXIT (Holding from 12:30)');
  console.log('━'.repeat(100));
  console.log(`\n  Shows avg P&L of exiting at each half-hour after noon if you caught the morning move.`);

  const exitTimes = [
    { label: '12:30 (take profits)', minute: 750 },
    { label: '1:00 PM', minute: 780 },
    { label: '1:30 PM', minute: 810 },
    { label: '2:00 PM', minute: 840 },
    { label: '2:30 PM', minute: 870 },
    { label: '3:00 PM', minute: 900 },
    { label: '3:30 PM', minute: 930 },
    { label: '3:59 PM (close)', minute: 959 },
  ];

  // For each directional day, compute P&L at each exit time
  console.log(`\n  ${pad('Exit Time', 25)} ${padL('Avg P&L', 10)} ${padL('Med P&L', 10)} ${padL('Win%', 8)} ${padL('Avg Pts', 10)} ${padL('N', 6)}`);
  console.log(`  ${'─'.repeat(75)}`);

  for (const exit of exitTimes) {
    const pnls = [];
    for (const d of directionalDays) {
      const dateStr = d.date;
      const bars = detailByDate[dateStr] || [];

      if (exit.minute === 750) {
        // Just the morning move
        pnls.push(d.mMag * PNL_PER_POINT - COMMISSION);
        continue;
      }

      // Find the close price at or near the exit minute
      let exitPrice = null;
      for (const bar of bars) {
        if (parseInt(bar.minute_of_day) <= exit.minute) {
          exitPrice = parseFloat(bar.close);
        }
      }
      if (exitPrice == null) continue;

      let pts;
      if (d.morningDir === 'UP') {
        pts = exitPrice - d.mOpen;
      } else {
        pts = d.mOpen - exitPrice;
      }
      pnls.push(pts * PNL_PER_POINT - COMMISSION);
    }

    const wins = pnls.filter(p => p > 0).length;
    const avgPts = (avg(pnls) + COMMISSION) / PNL_PER_POINT; // back out commission to get pts
    console.log(`  ${pad(exit.label, 25)} ${padL('$' + avg(pnls).toFixed(2), 10)} ${padL('$' + median(pnls).toFixed(2), 10)} ${padL(pct(wins, pnls.length), 8)} ${padL(avgPts.toFixed(1), 10)} ${padL(pnls.length, 6)}`);
  }

  // ─── 12. PRACTICAL TAKEAWAYS ──────────────────────────────────────────────
  console.log('\n' + '━'.repeat(100));
  console.log('  PRACTICAL TAKEAWAYS');
  console.log('━'.repeat(100));

  const contRate = contDays.length / directionalDays.length;
  const avgMaxRet = avg(directionalDays.map(d => d.maxRetracementPct));

  // Find the best exit time
  const exitTimeResults = [];
  for (const exit of exitTimes) {
    const pnls = [];
    for (const d of directionalDays) {
      const bars = detailByDate[d.date] || [];
      if (exit.minute === 750) {
        pnls.push(d.mMag * PNL_PER_POINT - COMMISSION);
        continue;
      }
      let exitPrice = null;
      for (const bar of bars) {
        if (parseInt(bar.minute_of_day) <= exit.minute) exitPrice = parseFloat(bar.close);
      }
      if (exitPrice == null) continue;
      const pts = d.morningDir === 'UP' ? exitPrice - d.mOpen : d.mOpen - exitPrice;
      pnls.push(pts * PNL_PER_POINT - COMMISSION);
    }
    exitTimeResults.push({ label: exit.label, avgPnl: avg(pnls), medPnl: median(pnls) });
  }
  const bestExit = exitTimeResults.reduce((best, e) => e.avgPnl > best.avgPnl ? e : best);

  console.log(`
  1. After a directional morning (>50pt move), afternoons CONTINUE ${(contRate * 100).toFixed(0)}% of the time.
     Average max retracement: ${avgMaxRet.toFixed(0)}% of the morning move.

  2. Best average exit time: ${bestExit.label} (avg P&L $${bestExit.avgPnl.toFixed(2)})

  3. Morning close position matters:
     - Closing at extremes (with trend): ${pct(closedAtLows.filter(d => d.afternoonDirection === 'CONTINUATION').length, closedAtLows.length)} continuation rate
     - Closing against trend: ${pct(closedAgainst.filter(d => d.afternoonDirection === 'CONTINUATION').length, closedAgainst.length)} continuation rate

  4. Volume signal:
     - High RVol continuation: ${pct(highRVol.filter(d => d.afternoonDirection === 'CONTINUATION').length, highRVol.length)}
     - Low RVol continuation: ${pct(lowRVol.filter(d => d.afternoonDirection === 'CONTINUATION').length, lowRVol.length)}
  `);

  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
