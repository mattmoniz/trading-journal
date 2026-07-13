// Extracted from ACDView.jsx (2026-07-13) so ACDView's default export can be lazy-loaded.
// Both used unconditionally in the always-visible Sidebar (App.jsx) — they must stay eager,
// which meant the whole ACDView module (4700+ lines) was forced eager too as long as they
// lived in the same file, defeating any lazy() wrapper on ACDView's default export.
import React from 'react';

const API_URL = '/api';

function TradeLogRow({ log, onUpdate }) {
  const [mode, setMode] = React.useState(null); // 'close' | 'note' | 'edit'
  const [pnlVal, setPnlVal] = React.useState('');
  const [noteVal, setNoteVal] = React.useState(log.note || '');
  const [editPnl, setEditPnl] = React.useState(log.pnl != null ? String(log.pnl) : '');

  const closeTrade = async () => {
    if (!pnlVal) return;
    await fetch(`${API_URL}/acd/feedback/${log.id}/close`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pnl: parseFloat(pnlVal), note: noteVal || null }) }).catch(() => {});
    setMode(null); if (onUpdate) onUpdate();
  };
  const saveNote = async () => {
    await fetch(`${API_URL}/acd/feedback/${log.id}/close`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: noteVal, pnl: log.pnl != null ? log.pnl : null }) }).catch(() => {});
    setMode(null); if (onUpdate) onUpdate();
  };
  const saveEdit = async () => {
    await fetch(`${API_URL}/acd/feedback/${log.id}/close`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pnl: editPnl ? parseFloat(editPnl) : log.pnl, note: noteVal || log.note }) }).catch(() => {});
    setMode(null); if (onUpdate) onUpdate();
  };

  const linkSt = { color: '#a5b4fc', cursor: 'pointer', textDecoration: 'underline', fontSize: 11, fontWeight: 600 };
  const inputSt = { padding: '4px 8px', borderRadius: 4, border: '1px solid #64748b', background: '#1e293b', color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' };
  const pnlColor = log.pnl >= 0 ? '#4ade80' : '#f87171';

  return (
    <div style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 6, background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(51,65,85,0.3)' }}>
      <div style={{ fontSize: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 11, color: log.action === 'TAKEN' ? '#4ade80' : '#fbbf24', background: log.action === 'TAKEN' ? 'rgba(74,222,128,0.1)' : 'rgba(251,191,36,0.1)', padding: '1px 8px', borderRadius: 4 }}>{log.action}</span>
        <span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 13 }}>{log.setup_type}</span>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>{(log.tags || []).join(', ')}</span>
        {log.pnl != null && <span style={{ color: pnlColor, fontFamily: 'monospace', fontWeight: 800, fontSize: 14 }}>${log.pnl}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {log.pnl == null && log.action === 'TAKEN' && mode !== 'close' && <span onClick={() => setMode('close')} style={linkSt}>close</span>}
          {mode === null && <span onClick={() => setMode('note')} style={linkSt}>note</span>}
          {mode === null && log.pnl != null && <span onClick={() => setMode('edit')} style={linkSt}>edit</span>}
          {mode === null && <span onClick={() => setMode('delete')} style={{ ...linkSt, color: '#f87171' }}>delete</span>}
        </span>
      </div>
      {log.note && mode !== 'note' && <div style={{ fontSize: 12, color: '#cbd5e1', fontStyle: 'italic', marginTop: 4, paddingLeft: 4, borderLeft: '2px solid #64748b', lineHeight: 1.4 }}>{log.note}</div>}
      {mode === 'close' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input type="number" value={pnlVal} onChange={e => setPnlVal(e.target.value)} placeholder="P&L e.g. -78" style={{ ...inputSt, width: 90 }} onKeyDown={e => e.key === 'Enter' && closeTrade()} autoFocus />
          <input value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="note (optional)" style={{ ...inputSt, width: 200 }} onKeyDown={e => e.key === 'Enter' && closeTrade()} />
          <span onClick={closeTrade} style={{ color: '#4ade80', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>save</span>
          <span onClick={() => setMode(null)} style={{ color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}>cancel</span>
        </div>
      )}
      {mode === 'note' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="e.g. should have waited for PW-Hi" style={{ ...inputSt, width: 320 }} onKeyDown={e => e.key === 'Enter' && saveNote()} autoFocus />
          <span onClick={saveNote} style={{ color: '#4ade80', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>save</span>
          <span onClick={() => setMode(null)} style={{ color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}>cancel</span>
        </div>
      )}
      {mode === 'edit' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>P&L:</span>
          <input type="number" value={editPnl} onChange={e => setEditPnl(e.target.value)} style={{ ...inputSt, width: 80 }} onKeyDown={e => e.key === 'Enter' && saveEdit()} autoFocus />
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Note:</span>
          <input value={noteVal} onChange={e => setNoteVal(e.target.value)} style={{ ...inputSt, width: 200 }} onKeyDown={e => e.key === 'Enter' && saveEdit()} />
          <span onClick={saveEdit} style={{ color: '#4ade80', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>save</span>
          <span onClick={() => setMode(null)} style={{ color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}>cancel</span>
        </div>
      )}
      {mode === 'delete' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <span style={{ fontSize: 12, color: '#f87171' }}>Delete this entry?</span>
          <span onClick={async () => { await fetch(`${API_URL}/acd/feedback/${log.id}`, { method: 'DELETE' }).catch(() => {}); if (onUpdate) onUpdate(); }} style={{ color: '#f87171', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>yes, delete</span>
          <span onClick={() => setMode(null)} style={{ color: '#94a3b8', cursor: 'pointer', fontSize: 11 }}>cancel</span>
        </div>
      )}
    </div>
  );
}

function QuickTradeLog() {
  const [open, setOpen] = React.useState(false);
  const [action, setAction] = React.useState(null);
  const [setupType, setSetupType] = React.useState('');
  const [customType, setCustomType] = React.useState('');
  const [direction, setDirection] = React.useState('LONG');
  const [tags, setTags] = React.useState([]);
  const [pnl, setPnl] = React.useState('');
  const [contracts, setContracts] = React.useState('1');
  const [submitted, setSubmitted] = React.useState(false);
  const [recentLogs, setRecentLogs] = React.useState([]);

  const SETUP_TYPES = ['IB_BEARISH', 'OPEN_DRIVE_LONG', 'OPEN_DRIVE_SHORT', 'VALUE_AREA_RESPONSIVE_LONG', 'VALUE_AREA_RESPONSIVE_SHORT', 'C_STANDALONE_DOWN', 'TRT_LONG', 'ABSORPTION_LONG', 'EMA_SNAPBACK_LONG', 'EMA_SNAPBACK_SHORT', 'COIL_SURGE_LONG', 'COIL_SURGE_SHORT'];
  const ALL_TAGS = ['absorption', 'level_confluence', 'momentum', 'volume', 'gut_read', 'no_confluence', 'momentum_wrong', 'too_extended', 'after_loss', 'choppy'];

  const loadRecent = () => {
    fetch(`${API_URL}/acd/feedback?days=1`).then(r => r.json()).then(d => setRecentLogs(d.feedback || [])).catch(() => {});
  };
  React.useEffect(() => { if (open) loadRecent(); }, [open]);

  const toggleTag = (t) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const submit = async () => {
    const type = setupType === 'CUSTOM' ? customType : setupType;
    if (!type || !action) return;
    try {
      const r = await fetch(`${API_URL}/acd/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupType: type, action, direction, tags, contracts: parseInt(contracts) || 1, entryPrice: null }),
      });
      const d = await r.json();
      if (d.feedback?.id && action === 'TAKEN' && pnl) {
        await fetch(`${API_URL}/acd/feedback/${d.feedback.id}/close`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pnl: parseFloat(pnl) }),
        });
      }
      setSubmitted(true);
      loadRecent();
      setTimeout(() => { setSubmitted(false); setAction(null); setSetupType(''); setCustomType(''); setTags([]); setPnl(''); setContracts('1'); setOpen(false); }, 1500);
    } catch {}
  };

  const chip = (active) => ({
    padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid',
    background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
    borderColor: active ? '#6366f1' : '#334155', color: active ? '#a5b4fc' : '#94a3b8',
  });

  const selStyle = { padding: '6px 10px', borderRadius: 4, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' };

  const sidebarButton = (
    <button
      onClick={() => setOpen(true)}
      style={{
        width: '100%',
        padding: '10px 14px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        border: '1px dashed rgba(99, 102, 241, 0.4)',
        background: 'rgba(99, 102, 241, 0.05)',
        color: '#a5b4fc',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(99, 102, 241, 0.12)';
        e.currentTarget.style.borderColor = '#6366f1';
        e.currentTarget.style.boxShadow = '0 0 10px rgba(99, 102, 241, 0.2)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'rgba(99, 102, 241, 0.05)';
        e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.4)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <span>➕</span>
      <span>Quick Trade Log</span>
    </button>
  );

  return (
    <>
      {sidebarButton}
      {open && (
        <div 
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(10, 10, 15, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div 
            style={{ 
              width: '90%', 
              maxWidth: '520px', 
              background: '#0b0f19', 
              border: '1px solid rgba(99, 102, 241, 0.35)', 
              borderRadius: 14,
              padding: 24, 
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
              position: 'relative'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#a5b4fc', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>⚡</span> Quick Trade Log
              </span>
              <button 
                onClick={() => setOpen(false)} 
                style={{ 
                  background: 'transparent', 
                  border: 'none', 
                  color: '#94a3b8', 
                  cursor: 'pointer', 
                  fontSize: 18,
                  padding: '4px 8px',
                  borderRadius: 4,
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={e => e.currentTarget.style.color = '#e2e8f0'}
                onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}
              >
                ✕
              </button>
            </div>

            {submitted ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '30px 0', textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(34, 197, 94, 0.15)', border: '2px solid #22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: '#22c55e' }}>✓</div>
                <div style={{ fontSize: 16, color: '#f8fafc', fontWeight: 700 }}>Trade Logged Successfully</div>
                <div style={{ fontSize: 13, color: '#94a3b8' }}>Updating feedback cache...</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={setupType} onChange={e => setSetupType(e.target.value)} style={selStyle}>
                    <option value="">Setup type...</option>
                    {SETUP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    <option value="CUSTOM">Custom...</option>
                  </select>
                  {setupType === 'CUSTOM' && (
                    <input value={customType} onChange={e => setCustomType(e.target.value)} placeholder="e.g. manual_absorption" style={{ ...selStyle, width: 160 }} />
                  )}
                  <select value={direction} onChange={e => setDirection(e.target.value)} style={selStyle}>
                    <option value="LONG">LONG</option>
                    <option value="SHORT">SHORT</option>
                  </select>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button 
                    onClick={() => setAction('TAKEN')} 
                    style={{ 
                      flex: 1, 
                      padding: '8px 16px', 
                      borderRadius: 6, 
                      fontSize: 12, 
                      fontWeight: 700, 
                      cursor: 'pointer', 
                      border: '1px solid ' + (action === 'TAKEN' ? '#22c55e' : '#334155'), 
                      background: action === 'TAKEN' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(15, 23, 42, 0.3)', 
                      color: action === 'TAKEN' ? '#4ade80' : '#94a3b8',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    Taking Trade
                  </button>
                  <button 
                    onClick={() => setAction('PASSED')} 
                    style={{ 
                      flex: 1, 
                      padding: '8px 16px', 
                      borderRadius: 6, 
                      fontSize: 12, 
                      fontWeight: 700, 
                      cursor: 'pointer', 
                      border: '1px solid ' + (action === 'PASSED' ? '#f59e0b' : '#334155'), 
                      background: action === 'PASSED' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(15, 23, 42, 0.3)', 
                      color: action === 'PASSED' ? '#fbbf24' : '#94a3b8',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    Passing Trade
                  </button>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tags / Confluences</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {ALL_TAGS.map(t => <span key={t} onClick={() => toggleTag(t)} style={chip(tags.includes(t))}>{t.replace(/_/g, ' ')}</span>)}
                  </div>
                </div>

                {action === 'TAKEN' && (
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', background: 'rgba(15, 23, 42, 0.4)', padding: '12px 16px', borderRadius: 8, border: '1px solid #1e293b' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>Contracts:</span>
                      <input type="number" value={contracts} onChange={e => setContracts(e.target.value)} style={{ ...selStyle, width: 50, padding: '5px' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>P&L ($):</span>
                      <input type="number" value={pnl} onChange={e => setPnl(e.target.value)} placeholder="Closed P&L" style={{ ...selStyle, width: 100, padding: '5px' }} onKeyDown={e => e.key === 'Enter' && submit()} />
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <button 
                    onClick={submit} 
                    disabled={!setupType || !action} 
                    style={{ 
                      flex: 2, 
                      padding: '10px 0', 
                      borderRadius: 6, 
                      fontSize: 13, 
                      fontWeight: 700, 
                      cursor: 'pointer', 
                      border: '1px solid #6366f1', 
                      background: 'rgba(99, 102, 241, 0.15)', 
                      color: '#a5b4fc',
                      opacity: !setupType || !action ? 0.4 : 1,
                      transition: 'all 0.15s ease'
                    }}
                    onMouseEnter={e => { if (setupType && action) e.currentTarget.style.background = 'rgba(99, 102, 241, 0.3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.15)'; }}
                  >
                    Confirm & Log
                  </button>
                  <button 
                    onClick={() => setOpen(false)} 
                    style={{ 
                      flex: 1, 
                      padding: '10px 0', 
                      borderRadius: 6, 
                      fontSize: 13, 
                      fontWeight: 700, 
                      cursor: 'pointer', 
                      border: '1px solid #334155', 
                      background: 'transparent', 
                      color: '#94a3b8' 
                    }}
                  >
                    Cancel
                  </button>
                </div>

                {recentLogs.length > 0 && (
                  <div style={{ borderTop: '1px solid #1e293b', paddingTop: 10, marginTop: 4 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Today's logs:</div>
                    <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {recentLogs.map(l => (
                        <TradeLogRow key={l.id} log={l} onUpdate={loadRecent} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TradeFeedbackBar({ setupCard }) {
  const [sent, setSent] = React.useState(null);
  const [tags, setTags] = React.useState([]);
  const [closing, setClosing] = React.useState(false);
  const [pnl, setPnl] = React.useState('');
  const [feedbackId, setFeedbackId] = React.useState(null);

  if (!setupCard?.type) return null;

  const TAKE_TAGS = ['absorption', 'level_confluence', 'momentum', 'volume', 'gut_read'];
  const PASS_TAGS = ['no_confluence', 'momentum_wrong', 'too_extended', 'after_loss', 'choppy'];
  const activeTags = sent === 'TAKEN' ? TAKE_TAGS : sent === 'PASSED' ? PASS_TAGS : [];

  const toggleTag = (t) => setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  const submit = async (action) => {
    setSent(action);
    try {
      const r = await fetch(`${API_URL}/acd/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupId: setupCard.setupId, setupType: setupCard.type, action, direction: setupCard.direction, tags, entryPrice: setupCard.entry, contracts: 1 }),
      });
      const d = await r.json();
      if (d.feedback?.id) setFeedbackId(d.feedback.id);
    } catch {}
  };

  const updateTags = async () => {
    if (!feedbackId) return;
    try {
      await fetch(`${API_URL}/acd/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupId: setupCard.setupId, setupType: setupCard.type, action: sent, direction: setupCard.direction, tags, entryPrice: setupCard.entry }),
      });
    } catch {}
  };
  React.useEffect(() => { if (feedbackId && tags.length > 0) updateTags(); }, [tags]);

  const closeTrade = async () => {
    if (!feedbackId || !pnl) return;
    try {
      await fetch(`${API_URL}/acd/feedback/${feedbackId}/close`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pnl: parseFloat(pnl) }),
      });
      setClosing(false);
      setPnl('done');
    } catch {}
  };

  const chipStyle = (active) => ({
    padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid',
    background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
    borderColor: active ? '#6366f1' : '#334155', color: active ? '#a5b4fc' : '#94a3b8',
  });

  const btnStyle = (color) => ({
    padding: '6px 18px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${color}`, background: `${color}15`, color,
  });

  return (
    <div style={{ borderTop: '1px solid rgba(99,102,241,0.15)', paddingTop: 8, marginTop: 4 }}>
      {!sent && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Trade Log:</span>
          <button onClick={() => submit('TAKEN')} style={btnStyle('#22c55e')}>Taking It</button>
          <button onClick={() => submit('PASSED')} style={btnStyle('#f59e0b')}>Passing</button>
        </div>
      )}
      {sent && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: sent === 'TAKEN' ? '#22c55e' : '#f59e0b', fontWeight: 700 }}>
              {sent === 'TAKEN' ? 'TAKING' : 'PASSED'} — {setupCard.type}
            </span>
            {activeTags.map(t => (
              <span key={t} onClick={() => toggleTag(t)} style={chipStyle(tags.includes(t))}>
                {t.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
          {sent === 'TAKEN' && !closing && pnl !== 'done' && (
            <button onClick={() => setClosing(true)} style={{ ...btnStyle('#818cf8'), alignSelf: 'flex-start', marginTop: 2 }}>Close Trade</button>
          )}
          {closing && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>P&L ($):</span>
              <input type="number" value={pnl} onChange={e => setPnl(e.target.value)} placeholder="e.g. 150 or -80"
                style={{ width: 90, padding: '4px 8px', borderRadius: 4, border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', fontSize: 12, fontFamily: 'monospace' }}
                onKeyDown={e => e.key === 'Enter' && closeTrade()} />
              <button onClick={closeTrade} style={btnStyle('#22c55e')}>Submit</button>
            </div>
          )}
          {pnl === 'done' && <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 600 }}>Trade logged</span>}
        </div>
      )}
    </div>
  );
}

function SystemHealthSummary({ onNavigate }) {
  const [data, setData] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/settings/process-health`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const sock = window._tradingSocket;
    if (!sock) return;
    const handler = () => fetch(`${API_URL}/settings/process-health`).then(r => r.json()).then(setData).catch(() => {});
    sock.on('process-health-alert', handler);
    return () => sock.off('process-health-alert', handler);
  }, []);

  const redCount = data?.redCount || 0;
  const dotColor = !data ? '#64748b' : redCount > 0 ? '#ef4444' : '#22c55e';
  const label = !data ? 'Checking...' : redCount > 0 ? `⚠ ${redCount} process${redCount > 1 ? 'es' : ''} need attention` : 'All processes running';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '8px 14px', background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 13 }}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <span style={{ color: dotColor === '#22c55e' ? '#22c55e' : dotColor === '#ef4444' ? '#ef4444' : 'var(--text-muted)' }}>{label}</span>
      <button
        onClick={() => onNavigate('settings')}
        style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 10px', borderRadius: 5, background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', cursor: 'pointer' }}
      >
        Process Health →
      </button>
    </div>
  );
}

export { QuickTradeLog, SystemHealthSummary };
