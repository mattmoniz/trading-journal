// Tests for server/services/sweepReversalMerged.js (merged sweep-reversal detector). Run: node scripts/test_sweep_reversal_merged.mjs
import assert from 'assert';
import { query } from '../server/db.js';
import { evaluateSweepReversal, computeDriveAtrUnits, SWEEP_LEVEL_PRIORITY } from '../server/services/sweepReversalMerged.js';
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };
// ---- synthetic
const flat = (n, px) => Array.from({ length: n }, () => ({ high: px + 1, low: px - 1 }));
const mkBars = (nBefore, startHigh, sweepLow) => { const b = flat(nBefore, startHigh); b[0] = { high: startHigh, low: startHigh - 2 }; for (let k = 0; k < 9; k++) b.push({ high: sweepLow + 8, low: sweepLow + 6 }); b.push({ high: sweepLow + 10, low: sweepLow }); return b; };
// 70 bars at ~1000 (high 1001), then 10 bars: 9 near 906-908, last bar low 900 -> long sweep of level 920, price back above
const bars = mkBars(70, 1000, 900), atr = 100;
t('drive in ATR20 units: (highest high before the extreme - extreme)/atr', () => { const extIdx = bars.length - 1; const d = computeDriveAtrUnits(bars, extIdx, true, 900, atr); assert(Math.abs(d - (1001 - 900) / atr) < 0.02, `got ${d}`); });
const base = { levels: { PD_POC: 920 }, bars, price: 925, atr20: atr, etMin: 620 };
t('long fires when drive >= cutoff', () => { const r = evaluateSweepReversal({ ...base, cutoff: 0.8 }); assert(r && r.dir === 'LONG' && r.name === 'PD_POC'); });
t('does not fire when drive < cutoff', () => assert.strictEqual(evaluateSweepReversal({ ...base, cutoff: 1.5 }), null));
t('no calibrated cutoff = silent', () => assert.strictEqual(evaluateSweepReversal({ ...base, cutoff: null }), null));
t('blocked direction (already fired today) = silent', () => assert.strictEqual(evaluateSweepReversal({ ...base, cutoff: 0.8, blockedDirs: new Set(['LONG']) }), null));
t('price not back above the level = silent', () => assert.strictEqual(evaluateSweepReversal({ ...base, price: 915, cutoff: 0.8 }), null));
t('poke of only 2 points is not a sweep', () => assert.strictEqual(evaluateSweepReversal({ ...base, levels: { PD_POC: 901 }, cutoff: 0.8 }), null));
t('IB levels ignored before 10:31 (lookahead), used after', () => { assert.strictEqual(evaluateSweepReversal({ ...base, levels: { IB_LOW: 920 }, cutoff: 0.8, etMin: 620 }), null); assert(evaluateSweepReversal({ ...base, levels: { IB_LOW: 920 }, cutoff: 0.8, etMin: 640 })); });
t('priority order: market level beats pivot level', () => { const r = evaluateSweepReversal({ ...base, levels: { PD_POC: 920, ONL: 921 }, cutoff: 0.8 }); assert.strictEqual(r.name, 'ONL'); assert(SWEEP_LEVEL_PRIORITY.indexOf('ONL') < SWEEP_LEVEL_PRIORITY.indexOf('PD_POC')); });
t('short is the mirror (sweep above, drive up)', () => { const m = bars.map((b) => ({ high: 2000 - b.low, low: 2000 - b.high })); const r = evaluateSweepReversal({ levels: { PD_POC: 1080 }, bars: m, price: 1075, atr20: atr, etMin: 620, cutoff: 0.8 }); assert(r && r.dir === 'SHORT' && Math.abs(r.drive - 1.01) < 0.03, JSON.stringify(r)); });
t('too few bars before the extreme = cannot measure, silent', () => assert.strictEqual(evaluateSweepReversal({ ...base, bars: mkBars(20, 1000, 900), cutoff: 0.1 }), null));
// ---- model case: 2026-10-20 10:00 long off FLOOR_S1 (the user's example). Research replay: drive 153 pts, ATR20 350, M60 0.44, tight at the 0.40 cutoff.
const bs = (await query(`SELECT ts::text t, high::float h, low::float l, close::float c FROM price_bars_primary WHERE symbol='NQ' AND ts >= '2026-10-20 08:40' AND ts <= '2026-10-20 10:00' ORDER BY ts`)).rows;
const hist = bs.map((b) => ({ high: b.h, low: b.l })); const atr20 = (await query(`SELECT AVG(rth_range)::float a FROM (SELECT rth_range FROM daily_rth_stats WHERE trade_date < '2026-10-20' ORDER BY trade_date DESC LIMIT 20) s`)).rows[0].a;
t('model case 2026-10-20 10:00: LONG via FLOOR_S1, drive about 0.44 ATR20 (matches the research replay)', () => { const r = evaluateSweepReversal({ levels: { FLOOR_S1: 29589, PD_VAL: 29709, OR5_LOW: 29500.5 }, bars: hist, price: bs[bs.length - 1].c, atr20, etMin: 600, cutoff: 0.405 }); assert(r, 'no event'); assert.strictEqual(r.dir, 'LONG'); assert.strictEqual(r.name, 'FLOOR_S1'); assert(Math.abs(r.drive - 0.44) < 0.04, `drive ${r.drive.toFixed(3)} atr20 ${atr20.toFixed(0)}`); });
console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
