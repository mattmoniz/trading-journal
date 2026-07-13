import React from 'react';
import {
  BarChart, Bar, ComposedChart, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { fmtP } from '../utils/format.js';

const API_URL = '/api';

function ScenarioPatBar({ data, dataKey = 'avgPnl', nameKey = 'label', height = 160 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
        <XAxis dataKey={nameKey} tick={{ fontSize: 11, fill: '#64748b' }} />
        <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={v => `$${Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)}`} width={48} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, fontSize: 12 }}
          formatter={(v) => [v != null ? `$${fmtP(parseFloat(v))}` : '—', 'Avg P&L']}
          labelFormatter={(l, payload) => {
            const d = payload?.[0]?.payload;
            return d ? `${l} — ${d.winRate}% WR · ${d.count ?? d.days} ${d.count != null ? 'fills' : 'days'}` : l;
          }} />
        <ReferenceLine y={0} stroke="#334155" />
        <Bar dataKey={dataKey} radius={[3, 3, 0, 0]}>
          {(data || []).map((entry, i) => (
            <Cell key={i} fill={entry[dataKey] >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const PRESETS = [
  { label: 'Stop at 1PM',         filters: { timeTo: '13:00' } },
  { label: 'Stop at noon',        filters: { timeTo: '12:00' } },
  { label: '11AM–1PM only',       filters: { timeFrom: '11:00', timeTo: '13:00' } },
  { label: 'First 3 trades/day',  filters: { maxTradesPerDay: 3 } },
  { label: 'Stop after 2 losses', filters: { stopAfterLosses: 2 } },
  { label: 'Stop once up $400',   filters: { profitLock: 400 } },
  { label: 'Skip BALANCE days',   filters: { dayTypes: ['TREND', 'TURBULENT'] } },
  { label: 'Mon–Wed only',        filters: { daysOfWeek: [1, 2, 3] } },
];

function fmt$(n, showPlus = true) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? (showPlus ? '+' : '') : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default function ScenarioTesterView() {
  // Filters
  const [dateRange,        setDateRange]        = React.useState('60');
  const [startDate,        setStartDate]        = React.useState('');
  const [endDate,          setEndDate]          = React.useState('');
  const [timeFrom,         setTimeFrom]         = React.useState('');
  const [timeTo,           setTimeTo]           = React.useState('');
  const [daysOfWeek,       setDaysOfWeek]       = React.useState([1,2,3,4,5]);
  const [dayTypes,         setDayTypes]         = React.useState(['TREND','BALANCE','TURBULENT']);
  const [accounts,         setAccounts]         = React.useState([]);
  const [allAccounts,      setAllAccounts]      = React.useState([]);
  const [maxTradesPerDay,  setMaxTradesPerDay]  = React.useState('');
  const [stopAfterLosses,  setStopAfterLosses]  = React.useState('');
  const [profitLock,       setProfitLock]       = React.useState('');
  const [dll,              setDll]              = React.useState('');

  // Results
  const [result,    setResult]    = React.useState(null);
  const [loading,   setLoading]   = React.useState(false);
  const [error,     setError]     = React.useState(null);
  const [dllTable,  setDllTable]  = React.useState(null);
  const [dllLoading,setDllLoading]= React.useState(false);
  const [activePreset, setActivePreset] = React.useState(null);

  // Pattern analysis
  const [patterns,        setPatterns]        = React.useState(null);
  const [patternsLoading, setPatternsLoading] = React.useState(false);

  // Optimizer
  const [optExpanded,    setOptExpanded]    = React.useState(false);
  const [optGridParams,  setOptGridParams]  = React.useState({ dll: true, timeTo: true, maxTradesPerDay: true, stopAfterLosses: false, profitLock: false });
  const [optResult,      setOptResult]      = React.useState(null);
  const [optLoading,     setOptLoading]     = React.useState(false);
  const [optError,       setOptError]       = React.useState(null);

  // Monte Carlo
  const [mcExpanded,   setMcExpanded]   = React.useState(false);
  const [mcParams,     setMcParams]     = React.useState(null);
  const [mcResult,     setMcResult]     = React.useState(null);
  const [mcLoading,    setMcLoading]    = React.useState(false);
  const [mcError,      setMcError]      = React.useState(null);

  React.useEffect(() => {
    fetch(`${API_URL}/scenario/accounts`).then(r => r.json()).then(a => { setAllAccounts(a); }).catch(() => {});
  }, []);

  const buildBody = React.useCallback((overrides = {}) => {
    const today = new Date().toISOString().slice(0, 10);
    let sd = startDate, ed = endDate;
    if (!startDate || !endDate) {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(dateRange || 60));
      sd = d.toISOString().slice(0, 10);
      ed = today;
    }
    return {
      startDate: sd, endDate: ed,
      timeFrom:  timeFrom  || undefined,
      timeTo:    timeTo    || undefined,
      daysOfWeek: daysOfWeek.length < 7 ? daysOfWeek : undefined,
      dayTypes:  dayTypes.length < 3 ? dayTypes : undefined,
      accounts:  accounts.length ? accounts : undefined,
      maxTradesPerDay: maxTradesPerDay ? parseInt(maxTradesPerDay) : undefined,
      stopAfterLosses: stopAfterLosses ? parseInt(stopAfterLosses) : undefined,
      profitLock: profitLock ? parseFloat(profitLock) : undefined,
      dll:        dll ? parseFloat(dll) : undefined,
      ...overrides,
    };
  }, [startDate, endDate, dateRange, timeFrom, timeTo, daysOfWeek, dayTypes, accounts, maxTradesPerDay, stopAfterLosses, profitLock, dll]);

  const run = React.useCallback(async (bodyOverrides = {}) => {
    setLoading(true); setError(null);
    try {
      const [r1] = await Promise.all([
        fetch(`${API_URL}/scenario`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(bodyOverrides)) }),
      ]);
      const d = await r1.json();
      if (d.error) throw new Error(d.error);
      setResult(d);
    } catch(e) { setError(e.message); }
    setLoading(false);
    runPatterns(bodyOverrides);
  }, [buildBody]);

  const runDllCompare = React.useCallback(async () => {
    setDllLoading(true);
    try {
      const r = await fetch(`${API_URL}/scenario/dll-compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody({ dllLevels: [200, 300, 400, 500] })) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setDllTable(d);
    } catch(e) { setError(e.message); }
    setDllLoading(false);
  }, [buildBody]);

  const runPatterns = React.useCallback(async (bodyOverrides = {}) => {
    setPatternsLoading(true);
    try {
      const base = buildBody(bodyOverrides);
      const body = { startDate: base.startDate, endDate: base.endDate, accounts: base.accounts, daysOfWeek: base.daysOfWeek, dayTypes: base.dayTypes };
      const r = await fetch(`${API_URL}/scenario/patterns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setPatterns(d);
    } catch(e) { console.error('[patterns]', e); }
    setPatternsLoading(false);
  }, [buildBody]);

  const runOptimizer = React.useCallback(async () => {
    setOptLoading(true); setOptError(null);
    try {
      const active = Object.entries(optGridParams).filter(([, v]) => v).map(([k]) => k);
      const gridParams = {};
      if (active.includes('dll'))             gridParams.dll             = [null, 100, 150, 200, 250, 300, 400, 500, 600];
      if (active.includes('timeTo'))          gridParams.timeTo          = [null, '11:00', '11:30', '12:00', '12:30', '13:00', '14:00'];
      if (active.includes('maxTradesPerDay')) gridParams.maxTradesPerDay = [null, 2, 3, 4, 5];
      if (active.includes('stopAfterLosses')) gridParams.stopAfterLosses = [null, 1, 2, 3];
      if (active.includes('profitLock'))      gridParams.profitLock      = [null, 200, 400, 600, 800];
      const base = buildBody({});
      const body = { startDate: base.startDate, endDate: base.endDate, accounts: base.accounts, gridParams, topN: 10 };
      const r = await fetch(`${API_URL}/scenario/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setOptResult(d);
    } catch(e) { setOptError(e.message); }
    setOptLoading(false);
  }, [buildBody, optGridParams]);

  const runMonteCarlo = React.useCallback(async (overrideParams = null) => {
    setMcLoading(true); setMcError(null);
    try {
      const scenarioParams = overrideParams || { dll: dll ? parseFloat(dll) : undefined, timeTo: timeTo || undefined, maxTradesPerDay: maxTradesPerDay ? parseInt(maxTradesPerDay) : undefined, stopAfterLosses: stopAfterLosses ? parseInt(stopAfterLosses) : undefined, profitLock: profitLock ? parseFloat(profitLock) : undefined };
      const base = buildBody({});
      const body = { startDate: base.startDate, endDate: base.endDate, accounts: base.accounts, scenarioParams, iterations: 5000 };
      const r = await fetch(`${API_URL}/scenario/monte-carlo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setMcResult(d); setMcExpanded(true);
    } catch(e) { setMcError(e.message); }
    setMcLoading(false);
  }, [buildBody, dll, timeTo, maxTradesPerDay, stopAfterLosses, profitLock]);

  // Run on mount with defaults
  React.useEffect(() => { run(); runPatterns(); }, []);

  const applyPreset = (preset) => {
    setActivePreset(preset.label);
    setTimeFrom(''); setTimeTo(''); setMaxTradesPerDay(''); setStopAfterLosses(''); setProfitLock(''); setDll('');
    setDayTypes(['TREND','BALANCE','TURBULENT']);
    setDaysOfWeek([1,2,3,4,5]);
    const f = preset.filters;
    if (f.timeFrom)        setTimeFrom(f.timeFrom);
    if (f.timeTo)          setTimeTo(f.timeTo);
    if (f.maxTradesPerDay) setMaxTradesPerDay(String(f.maxTradesPerDay));
    if (f.stopAfterLosses) setStopAfterLosses(String(f.stopAfterLosses));
    if (f.profitLock)      setProfitLock(String(f.profitLock));
    if (f.dayTypes)        setDayTypes(f.dayTypes);
    if (f.daysOfWeek)      setDaysOfWeek(f.daysOfWeek);
    setTimeout(() => run(f), 0);
  };

  const toggleDow = (d) => setDaysOfWeek(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  const toggleDayType = (t) => setDayTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  const toggleAccount = (a) => setAccounts(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]);

  const sc = result?.scenario;
  const ac = result?.actual;
  const deltaPos = sc && sc.delta >= 0;

  const CARD = { background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 16px' };
  const LABEL = { fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 };
  const NUM = (clr) => ({ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: clr || '#e2e8f0' });

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#e2e8f0', margin: 0 }}>Scenario Tester</h1>
        <span style={{ fontSize: 13, color: '#94a3b8' }}>Filter your own trade history — instant P&L impact of any rule</span>
      </div>

      {/* ── Presets ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {PRESETS.map(p => (
          <button key={p.label} onClick={() => applyPreset(p)}
            style={{ padding: '6px 14px', fontSize: 13, borderRadius: 20, cursor: 'pointer', fontWeight: activePreset === p.label ? 700 : 500,
              border: `1px solid ${activePreset === p.label ? '#6366f1' : 'var(--border-color)'}`,
              background: activePreset === p.label ? 'rgba(99,102,241,0.18)' : 'transparent',
              color: activePreset === p.label ? '#818cf8' : '#94a3b8' }}>
            {p.label}
          </button>
        ))}
        <button onClick={() => { setActivePreset(null); setTimeFrom(''); setTimeTo(''); setMaxTradesPerDay(''); setStopAfterLosses(''); setProfitLock(''); setDll(''); setDayTypes(['TREND','BALANCE','TURBULENT']); setDaysOfWeek([1,2,3,4,5]); setTimeout(() => run(), 0); }}
          style={{ padding: '6px 14px', fontSize: 13, borderRadius: 20, cursor: 'pointer', border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#ef4444' }}>
          Reset
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20, alignItems: 'start' }}>

        {/* ── Filters panel ── */}
        <div style={{ ...CARD, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Filters</div>

          {/* Date range */}
          <div>
            <div style={LABEL}>Date range</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              {['30','60','90'].map(d => (
                <button key={d} onClick={() => { setDateRange(d); setStartDate(''); setEndDate(''); }}
                  style={{ flex: 1, padding: '5px 0', fontSize: 13, borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${dateRange === d && !startDate ? '#6366f1' : 'var(--border-color)'}`,
                    background: dateRange === d && !startDate ? 'rgba(99,102,241,0.15)' : 'transparent',
                    color: dateRange === d && !startDate ? '#818cf8' : '#94a3b8', fontWeight: dateRange === d && !startDate ? 700 : 400 }}>
                  {d}d
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setDateRange(''); }}
                style={{ flex: 1, padding: '4px 6px', fontSize: 12, background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: '#e2e8f0' }} />
              <input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setDateRange(''); }}
                style={{ flex: 1, padding: '4px 6px', fontSize: 12, background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: '#e2e8f0' }} />
            </div>
          </div>

          {/* Time window */}
          <div>
            <div style={LABEL}>Time window (ET)</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="time" value={timeFrom} onChange={e => setTimeFrom(e.target.value)}
                style={{ flex: 1, padding: '4px 6px', fontSize: 13, background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: '#e2e8f0' }} />
              <span style={{ color: '#94a3b8', fontSize: 12 }}>to</span>
              <input type="time" value={timeTo} onChange={e => setTimeTo(e.target.value)}
                style={{ flex: 1, padding: '4px 6px', fontSize: 13, background: 'var(--input-bg)', border: '1px solid var(--border-color)', borderRadius: 5, color: '#e2e8f0' }} />
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>Leave blank = no time filter</div>
          </div>

          {/* Days of week */}
          <div>
            <div style={LABEL}>Days of week</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {[['M',1],['T',2],['W',3],['Th',4],['F',5]].map(([lbl,d]) => (
                <button key={d} onClick={() => toggleDow(d)}
                  style={{ flex: 1, padding: '4px 0', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${daysOfWeek.includes(d) ? '#22c55e' : 'var(--border-color)'}`,
                    background: daysOfWeek.includes(d) ? 'rgba(34,197,94,0.12)' : 'transparent',
                    color: daysOfWeek.includes(d) ? '#22c55e' : '#64748b', fontWeight: 600 }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* Day type */}
          <div>
            <div style={LABEL}>Day type</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {['TREND','BALANCE','TURBULENT'].map(t => (
                <button key={t} onClick={() => toggleDayType(t)}
                  style={{ flex: 1, padding: '4px 0', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${dayTypes.includes(t) ? '#818cf8' : 'var(--border-color)'}`,
                    background: dayTypes.includes(t) ? 'rgba(129,140,248,0.12)' : 'transparent',
                    color: dayTypes.includes(t) ? '#818cf8' : '#64748b', fontWeight: 600 }}>
                  {t === 'TURBULENT' ? 'TURB' : t}
                </button>
              ))}
            </div>
          </div>

          {/* Account */}
          {allAccounts.length > 0 && (
            <div>
              <div style={LABEL}>Accounts <span style={{ color: '#94a3b8', fontWeight: 400, textTransform: 'none' }}>(none = all)</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 110, overflowY: 'auto' }}>
                {allAccounts.map(a => (
                  <button key={a} onClick={() => toggleAccount(a)}
                    style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', textAlign: 'left',
                      border: `1px solid ${accounts.includes(a) ? '#3b82f6' : 'var(--border-color)'}`,
                      background: accounts.includes(a) ? 'rgba(59,130,246,0.12)' : 'transparent',
                      color: accounts.includes(a) ? '#7dd3fc' : '#64748b', fontFamily: 'monospace' }}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Sequential filters */}
          <div>
            <div style={LABEL}>Sequential rules</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Max trades/day', val: maxTradesPerDay, set: setMaxTradesPerDay, placeholder: 'e.g. 3', type: 'number' },
                { label: 'Stop after N losses', val: stopAfterLosses, set: setStopAfterLosses, placeholder: 'e.g. 2', type: 'number' },
                { label: 'Profit lock ($)', val: profitLock, set: setProfitLock, placeholder: 'e.g. 400', type: 'number' },
                { label: 'DLL ($)', val: dll, set: setDll, placeholder: 'e.g. 300', type: 'number' },
              ].map(({ label, val, set, placeholder }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 140 }}>{label}</span>
                  <input value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                    style={{ width: 80, padding: '4px 8px', fontSize: 13, background: 'var(--input-bg)', border: `1px solid ${val ? '#6366f1' : 'var(--border-color)'}`, borderRadius: 5, color: '#e2e8f0', fontFamily: 'monospace' }} />
                </div>
              ))}
            </div>
          </div>

          <button onClick={() => { setActivePreset(null); run(); }}
            disabled={loading}
            style={{ padding: '9px 0', fontSize: 14, fontWeight: 700, borderRadius: 7, border: 'none',
              background: loading ? '#1e293b' : '#6366f1', color: loading ? '#64748b' : '#fff', cursor: loading ? 'default' : 'pointer' }}>
            {loading ? 'Running…' : 'Run Scenario'}
          </button>
        </div>

        {/* ── Results panel ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#ef4444', fontSize: 13 }}>{error}</div>}

          {sc && (
            <>
              {/* ── Headline stats ── */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <div style={CARD}>
                  <div style={LABEL}>Scenario P&L</div>
                  <div style={NUM(sc.netPnl >= 0 ? '#22c55e' : '#ef4444')}>{fmt$(sc.netPnl)}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>vs actual {fmt$(ac?.netPnl)}</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Rule impact (delta)</div>
                  <div style={NUM(deltaPos ? '#22c55e' : '#ef4444')}>{fmt$(sc.delta)}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{deltaPos ? 'better' : 'worse'} than actual</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Win rate</div>
                  <div style={NUM(sc.winRate >= 50 ? '#22c55e' : '#f59e0b')}>{sc.winRate}%</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sc.winners}W / {sc.losers}L ({sc.tradeCount} fills)</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Win-day rate</div>
                  <div style={NUM(sc.winDayRate >= 50 ? '#22c55e' : '#f59e0b')}>{sc.winDayRate}%</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{sc.winDays}W / {sc.lossDays}L ({sc.dayCount} days)</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Avg per trade</div>
                  <div style={NUM(sc.avgPerTrade >= 0 ? '#94a3b8' : '#ef4444')}>{fmt$(sc.avgPerTrade)}</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Avg per day</div>
                  <div style={NUM(sc.avgPerDay >= 0 ? '#94a3b8' : '#ef4444')}>{fmt$(sc.avgPerDay)}</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Give-back</div>
                  <div style={NUM('#f59e0b')}>{fmt$(sc.giveBack, false)}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>peak–close cumulative</div>
                </div>
                <div style={CARD}>
                  <div style={LABEL}>Date range</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', marginTop: 4 }}>{result?.meta?.start}</div>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>→ {result?.meta?.end}</div>
                </div>
              </div>

              {/* ── Equity curve ── */}
              <div style={CARD}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                  Equity Curve — Scenario vs Actual
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={sc.equityCurve.map((pt, i) => ({ ...pt, actual: ac?.equityCurve?.[i]?.equity ?? null }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                    <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={d => d.slice(5)} interval={Math.floor(sc.equityCurve.length / 8)} />
                    <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={v => `$${v >= 0 ? '' : '-'}${Math.abs(v) >= 1000 ? (Math.abs(v)/1000).toFixed(1)+'k' : Math.abs(v).toFixed(0)}`} />
                    <Tooltip formatter={(v, n) => [v != null ? `$${fmtP(v)}` : '—', n === 'equity' ? 'Scenario' : 'Actual']} labelFormatter={l => `Date: ${l}`} contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, fontSize: 12 }} />
                    <ReferenceLine y={0} stroke="#334155" />
                    <Line type="monotone" dataKey="actual" stroke="#64748b" strokeWidth={1.5} dot={false} strokeDasharray="4 2" name="actual" />
                    <Line type="monotone" dataKey="equity" stroke="#6366f1" strokeWidth={2.5} dot={false} name="equity" />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: '#6366f1' }}>— Scenario</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>- - Actual</span>
                </div>
              </div>
            </>
          )}

          {/* ── DLL Compare ── */}
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                DLL Comparison — $200 / $300 / $400 / $500 / None
              </div>
              <button onClick={runDllCompare} disabled={dllLoading}
                style={{ padding: '5px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, border: '1px solid #6366f1',
                  background: dllLoading ? 'transparent' : 'rgba(99,102,241,0.15)', color: dllLoading ? '#64748b' : '#818cf8', cursor: dllLoading ? 'default' : 'pointer' }}>
                {dllLoading ? 'Running…' : 'Run DLL Compare'}
              </button>
            </div>

            {dllTable ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                      {['DLL','Net P&L','Delta vs None','Trades','Hit Days','Saved Days','Cut Early','Saved $','Lost by Cut $','Avg Hit Day P&L','Avg Hit Day Actual'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', textAlign: 'right', color: '#94a3b8', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dllTable.levels.map((row, i) => {
                      const isNone = row.dll == null;
                      const bestPnl = Math.max(...dllTable.levels.map(r => r.netPnl));
                      const isBest = row.netPnl === bestPnl;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(51,65,85,0.3)', background: isBest ? 'rgba(34,197,94,0.06)' : 'transparent' }}>
                          <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, color: isNone ? '#94a3b8' : '#fbbf24' }}>
                            {isNone ? 'None' : `$${row.dll}`} {isBest ? '★' : ''}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: row.netPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                            {fmt$(row.netPnl)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: row.delta >= 0 ? '#22c55e' : '#ef4444' }}>
                            {isNone ? '—' : fmt$(row.delta)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#94a3b8' }}>{row.tradeCount}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: row.dllHitDays > 0 ? '#fbbf24' : '#64748b' }}>{row.dllHitDays}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#22c55e' }}>{row.savedDays || '—'}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#ef4444' }}>{row.cutTooEarlyDays || '—'}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#22c55e' }}>
                            {row.savedTotal > 0 ? fmt$(row.savedTotal) : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#ef4444' }}>
                            {row.cutTooEarlyTotal > 0 ? fmt$(row.cutTooEarlyTotal) : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: row.avgDllDayPnl != null ? (row.avgDllDayPnl >= 0 ? '#22c55e' : '#ef4444') : '#64748b' }}>
                            {row.avgDllDayPnl != null ? fmt$(row.avgDllDayPnl) : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: row.avgDllActualDayPnl != null ? (row.avgDllActualDayPnl >= 0 ? '#22c55e' : '#ef4444') : '#64748b' }}>
                            {row.avgDllActualDayPnl != null ? fmt$(row.avgDllActualDayPnl) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                  <strong style={{ color: '#94a3b8' }}>Saved days:</strong> DLL fired and the actual day P&L was worse — the stop protected you.&nbsp;
                  <strong style={{ color: '#94a3b8' }}>Cut early:</strong> DLL fired but the actual day recovered to better — the stop cost you.&nbsp;
                  ★ = highest net P&L across all DLL levels.
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: '20px 0' }}>
                Click "Run DLL Compare" to see the $200/$300/$400/$500/None comparison side-by-side.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── PATTERN ANALYSIS ─────────────────────────────────────────────── */}
      {(patterns || patternsLoading) && (() => {
        const PCOL = { background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px 18px' };

        return (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>
              Pattern Analysis
              {patternsLoading && <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8', marginLeft: 10 }}>Loading…</span>}
              <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8', marginLeft: 12, textTransform: 'none', letterSpacing: 0 }}>
                Date range + account filters apply · sequential rules excluded
              </span>
            </div>

            {patterns && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>

                {/* Hourly */}
                <div style={PCOL}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                    Avg P&L by Hour (ET)
                  </div>
                  <ScenarioPatBar data={patterns.hourly} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 8 }}>
                    {patterns.hourly.map(h => (
                      <span key={h.hour} style={{ fontSize: 11, color: '#94a3b8' }}>
                        <b style={{ color: h.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>{h.label}</b>: {h.winRate}% WR · {h.count}f
                      </span>
                    ))}
                  </div>
                </div>

                {/* DOW */}
                <div style={PCOL}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                    Avg Day P&L by Weekday
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={patterns.dayOfWeek} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} />
                      <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickFormatter={v => `$${Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)}`} width={48} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, fontSize: 12 }}
                        formatter={v => [`$${fmtP(parseFloat(v))}`, 'Avg P&L']}
                        labelFormatter={(l, payload) => { const d = payload?.[0]?.payload; return d ? `${l} — ${d.winRate}% WR · ${d.days} days` : l; }} />
                      <ReferenceLine y={0} stroke="#334155" />
                      <Bar dataKey="avgPnl" radius={[3, 3, 0, 0]}>
                        {patterns.dayOfWeek.map((d, i) => <Cell key={i} fill={d.avgPnl >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 8 }}>
                    {patterns.dayOfWeek.map(d => (
                      <span key={d.dow} style={{ fontSize: 11, color: '#94a3b8' }}>
                        <b style={{ color: d.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>{d.label}</b>: {d.winRate}% WR · {d.days}d
                      </span>
                    ))}
                  </div>
                </div>

                {/* Fill sequence */}
                <div style={PCOL}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Edge by Fill # of Day
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>Does your edge degrade as you trade more? #1 = first fill of the day.</div>
                  <ScenarioPatBar data={patterns.sessionSequence} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 8 }}>
                    {patterns.sessionSequence.map(s => (
                      <span key={s.seq} style={{ fontSize: 11, color: '#94a3b8' }}>
                        <b style={{ color: s.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>{s.label}</b>: {s.winRate}% WR · {s.count}f · {fmt$(s.totalPnl)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* After win/loss */}
                <div style={PCOL}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Next Fill: After Win vs After Loss
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 14 }}>Make-it-back spiral, quantified. How do you trade after a loser?</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {[
                      { key: 'afterLoss', label: 'After a Loss', color: '#ef4444' },
                      { key: 'afterWin',  label: 'After a Win',  color: '#22c55e' },
                    ].map(({ key, label, color }) => {
                      const s = patterns.afterWinLoss[key];
                      return (
                        <div key={key} style={{ border: `1px solid ${color}33`, borderRadius: 8, padding: '14px 16px', background: `${color}08` }}>
                          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>{label}</div>
                          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'monospace', color: s.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                            {fmt$(s.avgPnl)}
                          </div>
                          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>avg per fill</div>
                          <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>{s.winRate}% win rate</div>
                          <div style={{ fontSize: 12, color: '#94a3b8' }}>{s.count} instances · {fmt$(s.totalPnl)} total</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              </div>
            )}
          </div>
        );
      })()}

      {/* ── PARAMETER OPTIMIZER ──────────────────────────────────────────── */}
      <div style={{ marginTop: 24, background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <button onClick={() => setOptExpanded(x => !x)}
          style={{ width: '100%', padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Parameter Optimizer (Grid Search)</span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{optExpanded ? '▲' : '▼'}</span>
        </button>
        {optExpanded && (
          <div style={{ padding: '0 18px 18px' }}>
            {/* Warning */}
            <div style={{ padding: '10px 14px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 7, marginBottom: 16, fontSize: 12, color: '#fbbf24', lineHeight: 1.6 }}>
              <strong>Curve-fit risk:</strong> the top-ranked combo is the best fit to past data — not necessarily the best future rule.
              Only trust combos labeled <strong>ROBUST</strong>: they must pass the out-of-sample test AND sit on a stable plateau (neighbors also work).
              Combos labeled <strong>OVERFIT</strong> or <strong>FRAGILE</strong> are likely data-mined and should be ignored.
            </div>

            {/* Param selection */}
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Select parameters to optimize:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {[
                ['dll', 'DLL ($100-600, $50/100 steps)'],
                ['timeTo', 'Time cutoff (11:00–14:00, 30min)'],
                ['maxTradesPerDay', 'Max trades/day (2–5)'],
                ['stopAfterLosses', 'Stop after N losses (1–3)'],
                ['profitLock', 'Profit lock (2–8 × $200)'],
              ].map(([key, label]) => (
                <button key={key} onClick={() => setOptGridParams(p => ({ ...p, [key]: !p[key] }))}
                  style={{ padding: '5px 12px', fontSize: 12, borderRadius: 16, cursor: 'pointer',
                    border: `1px solid ${optGridParams[key] ? '#6366f1' : 'var(--border-color)'}`,
                    background: optGridParams[key] ? 'rgba(99,102,241,0.15)' : 'transparent',
                    color: optGridParams[key] ? '#818cf8' : '#64748b', fontWeight: optGridParams[key] ? 700 : 400 }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
              Unchecked parameters are held at their "no rule" default. Date range and account filters from the main panel apply.
            </div>

            <button onClick={runOptimizer} disabled={optLoading}
              style={{ padding: '8px 20px', fontSize: 13, fontWeight: 700, borderRadius: 7, border: 'none',
                background: optLoading ? '#1e293b' : '#6366f1', color: optLoading ? '#64748b' : '#fff', cursor: optLoading ? 'default' : 'pointer', marginBottom: 16 }}>
              {optLoading ? 'Running grid search…' : 'Run Optimizer'}
            </button>

            {optError && <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{optError}</div>}

            {optResult && (() => {
              const { topCombos, totalCombos, meta } = optResult;
              return (
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>
                    {totalCombos} combinations tested · In-sample: {meta.isSplit.start} → {meta.isSplit.end} ({meta.isSplit.days}d) · Out-of-sample: {meta.oosSplit.start} → {meta.oosSplit.end} ({meta.oosSplit.days}d)
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                          {['DLL','Cut','MaxT','StopL','ProfLk','IS Delta','IS WD%','OOS Delta','OOS WD%','Max DD','Plateau','Status'].map(h => (
                            <th key={h} style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                          <th style={{ padding: '6px 8px', color: '#94a3b8', fontSize: 11 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {topCombos.map((c, i) => {
                          const p = c.params;
                          const statusColor = c.robust ? '#22c55e' : c.label.startsWith('OVERFIT') ? '#ef4444' : '#f59e0b';
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(51,65,85,0.3)', background: c.robust ? 'rgba(34,197,94,0.04)' : 'transparent' }}>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#fbbf24' }}>{p.dll != null ? `$${p.dll}` : '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{p.timeTo || '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{p.maxTradesPerDay ?? '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{p.stopAfterLosses ?? '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{p.profitLock != null ? `$${p.profitLock}` : '—'}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: c.isStats.delta >= 0 ? '#22c55e' : '#ef4444' }}>{fmt$(c.isStats.delta)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{c.isStats.winDayRate}%</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: c.oosStats.delta >= 0 ? '#22c55e' : '#ef4444' }}>{fmt$(c.oosStats.delta)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{c.oosStats.winDayRate}%</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#f59e0b' }}>{fmt$(c.isStats.maxDrawdown, false)}</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{Math.round(c.plateauRatio * 100)}%</td>
                              <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: statusColor, whiteSpace: 'nowrap' }}>{c.label}</td>
                              <td style={{ padding: '6px 8px' }}>
                                <button onClick={() => { setMcParams(c.params); runMonteCarlo(c.params); }}
                                  style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #64748b', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}>MC</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
                    <strong style={{ color: '#94a3b8' }}>Plateau %</strong> — % of ±1-step parameter neighbors that also beat actual P&L in-sample. ≥50% = robust plateau.&nbsp;
                    <strong style={{ color: '#22c55e' }}>ROBUST</strong> = OOS profitable + plateau ≥50%.&nbsp;
                    <strong style={{ color: '#f59e0b' }}>FRAGILE</strong> = OOS profitable but isolated spike.&nbsp;
                    <strong style={{ color: '#ef4444' }}>OVERFIT</strong> = failed OOS.
                    · <em>MC button = run Monte Carlo on that combo.</em>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ── MONTE CARLO ──────────────────────────────────────────────────── */}
      <div style={{ marginTop: 16, background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        <button onClick={() => setMcExpanded(x => !x)}
          style={{ width: '100%', padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Monte Carlo Robustness</span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{mcExpanded ? '▲' : '▼'}</span>
        </button>
        {mcExpanded && (
          <div style={{ padding: '0 18px 18px' }}>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12, lineHeight: 1.6 }}>
              Resamples the scenario's daily P&L array 5,000 times (with replacement) to show the distribution of possible outcomes.
              If the result is order-dependent/lucky, the distribution will be wide and the 5th percentile will be deeply negative.
              A robust strategy produces a tight distribution skewed to the right.
            </div>

            {mcParams && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                Testing: DLL={mcParams.dll != null ? `$${mcParams.dll}` : 'none'} · Cut={mcParams.timeTo || 'none'} · MaxT={mcParams.maxTradesPerDay ?? 'none'} · StopL={mcParams.stopAfterLosses ?? 'none'} · ProfLk={mcParams.profitLock != null ? `$${mcParams.profitLock}` : 'none'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <button onClick={() => { setMcParams(null); runMonteCarlo(null); }} disabled={mcLoading}
                style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 7, border: '1px solid #6366f1',
                  background: mcLoading ? 'transparent' : 'rgba(99,102,241,0.15)', color: mcLoading ? '#64748b' : '#818cf8', cursor: mcLoading ? 'default' : 'pointer' }}>
                {mcLoading ? 'Simulating 5000 paths…' : 'Run on Current Filters'}
              </button>
            </div>

            {mcError && <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{mcError}</div>}

            {mcResult && (() => {
              const { distribution: dist, drawdown, scenarioNetPnl, actualNetPnl, iterations } = mcResult;
              const maxBin = Math.max(...dist.bins.map(b => b.count));
              return (
                <div>
                  {/* Summary stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 20 }}>
                    {[
                      { label: '5th %ile', val: dist.p5, color: '#ef4444' },
                      { label: '25th %ile', val: dist.p25, color: '#f59e0b' },
                      { label: 'Median', val: dist.median, color: '#e2e8f0' },
                      { label: '75th %ile', val: dist.p75, color: '#22c55e' },
                      { label: '95th %ile', val: dist.p95, color: '#22c55e' },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', color }}>{fmt$(val)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                    <div style={{ padding: '8px 14px', borderRadius: 7, background: dist.probProfitable >= 60 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${dist.probProfitable >= 60 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                      <span style={{ fontSize: 13, color: dist.probProfitable >= 60 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                        {dist.probProfitable}% of simulations were profitable
                      </span>
                    </div>
                    <div style={{ padding: '8px 14px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
                      <span style={{ fontSize: 13, color: '#fbbf24' }}>Max drawdown p95: {fmt$(drawdown.p95, false)}</span>
                    </div>
                    <div style={{ padding: '8px 14px', borderRadius: 7, background: '#0f172a', border: '1px solid #1e293b' }}>
                      <span style={{ fontSize: 13, color: '#94a3b8' }}>Actual scenario P&L: </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: scenarioNetPnl >= 0 ? '#22c55e' : '#ef4444' }}>{fmt$(scenarioNetPnl)}</span>
                    </div>
                  </div>

                  {/* Histogram */}
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>Distribution of simulated 60-day P&L outcomes ({iterations.toLocaleString()} paths)</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={dist.bins} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} interval={Math.floor(dist.bins.length / 8)} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v <= -1000 ? '-'+(Math.abs(v)/1000).toFixed(0)+'k' : v}`} />
                      <YAxis tick={{ fontSize: 12, fill: '#64748b' }} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, fontSize: 12 }}
                        formatter={(v, n, props) => [`${v} paths (${(v/iterations*100).toFixed(1)}%)`, `$${props.payload.from} to $${props.payload.to}`]}
                        labelFormatter={() => ''} />
                      <ReferenceLine x={0} stroke="#64748b" />
                      <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                        {dist.bins.map((b, i) => <Cell key={i} fill={b.from >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.7} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>

                  <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
                    Method: bootstrap resampling — randomly draws {mcResult.dailyPnls.length} daily P&Ls with replacement, 5,000 times.
                    A left-skewed distribution with p5 deeply negative means the strategy is fragile to bad luck runs.
                    The actual result ({fmt$(scenarioNetPnl)}) should sit above the median to be meaningful.
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

    </div>
  );
}
