import express from 'express';
import { query } from '../db.js';
import multer from 'multer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getContextMarkerStats } from '../services/annotationPatterns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Multer: date comes from query param so it's available in destination()
const annotationStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dir = join(__dirname, '..', 'uploads', 'annotations', date);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    // client sends pre-compressed JPEG; keep extension as-is or default to jpg
    const ext = (file.originalname.match(/\.(webp|jpg|jpeg|png)$/i)?.[1] || 'jpg').toLowerCase();
    cb(null, `${ts}_${rand}.${ext}`);
  },
});

const annotationUpload = multer({
  storage: annotationStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB ceiling; client pre-compresses to ~200KB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  },
});

// ── GET /api/annotations?date=YYYY-MM-DD ─────────────────────────────────────
// Also supports ?from=YYYY-MM-DD&to=YYYY-MM-DD for range queries (future coaching)
router.get('/annotations', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    let result;
    if (date) {
      result = await query(
        'SELECT * FROM trade_annotations WHERE trade_date = $1 ORDER BY created_at',
        [date]
      );
    } else if (from && to) {
      result = await query(
        'SELECT * FROM trade_annotations WHERE trade_date >= $1 AND trade_date <= $2 ORDER BY trade_date, created_at',
        [from, to]
      );
    } else {
      return res.status(400).json({ error: 'date or from/to required' });
    }
    res.json({ annotations: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/annotations/upload-image?date=YYYY-MM-DD ───────────────────────
// Client pre-compresses to JPEG ≤200KB via canvas; server just stores it.
router.post('/annotations/upload-image', (req, res) => {
  annotationUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const date = req.query.date || 'misc';
    const relativePath = `annotations/${date}/${req.file.filename}`;
    res.json({ path: relativePath, size: req.file.size });
  });
});

// ── POST /api/annotations ─────────────────────────────────────────────────────
router.post('/annotations', async (req, res) => {
  try {
    const { trade_date, trade_ids, annotation_text, setup_type, context_marker, image_path } = req.body;
    if (!trade_date || !Array.isArray(trade_ids) || trade_ids.length === 0) {
      return res.status(400).json({ error: 'trade_date and trade_ids[] required' });
    }
    const result = await query(
      `INSERT INTO trade_annotations
         (trade_date, trade_ids, annotation_text, setup_type, context_marker, image_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        trade_date,
        trade_ids.map(Number),
        annotation_text || null,
        setup_type   || null,
        context_marker === 'reaction' ? 'reaction' : 'planned',
        image_path   || null,
      ]
    );
    res.json({ annotation: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/annotations/:id ──────────────────────────────────────────────────
router.put('/annotations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['annotation_text', 'setup_type', 'context_marker', 'image_path', 'correction_text', 'trade_ids'];
    const updates = {};
    for (const k of allowed) {
      if (k in req.body) updates[k] = req.body[k];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    // Cast trade_ids elements to int if present
    if (updates.trade_ids) updates.trade_ids = updates.trade_ids.map(Number);

    const keys = Object.keys(updates);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = [...keys.map(k => updates[k]), id];
    const result = await query(
      `UPDATE trade_annotations SET ${sets}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ annotation: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/annotations/:id ───────────────────────────────────────────────
router.delete('/annotations/:id', async (req, res) => {
  try {
    const existing = await query('SELECT image_path FROM trade_annotations WHERE id = $1', [req.params.id]);
    const imagePath = existing.rows[0]?.image_path;
    if (imagePath) {
      try { fs.unlinkSync(join(__dirname, '..', 'uploads', imagePath)); } catch {}
    }
    await query('DELETE FROM trade_annotations WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/annotations/pattern-stats ────────────────────────────────────────
// All-time win rate by context_marker (PLANNED vs REACTION). N<20 decisive = limited sample.
router.get('/annotations/pattern-stats', async (req, res) => {
  try {
    const stats = await getContextMarkerStats();
    res.json({ stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
