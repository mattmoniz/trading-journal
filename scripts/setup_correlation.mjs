import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/.env') });

const pool = new pg.Pool({ host: process.env.DB_HOST||'localhost', port: process.env.DB_PORT||5432, database: process.env.DB_NAME||'trading_journal', user: process.env.DB_USER||'trader', password: process.env.DB_PASSWORD||'trader123' });
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

const TOUCH=8, BARS=30, MIN=15;

async function run() {
  const hist = await q(`SELECT date::text, bias_dir, pts_vs_open FROM auction_history WHERE bias_dir IS NOT NULL ORDER BY date`);
  console.log(`\nAnalyzing ${hist.length} days...\n`);

  // acc[bias][setup] = { tested, profitable, pts[] }
  const acc = { LONG:{}, SHORT:{}, NEUTRAL:{} };

  for (const row of hist) {
    const { date, bias_dir } = row;
    const bars = await q(`
      SELECT ts, high::float h, low::float l, close::float c,
        SUM(close::float*volume::bigint) OVER (ORDER BY ts)/NULLIF(SUM(volume::bigint) OVER (ORDER BY ts),0) vw
      FROM price_bars WHERE symbol='NQ' AND ts::date=$1
        AND EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts) BETWEEN 570 AND 960
      ORDER BY ts`, [date]);
    if (bars.length < 50) continue;

    const pdR = await q(`SELECT MAX(ts::date::text) p FROM price_bars WHERE symbol='NQ' AND ts::date<$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [date]);
    const priorDate = pdR[0]?.p;
    if (!priorDate) continue;

    const pd = await q(`SELECT MAX(high)::float h, MIN(low)::float l FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16`, [priorDate]);
    const va = await q(`
      WITH vp AS (SELECT ROUND(low/0.25)*0.25 px, SUM(volume) vol FROM price_bars WHERE symbol='NQ' AND ts::date=$1 AND EXTRACT(hour FROM ts) BETWEEN 9 AND 16 GROUP BY ROUND(low/0.25)*0.25),
      t AS (SELECT SUM(vol) t FROM vp), pr AS (SELECT px FROM vp ORDER BY vol DESC LIMIT 1)
      SELECT p2.px::float poc,
        (SELECT MAX(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px DESC) cv FROM vp WHERE px>=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float vah,
        (SELECT MIN(px) FROM (SELECT px, SUM(vol) OVER (ORDER BY px ASC) cv FROM vp WHERE px<=p2.px) x WHERE cv<=(SELECT t*0.35 FROM t))::float val
      FROM vp, pr p2 GROUP BY p2.px LIMIT 1`, [priorDate]);
    const acd = await q(`SELECT or_high::float oh, or_low::float ol FROM acd_daily_log WHERE trade_date=$1`, [date]);

    const levels = [
      { k:'IBH',     p:acd[0]?.oh, t:'resistance' }, { k:'IBL',    p:acd[0]?.ol, t:'support' },
      { k:'PD VAH',  p:va[0]?.vah, t:'resistance' }, { k:'PD VAL', p:va[0]?.val, t:'support' },
      { k:'PD High', p:pd[0]?.h,   t:'resistance' }, { k:'PD Low', p:pd[0]?.l,   t:'support' },
    ].filter(l => l.p);

    const bucket = acc[bias_dir] || acc.NEUTRAL;

    for (const lv of levels) {
      const p = parseFloat(lv.p);
      for (let i=10; i<bars.length-BARS; i++) {
        const b = bars[i];
        const hit = lv.t==='resistance' ? b.h>=p-TOUCH&&b.h<=p+TOUCH : b.l<=p+TOUCH&&b.l>=p-TOUCH;
        if (!hit) continue;
        const fut = bars.slice(i+1, i+BARS+1);
        const mv = lv.t==='resistance' ? p-Math.min(...fut.map(x=>x.l)) : Math.max(...fut.map(x=>x.h))-p;
        if (!bucket[lv.k]) bucket[lv.k] = { tested:0, profitable:0, pts:[] };
        bucket[lv.k].tested++;
        if (mv>=MIN) { bucket[lv.k].profitable++; bucket[lv.k].pts.push(Math.round(mv)); }
        break;
      }
    }

    // VWAP cross
    for (let i=10; i<bars.length-BARS; i++) {
      const prev=bars[i-1], cur=bars[i];
      if (!prev?.vw||!cur?.vw) continue;
      const up=prev.c<prev.vw&&cur.c>cur.vw, dn=prev.c>prev.vw&&cur.c<cur.vw;
      if (!up&&!dn) continue;
      const fut=bars.slice(i+1,i+BARS+1);
      const mv=up?Math.max(...fut.map(x=>x.h))-cur.c:cur.c-Math.min(...fut.map(x=>x.l));
      const k=up?'VWAP Reclaim':'VWAP Break';
      if (!bucket[k]) bucket[k]={tested:0,profitable:0,pts:[]};
      bucket[k].tested++;
      if (mv>=MIN){bucket[k].profitable++;bucket[k].pts.push(Math.round(mv));}
      break;
    }
  }

  for (const dir of ['LONG','SHORT','NEUTRAL']) {
    const data = acc[dir];
    if (!Object.keys(data).length) continue;
    console.log('='.repeat(70));
    console.log(`MORNING BIAS: ${dir}`);
    console.log('='.repeat(70));
    console.log('Setup'.padEnd(14) + 'Tested'.padStart(8) + 'Hit%'.padStart(7) + 'Avg Pts'.padStart(10) + 'Max'.padStart(7) + '  Consistency');
    console.log('-'.repeat(70));
    const entries = Object.entries(data).sort((a,b) => {
      const pctA = a[1].profitable/a[1].tested, pctB = b[1].profitable/b[1].tested;
      return pctB - pctA;
    });
    for (const [k, v] of entries) {
      if (v.tested < 3) continue;
      const pct = (v.profitable/v.tested*100).toFixed(0);
      const avg = v.pts.length ? (v.pts.reduce((s,x)=>s+x,0)/v.pts.length).toFixed(0) : '—';
      const max = v.pts.length ? Math.max(...v.pts) : '—';
      const bar = '█'.repeat(Math.round(v.profitable/v.tested*10));
      console.log(`${k.padEnd(14)} ${String(v.tested).padStart(7)} ${(pct+'%').padStart(6)} ${(avg+'pts').padStart(9)} ${String(max).padStart(6)}  ${bar}`);
    }
    console.log();
  }
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
