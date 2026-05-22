import fs from 'fs';
import path from 'path';
import { parseSierraTradeLog } from '../parsers/sierraParser.js';
import { importSierraTrades } from '../services/tradeImportService.js';

// Uses plain setInterval directory scanning instead of chokidar.
// Chokidar's usePolling is unreliable on WSL2 /mnt/c/ Windows mounts —
// inotify events don't propagate across the WSL/Windows boundary.

class SierraWatcher {
  constructor(io, config = {}) {
    this.io = io;
    this.config = {
      watchPath: config.watchPath || process.env.SIERRA_WATCH_PATH,
      filePattern: config.filePattern || process.env.SIERRA_FILE_PATTERN || 'sierra_trades*.txt',
      pollInterval: config.pollInterval || parseInt(process.env.SIERRA_POLL_INTERVAL || '5000'),
      stabilityThreshold: config.stabilityThreshold || parseInt(process.env.SIERRA_STABILITY_THRESHOLD || '2000'),
      ...config
    };
    this.timer = null;
    this.isProcessing = false;
    this.queue = []; // pending [filePath, changeType] pairs
    this.knownFiles = new Map(); // filePath -> { size, mtime }
  }

  start() {
    console.log('🔍 Starting Sierra Chart file watcher (setInterval mode)...');
    console.log(`📂 Watching: ${this.config.watchPath} for ${this.config.filePattern}`);

    // Silently snapshot existing files so they aren't treated as new on startup
    this._initSnapshot();
    this.timer = setInterval(() => this._scan(), this.config.pollInterval);

    this.io.emit('watcher-status', { status: 'ready', watchPath: this.config.watchPath });
    return this;
  }

  _initSnapshot() {
    try {
      const dir = this.config.watchPath;
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter(f => this._matchesPattern(f));
      for (const filename of files) {
        const filePath = path.join(dir, filename);
        try {
          const stats = fs.statSync(filePath);
          this.knownFiles.set(filePath, `${stats.size}-${stats.mtimeMs}`);
        } catch (e) { /* ignore */ }
      }
      console.log(`📋 Snapshot: ${this.knownFiles.size} existing file(s) registered (not re-imported)`);
    } catch (err) {
      console.error('❌ Watcher snapshot error:', err.message);
    }
  }

  _matchesPattern(filename) {
    // Supports comma-separated glob patterns e.g. "TradeActivityLog*.txt,TradesList.txt"
    const patterns = this.config.filePattern.split(',').map(p => p.trim());
    return patterns.some(pattern => {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${escaped}$`, 'i').test(filename);
    });
  }

  _scan() {
    try {
      const dir = this.config.watchPath;
      if (!fs.existsSync(dir)) return;

      const files = fs.readdirSync(dir).filter(f => this._matchesPattern(f));

      for (const filename of files) {
        const filePath = path.join(dir, filename);
        try {
          const stats = fs.statSync(filePath);
          const fingerprint = `${stats.size}-${stats.mtimeMs}`;
          const known = this.knownFiles.get(filePath);

          if (!known) {
            console.log(`🔔 New file detected: ${filename}`);
            this.knownFiles.set(filePath, fingerprint);
            this.handleFileChange(filePath, 'added');
          } else if (known !== fingerprint) {
            console.log(`🔔 File changed: ${filename}`);
            this.knownFiles.set(filePath, fingerprint);
            this.handleFileChange(filePath, 'changed');
          }
        } catch (e) {
          // File may have been removed mid-scan, ignore
        }
      }
    } catch (err) {
      console.error('❌ Watcher scan error:', err.message);
    }
  }

  handleFileChange(filePath, changeType) {
    this.queue.push([filePath, changeType]);
    if (!this.isProcessing) this._processQueue();
  }

  async _processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const [filePath, changeType] = this.queue.shift();
      try {
        console.log(`📊 Sierra Chart file ${changeType}: ${path.basename(filePath)}`);
        this.io.emit('import-started', { file: path.basename(filePath), timestamp: new Date() });

        // Wait for stability threshold before reading (file may still be writing)
        await new Promise(r => setTimeout(r, this.config.stabilityThreshold));

        const content = fs.readFileSync(filePath, 'utf8');
        const { trades, formatType, hasPnl, warning } = parseSierraTradeLog(content);

        console.log(`📈 Parsed ${trades.length} trades from Sierra Chart`);

        if (warning) {
          console.warn(`🚫 Rejected ${path.basename(filePath)}: ${warning}`);
          this.io.emit('import-rejected', {
            file: path.basename(filePath),
            formatType,
            warning,
            timestamp: new Date()
          });
          continue;
        }

        const result = await importSierraTrades(trades);

        this.io.emit('trades-updated', {
          file: path.basename(filePath),
          imported: result.imported,
          skipped: result.skipped,
          total: trades.length,
          formatType,
          hasPnl,
          timestamp: new Date()
        });

        console.log(`✅ Import complete: ${result.imported} imported, ${result.skipped} skipped`);
      } catch (error) {
        console.error('❌ Error processing Sierra Chart file:', error);
        this.io.emit('import-error', {
          file: path.basename(filePath),
          error: error.message,
          timestamp: new Date()
        });
      }
    }

    this.isProcessing = false;
  }

  stop() {
    if (this.timer) {
      console.log('🛑 Stopping Sierra Chart watcher...');
      clearInterval(this.timer);
      this.timer = null;
      this.io.emit('watcher-status', { status: 'stopped' });
    }
  }

  getStatus() {
    return {
      running: this.timer !== null,
      watchPath: this.config.watchPath,
      filePattern: this.config.filePattern,
      isProcessing: this.isProcessing,
      trackedFiles: this.knownFiles.size
    };
  }
}

export default SierraWatcher;
