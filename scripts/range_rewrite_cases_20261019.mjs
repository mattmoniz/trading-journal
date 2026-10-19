// Old/new SQL pairs for scripts/test_range_rewrites_20261019.mjs. Keep each pair in sync with the live call site named in its comment.
export function register(add) {
  // stallDefendedLevelDetector.js computeVolumeBaseline5m
  add('stall5mBaseline',
    `SELECT mod5, AVG(vol5m)::float AS avg_vol, STDDEV(vol5m)::float AS std_vol FROM (SELECT (FLOOR((EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))/5)*5)::int AS mod5, ts::date AS d, FLOOR(EXTRACT(epoch FROM ts) / 300)::bigint AS bucket5, SUM(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS vol5m FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= $1::date - INTERVAL '90 days' AND ts::date < $1::date GROUP BY 1, 2, 3) sub GROUP BY mod5 ORDER BY mod5`,
    `SELECT mod5, AVG(vol5m)::float AS avg_vol, STDDEV(vol5m)::float AS std_vol FROM (SELECT (FLOOR((EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts))/5)*5)::int AS mod5, ts::date AS d, FLOOR(EXTRACT(epoch FROM ts) / 300)::bigint AS bucket5, SUM(COALESCE(bid_volume,0)+COALESCE(ask_volume,0))::float AS vol5m FROM price_bars_primary WHERE symbol='NQ' AND ts >= $1::date - INTERVAL '90 days' AND ts < $1::date GROUP BY 1, 2, 3) sub GROUP BY mod5 ORDER BY mod5`);
  // minorDefendedLevelDetector.js getFullDayATR
  add('fullDayATR',
    `SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (SELECT ts::date as d, (MAX(high) - MIN(low)) as range FROM price_bars_primary WHERE symbol='NQ' AND ts::date < $1 AND ts::date >= $1::date - INTERVAL '90 days' GROUP BY ts::date ORDER BY d DESC LIMIT 20) recent`,
    `SELECT AVG(range)::float as atr, COUNT(*)::int as n FROM (SELECT ts::date as d, (MAX(high) - MIN(low)) as range FROM price_bars_primary WHERE symbol='NQ' AND ts < $1::date AND ts >= $1::date - INTERVAL '90 days' GROUP BY ts::date ORDER BY d DESC LIMIT 20) recent`);

  // ---- A2 hot per-pass reads (acd.js runSetupDetection block, setupExpiry.js, marketPulse.js, priceRetrieval.js, pocRotationJoinDetector.js, rotation65ptGateShadow.js) ----
  const EQ_O = 'ts::date=$1', EQ_N = 'ts >= $1::date AND ts < $1::date + 1';
  const pair = (name, tmpl, extra = {}) => add(name, tmpl.replace('@DATE', EQ_O), tmpl.replace('@DATE', EQ_N), extra.mapParams);
  pair('sameDay_hiLo_rth', `SELECT MAX(high)::float as h, MIN(low)::float as l FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`);
  pair('sameDay_ibHiLo', `SELECT MAX(high)::float as ib_high, MIN(low)::float as ib_low FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629`);
  pair('sameDay_overnightHiLo', `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) NOT BETWEEN 570 AND 959`);
  pair('sameDay_ohlc15', `SELECT high::float, low::float, close::float, open::float FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 585 ORDER BY ts`);
  pair('sameDay_ibBars', `SELECT high::float, low::float, close::float, open::float, COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 629 ORDER BY ts`);
  pair('sameDay_rthBars', `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min, high::float, low::float, close::float, open::float, COALESCE(volume,0)::int as volume, COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`);
  pair('sameDay_avg20', `SELECT AVG(volume)::float as avg_vol FROM (SELECT volume FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) >= 575 ORDER BY ts DESC LIMIT 20) v`);
  pair('sameDay_pulseBars', `SELECT close::float, COALESCE(ask_volume,0)::int as ask_vol, COALESCE(bid_volume,0)::int as bid_vol, volume::int, (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min FROM price_bars_primary WHERE symbol='NQ' AND @DATE AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`);
  // prior-week 7-day windows (acd.js pwRes / pwVABars)
  add('prior7d_hiLo',
    `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= ($1::date - interval '7 days') AND ts::date < $1 AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`,
    `SELECT MAX(high)::float as hi, MIN(low)::float as lo FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - interval '7 days') AND ts < $1::date AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959`);
  add('prior7d_closeVol',
    `SELECT close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= ($1::date - interval '7 days') AND ts::date < $1 AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`,
    `SELECT close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - interval '7 days') AND ts < $1::date AND EXTRACT(dow FROM ts::date) BETWEEN 1 AND 5 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`);
  // marketPulse 90-day per-minute baseline
  add('marketPulse_volBaseline',
    `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min, AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol FROM price_bars_primary WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 600 AND 602 AND ts::date >= $1::date - 90 AND ts::date < $1 GROUP BY et_min ORDER BY et_min`,
    `SELECT (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts))::int as et_min, AVG(volume::float) as avg_vol, STDDEV(volume::float) as std_vol FROM price_bars_primary WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 600 AND 602 AND ts >= $1::date - 90 AND ts < $1::date GROUP BY et_min ORDER BY et_min`);
  // ts::date = ANY(array): bound added, original filter kept (acd.js setups/today bar lookup). Array of two consecutive dates.
  add('anyArray_bars',
    `SELECT ts::text, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = ANY($1::date[]) ORDER BY ts`,
    `SELECT ts::text, open::float, high::float, low::float, close::float FROM price_bars_primary WHERE symbol='NQ' AND ts::date = ANY($1::date[]) AND ts >= (SELECT MIN(x) FROM unnest($1::date[]) x) AND ts < (SELECT MAX(x) FROM unnest($1::date[]) x) + 1 ORDER BY ts`,
    d => [[d, new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10)]]);
  // session OR-shaped read, bound added (pocRotationJoinDetector / rotation65ptGateShadow); $2 = a "now" cutoff
  add('sessionOr_bars',
    `SELECT ts::text as ts, open::float, high::float, low::float, close::float, volume::float as volume FROM price_bars_primary WHERE symbol='NQ' AND ((ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)) AND ts <= $2 ORDER BY ts ASC`,
    `SELECT ts::text as ts, open::float, high::float, low::float, close::float, volume::float as volume FROM price_bars_primary WHERE symbol='NQ' AND ((ts::date = $1::date - 1 AND EXTRACT(hour FROM ts) >= 18) OR (ts::date = $1::date AND (EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts)) < 1020)) AND ts >= $1::date - 1 AND ts < $1::date + 1 AND ts <= $2 ORDER BY ts ASC`,
    d => [d, `${d} 23:59:59`]);
  // priceRetrieval.getLatestBars (current price read)
  add('latestBars',
    `SELECT ts::text as ts, close::float as close FROM price_bars_primary WHERE symbol=$1 AND ts::date >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT $2`,
    `SELECT ts::text as ts, close::float as close FROM price_bars_primary WHERE symbol=$1 AND ts >= CURRENT_DATE - 5 ORDER BY ts DESC LIMIT $2`,
    () => ['NQ', 25]);
  // morningBrief.js computeVAForDate ('1 month' / '3 months') and the overnight hi/lo
  for (const iv of ['1 month', '3 months']) add(`morningBrief_va_${iv.replace(' ', '')}`,
    `SELECT close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts::date >= ($1::date - interval '${iv}') AND ts::date < $1 AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`,
    `SELECT close::float, volume::bigint as vol FROM price_bars_primary WHERE symbol='NQ' AND ts >= ($1::date - interval '${iv}') AND ts < $1::date AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 959 ORDER BY ts`);
}
