// P&L from the broker's own fills (added 2026-10-06). Pure function, no database.
// The app's stored P&L is built from its own price model. This computes what the broker actually did,
// from the entry fill and the exit fill (stop or market exit). Returns null when either fill price is
// missing, so a gap in the record is never turned into a guessed number.
import { LIVE_INSTRUMENT } from '../../config/instruments.js';

export function brokerPnlFromFills({ entrySide, entryAvg, exitAvg, quantity = 1 }) {
  if (!Number.isFinite(entryAvg) || !Number.isFinite(exitAvg)) return null;
  const sign = entrySide === 'BUY' ? 1 : entrySide === 'SELL' ? -1 : null;
  if (sign == null) return null;
  const points = (exitAvg - entryAvg) * sign;
  return points * LIVE_INSTRUMENT.dollarsPerPoint * quantity - LIVE_INSTRUMENT.commissionPerRoundTrip * quantity;
}
