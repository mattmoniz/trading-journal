// Owns the ONE long-lived Python reader (scripts/tell_context/reader.py) that appends the context of every live tell fire to tell_context_fires (docs/TELL_CONTEXT_OVERLAY_SCOPE_20261103.md).
// Read-only with respect to trading: it places no orders, writes nothing to active_setups / amt_tell_*, gates nothing. If it is down the only loss is that fires are logged without context (shown as
// a problem string for the Tell tab); the live tell sidecar and the rest of the server are unaffected. Supervision lives in server/lib/pythonService.js.
import { createPythonService } from '../lib/pythonService.js';

export const TELL_CONTEXT_PORT = 8897;
const svc = createPythonService({ name: 'tellContextServiceManager', script: 'scripts/tell_context/reader.py', port: TELL_CONTEXT_PORT, logPrefix: '[tell-context' });
export const startTellContextService = svc.start;
export const stopTellContextService = svc.stop;
export const getTellContextStatus = svc.status;
