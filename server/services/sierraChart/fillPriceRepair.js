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
    const p = Number(m?.AverageFillPrice) > 0 ? Number(m.AverageFillPrice) : Number(m?.LastFillPrice);
    if (m?.OrderStatus === RAW_FILLED_STATUS && Number.isFinite(p) && p > 0) return { rawAvg: p, infoText: m.InfoText };
  }
  return null;
}

export async function repairNullFillPrices(dtcClient, db = { query }) {
  const rows = await db.query(`
    SELECT o.id, o.setup_id, o.purpose, o.symbol, o.order_type, o.side, o.price1::float AS price1, o.client_order_id,
           a.entry_zone_low::float AS entry_level
    FROM order_placements o LEFT JOIN active_setups a ON a.id = o.setup_id
    WHERE o.status = 'FILLED' AND o.avg_fill_price IS NULL
      AND o.created_at > NOW() - interval '3 days'
    ORDER BY o.id`);
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
      // Magnitude guard (DeepSeek review 2026-10-19, finding 3): MARKET fills have no order-type price rule, so a wrong cached
      // multiplier would pass classifyFill. Same 5% band brokerPnlResolver.sanePrice() uses against the setup's own entry level;
      // it catches a x100 / /100 style error, which is the failure shape here. No entry level on record -> do not guess.
      const magnitudeOk = Number.isFinite(o.entry_level) && o.entry_level > 0 && converted != null && Math.abs(converted - o.entry_level) / o.entry_level < 0.05;
      if (!magnitudeOk) {
        out.stillNull++;
        if (!reportedRefusals.has(o.id)) console.error(`[sierraChart.fillRepair] NOT repaired ${o.purpose} setup_id=${o.setup_id} (${o.client_order_id}): converted ${converted} is not within 5% of the setup's entry level ${o.entry_level} (multiplier ${mult}, raw ${fill.rawAvg}). Left NULL.`);
        reportedRefusals.add(o.id);
        continue;
      }
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
