import React, { useState, useEffect } from 'react';
import { useSharedPollData, refreshSharedPollData } from '../../utils/useSharedPollData';
import { useViewActive } from '../../utils/useViewActive.js';

import { API_URL } from '../../constants/api.js';
const fmtP = (n) => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

function computePlaybook(ctx, acd, edges) {
  if (!ctx || !acd?.today) return null;

  const t = acd.today;
  const price      = ctx.price;
  const closeVsOpen = ctx.closeVsOpen || 0;
  const vwap       = ctx.vwap;
  const poc        = ctx.poc;
  const ibH        = ctx.ibH;
  const ibL        = ctx.ibL;
  const ibMid      = ibH && ibL ? Math.round((ibH + ibL) / 2) : null;
  const orHigh     = parseFloat(t.or_high) || null;
  const orLow      = parseFloat(t.or_low)  || null;
  const orMid      = orHigh && orLow ? Math.round((orHigh + orLow) / 2) : null;
  const aDown      = parseFloat(t.a_down_level) || null;
  const aUp        = parseFloat(t.a_up_level)   || null;
  const aDownFired = !!t.a_down_fired;
  const aUpFired   = !!t.a_up_fired;
  const cDownConf  = !!t.c_down_confirmed;
  const cUpConf    = !!t.c_up_confirmed;
  const microTrend = ctx.microTrend;
  const deltaTrend = ctx.delta?.trend;
  const sessionChar = ctx.sessionChar;
  const permConds  = edges?.sessionPermissions?.conditions || [];

  // Delta divergence relative to session direction
  const isDownSession = closeVsOpen < -80;
  const isUpSession   = closeVsOpen > 80;
  const longDiv  = isDownSession && (deltaTrend === 'BUYING'  || deltaTrend === 'WEAKENING');
  const shortDiv = isUpSession   && (deltaTrend === 'SELLING' || deltaTrend === 'WEAKENING');
  const bearConf = isDownSession && (deltaTrend === 'SELLING' || deltaTrend === 'STRENGTHENING');
  const bullConf = isUpSession   && (deltaTrend === 'BUYING'  || deltaTrend === 'STRENGTHENING');

  // Bias score
  let score = 0;
  if (aDownFired && cDownConf)  score -= 3;
  else if (aDownFired)          score -= 1;
  if (aUpFired && cUpConf)      score += 3;
  else if (aUpFired)            score += 1;
  if (closeVsOpen < -80)        score -= 1;
  else if (closeVsOpen > 80)    score += 1;
  if (bearConf)                 score -= 1;
  else if (longDiv)             score += 0.5;  // caution — reversal watch
  if (bullConf)                 score += 1;
  else if (shortDiv)            score -= 0.5;
  if (microTrend === 'LOWER_HIGHS' || microTrend === 'LOWER_LOWS') score -= 0.5;
  if (microTrend === 'HIGHER_LOWS')                                 score += 0.5;

  const bias       = score <= -2 ? 'BEARISH' : score >= 2 ? 'BULLISH' : 'NEUTRAL';
  const confidence = Math.min(94, Math.round(50 + Math.abs(score) * 9));

  const reasons = [], watches = [], invalidations = [];
  let situation = '', entryZone = null, entryPrice = null, whyEntry = '';
  let t1 = null, t2 = null, t3 = null, stop = null;
  // readiness: WAIT | APPROACHING | IN_ZONE | IN_MOTION
  let readiness = 'WAIT', waitingFor = '', waitDistance = null;

  // ── BEARISH ──────────────────────────────────────────────────────────
  if (bias === 'BEARISH') {
    if (aDownFired && cDownConf)
      reasons.push('A Down + C Down confirmed — 86% WR on TREND/TURBULENT days');
    else if (aDownFired)
      reasons.push('A Down fired — waiting for C confirmation');
    if (closeVsOpen < 0)
      reasons.push(`Session ${closeVsOpen}pt vs open`);
    if (bearConf) reasons.push('Delta confirming sellers');

    // Pick best entry level — highest named resistance above or near price
    const entryLevels = [
      orMid  ? { level: orMid,              name: 'OR MID',  why: 'Statistically strongest fade zone on down days. Bounces to OR MID fail 73% of the time.' } : null,
      vwap   ? { level: Math.round(vwap),   name: 'VWAP',   why: 'VWAP is the session magnet — price extended below it tends to snap back, then fail here. 62% WR.' } : null,
      ibMid  ? { level: ibMid,              name: 'IB MID', why: 'IB midpoint — separates buyers from sellers. Price failing here = sellers defending.' } : null,
    ].filter(Boolean);

    // Find the closest one price hasn't blown through (above price or just below)
    const bestEntry = entryLevels.find(e => e.level > price - 30) || entryLevels[0];
    if (bestEntry) {
      entryPrice = bestEntry.level;
      entryZone  = `${bestEntry.name} ${fmtP(bestEntry.level)}`;
      whyEntry   = bestEntry.why;
      const dist = bestEntry.level - price;
      if (dist > 40)        { readiness = 'WAIT';        waitingFor = `Bounce to ${bestEntry.name} ${fmtP(bestEntry.level)}`; waitDistance = Math.round(dist); }
      else if (dist > 10)   { readiness = 'APPROACHING'; waitDistance = Math.round(dist); }
      else if (dist > -25)  { readiness = 'IN_ZONE'; }
      else                  { readiness = 'IN_MOTION'; }
    }

    // Targets: named levels below current price, sorted high→low
    const candidates = [
      aDown && price > aDown + 5  ? { n: 'A Down', p: Math.round(aDown) } : null,
      ibMid && price > ibMid + 5  ? { n: 'IB MID', p: ibMid             } : null,
      vwap  && price > vwap  + 5  ? { n: 'VWAP',   p: Math.round(vwap) } : null,
      poc   && price > poc   + 5  ? { n: 'POC',    p: Math.round(poc)  } : null,
      ibL   && price > ibL   + 5  ? { n: 'IB Low', p: Math.round(ibL)  } : null,
    ].filter(Boolean).sort((a, b) => b.p - a.p);
    if (candidates[0]) t1 = candidates[0];
    if (candidates[1]) t2 = candidates[1];
    if (candidates[2]) t3 = candidates[2];

    const entryRef = entryPrice || price;
    stop = `${fmtP(Math.round(entryRef + 22))} (+22pt above entry)`;

    situation = readiness === 'WAIT'
      ? `Bearish bias is clear — but don't trade yet. Wait for price to bounce to ${entryZone} (${waitDistance}pt away). Chasing from here gives up your edge.`
      : readiness === 'APPROACHING'
      ? `Price approaching ${entryZone} — get ready. This is your zone.`
      : readiness === 'IN_ZONE'
      ? `Price AT ${entryZone} — this is your entry. Stats are on your side here.`
      : `Price broke below ${entryZone}. Bearish momentum trade in progress — ride to targets.`;

    if (longDiv)
      watches.push('Delta diverging (buyers stepping in) — reduce size, wait for delta to roll back over.');
    else
      watches.push(`Delta ${deltaTrend || '—'} — ${bearConf ? 'aligned with short, confirming' : 'neutral, watch for flip to BUYING as exit signal'}`);
    if (microTrend === 'HIGHER_LOWS')
      watches.push('Higher lows forming — price is finding support. Short with smaller size.');

    if (orMid) invalidations.push(`Reclaim of OR MID ${fmtP(orMid)} with buying delta — exit short`);
    if (aUp)   invalidations.push(`A Up fires ${fmtP(Math.round(aUp))} — bias flips, go flat`);
    invalidations.push('Delta shifts BUYING on new session high — exit, not a fade day');

  // ── BULLISH ───────────────────────────────────────────────────────────
  } else if (bias === 'BULLISH') {
    if (aUpFired && cUpConf)
      reasons.push('A Up + C Up confirmed — continuation bias');
    else if (aUpFired)
      reasons.push('A Up fired — waiting for C confirmation');
    if (closeVsOpen > 0)
      reasons.push(`Session +${closeVsOpen}pt vs open`);
    if (bullConf) reasons.push('Delta confirming buyers');

    const bullEntryLevels = [
      orMid  ? { level: orMid,             name: 'OR MID', why: 'OR MID is the first test on a pullback — if buyers defend here, 74% continuation up.' } : null,
      vwap   ? { level: Math.round(vwap),  name: 'VWAP',  why: 'VWAP dips on trend-up days resolve higher 67% of the time. Best risk/reward zone.' } : null,
      ibMid  ? { level: ibMid,             name: 'IB MID', why: 'IB midpoint support — buyers defending session structure.' } : null,
    ].filter(Boolean);

    const bestBullEntry = bullEntryLevels.find(e => e.level < price + 30) || bullEntryLevels[0];
    if (bestBullEntry) {
      entryPrice = bestBullEntry.level;
      entryZone  = `${bestBullEntry.name} ${fmtP(bestBullEntry.level)}`;
      whyEntry   = bestBullEntry.why;
      const dist = price - bestBullEntry.level;
      if (dist > 40)        { readiness = 'WAIT';        waitingFor = `Pullback to ${bestBullEntry.name} ${fmtP(bestBullEntry.level)}`; waitDistance = Math.round(dist); }
      else if (dist > 10)   { readiness = 'APPROACHING'; waitDistance = Math.round(dist); }
      else if (dist > -25)  { readiness = 'IN_ZONE'; }
      else                  { readiness = 'IN_MOTION'; }
    }

    const bullCandidates = [
      orMid  && price < orMid  - 5 ? { n: 'OR MID',  p: orMid              } : null,
      orHigh && price < orHigh - 5 ? { n: 'OR High', p: Math.round(orHigh) } : null,
      vwap   && price < vwap   - 5 ? { n: 'VWAP',    p: Math.round(vwap)  } : null,
      ibH    && price < ibH    - 5 ? { n: 'IB High', p: Math.round(ibH)   } : null,
    ].filter(Boolean).sort((a, b) => a.p - b.p);
    if (bullCandidates[0]) t1 = bullCandidates[0];
    if (bullCandidates[1]) t2 = bullCandidates[1];
    if (bullCandidates[2]) t3 = bullCandidates[2];

    const entryRef = entryPrice || price;
    stop = `${fmtP(Math.round(entryRef - 22))} (-22pt below entry)`;

    situation = readiness === 'WAIT'
      ? `Bullish bias is clear — but don't chase. Wait for pullback to ${entryZone} (${waitDistance}pt away). Buying from here gives up your edge.`
      : readiness === 'APPROACHING'
      ? `Price pulling back toward ${entryZone} — get ready. Your zone is close.`
      : readiness === 'IN_ZONE'
      ? `Price AT ${entryZone} — this is your entry. Stats support the long here.`
      : `Price moving up from ${entryZone}. Bullish momentum trade in progress.`;

    if (shortDiv) watches.push('Delta diverging (sellers stepping in) — reduce size, wait for delta to re-confirm.');
    else watches.push(`Delta ${deltaTrend || '—'} — ${bullConf ? 'aligned with long, confirming' : 'watch for flip to SELLING as exit signal'}`);

    if (aDown)  invalidations.push(`A Down fires ${fmtP(Math.round(aDown))} — bias flips bearish, go flat`);
    if (orMid)  invalidations.push(`Loss of OR MID ${fmtP(orMid)} on selling delta — exit long`);

  // ── NEUTRAL ───────────────────────────────────────────────────────────
  } else {
    reasons.push('No A/C signal yet — market hasn\'t declared a direction');
    if (poc) reasons.push(`POC ${fmtP(Math.round(poc))} is current fair value`);
    readiness = 'WAIT';
    waitingFor = 'A Up or A Down to fire and confirm direction';
    situation = 'No trade. Market hasn\'t shown its hand yet. Sit on your hands until A signal fires or price reaches an extreme (50pt+ from VWAP).';
    if (vwap) entryZone = `VWAP ±50pt extreme fade`;
    if (poc)  t1 = { n: 'POC', p: Math.round(poc) };
    watches.push('Watch for A Up or A Down to fire — that\'s your trigger to build a bias');
    watches.push('Watch delta for first decisive shift (BUYING or SELLING confirms direction)');
  }

  return {
    bias, confidence, situation, reasons, watches, invalidations,
    entryZone, whyEntry, readiness, waitingFor, waitDistance,
    t1, t2, t3, stop,
    permConds, longDiv, shortDiv, deltaTrend, microTrend, sessionChar,
    price, orMid, vwap, aDown, aUp, ibL, ibH, ibMid,
  };
}

export default function LivePlaybookCard({ date }) {
  const isViewActive = useViewActive();
  // Shared with ACDView.jsx's own /acd/today fetch — was 2 independent
  // fetchers of the same endpoint (this card's 30s poll, ACDView's one-off
  // mount fetch), found 2026-07-15. refreshSharedPollData replaces the old
  // direct-fetch socket handlers so the instant-refresh-on-event behavior
  // still works, just against the shared cache entry instead of its own.
  const acdUrl = `${API_URL}/acd/today`;
  const [acd] = useSharedPollData(isViewActive ? acdUrl : null, 30000);
  // Shared with PermSlipAndStackBar/OvernightContextStrip/EdgeSectionsPanel — was 4
  // independent fetches of the same endpoint on every Morning Prep load, 2026-07-15.
  const [edges] = useSharedPollData(isViewActive ? `${API_URL}/antigravity/edges-context` : null, 30000);
  const [aiResponse,   setAiResponse]   = useState(null);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [aiError,      setAiError]      = useState(null);
  const [aiMeta,       setAiMeta]       = useState(null);
  const [conversations,setConversations]= useState([]);
  const [showHistory,  setShowHistory]  = useState(false);
  const [monthlyCost,  setMonthlyCost]  = useState(null);
  const [tapeContext,  setTapeContext]  = useState('');      // free-text tape read from user

  const todayDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // live-session-context was an independent fetch here too — found alongside 5
  // other components doing the exact same thing (2026-07-15). Deduped onto the
  // shared subscription hook; ctx now derives from it directly instead of its own
  // state, so it no longer needs to be part of loadCtx's socket/interval refresh.
  const [liveCtxShared] = useSharedPollData(isViewActive ? `${API_URL}/morning-brief/live-session-context/${todayDate}` : null, 30000);
  const ctx = liveCtxShared?.noData ? null : liveCtxShared;

  const loadConversations = () => {
    fetch(`${API_URL}/playbook/conversations/${todayDate}`)
      .then(r => r.json()).then(rows => {
        if (Array.isArray(rows)) {
          setConversations(rows.reverse()); // newest first
          if (rows.length > 0) {
            const last = rows[0];
            setAiResponse(last.ai_response);
            setAiMeta({ cost_usd: last.cost_usd != null ? parseFloat(last.cost_usd) : null, conversation_id: last.id, readAt: last.triggered_at });
          }
        }
      }).catch(() => {});
    fetch(`${API_URL}/playbook/cost-summary`)
      .then(r => r.json()).then(d => setMonthlyCost(d.month_total_usd != null ? parseFloat(d.month_total_usd) : null)).catch(() => {});
  };

  useEffect(() => {
    loadConversations();
  }, [date]);

  useEffect(() => {
    if (!isViewActive) return;
    const etH = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
    if (etH < 8 || etH >= 17) return;
    // acd (above) already polls this url every 30s while subscribed — this
    // effect just wires the socket-driven instant refresh onto the same
    // shared cache entry instead of firing its own fetch.
    const refresh = () => refreshSharedPollData(acdUrl);
    const sock = window._tradingSocket;
    if (sock) { sock.on('price-sync-progress', refresh); sock.on('setup-detected', refresh); }
    return () => {
      if (sock) { sock.off('price-sync-progress', refresh); sock.off('setup-detected', refresh); }
    };
  }, [date, isViewActive]);

  const triggerAssess = async (intent) => {
    setAiLoading(true);
    setAiError(null);
    try {
      const r = await fetch(`${API_URL}/playbook/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, date: todayDate, tape_context: tapeContext.trim() || null }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setAiResponse(data.response);
      setAiMeta({ cost_usd: data.cost_usd != null ? parseFloat(data.cost_usd) : null, conversation_id: data.conversation_id, readAt: new Date().toISOString() });
      setMonthlyCost(data.monthly_total_usd != null ? parseFloat(data.monthly_total_usd) : null);
      loadConversations();
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const p = computePlaybook(ctx, acd, edges);

  const intentColors = { LONG: '#4ade80', SHORT: '#f87171', UNSURE: '#94a3b8' };

  // Always render — even without computed playbook, the buttons should show
  const biasColorFallback = '#94a3b8';
  const biasBgFallback    = 'rgba(15,23,42,0.4)';
  const biasBorderFallback = 'rgba(51,65,85,0.3)';

  if (!p && !aiResponse) return (
    <div style={{ padding: '8px 12px', background: biasBgFallback, border: `1px solid ${biasBorderFallback}`, borderRadius: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Live Playbook · Ask Claude</div>
      <IntentButtons onTrigger={triggerAssess} loading={aiLoading} />
      <textarea value={tapeContext} onChange={e => setTapeContext(e.target.value)} placeholder="What's the tape doing? (optional)" rows={2} style={{ display:'block', width:'100%', marginTop:6, padding:'5px 8px', background:'rgba(15,23,42,0.6)', border:'1px solid rgba(51,65,85,0.5)', borderRadius:4, color:'#94a3b8', fontSize:11, resize:'vertical', outline:'none', boxSizing:'border-box', fontFamily:'inherit' }} />
      {aiError && <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{aiError}</div>}
      <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>Waiting for session data…</div>
    </div>
  );

  // If we have an AI response but session data hasn't loaded yet, render AI-only layout
  if (!p) {
    return (
      <div style={{ padding: '10px 12px', background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(51,65,85,0.3)', borderRadius: 6, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Live Playbook · Ask Claude</span>
          {monthlyCost != null && <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>${monthlyCost.toFixed(3)}/mo</span>}
        </div>
        <IntentButtons onTrigger={triggerAssess} loading={aiLoading} />
        {aiError && <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{aiError}</div>}
        {aiResponse && (
          <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.7)', border: '1px solid rgba(56,189,248,0.25)', borderLeft: '3px solid #38bdf8', borderRadius: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Claude's Read</span>
              {aiMeta?.cost_usd && <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>${parseFloat(aiMeta.cost_usd).toFixed(4)}</span>}
            </div>
            <div style={{ fontSize: 12, color: '#e2e8f0', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{aiResponse}</div>
          </div>
        )}
      </div>
    );
  }

  const biasColor  = p.bias === 'BEARISH' ? '#f87171' : p.bias === 'BULLISH' ? '#4ade80' : '#94a3b8';
  const biasBg     = p.bias === 'BEARISH' ? 'rgba(248,113,113,0.05)' : p.bias === 'BULLISH' ? 'rgba(74,222,128,0.05)' : 'rgba(15,23,42,0.4)';
  const biasBorder = p.bias === 'BEARISH' ? 'rgba(248,113,113,0.3)'  : p.bias === 'BULLISH' ? 'rgba(74,222,128,0.3)'  : 'rgba(51,65,85,0.3)';
  const alertColor = p.longDiv ? '#4ade80' : p.shortDiv ? '#f87171' : null;

  const readinessCfg = {
    WAIT:        { label: 'WAIT',        color: '#64748b', bg: 'rgba(100,116,139,0.12)', desc: `Waiting for ${p.waitingFor}` },
    APPROACHING: { label: 'APPROACHING', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  desc: `${p.waitDistance}pt to entry zone — get ready` },
    IN_ZONE:     { label: 'IN ZONE',     color: '#4ade80', bg: 'rgba(74,222,128,0.12)', desc: 'At entry — stats are on your side right now' },
    IN_MOTION:   { label: 'IN MOTION',   color: '#38bdf8', bg: 'rgba(56,189,248,0.1)',  desc: 'Momentum trade underway — ride to targets' },
  }[p.readiness] || { label: '—', color: '#64748b', bg: 'transparent', desc: '' };

  return (
    <div style={{ background: biasBg, border: `1px solid ${biasBorder}`, borderLeft: `3px solid ${biasColor}`, borderRadius: 6, padding: '10px 12px', fontSize: 12 }}>

      {/* Header — tiny, just label + cost */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Live Playbook</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {monthlyCost != null && (
            <span style={{ fontSize: 10, color: '#334155', fontFamily: 'monospace' }}>${monthlyCost.toFixed(3)}/mo</span>
          )}
          {p && <span style={{ fontSize: 11, fontWeight: 800, color: readinessCfg.color, background: readinessCfg.bg, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.06em' }}>
            {readinessCfg.label}
          </span>}
        </div>
      </div>

      {/* ── ASK CLAUDE BUTTONS — primary action, always at the top ── */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
          {aiResponse ? 'Ask again ↓' : 'What are you thinking?'}
        </div>
        <IntentButtons onTrigger={triggerAssess} loading={aiLoading} />
        {/* Tape read — what's price doing right now */}
        <textarea
          value={tapeContext}
          onChange={e => setTapeContext(e.target.value)}
          placeholder="What's the tape doing? (optional — e.g. 'price bounced from OR Low, stalling at mid-range, delta turning positive')"
          rows={2}
          style={{
            display: 'block', width: '100%', marginTop: 6, padding: '5px 8px',
            background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(51,65,85,0.5)',
            borderRadius: 4, color: '#94a3b8', fontSize: 11, lineHeight: 1.4,
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
        {aiLoading && <div style={{ fontSize: 11, color: '#38bdf8', marginTop: 6 }}>Asking Claude…</div>}
        {aiError && <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{aiError}</div>}
      </div>

      {/* ── AI RESPONSE (manual trigger result) ── */}
      {aiResponse && (
        <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(15,23,42,0.7)', border: '1px solid rgba(56,189,248,0.25)', borderLeft: '3px solid #38bdf8', borderRadius: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Claude's Read</span>
              {aiMeta?.readAt && (
                <span style={{ fontSize: 11, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {new Date(aiMeta.readAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).replace(',', '')}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {aiMeta?.cost_usd && <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>${parseFloat(aiMeta.cost_usd).toFixed(4)}</span>}
              {conversations.length > 1 && (
                <button onClick={() => setShowHistory(h => !h)} style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                  {showHistory ? 'hide' : `+${conversations.length - 1} earlier`}
                </button>
              )}
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#f1f5f9', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{aiResponse}</div>
        </div>
      )}

      {/* ── CONVERSATION HISTORY ── */}
      {showHistory && conversations.length > 1 && (
        <div style={{ marginTop: 6 }}>
          {conversations.slice(1).map((c, i) => (
            <div key={c.id} style={{ marginBottom: 6, padding: '6px 8px', background: 'rgba(15,23,42,0.4)', borderRadius: 4, border: '1px solid rgba(51,65,85,0.3)' }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: intentColors[c.intent] || '#94a3b8' }}>{c.intent}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>{new Date(c.triggered_at).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'})}</span>
              </div>
              <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.55 }}>{c.ai_response.slice(0, 200)}…</div>
            </div>
          ))}
        </div>
      )}

      {/* ── DIVIDER before computed quick read ── */}
      {p && aiResponse && (
        <div style={{ margin: '10px 0 6px', borderTop: '1px solid rgba(51,65,85,0.2)', paddingTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Auto read · {p.bias} {p.confidence}%</span>
        </div>
      )}

      {/* ── COMPUTED QUICK READ ── */}
      {p && (
      <div style={{ opacity: aiResponse ? 0.45 : 1 }}>

      {/* Readiness context line */}
      <div style={{ fontSize: 12, color: readinessCfg.color, marginBottom: 6, fontWeight: p.readiness === 'IN_ZONE' ? 700 : 400 }}>
        {readinessCfg.desc}
      </div>

      {/* Situation — the plain-language read */}
      <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.55, marginBottom: 6 }}>{p.situation}</div>

      {/* Divergence override */}
      {alertColor && (
        <div style={{ padding: '4px 8px', marginBottom: 6, background: `${alertColor}12`, border: `1px solid ${alertColor}40`, borderRadius: 4, fontSize: 11, color: alertColor, fontWeight: 700 }}>
          ⚡ Delta diverging — {p.longDiv ? 'sellers exhausting, watch for reversal' : 'buyers fading, watch for reversal'}
        </div>
      )}

      {/* Why */}
      <div style={{ marginBottom: 8 }}>
        {p.reasons.map((r, i) => (
          <div key={i} style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'flex-start', gap: 5, marginBottom: 2 }}>
            <span style={{ color: biasColor, flexShrink: 0 }}>▸</span>{r}
          </div>
        ))}
      </div>

      {/* Execution box — only full when IN_ZONE or IN_MOTION */}
      {p.entryZone && (
        <div style={{ background: 'rgba(15,23,42,0.6)', borderRadius: 4, padding: '7px 10px', marginBottom: 8, border: `1px solid ${p.readiness === 'IN_ZONE' ? 'rgba(74,222,128,0.35)' : 'rgba(51,65,85,0.3)'}` }}>
          <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Execution</div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>
            Entry: <span style={{ color: p.readiness === 'IN_ZONE' ? '#4ade80' : '#e2e8f0', fontWeight: 700 }}>{p.entryZone}</span>
          </div>
          {p.whyEntry && (
            <div style={{ fontSize: 11, color: '#475569', marginBottom: 5, fontStyle: 'italic', lineHeight: 1.4 }}>{p.whyEntry}</div>
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
            {p.t1 && <span style={{ fontSize: 12 }}>T1: <strong style={{ color: '#4ade80', fontFamily: 'monospace' }}>{fmtP(p.t1.p)}</strong> <span style={{ color: '#475569', fontSize: 11 }}>{p.t1.n}</span></span>}
            {p.t2 && <span style={{ fontSize: 12 }}>T2: <strong style={{ color: '#4ade80', fontFamily: 'monospace' }}>{fmtP(p.t2.p)}</strong> <span style={{ color: '#475569', fontSize: 11 }}>{p.t2.n}</span></span>}
            {p.t3 && <span style={{ fontSize: 12 }}>T3: <strong style={{ color: '#86efac', fontFamily: 'monospace' }}>{fmtP(p.t3.p)}</strong> <span style={{ color: '#475569', fontSize: 11 }}>{p.t3.n}</span></span>}
          </div>
          {p.stop && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>Stop: <span style={{ color: '#f87171', fontWeight: 700, fontFamily: 'monospace' }}>{p.stop}</span></div>
          )}
        </div>
      )}

      {/* Watch */}
      {p.watches.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Watch</div>
          {p.watches.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 5, marginBottom: 2 }}>
              <span style={{ color: '#fbbf24', flexShrink: 0 }}>⚠</span>{w}
            </div>
          ))}
        </div>
      )}

      {/* Invalidation */}
      {p.invalidations.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Exit / Flip If</div>
          {p.invalidations.map((inv, i) => (
            <div key={i} style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 5, marginBottom: 2 }}>
              <span style={{ color: '#ef4444', flexShrink: 0 }}>✕</span>{inv}
            </div>
          ))}
        </div>
      )}
      </div>
      )}
    </div>
  );
}

function IntentButtons({ onTrigger, loading }) {
  const btns = [
    { intent: 'LONG',   label: 'LONG',      color: '#4ade80', border: 'rgba(74,222,128,0.4)',  bg: 'rgba(74,222,128,0.1)'  },
    { intent: 'SHORT',  label: 'SHORT',     color: '#f87171', border: 'rgba(248,113,113,0.4)', bg: 'rgba(248,113,113,0.1)' },
    { intent: 'UNSURE', label: 'NOT SURE',  color: '#94a3b8', border: 'rgba(148,163,184,0.3)', bg: 'rgba(148,163,184,0.06)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {btns.map(b => (
        <button
          key={b.intent}
          onClick={() => onTrigger(b.intent)}
          disabled={loading}
          style={{
            padding: '9px 4px',
            background: loading ? 'rgba(15,23,42,0.2)' : b.bg,
            border: `1px solid ${loading ? 'rgba(51,65,85,0.2)' : b.border}`,
            borderRadius: 5,
            color: loading ? '#334155' : b.color,
            fontSize: 12,
            fontWeight: 800,
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {loading ? '…' : b.label}
        </button>
      ))}
    </div>
  );
}
