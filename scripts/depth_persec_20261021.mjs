// Streams a Sierra Chart .depth file and writes a per-second order-book summary for RTH (docs/STOP_RUN_DEPTH_PREREG_20261021.md).
// Format (support-board layout, verified on a real file; command codes are a hypothesis proven by the validation gate in the analysis):
//   header 64 bytes 'SCDD'; records 24 bytes <int64 microseconds since 1899-12-30 UTC, int8 command, int8 flags, int16 orders, float32 price*100, uint32 quantity, uint32 reserved>
//   commands: 1 clear, 2 insert bid, 3 insert ask, 4 update bid, 5 update ask, 6 delete bid, 7 delete ask.
// Usage: node depth_persec_20261021.mjs --list   |   node depth_persec_20261021.mjs --one DATE PATH
import fs from 'fs';
const DIRS = ['/mnt/c/SierraChart/Data/MarketDepthData', '/mnt/c/SierraChart-DTC/Data/MarketDepthData'], OUT = 'scratch/depth_persec_20261021';
if (process.argv[2] === '--list') { const all = []; for (const dir of DIRS) for (const f of fs.readdirSync(dir)) { const m = f.match(/^(NQ[A-Z]\d{1,2})\.(?:CME\.)?(\d{4}-\d{2}-\d{2})\.depth$/); if (!m) continue; const p = `${dir}/${f}`, sz = fs.statSync(p).size; if (sz < 50e6) continue; all.push([m[2], m[1], p]); } for (const [d, c, p] of all.sort()) console.log(d, p, c); process.exit(0); }
const [, , , DATE, PATH, TAG] = process.argv; fs.mkdirSync(OUT, { recursive: true }); const outPath = `${OUT}/${DATE}.${TAG}.tsv`; if (fs.existsSync(outPath)) process.exit(0);
const offHours = (() => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${DATE}T16:00:00Z`)); const z = parts.find((p) => p.type === 'timeZoneName').value; const m = z.match(/GMT([+-]\d+)/); return m ? +m[1] : -5; })();
const DAY0 = Date.parse(`${DATE}T00:00:00Z`) / 1000 - offHours * 3600, EPOCH_SHIFT = 2209161600, T0 = 34200, T1 = 57600, SIZE = 1 << 22, bid = new Int32Array(SIZE), ask = new Int32Array(SIZE); let bb = -1, ba = -1;
const fd = fs.openSync(PATH, 'r'); const scale = (() => { const t = Buffer.allocUnsafe(24 * 4000); const n = fs.readSync(fd, t, 0, t.length, 64 + 24 * 200000); const pr = []; for (let o = 0; o + 24 <= n; o += 24) { const c = t[o + 8]; if (c >= 2 && c <= 5) { const v = t.readFloatLE(o + 12); if (v > 0) pr.push(v); } } pr.sort((a, b) => a - b); const m = pr.length ? pr[pr.length >> 1] : 0; return m > 1e6 ? 100 : 1; })(); const  CH = 24 * 2_000_000; const buf = Buffer.allocUnsafe(CH); let pos = 64, nextSnap = T0; const lines = [];
const emit = (s) => { if (bb < 0 || ba < 0) return; let b10 = 0, a10 = 0, b40 = 0, a40 = 0; for (let k = 0; k < 40; k++) { const bv = bid[bb - k] || 0, av = ask[ba + k] || 0; if (k < 10) { b10 += bv; a10 += av; } b40 += bv; a40 += av; } lines.push(`${s}\t${bb / 4}\t${ba / 4}\t${bid[bb]}\t${ask[ba]}\t${b10}\t${a10}\t${b40}\t${a40}`); };
while (true) { const n = fs.readSync(fd, buf, 0, CH, pos); if (n < 24) break; pos += n - (n % 24); const recs = Math.floor(n / 24);
  for (let r = 0; r < recs; r++) { const o = r * 24, lo = buf.readUInt32LE(o), hi = buf.readInt32LE(o + 4), micros = hi * 4294967296 + lo, unix = micros / 1e6 - EPOCH_SHIFT; const sod = unix - DAY0;   // seconds since ET midnight of the session date (negative before midnight, so the previous evening cannot be mistaken for RTH)
    // emit snapshots for fully finished seconds before applying this record (all records of a batch share a timestamp, so a batch is never split)
    while (nextSnap < T1 && nextSnap + 1 <= sod && sod >= T0) { emit(nextSnap); nextSnap++; } if (nextSnap >= T1 && sod >= T1) { r = recs; break; }
    const cmd = buf[o + 8]; if (cmd === 1) { bid.fill(0); ask.fill(0); bb = -1; ba = -1; continue; }
    const price = buf.readFloatLE(o + 12) / scale, qty = buf.readUInt32LE(o + 16), idx = Math.round(price * 4); if (idx <= 0 || idx >= SIZE - 100) continue;
    if (cmd === 2 || cmd === 4) { bid[idx] = qty; if (qty > 0 && idx > bb) bb = idx; else if (qty === 0 && idx === bb) { while (bb > 0 && bid[bb] === 0) bb--; if (bb <= 0) bb = -1; } }
    else if (cmd === 3 || cmd === 5) { ask[idx] = qty; if (qty > 0 && (ba < 0 || idx < ba)) ba = idx; else if (qty === 0 && idx === ba) { while (ba < SIZE - 1 && ask[ba] === 0 && ba < ba + 5000) { ba++; if (ba > bb + 20000) break; } if (ask[ba] === 0) ba = -1; } }
    else if (cmd === 6) { bid[idx] = 0; if (idx === bb) { while (bb > 0 && bid[bb] === 0) bb--; if (bb <= 0) bb = -1; } }
    else if (cmd === 7) { ask[idx] = 0; if (idx === ba) { const lim = Math.min(SIZE - 1, idx + 20000); while (ba < lim && ask[ba] === 0) ba++; if (ask[ba] === 0) ba = -1; } } }
  if (nextSnap >= T1) break; if (pos > 0 && n < CH) break; }
fs.closeSync(fd); fs.writeFileSync(outPath + '.tmp', lines.join('\n') + '\n'); fs.renameSync(outPath + '.tmp', outPath); console.log(DATE, TAG, lines.length, 'seconds', `offset ${offHours}`, `scale ${scale}`);
