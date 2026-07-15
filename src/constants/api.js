// Backend origin, bypassing the Vite dev proxy (vite.config.js `server.proxy['/api']`,
// same target port — keep both in sync if the backend port ever changes).
//
// Found 2026-07-15: routing every fetch through the proxy meant API traffic and the
// Vite dev server's own module-serving shared one origin (localhost:3000), so they
// competed for the browser's single HTTP/1.1 6-connections-per-origin budget — Morning
// Prep's own background polling could saturate all 6 and leave a newly-navigated-to
// view's module fetch stuck in the browser's own queue for 20s+ (confirmed via a `curl`
// to the exact stuck URL from a separate process returning instantly — the server was
// never hung, the browser's connection pool was). Fetching the API directly from its
// own origin gives it a separate 6-connection budget, so the two no longer starve each
// other. Backend already has permissive CORS (`server/index.js` `app.use(cors())`, no
// cookies/auth in this app) so no credentials wrinkle.
//
// Briefly reverted same session over a network-topology worry (dev env is WSL2 — would
// port 3002 actually be reachable from wherever the real browser runs, not just from
// Playwright's browser running inside the same container as the servers?). User confirmed
// they open the app via plain `http://localhost:3000` — WSL2's default `localhostForwarding`
// auto-forwards *every* port a process listens on to the Windows host, not just the one
// visited first, so :3002 should already be reachable the same way :3000 is. Re-applied.
// If this ever breaks (page loads but every API call fails/hangs), that assumption was
// wrong — check `.wslconfig`'s `localhostForwarding` setting before reverting again.
// Full writeup: docs/OPEN_THREADS.md.
export const API_URL = `${window.location.protocol}//${window.location.hostname}:3002/api`;
