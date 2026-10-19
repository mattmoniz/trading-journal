#!/usr/bin/env node
// Page-load yardstick (2026-10-19): loads Morning Prep, then clicks Trades and Dashboard, and prints per view how long until the last /api request settles,
// how many /api requests fired, their size, the slowest per endpoint and which endpoints repeat. Needs the Vite client running (`npm run client`, port 3000)
// and the server on 3002. Run it from the repo root: `node scripts/measure_page_loads.mjs`; stop the client afterwards.
// Caveat: the dev client runs React.StrictMode, which doubles mount effects, so some "2x" repeats are dev-only; compare runs against each other, not against zero.
// Baseline 2026-10-19 14:50 ET (server before A1/A2): Morning Prep ~20 s / 78 requests / 1.5 MB, Trades ~5 s / 8 / 0.2 MB, Dashboard ~88 s / 59 / 8 MB;
// /api/case ~3 s alone (14.7 s under load), /api/stats/rolling 3.3 MB per call.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
let phase = 'init'; const reqs = []; const pending = new Map(); let lastActivity = Date.now();
page.on('request', r => { if (r.url().includes(':3002/api/')) { const o = { phase, url: r.url().replace(/^.*:3002/, ''), t0: Date.now() }; pending.set(r, o); reqs.push(o); lastActivity = Date.now(); } });
const done = async r => { const o = pending.get(r); if (!o) return; o.ms = Date.now() - o.t0; try { const resp = await r.response(); o.status = resp?.status(); const b = await resp?.body().catch(() => null); o.bytes = b ? b.length : 0; } catch {} pending.delete(r); lastActivity = Date.now(); };
page.on('requestfinished', done); page.on('requestfailed', r => { const o = pending.get(r); if (o) { o.failed = true; o.ms = Date.now() - o.t0; pending.delete(r); lastActivity = Date.now(); } });
const errors = []; page.on('pageerror', e => errors.push(String(e).slice(0, 200))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
async function settle(label, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { if (pending.size === 0 && Date.now() - lastActivity > 2500) break; await new Promise(r => setTimeout(r, 250)); }
  const settled = Date.now() - t0 - 2500;
  const rs = reqs.filter(r => r.phase === label);
  const by = {}; for (const r of rs) { const k = r.url.split('?')[0]; (by[k] ||= { n: 0, ms: 0, max: 0, bytes: 0 }); by[k].n++; by[k].ms += r.ms || 0; by[k].max = Math.max(by[k].max, r.ms || 0); by[k].bytes += r.bytes || 0; }
  console.log(`\n=== ${label}: settled ~${settled}ms after trigger, ${rs.length} /api requests, ${(rs.reduce((s, r) => s + (r.bytes || 0), 0) / 1024).toFixed(0)} KB`);
  const rows = Object.entries(by).sort((a, b) => b[1].max - a[1].max);
  for (const [k, v] of rows.slice(0, 12)) console.log(`  ${String(v.n).padStart(2)}x max ${String(v.max).padStart(5)}ms  ${(v.bytes / 1024).toFixed(0).padStart(5)}KB  ${k}`);
  const dup = rows.filter(([, v]) => v.n > 1); if (dup.length) console.log('  repeated:', dup.map(([k, v]) => `${v.n}x ${k}`).join(', '));
}
phase = 'MorningPrep(load)'; const t = Date.now();
await page.goto(`${process.env.CLIENT_URL || 'http://localhost:3000'}/`, { waitUntil: 'load' });
await settle('MorningPrep(load)');
phase = 'Trades(click)'; await page.getByText('Trades', { exact: true }).first().click(); await settle('Trades(click)');
phase = 'Dashboard(click)'; await page.getByText('Dashboard', { exact: true }).first().click(); await settle('Dashboard(click)');
console.log('\nconsole/page errors:', errors.length, errors.slice(0, 5));
await browser.close();
process.exit(0);
