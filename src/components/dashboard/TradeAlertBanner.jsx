import React, { useState, useEffect, useCallback, useContext } from 'react';

import { API_URL } from '../../constants/api.js';
import { useSharedPollData } from '../../utils/useSharedPollData.js';
import { useViewActive } from '../../utils/useViewActive.js';
import { CaseContext } from '../shared/CaseContext.jsx';

// Parse direction + entry price out of an alert message
function parseAlertMsg(msg) {
  if (!msg) return {};
  const dirMatch  = msg.match(/\b(LONG|SHORT)\b/);
  const entryMatch = msg.match(/Entry\s*([\d.]+)/i);
  // Extract setup_type: between "WON: " or "FIRED: " and ": LONG" / ": SHORT"
  const typeMatch = msg.match(/(?:WON|FIRED|LOST|EXPIRED):\s*(.+?)\s*:\s*(?:LONG|SHORT)/i);
  return {
    direction:  dirMatch  ? dirMatch[1]       : null,
    entryPrice: entryMatch ? parseFloat(entryMatch[1]) : null,
    setupName:  typeMatch  ? typeMatch[1].trim() : null,
  };
}

// ── Quick-log modal ────────────────────────────────────────────────────────────
function QuickLogModal({ alerts, preDirection, prePrice, preSetups, onClose }) {
  const [direction, setDirection]   = useState(preDirection || null);
  const [price, setPrice]           = useState(prePrice ? String(prePrice) : '');
  const [outcome, setOutcome]       = useState(null);
  const [pnlPts, setPnlPts]         = useState('');
  const [note, setNote]             = useState('');
  const [selected, setSelected]     = useState(new Set(preSetups || []));
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);

  const toggleSetup = (name) =>
    setSelected(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const submit = async () => {
    if (!direction || !price) return;
    setSaving(true);
    try {
      await fetch(`${API_URL}/live-reads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          entryPrice: parseFloat(price),
          note: note || null,
          attributed_setups: selected.size ? [...selected] : null,
          outcome: outcome || null,
          pnl_pts: pnlPts ? parseFloat(pnlPts) : null,
        }),
      });
      setSaved(true);
      setTimeout(onClose, 700);
    } catch { setSaving(false); }
  };

  const C = { green: '#10b981', red: '#ef4444', amber: '#f59e0b', blue: '#6366f1', text: '#f1f5f9', dim: '#94a3b8', muted: '#64748b', border: 'rgba(255,255,255,0.08)' };

  const btnDir = (d) => ({
    flex: 1, padding: '10px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontWeight: 700, fontSize: 14, letterSpacing: '0.04em',
    background: direction === d ? (d === 'LONG' ? C.green : C.red) : 'rgba(255,255,255,0.07)',
    color: direction === d ? '#fff' : C.dim, transition: 'all 0.15s',
  });

  const btnOut = (o, color) => ({
    flex: 1, padding: '7px 0', borderRadius: 5, cursor: 'pointer',
    fontWeight: 700, fontSize: 12,
    background: outcome === o ? `${color}33` : 'rgba(255,255,255,0.05)',
    color: outcome === o ? color : C.muted, transition: 'all 0.15s',
    border: outcome === o ? `1px solid ${color}66` : '1px solid transparent',
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
        padding: 22, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Log Trade</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        {/* Direction */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button style={btnDir('LONG')}  onClick={() => setDirection('LONG')}>▲ LONG</button>
          <button style={btnDir('SHORT')} onClick={() => setDirection('SHORT')}>▼ SHORT</button>
        </div>

        {/* Entry price */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Entry Price</label>
          <input
            type="number" step="0.25" value={price} onChange={e => setPrice(e.target.value)}
            autoFocus
            style={{ width: '100%', padding: '7px 10px', borderRadius: 5, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: C.text, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
          />
        </div>

        {/* Attributed setups */}
        {alerts.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Triggered by (select all that apply)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {alerts.map(a => {
                const { setupName } = parseAlertMsg(a.msg);
                const label = setupName || a.type;
                const isOn  = selected.has(label);
                return (
                  <button key={a.id} onClick={() => toggleSetup(label)} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: isOn ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
                    color: isOn ? '#a5b4fc' : C.muted, transition: 'all 0.12s',
                  }}>
                    <span style={{ fontSize: 13, lineHeight: 1 }}>{isOn ? '☑' : '☐'}</span>
                    <span style={{ fontSize: 12, fontWeight: isOn ? 700 : 400 }}>{label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: C.muted }}>{a.color === '#4ade80' ? '✓ WON' : a.color === '#ef4444' ? '✗ LOST' : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Outcome */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Outcome</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={btnOut('WIN',    C.green)} onClick={() => setOutcome('WIN')}>WIN</button>
            <button style={btnOut('LOSS',   C.red)}   onClick={() => setOutcome('LOSS')}>LOSS</button>
            <button style={btnOut('SCRATCH',C.amber)} onClick={() => setOutcome('SCRATCH')}>SCRATCH</button>
            <button style={btnOut('OPEN',   C.muted)} onClick={() => setOutcome('OPEN')}>OPEN</button>
          </div>
        </div>

        {/* P&L pts */}
        {(outcome === 'WIN' || outcome === 'LOSS') && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Points {outcome === 'LOSS' ? 'lost' : 'gained'}</label>
            <input
              type="number" step="0.25" value={pnlPts} onChange={e => setPnlPts(e.target.value)}
              placeholder="e.g. 45"
              style={{ width: '100%', padding: '7px 10px', borderRadius: 5, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: C.text, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
            />
          </div>
        )}

        {/* Note */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: C.dim, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Note (optional)</label>
          <textarea
            value={note} onChange={e => setNote(e.target.value)}
            placeholder="what you saw, why you took it…"
            rows={2}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 5, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: C.text, fontSize: 12, resize: 'none', boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit' }}
          />
        </div>

        <button
          onClick={submit}
          disabled={!direction || !price || saving}
          style={{
            width: '100%', padding: '11px 0', borderRadius: 8, border: 'none',
            background: saved ? C.green : (!direction || !price) ? 'rgba(255,255,255,0.05)' : C.blue,
            color: (!direction || !price) ? C.muted : '#fff',
            fontWeight: 700, fontSize: 14, cursor: (!direction || !price) ? 'default' : 'pointer',
            transition: 'background 0.2s',
          }}
        >
          {saved ? '✓ Logged' : saving ? 'Saving…' : 'Log Trade'}
        </button>
      </div>
    </div>
  );
}

// ── Main banner component ──────────────────────────────────────────────────────
export default function TradeAlertBanner() {
  const isViewActive = useViewActive();
  const [alerts, setAlerts]       = useState([]);
  const [dismissed, setDismissed] = useState(new Set());
  const [apiErrors, setApiErrors] = useState([]);
  const [logModal, setLogModal]   = useState(null); // { direction, price, preSetups }

  // Setup-detection and live-session-context health checks reuse the same
  // shared cache entries MarketPulseBar/SessionPulseCard/etc. already poll,
  // instead of firing their own independent fetches every 15s (found
  // 2026-07-15 — the ?date= param the old setup-detection check used has no
  // effect server-side, so it's safe to share the plain-URL cache entry).
  const todayDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [, setupErr]   = useSharedPollData(isViewActive ? `${API_URL}/acd/setup-detection` : null, 15000);
  const [, liveCtxErr] = useSharedPollData(isViewActive ? `${API_URL}/morning-brief/live-session-context/${todayDateStr}` : null, 30000);
  // Case-engine health check reuses CaseProvider's own always-on poll (App.jsx
  // wraps the whole app in it) instead of a separate fixed-asOf=09:30 fetch —
  // same dedup pass, found 2026-07-15.
  const { error: caseErr } = useContext(CaseContext);

  const fetchAlerts = useCallback(() => {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const errors = [];

    // Trade-alerts response is reused for both the alerts list itself and its
    // own health-check entry — this used to be two separate fetches of the
    // same URL every 15s (see docs/OPEN_THREADS.md, dedup pass 2026-07-15).
    const tradeAlertsPromise = fetch(`${API_URL}/morning-brief/trade-alerts/${d}`)
      .then(r => r.json())
      .then(data => {
        if (data.error && !data.noData && !data.isWeekend) errors.push(`Trade alerts: ${data.error}`);
        const activeIds = new Set((data.alerts || []).map(a => a.id));
        setAlerts(prev => {
          const updated = [...prev];
          for (const a of (data.alerts || [])) {
            const existing = updated.findIndex(x => x.id === a.id);
            if (existing >= 0) {
              updated[existing] = { ...a, expired: false };
            } else {
              updated.push({ ...a, expired: false });
            }
          }
          for (const a of updated) {
            if (!activeIds.has(a.id) && !a.expired && !a.dismissed) {
              a.expired = true;
              a.expiredAt = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
            }
          }
          return updated;
        });
      })
      .catch(() => errors.push('Trade alerts: unreachable'));

    tradeAlertsPromise.then(() => setApiErrors(errors));
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 15000);
    const sock = window._tradingSocket;
    if (sock) {
      sock.on('price-sync-progress', fetchAlerts);
      sock.on('setup-detected', fetchAlerts);
      sock.on('setup-state', fetchAlerts);
    }
    return () => {
      clearInterval(interval);
      if (sock) {
        sock.off('price-sync-progress', fetchAlerts);
        sock.off('setup-detected', fetchAlerts);
        sock.off('setup-state', fetchAlerts);
      }
    };
  }, [fetchAlerts]);

  const dismiss = (id) => setDismissed(prev => new Set([...prev, id]));

  const openLog = (alert) => {
    const { direction, entryPrice, setupName } = parseAlertMsg(alert.msg);
    const preSetups = setupName ? [setupName] : [];
    setLogModal({ direction, price: entryPrice, preSetups });
  };

  const visible = alerts.filter(a => !dismissed.has(a.id) && !a.expired);
  const allApiErrors = [
    ...apiErrors,
    ...(setupErr ? [`Setup detection: ${setupErr}`] : []),
    ...(liveCtxErr ? [`Live session: ${liveCtxErr}`] : []),
    ...(caseErr ? [`Case engine: ${caseErr}`] : []),
  ];
  if (visible.length === 0 && allApiErrors.length === 0) return null;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {allApiErrors.map((err, i) => (
          <div key={`err-${i}`} style={{
            padding: '8px 12px', background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.4)', borderLeft: '4px solid #ef4444',
            borderRadius: 6, fontSize: 12, color: '#fca5a5', fontWeight: 600,
          }}>
            SYSTEM ERROR: {err}
          </div>
        ))}
        {visible.map(a => (
          <div key={a.id} style={{
            padding: '8px 12px',
            background: a.expired ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.4)',
            borderTop:    `1px solid ${a.expired ? '#64748b40' : a.color + '40'}`,
            borderRight:  `1px solid ${a.expired ? '#64748b40' : a.color + '40'}`,
            borderBottom: `1px solid ${a.expired ? '#64748b40' : a.color + '40'}`,
            borderLeft:   `4px solid ${a.expired ? '#ef4444' : a.color}`,
            opacity: a.expired ? 0.7 : 1,
            borderRadius: 6,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            animation: 'fadeIn 0.3s ease-in',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, color: a.color,
                  background: `${a.color}20`, padding: '1px 6px', borderRadius: 3,
                  textTransform: 'uppercase', letterSpacing: '0.04em'
                }}>
                  {a.type.replace(/_/g, ' ')}
                </span>
                <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {a.time}
                  {a.expired && <span style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', background: 'rgba(239,68,68,0.15)', padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>EXPIRED {a.expiredAt}</span>}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 600 }}>
                {a.msg}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 10, flexShrink: 0 }}>
              <button
                onClick={() => openLog(a)}
                style={{
                  padding: '4px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                  background: 'rgba(99,102,241,0.2)', color: '#a5b4fc',
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                }}
                title="Log that you took this trade"
              >
                ✓ Took It
              </button>
              <button
                onClick={() => dismiss(a.id)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
                title="Dismiss"
              >✕</button>
            </div>
          </div>
        ))}
      </div>

      {logModal && (
        <QuickLogModal
          alerts={visible}
          preDirection={logModal.direction}
          prePrice={logModal.price}
          preSetups={logModal.preSetups}
          onClose={() => setLogModal(null)}
        />
      )}
    </>
  );
}
