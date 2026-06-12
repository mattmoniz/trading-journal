import { query } from '../db.js';

const CONFIDENCE_THRESHOLD = 20;

// Per-fill stats grouped by context_marker (PLANNED vs REACTION vs unset).
// decisive = wins + losses, excluding scratch (pnl == 0) fills.
// confident = decisive >= 20 — below that, callers must show "limited sample", never a win rate.
export async function getContextMarkerStats() {
  const rows = await query(`
    SELECT a.context_marker,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE t.pnl > 0) AS wins,
      COUNT(*) FILTER (WHERE t.pnl < 0) AS losses,
      ROUND(SUM(t.pnl)::numeric, 2) AS total_pnl
    FROM trade_annotations a
    JOIN trades t ON t.id = ANY(a.trade_ids)
    GROUP BY a.context_marker
  `);

  const result = {};
  for (const row of rows.rows) {
    const key = row.context_marker || 'unset';
    const wins = parseInt(row.wins);
    const losses = parseInt(row.losses);
    const decisive = wins + losses;
    const winRate = decisive >= CONFIDENCE_THRESHOLD ? Math.round((wins / decisive) * 100) : null;
    result[key] = {
      n: parseInt(row.n),
      wins, losses, decisive,
      totalPnl: parseFloat(row.total_pnl) || 0,
      winRate,
      confident: decisive >= CONFIDENCE_THRESHOLD,
    };
  }
  return result;
}
