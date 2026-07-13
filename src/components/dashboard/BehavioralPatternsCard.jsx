import React, { useState, useEffect, useCallback } from 'react';

const API_URL = '/api';

const DIR_STYLE = {
  LONG:       { color: '#4ade80', bg: 'rgba(34,197,94,0.15)',  label: 'LONG'    },
  SHORT:      { color: '#f87171', bg: 'rgba(239,68,68,0.15)',  label: 'SHORT'   },
  WITH_TREND: { color: '#c4b5fd', bg: 'rgba(139,92,246,0.15)', label: 'TREND↗'  },
  REVERSE:    { color: '#fbbf24', bg: 'rgba(245,158,11,0.15)', label: 'FADE'    },
};

const WR_TIERS = [65, 70, 75];
const STRONG_WR = 70; // 70%+ = actionable; 65-69% = context

const DOW_LABEL = { 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri' };

// Does today's context satisfy this pattern's required conditions?
// Returns: 'yes' | 'partial' | 'no'
function matchToday(req, ctx) {
  const checks = [];

  if (req.dow != null)
    checks.push(ctx.dow === req.dow ? 1 : 0);

  if (req.day_type && ctx.dayType)
    checks.push(ctx.dayType === req.day_type ? 1 : 0);

  if (req.morning_dir && ctx.firstHourDir)
    checks.push(ctx.firstHourDir === req.morning_dir ? 1 : 0);

  if (req.a_signal && (ctx.aUpFired || ctx.aDownFired)) {
    const sig = ctx.aUpFired ? 'UP' : ctx.aDownFired ? 'DOWN' : 'NONE';
    checks.push(sig === req.a_signal ? 1 : 0);
  }

  if (req.overnight_inv && ctx.overnight_inventory)
    checks.push(ctx.overnight_inventory === req.overnight_inv ? 1 : 0);

  if (req.open_vs_value && ctx.open_vs_prior_value)
    checks.push(ctx.open_vs_prior_value === req.open_vs_value ? 1 : 0);

  // IB break direction (IB_ABOVE / IB_BELOW)
  if (req.ib_break && ctx.ibBreak)
    checks.push(ctx.ibBreak === req.ib_break ? 1 : 0);

  // Efficiency tier
  if (req.efficiency_tier && ctx.efficiencyTier)
    checks.push(ctx.efficiencyTier === req.efficiency_tier ? 1 : 0);

  if (!checks.length) return 'partial'; // no checkable conditions
  if (checks.every(c => c === 1)) return 'yes';
  if (checks.some(c => c === 0)) return 'no';
  return 'partial';
}

// Is the current ET minute inside this pattern's time window?
function isWindowActive(req, etMin) {
  const start = req.time_window_start;
  const end   = req.time_window_end;
  if (start == null || end == null) return false;
  return etMin >= start && etMin < end;
}

function conditionChips(req, ctx) {
  const chips = [];
  const known = {
    dow: ctx.dow,
    day_type: ctx.dayType,
    morning_dir: ctx.firstHourDir,
    a_signal: ctx.aUpFired ? 'UP' : ctx.aDownFired ? 'DOWN' : null,
    overnight_inv: ctx.overnight_inventory,
    open_vs_value: ctx.open_vs_prior_value,
  };

  const add = (key, val, display) => {
    const matches = known[key] != null ? known[key] === val : null;
    chips.push({ label: display, matches });
  };

  if (req.dow != null)       add('dow',           req.dow,           DOW_LABEL[req.dow] || `DOW${req.dow}`);
  if (req.day_type)          add('day_type',       req.day_type,      req.day_type);
  if (req.a_signal)          add('a_signal',       req.a_signal,      `A-${req.a_signal}`);
  if (req.overnight_inv)     add('overnight_inv',  req.overnight_inv, req.overnight_inv.replace('_TRAPPED','⚠').replace('NEUTRAL','NEUT'));
  if (req.open_vs_value)     add('open_vs_value',  req.open_vs_value, req.open_vs_value.replace('_VALUE','').replace('ABOVE','↑VA').replace('BELOW','↓VA').replace('INSIDE','=VA'));
  if (req.morning_dir)       add('morning_dir',    req.morning_dir,   `AM ${req.morning_dir}`);

  return chips;
}

export default function BehavioralPatternsCard() {
  const [patterns, setPatterns] = useState([]);
  const [ctx, setCtx]           = useState({});
  const [minWr, setMinWr]       = useState(75);
  const [loading, setLoading]   = useState(true);

  const load = useCallback(async () => {
    try {
      // min_wr=0 so we always get all patterns — we filter client-side and show everything
      const [pRes, todRes, ctxRes, arRes] = await Promise.all([
        fetch(`${API_URL}/behavioral-patterns?min_wr=0`).then(r => r.json()),
        fetch(`${API_URL}/behavioral-patterns?min_wr=0&signal_type=TOD_PATTERN`).then(r => r.json()).catch(() => ({ patterns: [] })),
        fetch(`${API_URL}/antigravity/edges-context`).then(r => r.json()),
        fetch(`${API_URL}/auction-read/today`).then(r => r.json()).catch(() => ({})),
      ]);

      const parseNotes = (p) => ({
        ...p,
        notes: typeof p.notes === 'string'
          ? (() => { try { return JSON.parse(p.notes); } catch { return {}; } })()
          : (p.notes || {}),
      });

      // Merge SESSION_BIAS + TOD_PATTERN, dedup by signal_name
      const allRaw = [...(pRes.patterns || []), ...(todRes.patterns || [])];
      const seen = new Set();
      const merged = allRaw.map(parseNotes).filter(p => {
        if (seen.has(p.signal_name)) return false;
        seen.add(p.signal_name);
        return true;
      });
      setPatterns(merged);

      const sp  = ctxRes?.sessionPermissions || {};
      const acd = ctxRes?.acd || {};
      const now = new Date();
      const etMin = (now.getUTCHours() - 4) * 60 + now.getUTCMinutes();

      // IB break: if price closed above OR high at IB close → IB_ABOVE, below OR low → IB_BELOW
      let ibBreak = null;
      if (etMin >= 630) { // after 10:30 AM IB close
        if (sp.ibBreakDir === 'ABOVE' || acd.ib_break === 'IB_ABOVE') ibBreak = 'IB_ABOVE';
        else if (sp.ibBreakDir === 'BELOW' || acd.ib_break === 'IB_BELOW') ibBreak = 'IB_BELOW';
      }

      setCtx({
        dayType:             sp.dayType || null,
        aUpFired:            sp.aUpFired || false,
        aDownFired:          sp.aDownFired || false,
        firstHourDir:        sp.firstHourDir || null,
        overnight_inventory: arRes.overnight_inventory || null,
        open_vs_prior_value: arRes.open_vs_prior_value || null,
        ibBreak,
        efficiencyTier:      sp.efficiencyTier || null,
        dow:                 now.getDay(),
        etMin,
      });
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 120000); return () => clearInterval(iv); }, [load]);

  const filtered = patterns.filter(p => Math.round((p.win_rate || 0) * 100) >= minWr);

  // Annotate each pattern with match status, time-window activity, and sort
  const annotated = filtered.map(p => {
    const req       = p.notes?.requires || {};
    const match     = matchToday(req, ctx);
    const inWindow  = isWindowActive(req, ctx.etMin);
    return { ...p, _match: match, _req: req, _inWindow: inWindow };
  }).sort((a, b) => {
    // 1) Active time window first
    if (a._inWindow !== b._inWindow) return a._inWindow ? -1 : 1;
    // 2) Then by context match quality
    const rank = { yes: 0, partial: 1, no: 2 };
    if (rank[a._match] !== rank[b._match]) return rank[a._match] - rank[b._match];
    // 3) Then by WR desc
    return b.win_rate - a.win_rate;
  });

  const validToday  = annotated.filter(p => p._match === 'yes').length;
  const activeNow   = annotated.filter(p => p._inWindow && p._match === 'yes').length;

  if (loading || !annotated.length) return null;

  return (
    <div style={{
      padding: '10px 12px',
      background: 'rgba(15,23,42,0.55)',
      border: '1px solid rgba(51,65,85,0.5)',
      borderRadius: 6,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 6 }}>
          Pattern Library
          {activeNow > 0 && (
            <span style={{ fontSize: 10, color: '#fbbf24', background: 'rgba(251,191,36,0.15)', padding: '2px 7px', borderRadius: 3, fontWeight: 800, border: '1px solid rgba(251,191,36,0.3)', animation: 'pulse 1.5s infinite' }}>
              ⚡ {activeNow} LIVE NOW
            </span>
          )}
          {activeNow === 0 && validToday > 0 && (
            <span style={{ fontSize: 10, color: '#4ade80', background: 'rgba(34,197,94,0.12)', padding: '2px 6px', borderRadius: 3, fontWeight: 700 }}>
              {validToday} match today
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {WR_TIERS.map(t => (
            <button key={t} onClick={() => setMinWr(t)} style={{
              padding: '2px 8px', fontSize: 11, fontWeight: 600, borderRadius: 3, cursor: 'pointer', border: 'none',
              background: minWr === t ? '#334155' : 'rgba(51,65,85,0.3)',
              color: minWr === t ? '#f1f5f9' : '#64748b',
            }}>{t}%+</button>
          ))}
        </div>
      </div>

      {/* Pattern rows */}
      {annotated.map((p, i) => {
        const req       = p._req;
        const wr        = Math.round((p.win_rate || 0) * 100);
        const isStrong  = wr >= STRONG_WR;
        const ds        = DIR_STYLE[p.recommendation] || DIR_STYLE.LONG;
        const chips     = conditionChips(req, ctx);
        const winLabel  = req.time_window_label || '';
        const isValid   = p._match === 'yes';
        const isNo      = p._match === 'no';
        const isActive  = p._inWindow && isValid; // currently in the time window AND conditions met

        return (
          <div key={p.id || i} style={{
            padding: '8px 0',
            borderBottom: i < annotated.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
            opacity: isNo ? 0.28 : isStrong ? 1 : 0.72,
            paddingLeft: 8,
            borderLeft: isActive
              ? '3px solid #fbbf24'
              : isValid
                ? '2px solid rgba(34,197,94,0.5)'
                : '2px solid transparent',
            marginLeft: -2,
            background: isActive ? 'rgba(251,191,36,0.05)' : 'transparent',
            borderRadius: isActive ? '0 4px 4px 0' : 0,
          }}>
            {/* Row 1: label + WR badge */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: isStrong ? 700 : 500, color: isActive ? '#fde68a' : isStrong ? '#e2e8f0' : '#94a3b8' }}>
                  {winLabel || p.signal_name}
                </span>
                {isActive && (
                  <span style={{ fontSize: 10, fontWeight: 800, color: '#fbbf24', background: 'rgba(251,191,36,0.15)', padding: '1px 6px', borderRadius: 3, letterSpacing: '0.05em', border: '1px solid rgba(251,191,36,0.3)' }}>
                    ⚡ NOW
                  </span>
                )}
                {!isActive && isValid && (
                  <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 700, letterSpacing: '0.05em' }}>✓ TODAY</span>
                )}
                {!isStrong && !isActive && (
                  <span style={{ fontSize: 10, color: '#64748b', background: 'rgba(100,116,139,0.15)', padding: '1px 5px', borderRadius: 3, fontWeight: 600 }}>context</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{
                  fontSize: 14, fontWeight: 800, color: ds.color, background: ds.bg,
                  padding: '2px 8px', borderRadius: 4, letterSpacing: '0.02em',
                }}>
                  {wr}% {ds.label}
                </span>
                <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 32 }}>N={p.sample_size}</span>
              </div>
            </div>

            {/* Row 2: condition chips */}
            {chips.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 3 }}>
                {chips.map((chip, ci) => (
                  <span key={ci} style={{
                    fontSize: 11, fontWeight: 600,
                    padding: '2px 6px', borderRadius: 3,
                    color: chip.matches === true ? '#4ade80' : chip.matches === false ? '#f87171' : '#94a3b8',
                    background: chip.matches === true ? 'rgba(34,197,94,0.12)' : chip.matches === false ? 'rgba(239,68,68,0.1)' : 'rgba(100,116,139,0.15)',
                  }}>
                    {chip.label}
                  </span>
                ))}
              </div>
            )}

            {/* Row 3: action note */}
            {p.notes?.action && (isValid || isStrong) && (
              <div style={{ fontSize: 12, color: isActive ? '#fde68a' : '#94a3b8', lineHeight: 1.4 }}>
                → {p.notes.action}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: '#64748b', marginTop: 6, textAlign: 'right' }}>
        {annotated.filter(p => Math.round(p.win_rate*100) >= STRONG_WR).length} actionable · {annotated.filter(p => Math.round(p.win_rate*100) < STRONG_WR).length} context · N≥30 · mined weekly
      </div>
    </div>
  );
}
