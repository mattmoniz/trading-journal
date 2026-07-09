import { query } from '../server/db.js';

async function migrate() {
  console.log('Running migration: Creating macro_events table...');
  try {
    // 1. Create table
    await query(`
      CREATE TABLE IF NOT EXISTS macro_events (
        id SERIAL PRIMARY KEY,
        event_date DATE NOT NULL,
        event_type VARCHAR(50) NOT NULL, -- 'FOMC', 'CPI', 'NFP', 'OTHER'
        event_time TIME,
        impact_level VARCHAR(20) DEFAULT 'HIGH', -- 'HIGH', 'MEDIUM'
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_date, event_type)
      )
    `);
    console.log('✓ macro_events table verified/created.');

    // 2. Pre-populate key 2026 macroeconomic calendar dates (Q2-Q4 2026)
    const events = [
      // June 2026
      { date: '2026-06-05', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-06-10', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },
      { date: '2026-06-17', type: 'FOMC', time: '14:00:00', impact: 'HIGH', notes: 'Fed Interest Rate Decision & Statement' },
      
      // July 2026
      { date: '2026-07-03', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-07-10', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },
      { date: '2026-07-29', type: 'FOMC', time: '14:00:00', impact: 'HIGH', notes: 'Fed Interest Rate Decision' },

      // August 2026
      { date: '2026-08-07', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-08-12', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },

      // September 2026
      { date: '2026-09-04', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-09-11', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },
      { date: '2026-09-16', type: 'FOMC', time: '14:00:00', impact: 'HIGH', notes: 'Fed Interest Rate Decision' },

      // October 2026
      { date: '2026-10-02', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-10-13', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },
      { date: '2026-10-28', type: 'FOMC', time: '14:00:00', impact: 'HIGH', notes: 'Fed Interest Rate Decision' },

      // November 2026
      { date: '2026-11-06', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-11-12', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },

      // December 2026
      { date: '2026-12-04', type: 'NFP', time: '08:30:00', impact: 'HIGH', notes: 'Employment Situation' },
      { date: '2026-12-11', type: 'CPI', time: '08:30:00', impact: 'HIGH', notes: 'Consumer Price Index' },
      { date: '2026-12-17', type: 'FOMC', time: '14:00:00', impact: 'HIGH', notes: 'Fed Interest Rate Decision' }
    ];

    for (const e of events) {
      await query(`
        INSERT INTO macro_events (event_date, event_type, event_time, impact_level, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (event_date, event_type) DO NOTHING
      `, [e.date, e.type, e.time, e.impact, e.notes]);
    }
    console.log(`✓ Pre-populated ${events.length} major 2026 macro events.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
