import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { parseSierraTradeLog } from '../parsers/sierraParser.js';
import { importSierraTrades } from '../services/tradeImportService.js';

class SierraWatcher {
  constructor(io, config = {}) {
    this.io = io;
    this.config = {
      watchPath: config.watchPath || process.env.SIERRA_WATCH_PATH,
      filePattern: config.filePattern || process.env.SIERRA_FILE_PATTERN || 'sierra_trades*.txt',
      pollInterval: config.pollInterval || parseInt(process.env.SIERRA_POLL_INTERVAL || '1000'),
      stabilityThreshold: config.stabilityThreshold || parseInt(process.env.SIERRA_STABILITY_THRESHOLD || '2000'),
      ...config
    };
    this.watcher = null;
    this.isProcessing = false;
    this.lastFileHash = new Map();
  }

  start() {
    console.log('🔍 Starting Sierra Chart file watcher...');
    console.log(`📂 Watching: ${this.config.watchPath}/${this.config.filePattern}`);

    const watchPattern = path.join(this.config.watchPath, this.config.filePattern);

    this.watcher = chokidar.watch(watchPattern, {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      interval: this.config.pollInterval,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThreshold,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath) => this.handleFileChange(filePath, 'added'))
      .on('change', (filePath) => this.handleFileChange(filePath, 'changed'))
      .on('error', (error) => this.handleError(error))
      .on('ready', () => {
        console.log('✅ Sierra Chart watcher ready');
        this.io.emit('watcher-status', { status: 'ready', watchPath: this.config.watchPath });
      });

    return this;
  }

  async handleFileChange(filePath, changeType) {
    if (this.isProcessing) {
      console.log('⏳ Already processing a file, queuing...');
      return;
    }

    try {
      this.isProcessing = true;

      const fileHash = await this.getFileHash(filePath);
      if (this.lastFileHash.get(filePath) === fileHash) {
        console.log('📋 File unchanged, skipping...');
        return;
      }

      console.log(`📊 Sierra Chart file ${changeType}: ${path.basename(filePath)}`);

      this.io.emit('import-started', { file: path.basename(filePath), timestamp: new Date() });

      const content = fs.readFileSync(filePath, 'utf8');
      const trades = parseSierraTradeLog(content);

      console.log(`📈 Parsed ${trades.length} trades from Sierra Chart`);

      const result = await importSierraTrades(trades);

      this.lastFileHash.set(filePath, fileHash);

      this.io.emit('trades-updated', {
        file: path.basename(filePath),
        imported: result.imported,
        skipped: result.skipped,
        total: trades.length,
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
    } finally {
      this.isProcessing = false;
    }
  }

  async getFileHash(filePath) {
    const stats = fs.statSync(filePath);
    return `${stats.size}-${stats.mtime.getTime()}`;
  }

  handleError(error) {
    console.error('❌ Watcher error:', error);
    this.io.emit('watcher-error', { error: error.message, timestamp: new Date() });
  }

  stop() {
    if (this.watcher) {
      console.log('🛑 Stopping Sierra Chart watcher...');
      this.watcher.close();
      this.watcher = null;
      this.io.emit('watcher-status', { status: 'stopped' });
    }
  }

  getStatus() {
    return {
      running: this.watcher !== null,
      watchPath: this.config.watchPath,
      filePattern: this.config.filePattern,
      isProcessing: this.isProcessing
    };
  }
}

export default SierraWatcher;
