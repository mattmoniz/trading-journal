-- Trading Journal Database Schema

-- Daily Logs Table
CREATE TABLE daily_logs (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL UNIQUE,
    sleep_quality VARCHAR(20),
    mood VARCHAR(50),
    market_condition VARCHAR(50),
    pre_market_notes TEXT,
    post_market_notes TEXT,
    lessons_learned TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trades Table
CREATE TABLE trades (
    id SERIAL PRIMARY KEY,
    log_date DATE NOT NULL REFERENCES daily_logs(log_date) ON DELETE CASCADE,
    entry_time TIMESTAMP NOT NULL,
    exit_time TIMESTAMP,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    quantity INTEGER NOT NULL,
    entry_price DECIMAL(10, 2) NOT NULL,
    exit_price DECIMAL(10, 2),
    stop_loss DECIMAL(10, 2),
    target DECIMAL(10, 2),
    pnl DECIMAL(10, 2),
    fees DECIMAL(10, 2) DEFAULT 0,
    setup_type VARCHAR(100),
    trade_notes TEXT,
    mistakes TEXT,
    emotional_state VARCHAR(50),
    risk_reward_ratio DECIMAL(5, 2),
    tags TEXT[], -- Array of tags for flexible categorization
    custom_fields JSONB, -- Flexible custom fields storage
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trade Screenshots Table
CREATE TABLE trade_screenshots (
    id SERIAL PRIMARY KEY,
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    caption TEXT
);

-- Custom Fields Configuration Table
CREATE TABLE custom_field_definitions (
    id SERIAL PRIMARY KEY,
    field_name VARCHAR(100) NOT NULL UNIQUE,
    field_type VARCHAR(50) NOT NULL CHECK (field_type IN ('text', 'number', 'select', 'date', 'textarea', 'checkbox')),
    field_category VARCHAR(50) NOT NULL CHECK (field_category IN ('trade', 'daily_log')),
    options JSONB, -- For select fields: {"options": ["Option1", "Option2"]}
    is_required BOOLEAN DEFAULT FALSE,
    display_order INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Setup Types (Pre-populated)
CREATE TABLE setup_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance Metrics View
CREATE VIEW daily_performance AS
SELECT 
    t.log_date,
    COUNT(*) as total_trades,
    SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN t.pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
    ROUND(SUM(t.pnl)::numeric, 2) as daily_pnl,
    ROUND(AVG(t.pnl)::numeric, 2) as avg_pnl_per_trade,
    ROUND(MAX(t.pnl)::numeric, 2) as best_trade,
    ROUND(MIN(t.pnl)::numeric, 2) as worst_trade,
    ROUND((SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::decimal / COUNT(*) * 100)::numeric, 2) as win_rate
FROM trades t
WHERE t.exit_time IS NOT NULL
GROUP BY t.log_date
ORDER BY t.log_date DESC;

-- Indexes for performance
CREATE INDEX idx_trades_log_date ON trades(log_date);
CREATE INDEX idx_trades_entry_time ON trades(entry_time);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_setup_type ON trades(setup_type);
CREATE INDEX idx_daily_logs_date ON daily_logs(log_date);

-- Function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_daily_logs_updated_at BEFORE UPDATE ON daily_logs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON trades
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default setup types
INSERT INTO setup_types (name, description) VALUES
    ('Morning Trend Follow', 'Following the trend in the first 90 minutes'),
    ('VWAP Reversal', 'Mean reversion from VWAP bands'),
    ('Support/Resistance Bounce', 'Trading bounces off key levels'),
    ('Breakout', 'Trading breakouts from consolidation'),
    ('Opening Range Breakout', 'ORB strategy'),
    ('Failed Auction', 'Trading failed auction patterns'),
    ('Other', 'Other setup types');

-- Insert sample custom fields
INSERT INTO custom_field_definitions (field_name, field_type, field_category, options, display_order) VALUES
    ('Confidence Level', 'select', 'trade', '{"options": ["Low", "Medium", "High"]}', 1),
    ('Time Session', 'select', 'trade', '{"options": ["Pre-Market", "9:30-11:00", "11:00-14:00", "14:00-16:00", "After-Hours"]}', 2),
    ('Followed Plan', 'checkbox', 'trade', NULL, 3),
    ('Market Phase', 'select', 'daily_log', '{"options": ["Trending", "Choppy", "Ranging", "Volatile"]}', 1);
