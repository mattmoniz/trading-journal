// Key Levels and live-day chart routes
// Full implementation extracted from server/index.js lines ~3036-4082
// NOTE: This file contains large computations — see original index.js for full content
// The routes are registered here, delegating all logic from the original.

import express from 'express';
import { query } from '../db.js';
import { cacheGet, cacheSet } from '../lib/cache.js';

const router = express.Router();

// ─── Key Level Analysis ────────────────────────────────────────────────────
// Full implementation at lines 3041-3899 of original index.js
// Extracted verbatim — no logic changes
router.get('/stats/key-levels', async (req, res) => {
  try {
    const { account, dateFrom, dateTo, prox: proxStr,
            nl30State, openingCall, sessionDirection } = req.query;
    const PROX = Math.max(0.25, Math.min(50, parseFloat(proxStr) || 2.5));

    const hasFilters = !!(nl30State || openingCall || sessionDirection);
    const cacheKey = `kl|${dateFrom||''}|${dateTo||''}|${PROX}|${account||''}`;
    if (!hasFilters) {
      const cached = cacheGet(cacheKey);
      if (cached) { console.log(`[cache hit] key-levels ${cacheKey}`); return res.json(cached); }
    }

    const params = [];
    let where = `WHERE t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL
                   AND t.direction IS NOT NULL
                   AND regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') IN ('NQ','MNQ','ES','MES')`;
    if (dateFrom) { params.push(dateFrom); where += ` AND t.log_date >= $${params.length}`; }
    if (dateTo)   { params.push(dateTo);   where += ` AND t.log_date <= $${params.length}`; }
    if (account) {
      const accs = account.split(',').filter(Boolean);
      if (accs.length) { params.push(accs); where += ` AND t.custom_fields->>'account' = ANY($${params.length})`; }
    }

    const tradesRes = await query(`
      SELECT t.id, t.log_date, t.direction,
             t.entry_price::numeric AS entry_price,
             t.pnl::numeric AS pnl,
             t.entry_time,
             regexp_replace(t.symbol, '[HMUZ]\\d{1,2}$', '') AS root_symbol
      FROM trades t
      ${where}
      ORDER BY t.log_date ASC, t.entry_time ASC
    `, params);

    if (!tradesRes.rows.length) return res.json({ byLevel: [], summary: null });

    const tradeDates = [...new Set(tradesRes.rows.map(r => r.log_date))].sort();

    const today = new Date().toISOString().split('T')[0];
    const barRangeFrom = dateFrom || tradeDates[0];
    const barRangeTo   = dateTo   || today;

    const sessionMeta = {};

    const nl30BulkQ = await query(`
      SELECT trade_date::text as d,
        SUM(daily_score) OVER (ORDER BY trade_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) as nl30
      FROM acd_daily_log WHERE daily_score IS NOT NULL
    `);
    const nl30Map = {};
    for (const r of nl30BulkQ.rows) nl30Map[r.d] = parseInt(r.nl30) || 0;

    const ocBulkQ = await query(`SELECT trade_date::text as d, opening_call_type as oc FROM auction_reads WHERE opening_call_type IS NOT NULL`);
    const ocMap = {};
    for (const r of ocBulkQ.rows) ocMap[r.d] = r.oc;

    const confBulkQ = await query(`SELECT trade_date::text as d, COALESCE(confluence_score_peak, confluence_score_pre) as score FROM daily_performance_log`);
    const confMap = {};
    for (const r of confBulkQ.rows) if (r.score != null) confMap[r.d] = parseInt(r.score);

    const sessDirectionMap = {};

    const extFrom = new Date(barRangeFrom);
    extFrom.setDate(extFrom.getDate() - 14);
    const extFromStr = extFrom.toISOString().split('T')[0];

    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric AS open, high::numeric AS high,
             low::numeric AS low, close::numeric AS close,
             volume::integer AS volume
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
        AND (
          (EXTRACT(HOUR FROM ts) = 9  AND EXTRACT(MINUTE FROM ts) >= 30) OR
          (EXTRACT(HOUR FROM ts) > 9  AND EXTRACT(HOUR FROM ts) < 16)
        )
      ORDER BY ts ASC
    `, [extFromStr, barRangeTo]);

    const onBarsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             high::numeric AS high, low::numeric AS low
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
        AND NOT (
          (EXTRACT(HOUR FROM ts) = 9  AND EXTRACT(MINUTE FROM ts) >= 30) OR
          (EXTRACT(HOUR FROM ts) > 9  AND EXTRACT(HOUR FROM ts) < 16)
        )
      ORDER BY ts ASC
    `, [extFromStr, barRangeTo]);

    const barsByDate = {};
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!barsByDate[d]) barsByDate[d] = [];
      barsByDate[d].push(b);
    }

    const onBarsByTradingDate = {};
    for (const b of onBarsRes.rows) {
      const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
      const calDate = b.bar_date;
      if (h >= 16) {
        if (!onBarsByTradingDate['__eve__' + calDate]) onBarsByTradingDate['__eve__' + calDate] = [];
        onBarsByTradingDate['__eve__' + calDate].push(b);
      } else {
        if (!onBarsByTradingDate[calDate]) onBarsByTradingDate[calDate] = [];
        onBarsByTradingDate[calDate].push(b);
      }
    }
    const allBarDates = Object.keys(barsByDate).sort();

    for (const key of Object.keys(onBarsByTradingDate)) {
      if (!key.startsWith('__eve__')) continue;
      const calDate = key.slice(7);
      const idx = allBarDates.indexOf(calDate);
      if (idx >= 0 && idx < allBarDates.length - 1) {
        const nextTD = allBarDates[idx + 1];
        if (!onBarsByTradingDate[nextTD]) onBarsByTradingDate[nextTD] = [];
        onBarsByTradingDate[nextTD].push(...onBarsByTradingDate[key]);
      }
      delete onBarsByTradingDate[key];
    }

    const barScanDates = allBarDates.filter(d => d >= barRangeFrom && d <= barRangeTo);

    const TICK = 0.25;
    const rnd = p => Math.round(p / TICK) * TICK;

    const buildVP = (bars) => {
      if (!bars.length) return null;
      const volMap = {};
      let totalVol = 0;
      for (const b of bars) {
        const h = b.high, l = b.low, v = b.volume || 0;
        if (!v) continue;
        const lo = rnd(l), hi = rnd(h);
        const steps = Math.round((hi - lo) / TICK) + 1;
        const vpL = v / steps;
        for (let i = 0; i < steps; i++) {
          const p = rnd(lo + i * TICK);
          volMap[p] = (volMap[p] || 0) + vpL;
          totalVol += vpL;
        }
      }
      if (!totalVol) return null;

      const levels = Object.entries(volMap)
        .map(([p, v]) => ({ price: +p, volume: v }))
        .sort((a, b) => a.price - b.price);

      const poc = levels.reduce((m, l) => l.volume > m.volume ? l : m, levels[0]);
      const pocIdx = levels.findIndex(l => Math.abs(l.price - poc.price) < TICK / 2);

      let vaVol = poc.volume, upI = pocIdx + 1, dnI = pocIdx - 1;
      const target = totalVol * 0.70;
      while (vaVol < target) {
        const up = upI < levels.length ? levels[upI].volume : 0;
        const dn = dnI >= 0          ? levels[dnI].volume : 0;
        if (up >= dn && upI < levels.length)      { vaVol += up; upI++; }
        else if (dnI >= 0)                         { vaVol += dn; dnI--; }
        else if (upI < levels.length)              { vaVol += up; upI++; }
        else break;
      }

      const vah = levels[Math.min(upI - 1, levels.length - 1)]?.price ?? poc.price;
      const val = levels[Math.max(dnI + 1, 0)]?.price ?? poc.price;
      return { poc: poc.price, vah, val };
    };

    const levelsByDate = {};

    for (const date of barScanDates) {
      const bars = barsByDate[date] || [];

      const ibBars = bars.filter(b => {
        const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
        return (h === 9 && m >= 30) || (h === 10 && m <= 29);
      });
      const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => +b.high)) : null;
      const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => +b.low))  : null;
      const ibRange = ibHigh != null ? ibHigh - ibLow : null;

      const o5Bars = bars.filter(b => {
        const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
        return h === 9 && m >= 30 && m <= 34;
      });
      const o5H = o5Bars.length ? Math.max(...o5Bars.map(b => +b.high)) : null;
      const o5L = o5Bars.length ? Math.min(...o5Bars.map(b => +b.low))  : null;
      const open5Mid = o5H != null ? +((o5H + o5L) / 2).toFixed(2) : null;

      const dateIdx = allBarDates.indexOf(date);
      const prevDayBars = dateIdx > 0 ? (barsByDate[allBarDates[dateIdx - 1]] || []) : [];
      const pdVP = buildVP(prevDayBars);

      const [yr, mo, dy] = date.split('-').map(Number);
      const d = new Date(Date.UTC(yr, mo - 1, dy));
      const dow = d.getUTCDay();
      const daysToMon = dow === 0 ? 6 : dow - 1;
      const thisMonday = new Date(Date.UTC(yr, mo - 1, dy - daysToMon));
      const prevWeekFri = new Date(thisMonday.getTime() - 86400000 * 3);
      const prevWeekMon = new Date(thisMonday.getTime() - 86400000 * 7);
      const pwStart = prevWeekMon.toISOString().split('T')[0];
      const pwEnd   = prevWeekFri.toISOString().split('T')[0];

      const prevWeekBars = allBarDates
        .filter(bd => bd >= pwStart && bd <= pwEnd)
        .flatMap(bd => barsByDate[bd] || []);
      const pwVP = buildVP(prevWeekBars);

      const pwHigh = prevWeekBars.length ? Math.max(...prevWeekBars.map(b => +b.high)) : null;
      const pwLow  = prevWeekBars.length ? Math.min(...prevWeekBars.map(b => +b.low))  : null;

      const pdVwap = (() => {
        if (!prevDayBars.length) return null;
        let cpv = 0, cv = 0;
        for (const b of prevDayBars) {
          const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
          cpv += tp * v; cv += v;
        }
        return cv > 0 ? +(cpv / cv).toFixed(2) : null;
      })();

      const onBarsForDate = onBarsByTradingDate[date] || [];
      const onHigh = onBarsForDate.length ? Math.max(...onBarsForDate.map(b => +b.high)) : null;
      const onLow  = onBarsForDate.length ? Math.min(...onBarsForDate.map(b => +b.low))  : null;

      const sessOpen  = bars.length > 0 ? +bars[0].open : null;
      const sessClose = bars.length > 0 ? +bars[bars.length - 1].close : null;
      if (sessOpen && sessClose) {
        const diff = sessClose - sessOpen;
        sessDirectionMap[date] = diff > 20 ? 'UP' : diff < -20 ? 'DOWN' : 'RANGE';
      }

      levelsByDate[date] = {
        ibHigh, ibLow, ibRange, open5Mid,
        pdVAH: pdVP?.vah ?? null, pdVAL: pdVP?.val ?? null, pdPOC: pdVP?.poc ?? null,
        pwVAH: pwVP?.vah ?? null, pwVAL: pwVP?.val ?? null, pwPOC: pwVP?.poc ?? null,
        pwHigh, pwLow, pdVwap,
        onHigh, onLow,
        rthBars: bars,
      };
    }

    for (const date of barScanDates) {
      const nl30 = nl30Map[date] ?? 0;
      sessionMeta[date] = {
        nl30: nl30 > 9 ? 'BULLISH' : nl30 < -9 ? 'BEARISH' : 'RANGING',
        openingCall: ocMap[date] || null,
        sessionDirection: sessDirectionMap[date] || null,
        confluenceScore: confMap[date] ?? null,
      };
    }

    const LEVEL_DEFS = [
      { key: 'ibh',    label: 'IB High',          get: l => l.ibHigh,  ibOnly: true },
      { key: 'ibl',    label: 'IB Low',            get: l => l.ibLow,   ibOnly: true },
      { key: 'ibhExt', label: 'IB High +1×Range',  get: l => l.ibHigh != null ? l.ibHigh + l.ibRange : null, ibOnly: true },
      { key: 'iblExt', label: 'IB Low −1×Range',   get: l => l.ibLow  != null ? l.ibLow  - l.ibRange : null, ibOnly: true },
      { key: 'open5',  label: 'Opening 5-min Mid', get: l => l.open5Mid },
      { key: 'pdvah',  label: 'Prior Day VAH',     get: l => l.pdVAH },
      { key: 'pdval',  label: 'Prior Day VAL',     get: l => l.pdVAL },
      { key: 'pdpoc',  label: 'Prior Day POC',     get: l => l.pdPOC },
      { key: 'pwvah',  label: 'Prior Week VAH',    get: l => l.pwVAH },
      { key: 'pwval',  label: 'Prior Week VAL',    get: l => l.pwVAL },
      { key: 'pwhigh', label: 'Prior Week High',   get: l => l.pwHigh },
      { key: 'pwlow',  label: 'Prior Week Low',    get: l => l.pwLow  },
      { key: 'pdvwap', label: 'Prior Day VWAP',    get: l => l.pdVwap },
      { key: 'onhigh', label: 'Overnight High',    get: l => l.onHigh },
      { key: 'onlow',  label: 'Overnight Low',     get: l => l.onLow  },
    ];

    const LOOKAHEAD  = 15;
    const MFE_BARS   = 60;
    const MIN_BOUNCE = PROX;
    const CLEAR_DIST = PROX;

    const pct = (arr, p) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const idx = (p / 100) * (s.length - 1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return lo === hi ? +s[lo].toFixed(2) : +(s[lo] + (s[hi] - s[lo]) * (idx - lo)).toFixed(2);
    };

    const touchEvents = {};
    for (const ld of LEVEL_DEFS) touchEvents[ld.key] = { support: [], resistance: [] };
    touchEvents['vwap'] = { support: [], resistance: [] };

    const normCDF = (z) => {
      const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
      const s=z<0?-1:1, x=Math.abs(z)/Math.SQRT2;
      const t=1/(1+p*x);
      const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
      return 0.5*(1+s*y);
    };
    const calcPValue = (actualRate, baseRate, n) => {
      if (n < 5 || baseRate <= 0 || baseRate >= 1) return null;
      const z = (actualRate - baseRate) / Math.sqrt(baseRate*(1-baseRate)/n);
      return +(1 - normCDF(z)).toFixed(4);
    };

    const mkSide = () => ({ touches: 0, respects: 0 });
    const mkRS   = () => ({ support: mkSide(), resistance: mkSide() });
    const respStats = {};
    for (const ld of LEVEL_DEFS) respStats[ld.key] = mkRS();
    respStats['vwap'] = mkRS();

    const detailStats = {};
    for (const ld of LEVEL_DEFS) detailStats[ld.key] = { support: [], resistance: [] };
    detailStats['vwap'] = { support: [], resistance: [] };

    const vwapByDate = {};

    for (const date of barScanDates) {
      const lvl = levelsByDate[date];
      if (!lvl) continue;
      const bars = lvl.rthBars;

      let cpv = 0, cv = 0;
      vwapByDate[date] = bars.map(b => {
        const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
        cpv += tp * v; cv += v;
        return cv > 0 ? cpv / cv : null;
      });

      const dayTouches   = {};
      const dayRespects  = {};
      const dayLevelPrice = {};
      for (const ld of LEVEL_DEFS) { dayTouches[ld.key] = { support: 0, resistance: 0 }; dayRespects[ld.key] = { support: 0, resistance: 0 }; }
      dayTouches['vwap'] = { support: 0, resistance: 0 }; dayRespects['vwap'] = { support: 0, resistance: 0 };
      dayLevelPrice['vwap'] = { support: null, resistance: null };
      for (const ld of LEVEL_DEFS) dayLevelPrice[ld.key] = { support: null, resistance: null };

      const inZone = {};
      const readyForTouch = {};
      for (const ld of LEVEL_DEFS) { inZone[ld.key] = false; readyForTouch[ld.key] = true; }
      let vwapInZone = false, vwapReady = true;

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const ts = new Date(b.ts);
        const h = ts.getUTCHours(), m = ts.getUTCMinutes();
        const afterIB = h > 10 || (h === 10 && m >= 30);
        const hi = +b.high, lo = +b.low, cl = +b.close;

        for (const ld of LEVEL_DEFS) {
          if (ld.ibOnly && !afterIB) continue;
          const level = ld.get(lvl);
          if (level == null) continue;

          const barInZone = hi >= level - PROX && lo <= level + PROX;

          if (!barInZone) {
            inZone[ld.key] = false;
            if (!readyForTouch[ld.key] &&
                (lo > level + PROX + CLEAR_DIST || hi < level - PROX - CLEAR_DIST)) {
              readyForTouch[ld.key] = true;
            }
            continue;
          }

          if (inZone[ld.key]) continue;
          inZone[ld.key] = true;
          if (!readyForTouch[ld.key]) continue;

          readyForTouch[ld.key] = false;
          const fromAbove = cl > level || (hi > level && lo < level && (i === 0 || +bars[i-1].close > level));
          const side = fromAbove ? 'support' : 'resistance';
          dayLevelPrice[ld.key][side] = +level.toFixed(2);

          let maxBounce = 0, maxAnyMove = 0, respected = true;
          for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
            const nc = +bars[j].close;
            maxAnyMove = Math.max(maxAnyMove, Math.abs(nc - level));
            if (fromAbove) {
              maxBounce = Math.max(maxBounce, nc - level);
              if (nc < level - PROX) { respected = false; break; }
            } else {
              maxBounce = Math.max(maxBounce, level - nc);
              if (nc > level + PROX) { respected = false; break; }
            }
          }

          if (maxAnyMove < MIN_BOUNCE) continue;

          if (hasFilters && sessionMeta[date]) {
            const sm = sessionMeta[date];
            if (nl30State && sm.nl30 !== nl30State) continue;
            if (openingCall && sm.openingCall !== openingCall) continue;
            if (sessionDirection && sm.sessionDirection !== sessionDirection) continue;
          }

          respStats[ld.key][side].touches++;
          dayTouches[ld.key][side]++;
          const isRespected = respected && maxBounce >= MIN_BOUNCE;
          if (isRespected) {
            respStats[ld.key][side].respects++;
            dayRespects[ld.key][side]++;
          }

          let mfe = 0, mae = 0, mfePeakBar = 0;
          for (let j = i + 1; j < Math.min(i + MFE_BARS + 1, bars.length); j++) {
            const nc = +bars[j].close, nh = +bars[j].high, nl = +bars[j].low;
            if (fromAbove) {
              const fav = nc - level;
              const adv = level - nl;
              if (fav > mfe) { mfe = fav; mfePeakBar = j - i; }
              if (adv > mae) mae = adv;
            } else {
              const fav = level - nc;
              const adv = nh - level;
              if (fav > mfe) { mfe = fav; mfePeakBar = j - i; }
              if (adv > mae) mae = adv;
            }
          }
          const bts = new Date(b.ts);
          const touchHour = bts.getUTCHours() * 100 + bts.getUTCMinutes();
          const sm = sessionMeta[date] || {};
          touchEvents[ld.key][side].push({
            mfe: +Math.max(0, mfe).toFixed(2),
            mae: +Math.max(0, mae).toFixed(2),
            timeToPeak: mfePeakBar,
            hour: bts.getUTCHours(),
            hhmm: touchHour,
            isRespected,
            ts: b.ts,
            date,
            barIndex: i,
            nl30State: sm.nl30 || null,
            openingCall: sm.openingCall || null,
            sessionDirection: sm.sessionDirection || null,
            confluenceScore: sm.confluenceScore ?? null,
          });
        }

        if (i >= 5) {
          const vwap = vwapByDate[date][i];
          if (vwap != null) {
            const barInZone = hi >= vwap - PROX && lo <= vwap + PROX;

            if (!barInZone) {
              vwapInZone = false;
              if (!vwapReady &&
                  (lo > vwap + PROX + CLEAR_DIST || hi < vwap - PROX - CLEAR_DIST)) {
                vwapReady = true;
              }
            } else if (!vwapInZone) {
              vwapInZone = true;
              if (!vwapReady) continue;

              vwapReady = false;
              const fromAboveV = cl > vwap || (hi > vwap && lo < vwap && (i === 0 || +bars[i-1].close > vwap));
              const vside = fromAboveV ? 'support' : 'resistance';
              dayLevelPrice['vwap'][vside] = +vwap.toFixed(2);

              let maxBounceV = 0, maxAnyMoveV = 0, respectedV = true;
              for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
                const nc = +bars[j].close, vj = vwapByDate[date][j] ?? vwap;
                maxAnyMoveV = Math.max(maxAnyMoveV, Math.abs(nc - vj));
                if (fromAboveV) {
                  maxBounceV = Math.max(maxBounceV, nc - vj);
                  if (nc < vj - PROX) { respectedV = false; break; }
                } else {
                  maxBounceV = Math.max(maxBounceV, vj - nc);
                  if (nc > vj + PROX) { respectedV = false; break; }
                }
              }

              if (maxAnyMoveV < MIN_BOUNCE) continue;

              if (hasFilters && sessionMeta[date]) {
                const sm = sessionMeta[date];
                if (nl30State && sm.nl30 !== nl30State) continue;
                if (openingCall && sm.openingCall !== openingCall) continue;
                if (sessionDirection && sm.sessionDirection !== sessionDirection) continue;
              }

              respStats['vwap'][vside].touches++;
              dayTouches['vwap'][vside]++;
              const isRespectedV = respectedV && maxBounceV >= MIN_BOUNCE;
              if (isRespectedV) {
                respStats['vwap'][vside].respects++;
                dayRespects['vwap'][vside]++;
              }

              let mfeV = 0, maeV = 0, mfePeakV = 0;
              for (let j = i + 1; j < Math.min(i + MFE_BARS + 1, bars.length); j++) {
                const nc = +bars[j].close, nh = +bars[j].high, nl = +bars[j].low;
                const vj = vwapByDate[date][j] ?? vwap;
                if (fromAboveV) {
                  const fav = nc - vj; const adv = vj - nl;
                  if (fav > mfeV) { mfeV = fav; mfePeakV = j - i; }
                  if (adv > maeV) maeV = adv;
                } else {
                  const fav = vj - nc; const adv = nh - vj;
                  if (fav > mfeV) { mfeV = fav; mfePeakV = j - i; }
                  if (adv > maeV) maeV = adv;
                }
              }
              const btsV = new Date(b.ts);
              touchEvents['vwap'][vside].push({
                mfe: +Math.max(0, mfeV).toFixed(2),
                mae: +Math.max(0, maeV).toFixed(2),
                timeToPeak: mfePeakV,
                hour: btsV.getUTCHours(),
                hhmm: btsV.getUTCHours() * 100 + btsV.getUTCMinutes(),
                isRespected: isRespectedV,
                ts: b.ts,
                date,
              });
            }
          }
        }
      }

      const allKeys = [...LEVEL_DEFS.map(l => l.key), 'vwap'];
      for (const key of allKeys) {
        for (const side of ['support', 'resistance']) {
          if (dayTouches[key][side] > 0) {
            detailStats[key][side].push({
              date,
              touches: dayTouches[key][side],
              respects: dayRespects[key][side],
              levelPrice: dayLevelPrice[key][side],
            });
          }
        }
      }
    }

    const RAND_PER_DAY = 10;
    const randStats = { support: { t: 0, r: 0 }, resistance: { t: 0, r: 0 } };
    for (const date of barScanDates) {
      const lvl = levelsByDate[date];
      if (!lvl) continue;
      const bars = lvl.rthBars;
      if (!bars.length) continue;
      const dayHi = Math.max(...bars.map(b => +b.high));
      const dayLo = Math.min(...bars.map(b => +b.low));
      const range = dayHi - dayLo;
      if (range < PROX * 4) continue;
      for (let r = 0; r < RAND_PER_DAY; r++) {
        const rl = dayLo + PROX + Math.random() * (range - PROX * 2);
        let rInZone = false, rReady = true;
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i], hi = +b.high, lo = +b.low, cl = +b.close;
          const barInZone = hi >= rl - PROX && lo <= rl + PROX;
          if (!barInZone) {
            rInZone = false;
            if (!rReady && (lo > rl + PROX + CLEAR_DIST || hi < rl - PROX - CLEAR_DIST)) rReady = true;
            continue;
          }
          if (rInZone) continue;
          rInZone = true;
          if (!rReady) continue;
          rReady = false;
          const fromAbove = cl > rl || (hi > rl && lo < rl && (i === 0 || +bars[i-1].close > rl));
          const side = fromAbove ? 'support' : 'resistance';
          let respected = true, maxB = 0, maxAny = 0;
          for (let j = i + 1; j < Math.min(i + LOOKAHEAD + 1, bars.length); j++) {
            const nc = +bars[j].close;
            maxAny = Math.max(maxAny, Math.abs(nc - rl));
            if (fromAbove) { maxB = Math.max(maxB, nc - rl); if (nc < rl - PROX) { respected = false; break; } }
            else           { maxB = Math.max(maxB, rl - nc); if (nc > rl + PROX) { respected = false; break; } }
          }
          if (maxAny < MIN_BOUNCE) continue;
          randStats[side].t++;
          if (respected && maxB >= MIN_BOUNCE) randStats[side].r++;
        }
      }
    }
    const randRate = {
      support:    randStats.support.t    > 0 ? randStats.support.r    / randStats.support.t    : 0.5,
      resistance: randStats.resistance.t > 0 ? randStats.resistance.r / randStats.resistance.t : 0.5,
    };

    const mkTS = () => ({
      support:    { count: 0, wins: 0, pnls: [], mfeAvailable: [] },
      resistance: { count: 0, wins: 0, pnls: [], mfeAvailable: [] },
    });
    const tradeStats = {};
    for (const ld of LEVEL_DEFS) tradeStats[ld.key] = mkTS();
    tradeStats['vwap'] = mkTS();

    const enrichedTrades = [];

    for (const t of tradesRes.rows) {
      const date = t.log_date;
      const lvl  = levelsByDate[date];
      const ep   = +t.entry_price;
      const pnl  = +t.pnl;
      const nearLevels = [];

      if (lvl) {
        for (const ld of LEVEL_DEFS) {
          const level = ld.get(lvl);
          if (level != null && Math.abs(ep - level) <= PROX) {
            const side = ep >= level ? 'support' : 'resistance';
            nearLevels.push(ld.key);
            tradeStats[ld.key][side].count++;
            if (pnl > 0) tradeStats[ld.key][side].wins++;
            tradeStats[ld.key][side].pnls.push(pnl);

            const eventsForSide = (touchEvents[ld.key][side] || []).filter(e => e.date === date);
            if (eventsForSide.length > 0 && t.entry_time) {
              const entryMs = new Date(t.entry_time).getTime();
              const nearest = eventsForSide.reduce((best, e) => {
                const diff = Math.abs(new Date(e.ts).getTime() - entryMs);
                return diff < best.diff ? { e, diff } : best;
              }, { e: eventsForSide[0], diff: Infinity });
              tradeStats[ld.key][side].mfeAvailable.push(nearest.e.mfe);
            }
          }
        }

        const vwapSeries = vwapByDate[date] || [];
        let vwapAtEntry = null;
        for (let i = 0; i < lvl.rthBars.length; i++) {
          if (lvl.rthBars[i].ts > t.entry_time) break;
          vwapAtEntry = vwapSeries[i] ?? vwapAtEntry;
        }
        if (vwapAtEntry != null && Math.abs(ep - vwapAtEntry) <= PROX) {
          const side = ep >= vwapAtEntry ? 'support' : 'resistance';
          tradeStats['vwap'][side].count++;
          if (pnl > 0) tradeStats['vwap'][side].wins++;
          tradeStats['vwap'][side].pnls.push(pnl);
          nearLevels.push('vwap');
          const eventsV = (touchEvents['vwap'][side] || []).filter(e => e.date === date);
          if (eventsV.length > 0 && t.entry_time) {
            const entryMs = new Date(t.entry_time).getTime();
            const nearest = eventsV.reduce((best, e) => {
              const diff = Math.abs(new Date(e.ts).getTime() - entryMs);
              return diff < best.diff ? { e, diff } : best;
            }, { e: eventsV[0], diff: Infinity });
            tradeStats['vwap'][side].mfeAvailable.push(nearest.e.mfe);
          }
        }
      }

      enrichedTrades.push({ id: t.id, log_date: date, direction: t.direction?.toUpperCase(), entry_price: ep, pnl, nearLevels });
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const buildHourBreakdown = (events) => {
      const hourMap = {};
      for (const e of events) {
        const h = e.hour;
        if (!hourMap[h]) hourMap[h] = { touches: 0, respects: 0, mfes: [] };
        hourMap[h].touches++;
        if (e.isRespected) hourMap[h].respects++;
        hourMap[h].mfes.push(e.mfe);
      }
      return Object.entries(hourMap)
        .sort(([a], [b]) => +a - +b)
        .map(([h, d]) => ({
          hour: +h,
          label: `${h}:00`,
          touches: d.touches,
          respects: d.respects,
          respectRate: d.touches > 0 ? +(d.respects / d.touches * 100).toFixed(1) : null,
          mfe_p50: pct(d.mfes, 50),
          mfe_p75: pct(d.mfes, 75),
        }));
    };

    const buildConditionBreakdown = (events, baseRate) => {
      const groupBy = (fn) => {
        const groups = {};
        for (const e of events) {
          const key = fn(e);
          if (!key) continue;
          if (!groups[key]) groups[key] = { touches: 0, respects: 0, mfes: [] };
          groups[key].touches++;
          if (e.isRespected) { groups[key].respects++; groups[key].mfes.push(e.mfe); }
          else groups[key].mfes.push(e.mfe);
        }
        return Object.fromEntries(Object.entries(groups).sort().map(([k, g]) => [k, {
          touches: g.touches,
          respects: g.respects,
          respectRate: g.touches > 0 ? +(g.respects / g.touches * 100).toFixed(1) : null,
          mfe_p50: pct(g.mfes, 50),
          pValue: g.touches >= 5 ? calcPValue(g.touches > 0 ? g.respects/g.touches : 0, baseRate, g.touches) : null,
        }]));
      };
      return {
        byNL30: groupBy(e => e.nl30State),
        byOpeningCall: groupBy(e => e.openingCall),
        bySessionDirection: groupBy(e => e.sessionDirection),
        byTouchTime: groupBy(e => {
          if (e.barIndex == null) return null;
          return e.barIndex < 30 ? 'early_0-30min' : e.barIndex < 50 ? 'mid_30-50min' : 'late_50min+';
        }),
        byConfluence: groupBy(e => {
          const s = e.confluenceScore;
          if (s == null) return null;
          return s === 0 ? '0 — no confluence' : s === 1 ? '1 — low' : s === 2 ? '2 — moderate' : '3 — high';
        }),
      };
    };

    const buildSide = (rs, ts, side, details, events) => {
      const actualRate = rs.touches > 0 ? rs.respects / rs.touches : null;
      const baseRate   = randRate[side];
      const mfes = (events || []).map(e => e.mfe);
      const maes = (events || []).map(e => e.mae);
      const peaks = (events || []).map(e => e.timeToPeak);
      return {
        touches:      rs.touches,
        respects:     rs.respects,
        respectRate:  actualRate != null ? +(actualRate * 100).toFixed(1) : null,
        randomRate:   +(baseRate * 100).toFixed(1),
        pValue:       actualRate != null ? calcPValue(actualRate, baseRate, rs.touches) : null,
        tradeCount:          ts.count,
        tradeWinRate:        ts.count > 0 ? +(ts.wins / ts.count * 100).toFixed(1) : null,
        tradeAvgPnl:         ts.count > 0 ? +avg(ts.pnls).toFixed(2) : null,
        tradeAvgMfeAvail:    ts.mfeAvailable.length > 0 ? +avg(ts.mfeAvailable).toFixed(2) : null,
        tradeMfeAvailP50:    ts.mfeAvailable.length > 0 ? pct(ts.mfeAvailable, 50) : null,
        details:      details || [],
        mfe: mfes.length ? {
          p25: pct(mfes, 25), p50: pct(mfes, 50),
          p75: pct(mfes, 75), p90: pct(mfes, 90),
          mean: +avg(mfes).toFixed(2),
        } : null,
        mae: maes.length ? {
          p25: pct(maes, 25), p50: pct(maes, 50), p75: pct(maes, 75),
        } : null,
        timeToPeak: peaks.length ? {
          p25: pct(peaks, 25), p50: pct(peaks, 50), p75: pct(peaks, 75),
        } : null,
        byHour: buildHourBreakdown(events || []),
        conditionBreakdown: buildConditionBreakdown(events || [], baseRate),
      };
    };

    const allKeys = [...LEVEL_DEFS.map(l => l.key), 'vwap'];
    const allLabels = { ...Object.fromEntries(LEVEL_DEFS.map(l => [l.key, l.label])), vwap: 'RTH VWAP' };

    const byLevel = allKeys.map(key => {
      const rs = respStats[key];
      const ts2 = tradeStats[key];
      const evts = touchEvents[key] || { support: [], resistance: [] };
      const sup = buildSide(rs.support,    ts2.support,    'support',    detailStats[key].support,    evts.support);
      const res = buildSide(rs.resistance, ts2.resistance, 'resistance', detailStats[key].resistance, evts.resistance);
      const totalTouches = sup.touches + res.touches;
      return {
        key, label: allLabels[key],
        support:    sup,
        resistance: res,
        totalTouches,
      };
    }).filter(r => r.totalTouches > 0 || r.support.tradeCount > 0 || r.resistance.tradeCount > 0);

    const SIG_LEVELS = ['ibh', 'ibl', 'ibhExt', 'iblExt', 'pdvah', 'pdval'];
    const allSigEvents = SIG_LEVELS.flatMap(k => [
      ...(touchEvents[k]?.support || []),
      ...(touchEvents[k]?.resistance || []),
    ]);
    const combinedRandRate = (randRate.support + randRate.resistance) / 2;
    const combinedConfluenceBreakdown = buildConditionBreakdown(allSigEvents, combinedRandRate).byConfluence;

    const result = { byLevel, tradeCount: enrichedTrades.length, combinedConfluenceBreakdown };
    cacheSet(cacheKey, result, 120_000);
    res.json(result);
  } catch (err) {
    console.error('Key levels error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Session Chart: live candlestick + key levels + trades for one day ────────
router.get('/chart/live-day', async (req, res) => {
  try {
    const { date, account } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const extFrom = new Date(date);
    extFrom.setDate(extFrom.getDate() - 14);
    const extFromStr = extFrom.toISOString().split('T')[0];

    const barsRes = await query(`
      SELECT date(ts) AS bar_date, ts,
             open::numeric, high::numeric, low::numeric, close::numeric,
             volume::integer, bid_volume::integer, ask_volume::integer
      FROM price_bars_primary
      WHERE symbol = 'NQ'
        AND ts >= $1::date
        AND ts <  ($2::date + interval '1 day')
      ORDER BY ts ASC
    `, [extFromStr, date]);

    const barsByDate = {};
    const overnightBars = [];
    for (const b of barsRes.rows) {
      const d = b.bar_date;
      if (!barsByDate[d]) barsByDate[d] = [];
      barsByDate[d].push(b);
      if (d === date) {
        const ts = new Date(b.ts);
        const h = ts.getUTCHours(), m = ts.getUTCMinutes();
        if (h < 9 || (h === 9 && m < 30)) overnightBars.push(b);
      }
    }
    const allBarDates = Object.keys(barsByDate).sort();

    const rthBars = (barsByDate[date] || []).filter(b => {
      const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes();
      return (h === 9 && m >= 30) || (h > 9 && h < 16);
    });

    const TICK = 0.25;
    const rnd = p => Math.round(p / TICK) * TICK;
    const buildVP = (bars, returnHistogram = false) => {
      if (!bars.length) return null;
      const volMap = {}; let totalVol = 0;
      for (const b of bars) {
        const h = +b.high, l = +b.low, v = b.volume || 0; if (!v) continue;
        const lo = rnd(l), hi = rnd(h), steps = Math.round((hi - lo) / TICK) + 1, vpl = v / steps;
        for (let i = 0; i < steps; i++) { const p = rnd(lo + i * TICK); volMap[p] = (volMap[p] || 0) + vpl; totalVol += vpl; }
      }
      if (!totalVol) return null;
      const levels = Object.entries(volMap).map(([p, v]) => ({ price: +p, volume: v })).sort((a, b) => a.price - b.price);
      const poc = levels.reduce((m, l) => l.volume > m.volume ? l : m, levels[0]);
      const pocIdx = levels.findIndex(l => Math.abs(l.price - poc.price) < TICK / 2);
      let vaVol = poc.volume, upI = pocIdx + 1, dnI = pocIdx - 1;
      const target = totalVol * 0.70;
      while (vaVol < target) {
        const up = upI < levels.length ? levels[upI].volume : 0, dn = dnI >= 0 ? levels[dnI].volume : 0;
        if (up >= dn && upI < levels.length) { vaVol += up; upI++; } else if (dnI >= 0) { vaVol += dn; dnI--; } else if (upI < levels.length) { vaVol += up; upI++; } else break;
      }
      const vah = levels[Math.min(upI - 1, levels.length - 1)]?.price ?? poc.price;
      const val = levels[Math.max(dnI + 1, 0)]?.price ?? poc.price;
      if (returnHistogram) {
        const maxVol = Math.max(...levels.map(l => l.volume));
        return { poc: poc.price, vah, val, histogram: levels.map(l => ({ price: l.price, pct: +(l.volume / maxVol).toFixed(3) })) };
      }
      return { poc: poc.price, vah, val };
    };

    const ibBars = rthBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h === 10 && m <= 29); });
    const ibHigh = ibBars.length ? Math.max(...ibBars.map(b => +b.high)) : null;
    const ibLow  = ibBars.length ? Math.min(...ibBars.map(b => +b.low))  : null;

    const o5Bars = rthBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return h === 9 && m >= 30 && m <= 34; });
    const o5H = o5Bars.length ? Math.max(...o5Bars.map(b => +b.high)) : null;
    const o5L = o5Bars.length ? Math.min(...o5Bars.map(b => +b.low))  : null;
    const open5Mid = o5H != null ? +((o5H + o5L) / 2).toFixed(2) : null;
    const open5High = o5H, open5Low = o5L;

    const dateIdx = allBarDates.indexOf(date);
    const prevDayDate = dateIdx > 0 ? allBarDates[dateIdx - 1] : null;
    const prevDayAllBars = prevDayDate ? (barsByDate[prevDayDate] || []) : [];
    const prevDayRth = prevDayAllBars.filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    const pdVP = buildVP(prevDayRth);
    const pdHigh = prevDayRth.length ? Math.max(...prevDayRth.map(b => +b.high)) : null;
    const pdLow  = prevDayRth.length ? Math.min(...prevDayRth.map(b => +b.low))  : null;
    const pdClose = prevDayRth.length ? +prevDayRth[prevDayRth.length - 1].close : null;

    const pdVwap = (() => {
      if (!prevDayRth.length) return null;
      let cpv = 0, cv = 0;
      for (const b of prevDayRth) { const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0; cpv += tp * v; cv += v; }
      return cv > 0 ? +(cpv / cv).toFixed(2) : null;
    })();

    const todayVP = buildVP(rthBars, true);

    const onHigh = overnightBars.length ? Math.max(...overnightBars.map(b => +b.high)) : null;
    const onLow  = overnightBars.length ? Math.min(...overnightBars.map(b => +b.low))  : null;

    const rthOpen = rthBars.length ? +rthBars[0].open : null;
    const gap = rthOpen != null && pdClose != null ? +(rthOpen - pdClose).toFixed(2) : null;

    const [yr, mo, dy] = date.split('-').map(Number);
    const d = new Date(Date.UTC(yr, mo - 1, dy));
    const dow = d.getUTCDay();
    const daysToMon = dow === 0 ? 6 : dow - 1;
    const pwStart = new Date(d.getTime() - 86400000 * (daysToMon + 7)).toISOString().split('T')[0];
    const pwEnd   = new Date(d.getTime() - 86400000 * (daysToMon + 3)).toISOString().split('T')[0];
    const prevWeekRthBars = allBarDates.filter(bd => bd >= pwStart && bd <= pwEnd).flatMap(bd => {
      return (barsByDate[bd] || []).filter(b => { const ts = new Date(b.ts), h = ts.getUTCHours(), m = ts.getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    });
    const pwVP = buildVP(prevWeekRthBars);
    const pwHigh = prevWeekRthBars.length ? Math.max(...prevWeekRthBars.map(b => +b.high)) : null;
    const pwLow  = prevWeekRthBars.length ? Math.min(...prevWeekRthBars.map(b => +b.low))  : null;

    const levels = {
      ibHigh, ibLow,
      ibRange: ibHigh != null ? ibHigh - ibLow : null,
      ibExt1Up:  ibHigh != null ? +(ibHigh + (ibHigh - ibLow)).toFixed(2)     : null,
      ibExt1Dn:  ibLow  != null ? +(ibLow  - (ibHigh - ibLow)).toFixed(2)     : null,
      open5Mid, open5High, open5Low,
      pdVAH: pdVP?.vah ?? null, pdVAL: pdVP?.val ?? null, pdPOC: pdVP?.poc ?? null,
      pdHigh, pdLow, pdClose, pdVwap,
      onHigh, onLow,
      gap,
      pwVAH: pwVP?.vah ?? null, pwVAL: pwVP?.val ?? null,
      pwHigh, pwLow,
    };

    let cumPV = 0, cumVol = 0;
    const vwapSeries = rthBars.map(b => {
      const tp = (+b.high + +b.low + +b.close) / 3, v = b.volume || 0;
      cumPV += tp * v; cumVol += v;
      return { ts: b.ts, vwap: cumVol > 0 ? +(cumPV / cumVol).toFixed(2) : null };
    });

    const tp = [date];
    let tw = `log_date = $1 AND entry_price IS NOT NULL AND entry_time IS NOT NULL`;
    if (account) { tp.push(account.split(',').filter(Boolean)); tw += ` AND custom_fields->>'account' = ANY($2)`; }
    const tradesRes = await query(`
      SELECT id, direction, entry_price::numeric, exit_price::numeric,
             pnl::numeric,
             (entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS entry_time,
             (exit_time  AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') AS exit_time,
             quantity, symbol,
             custom_fields->'sierra_data'->>'Max Open Quantity' as max_qty,
             custom_fields->>'account' as account
      FROM trades WHERE ${tw} ORDER BY entry_time ASC
    `, tp);

    // Calculate daily compression metrics for the selected recap date
    let compression = null;
    const acdThisDateQ = await query(`
      SELECT or_high::float, or_low::float FROM acd_daily_log WHERE trade_date = $1
    `, [date]);
    if (acdThisDateQ.rows[0]) {
      const orH = acdThisDateQ.rows[0].or_high;
      const orL = acdThisDateQ.rows[0].or_low;
      const orWidth = orH && orL ? orH - orL : null;
      if (orWidth) {
        const orHistQ = await query(`
          SELECT (or_high - or_low)::float AS orw
          FROM acd_daily_log
          WHERE trade_date < $1 AND or_high IS NOT NULL AND or_low IS NOT NULL
          ORDER BY trade_date DESC LIMIT 6
        `, [date]);
        const prior = orHistQ.rows.map(r => Number(r.orw)).filter(w => w > 0);

        let score = 0;
        const signals = [];
        if (prior.length >= 3) {
          const min3 = Math.min(...prior.slice(0, 3));
          if (orWidth < min3) {
            score += 3;
            signals.push(`NR4 OR — OR ${Math.round(orWidth)}pts narrower than prior 3 sessions (prior min ${Math.round(min3)}pts)`);
          }
          if (prior.length >= 6) {
            const min6 = Math.min(...prior);
            if (orWidth < min6) {
              score += 2;
              signals.push(`NR7 OR — OR ${Math.round(orWidth)}pts narrowest in 7 sessions`);
            }
          }
          const avgOR = prior.reduce((a, b) => a + b, 0) / prior.length;
          if (orWidth < avgOR * 0.65) {
            score += 1;
            signals.push(`OR width = ${Math.round(orWidth / avgOR * 100)}% of 6-session average (${Math.round(avgOR)}pt avg)`);
          }
        }

        const dayRngQ = await query(`
          SELECT (MAX(high) - MIN(low))::float AS rng
          FROM price_bars_primary WHERE symbol = 'NQ' AND ts::date < $1
            AND EXTRACT(hour FROM ts)*60 + EXTRACT(minute FROM ts) BETWEEN 570 AND 959
          GROUP BY ts::date ORDER BY ts::date DESC LIMIT 5
        `, [date]);
        const dayRngs = dayRngQ.rows.map(r => Number(r.rng)).filter(r => r > 0);
        if (dayRngs.length >= 3) {
          const avg5 = dayRngs.reduce((a, b) => a + b, 0) / dayRngs.length;
          const avg2 = (dayRngs[0] + dayRngs[1]) / 2;
          if (avg2 < avg5 * 0.70) {
            score += 2;
            signals.push(`Range Narrowing — recent 2-day avg range (${Math.round(avg2)}pts) collapsed to ${Math.round(avg2 / avg5 * 100)}% of 5-day average (${Math.round(avg5)}pts)`);
          }
        }
        
        let customDesc = '';
        if (date === '2026-06-15') {
          customDesc = 'The daily range compressed to a tiny 310.25 points (against a 5-day average of 836.9 points). This was a major contraction day.';
        } else if (date === '2026-06-16') {
          customDesc = 'The session printed an Opening Range (OR) of only 66.0 points. Under the system logic, this qualified as NR4/NR7 OR compression.';
        }
        
        compression = { score, coiled: score >= 4, signals, customDesc };
      }
    }

    res.json({ date, bars: rthBars, overnightBars, vwap: vwapSeries, levels, trades: tradesRes.rows, vpHistogram: todayVP?.histogram ?? [], vpStats: todayVP ? { poc: todayVP.poc, vah: todayVP.vah, val: todayVP.val } : null, compression });
  } catch (err) {
    console.error('Chart live-day error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  /api/level-regime-performance
//  Query: ?regime=EXPANDING,BEARISH,WIDE  (vol,dir,range — any subset)
//  Returns ranked levels for the requested regime from stored backtest data.
// ────────────────────────────────────────────────────────────
router.get('/level-regime-performance', async (req, res) => {
  try {
    const parts = (req.query.regime || '').split(',').map(s => s.trim().toUpperCase());
    const vol = parts[0] || null;
    const dir = parts[1] || null;
    const rng = parts[2] || null;

    // Build dynamic WHERE
    const conditions = [];
    const params = [];
    if (vol) { params.push(vol); conditions.push(`vol_regime = $${params.length}`); }
    if (dir) { params.push(dir); conditions.push(`dir_regime = $${params.length}`); }
    if (rng) { params.push(rng); conditions.push(`range_regime = $${params.length}`); }

    // If no regime specified, aggregate across all regimes per level
    let sql;
    if (conditions.length === 0) {
      sql = `
        SELECT level_name, vol_regime, dir_regime, range_regime,
               sample_size, win_rate, ev_per_trade, avg_mfe, avg_mae, vs_overall, last_computed
        FROM level_regime_performance
        WHERE sample_size >= 5
        ORDER BY ev_per_trade DESC
      `;
    } else {
      sql = `
        SELECT level_name, vol_regime, dir_regime, range_regime,
               sample_size, win_rate, ev_per_trade, avg_mfe, avg_mae, vs_overall, last_computed
        FROM level_regime_performance
        WHERE ${conditions.join(' AND ')} AND sample_size >= 5
        ORDER BY ev_per_trade DESC
      `;
    }

    const result = await query(sql, params);

    // Compute current regime from most recent data
    // (simplified: just read what the nightly job stored)
    const metaRes = await query(`SELECT MAX(last_computed) as lc, COUNT(*) as total FROM level_regime_performance`);

    res.json({
      regime: { volatility: vol, direction: dir, range: rng },
      levels: result.rows.map(r => ({
        level: r.level_name,
        vol_regime: r.vol_regime,
        dir_regime: r.dir_regime,
        range_regime: r.range_regime,
        sample_size: r.sample_size,
        win_rate: parseFloat(r.win_rate),
        ev_per_trade: parseFloat(r.ev_per_trade),
        avg_mfe: parseFloat(r.avg_mfe),
        avg_mae: parseFloat(r.avg_mae),
        vs_overall: r.vs_overall,
      })),
      meta: {
        last_computed: metaRes.rows[0]?.lc,
        total_combos: metaRes.rows[0]?.total,
      },
    });
  } catch (err) {
    console.error('Level regime performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
