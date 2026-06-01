/**
 * Bar-triggered setup detection.
 * Called after each NQ bar insert in priceBars.js.
 * Calls the existing setup-detection endpoint (avoids duplicating logic)
 * and emits the result via socket so the frontend updates immediately.
 */

export async function detectAndEmitSetup(io, _tradeDate) {
  try {
    const port = process.env.PORT || 3001;
    const result = await fetch(`http://localhost:${port}/api/acd/setup-detection`, {
      headers: { 'x-internal': 'bar-trigger' },
    });
    if (!result.ok) return;
    const data = await result.json();

    if (data.setup) {
      io.emit('setup-detected', { ...data.setup, source: 'bar-triggered' });
    } else {
      io.emit('setup-state', {
        setup: null,
        source: 'bar-triggered',
        sessionClosed: data.sessionClosed || false,
        reason: data.reason || null,
      });
    }
  } catch (err) {
    console.error('[setupEmitter] Error:', err.message);
  }
}
