import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import SierraWatcher from './watchers/sierraWatcher.js';
import { manualImportFromFile, getImportHistory } from './services/tradeImportService.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

const sierraWatcher = new SierraWatcher(io);
sierraWatcher.start();

io.on('connection', (socket) => {
  console.log('🔌 Dashboard connected:', socket.id);
  socket.emit('watcher-status', sierraWatcher.getStatus());

  socket.on('disconnect', () => {
    console.log('🔌 Dashboard disconnected:', socket.id);
  });
});

app.get('/api/sierra/status', (req, res) => {
  res.json(sierraWatcher.getStatus());
});

app.post('/api/sierra/import', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  try {
    console.log('📤 Manual import requested:', filePath);
    const result = await manualImportFromFile(filePath);
    
    io.emit('trades-updated', {
      file: filePath.split(/[/\\]/).pop(),
      manual: true,
      ...result,
      timestamp: new Date()
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Manual import error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sierra/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = await getImportHistory(limit);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    watcher: sierraWatcher.getStatus(),
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Sierra Chart Integration Server running on port ${PORT}`);
  console.log(`👀 Watching: ${sierraWatcher.config.watchPath}`);
  console.log(`📊 Dashboard WebSocket ready`);
});

export default app;
