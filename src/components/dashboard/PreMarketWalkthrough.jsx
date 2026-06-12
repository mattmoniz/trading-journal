import React, { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = '/api';

const REGIME_OPTIONS = [
  { value: 'IN_BALANCE', label: 'In balance' },
  { value: 'TRENDING', label: 'Trending' },
  { value: 'BREAKING_OUT', label: 'Breaking out' },
  { value: 'UNCLEAR', label: 'Unclear' },
];

const LEAN_OPTIONS = [
  { value: 'BULLISH', label: 'Bullish', color: '#22c55e' },
  { value: 'BEARISH', label: 'Bearish', color: '#ef4444' },
  { value: 'NEUTRAL', label: 'Neutral', color: '#94a3b8' },
];

const labelStyle = { fontSize: 13, fontWeight: 700, color: '#cbd5e1', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 };
const helperStyle = { fontSize: 12, color: '#94a3b8', lineHeight: 1.5, marginBottom: 10 };
const refRowStyle = { display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 10, padding: '8px 12px', background: 'rgba(15,23,42,0.4)', border: '1px solid #1e293b', borderRadius: 6 };
const refItemLabel = { fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 6 };
const refItemValue = { fontSize: 13, fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace' };
const textareaStyle = {
  width: '100%', minHeight: 64, resize: 'vertical', fontFamily: 'Arial, sans-serif', fontSize: 13,
  color: 'var(--text-primary)', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, padding: '8px 10px',
};
const sectionWrapStyle = { marginBottom: 22, paddingBottom: 18, borderBottom: '1px solid var(--border-color)' };

function pillButton(active, color) {
  return {
    padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? color : 'var(--border-color)'}`,
    background: active ? `${color}22` : 'transparent',
    color: active ? color : '#94a3b8',
  };
}

function ChoiceRow({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={pillButton(value === o.value, o.color || '#3b82f6')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function fmtPx(v) { return v != null ? parseFloat(v).toFixed(2) : '—'; }

const VALUE_LABEL = { ABOVE_VALUE: 'Above prior VAH', INSIDE_VALUE: 'Inside prior value', BELOW_VALUE: 'Below prior VAL' };
const INVENTORY_LABEL = { SHORT_TRAPPED: 'Shorts trapped (above value)', LONG_TRAPPED: 'Longs trapped (below value)', NEUTRAL: 'Neutral / no clear trap' };
const BRACKET_STATE_LABEL = { TRENDING_UP: 'Trending up', TRENDING_DOWN: 'Trending down', TRANSITIONAL: 'Transitional', BRACKET: 'In balance / bracket' };

export default function PreMarketWalkthrough() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [date] = useState(todayET);
  const [ref, setRef] = useState(null);
  const [longterm, setLongterm] = useState(null);
  const [acdToday, setAcdToday] = useState(null);

  const [regime, setRegime] = useState(null);
  const [overnightRead, setOvernightRead] = useState('');
  const [openNotes, setOpenNotes] = useState('');
  const [signalsNotes, setSignalsNotes] = useState('');
  const [layer1Lean, setLayer1Lean] = useState(null);
  const [layer2Lean, setLayer2Lean] = useState(null);
  const [layer3Lean, setLayer3Lean] = useState(null);
  const [layer4Lean, setLayer4Lean] = useState(null);
  const [committedPlan, setCommittedPlan] = useState('');

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const saveTimer = useRef(null);

  // Reference data — read-only, from existing overnight/auction-read auto-detection
  useEffect(() => {
    fetch(`${API_URL}/auction-read/auto`)
      .then(r => r.json())
      .then(d => { if (!d.error) setRef(d); })
      .catch(() => {});
  }, []);

  // Reference data — live regime / value-migration read, for Layer 1 context only
  useEffect(() => {
    fetch(`${API_URL}/longterm/summary`)
      .then(r => r.json())
      .then(d => { if (!d.error) setLongterm(d); })
      .catch(() => {});
  }, []);

  // Reference data — single shared fetch for Layer 3 (OR levels) and Layer 4 (NL30/NL10, A-signals)
  useEffect(() => {
    fetch(`${API_URL}/acd/today`)
      .then(r => r.json())
      .then(d => { if (!d.error) setAcdToday(d); })
      .catch(() => {});
  }, []);

  // Load any existing entry for today — a new day starts fresh
  useEffect(() => {
    setLoaded(false);
    fetch(`${API_URL}/premarket-walkthrough/${date}`)
      .then(r => r.json())
      .then(d => {
        if (d) {
          setRegime(d.regime || null);
          setOvernightRead(d.overnight_read || '');
          setOpenNotes(d.open_notes || '');
          setSignalsNotes(d.signals_notes || '');
          setLayer1Lean(d.layer1_lean || null);
          setLayer2Lean(d.layer2_lean || null);
          setLayer3Lean(d.layer3_lean || null);
          setLayer4Lean(d.layer4_lean || null);
          setCommittedPlan(d.committed_plan || '');
          if (d.updated_at) setSavedAt(new Date(d.updated_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }));
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [date]);

  const persist = useCallback((overrides) => {
    const body = {
      regime, overnight_read: overnightRead, open_notes: openNotes, signals_notes: signalsNotes,
      layer1_lean: layer1Lean, layer2_lean: layer2Lean, layer3_lean: layer3Lean, layer4_lean: layer4Lean,
      committed_plan: committedPlan,
      ...overrides,
    };
    setSaving(true);
    fetch(`${API_URL}/premarket-walkthrough/${date}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => {
        setSaving(false);
        if (d?.updated_at) setSavedAt(new Date(d.updated_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }));
      })
      .catch(() => setSaving(false));
  }, [date, regime, overnightRead, openNotes, signalsNotes, layer1Lean, layer2Lean, layer3Lean, layer4Lean, committedPlan]);

  // Debounced auto-save for free-text fields; immediate save for choice selections
  const scheduleSave = useCallback((overrides) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(overrides), 1200);
  }, [persist]);

  if (!loaded) return <div style={{ fontSize: 13, color: '#94a3b8' }}>Loading…</div>;

  const leans = [layer1Lean, layer2Lean, layer3Lean, layer4Lean];
  const setCount = leans.filter(Boolean).length;
  const bullish = leans.filter(l => l === 'BULLISH').length;
  const bearish = leans.filter(l => l === 'BEARISH').length;
  const neutral = leans.filter(l => l === 'NEUTRAL').length;

  let verdict = null;
  if (setCount >= 2) {
    const dominant = Math.max(bullish, bearish);
    const agreement = dominant / setCount;
    if (agreement >= 0.75 && dominant >= 2) {
      verdict = { label: 'STACK', sub: bullish > bearish ? 'Bullish confluence' : 'Bearish confluence',
        color: '#22c55e', text: `${dominant} of ${setCount} layers agree — high conviction. The reasoning lines up; size and conviction can reflect that.` };
    } else {
      verdict = { label: 'CONFLICT', sub: 'Layers disagree',
        color: '#f59e0b', text: `Layers are split (${bullish} bullish · ${bearish} bearish · ${neutral} neutral) — low conviction. Smaller size, or stand aside is a legitimate, deliberate choice — not a failure. The framework's value is permission to skip ambiguous days.` };
    }
  }

  return (
    <div style={{ fontFamily: 'Arial, sans-serif' }}>
      <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6, marginBottom: 18 }}>
        A guided pre-market walkthrough — work through each layer in order, then commit a plan while calm.
        You fill in your own read at every step; the app only reflects it back. The goal is discipline:
        force the reasoning, ask whether the timeframes agree, and write the plan down before the bell.
        {savedAt && <span style={{ marginLeft: 8, color: '#64748b', fontStyle: 'italic' }}>· last saved {savedAt} ET{saving ? ' · saving…' : ''}</span>}
      </div>

      {/* LAYER 1 — REGIME */}
      <div style={sectionWrapStyle}>
        <div style={labelStyle}>Layer 1 — Regime / bigger structure</div>
        <div style={helperStyle}>
          Are we inside a multi-day balance, or trending / breaking out of one? <em>In balance</em> = levels hold,
          fades work. <em>Trending</em> = levels slice — go with, not against. Reference (read-only) below — form your own read, then choose.
        </div>
        {longterm?.bracketState && (
          <div style={refRowStyle}>
            <div><span style={refItemLabel}>Live regime read</span><span style={refItemValue}>{BRACKET_STATE_LABEL[longterm.bracketState.state] || longterm.bracketState.state || '—'}</span></div>
            <div><span style={refItemLabel}>Value overlap (5d / 10d)</span><span style={refItemValue}>{longterm.valueMigration?.overlapCount5 ?? '—'} of 5 · {longterm.valueMigration?.overlapCount10 ?? '—'} of 10</span></div>
          </div>
        )}
        <ChoiceRow options={REGIME_OPTIONS} value={regime}
          onChange={(v) => { setRegime(v); persist({ regime: v }); }} />
      </div>

      {/* LAYER 2 — OVERNIGHT READ */}
      <div style={sectionWrapStyle}>
        <div style={labelStyle}>Layer 2 — Overnight read</div>
        <div style={helperStyle}>Reference (read-only) — reason against the real numbers, then write your read below.</div>
        {ref && (
          <div style={refRowStyle}>
            <div><span style={refItemLabel}>Open vs prior value</span><span style={refItemValue}>{VALUE_LABEL[ref.open_vs_prior_value] || '—'}</span></div>
            <div><span style={refItemLabel}>Overnight inventory</span><span style={refItemValue}>{INVENTORY_LABEL[ref.overnight_inventory] || '—'}</span></div>
            <div><span style={refItemLabel}>Overnight high</span><span style={refItemValue}>{fmtPx(ref.ovn_high)}</span></div>
            <div><span style={refItemLabel}>Overnight low</span><span style={refItemValue}>{fmtPx(ref.ovn_low)}</span></div>
            <div><span style={refItemLabel}>Prior VAH / POC / VAL</span><span style={refItemValue}>{fmtPx(ref.prior_day_vah)} / {fmtPx(ref.prior_day_poc)} / {fmtPx(ref.prior_day_val)}</span></div>
          </div>
        )}
        <div style={helperStyle}>Is inventory trapped, and which direction does the overnight lean? Write your read:</div>
        <textarea style={textareaStyle} value={overnightRead}
          onChange={e => { setOvernightRead(e.target.value); scheduleSave({ overnight_read: e.target.value }); }}
          placeholder="e.g. Shorts trapped above prior VAH overnight, drifted down into the open — leaning long unless that breaks down fast" />
      </div>

      {/* LAYER 3 — THE OPEN */}
      <div style={sectionWrapStyle}>
        <div style={labelStyle}>Layer 3 — The open</div>
        <div style={helperStyle}>
          Opening type (drive / test-drive / auction / rejection-reverse) and direction. A drive <em>with</em> the
          overnight read = confluence; a drive <em>against</em> it = warning your bias may be wrong.
          Fill this in pre-open as "what I expect / what would confirm" — revisit it at the open. Note opening type yourself; reference levels below.
        </div>
        {acdToday?.today && (acdToday.today.or_high != null || acdToday.today.or_low != null) && (
          <div style={refRowStyle}>
            <div><span style={refItemLabel}>OR high / low</span><span style={refItemValue}>{fmtPx(acdToday.today.or_high)} / {fmtPx(acdToday.today.or_low)}</span></div>
          </div>
        )}
        <textarea style={textareaStyle} value={openNotes}
          onChange={e => { setOpenNotes(e.target.value); scheduleSave({ open_notes: e.target.value }); }}
          placeholder="e.g. Expecting a test-drive down into the ON low, then a drive back up if it holds — that would confirm the long lean" />
      </div>

      {/* LAYER 4 — SIGNALS */}
      <div style={sectionWrapStyle}>
        <div style={labelStyle}>Layer 4 — Signals</div>
        <div style={helperStyle}>
          ACD / Fisher expectation — A-up / A-down lean, NL30 / NL10 direction. Signals only carry weight when
          they <em>agree</em> with layers 1–3. Reference (read-only) below — write your own signal read.
        </div>
        {acdToday && (
          <div style={refRowStyle}>
            <div><span style={refItemLabel}>NL30 / NL10</span><span style={refItemValue}>{acdToday.numberLine?.sum30 ?? '—'} / {acdToday.numberLine?.sum10 ?? '—'}</span></div>
            <div>
              <span style={refItemLabel}>A-signal</span>
              <span style={refItemValue}>
                {acdToday.today?.a_up_fired ? `A Up fired${acdToday.today.a_up_level != null ? ' ' + fmtPx(acdToday.today.a_up_level) : ''}`
                  : acdToday.today?.a_down_fired ? `A Down fired${acdToday.today.a_down_level != null ? ' ' + fmtPx(acdToday.today.a_down_level) : ''}`
                  : acdToday.today ? 'No signal yet' : '—'}
              </span>
            </div>
          </div>
        )}
        <textarea style={textareaStyle} value={signalsNotes}
          onChange={e => { setSignalsNotes(e.target.value); scheduleSave({ signals_notes: e.target.value }); }}
          placeholder="e.g. NL30 was +6 yesterday, leaning A-up — agrees with the long read above" />
      </div>

      {/* THE VERDICT */}
      <div style={sectionWrapStyle}>
        <div style={labelStyle}>The verdict — do they stack or conflict?</div>
        <div style={helperStyle}>Mark each layer's directional lean, then see whether they line up.</div>
        {[
          ['Layer 1 — Regime', layer1Lean, setLayer1Lean, 'layer1_lean'],
          ['Layer 2 — Overnight', layer2Lean, setLayer2Lean, 'layer2_lean'],
          ['Layer 3 — The open', layer3Lean, setLayer3Lean, 'layer3_lean'],
          ['Layer 4 — Signals', layer4Lean, setLayer4Lean, 'layer4_lean'],
        ].map(([label, val, setter, key]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: '#cbd5e1', minWidth: 150 }}>{label}</span>
            <ChoiceRow options={LEAN_OPTIONS} value={val}
              onChange={(v) => { setter(v); persist({ [key]: v }); }} />
          </div>
        ))}

        {verdict && (
          <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 8,
            background: `${verdict.color}15`, border: `1px solid ${verdict.color}55` }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: verdict.color, letterSpacing: '0.08em' }}>
              {verdict.label} <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', letterSpacing: 'normal', textTransform: 'none' }}>· {verdict.sub}</span>
            </div>
            <div style={{ fontSize: 13, color: '#cbd5e1', marginTop: 4, lineHeight: 1.5 }}>{verdict.text}</div>
          </div>
        )}
        {!verdict && (
          <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic', marginTop: 6 }}>
            Mark at least two layers to see whether your reasoning stacks or conflicts.
          </div>
        )}
      </div>

      {/* THE COMMITTED PLAN */}
      <div style={{ marginBottom: 4 }}>
        <div style={labelStyle}>The committed plan</div>
        <div style={helperStyle}>
          Write your committed read, your ONE or TWO setups for the day, and what would invalidate each.
          This stays visible all session — so at 1PM you can see exactly what you committed to at 9:15.
        </div>
        <textarea style={{ ...textareaStyle, minHeight: 110, fontSize: 14, borderColor: '#3b82f6' }} value={committedPlan}
          onChange={e => { setCommittedPlan(e.target.value); scheduleSave({ committed_plan: e.target.value }); }}
          placeholder={"e.g.\nRead: Long bias — shorts trapped overnight, NL30 agrees.\nSetup 1: A-up reclaim of OR high with volume — invalidated if we lose ON low.\nSetup 2: Fade of prior VAH on first test if rejection — invalidated if we accept above it."} />
      </div>
    </div>
  );
}
