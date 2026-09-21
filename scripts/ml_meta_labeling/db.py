# Shared DB connection helper for the meta-labeling ML thread's Python scripts. Extracted
# from scripts/backfill_garch_vol_scale_history.py's own load_env()/psycopg2.connect()
# pattern (the only prior Python script in this repo) rather than re-copied, per this
# codebase's "export the real function, never reimplement" rule applied to the Python side
# too.
import psycopg2

def load_env():
    env_vars = {}
    with open('/home/mmoniz/trading-journal/.env', 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                key, val = line.split('=', 1)
                env_vars[key] = val
    return env_vars

def get_connection():
    env_vars = load_env()
    conn = psycopg2.connect(
        host=env_vars.get('DB_HOST', 'localhost'), port=env_vars.get('DB_PORT', '5432'),
        dbname=env_vars.get('DB_NAME', 'trading_journal'), user=env_vars.get('DB_USER', 'trader'),
        password=env_vars.get('DB_PASSWORD', 'trader123'))
    return conn
