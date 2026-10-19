// Behavioural checks for server/lib/microCache.js using a real Express app on an ephemeral port.
import assert from 'node:assert/strict';
import express from '/home/mmoniz/trading-journal/node_modules/express/index.js';
import { microCache } from '../server/lib/microCache.js';
let calls = 0, fail = false;
const app = express();
app.get('/x/:id', microCache(300), async (req, res) => { calls++; await new Promise(r => setTimeout(r, 80)); if (fail) return res.status(500).json({ error: 'boom' }); res.json({ id: req.params.id, n: calls }); });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const get = async (p) => { const r = await fetch(base + p); return { s: r.status, b: await r.json() }; };
// 5 concurrent callers share ONE computation
const rs = await Promise.all([1,2,3,4,5].map(() => get('/x/a')));
assert.equal(calls, 1); assert.ok(rs.every(r => r.s === 200 && r.b.n === 1));
// within the TTL: served from cache, no new computation
await get('/x/a'); assert.equal(calls, 1);
// a different URL is a different key
await get('/x/b'); assert.equal(calls, 2);
// after the TTL it recomputes
await new Promise(r => setTimeout(r, 350)); const again = await get('/x/a'); assert.equal(calls, 3); assert.equal(again.b.n, 3);
// errors are never cached
fail = true; await new Promise(r => setTimeout(r, 350));
const e1 = await get('/x/a'); assert.equal(e1.s, 500);
fail = false; const ok = await get('/x/a'); assert.equal(ok.s, 200);
srv.close(); console.log('micro-cache checks passed'); process.exit(0);
