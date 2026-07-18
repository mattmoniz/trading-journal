// Dry-run only. Does NOT write to trades.setup_type. See docs/OPEN_THREADS.md
// (OPEN_DECISION real_trades_zero_setup_attribution) for why this is scoped to
// origin_status='ACTIVE' setups only, and why the honest matchable window is
// tiny (starts 2026-07-09, the day origin_status began being populated).
import { query } from '../server/db.js';

function inferDirection(setupType) {
  if (/LONG|UP|BULLISH/.test(setupType)) return 'LONG';
  if (/SHORT|DOWN|BEARISH/.test(setupType)) return 'SHORT';
  return null;
}

const TIME_WINDOW_MIN = 15;    // how long after a setup fires a real entry could plausibly reference it
const PRICE_TOLERANCE_PTS = 80; // loosened after dry-run v1: real entries land 12-75pts from
// price_at_detection within a 15min window on this instrument's real intraday volatility --
// an 8pt tolerance (naive guess) matched zero of 51 real trades. Price proximity is a weak
// signal here; time+direction carries most of the real discriminating power.

async function main() {
  const { rows: today } = await query(`SELECT CURRENT_DATE::text as today`);
  console.log(`Dry run @ ${today[0].today}\n`);

  const { rows: trades } = await query(`
    SELECT id, log_date, entry_time, direction, entry_price
    FROM trades
    WHERE log_date >= '2026-07-09' AND setup_type IS NULL
    ORDER BY entry_time
  `);
  // fired_at is stored naive-ET (see acd.js:581-582 comment) while trades.entry_time is a
  // real UTC instant -- convert fired_at to a true UTC instant here or every comparison
  // below is silently off by 4-5 hours (EDT/EST) and matches nothing.
  const { rows: setups } = await query(`
    SELECT id, setup_type, (fired_at AT TIME ZONE 'America/New_York') as fired_at_utc,
           price_at_detection, entry_zone_low, entry_zone_high
    FROM active_setups
    WHERE origin_status = 'ACTIVE'
    ORDER BY fired_at
  `);

  console.log(`Candidate trades: ${trades.length}, candidate ACTIVE setups: ${setups.length}\n`);

  let matched = 0;
  const results = [];
  for (const t of trades) {
    const tEntry = new Date(t.entry_time);
    let best = null;
    for (const s of setups) {
      const dir = inferDirection(s.setup_type);
      if (dir && dir !== t.direction) continue;
      const sFired = new Date(s.fired_at_utc);
      const deltaMin = (tEntry - sFired) / 60000;
      if (deltaMin < -1 || deltaMin > TIME_WINDOW_MIN) continue; // allow 1 min of clock skew before fire
      const refPrice = s.price_at_detection ?? ((Number(s.entry_zone_low) + Number(s.entry_zone_high)) / 2);
      if (refPrice == null || Number.isNaN(refPrice)) continue;
      const deltaPts = Math.abs(Number(t.entry_price) - Number(refPrice));
      if (deltaPts > PRICE_TOLERANCE_PTS) continue;
      // confidence: closer in time and price = better. Simple weighted score, lower = better.
      const score = (deltaMin / TIME_WINDOW_MIN) + (deltaPts / PRICE_TOLERANCE_PTS);
      if (!best || score < best.score) best = { setup: s, deltaMin, deltaPts, score };
    }
    if (best) {
      matched++;
      results.push({ trade_id: t.id, log_date: t.log_date, direction: t.direction,
        setup_type: best.setup.setup_type, deltaMin: best.deltaMin.toFixed(1), deltaPts: best.deltaPts.toFixed(2),
        confidence: (1 - best.score / 2).toFixed(2) });
    }
  }

  console.log(`Matched ${matched} / ${trades.length} real trades to a genuinely-live ACTIVE setup.\n`);
  console.log('Matches (dry run, nothing written):');
  console.table(results);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
