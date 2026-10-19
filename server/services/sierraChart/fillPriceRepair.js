// Repairs FILLED orders stored with no avg_fill_price (added 2026-10-19).
//
// Why: applyOrderUpdate() (reconciliation.js) leaves avg_fill_price NULL when the symbol's price multiplier is
// unknown at fill time, or when the converted fill fails the order-type sanity check. The raw broker message is
// always kept (order_placements_updates), so the price is recoverable once the multiplier is known. Until it is
// repaired, a filled trade has no entry price, so dllGate.js cannot size its worst case.
//
// Same conversion path as the live update (getPriceMultiplier -> applyPriceMultiplier -> toTickPrice ->
// classifyFill). It never invents a price from a heuristic, and never overwrites a price that is already set.
// A fill that fails the sanity check stays NULL and is reported, exactly as the live path does.
import { query } from '../../db.js';
import { getPriceMultiplier, applyPriceMultiplier, classifyFill, toTickPrice } from './priceMultiplier.js';
import { recordBrokerPnlForSetup } from './brokerPnlWriter.js';

const RAW_FILLED_STATUS = 7; // DTC OrderStatusEnum ORDER_STATUS_FILLED
const reportedRefusals = new Set(); // order ids already reported, so a permanent refusal logs once, not every sweep

/** Newest FILLED raw message for a client order id carrying a non-zero AverageFillPrice, or null. */
export function pickRawFill(rawMessages) {
  for (const raw of rawMessages) {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const p = Number(m?.AverageFillPrice);
    if (m?.OrderStatus === RAW_FILLED_STATUS && Number.isFinite(p) && p > 0) return { rawAvg: p, infoText: m.InfoText };
  }
  return null;
}

export async function repairNullFillPrices(dtcClient, db = { query }) {
  const rows = await db.query(`
    SELECT id, setup_id, purpose, symbol, order_type, side, price1::float AS price1, client_order_id
    FROM order_placements
    WHERE status = 'FILLED' AND avg_fill_price IS NULL AND filled_quantity > 0
      AND created_at > NOW() - interval '3 days'
    ORDER BY id`);
  const out = { checked: rows.rows.length, repaired: 0, stillNull: 0 };
  for (const o of rows.rows) {
    try {
      const raws = await db.query(`SELECT raw_message FROM order_placements_updates WHERE client_order_id = $1 ORDER BY id DESC`, [o.client_order_id]);
      const fill = pickRawFill(raws.rows.map(r => r.raw_message));
      if (!fill) { out.stillNull++; continue; }
      const mult = await getPriceMultiplier(dtcClient, o.symbol).catch(() => null);
      if (mult == null) { out.stillNull++; continue; } // multiplier still unknown -- retried next sweep
      const converted = toTickPrice(applyPriceMultiplier(fill.rawAvg, mult));
      const check = classifyFill({ orderType: o.order_type, side: o.side, price1: o.price1, fillPrice: converted, infoText: fill.infoText });
      if (converted == null || check.status === 'REFUSED') {
        out.stillNull++;
        if (!reportedRefusals.has(o.id)) console.error(`[sierraChart.fillRepair] REFUSED repair for ${o.purpose} setup_id=${o.setup_id} (${o.client_order_id}): ${check.reason ?? 'unconvertible'}. raw=${fill.rawAvg} multiplier=${mult}. Left NULL.`);
        reportedRefusals.add(o.id);
        continue;
      }
      const u = await db.query(`UPDATE order_placements SET avg_fill_price = $2, last_update_at = now() WHERE id = $1 AND avg_fill_price IS NULL`, [o.id, converted]);
      if (u.rowCount === 0) continue;
      out.repaired++;
      console.log(`[sierraChart.fillRepair] repaired ${o.purpose} setup_id=${o.setup_id}: raw=${fill.rawAvg} x multiplier=${mult} -> ${converted.toFixed(2)}`);
      // A repaired exit/entry may complete the round trip; the writer needs both prices and never guesses.
      await recordBrokerPnlForSetup(o.setup_id, db).catch((e) => console.error(`[sierraChart.fillRepair] broker P&L write failed for setup_id=${o.setup_id}:`, e.message));
    } catch (e) {
      out.stillNull++;
      console.error(`[sierraChart.fillRepair] order ${o.id} failed:`, e.message);
    }
  }
  return out;
}
