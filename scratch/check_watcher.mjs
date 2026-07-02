import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const TARGET_FILE = '/home/mmoniz/trading-journal/scratch/claude_request.md';
const HASH_FILE = '/home/mmoniz/trading-journal/scratch/.claude_request_last_hash';

function getMd5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

async function main() {
  if (!fs.existsSync(TARGET_FILE)) {
    console.log(`[ERROR] Target file ${TARGET_FILE} does not exist.`);
    process.exit(0);
  }

  const content = fs.readFileSync(TARGET_FILE, 'utf8');
  const currentHash = getMd5(content);

  let lastHash = '';
  if (fs.existsSync(HASH_FILE)) {
    lastHash = fs.readFileSync(HASH_FILE, 'utf8').trim();
  }

  if (currentHash !== lastHash) {
    console.log(`[CHANGED] The file has been updated!`);
    console.log(`Current MD5: ${currentHash}`);
    console.log(`Previous MD5: ${lastHash}`);
    
    // Save the new hash to cache
    fs.writeFileSync(HASH_FILE, currentHash, 'utf8');
  } else {
    console.log('[NO_CHANGE] No changes detected.');
  }
  process.exit(0);
}

main().catch(console.error);
