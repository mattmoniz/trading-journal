import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Fix double-timezone-conversion bug:
// TIMESTAMP WITHOUT TIME ZONE is stored as UTC in this app, but node-postgres
// treats it as local time by default, which shifts times by the UTC offset.
// Appending 'Z' tells JavaScript to interpret the raw stored value as UTC.
pg.types.setTypeParser(1114, (val) => val ? new Date(val + 'Z') : null);

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of Date objects
// so they don't get timezone-shifted when serialized to JSON.
pg.types.setTypeParser(1082, (val) => val);

const { Pool } = pg;

// Create PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'trading_journal',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Bump work_mem per-connection so large sorts (e.g. GROUP BY on trades) stay in memory
pool.on('connect', (client) => {
  client.query('SET work_mem = \'64MB\'').catch(() => {});
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

// Helper function to execute queries
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'production') {
      const cleanText = text.replace(/\s+/g, ' ').trim();
      const display = cleanText.length > 120 ? cleanText.slice(0, 120) + '...' : cleanText;
      console.log('Executed query', { query: display, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
};

// Get a client from the pool for transactions
export const getClient = () => pool.connect();

export default pool;
