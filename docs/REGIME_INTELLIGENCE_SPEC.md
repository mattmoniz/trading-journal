> [!WARNING]
> **REJECTED 2026-07-31 — do not implement without new evidence.** Audited before any schema/code was written: 2 real bugs found and fixed in the supporting scripts (ES-price contamination via a missing `symbol='NQ'` filter, an EDT-only hardcoded timezone offset), and the core "Grand Unified Theory" reverses under corrected data — the EMA-overnight theory combo loses money at every stop width tested while its own anti-theory combo wins. The one piece closest to a live gate (`IB_BEARISH` Mid60/Edge60) fails this codebase's `computeRigor` chronological-stability check and its effect size is ~50x larger than what `computeReplication` shows actually generalizes across the setup roster — a cherry-picked outlier, not a broad real effect. Full account, numbers, and scripts: `docs/OPEN_THREADS.md`'s 2026-07-31 entry and `RESEARCH_CLAIM balance_area_regime_grand_unified_theory_debunked`. Left in place as historical record only.
>
> **Important caveat on the above**: everything debunked was tested against this spec's own "balance area" (plain `MAX(high)/MIN(low)` percentile-of-range) — NOT this codebase's real, established, volume-weighted value area (`computeProfile()`/`computeVolumeProfileForRange()`). Those are different inputs. Parts 1-2 of this spec (tagging only, no gating) were rebuilt the same day using the TRUE volume-weighted value area instead — see `docs/OPEN_THREADS.md`'s same-day follow-up entry and `scripts/compute_value_area_regime_snapshots.mjs` / `value_area_regime_snapshots` table. That measurement layer is live and accumulating real data; Parts 3+ of this document (the gating/routing engine, dashboard) remain rejected and unbuilt.

# Regime Intelligence System — Master Implementation Spec
**Version: 2.0 | Date: 2026-07-31**
**Supersedes:** REGIME_INTELLIGENCE_SPEC v1.0, matrix_engine_spec.md (Gemini draft)

> [!IMPORTANT]
> Constraints from ANTIGRAVITY_CONSTRAINTS.md apply throughout:
> - No static hardcoded performance thresholds (0.25/0.75 Mid/Edge split is geometric, not a perf threshold — OK)
> - All gate promotion decisions derived from rolling real-N data
> - No lookahead bias — balance areas computed from prior calendar days only
> - Real forward data only: origin_status IN ('ACTIVE','SHADOW'), resolution IN ('TARGET_HIT','STOP_HIT')
> - N >= 20 per bucket before any production gate changes

---

## Vision

Every morning the system answers two questions:
1. **What kind of market is today?** (The Matrix Status)
2. **Which setups are authorized for those physics?** (The Dynamic Playbook)

All setups still fire and get tagged. Nothing is invisible. The system learns from everything — authorized trades, shadowed trades, and gated suppressions. The playbook is never frozen; it adapts every night as real N accumulates.

---

## The Grand Unified Theory (Data-Confirmed)

From real forward-resolved data (2025-present):

| Strategy Type | Thrives in | Fails in |
|---|---|---|
| **Mean Reversion** (fades, scalps, IB fades) | Edge of short-term range + Middle of macro range | Middle of short-term range + Edge of macro range |
| **Trend Following** (EMA overnight) | Middle of 30-day range + Edge of 60-day range | Edge of short-term range |

This is the core physics. The dashboard and playbook are built around it.

---

## Part 1: Database Schema

### 1.1 — `balance_area_snapshots`
Pre-computed nightly. Covers all 7 lookback periods.

```sql
CREATE TABLE balance_area_snapshots (
    id            SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    lookback_days INTEGER NOT NULL,        -- 10, 20, 30, 45, 60, 90, 180
    range_high    NUMERIC(10,2) NOT NULL,
    range_low     NUMERIC(10,2) NOT NULL,
    range_size    NUMERIC(10,2) NOT NULL,  -- high - low
    mid_upper     NUMERIC(10,2) NOT NULL,  -- low + range * 0.75
    mid_lower     NUMERIC(10,2) NOT NULL,  -- low + range * 0.25
    created_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE(snapshot_date, lookback_days)
);
CREATE INDEX idx_bas_date ON balance_area_snapshots(snapshot_date);
```

### 1.2 — New Columns on `active_setups`
Stamped at detection time. All 7 periods tracked, even "unused" ones — they become useful as N accumulates.

```sql
-- Position fractions (0.0 to 1.0 within range)
ALTER TABLE active_setups ADD COLUMN regime_pos_10d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_20d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_30d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_45d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_60d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_90d   NUMERIC(6,4);
ALTER TABLE active_setups ADD COLUMN regime_pos_180d  NUMERIC(6,4);

-- Human-readable labels ('Mid' or 'Edge')
ALTER TABLE active_setups ADD COLUMN regime_label_10d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_20d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_30d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_45d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_60d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_90d  VARCHAR(4);
ALTER TABLE active_setups ADD COLUMN regime_label_180d VARCHAR(4);

-- The gate/advisory applied at fire time
ALTER TABLE active_setups ADD COLUMN regime_gate_applied VARCHAR(30) DEFAULT 'unfiltered';
ALTER TABLE active_setups ADD COLUMN regime_gate_reason  TEXT;
```

### 1.3 — `regime_matrix_dictionary`
Database-driven (not hardcoded JS object). Updated by nightly calibration script when N crosses thresholds.

```sql
CREATE TABLE regime_matrix_dictionary (
    id             SERIAL PRIMARY KEY,
    matrix_combo   VARCHAR(30) NOT NULL,   -- e.g. 'Edge30+Mid90'
    physics_label  VARCHAR(80) NOT NULL,   -- e.g. 'Mean Reversion — macro chop, false breakouts'
    physics_desc   TEXT NOT NULL,          -- explanation shown in UI
    setup_type     VARCHAR(100) NOT NULL,
    gate_status    VARCHAR(20) NOT NULL DEFAULT 'AUTHORIZED',
    -- AUTHORIZED: show in Dynamic Playbook, trade normally
    -- ADVISORY:   show dimmed in Playbook with advisory note
    -- SHADOW:     hidden from Playbook, tracked in background
    -- SUPPRESSED: gated off, trade logged to regime_gate_log
    ev_in_combo    NUMERIC(10,2),
    ev_overall     NUMERIC(10,2),
    real_n         INTEGER,
    promoted_at    DATE,
    last_updated   DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE(matrix_combo, setup_type)
);
```

**Initial seed data (from 2026-07-31 analysis, real forward N):**

```sql
-- Edge30+Mid60: Mean reversion regime
INSERT INTO regime_matrix_dictionary
(matrix_combo, physics_label, physics_desc, setup_type, gate_status, ev_in_combo, real_n) VALUES
('Edge30+Mid60', 'Mean Reversion', 'Market at short-term extreme but trapped in macro chop. Expect false breakouts and snaps back.', 'IB_BEARISH', 'AUTHORIZED', 96.00, 10),
('Edge30+Mid60', 'Mean Reversion', 'Market at short-term extreme but trapped in macro chop. Expect false breakouts and snaps back.', 'OR_MID_AFTER_IB_FADE_LONG', 'ADVISORY', 100.00, 8),

-- Edge30+Mid90: Mean reversion (macro-scale)
('Edge30+Mid90', 'Mean Reversion', 'Short-term momentum hitting 90-day macro brick wall. Mean reversion setups dominate.', 'IB_MID_SCALP_FADE_LONG', 'ADVISORY', 103.00, 10),
('Edge30+Mid90', 'Mean Reversion', 'Short-term momentum hitting 90-day macro brick wall. Mean reversion setups dominate.', 'CAM_S3_FADE_SHORT', 'ADVISORY', 67.00, 10),
('Edge30+Mid90', 'Mean Reversion', 'Short-term momentum hitting 90-day macro brick wall. Mean reversion setups dominate.', 'IB_HIGH_FADE_SHORT', 'ADVISORY', 24.00, 13),

-- Mid30+Edge60: Trend-following regime (our confirmed OOS winner for EMA)
('Mid30+Edge60', 'Trend Continuation', 'Market has breathing room short-term and macro momentum behind it. Trend setups dominate.', 'IB_BULLISH', 'ADVISORY', 52.00, 10),
('Mid30+Edge60', 'Trend Continuation', 'Market has breathing room short-term and macro momentum behind it. Trend setups dominate.', 'EMA_OVERNIGHT_CROSS', 'ADVISORY', null, null),

-- Mid20+Mid60: Balanced regime
('Mid20+Mid60', 'Balanced — No Strong Edge', 'Market balanced at both timeframes. Fade setups can work but sizing should be reduced.', 'PD_VAH_FADE_SHORT', 'ADVISORY', 167.00, 7);
```

### 1.4 — `regime_calibration`
Nightly-updated ledger. Powers the auto-promotion logic.

```sql
CREATE TABLE regime_calibration (
    id               SERIAL PRIMARY KEY,
    calibration_date DATE NOT NULL,
    setup_type       VARCHAR(100) NOT NULL,
    matrix_combo     VARCHAR(30) NOT NULL,   -- e.g. 'Edge30+Mid90'
    real_n           INTEGER NOT NULL,
    ev_per_trade     NUMERIC(10,2),
    win_pct          NUMERIC(5,2),
    total_pnl        NUMERIC(12,2),
    gate_status      VARCHAR(20) DEFAULT 'UNPROVEN',
    -- UNPROVEN:    N < 20 — tag, display advisory, no routing change
    -- AUTHORIZED:  N >= 20, ev > 1.5x overall_ev — show in playbook
    -- SUPPRESSED:  N >= 20, ev <= 0 — hide from playbook, track shadows
    -- LEARNING:    Was SUPPRESSED, accumulated N, being reassessed
    gate_reason      TEXT,
    promoted_at      DATE,
    UNIQUE(calibration_date, setup_type, matrix_combo)
);
```

### 1.5 — `regime_gate_log`
Every suppressed setup is logged here. The system never forgets.

```sql
CREATE TABLE regime_gate_log (
    id                      SERIAL PRIMARY KEY,
    fired_at                TIMESTAMP NOT NULL,
    setup_type              VARCHAR(100) NOT NULL,
    trade_date              DATE NOT NULL,
    price_at_detection      NUMERIC(10,2),
    t1_level                NUMERIC(10,2),
    stop_level              NUMERIC(10,2),
    gate_applied            VARCHAR(30) NOT NULL,
    matrix_combo_at_fire    VARCHAR(30),
    regime_pos_30d          NUMERIC(6,4),
    regime_pos_60d          NUMERIC(6,4),
    regime_label_30d        VARCHAR(4),
    regime_label_60d        VARCHAR(4),
    hypothetical_pnl        NUMERIC(10,2),
    hypothetical_resolution VARCHAR(20),    -- TARGET_HIT / STOP_HIT / TIME_EXPIRED
    resolved_at             TIMESTAMP,
    gate_verdict            VARCHAR(20) DEFAULT 'PENDING',
    -- PENDING / CORRECT_SUPPRESS / FALSE_SUPPRESS / BREAKEVEN
    created_at              TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_rgl_setup_date ON regime_gate_log(setup_type, trade_date);
CREATE INDEX idx_rgl_verdict    ON regime_gate_log(gate_verdict, trade_date);
```

---

## Part 2: Nightly Recalibration Pipeline

**File:** `scripts/recalibrate_balance_areas.mjs`
**Schedule:** 8:15 PM ET daily (before main calibration at 8:20 PM)
**Add to:** `scripts/run_daily_calibration.sh`

### Step-by-step:

```
1. BALANCE AREA COMPUTATION
   - Fetch all daily OHLC from price_bars_primary WHERE date < today
   - For each lookback in [10, 20, 30, 45, 60, 90, 180]:
       range_high = MAX(high) of prior N trading days
       range_low  = MIN(low)  of prior N trading days
       range_size = range_high - range_low
       mid_upper  = range_low + range_size * 0.75
       mid_lower  = range_low + range_size * 0.25
   - UPSERT into balance_area_snapshots for tomorrow's date
   - Log: "Balance areas computed for [date]: 30d range=[low]-[high], 60d range=..."

2. REGIME CALIBRATION UPDATE
   - For each setup_type × matrix_combo pair in regime_calibration:
       Query active_setups WHERE:
         origin_status IN ('ACTIVE','SHADOW')
         resolution IN ('TARGET_HIT','STOP_HIT')
         actual_pnl IS NOT NULL
         regime_label_30d = [30d label for this combo]
         regime_label_60d = [60d label for this combo]
       Compute: real_n, ev_per_trade, win_pct, total_pnl
   - UPSERT into regime_calibration for today's date

3. AUTO-PROMOTION LOGIC
   For each combo in regime_calibration:
     - IF real_n >= 20 AND ev_per_trade > (1.5 × setup_overall_ev)
         → UPDATE regime_matrix_dictionary SET gate_status='AUTHORIZED', promoted_at=today
         → Log: "PROMOTED: [setup] in [combo] — N=[n], EV=[ev] vs overall [overall]"
     - IF real_n >= 20 AND ev_per_trade <= 0
         → UPDATE regime_matrix_dictionary SET gate_status='SUPPRESSED'
         → Log: "SUPPRESSED: [setup] in [combo] — N=[n], EV=[ev] (negative)"
     - ELSE gate_status = 'UNPROVEN' — no change to routing

4. GATE LOG RESOLUTION
   For any regime_gate_log rows WHERE gate_verdict='PENDING' AND trade_date < today:
     - Estimate hypothetical outcome using T1/stop levels vs actual close
     - Set hypothetical_resolution and gate_verdict (CORRECT_SUPPRESS / FALSE_SUPPRESS)
   
5. ROLLING SHADOW EV ALERT (replaces slow 20-count false suppress check)
   Gemini critique: waiting for 20 suppressed trades on low-frequency setups
   takes months. Use rolling 90-day EV of shadowed trades instead:

   For each setup with SUPPRESSED entries in last 90 days (N >= 5):
     rolling_shadow_ev = AVG(hypothetical_pnl) over last 90 days
     IF rolling_shadow_ev > 0:
       Log WARNING: "[setup] shadow EV=+$[ev]/trade over 90d (N=[n]) — gate may be overly restrictive"
       UPDATE regime_calibration SET gate_status='LEARNING' for this setup+combo
       → Flag for Claude review next session
   
   This catches false suppression in weeks, not months, even for low-N setups.
```

---

## Part 3: Setup Firing Changes (`server/routes/acd.js`)

> [!IMPORTANT]
> **Gemini critique accepted.** The gate logic must NEVER hardcode setup names or regime conditions in server code. The server is a dumb executor — it reads gate_status from the database and obeys it. All intelligence lives in `regime_matrix_dictionary`, updated nightly by the calibration script. This makes the system fully self-healing without code deploys.

### 3.1 — In-Memory Balance Area Cache (Server Startup)

**Problem fixed:** Querying Postgres on every setup detection would crash the connection pool during high-volatility spikes when multiple setups fire per second.

**Solution:** Load snapshots into memory once at server startup. Refresh at midnight via a scheduled job. All live gate checks use only the in-memory object — zero DB queries during the trading session.

```javascript
// server/services/regimeCache.js
// Loaded once at startup, refreshed nightly at midnight

let _balanceAreaCache = {};  // { lookback: { range_high, range_low, range_size } }
let _matrixDictCache  = [];  // rows from regime_matrix_dictionary where gate_status != 'UNPROVEN'
let _cacheDate = null;

async function loadRegimeCache(pool) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: snaps } = await pool.query(
        `SELECT lookback_days, range_high, range_low, range_size
         FROM balance_area_snapshots WHERE snapshot_date = $1`, [today]
    );
    _balanceAreaCache = Object.fromEntries(snaps.map(s => [s.lookback_days, s]));

    const { rows: dict } = await pool.query(
        `SELECT setup_type, matrix_combo, gate_status, ev_in_combo
         FROM regime_matrix_dictionary WHERE gate_status IN ('AUTHORIZED','SUPPRESSED','ADVISORY')`
    );
    _matrixDictCache = dict;
    _cacheDate = today;
    console.log(`[RegimeCache] Loaded for ${today}: ${snaps.length} balance areas, ${dict.length} dictionary entries`);
}

// Called at server startup and at midnight via setInterval
function scheduleNightlyRefresh(pool) {
    const msUntilMidnight = () => {
        const now = new Date();
        const midnight = new Date(now);
        midnight.setHours(24, 0, 5, 0); // 12:00:05 AM
        return midnight - now;
    };
    setTimeout(async () => {
        await loadRegimeCache(pool);
        setInterval(() => loadRegimeCache(pool), 24 * 60 * 60 * 1000);
    }, msUntilMidnight());
}

function getBalanceAreas() { return _balanceAreaCache; }
function getMatrixDict()   { return _matrixDictCache; }

export { loadRegimeCache, scheduleNightlyRefresh, getBalanceAreas, getMatrixDict };
```

**In `server/index.js` (startup):**
```javascript
import { loadRegimeCache, scheduleNightlyRefresh } from './services/regimeCache.js';
await loadRegimeCache(pool);
scheduleNightlyRefresh(pool);
```

### 3.2 — Universal Regime Stamping (Every Setup, Zero DB Queries)

Add after detection, before DB insert. Uses cached balance areas — no Postgres hit:

```javascript
import { getBalanceAreas, getMatrixDict } from '../services/regimeCache.js';

const ba  = getBalanceAreas(); // from memory, 0.001ms
const pos = (price, snap) => (!snap || snap.range_size == 0)
    ? null : (price - snap.range_low) / snap.range_size;
const lbl = p => p === null ? null : (p >= 0.25 && p <= 0.75 ? 'Mid' : 'Edge');

const p = detectedPrice;
const regime = {
    regime_pos_10d:   pos(p, ba[10]),  regime_label_10d:  lbl(pos(p, ba[10])),
    regime_pos_20d:   pos(p, ba[20]),  regime_label_20d:  lbl(pos(p, ba[20])),
    regime_pos_30d:   pos(p, ba[30]),  regime_label_30d:  lbl(pos(p, ba[30])),
    regime_pos_45d:   pos(p, ba[45]),  regime_label_45d:  lbl(pos(p, ba[45])),
    regime_pos_60d:   pos(p, ba[60]),  regime_label_60d:  lbl(pos(p, ba[60])),
    regime_pos_90d:   pos(p, ba[90]),  regime_label_90d:  lbl(pos(p, ba[90])),
    regime_pos_180d:  pos(p, ba[180]), regime_label_180d: lbl(pos(p, ba[180])),
    regime_gate_applied: 'unfiltered',
    regime_gate_reason:  null,
};
```

### 3.3 — Generic DB-Driven Gate Engine (No Hardcoded Setup Names)

**Problem fixed:** `if (setupType === 'IB_BEARISH')` hardcodes business logic into server code. When the nightly script updates `regime_matrix_dictionary`, the server has no idea. This block replaces ALL setup-specific gate logic with a single generic lookup.

```javascript
// Generic gate engine — reads from the in-memory matrix dictionary cache
// No setup names. No regime conditions. Just: "what does the DB say?"

const dict = getMatrixDict(); // from memory, 0.001ms

// Find all dictionary entries for this setup_type
const entries = dict.filter(d => d.setup_type === setupType);

if (entries.length === 0) {
    // No dictionary entry — unfiltered, tag only
    regime.regime_gate_applied = 'unfiltered';
    regime.regime_gate_reason  = 'No gate configured for this setup type';

} else {
    // Check each dictionary entry: does today's regime match this combo?
    let matched = null;
    for (const entry of entries) {
        // Parse the combo string (e.g. 'Edge30+Mid60') and test against current labels
        if (regimeMatchesCombo(regime, entry.matrix_combo)) {
            matched = entry;
            break;
        }
    }

    if (!matched) {
        // Setup has dictionary entries but none match today's regime
        regime.regime_gate_applied = 'unfiltered';
        regime.regime_gate_reason  = `No matching gate combo for today's regime context`;

    } else if (matched.gate_status === 'SUPPRESSED') {
        // DB says suppress — log to gate log, downgrade to SHADOW
        await logSuppressedSetup(pool, {
            firedAt, setupType, tradeDate, price, t1Level, stopLevel,
            gate: matched.matrix_combo,
            matrixCombo: matched.matrix_combo,
            pos30: regime.regime_pos_30d, pos60: regime.regime_pos_60d,
            lbl30: regime.regime_label_30d, lbl60: regime.regime_label_60d,
        });
        regime.regime_gate_applied = matched.matrix_combo;
        regime.regime_gate_reason  =
            `SUPPRESSED by DB dictionary: ${matched.matrix_combo}, ` +
            `gate_status=SUPPRESSED, EV=${matched.ev_in_combo}`;
        originStatus = 'SHADOW';

    } else if (matched.gate_status === 'AUTHORIZED') {
        // DB says fire — proceed normally with note
        regime.regime_gate_applied = matched.matrix_combo;
        regime.regime_gate_reason  =
            `AUTHORIZED by DB dictionary: ${matched.matrix_combo}, ` +
            `gate_status=AUTHORIZED, EV=${matched.ev_in_combo}`;

    } else if (matched.gate_status === 'ADVISORY') {
        // Favorable regime but N < 20 — fire but note advisory
        regime.regime_gate_applied = matched.matrix_combo;
        regime.regime_gate_reason  =
            `ADVISORY: ${matched.matrix_combo} is favorable (EV=${matched.ev_in_combo}) ` +
            `but N below promotion threshold. Proceed with awareness.`;
    }
}

// Helper: parse combo string and test against current regime labels
function regimeMatchesCombo(regime, comboStr) {
    // comboStr format: 'Edge30+Mid60', 'Mid30+Edge90', etc.
    const parts = comboStr.split('+');
    return parts.every(part => {
        const match = part.match(/^(Mid|Edge)(\d+)$/);
        if (!match) return true; // unrecognized part, skip
        const [, expectedLabel, lookback] = match;
        return regime[`regime_label_${lookback}d`] === expectedLabel;
    });
}
```

### 3.4 — Notes on the Generic Engine
- **No code deploy needed** when gates change. Nightly script updates `regime_matrix_dictionary` → cache refreshes at midnight → new rules apply tomorrow morning automatically.
- **IB_BEARISH Mid60 gate** is seeded into `regime_matrix_dictionary` at Phase 1 with `gate_status='SUPPRESSED'` for the `Edge60` combo. The code above handles it generically.
- **EMA overnight advisory** is seeded with `gate_status='ADVISORY'` for `Mid30+Edge60`. Advisory fires normally, just tagged.
- **All other setups** have no dictionary entry yet → `unfiltered` → fire normally, accumulate N.

---

## Part 4: Morning Prep Dashboard — Matrix Engine

### 4.1 — New API Endpoint
**`GET /api/morning-prep/matrix`**
**File:** `server/routes/matrixEngine.js`

**Gemini critique accepted:** The API must not hardcode `Edge30+Mid60` as the "primary" display. It should dynamically scan all combos in `regime_matrix_dictionary` and elevate the one with the **highest combined EV of AUTHORIZED setups** for today's regime. If `Edge30+Mid90` becomes stronger in 2027, the dashboard switches automatically with zero code change.

```javascript
// server/routes/matrixEngine.js

router.get('/api/morning-prep/matrix', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    // All 7 balance area snapshots (read from DB for API — this is not the hot path)
    const { rows: snaps } = await pool.query(
        `SELECT * FROM balance_area_snapshots WHERE snapshot_date = $1`, [today]
    );
    const ba = Object.fromEntries(snaps.map(s => [s.lookback_days, s]));
    const currentPrice = snaps[0]?.current_price ?? null; // yesterday's close

    const pos = (price, snap) => (!snap || snap.range_size == 0)
        ? null : (price - snap.range_low) / snap.range_size;
    const lbl = p => p === null ? null : (p >= 0.25 && p <= 0.75 ? 'Mid' : 'Edge');

    // Compute today's label for every lookback
    const todayLabels = {};
    for (const L of [10,20,30,45,60,90,180]) {
        todayLabels[L] = lbl(pos(currentPrice, ba[L]));
    }

    // --- DYNAMIC PRIMARY MATRIX SELECTION ---
    // Scan all combos in regime_matrix_dictionary.
    // For each combo, check if today's regime matches.
    // Sum the EV of all AUTHORIZED entries for that combo.
    // Elevate the combo with the highest combined authorized EV.

    const { rows: dictAll } = await pool.query(
        `SELECT matrix_combo, setup_type, gate_status, ev_in_combo, real_n,
                physics_label, physics_desc
         FROM regime_matrix_dictionary
         WHERE gate_status IN ('AUTHORIZED','ADVISORY','SUPPRESSED')`
    );

    const comboScores = {};
    for (const entry of dictAll) {
        if (!regimeMatchesCombo(todayLabels, entry.matrix_combo)) continue;
        if (!comboScores[entry.matrix_combo]) {
            comboScores[entry.matrix_combo] = {
                combo: entry.matrix_combo,
                physics_label: entry.physics_label,
                physics_desc: entry.physics_desc,
                authorized_ev_sum: 0,
                authorized_count: 0,
            };
        }
        if (entry.gate_status === 'AUTHORIZED' && entry.ev_in_combo != null) {
            comboScores[entry.matrix_combo].authorized_ev_sum += entry.ev_in_combo;
            comboScores[entry.matrix_combo].authorized_count++;
        }
    }

    // Pick the primary combo: highest combined authorized EV
    const scored = Object.values(comboScores)
        .sort((a, b) => b.authorized_ev_sum - a.authorized_ev_sum);
    const primary = scored[0] ?? { combo: 'Unclassified', physics_label: 'No active gates', physics_desc: 'Accumulating data.', authorized_ev_sum: 0 };

    // Partition setups into authorized / advisory / suppressed for today
    const todayDict = dictAll.filter(d => regimeMatchesCombo(todayLabels, d.matrix_combo));
    const authorized  = todayDict.filter(d => d.gate_status === 'AUTHORIZED');
    const advisory    = todayDict.filter(d => d.gate_status === 'ADVISORY');
    const suppressed  = todayDict.filter(d => d.gate_status === 'SUPPRESSED');

    // --- LEARNING ALERTS: rolling 90-day shadow EV (not 20-count) ---
    // Gemini critique: 20-count is too slow for low-frequency setups.
    // Use rolling EV of shadowed trades over last 90 days instead.
    const { rows: shadowAlerts } = await pool.query(`
        SELECT setup_type,
               COUNT(*) AS n,
               AVG(hypothetical_pnl) AS shadow_ev_90d
        FROM regime_gate_log
        WHERE resolved_at >= NOW() - INTERVAL '90 days'
          AND gate_verdict IS NOT NULL
          AND gate_verdict != 'PENDING'
        GROUP BY setup_type
        HAVING AVG(hypothetical_pnl) > 0 AND COUNT(*) >= 5
        ORDER BY AVG(hypothetical_pnl) DESC
    `);
    const learningAlerts = shadowAlerts.map(r =>
        `${r.setup_type}: shadow EV=+$${Number(r.shadow_ev_90d).toFixed(0)}/trade ` +
        `over last 90 days (N=${r.n} suppressed trades) — gate may be overly restrictive`
    );

    res.json({
        snapshot_date: today,
        // Dynamic primary — elevated automatically by highest authorized EV
        matrix_status:  primary.combo,
        physics_label:  primary.physics_label,
        physics_desc:   primary.physics_desc,
        primary_ev_sum: primary.authorized_ev_sum,
        // All combos active today (for advanced view)
        active_combos:  scored,
        // All 7 balance area positions
        balance_areas: [10,20,30,45,60,90,180].map(L => ({
            lookback:        L,
            range_high:      ba[L]?.range_high,
            range_low:       ba[L]?.range_low,
            range_size:      ba[L]?.range_size,
            mid_upper:       ba[L]?.mid_upper,
            mid_lower:       ba[L]?.mid_lower,
            current_price:   currentPrice,
            position:        pos(currentPrice, ba[L]),
            label:           todayLabels[L],
            pct_from_upper:  ba[L] ? ((ba[L].mid_upper - currentPrice) / ba[L].range_size * 100).toFixed(1) : null,
            pct_from_lower:  ba[L] ? ((currentPrice - ba[L].mid_lower) / ba[L].range_size * 100).toFixed(1) : null,
        })),
        authorized_setups: authorized,
        advisory_setups:   advisory,
        suppressed_today:  suppressed,
        learning_alerts:   learningAlerts,
    });
});
```

### 4.2 — Matrix Banner Component
**File:** `client/src/components/MatrixStatusBanner.jsx`

The top element of the morning prep dashboard. Prominent, always visible.

```
┌─────────────────────────────────────────────────────────────┐
│  🧭 TODAY'S MARKET PHYSICS                                  │
│                                                             │
│  MATRIX STATUS:  Edge30 + Mid60                            │
│                                                             │
│  Mean Reversion — Market is at the top of its 30-day run   │
│  but still trapped inside 60-day macro balance.            │
│  Expect false breakouts. Fade extensions.                   │
│                                                             │
│  30-Day: EDGE (12%)  ██░░░░░░░░░  Range: 21,200–22,450    │
│  60-Day: MID  (43%)  ████░░░░░░░  Range: 20,800–23,900    │
└─────────────────────────────────────────────────────────────┘
```

Visual details:
- Background color shifts by physics: mean-reversion = blue tones, trend = amber/orange
- Position bar: full-width bar with Mid zone shaded (25–75%), current price as a dot
- Distance from mid zone shown as "3.1% from upper boundary"

### 4.3 — Dynamic Playbook Component
**File:** `client/src/components/DynamicPlaybook.jsx`

Replaces/supplements the static setup list on Morning Prep.

```
┌─────────────────────────────────────────────────────────────┐
│  📋 TODAY'S PLAYBOOK  [Edge30+Mid60 — Mean Reversion]       │
├─────────────────────────────────────────────────────────────┤
│  ✅ AUTHORIZED                                              │
│  ▶ IB_BEARISH       EV $28/trade  N=26  Gate: CLEARED      │
│    "60d Mid context confirmed. Full authorization."         │
│                                                             │
│  🔶 ADVISORY (favorable regime, N still accumulating)       │
│  ▶ OR_MID_AFTER_IB  EV $100/trade N=8  (N<20 threshold)   │
│    "Edge30+Mid60 is its best known regime. Proceed smaller."│
│                                                             │
│  ⬛ ALL OTHER SETUPS (shadow-tagged, not highlighted)        │
│  ▶ [normal setup list, no special regime highlight]         │
│    "Firing and tagged. Data accumulating for future gates." │
├─────────────────────────────────────────────────────────────┤
│  🚫 SUPPRESSED TODAY                                        │
│  ✖ IB_BEARISH (when 60d=Edge)  Gate: Mid60_gate active     │
│    "Would have fired. Logging to shadow tracker."           │
└─────────────────────────────────────────────────────────────┘
```

Key behavior:
- **Authorized** = gate_status AUTHORIZED + today's regime clears the gate → highlighted green
- **Advisory** = gate_status ADVISORY or UNPROVEN + favorable regime → amber, dimmed slightly
- **All others** = displayed normally, tagged silently in background
- **Suppressed** = gate_status SUPPRESSED + today's regime triggers it → shows with ✖, no alert fired

### 4.4 — Full Balance Area Card
**File:** `client/src/components/BalanceAreaCard.jsx`

Shows all 7 lookback periods with position bars. Collapsed by default, expandable.

```
┌─────────────────────────────────────────────────────────────┐
│  📊 ALL BALANCE AREAS  [expand]                             │
│  10d: Mid(52%)  ████░░░░░░  20d: Mid(48%)  ████░░░░░░     │
│  30d: Edge(12%) ██░░░░░░░░  45d: Edge(18%) ██░░░░░░░░     │
│  60d: Mid(43%)  ████░░░░░░  90d: Mid(41%)  ████░░░░░░     │
│  180d: Mid(55%) █████░░░░░                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 5: The Adaptation Loop (Gemini's Shadow Tagger Vision)

### How the System Evolves Without Human Intervention

**Night 1–N:** Every setup fires normally. Each row stamped with all 7 regime positions and the matrix_combo (30+60 primary). No routing changes except IB_BEARISH Mid60 gate.

**Each night:** Nightly calibration script recomputes every setup_type × matrix_combo pair. Rolling windows shift as market structure changes — an Edge today may be Mid in 30 days if the market has moved into a new regime range.

**When N crosses 20 (per combo):** Auto-promotion fires:
- If EV is 1.5× overall → AUTHORIZED (added to playbook for that regime)
- If EV is negative → SUPPRESSED (removed from playbook for that regime, shadow-tracked)

**When false_suppress_rate > 30%:** Auto-reassessment flag raised → gate boundary re-examined against fresh N.

**When market structure changes:** Rolling windows naturally adapt. A 60-day Mid from January becomes a 60-day Edge in March if price discovers new territory. The system recalibrates nightly — no human input needed.

### The Graduation Pipeline
```
UNPROVEN (N<20)
    → Tag and observe
    → Advisory if regime is favorable

AUTHORIZED (N>=20, EV > 1.5× overall)
    → Add to Dynamic Playbook for this regime
    → Full alerts when regime is active

SUPPRESSED (N>=20, EV <= 0)
    → Remove from Playbook for this regime
    → Log to regime_gate_log (shadow tracking)
    → Monitor for false_suppress_rate

LEARNING (false_suppress_rate > 30%)
    → Flag for reassessment
    → May revert to AUTHORIZED if evidence warrants
```

---

## Part 6: Implementation Sequence

**DO NOT implement phases out of order. Each phase requires verification before the next begins.**

| Phase | Deliverable | Pre-condition | Est. time |
|---|---|---|---|
| **1** | `balance_area_snapshots` table + nightly script + 7 regime columns on `active_setups` | None | Week 1 |
| **2** | Universal regime stamping on every setup fire (no gating) | Phase 1 running 5+ days | Week 1–2 |
| **3** | IB_BEARISH Mid60 production gate + `regime_gate_log` table + nightly gate resolution | Phase 2 verified | Week 2 |
| **4** | `regime_calibration` table + auto-promotion logic in nightly script | Phase 3 running 2+ weeks | Week 3–4 |
| **5** | `regime_matrix_dictionary` DB table (replace seed SQL above) | Phase 4 running | Week 4 |
| **6** | `GET /api/morning-prep/matrix` endpoint | Phase 5 complete | Week 4–5 |
| **7** | `MatrixStatusBanner.jsx` + `DynamicPlaybook.jsx` + `BalanceAreaCard.jsx` | Phase 6 endpoint working | Week 5 |
| **8** | EMA overnight advisory tagging (`EMA_OVERNIGHT_CROSS` setup type) | Phase 2 complete | Week 3 (parallel) |
| **9** | EMA hard gate auto-promoted when N crosses 20 per sub-period bucket | Phase 4 running | Auto |

---

## Part 7: Self-Learning Rule Summary (All Constraints-Compliant)

| Rule | Derivation | Not hardcoded |
|---|---|---|
| Mid/Edge boundary: 25%/75% | Geometric split of price range — not a performance threshold | ✅ |
| Gate promotion N floor: 20 | Existing constraint from ANTIGRAVITY_CONSTRAINTS.md | ✅ |
| Gate ON EV threshold | ev_in_combo > 1.5 × rolling_setup_overall_ev | ✅ Rolling |
| False suppress alert | Rolling 90-day shadow EV: if suppressed trades AVG positive over 90d with N≥5, alert fires | ✅ Rolling |
| Gate reassessment trigger | rolling_shadow_ev_90d > 0 with N≥5, OR nightly calibration crosses N=20 | ✅ Rolling |
| Balance area recalibration | Nightly, prior N calendar days only, no lookahead | ✅ |

---

## Appendix: Confirmed Regime Signals (as of 2026-07-31)

From `regime_framework_results.md` and `agy_all_setups_regime_test.mjs`:

### Ready for AUTHORIZED promotion (N approaching 20):
| Setup | Combo | EV in combo | EV overall | N |
|---|---|---|---|---|
| IB_BEARISH | Mid60 | $27.69 | $12.15 | 26 ✅ GATED NOW |
| IB_MID_SCALP_FADE_LONG | Edge30+Mid90 | $103 | $39 | 10 (ADVISORY) |
| PD_VAH_FADE_SHORT | Mid20+Mid60 | $167 WR=100% | $84 | 6 (UNPROVEN) |
| OR_MID_AFTER_IB_FADE_LONG | Edge10+Edge60 | $100 WR=87% | $19 | 8 (UNPROVEN) |

### SUPPRESSION candidates (N approaching 20, EV negative):
| Setup | Combo | EV | N |
|---|---|---|---|
| PD_POC_FADE_LONG | All combos | -$104 to -$143 | 7–9 (needs more N) |
| PD_POC_FADE_SHORT | Mid combo | -$154 | 9 (needs more N) |
| IB_LOW_FADE_SHORT | All combos | -$151 | 9 (needs more N) |

### EMA Overnight:
| Filter | OOS R/DD | N OOS | Status |
|---|---|---|---|
| Mid30+Edge60, 80pt stop | 2.42x | 41 | ADVISORY |
| Mid30+Edge60, 100pt stop | 3.01x | 39 | ADVISORY |
