// Confluence routes — /api/confluence/today (lines ~8065-8436)
// and /api/acd/confluence is already in acd.js

import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// GET /api/confluence/today — 12-condition confluence score
// Full implementation: lines 8066-8435 of original index.js
// This route is very large (370 lines) — extracted verbatim

router.get('/confluence/today', async (req, res) => {
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowET   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etMin   = nowET.getHours() * 60 + nowET.getMinutes();

    const arQ = await query(`SELECT * FROM auction_reads WHERE trade_date=$1`, [todayET]);
    const ar  = arQ.rows[0] || {};

    const nlQ = await query(`
      SELECT
        SUM(daily_score)::int as nl30,
        SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '10 days' THEN daily_score ELSE 0 END)::int as nl10,
        SUM(CASE WHEN trade_date >= ($1::text)::date - INTERVAL '5 days'  THEN daily_score ELSE 0 END)::int as nl5
      FROM acd_daily_log
      WHERE trade_date < ($1::text)::date AND trade_date >= ($1::text)::date - INTERVAL '30 days'
    `, [todayET]);
    const nl30 = nlQ.rows[0]?.nl30 || 0;
    const nl10 = nlQ.rows[0]?.nl10 || 0;

    const vaQ = await query(`
      WITH days AS (
        SELECT DISTINCT ts::date as d FROM price_bars_primary WHERE symbol='NQ'
          AND ts::date < ($1::text)::date AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        ORDER BY d DESC LIMIT 5
      )
      SELECT d, (
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=days.d
            AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        poc_row AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT poc_row.px FROM poc_row LIMIT 1
      ) as poc
      FROM days ORDER BY d DESC
    `, [todayET]);
    const pocDays = vaQ.rows.map(r => parseFloat(r.poc)).filter(Boolean);
    let valueMigration = 'OVERLAPPING';
    if (pocDays.length >= 3) {
      let up = 0, down = 0;
      for (let i = 1; i < pocDays.length; i++) {
        if (pocDays[i-1] > pocDays[i]) up++;
        else if (pocDays[i-1] < pocDays[i]) down++;
      }
      if (up >= 3) valueMigration = 'HIGHER';
      else if (down >= 3) valueMigration = 'LOWER';
    }

    const monthYear = todayET.slice(0,7);
    const pivotQ    = await query(`SELECT pivot_level, pivot_r1, pivot_s1 FROM acd_monthly_pivot WHERE month_year=$1`, [monthYear]);
    const pivotLevel = pivotQ.rows[0]?.pivot_level ? parseFloat(pivotQ.rows[0].pivot_level) : null;
    const pivotR1    = pivotQ.rows[0]?.pivot_r1 ? parseFloat(pivotQ.rows[0].pivot_r1) : null;
    const pivotS1    = pivotQ.rows[0]?.pivot_s1 ? parseFloat(pivotQ.rows[0].pivot_s1) : null;
    const currentPriceQ = await query(`SELECT close::float as close FROM price_bars_primary WHERE symbol='NQ' ORDER BY ts DESC LIMIT 1`);
    const currentPrice = currentPriceQ.rows[0]?.close || 0;
    const monthlyPivotPos = pivotR1 && pivotS1 && currentPrice
      ? (currentPrice > pivotR1 ? 'ABOVE_PIVOT_RANGE' : currentPrice < pivotS1 ? 'BELOW_PIVOT_RANGE' : 'INSIDE_PIVOT_RANGE')
      : null;

    const evQ = await query(`SELECT setup_type, fired_time FROM acd_setup_events WHERE trade_date=$1 ORDER BY fired_time ASC`, [todayET]);
    const events = evQ.rows;
    const aUpFired    = events.some(e => e.setup_type === 'A Up fired');
    const aDownFired  = events.some(e => e.setup_type === 'A Down fired');
    const cUpFired    = events.some(e => e.setup_type === 'C Up confirmed' || e.setup_type === 'C Up (no A)');
    const cDownFired  = events.some(e => e.setup_type === 'C Down confirmed' || e.setup_type === 'C Down (no A)');

    let bias;
    if (nl30 > 9)                          bias = 'BULLISH';
    else if (nl30 < -9)                    bias = 'BEARISH';
    else if (valueMigration === 'HIGHER')  bias = 'BULLISH_LEAN';
    else if (valueMigration === 'LOWER')   bias = 'BEARISH_LEAN';
    else                                   bias = 'NEUTRAL';

    const isBull = bias === 'BULLISH' || bias === 'BULLISH_LEAN';
    const isBear = bias === 'BEARISH' || bias === 'BEARISH_LEAN';

    const aSignalOverride = ar.a_signal_override || null;
    const aSignalDir = aSignalOverride?.startsWith('A_UP') ? 'BULLISH'
                     : aSignalOverride?.startsWith('A_DOWN') ? 'BEARISH' : null;
    const aSignalQuality = aSignalOverride?.endsWith('_STRONG') ? 'STRONG'
                         : aSignalOverride?.endsWith('_WEAK')   ? 'WEAK'
                         : aSignalOverride?.endsWith('_FAILED') ? 'FAILED' : null;

    const effectiveADir = aSignalDir || (aUpFired ? 'BULLISH' : aDownFired ? 'BEARISH' : null);
    const aSignalFailed = aSignalQuality === 'FAILED' ||
      (!aUpFired && !aDownFired && events.some(e => e.setup_type?.startsWith('Failed')));

    const inefficientProfiles = ['TREND', 'NORMAL_VARIATION'];
    const marketState = ar.prior_day_profile
      ? (inefficientProfiles.includes(ar.prior_day_profile) ? 'INEFFICIENT' : 'EFFICIENT')
      : null;

    const preOpen    = etMin < 9 * 60 + 30;
    const postOpen   = etMin >= 9 * 60 + 30;
    const postLocked = etMin >= 9 * 60 + 45;

    const structDir = isBull ? 'BULLISH' : isBear ? 'BEARISH' : 'NEUTRAL';

    const conditions = [
      {
        id: 'c1', label: 'NL30 trend confirmed',
        available: true,
        met: nl30 > 9 || nl30 < -9,
        value: `${nl30 > 0 ? '+' : ''}${nl30}`,
        reason: nl30 > 9 ? 'Confirmed uptrend (+9 threshold)' : nl30 < -9 ? 'Confirmed downtrend (-9 threshold)' : 'Ranging — no sustained OTF conviction',
      },
      {
        id: 'c2', label: 'NL10 aligned — no momentum divergence',
        available: true,
        met: (nl30 > 9 && nl10 > 0) || (nl30 < -9 && nl10 < 0) || (Math.abs(nl30) <= 9),
        value: `${nl10 > 0 ? '+' : ''}${nl10}`,
        reason: (nl30 > 9 && nl10 < 0) ? 'Divergence: NL30 bullish but NL10 negative — momentum weakening'
              : (nl30 < -9 && nl10 > 0) ? 'Divergence: NL30 bearish but NL10 positive — momentum weakening'
              : 'No divergence',
      },
      {
        id: 'c3', label: 'Open location supports bias direction',
        available: !!ar.open_vs_prior_value,
        met: (isBull && ar.open_vs_prior_value === 'ABOVE_VALUE') ||
             (isBear && ar.open_vs_prior_value === 'BELOW_VALUE') ||
             (bias === 'BULLISH_LEAN' && ar.open_vs_prior_value !== 'BELOW_VALUE') ||
             (bias === 'BEARISH_LEAN' && ar.open_vs_prior_value !== 'ABOVE_VALUE'),
        value: ar.open_vs_prior_value?.replace(/_/g, ' ') || null,
        reason: !ar.open_vs_prior_value ? 'Not yet logged' : null,
      },
      {
        id: 'c4', label: 'Overnight inventory trapped in bias direction',
        available: !!ar.overnight_inventory,
        met: (isBull && ar.overnight_inventory === 'SHORT_TRAPPED') ||
             (isBear && ar.overnight_inventory === 'LONG_TRAPPED'),
        value: ar.overnight_inventory?.replace(/_/g, ' ') || null,
        reason: ar.overnight_inventory === 'NEUTRAL' ? 'Neutral — no trapped fuel' : null,
      },
      {
        id: 'c5', label: 'Market state matches playbook',
        available: !!marketState,
        met: ((isBull || isBear) && marketState === 'INEFFICIENT') ||
             ((bias === 'BULLISH_LEAN' || bias === 'BEARISH_LEAN') && marketState === 'EFFICIENT'),
        value: marketState,
        reason: !marketState ? 'No prior day profile logged' : null,
      },
      {
        id: 'c6', label: 'Monthly pivot zone aligned with bias',
        available: !!monthlyPivotPos,
        met: (isBull && monthlyPivotPos === 'ABOVE_PIVOT_RANGE') ||
             (isBear && monthlyPivotPos === 'BELOW_PIVOT_RANGE'),
        value: monthlyPivotPos?.replace(/_/g, ' ') || null,
        reason: monthlyPivotPos === 'INSIDE_PIVOT_RANGE' ? 'Inside pivot range — monthly bias neutral' : !monthlyPivotPos ? 'Monthly pivot not logged' : null,
      },
      {
        id: 'c7', label: 'Value migrating in bias direction (5-session)',
        available: pocDays.length >= 3,
        met: (isBull && valueMigration === 'HIGHER') || (isBear && valueMigration === 'LOWER'),
        value: valueMigration,
        reason: pocDays.length < 3 ? 'Insufficient history' : valueMigration === 'OVERLAPPING' ? 'Value overlapping — balanced' : null,
      },
      {
        id: 'c8', label: 'OR condition favorable (narrow/normal)',
        available: postOpen && !!ar.or_condition,
        met: ar.or_condition === 'NARROW' || ar.or_condition === 'NORMAL',
        value: ar.or_condition,
        reason: !postOpen ? 'Waiting for open' : !ar.or_condition ? 'Not yet logged'
              : (ar.or_condition === 'WIDE' || ar.or_condition === 'EMOTIONAL') ? 'Wide/emotional OR reduces A signal quality' : null,
      },
      {
        id: 'c9', label: 'Opening call supports directional conviction',
        available: postOpen && !!ar.opening_call_type,
        met: ar.opening_call_type === 'OPEN_DRIVE' || ar.opening_call_type === 'OPEN_TEST_DRIVE',
        value: ar.opening_call_type?.replace(/_/g, ' ') || null,
        reason: !postOpen ? 'Waiting for open' : !ar.opening_call_type ? 'Not yet logged' : null,
      },
      {
        id: 'c10', label: 'A signal fired and sustained',
        available: postOpen,
        met: !!effectiveADir && !aSignalFailed,
        value: effectiveADir ? `A ${effectiveADir === 'BULLISH' ? 'Up' : 'Down'} fired` : null,
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'No A signal fired yet'
              : aSignalFailed ? 'A signal failed — did not sustain' : null,
        note: effectiveADir && structDir !== 'NEUTRAL' && effectiveADir !== structDir
              ? `Counter-trend vs NL30 ${structDir.toLowerCase()} — directional context, not a scoring penalty` : null,
      },
      {
        id: 'c11', label: 'A signal quality: strong',
        available: postOpen,
        met: aSignalQuality === 'STRONG',
        value: aSignalQuality || (effectiveADir ? 'not assessed' : null),
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'No A signal yet — set quality in Opening Read'
              : aSignalQuality === 'WEAK' ? 'Signal quality: WEAK — slow grind, overlapping bars'
              : aSignalQuality === 'FAILED' ? 'Signal quality: FAILED — trap, potential reversal'
              : !aSignalQuality ? 'Quality not yet assessed — set in Opening Read (A signal override)'
              : null,
      },
      {
        id: 'c12', label: 'C signal confirmed',
        available: postOpen,
        met: (effectiveADir === 'BULLISH' && cUpFired) || (effectiveADir === 'BEARISH' && cDownFired),
        value: cUpFired ? 'C Up confirmed' : cDownFired ? 'C Down confirmed' : null,
        reason: !postOpen ? 'Waiting for open'
              : !effectiveADir ? 'Waiting for A signal first'
              : 'C signal not yet fired',
      },
    ];

    const structConds     = conditions.slice(0, 7);
    const structScore     = structConds.filter(c => c.available && c.met).length;
    const structBias      = bias;

    const structLabel = structScore >= 6 ? 'STRONG' : structScore >= 4 ? 'MODERATE' : structScore >= 2 ? 'WEAK' : 'NEUTRAL';
    const structColor = structDir === 'BULLISH' ? '#22c55e' : structDir === 'BEARISH' ? '#ef4444' : '#64748b';

    const sessConds   = conditions.slice(7);
    const sessScore   = sessConds.filter(c => c.available && c.met).length;
    const sessDir     = effectiveADir || null;
    const sessAvail   = sessConds.some(c => c.available);

    const sessLabel = !sessDir ? 'NO SIGNAL' : sessScore >= 4 ? 'HIGH CONVICTION' : sessScore >= 2 ? 'MODERATE' : 'LOW';
    const sessColor = sessDir === 'BULLISH' ? '#22c55e' : sessDir === 'BEARISH' ? '#ef4444' : '#64748b';

    let alignment, alignColor, alignNote;
    if (!sessDir || !structDir || structDir === 'NEUTRAL') {
      alignment  = 'NEUTRAL';
      alignColor = '#64748b';
      alignNote  = !sessDir ? 'No A signal fired yet — structural context only' : 'Neutral structural bias — no directional tailwind';
    } else if (structDir === sessDir) {
      alignment  = 'ALIGNED';
      alignColor = '#22c55e';
      alignNote  = `Both structural (${structDir}) and session (${sessDir}) point the same direction — highest quality setup condition.`;
    } else {
      alignment  = 'COUNTER_TREND';
      alignColor = '#fbbf24';
      alignNote  = `A signal (${sessDir}) is counter-trend to structural bias (${structDir}). Reduced conviction. Tighter targets. No overnight.`;
    }

    // Always compute composite (5d) VA profile — needed for NO_SETUP reference levels
    const ctVaQ = await query(`
      WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
        FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= CURRENT_DATE-5 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16
        GROUP BY ROUND(low/0.25)*0.25),
      total AS (SELECT SUM(vol) as t FROM vp),
      poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT p.poc_px::float as poc,
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
      FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
    `);
    const ctVa = ctVaQ.rows[0] || {};
    const compositeProfile = {
      poc: ctVa.poc ? Math.round(ctVa.poc) : null,
      vah: ctVa.vah ? Math.round(ctVa.vah) : null,
      val: ctVa.val ? Math.round(ctVa.val) : null,
    };

    let counterTrendData = null;
    if (alignment === 'COUNTER_TREND') {

      const priorVaQ = await query(`
        WITH vp AS (SELECT ROUND(low/0.25)*0.25 as px, SUM(volume) as vol
          FROM price_bars_primary WHERE symbol='NQ' AND ts::date=(SELECT MAX(ts::date) FROM price_bars_primary WHERE symbol='NQ' AND ts::date<CURRENT_DATE AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16)
          AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
        total AS (SELECT SUM(vol) as t FROM vp),
        poc_row AS (SELECT px as poc_px FROM vp ORDER BY vol DESC LIMIT 1)
        SELECT p.poc_px::float as poc,
          (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as vah,
          (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p.poc_px) x WHERE cv<=(SELECT t*0.35 FROM total))::float as val
        FROM vp, poc_row p GROUP BY p.poc_px LIMIT 1
      `);
      const priorVa = priorVaQ.rows[0] || {};

      const currentPx = currentPrice;
      const isShort   = sessDir === 'BEARISH';

      const allLevels = [
        ctVa.vah   && { price: Math.round(ctVa.vah),   label: '5d Composite VAH', type: 'resistance' },
        ctVa.poc   && { price: Math.round(ctVa.poc),   label: '5d Composite POC — median 37pts', type: isShort ? 'support' : 'resistance' },
        ctVa.val   && { price: Math.round(ctVa.val),   label: '5d Composite VAL', type: 'support' },
        priorVa.vah && { price: Math.round(priorVa.vah), label: 'Prior Day VAH — median 33pts', type: 'resistance' },
        priorVa.poc && { price: Math.round(priorVa.poc), label: 'Prior Day POC — median 37pts', type: 'neutral' },
        priorVa.val && { price: Math.round(priorVa.val), label: 'Prior Day VAL', type: 'support' },
      ].filter(Boolean);

      const targets   = allLevels
        .filter(l => isShort ? l.price < currentPx : l.price > currentPx)
        .sort((a,b) => isShort ? b.price - a.price : a.price - b.price);
      const headwinds = allLevels
        .filter(l => isShort ? l.price > currentPx : l.price < currentPx)
        .sort((a,b) => isShort ? a.price - b.price : b.price - a.price);

      const nearestTarget   = targets[0] || null;
      const nearestHeadwind = headwinds[0] || null;

      const mgmtRule = isShort
        ? `Exit at first structural support (${nearestTarget?.price || 'POC'}). No overnight. Exit immediately if price reclaims OR High.`
        : `Exit at first structural resistance (${nearestTarget?.price || 'POC'}). No overnight. Exit immediately if price breaks OR Low.`;

      counterTrendData = {
        direction: sessDir,
        structuralBias: structDir,
        targets, headwinds,
        nearestTarget, nearestHeadwind,
        t1: nearestTarget?.price || null,
        mgmtRule,
        compositePOC: Math.round(ctVa.poc || 0),
        compositeVAH: Math.round(ctVa.vah || 0),
        compositeVAL: Math.round(ctVa.val || 0),
        priorVAH: Math.round(priorVa.vah || 0),
        priorVAL: Math.round(priorVa.val || 0),
      };
    }

    const score     = structScore + sessScore;
    const trueMax   = 12 - conditions.filter(c => c.available && !c.met && (
      (c.id === 'c4' && ar.overnight_inventory === 'NEUTRAL') ||
      (c.id === 'c6' && monthlyPivotPos === 'INSIDE_PIVOT_RANGE')
    )).length;
    const missing   = conditions.filter(c => c.available && !c.met).map(c => c.label);
    const neutral   = bias === 'NEUTRAL';

    let label, sublabel, color;
    if (alignment === 'COUNTER_TREND') {
      label = 'COUNTER-TREND'; sublabel = alignNote; color = '#fbbf24';
    } else if (neutral) {
      label = 'NEUTRAL BIAS'; sublabel = 'Responsive setups only'; color = '#64748b';
    } else if (score >= 10) {
      label = 'HIGH CONFLUENCE'; sublabel = 'Full process — 1 contract'; color = '#22c55e';
    } else if (score >= 7) {
      label = 'MODERATE'; sublabel = 'Day trade only — tighter targets'; color = '#fbbf24';
    } else if (score >= 4) {
      label = 'LOW'; sublabel = 'Reduce size 50% — obvious setups only'; color = '#f97316';
    } else {
      label = 'STAND ASIDE'; sublabel = 'Conflicting signals — no new entries'; color = '#ef4444';
    }

    const phase1Logged = !!(ar.overnight_inventory || ar.open_vs_prior_value || ar.prior_day_profile);

    res.json({
      score, maxPossible: trueMax, bias, neutral, label, sublabel, color,
      conditions, missing,
      structural: { score: structScore, max: 7, bias: structBias, dir: structDir, label: structLabel, color: structColor, conditions: structConds },
      session: { score: sessScore, max: 5, dir: sessDir, label: sessLabel, color: sessColor, conditions: sessConds, available: sessAvail },
      alignment, alignColor, alignNote,
      counterTrendData,
      compositeProfile,
      preMarketScore: structScore,
      sessionScore: sessScore,
      phase1Logged,
      calculatedAt: new Date().toISOString(),
      nl30, nl10, valueMigration,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
