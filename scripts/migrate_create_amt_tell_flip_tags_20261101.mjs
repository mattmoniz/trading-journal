// Creates amt_tell_flip_tags: the outcome-blind delta-flip tag of every live tell fire (docs: scripts/amt_vbars/PREREG_FLIP_DISAGREE_FORWARD.md). New table only, idempotent.
import { query } from '../server/db.js';
await query(`CREATE TABLE IF NOT EXISTS amt_tell_flip_tags (
  tell_trade_id BIGINT PRIMARY KEY,
  trade_date DATE NOT NULL,
  bar_rule VARCHAR(10) NOT NULL,
  sig_idx INTEGER NOT NULL,
  tell_dir SMALLINT NOT NULL,
  vote SMALLINT NOT NULL,
  grp VARCHAR(10) NOT NULL CHECK (grp IN ('AGREE','DISAGREE','NONE')),
  prior_streak INTEGER NOT NULL DEFAULT 0,
  n_flips_30 INTEGER NOT NULL DEFAULT 0,
  flip_source VARCHAR(24) NOT NULL,
  true_vote SMALLINT,
  true_grp VARCHAR(10),
  validated BOOLEAN,
  bars_n INTEGER,
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
await query(`CREATE INDEX IF NOT EXISTS idx_amt_tell_flip_tags_date ON amt_tell_flip_tags (trade_date)`);
const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='amt_tell_flip_tags' ORDER BY ordinal_position`); console.log(r.rows.map(x => x.column_name).join(', ')); process.exit(0);
