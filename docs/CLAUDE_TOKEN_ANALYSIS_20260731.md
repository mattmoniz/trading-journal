# Claude Token Burn Analysis & Critique (Updated for Regime Engine)

I have analyzed your codebase to identify why your Claude token burn rate is high. The token burn originates from three distinct layers of your architecture. Here is a critique of the current setup and how to optimize it, especially in light of the new **Dual-Timeframe Matrix Engine** we just designed.

## 1. IDE Context Bloat (`CLAUDE.md`)
**The Problem:**
Your `CLAUDE.md` file is **184 KB** in size (roughly 45,000 tokens). Most AI coding assistants (like Cursor, Cline, or Copilot) automatically inject the entire contents of `CLAUDE.md` into the system prompt for **every single interaction**. 
At ~$3 per million input tokens, you are burning roughly $0.14 on *every single message you send* in your IDE, just to repeatedly feed Claude historical bug post-mortems and long-winded anecdotes.

**The Fix:**
- **Separate rules from history:** `CLAUDE.md` should only contain crisp, actionable rules (e.g., "Always use CumPL diff, never SUM(pnl)").
- **Protect the New Spec:** We just wrote a 567-line `docs/REGIME_INTELLIGENCE_SPEC.md`. **Do not** copy its contents into `CLAUDE.md`. Simply add one line to `CLAUDE.md`: *"When modifying the setup routing engine, you must read docs/REGIME_INTELLIGENCE_SPEC.md first."*
- **Move the anecdotes:** Take the detailed "Found 2026-07-19..." post-mortems and move them to `docs/POST_MORTEMS.md`. 

## 2. Unoptimized Application API Calls (`server/routes/playbook.js`)
**The Problem:**
The `/api/playbook/assess` endpoint is a massive token sink. Historically, it bundled a huge amount of context to send to Claude, including 80 rows of audit data, full OHLCV arrays, and raw setups, effectively asking Claude to "guess" the market regime.

**The Fix (The Matrix Advantage):**
- **Leverage the Database Brain:** Because we just built the `regime_matrix_dictionary` and `balance_area_snapshots`, the database now does the heavy lifting. You no longer need to send Claude raw OHLCV arrays! 
- **Shrink the Payload:** Instead of sending massive arrays, update the `/api/playbook/assess` payload to simply pass the pre-computed Matrix Status. 
  *Example Payload:* `"Today is Edge30+Mid60. Physics: Macro Chop / Mean Reversion. Authorized Setups: IB_BEARISH, CAM_S2_FADE_SHORT."*
- **Implement Prompt Caching:** If you still need to pass historical data, add `cache_control: { "type": "ephemeral" }` to your `ASSESS_SYSTEM` block to utilize Anthropic's Prompt Caching.

## 3. Agentic Workflow Bloat (`antigravity_response.md`)
**The Problem:**
You have a sophisticated supervisor loop where Claude delegates heavy lifting to Gemini via `scripts/invoke_gemini.sh`. If Gemini dumps thousands of lines of raw SQL query results into `scratch/antigravity_response.md`, Claude is forced to read that massive file to validate the work, burning massive amounts of input tokens in its IDE context.

**The Fix (Managing the Shadow Tagger):**
- **Aggregate, Don't Dump:** The new "Shadow Tagger" is going to generate thousands of suppressed entries in `regime_gate_log`. When you ask Gemini to review the Shadow Tagger, Gemini must **never** output raw log rows to `antigravity_response.md`. 
- **The Executive Summary Rule:** Add a strict instruction in `docs/ANTIGRAVITY_CONSTRAINTS.md`: *"Gemini must never output more than 10 rows of raw data into antigravity_response.md. Write full result sets to a separate CSV in `reports/` and provide Claude with a 3-sentence executive summary and the file path."*
- This keeps Claude's context window pristine. Claude only reads the summary and makes the final decision, rather than tokenizing 5,000 lines of raw backtest outputs.

## 4. Self-Care & Circuit Breakers (Preventing Context Collapse)
**The Problem:**
When Claude gets stuck on a complex coding task or struggles to debug an issue, it will often enter a "death loop"—repeatedly writing the same broken code, apologizing, and trying again. This not only burns massive amounts of tokens, but it destroys the context window, meaning Claude forgets the original instructions.

**The Fix (Add these Circuit Breakers to `CLAUDE.md`):**
Add the following strict behavioral rules to the top of `CLAUDE.md`:
1. **The 3-Strike Rule:** *"If you write code that fails or produces an error 3 times in a row, STOP writing code. Step back, write out the assumptions you are making, and ask the user for clarification before proceeding."*
2. **Context Window Flush:** *"If a task is taking exceptionally long and you feel your context is getting confused, stop and write a 'Checkpoint Summary' of your progress. Ask the user to start a new chat session and paste the Checkpoint Summary there to refresh your context window."*
3. **Escalate to Peer Review:** *"If you are stuck on a complex mathematical or architectural problem, stop guessing. Invoke Gemini (via `scripts/invoke_gemini.sh`) to run the math or review the architecture for you, and wait for its response in `antigravity_response.md`."*
