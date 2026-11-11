// Golden detection replay, shared library (Fable audit F27/F32, 2026-11-11; design: scratch/fable_audit_designs_20261110.md section 2).
// WHAT IT DOES: runs ONE setup-detection pass (the real /acd/setup-detection route handler) in a fresh process with a FROZEN clock and with the database boundary (server/db.js
// query()) intercepted. RECORD mode answers reads from the live database (and stores statement + params + rows) and NEVER executes a write: INSERT/UPDATE/DELETE/DDL are captured as
// "decisions" and answered with a synthetic result (RETURNING id gets a deterministic fake id). REPLAY mode answers every read from the recording, with no database at all.
// Comparing the decisions (every write the pass attempted, the JSON it returned, the outbound localhost calls) between two code versions on the same recording proves a change altered no decision.
// A statement the recording does not contain is reported as UNRECORDED (the changed code added or altered a read), never hidden.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
const nowReal = () => performance.now();   // the Date clock is frozen during a pass; idle detection must use a real one

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// ---- JSON with Dates preserved ---------------------------------------------------------------------------------------------------------------
export const enc = (v) => JSON.stringify(v, function (k, val) {
  const raw = this[k];
  if (raw instanceof Date) return { $d: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  if (typeof val === 'number' && !Number.isFinite(val)) return { $n: String(val) };
  if (typeof val === 'bigint') return { $b: String(val) };
  return val;
});
export const dec = (s) => JSON.parse(s, (k, v) => {
  if (v && typeof v === 'object') { if ('$d' in v) return v.$d == null ? new Date(NaN) : new Date(v.$d); if ('$n' in v) return Number(v.$n); if ('$b' in v) return BigInt(v.$b); }
  return v;
});

const norm = (sql) => String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
export const keyOf = (sql, params) => crypto.createHash('sha1').update(norm(sql) + '\u0000' + enc(params ?? [])).digest('hex').slice(0, 16);
const WRITE_RE = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|CREATE\s+(TABLE|INDEX|VIEW|UNIQUE)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|VIEW)|REFRESH\s+MATERIALIZED)\b/i;
export const isWrite = (sql) => WRITE_RE.test(norm(sql));

// ---- frozen clock + seeded random ------------------------------------------------------------------------------------------------------------------
export function freezeClock(t0Ms) {
  const Real = globalThis.Date;
  class FrozenDate extends Real {
    constructor(...a) { if (a.length === 0) super(t0Ms); else super(...a); }
    static now() { return t0Ms; }
  }
  globalThis.Date = FrozenDate;
  let seed = 123456789;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  return () => { globalThis.Date = Real; };
}

// ---- the interceptor -------------------------------------------------------------------------------------------------------------------------------
export function makeRecorder() {
  const reads = new Map();      // key -> [ {rows, rowCount} ... ] in call order
  const writes = [];            // decisions: { sql, params, result }
  const stats = { reads: 0, writes: 0 };
  let fakeId = 900000000, inflight = 0, lastActivity = nowReal();
  const interceptor = async (text, params, realQuery) => {
    inflight++; lastActivity = nowReal();
    try {
      const k = keyOf(text, params);
      if (isWrite(text)) {
        const hasReturning = /\bRETURNING\b/i.test(text);
        const result = { rows: hasReturning ? [{ id: ++fakeId }] : [], rowCount: 1 };
        writes.push({ k, sql: norm(text), params: params ?? [], result });
        stats.writes++;
        const list = reads.get(k) || []; list.push(result); reads.set(k, list);   // a later identical statement gets the same fake answer in replay
        return result;
      }
      const r = await realQuery(text, params);
      const result = { rows: r.rows, rowCount: r.rowCount };
      const list = reads.get(k) || []; list.push(result); reads.set(k, list);
      stats.reads++;
      return result;
    } finally { inflight--; lastActivity = nowReal(); }
  };
  return { interceptor, reads, writes, stats, idle: () => inflight === 0 && nowReal() - lastActivity > 600 };
}

export function makeReplayer(recording) {
  const reads = new Map(Object.entries(recording.reads).map(([k, v]) => [k, v.map((x) => ({ rows: x.rows, rowCount: x.rowCount }))]));
  const cursor = new Map();
  const writes = [], unrecorded = [];
  let inflight = 0, lastActivity = nowReal();
  const interceptor = async (text, params) => {
    inflight++; lastActivity = nowReal();
    try {
      const k = keyOf(text, params);
      const list = reads.get(k);
      if (isWrite(text)) {
        const result = list ? list[Math.min(cursor.get(k) || 0, list.length - 1)] : { rows: /\bRETURNING\b/i.test(text) ? [{ id: 1 }] : [], rowCount: 1 };
        cursor.set(k, (cursor.get(k) || 0) + 1);
        writes.push({ k, sql: norm(text), params: params ?? [], result });
        return result;
      }
      if (!list) { unrecorded.push({ k, sql: norm(text).slice(0, 200), params: params ?? [] }); return { rows: [], rowCount: 0 }; }
      const i = cursor.get(k) || 0; cursor.set(k, i + 1);
      return list[Math.min(i, list.length - 1)];
    } finally { inflight--; lastActivity = nowReal(); }
  };
  return { interceptor, writes, unrecorded, idle: () => inflight === 0 && nowReal() - lastActivity > 600 };
}

// ---- fetch: only localhost, recorded --------------------------------------------------------------------------------------------------------------
export function installFetch(mode, recording, calls) {
  const real = globalThis.fetch;
  const keyFetch = (url, init) => crypto.createHash('sha1').update(`${init?.method || 'GET'} ${url} ${init?.body || ''}`).digest('hex').slice(0, 16);
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const k = keyFetch(u, init);
    if (mode === 'record') {
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) throw new Error(`replay: outbound call blocked: ${u}`);
      const r = await real(url, init); const body = await r.text();
      calls.push({ k, url: u, method: init?.method || 'GET', body: init?.body ?? null, status: r.status, resp: body });
      return new Response(body, { status: r.status });
    }
    const hit = (recording.fetches || []).find((c) => c.k === k);
    calls.push({ k, url: u, method: init?.method || 'GET', body: init?.body ?? null, status: hit?.status ?? 599, resp: hit?.resp ?? '', unrecorded: !hit });
    return new Response(hit?.resp ?? '', { status: hit?.status ?? 599 });
  };
}

// ---- run one pass -----------------------------------------------------------------------------------------------------------------------------------
export async function runOnePass({ routeModulePath, ioStub }) {
  const mod = await import(routeModulePath);
  const router = mod.default(ioStub);
  const layer = router.stack.find((l) => l.route && l.route.path === '/acd/setup-detection');
  if (!layer) throw new Error('route /acd/setup-detection not found');
  const handler = layer.route.stack[0].handle;
  let status = 200, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await handler({ query: { fresh: '1' } }, res);
  return { status, body };
}
export async function settle(isIdle, maxMs = 90000) {
  const t0 = nowReal();
  while (nowReal() - t0 < maxMs) { await new Promise((r) => setTimeout(r, 200)); if (isIdle()) { await new Promise((r) => setTimeout(r, 400)); if (isIdle()) return true; } }
  return false;
}

// ---- decisions, as comparable data ---------------------------------------------------------------------------------------------------------------
const stable = (v) => JSON.parse(enc(v));
export function decisionsOf({ status, body, writes, fetches }) {
  const w = writes.map((x) => enc({ sql: x.sql, params: x.params })).sort();
  const f = (fetches || []).map((c) => enc({ url: c.url, method: c.method, body: c.body })).sort();
  return { status, body: stable(body), writes: w, fetches: f };
}
export function diffDecisions(a, b) {
  const out = [];
  if (a.status !== b.status) out.push(`status ${a.status} -> ${b.status}`);
  if (enc(a.body) !== enc(b.body)) out.push('response body differs');
  const multiset = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  for (const [name, x, y] of [['write', a.writes, b.writes], ['fetch', a.fetches, b.fetches]]) {
    const mx = multiset(x), my = multiset(y);
    for (const [k, n] of mx) if ((my.get(k) || 0) < n) out.push(`${name} only in A (x${n - (my.get(k) || 0)}): ${k.slice(0, 260)}`);
    for (const [k, n] of my) if ((mx.get(k) || 0) < n) out.push(`${name} only in B (x${n - (mx.get(k) || 0)}): ${k.slice(0, 260)}`);
  }
  return out;
}
export const ioStub = { emit() {}, on() {}, sockets: { emit() {} } };
export const readJson = (p) => dec(fs.readFileSync(p, 'utf8'));
