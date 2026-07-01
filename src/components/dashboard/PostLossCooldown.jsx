import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

const API_URL = '/api';

// Single source of truth for the cooldown duration label shown to the user.
// The actual countdown is driven by the server-stored end_time (server/routes/cooldown.js
// COOLDOWN_MINUTES) so this stays in sync as long as both are kept equal.
const COOLDOWN_MINUTES = 15;

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function PostLossCooldown() {
  // null = no cooldown / unknown yet, 'active' = counting down, 'awaiting' = finished, needs dismissal
  const [phase, setPhase] = useState(null);
  const [cooldownId, setCooldownId] = useState(null);
  const [endTime, setEndTime] = useState(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [decisionStats, setDecisionStats] = useState(null);
  const tickRef = useRef(null);

  const applyStatus = useCallback((data) => {
    if (data.active) {
      setPhase('active');
      setCooldownId(data.id);
      setEndTime(data.endTime);
      setRemainingMs(data.remainingMs);
    } else if (data.awaitingDismissal) {
      setPhase('awaiting');
      setCooldownId(data.id);
      setEndTime(data.endTime);
      setRemainingMs(0);
    } else {
      setPhase(null);
      setCooldownId(null);
      setEndTime(null);
      setRemainingMs(0);
    }
  }, []);

  // On mount: check for an in-progress cooldown so a page refresh resumes the countdown
  useEffect(() => {
    fetch(`${API_URL}/cooldown/status`)
      .then(r => r.json())
      .then(applyStatus)
      .catch(() => {});
  }, [applyStatus]);

  // Load all-time behavioral stats for the decision panel — fetched once, never date-filtered
  useEffect(() => {
    fetch(`${API_URL}/cooldown/decision-stats`)
      .then(r => r.json())
      .then(d => !d.error && setDecisionStats(d))
      .catch(() => {});
  }, []);

  // Local 1-second tick while active, computed from the persisted end_time —
  // immune to refresh because it's re-derived from the server timestamp, not local state
  useEffect(() => {
    if (phase !== 'active' || !endTime) {
      if (tickRef.current) clearInterval(tickRef.current);
      return;
    }
    const tick = () => {
      const remaining = new Date(endTime).getTime() - Date.now();
      if (remaining <= 0) {
        setPhase('awaiting');
        setRemainingMs(0);
        if (tickRef.current) clearInterval(tickRef.current);
      } else {
        setRemainingMs(remaining);
      }
    };
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [phase, endTime]);

  const startCooldown = useCallback(() => {
    fetch(`${API_URL}/cooldown/start`, { method: 'POST' })
      .then(r => r.json())
      .then(applyStatus)
      .catch(() => {});
  }, [applyStatus]);

  const dismiss = useCallback(() => {
    if (!cooldownId) return;
    fetch(`${API_URL}/cooldown/${cooldownId}/dismiss`, { method: 'POST' })
      .then(() => {
        setPhase(null);
        setCooldownId(null);
        setEndTime(null);
        setRemainingMs(0);
      })
      .catch(() => {});
  }, [cooldownId]);

  // Decision intel block — quiet facts that surface at the moment of temptation.
  // Only shown when the cooldown button is visible (phase null or awaiting).
  // The stats are all-time structural truths, not recent-period metrics.
  const DecisionIntel = () => {
    if (!decisionStats) return null;
    const ds = decisionStats;
    const hasSeqStats = ds.afterLossWinPct != null && ds.afterWinWinPct != null;
    const hasWhileDown = ds.continueWhileDownPctWorse != null;
    return (
      <div style={intelWrapStyle}>
        {hasSeqStats && (
          <div style={intelLineStyle}>
            After a loss: <span style={{ color: '#f87171', fontWeight: 600 }}>{ds.afterLossWinPct}%</span> win rate
            {' '}vs <span style={{ color: '#4ade80', fontWeight: 600 }}>{ds.afterWinWinPct}%</span> after a win
          </div>
        )}
        {hasWhileDown && (
          <div style={intelLineStyle}>
            Continue while down: ends deeper{' '}
            <span style={{ color: '#f87171', fontWeight: 600 }}>{ds.continueWhileDownPctWorse}%</span>
            {ds.continueWhileDownAvgLoss != null && ds.continueWhileDownAvgLoss < 0
              ? ` of the time (avg $${Math.abs(ds.continueWhileDownAvgLoss).toLocaleString()} extra)`
              : ' of the time'}
          </div>
        )}
        <div style={{ ...intelLineStyle, opacity: 0.7 }}>
          15-min cooldown ≈ <span style={{ color: '#a78bfa' }}>+$225K</span> vs your actual history
          <span style={{ display: 'block', fontSize: 12, color: '#64748b', marginTop: 1 }}>
            from 2026 session-replay backtest
          </span>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* The active countdown must be unmissable regardless of which tab/panel
          is showing — portal it to document.body as a fixed, full-width banner
          rather than confining it to the (narrower) sidebar. */}
      {phase === 'active' && createPortal(
        <div style={bannerStyle}>
          <span style={{ fontSize: '1.3em', letterSpacing: '0.05em' }}>
            ⛔ COOLDOWN — {formatRemaining(remainingMs)} remaining — DO NOT TRADE
          </span>
        </div>,
        document.body
      )}

      {phase === 'awaiting' && (
        <>
          <div style={inlinePromptStyle}>
            <div style={{ marginBottom: 10 }}>
              Cooldown complete. Is this a real setup, or are you still making it back?
            </div>
            <button style={dismissBtnStyle} onClick={dismiss}>I've checked myself — dismiss</button>
          </div>
          <DecisionIntel />
        </>
      )}

      {phase === null && (
        <>
          <div style={triggerWrapStyle}>
            <button style={triggerBtnStyle} onClick={startCooldown}>
              Took a loss — start {COOLDOWN_MINUTES}-minute cooldown
            </button>
          </div>
          <DecisionIntel />
        </>
      )}
    </>
  );
}

const bannerStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '20px',
  width: '100%',
  padding: '18px 24px',
  background: '#ff4d4f',
  color: '#fff',
  fontWeight: 700,
  textAlign: 'center',
  boxShadow: '0 2px 16px rgba(255, 77, 79, 0.7)',
};

const inlinePromptStyle = {
  border: '1px solid rgba(245,158,11,0.45)',
  background: 'rgba(245,158,11,0.10)',
  borderRadius: '8px',
  padding: '12px',
  marginBottom: 8,
  fontSize: 13,
  fontWeight: 600,
  color: '#fbbf24',
  lineHeight: 1.4,
};

const dismissBtnStyle = {
  width: '100%',
  padding: '8px 12px',
  background: '#fbbf24',
  color: '#1e1b16',
  border: 'none',
  borderRadius: '4px',
  fontWeight: 700,
  fontSize: 12,
  cursor: 'pointer',
};

const triggerWrapStyle = {
  marginBottom: 8,
};

const triggerBtnStyle = {
  width: '100%',
  padding: '10px 14px',
  background: '#ff4d4f',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  fontWeight: 700,
  fontSize: 13,
  cursor: 'pointer',
  boxShadow: '0 0 0 1px rgba(255,77,79,0.4)',
};

// Decision intel — intentionally quiet so the button remains visually dominant.
// These are cold facts that surface at the moment the make-it-back reflex fires.
const intelWrapStyle = {
  marginBottom: 12,
  padding: '8px 10px',
  background: 'rgba(0,0,0,0.2)',
  borderRadius: 4,
  borderLeft: '2px solid rgba(100,116,139,0.35)',
};

const intelLineStyle = {
  fontSize: 12,
  color: '#94a3b8',
  lineHeight: 1.6,
};
