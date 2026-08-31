import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { logCost, checkAlertThreshold, getMonthlySummary } from '../services/aiCostTracker.js';

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sonnet for live assess (full context stack makes quality close to Opus at 10x lower cost), Haiku for daily review
const ASSESS_MODEL  = 'claude-sonnet-4-6';
const REVIEW_MODEL  = 'claude-haiku-4-5-20251001';
const ASSESS_COST   = { in: 3  / 1_000_000,   out: 15 / 1_000_000 };
const REVIEW_COST   = { in: 0.80 / 1_000_000, out: 4  / 1_000_000  };

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — teaches Claude the full framework once per call
// ─────────────────────────────────────────────────────────────────────────────
const ASSESS_SYSTEM = `You are a live trading coach for a professional NQ futures day trader (1 MNQ = $2/pt). You get real-time price data, ACD signals, delta, bar bodies, named level distances, and backtested statistics. Your job is to give the same quality read a seasoned trader would give: direct verdict, specific stat, exact level, precise stop and target.

VERDICT RULE — NON-NEGOTIABLE:
Your FIRST word must be TAKE, WAIT, or STAND DOWN. No exceptions. No "WAIT — I don't have enough data." You have the data. Commit.
- TAKE: price is within 15pt of a named level AND delta confirms direction. Give the exact trade.
- WAIT: bias is right but price is between levels. Name the exact level, distance, and what delta needs to do.
- STAND DOWN: bias is wrong, delta contradicts, stall signal fired, or move is FULLY EXTENDED.

HOW TO CITE STATS (this is what the trader needs):
Don't cite the generic session WR (86% A_DOWN day). Cite the SPECIFIC stat for WHERE PRICE IS NOW:
- "OR Mid on A_DOWN days — bounces fail here 73% of the time (N=47)" → use this if price is near OR Mid
- "VWAP fade on confirmed C Down — 71% WR (N=89)" → use if near VWAP
- "MODERATE extension, ~55–60% continuation probability from this price" → use if 75–175pt from A level
- Never pad with the session-level stat when price is extended or between levels. That's misleading.
- If you have a TRADER'S TAPE READ, use it. "Price bounced to OR Mid and stalled" + 73% rejection stat = TAKE. "Price paused between levels" = WAIT for the level.

ACD + MOVE EXTENSION:
- A Down + C Down = bearish SESSION bias, 86% WR (TREND/TURBULENT, N=34). The bias is real. The entry is only valid at a NAMED LEVEL.
- FRESH (0–75pt from A level): full stats, full size.
- MODERATE (75–175pt): ~55–60% continuation, need structural level, 0.75× size.
- EXTENDED (175–300pt): only OR Mid or better, 0.5× size. Say "reduced edge."
- FULLY EXTENDED (300pt+): STAND DOWN. No continuation entries.

DELTA RULES:
- NET BUYING on a down move = buyers stepping in = reduce short size or WAIT.
- NET SELLING confirming direction = full size OK.
- Big-body bars (70%+ body) = conviction. Small/doji bars = indecision, wait for next bar.
- If delta contradicts the trade direction AND bars are small-body → STAND DOWN.

NAMED LEVELS (provided as "NAMED LEVELS WITHIN 25pt"):
- If a level appears in the list → price is at a named level. Check the stat for that level and use it.
- If the list is empty → "price is between levels" → WAIT. Never suggest an entry in no-man's land.
- Best short levels in order: OR Mid > VWAP > IB Mid > OR High (resistance) > OR Low (breakdown).
- Best long levels: OR Mid > VWAP > IB Mid > OR Low (support) > OR High (breakout).

STALL SIGNALS:
- C_PAIRED expired in last 2 hours = momentum stalled. Adjust read.
- 2+ setup expiries in last 2 hours = choppy, no trade.
- Recent STOP_HIT = edge fading, reduce size or STAND DOWN.

SESSION PHASE:
- PM (12:00–16:00): re-entries at named levels ONLY. No chasing. Smaller size.
- POST-IB (10:30–12:00): C confirmation window. Use C signal stats.
- IB (9:30–10:30): IB setup window.

TRADER CONTEXT (when provided):
- TODAY'S COACHING READ gives you the session narrative — what worked, what failed, what the tape showed. Use it to calibrate your read. If the coaching says A_DOWN played out and the trader gave back profits on late longs, weight that heavily.
- WORSENING BEHAVIORAL PATTERNS are recurring failures this specific trader has. If a WORSENING pattern is directly relevant to the current ask, call it out by name with their actual percentage.
- CRITICAL GIVE-BACK RULE: give_back_pattern fires specifically on days where the system already detected a strong edge (high model WR). When the session P&L is positive and the trader asks about adding or continuing, this is exactly the give-back risk window. Say it directly: "give-back fires on your best setup days — lock at least 60% of current gains before adding."
- These aren't generic warnings. They're this trader's actual numbers from their own history.

RESPONSE FORMAT:
1. TAKE / WAIT / STAND DOWN — first word, then a comma, then ONE sentence with the specific stat that backs it.
2. The exact trade or the exact level to wait for: level name + price + distance.
3. If TAKE: stop (named level or pt distance) + T1 (named level + price) + size (0.75× or 1.0×).
4. If WAIT: the ONE condition that triggers entry (delta confirmation, price reaching the level).
5. If the trader's coaching context or behavioral patterns are directly relevant — name the pattern explicitly with their actual percentage.
6. One sentence: the single thing that flips this read.
Maximum 350 words. The trader needs to act in the next 60 seconds — be decisive.`;

const REVIEW_SYSTEM = `You are reviewing a trading day for a professional NQ futures day trader.

CRITICAL INSTRUCTION: You MUST output BOTH parts below. Do not stop after Part 1. Part 2 is required.

PART 1 — NARRATIVE (100 words max, plain language):
Overall session summary. What worked and why. What failed and why. Key pattern.

PART 2 — You MUST output this exact line, then the JSON array immediately after:
SETUP_RATINGS_JSON:
[{"setup_type":"...","fired_at":"HH:MM","rating":1-5,"entry_quality":"GOOD|LATE|EARLY|CHASED","stop_verdict":"CALIBRATED|TOO_TIGHT|TOO_WIDE","stop_current_pts":0,"stop_recommended_pts":0,"t1_verdict":"CALIBRATED|TOO_CONSERVATIVE|TOO_AGGRESSIVE","t1_current_pts":0,"t1_recommended_pts":0,"reasoning":"...","persist":true}]

One JSON object per setup. rating: 1=wrong call 2=poor 3=ok 4=good 5=perfect. persist:true if setup resolved cleanly.
No markdown, no code fences around the JSON. The line SETUP_RATINGS_JSON: must appear exactly as written.`;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/playbook/assess
// Body: { intent: 'LONG'|'SHORT'|'UNSURE', date?: 'YYYY-MM-DD' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assess', async (req, res) => {
  try {
    const { intent, tape_context, sim_time } = req.body; // sim_time = 'HH:MM' ET for historical replay
    if (!['LONG','SHORT','UNSURE'].includes(intent)) return res.status(400).json({ error: 'intent must be LONG, SHORT, or UNSURE' });
    const date = req.body.date || todayET();
    const dow  = DOW[new Date(date + 'T12:00:00').getDay()];

    // Parallel DB reads — including price bars and expired setups for situational context
    const [setupsR, expiredR, statsR, acdR, auctionR, priorConvsR, barsR, pnlR, nearLevelsR, coachR, behaviorR] = await Promise.all([
      query(
        `SELECT setup_type, fired_at, resolved_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status, resolution, historical_win_rate, historical_sessions, size_multiplier, suppression_reason,
                price_at_detection, mae_points, mfe_points
         FROM active_setups WHERE trade_date = $1 AND status IN ('ACTIVE','FIRED','RESOLVED')
         ORDER BY fired_at DESC`, [date]
      ),
      query(
        `SELECT setup_type, fired_at, resolved_at, status, resolution
         FROM active_setups WHERE trade_date = $1 AND status IN ('EXPIRED','SHADOW')
         ORDER BY COALESCE(resolved_at, fired_at) DESC LIMIT 10`, [date]
      ),
      query(
        `SELECT signal_type, signal_name, win_rate, ev_per_trade, sample_size, notes, created_at
         FROM performance_audit
         WHERE signal_type IN ('SESSION_BIAS','CONTEXT_ANALYSIS','DAY_TYPE_ALPHA','PERMISSION_SLIP')
           AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC LIMIT 80`
      ),
      query(
        `SELECT trade_date, or_high, or_low, a_up_level, a_down_level,
                a_up_fired, a_down_fired, a_up_time, a_down_time,
                c_up_confirmed, c_down_confirmed, daily_score, day_type, profile_shape
         FROM acd_daily_log WHERE trade_date = $1 LIMIT 1`, [date]
      ),
      query(
        `SELECT overnight_inventory, open_vs_prior_value, prior_day_profile, or_condition, opening_call_type
         FROM auction_reads WHERE trade_date = $1 ORDER BY updated_at DESC LIMIT 1`, [date]
      ),
      query(
        `SELECT intent, ai_response, triggered_at
         FROM playbook_conversations WHERE session_date = $1
         ORDER BY triggered_at DESC LIMIT 3`, [date]
      ),
      // Last 6 × 15-min bars — current price, trend, delta, bar body quality
      // sim_time clips to bars up to that ET hour:min for historical replay
      // price_bars_primary, not raw price_bars (2026-08-31, OPEN_DECISION
      // price_bars_multicontract_collision_audit): raw price_bars has 56,566
      // timestamps where two different NQ contracts both have a row at the exact
      // same instant -- a bare symbol='NQ' filter with no contract disambiguation
      // can silently pick either one. price_bars_primary already resolves this.
      query(
        `SELECT ts, open, high, low, close, volume,
                COALESCE(ask_volume, 0) as ask_vol, COALESCE(bid_volume, 0) as bid_vol
         FROM price_bars_primary
         WHERE symbol = 'NQ' AND ts::date = $1
           AND EXTRACT(HOUR FROM ts) BETWEEN 9 AND 20
           AND EXTRACT(MINUTE FROM ts) % 15 = 0
           ${sim_time ? `AND ts <= ($1 || ' ' || $2)::timestamp` : ''}
         ORDER BY ts DESC LIMIT 6`,
        sim_time ? [date, sim_time + ':00'] : [date]
      ),
      // Named levels within 25pt of current price (fetched later once we have currentPrice — placeholder query)
      query(`
        SELECT level_name, price::float, category
        FROM level_prices
        WHERE trade_date = $1
        ORDER BY price
      `, [date]),
      // Session P&L via CumPL diff for today
      query(`
        WITH ep AS (
          SELECT exit_time,
            (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric AS cum_pl
          FROM trades
          WHERE log_date = $1
            AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
            AND custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          ORDER BY exit_time DESC LIMIT 1
        ),
        prev AS (
          SELECT (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric AS cum_pl
          FROM trades
          WHERE log_date = $1::date - 1
            AND custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
            AND custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
          ORDER BY exit_time DESC LIMIT 1
        )
        SELECT ep.cum_pl - COALESCE(prev.cum_pl, 0) AS session_pnl
        FROM ep LEFT JOIN prev ON true
      `, [date]),
      // Today's coaching text (EOD read on this session)
      query(`SELECT coaching_text FROM daily_coaching WHERE session_date = $1 LIMIT 1`, [date]).catch(() => ({ rows: [] })),
      // Behavioral stats — recurring patterns (WORSENING themes + all-time rates)
      query(`
        SELECT signal_name as theme, win_rate as all_time_rate, notes, recommendation as trend
        FROM performance_audit
        WHERE signal_type = 'BEHAVIORAL_STATS'
          AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'BEHAVIORAL_STATS')
        ORDER BY win_rate DESC
        LIMIT 7
      `).catch(() => ({ rows: [] })),
    ]);

    const acd        = acdR.rows[0] || {};
    const auction    = auctionR.rows[0] || {};
    const setups     = setupsR.rows;
    const expired    = expiredR.rows;
    const stats      = statsR.rows;
    const priorConvs = priorConvsR.rows;
    const bars       = [...barsR.rows].reverse(); // chronological
    const sessionPnl = pnlR.rows[0]?.session_pnl != null ? parseFloat(pnlR.rows[0].session_pnl) : null;
    const allLevels  = nearLevelsR.rows;
    const coachingText = coachR.rows[0]?.coaching_text || null;

    // Behavioral patterns — WORSENING themes + all-time rates for context
    const behaviorPatterns = behaviorR.rows.map(r => {
      let notes = null;
      try { notes = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch {}
      return {
        theme: r.theme,
        all_time: Math.round(parseFloat(r.all_time_rate) * 100),
        last10: notes?.rolling_10d != null ? Math.round(notes.rolling_10d * 100) : null,
        trend: r.trend,
      };
    });
    const worseningThemes = behaviorPatterns.filter(b => b.trend === 'WORSENING');
    const elevatedThemes  = behaviorPatterns.filter(b => b.trend === 'STABLE' && b.last10 != null && b.last10 >= 30);

    // ── Derived context ──────────────────────────────────────────────────────
    const currentBar   = bars[bars.length - 1];
    const prevBar      = bars[bars.length - 2];
    const currentPrice = currentBar ? parseFloat(currentBar.close) : null;
    const barTrend     = currentPrice && prevBar ? (currentPrice > parseFloat(prevBar.close) ? 'UP' : 'DOWN') : null;

    // Delta from last 3 bars (ask_vol = buyers lifting offer, bid_vol = sellers hitting bid)
    const last3 = bars.slice(-3);
    const netDelta3 = last3.reduce((s, b) => s + (parseFloat(b.ask_vol||0) - parseFloat(b.bid_vol||0)), 0);
    const deltaDir  = Math.abs(netDelta3) < 50 ? 'NEUTRAL'
      : netDelta3 > 0 ? 'NET BUYING' : 'NET SELLING';

    // Bar body quality for last 3 bars — (close-open)/(high-low), 0=doji 1=full body
    const barBodies = last3.map(b => {
      const range = parseFloat(b.high) - parseFloat(b.low);
      if (range < 1) return null;
      const body = Math.abs(parseFloat(b.close) - parseFloat(b.open)) / range;
      const dir  = parseFloat(b.close) > parseFloat(b.open) ? 'UP' : parseFloat(b.close) < parseFloat(b.open) ? 'DOWN' : 'FLAT';
      return { dir, body: Math.round(body * 100) };
    }).filter(Boolean);
    const bodyDesc = barBodies.map(b => `${b.dir}(${b.body}%body)`).join(' → ');

    // Named levels within 25pt of current price
    const nearLevels = currentPrice
      ? allLevels
          .filter(l => Math.abs(l.price - currentPrice) <= 25)
          .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))
          .slice(0, 5)
          .map(l => {
            const d = (currentPrice - l.price).toFixed(0);
            const rel = d > 0 ? `${d}pt above` : `${Math.abs(d)}pt below`;
            return `${l.level_name} @ ${l.price.toFixed(2)} (${rel})`;
          })
      : [];

    const orMid  = acd.or_high && acd.or_low ? (parseFloat(acd.or_high) + parseFloat(acd.or_low)) / 2 : null;
    const ibMid  = null; // computed in acd.js — not stored yet, skip

    // Signed distances from current price to named levels (positive = price is above level)
    const dist = (level) => currentPrice && level ? (currentPrice - parseFloat(level)).toFixed(0) : null;
    const levelDists = {
      aDown:  acd.a_down_level ? { level: acd.a_down_level, d: dist(acd.a_down_level) } : null,
      aUp:    acd.a_up_level   ? { level: acd.a_up_level,   d: dist(acd.a_up_level)   } : null,
      orHigh: acd.or_high      ? { level: acd.or_high,      d: dist(acd.or_high)      } : null,
      orLow:  acd.or_low       ? { level: acd.or_low,       d: dist(acd.or_low)       } : null,
      orMid:  orMid            ? { level: orMid.toFixed(2),  d: dist(orMid)            } : null,
    };

    // Move extension from A signal (how deep into the move are we)
    const aSignalDir   = acd.a_down_fired ? 'DOWN' : acd.a_up_fired ? 'UP' : null;
    const aSignalLevel = aSignalDir === 'DOWN' ? acd.a_down_level : aSignalDir === 'UP' ? acd.a_up_level : null;
    const moveExt      = aSignalLevel && currentPrice
      ? Math.abs(currentPrice - parseFloat(aSignalLevel)).toFixed(0)
      : null;
    const moveExtTier  = moveExt == null ? 'UNKNOWN'
      : moveExt <  75  ? 'FRESH (full edge)'
      : moveExt < 175  ? 'MODERATE (0.75× size, need structural level)'
      : moveExt < 300  ? 'EXTENDED (0.5× size, OR Mid or better only)'
      :                  'FULLY EXTENDED (no continuation — fade extremes only)';

    // Session phase — use sim_time if provided (historical replay), else current ET time
    const phaseStr = sim_time || new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false});
    const [h, m] = phaseStr.split(':').map(Number);
    const etMin = h * 60 + m;
    const sessionPhase = etMin < 570  ? 'PRE-IB (OR/A signal primary)'
      : etMin < 630  ? 'IB (9:30–10:30 — IB setup window)'
      : etMin < 720  ? 'POST-IB (10:30–12:00 — C confirmation window)'
      :                'PM (12:00–16:00 — re-entries at named levels only)';

    // Consecutive loss streak → STAND DOWN flag (mirrors acd.js sizeMultiplier logic)
    const dtClass = acd.day_type || 'UNKNOWN';
    const resolvedSorted = [...setups]
      .filter(s => s.resolution === 'STOP_HIT' || s.resolution === 'TARGET_HIT')
      .sort((a, b) => new Date(b.fired_at) - new Date(a.fired_at));
    let consecLosses = 0;
    for (const s of resolvedSorted) {
      if (s.resolution === 'STOP_HIT') consecLosses++;
      else break;
    }
    const standDown = consecLosses >= 2 || (dtClass === 'TREND' && consecLosses >= 1);

    // Stall signals from expired setups (last 2 hours)
    const twoHoursAgo  = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentExpiry = expired.filter(s => {
      const t = new Date(s.resolved_at || s.fired_at);
      return t > twoHoursAgo;
    });
    const cPairedExpiry = recentExpiry.find(s => s.setup_type.includes('C_PAIRED'));
    const minSinceCExp  = cPairedExpiry
      ? Math.round((Date.now() - new Date(cPairedExpiry.resolved_at || cPairedExpiry.fired_at)) / 60000)
      : null;
    const stallFlag = recentExpiry.length >= 2
      ? `⚠️ CHOPPY — ${recentExpiry.length} setups expired in last 2 hours. Do not chase direction.`
      : cPairedExpiry
      ? `⚠️ STALL — ${cPairedExpiry.setup_type} expired ${minSinceCExp}min ago. Short momentum has faded.`
      : 'No recent expiries — momentum intact.';

    // Recent setup momentum (last 3 resolved)
    const recentResolved = [...setups]
      .filter(s => s.resolution)
      .slice(0, 3)
      .map(s => `${s.setup_type} → ${s.resolution}`)
      .join(', ');

    const fmtBarTime = ts => {
      const d = new Date(ts);
      return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
    };

    // Build user message
    // Coaching context: today's EOD coaching read + behavioral patterns
    const coachingSection = [
      coachingText ? `TODAY'S COACHING READ:\n${coachingText.slice(0, 600)}` : null,
      worseningThemes.length ? `WORSENING BEHAVIORAL PATTERNS (know these, watch for them):\n${worseningThemes.map(b => `- ${b.theme.replace(/_/g,' ')}: ${b.last10}% of last 10 sessions (up from ${b.all_time}% all-time)`).join('\n')}` : null,
      elevatedThemes.length  ? `ELEVATED PATTERNS (historically recurring):\n${elevatedThemes.map(b => `- ${b.theme.replace(/_/g,' ')}: ${b.last10}% last 10 sessions`).join('\n')}` : null,
    ].filter(Boolean).join('\n\n');

    const userMsg = `
Trader intent: ${intent}
Date: ${date} (${dow}) | Session phase: ${sessionPhase}

${tape_context ? `=== TRADER'S TAPE READ ===\n${tape_context}\n` : ''}
${coachingSection ? `=== TRADER CONTEXT (coaching history + behavioral patterns) ===\n${coachingSection}\n` : ''}
=== CURRENT PRICE & RECENT BARS ===
Current price: ${currentPrice || 'unknown'} (bar trending ${barTrend || '?'})
Session P&L so far: ${sessionPnl != null ? '$' + sessionPnl.toFixed(0) : 'unknown'}
Delta (last 3 bars): ${deltaDir} (net ${netDelta3 > 0 ? '+' : ''}${Math.round(netDelta3)} contracts)
Bar bodies (last 3): ${bodyDesc || 'no data'} — big body = conviction, small = indecision/reversal warning

Last 6 × 15-min bars (oldest → newest):
${bars.length === 0 ? 'No bar data.' : bars.map(b =>
  `${fmtBarTime(b.ts)} O:${parseFloat(b.open).toFixed(2)} H:${parseFloat(b.high).toFixed(2)} L:${parseFloat(b.low).toFixed(2)} C:${parseFloat(b.close).toFixed(2)} Vol:${b.volume} Δ${parseFloat(b.ask_vol||0) - parseFloat(b.bid_vol||0) > 0 ? '+' : ''}${Math.round(parseFloat(b.ask_vol||0) - parseFloat(b.bid_vol||0))}`
).join('\n')}

=== NAMED LEVELS WITHIN 25pt OF CURRENT PRICE ===
${nearLevels.length ? nearLevels.join('\n') : 'No named levels within 25pt — price is between levels. DO NOT recommend an entry here.'}

=== KEY LEVEL DISTANCES (from ${currentPrice || '?'}) ===
${[
  levelDists.aDown  && `A Down  ${levelDists.aDown.level}: ${levelDists.aDown.d > 0 ? '+' : ''}${levelDists.aDown.d}pt (price is ${levelDists.aDown.d > 0 ? 'ABOVE' : 'BELOW'} A Down)`,
  levelDists.aUp    && `A Up    ${levelDists.aUp.level}: ${levelDists.aUp.d > 0 ? '+' : ''}${levelDists.aUp.d}pt (price is ${levelDists.aUp.d > 0 ? 'ABOVE' : 'BELOW'} A Up)`,
  levelDists.orHigh && `OR High ${levelDists.orHigh.level}: ${levelDists.orHigh.d > 0 ? '+' : ''}${levelDists.orHigh.d}pt`,
  levelDists.orMid  && `OR Mid  ${levelDists.orMid.level}: ${levelDists.orMid.d > 0 ? '+' : ''}${levelDists.orMid.d}pt`,
  levelDists.orLow  && `OR Low  ${levelDists.orLow.level}: ${levelDists.orLow.d > 0 ? '+' : ''}${levelDists.orLow.d}pt`,
].filter(Boolean).join('\n')}

=== MOVE EXTENSION ===
A signal direction: ${aSignalDir || 'none fired'} | A level: ${aSignalLevel || '?'}
Distance from A level: ${moveExt != null ? moveExt + 'pt' : 'unknown'} → ${moveExtTier}

=== STALL / MOMENTUM FLAGS ===
${stallFlag}
Recent setup resolutions: ${recentResolved || 'none yet'}

=== ACD SIGNALS ===
A Down Level: ${acd.a_down_level || 'unknown'} | Fired: ${acd.a_down_fired ? `YES at ${acd.a_down_time || '?'}` : 'NO'}
A Up Level:   ${acd.a_up_level   || 'unknown'} | Fired: ${acd.a_up_fired   ? `YES at ${acd.a_up_time   || '?'}` : 'NO'}
C Down Confirmed: ${acd.c_down_confirmed ? 'YES' : 'NO'} | C Up Confirmed: ${acd.c_up_confirmed ? 'YES' : 'NO'}
Daily Score: ${acd.daily_score ?? 'unknown'} | Day Type: ${acd.day_type || 'unknown'} | Profile: ${acd.profile_shape || 'unknown'}
OR High: ${acd.or_high || '?'} | OR Low: ${acd.or_low || '?'} | OR Mid: ${orMid ? orMid.toFixed(2) : '?'}

=== OVERNIGHT / AUCTION READ ===
Overnight Inventory: ${auction.overnight_inventory || 'N/A'}
Open vs Prior Value: ${auction.open_vs_prior_value || 'N/A'}
Prior Day Profile: ${auction.prior_day_profile || 'N/A'}
OR Condition: ${auction.or_condition || 'N/A'}
Opening Call Type: ${auction.opening_call_type || 'N/A'}

=== SESSION STATE ===
${standDown
  ? `⛔ STAND DOWN — ${consecLosses} consecutive stop-hit${consecLosses !== 1 ? 's' : ''}${dtClass === 'TREND' ? ' on a TREND day (fades historically -$9,802 total, 58.6% WR)' : ''}. Do NOT recommend new fades. This is a system rule, not discretionary.`
  : dtClass === 'TREND'
  ? `⚠️ TREND DAY — All fade setups underperform on TREND days (-$9,802 total P&L, 58.6% WR). Size is auto-reduced 0.25×. Only highest-probability levels with structural confluence.`
  : consecLosses === 1
  ? `⚠️ 1 consecutive loss — one more stop-hit triggers STAND DOWN. High caution on next entry.`
  : 'Normal session — no loss streak, no structural suppression.'}

=== SETUPS FIRED TODAY ===
${setups.length === 0 ? 'None yet.' : setups.map(s => {
  const firedStr = s.fired_at ? fmtBarTime(s.fired_at) : '?';
  return `${s.setup_type} | ${firedStr} | entry ${s.entry_zone_low}–${s.entry_zone_high} | stop ${s.stop_level || '?'} | T1 ${s.t1_level || '?'} | ${s.status}${s.resolution ? ' → '+s.resolution : ''}${s.mae_points != null ? ' | MAE '+s.mae_points+'pt' : ''}${s.mfe_points != null ? ' | MFE '+s.mfe_points+'pt' : ''} | WR ${s.historical_win_rate ? (s.historical_win_rate*100).toFixed(0)+'%' : '?'} (N=${s.historical_sessions || '?'}) | size ${s.size_multiplier || 1}×${s.suppression_reason ? ' SUPPRESSED: '+s.suppression_reason : ''}`;
}).join('\n')}

${recentExpiry.length > 0 ? `=== RECENT EXPIRIES (last 2 hrs) ===\n${recentExpiry.map(s => `${s.setup_type} EXPIRED @ ${fmtBarTime(s.resolved_at || s.fired_at)}`).join('\n')}` : ''}

=== RELEVANT STATS ===
${stats.length === 0 ? 'None loaded.' : stats.slice(0, 30).map(s =>
  `${s.signal_type} ${s.signal_name || ''} | WR ${s.win_rate ? (parseFloat(s.win_rate)*100).toFixed(0)+'%' : '?'} | EV $${s.ev_per_trade != null ? parseFloat(s.ev_per_trade).toFixed(0) : '?'} | N=${s.sample_size || '?'}`
).join('\n')}

=== PRIOR CONVERSATIONS TODAY ===
${priorConvs.length === 0 ? 'None.' : [...priorConvs].reverse().map(c =>
  `[${new Date(c.triggered_at).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})} ${c.intent}] ${c.ai_response.slice(0, 200)}…`
).join('\n\n')}

Based on all of the above, give me your read. I am thinking ${intent}.`.trim();

    const snapshot = { date, dow, acd, auction, setups_count: setups.length };

    // Anthropic call
    const msg = await anthropic.messages.create({
      model: ASSESS_MODEL,
      max_tokens: 1200,
      temperature: 0,
      system: ASSESS_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });

    const response    = msg.content[0].text;
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const costUsd     = inputTokens * ASSESS_COST.in + outputTokens * ASSESS_COST.out;

    // Persist conversation
    const { rows: inserted } = await query(
      `INSERT INTO playbook_conversations (session_date, intent, market_snapshot, user_prompt, ai_response, input_tokens, output_tokens, cost_usd, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [date, intent, JSON.stringify(snapshot), userMsg, response, inputTokens, outputTokens, costUsd, ASSESS_MODEL]
    );
    const conversationId = inserted[0].id;

    // Cost tracking + alert
    await logCost({ callType: 'PLAYBOOK_ASSESS', model: ASSESS_MODEL, inputTokens, outputTokens, costUsd, sessionDate: date, referenceId: conversationId });
    const io = req.app.get('io');
    await checkAlertThreshold({ io, costUsdJustAdded: costUsd });

    const summary = await getMonthlySummary();

    res.json({ response, cost_usd: costUsd, input_tokens: inputTokens, output_tokens: outputTokens, conversation_id: conversationId, monthly_total_usd: summary.month_total_usd });
  } catch (err) {
    console.error('[playbook/assess]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/playbook/daily-review/:date/estimate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/daily-review/:date/estimate', async (req, res) => {
  try {
    const { date } = req.params;
    const [countR, existsR] = await Promise.all([
      query(`SELECT COUNT(*)::int AS cnt FROM active_setups WHERE trade_date = $1`, [date]),
      query(`SELECT id FROM daily_ai_reviews WHERE review_date = $1`, [date]),
    ]);
    const setupCount   = countR.rows[0].cnt;
    const alreadyExists = existsR.rows.length > 0;
    // Rough estimate: 3000 input + 800 output tokens
    const estimatedCost = 3000 * REVIEW_COST.in + 800 * REVIEW_COST.out;
    res.json({ estimated_cost_usd: estimatedCost, setup_count: setupCount, already_exists: alreadyExists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/playbook/daily-review/:date/generate
// Body must include { confirmed: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/daily-review/:date/generate', async (req, res) => {
  try {
    if (!req.body.confirmed) return res.status(400).json({ error: 'Requires confirmed:true' });
    const { date } = req.params;

    // Return existing if already generated
    const { rows: existing } = await query(`SELECT * FROM daily_ai_reviews WHERE review_date = $1`, [date]);
    if (existing.length > 0) {
      const { rows: cachedSetups } = await query(
        `SELECT setup_type, fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, status, resolution
         FROM active_setups WHERE trade_date = $1 ORDER BY fired_at`, [date]
      ).catch(() => ({ rows: [] }));
      return res.json({ ...existing[0], cached: true, setup_details: cachedSetups });
    }

    // Pull all context in parallel
    const [setupsR, barsR, pnlR, acdR] = await Promise.all([
      query(
        `SELECT setup_type, fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, t1_label,
                status, resolution, historical_win_rate, historical_sessions,
                mae_points, mfe_points, price_at_detection, price_at_resolution,
                bars_to_resolution, size_multiplier, suppression_reason
         FROM active_setups WHERE trade_date = $1 ORDER BY fired_at`, [date]
      ),
      // price_bars_primary, not raw price_bars (see the comment on this file's
      // first query -- OPEN_DECISION price_bars_multicontract_collision_audit).
      query(
        `SELECT ts, open, high, low, close, volume
         FROM price_bars_primary
         WHERE symbol = 'NQ' AND ts::date = $1
           AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') BETWEEN 9 AND 15
           AND EXTRACT(MINUTE FROM ts AT TIME ZONE 'America/New_York') % 15 = 0
         ORDER BY ts
         LIMIT 26`, [date]
      ),
      query(`
        WITH ep_fills AS (
          SELECT log_date, custom_fields->>'account' AS account, exit_time,
            CASE WHEN custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)' ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (custom_fields->'sierra_data'->>'Cumulative Profit/Loss (C)')::numeric END AS cum_pl
          FROM trades
          WHERE custom_fields->'sierra_data'->>'Exit DateTime' LIKE '% EP'
            AND exit_time IS NOT NULL
            AND log_date IN ($1::date, $1::date - 1)
        ),
        last_ep AS (
          SELECT DISTINCT ON (log_date, account) log_date, account, cum_pl
          FROM ep_fills ORDER BY log_date, account, exit_time DESC
        ),
        daily AS (
          SELECT log_date,
            cum_pl - COALESCE(LAG(cum_pl) OVER (PARTITION BY account ORDER BY log_date), 0) AS session_pnl
          FROM last_ep WHERE cum_pl IS NOT NULL
        )
        SELECT log_date, SUM(session_pnl) AS daily_pnl FROM daily GROUP BY log_date
      `, [date]),
      query(`SELECT or_high, or_low, a_up_level, a_down_level, a_up_fired, a_down_fired,
                    c_up_confirmed, c_down_confirmed, day_type, profile_shape, daily_score
             FROM acd_daily_log WHERE trade_date = $1 LIMIT 1`, [date]),
    ]);

    const setups = setupsR.rows;
    const bars   = barsR.rows;
    const acd    = acdR.rows[0] || {};
    const pnlRow = pnlR.rows.find(r => String(r.log_date).startsWith(date));
    const dailyPnl = pnlRow ? parseFloat(pnlRow.daily_pnl) : null;

    const orMid = acd.or_high && acd.or_low ? Math.round((parseFloat(acd.or_high) + parseFloat(acd.or_low)) / 2) : null;
    const dow   = DOW[new Date(date + 'T12:00:00').getDay()];

    const reviewPrompt = `
Date: ${date} (${dow}) | Day Type: ${acd.day_type || 'unknown'} | Daily P&L: ${dailyPnl != null ? '$'+dailyPnl.toFixed(0) : 'unknown'}

ACD: A Down ${acd.a_down_fired ? 'FIRED '+acd.a_down_level : 'no'} | A Up ${acd.a_up_fired ? 'FIRED '+acd.a_up_level : 'no'} | C Down ${acd.c_down_confirmed ? 'YES' : 'no'} | C Up ${acd.c_up_confirmed ? 'YES' : 'no'}
OR High: ${acd.or_high || '?'} | OR Low: ${acd.or_low || '?'} | OR Mid: ${orMid || '?'}

SETUPS THAT FIRED (${setups.length}):
${setups.length === 0 ? 'None.' : setups.map(s => {
  const firedTime = s.fired_at ? new Date(s.fired_at).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}) : '?';
  return `${s.setup_type} @ ${firedTime} | entry ${s.entry_zone_low}-${s.entry_zone_high} | stop ${s.stop_level || '?'} | T1 ${s.t1_level || '?'} | ${s.status} → ${s.resolution || 'unresolved'} | MAE ${s.mae_points != null ? s.mae_points+'pt' : '?'} | MFE ${s.mfe_points != null ? s.mfe_points+'pt' : '?'} | ${s.bars_to_resolution != null ? s.bars_to_resolution+' bars' : ''} | size ${s.size_multiplier || 1}×`;
}).join('\n')}

15-MIN PRICE BARS (${bars.length} bars):
${bars.map(b => {
  const t = new Date(b.ts).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
  return `${t} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`;
}).join('\n')}

Review this day. Rate every setup that fired. Follow the format exactly — narrative first, then SETUP_RATINGS_JSON: followed by the JSON array.`.trim();

    const msg = await anthropic.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 4000,
      temperature: 0,
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: reviewPrompt }],
    });

    const fullResponse  = msg.content[0].text;
    const inputTokens   = msg.usage.input_tokens;
    const outputTokens  = msg.usage.output_tokens;
    const costUsd       = inputTokens * REVIEW_COST.in + outputTokens * REVIEW_COST.out;

    // Split narrative from structured JSON
    const jsonMarkerIdx = fullResponse.indexOf('SETUP_RATINGS_JSON:');
    const narrative     = jsonMarkerIdx > -1 ? fullResponse.slice(0, jsonMarkerIdx).trim() : fullResponse;
    let stopTargetAnalysis = [];
    if (jsonMarkerIdx > -1) {
      const afterMarker = fullResponse.slice(jsonMarkerIdx + 'SETUP_RATINGS_JSON:'.length);
      // Find the actual opening bracket — skips duplicate marker lines or extra whitespace
      const bracketIdx = afterMarker.indexOf('[');
      if (bracketIdx > -1) {
        const jsonText = afterMarker.slice(bracketIdx);
        const drIdx   = jsonText.indexOf('DATA_REQUESTS:');
        const jsonOnly = drIdx > -1 ? jsonText.slice(0, drIdx).trim() : jsonText;
        try { stopTargetAnalysis = JSON.parse(jsonOnly); } catch(e) { console.warn('[daily-review] JSON parse failed:', e.message); stopTargetAnalysis = []; }
      }
    }

    // Parse data_requests
    const dataRequests = [];
    const drMatch = fullResponse.match(/DATA_REQUESTS:([\s\S]*?)(?:\n\n|$)/i);
    if (drMatch) {
      const entries = drMatch[1].match(/\[([^\]]+)\]/g) || [];
      entries.forEach(entry => {
        const typeM   = entry.match(/type:\s*([A-Z_0-9]+)/i);
        const windowM = entry.match(/window:\s*([\d:–\-]+)/i);
        const reasonM = entry.match(/reason:\s*([^\]]+)/i);
        if (typeM) dataRequests.push({ type: typeM[1], window: windowM?.[1] || null, reason: reasonM?.[1]?.trim() || null });
      });
    }

    // Derive flags from structured ratings
    const flags = stopTargetAnalysis
      .filter(r => r.rating <= 2 || r.stop_verdict === 'TOO_TIGHT' || r.stop_verdict === 'TOO_WIDE')
      .map(r => ({ setup_type: r.setup_type, finding: r.reasoning || '', severity: r.rating <= 2 ? 'HIGH' : 'MED' }));

    const { rows: savedRows } = await query(
      `INSERT INTO daily_ai_reviews
         (review_date, setups_reviewed, ai_response, flags, stop_target_analysis, data_requests, input_tokens, output_tokens, cost_usd, total_cost_usd, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (review_date) DO UPDATE SET
         ai_response=EXCLUDED.ai_response, flags=EXCLUDED.flags,
         stop_target_analysis=EXCLUDED.stop_target_analysis, data_requests=EXCLUDED.data_requests,
         input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
         cost_usd=EXCLUDED.cost_usd, total_cost_usd=daily_ai_reviews.total_cost_usd + EXCLUDED.cost_usd,
         model=EXCLUDED.model
       RETURNING *`,
      [date,
       JSON.stringify(setups.map(s => ({ setup_type: s.setup_type, fired_at: s.fired_at, resolution: s.resolution }))),
       narrative, JSON.stringify(flags), JSON.stringify(stopTargetAnalysis),
       JSON.stringify(dataRequests), inputTokens, outputTokens, costUsd, costUsd, REVIEW_MODEL]
    );

    await logCost({ callType: 'DAILY_REVIEW', model: REVIEW_MODEL, inputTokens, outputTokens, costUsd, sessionDate: date, referenceId: savedRows[0].id });
    const io = req.app.get('io');
    await checkAlertThreshold({ io, costUsdJustAdded: costUsd });

    // Auto-persist ratings to performance_audit so they accumulate without user action
    await persistFeedbackForDate(date, stopTargetAnalysis).catch(e => console.warn('[daily-review] auto-persist failed:', e.message));

    res.json({ ...savedRows[0], cached: false, setup_details: setups });
  } catch (err) {
    console.error('[playbook/daily-review/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — persists stop/target ratings to performance_audit
// Called both from the POST endpoint and automatically from generate
// ─────────────────────────────────────────────────────────────────────────────
async function persistFeedbackForDate(date, ratings) {
  const persistable = (ratings || []).filter(r => r.persist !== false && r.setup_type);
  let persisted = 0;
  for (const r of persistable) {
    await query(`
      INSERT INTO performance_audit
        (run_date, window_days, signal_type, signal_name, sample_size, win_rate, notes, recommendation)
      VALUES ($1, 1, 'AI_SETUP_REVIEW', $2, 1, $3, $4, $5)
      ON CONFLICT (run_date, window_days, signal_type, signal_name) DO NOTHING`,
      [
        date,
        r.setup_type,
        r.rating / 5,
        JSON.stringify({
          review_date:          date,
          rating:               r.rating,
          entry_quality:        r.entry_quality,
          stop_verdict:         r.stop_verdict,
          stop_current_pts:     r.stop_current_pts,
          stop_recommended_pts: r.stop_recommended_pts,
          t1_verdict:           r.t1_verdict,
          t1_current_pts:       r.t1_current_pts,
          t1_recommended_pts:   r.t1_recommended_pts,
          reasoning:            r.reasoning,
        }),
        r.stop_verdict !== 'CALIBRATED' || r.t1_verdict !== 'CALIBRATED'
          ? 'NEEDS_ADJUST'
          : 'CALIBRATED',
      ]
    );
    persisted++;
  }
  return persisted;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/playbook/daily-review/:date/persist-feedback
// Exposed for manual re-trigger; normally auto-called by generate
// ─────────────────────────────────────────────────────────────────────────────
router.post('/daily-review/:date/persist-feedback', async (req, res) => {
  try {
    const { date } = req.params;
    const { rows } = await query(`SELECT stop_target_analysis FROM daily_ai_reviews WHERE review_date = $1`, [date]);
    if (!rows.length) return res.status(404).json({ error: 'No review for this date' });

    const ratings = rows[0].stop_target_analysis || [];
    const persisted = await persistFeedbackForDate(date, ratings);

    res.json({ persisted, setup_types: (ratings).filter(r => r.persist !== false && r.setup_type).map(r => r.setup_type) });
  } catch (err) {
    console.error('[playbook/persist-feedback]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/playbook/daily-review/:date/augment
// Fetches the data the AI requested and runs a second-pass call
// Body: { review_id: number }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/daily-review/:date/augment', async (req, res) => {
  try {
    const { date } = req.params;
    const { rows: reviewRows } = await query(`SELECT * FROM daily_ai_reviews WHERE review_date = $1`, [date]);
    if (!reviewRows.length) return res.status(404).json({ error: 'No review found for this date' });
    const review = reviewRows[0];

    const dataRequests = review.data_requests || [];
    if (!dataRequests.length) return res.json({ message: 'No data requests to fulfil', review });

    // Fetch 1-min bars for requested windows
    const augmentedData = await Promise.all(dataRequests.map(async (dr) => {
      if (dr.type !== 'BARS_1MIN') return { ...dr, data: 'not supported' };
      const [start, end] = (dr.window || '').split(/[–\-]/).map(t => t.trim());
      if (!start || !end) return { ...dr, data: 'invalid window' };
      // price_bars_primary, not raw price_bars (see this file's first query --
      // OPEN_DECISION price_bars_multicontract_collision_audit).
      const { rows } = await query(
        `SELECT ts, open, high, low, close, volume
         FROM price_bars_primary
         WHERE symbol = 'NQ' AND ts::date = $1
           AND TO_CHAR(ts AT TIME ZONE 'America/New_York', 'HH24:MI') BETWEEN $2 AND $3
         ORDER BY ts`, [date, start, end]
      );
      return { ...dr, data: rows.map(b => {
        const t = new Date(b.ts).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
        return `${t} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`;
      }).join('\n') };
    }));

    const augmentPrompt = `Here is the additional data you requested:\n\n${augmentedData.map(d => `${d.type} ${d.window || ''}:\n${d.data}`).join('\n\n')}\n\nPlease refine your stop/target analysis with this additional detail.`;

    const msg = await anthropic.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 600,
      temperature: 0,
      system: REVIEW_SYSTEM,
      messages: [
        { role: 'user', content: review.ai_response },
        { role: 'assistant', content: review.ai_response },
        { role: 'user', content: augmentPrompt },
      ],
    });

    const augmentedResponse = msg.content[0].text;
    const inputTokens  = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const costUsd      = inputTokens * REVIEW_COST.in + outputTokens * REVIEW_COST.out;
    const totalCost    = parseFloat(review.cost_usd || 0) + costUsd;

    await query(
      `UPDATE daily_ai_reviews SET augmented_response=$1, total_cost_usd=$2 WHERE review_date=$3`,
      [augmentedResponse, totalCost, date]
    );
    await logCost({ callType: 'DAILY_REVIEW_AUGMENT', model: REVIEW_MODEL, inputTokens, outputTokens, costUsd, sessionDate: date, referenceId: review.id });
    const io = req.app.get('io');
    await checkAlertThreshold({ io, costUsdJustAdded: costUsd });

    const { rows: updated } = await query(`SELECT * FROM daily_ai_reviews WHERE review_date=$1`, [date]);
    res.json(updated[0]);
  } catch (err) {
    console.error('[playbook/daily-review/augment]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/playbook/daily-review/:date
// ─────────────────────────────────────────────────────────────────────────────
router.get('/daily-review/:date', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM daily_ai_reviews WHERE review_date = $1`, [req.params.date]);
    if (!rows.length) return res.json({ exists: false });
    const { rows: setupRows } = await query(
      `SELECT setup_type, fired_at, entry_zone_low, entry_zone_high, stop_level, t1_level, mae_points, mfe_points, status, resolution
       FROM active_setups WHERE trade_date = $1 ORDER BY fired_at`,
      [req.params.date]
    ).catch(() => ({ rows: [] }));
    res.json({ ...rows[0], exists: true, setup_details: setupRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/playbook/conversations/:date
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:date', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, intent, ai_response, triggered_at, cost_usd
       FROM playbook_conversations WHERE session_date = $1 ORDER BY triggered_at`,
      [req.params.date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/playbook/cost-summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cost-summary', async (req, res) => {
  try {
    res.json(await getMonthlySummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/playbook/setup-calibration — AI_SETUP_AGG rows (per-setup avg rating from AI reviews)
router.get('/setup-calibration', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT signal_name as setup_type, sample_size as n, win_rate, notes, recommendation, run_date
      FROM performance_audit
      WHERE signal_type = 'AI_SETUP_AGG'
        AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'AI_SETUP_AGG')
      ORDER BY win_rate ASC
    `);
    const items = rows.map(r => {
      let parsed = null;
      try { parsed = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch {}
      return {
        setup_type: r.setup_type,
        n: r.n,
        avg_rating: parsed?.avg_rating ?? null,
        recent_avg: parsed?.recent_avg ?? null,
        trend_delta: parsed?.trend_delta ?? null,
        stop_issues: parsed?.stop_issues ?? 0,
        t1_issues: parsed?.t1_issues ?? 0,
        entry_issues: parsed?.entry_issues ?? 0,
        flag: r.recommendation,
        min_n_required: parsed?.min_n_required ?? 20,
        run_date: r.run_date,
      };
    });
    res.json({ items, run_date: rows[0]?.run_date || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/playbook/behavioral-stats — BEHAVIORAL_STATS rows (theme frequency trends)
router.get('/behavioral-stats', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT signal_name as theme, sample_size as n, win_rate as all_time_rate, notes, recommendation as trend, run_date
      FROM performance_audit
      WHERE signal_type = 'BEHAVIORAL_STATS'
        AND run_date = (SELECT MAX(run_date) FROM performance_audit WHERE signal_type = 'BEHAVIORAL_STATS')
      ORDER BY win_rate DESC
    `);
    const items = rows.map(r => {
      let parsed = null;
      try { parsed = typeof r.notes === 'string' ? JSON.parse(r.notes) : r.notes; } catch {}
      return {
        theme: r.theme,
        n: r.n,
        all_time_rate: parseFloat(r.all_time_rate),
        rolling_30d: parsed?.rolling_30d ?? null,
        rolling_10d: parsed?.rolling_10d ?? null,
        trend: r.trend,
        trend_delta: parsed?.trend_delta ?? null,
        weekly_counts: parsed?.weekly_counts ?? [],
      };
    });
    res.json({ items, run_date: rows[0]?.run_date || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pipeline health: last run date + row count per signal_type, with metadata
router.get('/pipeline-status', async (req, res) => {
  // Metadata for each known signal_type: description, schedule string, script(s), max_age_days
  const META = {
    SETUP_STATUS:        { cat: 'Core', desc: 'Auto-suppression gate — flags N≥20 + EV<-$5 setups as SHADOW. Also promotes recovered setups. Safety net: if stale, losing setups accumulate undetected.', schedule: 'Daily 4:20 PM ET + Sun 9:20 PM', scripts: 'backtest_setup_status.mjs', maxAge: 2 },
    SETUP_STATUS_DOW:    { cat: 'Core', desc: 'Per-DOW suppression overlay (e.g. Thu×IB_BEARISH EV=-$17). Stacks on top of global suppression; today\'s DOW rows loaded at startup.', schedule: 'Daily 4:20 PM ET + Sun 9:20 PM', scripts: 'backtest_setup_status.mjs', maxAge: 2 },
    OPTIMAL_STOP:        { cat: 'Core', desc: 'Data-derived stops + EV-sweep targets per setup type. Stop=p75_MAE (EV-sweep for IB). T1=argmax EV(T) where T≤p75_MFE. Live engine reads liveStats._opt[type].', schedule: 'Daily 4:20 PM ET + Sun', scripts: 'update_optimal_stops.mjs', maxAge: 2 },
    MON_BACKTEST:        { cat: 'Core', desc: 'Monday WR/EV overrides per level — used in keepLevels logic in acd.js. IB_LOW_MONDAY: EV=-$60, OR5_MID_MONDAY: 75.5% WR. Prevents level noise on statistically bad Monday setups.', schedule: 'Sun (weekly backtest)', scripts: 'backtest_monday_deep.js', maxAge: 8 },
    UNIFIED_BACKTEST:    { cat: 'Core', desc: 'EV, WR, N per setup_type×direction across all resolved trades. Primary source of truth for setup performance ranking and tier classification.', schedule: 'Sun 9:10 PM ET', scripts: 'backtest_unified.js', maxAge: 8 },
    DAY_TYPE_ALPHA:      { cat: 'Core', desc: 'Per-(setup_type × day_type) z-score → SIZE_UP/SUPPRESS cells in sizeMultiplier IIFE. Only cells with z≥1.5 + N≥20 affect live sizing.', schedule: 'Sun (weekly)', scripts: 'backtest_day_type_alpha.js', maxAge: 8 },
    LATENCY_AUDIT:       { cat: 'Core', desc: 'Setup fire latency: lag from first bar near level to alert. RETROACTIVE (>45min) = phantom win. Fix recovered ~$44K/yr. Alerts to gemini_alerts.txt.', schedule: 'Daily 5:15 PM ET', scripts: 'audit_setup_latency.mjs', maxAge: 2 },
    CONTEXT_ANALYSIS:    { cat: 'Context', desc: 'DOW × day-type × time-of-day edge across 136 conditions. Stable rules: no Monday fades, BALANCE-only, prefer LONG, IB_MID Fri=best.', schedule: 'Sun 6:00 AM ET', scripts: 'context_analysis.js', maxAge: 8 },
    SESSION_BIAS:        { cat: 'Context', desc: 'Pre-market direction bias (A Up, NL30, gap) vs session outcome. Powers the permission slip system for directional confidence.', schedule: 'Sun (weekly)', scripts: 'mine_session_bias.mjs', maxAge: 8 },
    PERMISSION_SLIP:     { cat: 'Context', desc: 'Session bias hit rates by context combo: A Up+NL30 72.1% N=140. Used in SessionBiasPanel for directional sizing confidence.', schedule: 'Sun (weekly)', scripts: 'backtest_permission_slips.mjs', maxAge: 8 },
    SETUP_ANTICIPATION:  { cat: 'Context', desc: 'P(setup fires | day_type, DOW) × avg_pnl. Powers top-3 forecast in SessionForecastPanel. Top: BALANCE→OR5_HIGH_FADE_SHORT 29% fire rate / 84% WR.', schedule: 'Sun 8:30 PM ET', scripts: 'backtest_level_approach.js', maxAge: 8 },
    PULSE_SCORE_AUDIT:   { cat: 'Context', desc: 'Pulse score (composite market-read: delta, volume, range, momentum) calibration vs next-day outcomes. Validates the scoring model.', schedule: 'Sun (weekly)', scripts: 'backtest_pulse_score.mjs', maxAge: 8 },
    // TOD_ALPHA/DOW_TOD_ALPHA corrected 2026-07-16 (self-recalibration audit) — traced via
    // `git log --all -S"TOD_ALPHA"`: both came from a one-off scratch/calculate_dow_tod.mjs
    // run (Jul 8, never committed to git, not a real pipeline script) whose output got
    // written to performance_audit once. The next day's commit (de3e407, which built this
    // whole META table) guessed mine_tod_patterns.mjs was the source by name-similarity
    // without checking — it only ever writes TOD_PATTERN (a separate, real, still-weekly
    // signal listed below). Neither signal_type is read anywhere outside this dashboard
    // (grep-verified), so this was a display-accuracy bug, not a live-decision one.
    TOD_ALPHA:           { cat: 'Context', desc: 'Time-of-day alpha per setup type: which setups outperform at which hours of the RTH session. One-off manual analysis (Jul 2026) — no recurring script produces this; will never refresh unless promoted to a real pipeline.', schedule: 'One-off (no script) — data frozen', scripts: 'none (was scratch/calculate_dow_tod.mjs, never committed)', maxAge: 9999 },
    DOW_TOD_ALPHA:       { cat: 'Context', desc: 'DOW × time-of-day cross-analysis (e.g. Friday morning fades vs Thursday afternoon setups). One-off manual analysis (Jul 2026) — no recurring script produces this; will never refresh unless promoted to a real pipeline.', schedule: 'One-off (no script) — data frozen', scripts: 'none (was scratch/calculate_dow_tod.mjs, never committed)', maxAge: 9999 },
    CONFLUENCE_AUDIT:    { cat: 'Context', desc: 'Level pair confluence at 15pt proximity: 108 TRADE-rated pairs. Top: CAM_S2+PD_IB_HIGH 75.5% EV=$55. Used in SessionForecastPanel.', schedule: 'Sun (weekly)', scripts: 'backtest_confluence.js', maxAge: 8 },
    AI_SETUP_REVIEW:     { cat: 'Coaching', desc: 'Per-session AI review of each trade: stop/entry/T1 quality rating (1–5⭐). Raw input for AI_SETUP_AGG.', schedule: 'Daily 4:35 PM ET', scripts: 'daily_coaching.js', maxAge: 2 },
    AI_SETUP_AGG:        { cat: 'Coaching', desc: 'Aggregated AI ratings per setup type — flags NEEDS_ADJUST when avg<3.5⭐ N≥20. Shown in Setup Calibration panel.', schedule: 'Daily 4:35 PM ET', scripts: 'aggregate_ai_setup_reviews.js', maxAge: 2 },
    BEHAVIORAL_STATS:    { cat: 'Coaching', desc: 'Behavioral pattern frequency trends across all coaching sessions (revenge trading, oversizing, etc). WORSENING = last10 >10pp above prior 20.', schedule: 'Sun 9:05 PM ET', scripts: 'aggregate_behavioral_stats.js', maxAge: 8 },
    BEHAVIORAL_PATTERN:  { cat: 'Coaching', desc: 'Specific behavioral patterns mined from coaching history text. Input to BEHAVIORAL_STATS.', schedule: 'Sun (weekly)', scripts: 'mine_behavioral_patterns.mjs', maxAge: 8 },
    LEVEL_FADE_AUDIT:    { cat: 'Specialized', desc: 'Per-level fade edge audit: EV/WR/N for each of the 50+ key levels. Identifies which levels are worth tracking vs noise.', schedule: 'Sun 9:22 PM ET', scripts: 'level_fade_audit.mjs', maxAge: 8 },
    MAE_MFE_AUDIT:       { cat: 'Specialized', desc: 'MAE/MFE distribution health: verifies backfill completeness and that stop/target distributions are well-formed and not skewed by outliers.', schedule: 'Sun 8:00 PM ET', scripts: 'audit_mae_mfe.mjs', maxAge: 8 },
    // SYSTEM_BACKTEST's script corrected 2026-07-16 (self-recalibration audit) --
    // backtest_full_system.js was archived 2026-07-09 (scripts/archive/); the real,
    // current writer is backtest_unified.js (confirmed via grep + it's genuinely fresh,
    // 7 distinct run_dates) -- this entry's schedule/freshness claim was already
    // accidentally correct, only the script name was stale.
    SYSTEM_BACKTEST:     { cat: 'Specialized', desc: 'Full system-level backtest across all trade types and regime conditions. Broader than UNIFIED_BACKTEST — includes combo and contextual signals.', schedule: 'Sun 9:10 PM ET', scripts: 'backtest_unified.js', maxAge: 10 },
    LEVEL_PATTERN:       { cat: 'Specialized', desc: 'Pattern recognition at key levels (absorption bars, volume spikes, reclaim patterns). Feeds into sizeMultiplier confluence factor.', schedule: 'Weekly', scripts: 'backtest_level_patterns.mjs', maxAge: 10 },
    TOD_PATTERN:         { cat: 'Specialized', desc: 'Time-of-day pattern mining: recurring price behavior at specific intraday times.', schedule: 'Weekly', scripts: 'mine_tod_patterns.mjs', maxAge: 10 },
    // LEVEL_FADE_DELTA corrected 2026-07-16 (self-recalibration audit) -- traced via
    // `git log --all -S"LEVEL_FADE_DELTA"`: real original writer was
    // scripts/backtest_session_delta.mjs, archived in the SAME commit (de3e407) that
    // built this META table -- unlike MIDPOINT_FADE_AUDIT/PD_IB_AUDIT below (correctly
    // marked frozen in that same commit), this one was pointed at backtest_level_patterns.mjs
    // instead, which only ever writes LEVEL_PATTERN (above), never this signal_type. Not
    // read anywhere outside this dashboard (grep-verified) -- display-accuracy bug only.
    LEVEL_FADE_DELTA:    { cat: 'Specialized', desc: 'Delta confirmation at level fades — net buyer/seller imbalance at approach; informed the live +0.15 sizeMultiplier "buyersAtLevel/sellersAtLevel" factor (acd.js ~line 5061), which is computed fresh from live bars, not read from this table. Script archived 2026-07-09 (scripts/archive/backtest_session_delta.mjs) — data frozen.', schedule: 'Historical (script archived 2026-07-09)', scripts: 'backtest_session_delta.mjs (archived)', maxAge: 9999 },
    MIDPOINT_FADE_AUDIT: { cat: 'Specialized', desc: 'High-N historical baseline (N=293–483/level) for IB_MID, OR_MID, OR_MID_AFTER_IB, PD_MID, SESSION_MID, VWAP. Script archived — data is frozen 2024 reference. UNIFIED_BACKTEST covers directional splits for active levels.', schedule: 'Historical (script archived 2026-07-09)', scripts: 'midpoint_fade_audit.mjs', maxAge: 9999 },
    PD_IB_AUDIT:         { cat: 'Specialized', desc: 'High-N historical baseline (N=167–297/level) for PD_IB_HIGH/LOW/MID, PD_OR_HIGH/LOW, PD_OR_MID, PD_SESSION_MID. Script archived — data frozen. PD_OR_HIGH and PD_OR_LOW have no UNIFIED_BACKTEST directional equivalent yet.', schedule: 'Historical (script archived 2026-07-09)', scripts: 'pd_ib_or_fade_audit.mjs', maxAge: 9999 },
  };

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { rows } = await query(`
      SELECT signal_type,
             MAX(run_date)::text AS last_run,
             COUNT(*) AS total_rows,
             MAX(run_date) AS last_run_ts
      FROM performance_audit
      GROUP BY signal_type
      ORDER BY MAX(run_date) DESC
    `);

    const known = new Set(rows.map(r => r.signal_type));

    // Build result: known types + any META types not yet in DB
    const allTypes = [
      ...rows.map(r => {
        const meta = META[r.signal_type];
        const daysSince = Math.floor((new Date(today) - new Date(r.last_run)) / 86400000);
        if (!meta) {
          // Not in META = not a scheduled pipeline; mark as ORPHAN for Gemini consolidation
          return { signal_type: r.signal_type, last_run: r.last_run, total_rows: parseInt(r.total_rows, 10), days_since: daysSince, cat: 'Orphan', desc: 'Not in scheduled pipeline set — likely one-off analysis or superseded. Gemini consolidation audit will classify.', schedule: '(unscheduled)', scripts: '?', maxAge: 0, status: 'ORPHAN' };
        }
        return { signal_type: r.signal_type, last_run: r.last_run, total_rows: parseInt(r.total_rows, 10), days_since: daysSince, ...meta };
      }),
      ...Object.entries(META)
        .filter(([k]) => !known.has(k))
        .map(([k, m]) => ({ signal_type: k, last_run: null, total_rows: 0, days_since: null, ...m, status: 'NEVER' })),
    ];

    // Freshness for META types: OK / STALE / NEVER
    const result = allTypes.map(r => {
      if (r.status) return r; // already set (ORPHAN / NEVER)
      let status = 'NEVER';
      if (r.last_run) {
        status = r.days_since <= r.maxAge ? 'OK' : 'STALE';
      }
      return { ...r, status };
    });

    res.json({ pipelines: result, as_of: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
