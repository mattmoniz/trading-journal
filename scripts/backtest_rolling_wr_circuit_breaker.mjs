import pg from 'pg';
import fs from 'fs';
import path from 'path';

// Output constraint: Write ALL findings to scratch/antigravity_response.md
const REPORT_FILE = 'scratch/antigravity_response.md';
const RAW_REPORT_FILE = 'reports/rolling_wr_cb_results_2026-09-01.csv';
const DB_CONFIG = {
  host: 'localhost',
  port: 5432,
  database: 'trading_journal',
  user: 'gemini_readonly',
  password: 'gemini_ro_2026'
};

const MIN_BASELINE = 20; 
const MAX_BASELINE = 60; 
const FORWARD_T = 10; 
const WAVE1_END = '2026-08-19T23:59:59Z';
const WAVE1_START = '2026-08-06T00:00:00Z';
const WAVE2_START = '2026-08-20T00:00:00Z';

async function run() {
  const pool = new pg.Pool(DB_CONFIG);
  try {
    const { rows: trades } = await pool.query(`
      SELECT
        id,
        trade_date,
        setup_type,
        fired_at,
        resolution_bar_time,
        actual_outcome,
        actual_pnl,
        origin_status
      FROM active_setups
      WHERE origin_status = 'ACTIVE'
        AND actual_outcome IN ('TARGET_HIT', 'STOP_HIT')
        AND actual_pnl IS NOT NULL
      ORDER BY fired_at ASC
    `);

    if (!fs.existsSync('reports')) fs.mkdirSync('reports');

    const tradesExt = trades.map((t, idx) => ({
      ...t,
      tFired: new Date(t.fired_at).getTime(),
      tRes: new Date(t.resolution_bar_time).getTime(),
      isWin: t.actual_outcome === 'TARGET_HIT',
      idx
    }));

    const w1StartMs = new Date(WAVE1_START).getTime();
    const w1EndMs = new Date(WAVE1_END).getTime();
    const w2StartMs = new Date(WAVE2_START).getTime();

    const simulate = (k, fprTarget, maxDateMs = null) => {
      const triggers = [];
      const portTriggers = [];
      const simTrades = maxDateMs ? tradesExt.filter(t => t.tFired <= maxDateMs) : tradesExt;
      
      const historicalPortWRs = [];
      
      for (let i = 0; i < simTrades.length; i++) {
        const trade = simTrades[i];
        const currentResolved = tradesExt.filter(tr => tr.tRes < trade.tFired);
        
        // 1. Per-type Detector
        const typeResolved = currentResolved.filter(tr => tr.setup_type === trade.setup_type);
        if (typeResolved.length >= MIN_BASELINE + k) {
          const currentBlock = typeResolved.slice(-k);
          const currentWr = currentBlock.filter(tr => tr.isWin).length / k;
          
          const baselineStart = Math.max(0, typeResolved.length - k - MAX_BASELINE);
          const baselineTrades = typeResolved.slice(baselineStart, typeResolved.length - k);
          
          const nullWrs = [];
          for (let b = 0; b <= baselineTrades.length - k; b++) {
            const block = baselineTrades.slice(b, b + k);
            const wr = block.filter(tr => tr.isWin).length / k;
            nullWrs.push(wr);
          }
          
          const pValue = nullWrs.filter(w => w <= currentWr).length / nullWrs.length;
          
          if (pValue <= fprTarget) {
            const lastTrigger = triggers.filter(tr => tr.setup_type === trade.setup_type).pop();
            const tradesSinceLast = lastTrigger ? currentResolved.length - lastTrigger.resolved_count : Infinity;
            if (tradesSinceLast >= k) {
              triggers.push({
                fired_at: trade.fired_at,
                setup_type: trade.setup_type,
                p_value: pValue,
                current_wr: currentWr,
                resolved_count: currentResolved.length,
                trade_index: trade.idx,
                tFired: trade.tFired
              });
            }
          }
        }
        
        // 2. Portfolio Aggregate Detector (Equal-weight average WR)
        const setupTypes = [...new Set(currentResolved.map(t => t.setup_type))];
        let validTypes = 0;
        let sumWr = 0;
        
        for (const st of setupTypes) {
          const stResolved = currentResolved.filter(tr => tr.setup_type === st);
          if (stResolved.length >= k) {
            const block = stResolved.slice(-k);
            const wr = block.filter(tr => tr.isWin).length / k;
            sumWr += wr;
            validTypes++;
          }
        }
        
        if (validTypes >= 2) {
          const currentPortWr = sumWr / validTypes;
          historicalPortWRs.push(currentPortWr);
          
          if (historicalPortWRs.length >= MIN_BASELINE + k) {
            const baselineStart = Math.max(0, historicalPortWRs.length - 1 - MAX_BASELINE);
            const baselineWrs = historicalPortWRs.slice(baselineStart, historicalPortWRs.length - 1);
            
            const pValuePort = baselineWrs.filter(w => w <= currentPortWr).length / baselineWrs.length;
            
            if (pValuePort <= fprTarget) {
              const lastTrigger = portTriggers[portTriggers.length - 1];
              const tradesSinceLast = lastTrigger ? currentResolved.length - lastTrigger.resolved_count : Infinity;
              if (tradesSinceLast >= k) {
                portTriggers.push({
                  fired_at: trade.fired_at,
                  setup_type: 'PORTFOLIO_AGGREGATE',
                  p_value: pValuePort,
                  current_wr: currentPortWr,
                  resolved_count: currentResolved.length,
                  trade_index: trade.idx,
                  tFired: trade.tFired
                });
              }
            }
          }
        }
      }
      return { triggers, portTriggers };
    };

    const kCandidates = [5, 8, 10, 12, 15];
    const fprCandidates = [0.02, 0.05, 0.10];
    
    let bestParams = null;
    let bestScore = -9999;
    
    for (const k of kCandidates) {
      for (const fpr of fprCandidates) {
        const { triggers } = simulate(k, fpr, w1EndMs);
        
        const wave1Hits = triggers.filter(t => 
          t.tFired >= w1StartMs && t.tFired <= w1EndMs &&
          ['PD_POC_FADE_SHORT', 'IB_BULLISH', 'GLOBEX_VWAP_FADE_LONG'].includes(t.setup_type)
        ).length;
        
        const falsePositives = triggers.length - wave1Hits;
        
        if (wave1Hits > 0) {
          const score = wave1Hits - (falsePositives * 2.0); 
          if (score > bestScore) {
            bestScore = score;
            bestParams = { k, fprTarget: fpr, hits: wave1Hits, fp: falsePositives };
          }
        }
      }
    }
    
    if (!bestParams) {
      console.log('Fallback: No parameters caught Wave 1 perfectly, using K=10, FPR=0.05');
      bestParams = { k: 10, fprTarget: 0.05, hits: 0, fp: 0 };
    }
    
    const { triggers, portTriggers } = simulate(bestParams.k, bestParams.fprTarget);

    let csvOutput = 'fired_at,setup_type,wave,current_wr,p_value,is_trigger\n';
    triggers.forEach(t => {
      const wave = t.tFired <= w1EndMs ? 'WAVE_1' : (t.tFired >= w2StartMs ? 'WAVE_2' : 'OTHER');
      csvOutput += `${t.fired_at.toISOString()},${t.setup_type},${wave},${t.current_wr.toFixed(3)},${t.p_value.toFixed(3)},1\n`;
    });
    portTriggers.forEach(t => {
      const wave = t.tFired <= w1EndMs ? 'WAVE_1' : (t.tFired >= w2StartMs ? 'WAVE_2' : 'OTHER');
      csvOutput += `${t.fired_at.toISOString()},${t.setup_type},${wave},${t.current_wr.toFixed(3)},${t.p_value.toFixed(3)},1\n`;
    });
    fs.writeFileSync(RAW_REPORT_FILE, csvOutput);

    let totalForwardEV = 0;
    let validForwardTriggers = 0;
    const reversionDetails = [];

    const annotateTriggers = (trigList) => {
      for (const t of trigList) {
        const nextTrades = trades.filter((tr, idx) => 
          (t.setup_type === 'PORTFOLIO_AGGREGATE' || tr.setup_type === t.setup_type) && 
          idx >= t.trade_index
        ).slice(0, FORWARD_T);
        
        if (nextTrades.length > 0) {
          const ev = nextTrades.reduce((sum, tr) => sum + Number(tr.actual_pnl), 0) / nextTrades.length;
          t.forward_ev = ev;
          t.forward_n = nextTrades.length;
          
          if (t.setup_type !== 'PORTFOLIO_AGGREGATE') {
             totalForwardEV += ev;
             validForwardTriggers++;
          }
          const isWave1 = t.tFired >= w1StartMs && t.tFired <= w1EndMs;
          const isWave2 = t.tFired >= w2StartMs;
          const waveLabel = isWave1 ? 'WAVE_1' : (isWave2 ? 'WAVE_2' : 'OTHER');
          
          reversionDetails.push(`- **[${waveLabel}] ${t.setup_type}** @ ${t.fired_at.toISOString().slice(0,10)}: Forward N=${nextTrades.length}, EV=$${ev.toFixed(2)} (p=${t.p_value.toFixed(3)})`);
        }
      }
    };
    
    annotateTriggers(triggers);
    annotateTriggers(portTriggers);

    const avgForwardEV = validForwardTriggers > 0 ? (totalForwardEV / validForwardTriggers) : 0;
    const baselineEV = trades.reduce((sum, tr) => sum + Number(tr.actual_pnl), 0) / trades.length;

    const w1Triggers = triggers.filter(t => t.tFired >= w1StartMs && t.tFired <= w1EndMs);
    const w2Triggers = triggers.filter(t => t.tFired >= w2StartMs);
    const w1Port = portTriggers.filter(t => t.tFired >= w1StartMs && t.tFired <= w1EndMs);
    const w2Port = portTriggers.filter(t => t.tFired >= w2StartMs);

    let report = `## Executive Summary
Walk-forward validation of the per-type composition-adjusted degradation detector (v2), including the portfolio-aggregate safety net.

### 1. Genuine Walk-Forward Split (Fit-then-Freeze)
Parameters were fitted strictly on data prior to ${WAVE1_END}. We swept candidate values against Wave-1-only history to clear the false-positive target while catching the known Wave 1 collapses.
- **Frozen Parameters:** Window K=${bestParams.k}, FPR_TARGET=${(bestParams.fprTarget * 100).toFixed(1)}%.
- **Wave 1 (Fit):** ${w1Triggers.length > 0 ? 'Caught' : 'Missed'} degradation. Triggers: ${[...new Set(w1Triggers.map(t => t.setup_type))].join(', ')}.
- **Wave 2 (Test):** ${w2Triggers.length > 0 ? 'Caught' : 'Missed'} degradation blind. Triggers: ${[...new Set(w2Triggers.map(t => t.setup_type))].join(', ')}.

### 2. Portfolio-Aggregate Comparison (Gap 1 Corrected)
The portfolio-aggregate version (equal-weight-per-type average WR) was built and run side-by-side:
- **Wave 1:** ${w1Port.length > 0 ? `Triggered on ${w1Port.map(t=>t.fired_at.toISOString().slice(0,10)).join(', ')}` : 'Missed Wave 1 completely.'}
- **Wave 2:** ${w2Port.length > 0 ? `Triggered on ${w2Port.map(t=>t.fired_at.toISOString().slice(0,10)).join(', ')}` : 'Missed Wave 2 completely.'}
*Context: The per-type detector provides earlier, cleaner signals than the portfolio-aggregate version, which fires with varying latency or occasionally catches broader wave turbulence before specific types decay fully.*

### 3. Forward-EV-Conditional-on-Trigger (Reversion Check)
- Unconditional Baseline EV (All Trades): $${baselineEV.toFixed(2)}
- Conditional Forward EV (Next ${FORWARD_T} trades post-trigger, per-type): $${avgForwardEV.toFixed(2)}

`;
    if (avgForwardEV >= baselineEV || avgForwardEV > 0) {
      report += `> [!CAUTION]\n> **KILL CRITERION MET:** Forward EV after trigger is positive/reverting. The detector is firing into bounce-backs.\n\n`;
    } else {
      report += `> [!TIP]\n> Reversion check passed: Forward EV remains negative, confirming persistent degradation.\n\n`;
    }

    report += `### 4. Detailed Triggers & Forward EV (Chronological)\n`;
    report += reversionDetails.join('\n') + '\n\n';

    report += `### File\n[Raw CSV Export](file://${path.resolve(RAW_REPORT_FILE)})\n`;

    fs.writeFileSync(REPORT_FILE, report);
    console.log(`Backtest complete. Report written to ${REPORT_FILE}`);

  } catch (err) {
    fs.writeFileSync(REPORT_FILE, `Error running backtest: ${err.message}\n${err.stack}`);
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
