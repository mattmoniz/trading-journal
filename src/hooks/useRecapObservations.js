import { useMemo } from 'react';

export function useRecapObservations(recapData) {
  return useMemo(() => {
    if (!recapData) return [];
    const { bars = [], levels = {}, vwap: vwapSeries = [], trades = [], vpStats } = recapData;
    if (!bars.length) return [];
    const rth = bars.filter(b => { const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes(); return (h === 9 && m >= 30) || (h > 9 && h < 16); });
    if (!rth.length) return [];
    const fmtTime = ts => { const t = new Date(ts); return `${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2,'0')}`; };
    const obs = [];

    // Compression & Coiling metrics
    if (recapData.compression) {
      const { score, coiled, signals, customDesc } = recapData.compression;
      if (customDesc) {
        obs.push({
          type: 'info',
          icon: '🌀',
          text: `${customDesc} (Compression Score: ${score}/10)`
        });
      } else if (coiled) {
        obs.push({
          type: 'info',
          icon: '🌀',
          text: `COILED (Score ${score}/10) — setup for range expansion. Signals: ${signals.join(' | ')}`
        });
      } else if (score >= 2) {
        obs.push({
          type: 'neutral',
          icon: '🌀',
          text: `Compressed (Score ${score}/10) — mild range contraction. Signals: ${signals.join(' | ')}`
        });
      }
    }

    // Gap
    if (levels.pdClose != null) {
      const gapPts = +rth[0].open - levels.pdClose;
      const absPts = Math.abs(gapPts).toFixed(2);
      const dir = gapPts > 0.5 ? 'up' : gapPts < -0.5 ? 'down' : null;
      if (dir) {
        const filled = dir === 'up' ? rth.some(b => +b.low <= levels.pdClose) : rth.some(b => +b.high >= levels.pdClose);
        obs.push({ type: dir === 'up' ? 'green' : 'red', icon: dir === 'up' ? '↑' : '↓', text: `Gap ${dir} ${absPts} pts — ${filled ? 'filled' : 'unfilled'}` });
      } else {
        obs.push({ type: 'neutral', icon: '─', text: 'Flat open (no significant gap)' });
      }
    }

    // IB break
    if (levels.ibHigh != null && levels.ibLow != null) {
      const ibRange = (levels.ibHigh - levels.ibLow).toFixed(2);
      const postIB = rth.filter(b => { const h = new Date(b.ts).getUTCHours(), m = new Date(b.ts).getUTCMinutes(); return h > 10 || (h === 10 && m >= 30); });
      const upBreak = postIB.find(b => +b.high > levels.ibHigh + 0.25);
      const dnBreak = postIB.find(b => +b.low  < levels.ibLow  - 0.25);
      const firstBreak = (!upBreak && !dnBreak) ? null
        : (!dnBreak || (upBreak && new Date(upBreak.ts) < new Date(dnBreak.ts))) ? { dir: 'up', bar: upBreak }
        : { dir: 'down', bar: dnBreak };
      if (firstBreak) {
        const ext1Up = levels.ibHigh + (levels.ibHigh - levels.ibLow);
        const ext1Dn = levels.ibLow  - (levels.ibHigh - levels.ibLow);
        const hitExt = firstBreak.dir === 'up' ? postIB.some(b => +b.high >= ext1Up - 0.5) : postIB.some(b => +b.low <= ext1Dn + 0.5);
        obs.push({ type: firstBreak.dir === 'up' ? 'green' : 'red', icon: firstBreak.dir === 'up' ? '▲' : '▼',
          text: `IB (${ibRange} pts) — broke ${firstBreak.dir === 'up' ? 'upside' : 'downside'} at ${fmtTime(firstBreak.bar.ts)}${hitExt ? ', extended to ±1× target' : ''}` });
      } else {
        obs.push({ type: 'neutral', icon: '↔', text: `IB (${ibRange} pts) — no clean breakout (inside day)` });
      }
    }

    // VWAP position at close
    if (vwapSeries.length) {
      const lastVwap = [...vwapSeries].reverse().find(v => v.vwap != null);
      const lastBar  = rth[rth.length - 1];
      if (lastVwap && lastBar) {
        const diff = +lastBar.close - lastVwap.vwap;
        obs.push({ type: diff > 0 ? 'green' : 'red', icon: '~',
          text: `Closed ${Math.abs(diff).toFixed(2)} pts ${diff > 0 ? 'above' : 'below'} VWAP (${lastVwap.vwap?.toFixed(2)})` });
      }
    }

    // VP close position
    if (vpStats && rth.length) {
      const lastClose = +rth[rth.length - 1].close;
      const inVa = lastClose >= vpStats.val && lastClose <= vpStats.vah;
      obs.push({ type: inVa ? 'green' : 'neutral', icon: '▦',
        text: `Closed ${inVa ? 'inside' : 'outside'} Value Area (VAH ${vpStats.vah?.toFixed(2)} · POC ${vpStats.poc?.toFixed(2)} · VAL ${vpStats.val?.toFixed(2)})` });
    }

    // Trade summary
    if (trades.length) {
      const won = trades.filter(t => +t.pnl > 0).length;
      const totalPnl = trades.reduce((s, t) => s + +t.pnl, 0);
      obs.push({ type: totalPnl >= 0 ? 'green' : 'red', icon: '$',
        text: `${trades.length} trade${trades.length !== 1 ? 's' : ''} · ${won}W / ${trades.length - won}L · ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` });
    }

    // ── Formal setups within ±20 pts ──────────────────────────────────────────
    // Tracks every distinct directional approach to each key level (not just the first).
    // Proximity scales with IB range: wider IB = wider zone needed to catch approaches.
    // Clamped between 10 and 30 pts so it stays practical.
    const ibRange = levels.ibHigh != null && levels.ibLow != null ? levels.ibHigh - levels.ibLow : 80;
    const SETUP_PROX = Math.max(10, Math.min(30, Math.round(ibRange * 0.18)));
    const openPrice = +rth[0].open;

    const SETUPS = [
      { key: 'ibHigh',    name: 'IB High',           category: 'IB' },
      { key: 'ibLow',     name: 'IB Low',            category: 'IB' },
      { key: 'ibExt1Up',  name: 'IB +1× Ext',        category: 'IB' },
      { key: 'ibExt1Dn',  name: 'IB −1× Ext',        category: 'IB' },
      { key: 'open5Mid',  name: 'OR Mid',             category: 'OR' },
      { key: 'pdVAH',     name: 'PD Value Area High', category: 'PD VA' },
      { key: 'pdVAL',     name: 'PD Value Area Low',  category: 'PD VA' },
      { key: 'pdPOC',     name: 'PD POC',             category: 'PD VA' },
      { key: 'pdVwap',    name: 'PD VWAP',            category: 'PD' },
      { key: 'pdHigh',    name: 'PD High',            category: 'PD' },
      { key: 'pdLow',     name: 'PD Low',             category: 'PD' },
      { key: 'onHigh',    name: 'Overnight High',     category: 'ON' },
      { key: 'onLow',     name: 'Overnight Low',      category: 'ON' },
      { key: 'pwHigh',    name: 'Prior Week High',    category: 'PW' },
      { key: 'pwLow',     name: 'Prior Week Low',     category: 'PW' },
      { key: 'pwVAH',     name: 'Prior Week VAH',     category: 'PW' },
      { key: 'pwVAL',     name: 'Prior Week VAL',     category: 'PW' },
    ];

    const setupHits = [];
    for (const s of SETUPS) {
      const price = levels[s.key]; if (price == null) continue;
      if (Math.abs(openPrice - price) <= SETUP_PROX) continue; // opened on this level

      let inZone = false;
      let cleared = Math.abs(openPrice - price) > SETUP_PROX;
      let lastSide = openPrice > price ? 'above' : 'below';
      let barsOutside = cleared ? 99 : 0; // bars consecutively outside the zone
      const BARS_TO_CLEAR = 3; // must be outside zone for 3 consecutive bars to count as a clean approach

      for (let i = 0; i < rth.length; i++) {
        const b = rth[i];
        const hi = +b.high, lo = +b.low;
        const barInZone = lo <= price + SETUP_PROX && hi >= price - SETUP_PROX;

        if (!barInZone) {
          if (inZone) { inZone = false; barsOutside = 0; }
          barsOutside++;
          // Track side and only mark cleared after 3 consecutive bars outside zone
          if (lo > price + SETUP_PROX) lastSide = 'above';
          else if (hi < price - SETUP_PROX) lastSide = 'below';
          if (barsOutside >= BARS_TO_CLEAR) cleared = true;
          continue;
        }

        if (inZone) continue; // already in zone, no new entry
        inZone = true;

        if (!cleared || !lastSide) continue; // no clean prior position, skip

        const fromAbove = lastSide === 'above';
        cleared = false; // needs to clear again before next approach counts

        // Outcome: scan forward until price definitively exits the zone (close clears the edge
        // by 5+ pts). No fixed time limit — could be 1 bar or 20+.
        // If price stays choppy inside the zone and never exits cleanly → skip.
        const EXIT_CONFIRM = 5; // pts beyond zone edge to confirm definitive move
        const MAX_SCAN = 30;    // give up after 30 bars (30 min) — stuck/choppy
        let outcome, outcomeType;
        let zoneExit = null;
        for (let k = i + 1; k <= i + MAX_SCAN && k < rth.length; k++) {
          const kb = rth[k];
          const cls = +kb.close;
          if (cls > price + SETUP_PROX + EXIT_CONFIRM) { zoneExit = 'up';   break; }
          if (cls < price - SETUP_PROX - EXIT_CONFIRM) { zoneExit = 'down'; break; }
        }
        if (!zoneExit) continue; // never made a definitive exit — choppy/stuck in zone

        if (fromAbove) {
          outcome = zoneExit === 'up' ? 'support held' : 'support broke';
          outcomeType = zoneExit === 'up' ? 'held' : 'broke';
        } else {
          outcome = zoneExit === 'down' ? 'resistance held' : 'resistance broke';
          outcomeType = zoneExit === 'down' ? 'held' : 'broke';
        }

        // Measure how far price moved in the favorable direction over next 45 bars
        // For held: favorable = direction price bounced away from level
        // For broke: favorable = direction price continued through level
        const MFE_SCAN = 45;
        let mfe = 0;
        const favorableDir = (fromAbove && outcomeType === 'held') || (!fromAbove && outcomeType === 'broke') ? 'up' : 'down';
        for (let k = i + 1; k < Math.min(i + MFE_SCAN + 1, rth.length); k++) {
          const cls = +rth[k].close;
          const move = favorableDir === 'up' ? cls - price : price - cls;
          if (move > mfe) mfe = move;
        }

        setupHits.push({ name: s.name, category: s.category, key: s.key, price, timeStr: fmtTime(b.ts),
          side: fromAbove ? 'support' : 'resistance', outcome, outcomeType,
          mfe: +mfe.toFixed(2), date: recapData?.date });
      }
    }

    // VWAP setups — dynamic level, recalculated each bar (skip first 5 bars to let it settle)
    if (vwapSeries.length > 5) {
      let vwapInZone = false, vwapCleared = true, vwapLastSide = null, vwapBarsOut = 99;
      for (let i = 5; i < rth.length; i++) {
        const vwap = vwapSeries[i]; if (vwap == null) continue;
        const b = rth[i], hi = +b.high, lo = +b.low;
        const barInZone = lo <= vwap + SETUP_PROX && hi >= vwap - SETUP_PROX;

        if (!barInZone) {
          if (vwapInZone) { vwapInZone = false; vwapBarsOut = 0; }
          vwapBarsOut++;
          if (lo > vwap + SETUP_PROX) vwapLastSide = 'above';
          else if (hi < vwap - SETUP_PROX) vwapLastSide = 'below';
          if (vwapBarsOut >= 3) vwapCleared = true;
          continue;
        }
        if (vwapInZone) continue;
        vwapInZone = true;
        if (!vwapCleared || !vwapLastSide) continue;
        vwapCleared = false;

        const fromAbove = vwapLastSide === 'above';
        const EXIT_CONFIRM = 5, MAX_SCAN = 30;
        let zoneExit = null;
        for (let k = i + 1; k <= i + MAX_SCAN && k < rth.length; k++) {
          const vj = vwapSeries[k] ?? vwap;
          const cls = +rth[k].close;
          if (cls > vj + SETUP_PROX + EXIT_CONFIRM) { zoneExit = 'up'; break; }
          if (cls < vj - SETUP_PROX - EXIT_CONFIRM) { zoneExit = 'down'; break; }
        }
        if (!zoneExit) continue;

        const outcomeType = (fromAbove && zoneExit === 'up') || (!fromAbove && zoneExit === 'down') ? 'held' : 'broke';
        const outcome = fromAbove
          ? (outcomeType === 'held' ? 'support held' : 'support broke')
          : (outcomeType === 'held' ? 'resistance held' : 'resistance broke');

        let mfe = 0;
        const favorableDir = (fromAbove && outcomeType === 'held') || (!fromAbove && outcomeType === 'broke') ? 'up' : 'down';
        for (let k = i + 1; k < Math.min(i + 46, rth.length); k++) {
          const cls = +rth[k].close;
          const move = favorableDir === 'up' ? cls - vwap : vwap - cls;
          if (move > mfe) mfe = move;
        }

        setupHits.push({ name: 'VWAP', category: 'VWAP', key: 'vwap', price: +vwap.toFixed(2),
          timeStr: fmtTime(b.ts), side: fromAbove ? 'support' : 'resistance',
          outcome, outcomeType, mfe: +mfe.toFixed(2), date: recapData?.date });
      }
    }

    // Sort chronologically
    setupHits.sort((a, b) => a.timeStr.localeCompare(b.timeStr));

    // Confluence detection: group setups within 15 pts of each other AND within 15 min of each other
    // A confluence = multiple levels acting as one zone — stronger signal
    const CONFLUENCE_PRICE = 15; // pts
    const CONFLUENCE_TIME  = 15; // minutes apart
    const timeToMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

    const confluenceGroups = [];
    const grouped = new Set();
    for (let a = 0; a < setupHits.length; a++) {
      if (grouped.has(a)) continue;
      const grp = [setupHits[a]];
      grouped.add(a);
      for (let b = a + 1; b < setupHits.length; b++) {
        if (grouped.has(b)) continue;
        const sa = setupHits[a], sb = setupHits[b];
        const priceDiff = Math.abs(sa.price - sb.price);
        const timeDiff = Math.abs(timeToMins(sa.timeStr) - timeToMins(sb.timeStr));
        if (priceDiff <= CONFLUENCE_PRICE && timeDiff <= CONFLUENCE_TIME && sa.side === sb.side) {
          grp.push(sb);
          grouped.add(b);
        }
      }
      const bestMfe = Math.max(...grp.map(s => s.mfe));
      const names = [...new Set(grp.map(s => s.name))].join(' + ');
      const key = grp[0].key; // use first for chart link
      confluenceGroups.push({
        setups: grp,
        names,
        key,
        price: grp[0].price,
        timeStr: grp[0].timeStr,
        side: grp[0].side,
        outcome: grp[0].outcome,
        outcomeType: grp[0].outcomeType,
        mfe: bestMfe,
        date: grp[0].date,
        isConfluence: grp.length > 1,
      });
    }

    // Trade of the day: confluence group with highest MFE
    const bestSetup = confluenceGroups.length > 0
      ? [...confluenceGroups].sort((a, b) => b.mfe - a.mfe)[0]
      : null;

    obs.push({ type: 'setups', setupHits, bestSetup });

    return obs;
  }, [recapData]);
}
