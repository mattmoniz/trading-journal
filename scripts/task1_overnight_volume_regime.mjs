import { Client } from 'pg';

const client = new Client({
  user: 'trader',
  host: 'localhost',
  database: 'trading_journal',
  password: 'trader123',
});

async function main() {
  await client.connect();

  console.log("Fetching overnight sessions...");
  const resOvernight = await client.query(`
    WITH rth_days AS (
      SELECT DISTINCT ts::date as d
      FROM price_bars_primary
      WHERE symbol='NQ' AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ),
    overnight_bars AS (
      SELECT rd.d as session_date, pb.ts, pb.high, pb.low, pb.volume
      FROM rth_days rd
      JOIN price_bars_primary pb
        ON pb.symbol='NQ'
        AND pb.ts >= (rd.d - interval '1 day') + interval '18 hours'
        AND pb.ts < rd.d + interval '9 hours 30 minutes'
    )
    SELECT 
      session_date::text as session_date, 
      count(*) as bars,
      max(high) - min(low) as trange,
      sum(volume) as vol
    FROM overnight_bars
    GROUP BY session_date
    HAVING count(*) > 800
    ORDER BY session_date;
  `);

  const sessions = resOvernight.rows;
  console.log("Found " + sessions.length + " sessions passing density filter (>800 bars).");

  // Compute rolling terciles (20-session window) based on VOLUME instead of trange
  const labels = {};
  for (let i = 19; i < sessions.length; i++) {
    const window = [];
    for (let j = i - 19; j <= i; j++) {
      window.push(Number(sessions[j].vol));
    }
    const current = Number(sessions[i].vol);
    window.sort((a,b) => a - b);
    
    const t1 = window[6]; 
    const t2 = window[13];
    
    let label = 'NORMAL';
    if (current <= t1) label = 'LOW';
    else if (current >= t2) label = 'HIGH';
    
    labels[sessions[i].session_date] = label;
  }
  
  const daysWithLabel = Object.keys(labels).length;
  console.log("Computed rolling labels for " + daysWithLabel + " days based on overnight volume.");

  const labeledDatesStr = Object.keys(labels).map(d => "'" + d + "'").join(',');
  
  const resLevels = await client.query(`
    SELECT trade_date::text as d, level_name, price, category
    FROM level_prices
    WHERE trade_date::text IN (${labeledDatesStr})
  `);
  
  const levelsByDay = {};
  for (const r of resLevels.rows) {
    if (!levelsByDay[r.d]) levelsByDay[r.d] = [];
    levelsByDay[r.d].push({ name: r.level_name, price: Number(r.price), cat: r.category });
  }
  
  const resBars = await client.query(`
    SELECT ts, ts::date::text as d, open, high, low, close
    FROM price_bars_primary
    WHERE symbol='NQ' 
      AND ts::date::text IN (${labeledDatesStr})
      AND (EXTRACT(hour FROM ts)*60+EXTRACT(minute FROM ts)) BETWEEN 570 AND 959
    ORDER BY ts
  `);
  
  const barsByDay = {};
  for (const r of resBars.rows) {
    if (!barsByDay[r.d]) barsByDay[r.d] = [];
    barsByDay[r.d].push({
      ts: r.ts,
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      minute: new Date(r.ts).getUTCHours() * 60 + new Date(r.ts).getUTCMinutes()
    });
  }

  const results = [];
  
  for (const [d, label] of Object.entries(labels)) {
    const levels = levelsByDay[d];
    const bars = barsByDay[d];
    if (!levels || !bars || levels.length === 0 || bars.length === 0) continue;
    
    let firstTouch = null;
    let touchIndex = -1;
    
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      for (const lvl of levels) {
        if (b.low <= lvl.price && b.high >= lvl.price) {
          firstTouch = { level: lvl, bar: b };
          touchIndex = i;
          break;
        }
      }
      if (firstTouch) break;
    }
    
    if (firstTouch) {
      const forwardIndex = touchIndex + 15;
      if (forwardIndex < bars.length) {
        const entryPrice = firstTouch.level.price;
        const exitPrice = bars[forwardIndex].close;
        
        let approachFromAbove = true;
        if (touchIndex > 0) {
          approachFromAbove = bars[touchIndex - 1].close > entryPrice;
        } else {
          approachFromAbove = bars[touchIndex].close > entryPrice;
        }
        
        const rawMove = exitPrice - entryPrice;
        const signedMove = approachFromAbove ? rawMove : -rawMove;
        
        results.push({
          date: d,
          label,
          move: signedMove
        });
      }
    }
  }
  
  const stats = {
    LOW: { n: 0, sum: 0 },
    NORMAL: { n: 0, sum: 0 },
    HIGH: { n: 0, sum: 0 },
    ALL: { n: 0, sum: 0 }
  };
  
  for (const r of results) {
    stats[r.label].n++;
    stats[r.label].sum += r.move;
    stats.ALL.n++;
    stats.ALL.sum += r.move;
  }
  
  for (const [k, v] of Object.entries(stats)) {
    const mean = v.n > 0 ? (v.sum / v.n).toFixed(2) : '0.00';
    console.log(k.padEnd(6) + " | N=" + v.n.toString().padStart(3) + " | Mean Move=" + mean.padStart(6) + " pts ($" + (mean*2).toFixed(2) + ")");
  }

  await client.end();
}

main().catch(console.error);
