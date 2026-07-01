import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  try {
    console.log('🔧 Setting up database schema...');
    console.log('   (this bootstraps an EMPTY database — schema.sql is not idempotent)');

    // Read the schema file
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Execute the schema
    await pool.query(schema);

    const { rows } = await pool.query(`
      SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_type, table_name
    `);
    const tables = rows.filter(r => r.table_type === 'BASE TABLE');
    const views = rows.filter(r => r.table_type === 'VIEW');

    console.log(`✅ Database schema created successfully! (${tables.length} tables, ${views.length} views)`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error setting up database:', error);
    process.exit(1);
  }
}

setupDatabase();
