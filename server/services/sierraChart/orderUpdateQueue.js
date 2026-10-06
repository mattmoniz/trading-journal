// Serializes order-update processing per ClientOrderID (added 2026-10-06).
// Found live 2026-10-05: the broker sent three updates for one exit within 0.4ms (PENDING_OPEN,
// OPEN, FILLED). Each was processed concurrently, read the same stale status, and the last write
// (PENDING_OPEN) overwrote the FILLED. Running each update only after the previous one for the
// same order finishes means each check sees the real current state. Updates for different
// orders still run in parallel.

const tails = new Map(); // clientOrderId -> promise of the last queued update

export function runSerializedByKey(key, task) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(() => task());
  const tail = run.catch(() => {}); // a failed update must not block later ones
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
