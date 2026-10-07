// Switches which DTC account/instance .env points at, without touching anything else in the
// file (2026-10-07, built per user request after the Evaluator instance grew multiple real
// accounts -- DeepSeek's own review flagged "two accounts on two ports on one machine...
// increases the chance of a wrong port/trade-account mapping" as a real risk of hand-editing
// .env). Profiles live in config/dtc-accounts/*.env, one file per account, each self-describing
// (real vs sim, which venue, what it's for) -- see that directory for the actual list.
//
// Deliberately does NOT restart the server or touch the kill switch -- this only rewrites
// .env's DTC_* lines. A restart is a separate, explicit step (and always disarms on boot by
// design -- see connectionManager.js's forceHaltOnBoot).
//
// Usage: node scripts/switch_dtc_account.mjs <profile-name>
//        node scripts/switch_dtc_account.mjs --list
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROFILE_DIR = join(REPO_ROOT, 'config', 'dtc-accounts');
const ENV_PATH = join(REPO_ROOT, '.env');

function listProfiles() {
  return readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.env')).map((f) => f.replace(/\.env$/, ''));
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const arg = process.argv[2];
const profiles = listProfiles();

if (!arg || arg === '--list') {
  console.log('Available DTC account profiles (config/dtc-accounts/):');
  for (const p of profiles) console.log(`  ${p}`);
  console.log('\nUsage: node scripts/switch_dtc_account.mjs <profile-name>');
  process.exit(arg === '--list' ? 0 : 1);
}

// Exact match only -- no fuzzy/partial matching, so a typo fails loudly instead of silently
// picking the wrong account.
if (!profiles.includes(arg)) {
  console.error(`No such profile "${arg}". Available: ${profiles.join(', ')}`);
  process.exit(1);
}

const profilePath = join(PROFILE_DIR, `${arg}.env`);
const profileVars = parseEnvFile(readFileSync(profilePath, 'utf8'));
const dtcKeys = Object.keys(profileVars).filter((k) => k.startsWith('DTC_'));
if (dtcKeys.length === 0) {
  console.error(`Profile "${arg}" has no DTC_* keys -- refusing to apply an empty switch.`);
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  console.error(`.env not found at ${ENV_PATH} -- nothing to switch.`);
  process.exit(1);
}

const backupPath = `${ENV_PATH}.bak.${Date.now()}`;
copyFileSync(ENV_PATH, backupPath);

const currentLines = readFileSync(ENV_PATH, 'utf8').split('\n');
const currentVars = parseEnvFile(currentLines.join('\n'));

const changes = [];
const newLines = currentLines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=/);
  if (m && dtcKeys.includes(m[1])) {
    const key = m[1];
    const oldVal = currentVars[key];
    const newVal = profileVars[key];
    if (oldVal !== newVal) changes.push({ key, oldVal, newVal });
    return `${key}=${newVal}`;
  }
  return line;
});

// Any DTC_* key the profile defines that .env doesn't already have a line for gets appended --
// this only happens if .env's DTC_* block is missing a key some profile expects.
const missingKeys = dtcKeys.filter((k) => !(k in currentVars));
for (const key of missingKeys) {
  newLines.push(`${key}=${profileVars[key]}`);
  changes.push({ key, oldVal: '(not set)', newVal: profileVars[key] });
}

writeFileSync(ENV_PATH, newLines.join('\n'));

console.log(`Switched .env to profile "${arg}" (backup saved: ${backupPath})`);
if (changes.length === 0) {
  console.log('No changes -- .env already matched this profile.');
} else {
  console.log('Changed:');
  for (const c of changes) console.log(`  ${c.key}: ${c.oldVal} -> ${c.newVal}`);
}
console.log('\n.env rewritten. The running server (if any) has NOT been restarted and still has');
console.log('the old values loaded -- restart is a separate, explicit step.');
