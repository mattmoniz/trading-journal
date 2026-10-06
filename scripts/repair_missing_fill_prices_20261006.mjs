// Repair (2026-10-06): fills the stop/exit price for trades whose broker messages hold a FILLED price but
// whose order row lacks it. Uses the same conversion and quote check as the live handler
// (applyPriceMultiplier + toTickPrice + classifyFill). Backs up first, in one transaction. Trades whose
// broker record has NO filled exit are NOT touched -- they are reported for review.
import { getClient, query } from '../server/db.js';
import { applyPriceMultiplier, toTickPrice, classifyFill } from '../server/services/sierraChart/priceMultiplier.js';
const MULT = 0.00999999776482582, BACKUP = 'order_placements_missing_fill_repair_backup_20261006';
const targets = (await query(`SELECT o.id, o.setup_id, o.purpose, o.side, o.order_type, o.price1::float px1, o.status, o.client_order_id cid
  FROM order_placements o WHERE o.setup_id IN (131237,131377,131378,131379) AND o.purpose IN ('STOP','EXIT') ORDER BY o.id`)).rows;
const cl = await getClient();
let done = 0;
try {
  await cl.query('BEGIN');
  await cl.query(`CREATE TABLE IF NOT EXISTS ${BACKUP} AS SELECT * FROM order_placements WHERE false`);
  await cl.query(`INSERT INTO ${BACKUP} SELECT * FROM order_placements WHERE id = ANY($1::int[])`, [targets.map(t => t.id)]);
  for (const t of targets) {
    const f = (await cl.query(`SELECT (raw_message::jsonb->>'OrderStatus') st, (raw_message::jsonb->>'AverageFillPrice') avg, (raw_message::jsonb->>'InfoText') info FROM order_placements_updates WHERE client_order_id=$1 ORDER BY id`, [t.cid])).rows;
    const fill = f.filter(x => x.st === '7').at(-1);
    if (!fill || !fill.avg) { console.log(`skip ${t.id} (${t.purpose} ${t.setup_id}): no FILLED message`); continue; }
    const px = toTickPrice(applyPriceMultiplier(Number(fill.avg), MULT));
    const c = classifyFill({ orderType: t.order_type, side: t.side, price1: t.px1, fillPrice: px, infoText: fill.info });
    if (c.status === 'REFUSED') { console.log(`refused ${t.id}: ${c.reason}`); continue; }
    await cl.query(`UPDATE order_placements SET avg_fill_price = $2, status = 'FILLED', filled_quantity = 1 WHERE id = $1`, [t.id, px]);
    console.log(`set ${t.id} (${t.purpose} ${t.setup_id}) = ${px} [${c.status}]`); done++;
  }
  await cl.query('COMMIT');
} catch (e) { await cl.query('ROLLBACK'); console.error('ROLLED BACK', e.message); process.exit(1); }
console.log(`${done} row(s) repaired. Backup: ${BACKUP}`);
process.exit(0);
