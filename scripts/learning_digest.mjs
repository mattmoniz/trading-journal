// CLI wrapper for server/services/learningDigestService.js — see that file for the
// actual logic/comments. Run manually: node scripts/learning_digest.mjs
// (No socket emission from here — that only happens via the server's own cron,
// which passes its live `io` instance.)

import { runLearningDigest } from '../server/services/learningDigestService.js';

const result = await runLearningDigest(null);
console.log(`[learning_digest] ${result.count} events: ${result.breakdown.pattern} pattern, ${result.breakdown.setupStatus} setup-status, ${result.breakdown.dayType} day-type, ${result.breakdown.stopTarget} stop/target.`);
process.exit(0);
