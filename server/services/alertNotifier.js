// Outbound alert to the user's phone (2026-10-26). The only channel is the user's OWN Home Assistant: POST to a webhook trigger whose address is in .env as HA_ALERT_WEBHOOK_URL
// (an HA automation with a webhook trigger turns it into a mobile-app push). No third-party service is used, and nothing is sent when the variable is unset.
export async function sendAlert(title, message) {
  const url = process.env.HA_ALERT_WEBHOOK_URL;
  if (!url) return { ok: false, note: 'HA_ALERT_WEBHOOK_URL not set: alert logged only' };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, message, source: 'trading-journal' }), signal: AbortSignal.timeout(8000) });
  return { ok: r.ok, note: r.ok ? null : `HA webhook returned ${r.status}` };
}
