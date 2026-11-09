# "Production Technical Specification (v2.0): Structure-Gated Time-Velocity Liquidity Vacuum & Continuation Engine (NQ/MNQ)" (saved 2026-11-08, pasted by the user)

User: "Was this the same one from before, because im trying to trace back my steps still. Im nervous i lost the initial idea. Would this pass a rigorous audit, thirds, by claude but also still be very profitable". NOTE: the equations of the original paste did NOT survive (every formula line below is blank in the paste: VWAP, Opening Range, Velocity, the Bollinger lines, ROC bands, the M1/M2 long and short triggers). Only the prose survived. The user should re-paste the equations (or the markdown source) before this version is audited or built. Claude's label for this file: "structure-gated velocity version"; it is NOT one of the files in docs/GeminiArgons*.

## 1. System Objective & Architectural Mandate
Deterministic, zero-lookahead, event-driven execution and backtesting engine in Python for intraday NQ/MNQ on 500-Volume bars from Sierra Chart. To survive a rigorous 3-split walk-forward backtest (In-Sample / Validation / Out-of-Sample across 2023-2026 data regimes) with high win rate and long-term viability, this v2.0 engine implements two structural pivots:
 * Structure-Gated Entry Topology: eradicates blind 50-bar oscillator chases by anchoring all entries to zero-lookahead RTH Developing VWAP and Opening Range High/Low boundaries.
 * Unified Time-Velocity Mechanics: replaces fragile L2 DOM depth proxies with a robust, backtest-invariant tick-velocity metric (TrueRange_t / dt_t) and 3-bar compression-to-expansion bursts, eliminating late 10-bar entries and premature flag exits.

## 2. Data Pipeline, 500-Volume Bar Construction & Rollover Hygiene
2.1 Each bar t seals the instant cumulative traded volume reaches >= 500 contracts. Data contract for .scid backtesting and PostgreSQL logging: open_ts[t], close_ts[t] (microsecond, UTC / America/New_York); O,H,L,C float64 (tick_size 0.25, point_value_nq 20.00); volume[t] (>= 500); num_trades[t]; bid_vol[t], ask_vol[t] (aggressive volume at bid vs ask; delta_t = ask_vol_t - bid_vol_t).
2.2 Rollover, session reset and warmup gate (14 quarterly CME rollovers H, M, U, Z and the daily 17:00-18:00 halts): Session Reset Event if the contract symbol changes, close_ts_t - close_ts_{t-1} > 3600 s, or (rth_only mode) bar t is the first bar at or after 09:30:00 EST. True Range gap exclusion: on the first bar after a reset TR_t = H_t - L_t. Warmup lockout: bars_since_reset = 0, +1 per bar; block all entries while bars_since_reset < 15.

## 3. Zero-Lookahead RTH Session Structure & Time-Velocity Features
3.1 Session topology (cumulative, no lookahead): RTH Developing VWAP [formula lost in paste]; Opening Range (OR) formed across the first 15 bars of RTH (bars_since_reset in [1, 15]) [formula lost].
3.2 Unified Tick-Velocity Speedometer (Velocity_t): replaces L2 DOM depth proxies to guarantee equivalence between historical .scid backtests and live DTC execution. Bar duration dt_t = max(close_ts_t - open_ts_t, 0.05). Unified velocity metric = points per second per 500 contracts [formula lost; stated elsewhere as TrueRange_t / dt_t]. Bollinger bands on Velocity (L=50, k=1.5) [formula lost].
3.3 Bar Time Duration and relative pace gate (is_fast_tape_t): Dur_SMA_t = SMA(dt_t, 50). RTH: is_fast_tape = (dt_t <= 0.50 x Dur_SMA_t) AND (dt_t <= 15.0 s). Globex: is_fast_tape = (dt_t <= 0.65 x Dur_SMA_t) AND (dt_t <= 120.0 s).
3.4 Fast 3-bar rate of change ROC_{3,t} = C_t - C_{t-3} and a structural compass ROC_{50,t}; Bollinger bands on ROC_3 (L=50, k=2.0) [formulas lost].

## 4. Structure-Gated Entry Mechanics (STATE == FLAT)
All entries require: bars_since_reset >= 15, a valid RTH/Globex session window, is_fast_tape == True, and structural boundary clearance.
Mechanic 1, Structure-Gated Breakout Ignition (M1_Structure_Breakout): long trigger [lost], short trigger [lost]. Action: enter at Next_Bar_Open + slippage -> STATE = IMPULSE_ACTIVE, wave_count = 1.
Mechanic 2, Compression-to-Expansion Coil (M2_Compression_Ignition): long trigger [lost], short trigger [lost]. Action: enter at Next_Bar_Open + slippage -> IMPULSE_ACTIVE, wave_count = 1.

## 5. Position Lifecycle, Dynamic Climax Exits & Structural Stop Trails (strict priority on each bar close with position != 0)
 * Priority 1, Structural stop-loss trail (replacing fixed stops): Long: stop anchored at max(VWAP_t, Swing_Low_{t-10}) or FillPrice - 2.5 x EMA_TR_entry. Short: min(VWAP_t, Swing_High_{t-10}) or FillPrice + 2.5 x EMA_TR_entry. If breached -> exit 100%, FLAT.
 * Priority 2, Time-decay pullback stall (is_stalled): if price enters a pullback flag but bar duration doubles (dt_t > 2.0 x EMA_10(dt_impulse)) or velocity collapses (Z_Vel <= -1.0), institutional sweep momentum is dead -> exit 100%, FLAT.
 * Priority 3, Wave climax exhaustion hook (ROC_Hooked_Inside + Velocity_Curled_Down): ROC_3 hooks inside its Bollinger band (>= 0.20 sigma retreat) while unified velocity curls down by >= 25 percent from its peak. Execution: bank 50 to 75 percent profit at Next_Bar_Open, move runner stop to breakeven + 1 tick, transition to STATE = PULLBACK_HOLD to ride multi-wave continuation.

## 6. PostgreSQL Persistence, DTC Live Execution & Ablation Deliverables
 * PostgreSQL logging: commit all sealed 500V bars, rolling metrics (Vel_Mid, ROC_Std) and FSM state (state, wave_count, entry_price) to local tables (price_bars, strategy_state_log) for recovery on restart.
 * DTC protocol (JSON/TCP): asynchronous Sierra Chart integration for sub-millisecond order routing and fill logging.
 * Execution cost model: dynamic slippage (Z_Vel <= 1.5 -> 1 tick; 1.5 < Z <= 2.5 -> 2 ticks; Z > 2.5 -> 3 ticks) and $1.24 round-turn commissions per MNQ.
 * Required ablation deliverables: complete 3 x 2 x 2 matrix reporting Win Rate, Profit Factor, Net Expectancy, Sharpe/Sortino, Max Drawdown and Purged Walk-Forward Efficiency Ratio across 2023, 2024, 2025 and YTD 2026 splits.
