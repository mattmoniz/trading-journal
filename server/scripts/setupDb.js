import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  try {
    console.log('🔧 Setting up database schema...');
    
    // Read the schema file
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the schema
    await pool.query(schema);
    
    console.log('✅ Database schema created successfully!');
    console.log('📊 Tables created:');
    console.log('   - daily_logs');
    console.log('   - trades');
    console.log('   - trade_screenshots');
    console.log('   - custom_field_definitions');
    console.log('   - setup_types');
    console.log('📈 Views created:');
    console.log('   - daily_performance');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error setting up database:', error);
    process.exit(1);
  }
}

setupDatabase();
