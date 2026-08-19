import React, { useState, useEffect, useMemo, useRef } from 'react';
import { formatNumber, fmtP } from '../utils/format.js';
import WeeklyReportPanel from '../components/dashboard/WeeklyReportPanel.jsx';
import { SETUP_DISPLAY_LABELS, CAL_SETUP_SHORT_LABELS, SETUP_RESOLUTION_TEXT } from '../constants/setupDisplay.js';
import { getSetupConviction } from '../utils/setupConviction.js';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

import { API_URL } from '../constants/api.js';
import { inferDirection } from '../../server/config/setupTypes.js';

function CalendarView({ accounts, selectedAccounts, setSelectedAccounts }) {
  const [dailyLogs, setDailyLogs] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [modalTrades, setModalTrades] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [weekExpanded, setWeekExpanded] = useState({});
  const [weeklyAssessments, setWeeklyAssessments] = useState({});
  const [selectedWeekReport, setSelectedWeekReport] = useState(null);

  useEffect(() => {
    const y = currentMonth.getFullYear();
    const m = currentMonth.getMonth();
    const dim = new Date(y, m + 1, 0).getDate();
    const startDate = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const endDate   = `${y}-${String(m+1).padStart(2,'0')}-${String(dim).padStart(2,'0')}`;
  }, [currentMonth]);

  useEffect(() => {
    const qs = selectedAccounts.length > 0
      ? `?accounts=${selectedAccounts.map(encodeURIComponent).join(',')}`
      : '';
    fetch(`${API_URL}/daily-logs${qs}`)
      .then(r => r.json())
      .then(setDailyLogs)
      .catch(console.error);
  }, [selectedAccounts]);

  useEffect(() => {
    fetch(`${API_URL}/weekly/assessments`)
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d)) return;
        const map = {};
        d.forEach(w => { map[w.week_start] = w; });
        setWeeklyAssessments(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!accountDropdownOpen) return;
    const close = (e) => { if (!e.target.closest('.account-dropdown')) setAccountDropdownOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [accountDropdownOpen]);

  const toggleAccount = (account) => {
    setSelectedAccounts(prev =>
      prev.includes(account) ? prev.filter(a => a !== account) : [...prev, account]
    );
  };

  const openDayModal = async (dateStr, log, openToChart = false) => {
    if (!log) return;
    setSelectedDay({ dateStr, log, openToChart });
    setModalTrades([]);
    setModalLoading(true);
    try {
      const res = await fetch(`${API_URL}/trades/${dateStr}`);
      setModalTrades(await res.json());
    } catch (e) { console.error(e); }
    finally { setModalLoading(false); }
  };

  const handleDayClick = (dateStr, log) => openDayModal(dateStr, log, false);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const logsByDate = {};
  dailyLogs.forEach(log => {
    const d = new Date(log.log_date);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    logsByDate[key] = log;
  });

  const cells = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - firstDow + 1;
    if (dayNum < 1 || dayNum > daysInMonth) return null;
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    return { dayNum, dateStr, log: logsByDate[dateStr] || null };
  });

  const todayStr = new Date().toLocaleDateString('en-CA');
  const monthLabel = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const monthPrefix = `${year}-${String(month+1).padStart(2,'0')}-`;
  const monthDayLogs = Object.entries(logsByDate)
    .filter(([k]) => k.startsWith(monthPrefix))
    .map(([, v]) => v);
  const monthTradingDays = monthDayLogs.filter(l => parseInt(l.trade_count) > 0).length;
  const monthTotalPnl = monthDayLogs.reduce((s, l) => s + parseFloat(l.daily_pnl || 0), 0);
  const monthAvgPerDay = monthTradingDays > 0 ? monthTotalPnl / monthTradingDays : 0;

  return (
    <div className="calendar-view">
      <header className="page-header"><h1>Trading Calendar</h1></header>

      <div className="cal-toolbar">
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}>‹</button>
          <span className="cal-month-label">{monthLabel}</span>
          <button className="cal-nav-btn" onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="account-dropdown">
            <button className="account-dropdown-trigger" onClick={() => setAccountDropdownOpen(o => !o)}>
              {selectedAccounts.length === 0 || selectedAccounts.length === accounts.length
                ? 'All Accounts'
                : selectedAccounts.length === 1
                  ? selectedAccounts[0]
                  : `${selectedAccounts.length} accounts`}
              <span style={{ marginLeft: 6 }}>▾</span>
            </button>
            {accountDropdownOpen && (
              <div className="account-dropdown-menu">
                <label className="account-option">
                  <input type="checkbox"
                    checked={accounts.length > 0 && accounts.every(a => selectedAccounts.includes(a))}
                    onChange={() => setSelectedAccounts(s => accounts.every(a => s.includes(a)) ? [] : [...accounts])}
                  />
                  All Accounts
                </label>
                {(() => {
                  const isLiveAcct = a => !a.includes('TEST') && !a.includes('PRACTICE') && !a.includes('TFDRA') && !a.includes('BX') && !a.includes('S1');
                  const live = accounts.filter(isLiveAcct);
                  const sim  = accounts.filter(a => !isLiveAcct(a));
                  return (
                    <>
                      {live.length > 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '6px 12px 2px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</div>}
                      {live.map(a => (
                        <label key={a} className="account-option" style={{ color: 'var(--accent-green)' }}>
                          <input type="checkbox" checked={selectedAccounts.includes(a)} onChange={() => toggleAccount(a)} />
                          {a}
                        </label>
                      ))}
                      {sim.length > 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '6px 12px 2px', textTransform: 'uppercase', letterSpacing: '0.06em', borderTop: '1px solid var(--border-color)', marginTop: 4 }}>Evaluation / Sim</div>}
                      {sim.map(a => (
                        <label key={a} className="account-option">
                          <input type="checkbox" checked={selectedAccounts.includes(a)} onChange={() => toggleAccount(a)} />
                          {a}
                        </label>
                      ))}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
          {selectedAccounts.length > 0 && selectedAccounts.length < accounts.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
              <span>{selectedAccounts[0]}</span>
              {selectedAccounts.length > 1 && (
                <>
                  {accountsExpanded && selectedAccounts.slice(1).map(a => (
                    <React.Fragment key={a}>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                      <span>{a}</span>
                    </React.Fragment>
                  ))}
                  <button
                    onClick={() => setAccountsExpanded(e => !e)}
                    style={{ fontSize: 13, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                  >
                    {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {monthTradingDays > 0 && (
        <div className="cal-monthly-summary">
          <span className="cal-monthly-label">{monthLabel.toUpperCase()}</span>
          <span className="cal-monthly-sep">·</span>
          <span>{monthTradingDays} trading {monthTradingDays === 1 ? 'day' : 'days'}</span>
          <span className="cal-monthly-sep">·</span>
          <span>P&L: <span className={monthTotalPnl >= 0 ? 'positive' : 'negative'}>{monthTotalPnl >= 0 ? '+' : ''}${formatNumber(monthTotalPnl, 0)}</span></span>
          <span className="cal-monthly-sep">·</span>
          <span>Avg: <span className={monthAvgPerDay >= 0 ? 'positive' : 'negative'}>{monthAvgPerDay >= 0 ? '+' : ''}${formatNumber(monthAvgPerDay, 0)}/day</span></span>
        </div>
      )}

      <div className="cal-grid">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} className="cal-dow">{d}</div>
        ))}
        {[0,1,2,3,4,5].map(weekIdx => {
          const weekCells = cells.slice(weekIdx * 7, weekIdx * 7 + 7);
          if (weekCells.every(c => c === null)) return null;

          const weekLogs = weekCells.filter(c => c !== null && c.log && parseInt(c.log.trade_count) > 0).map(c => c.log);
          const weekTradingDays = weekLogs.length;
          const weekPnl = weekLogs.reduce((s, l) => s + parseFloat(l.daily_pnl || 0), 0);
          const nonNullCells = weekCells.filter(c => c !== null);
          const weekRangeStart = nonNullCells[0]?.dateStr;
          const weekRangeEnd = nonNullCells[nonNullCells.length - 1]?.dateStr;
          const isExpanded = !!weekExpanded[weekIdx];
          // Compute Monday of this calendar week for weekly_assessments lookup
          const weekKey = (() => {
            if (!weekRangeStart) return null;
            const d = new Date(weekRangeStart + 'T12:00:00');
            const dow = d.getDay(); // 0=Sun,1=Mon,...
            // Monday belonging to THIS calendar row: Sunday (dow=0) -> +1 day forward.
            // Any other weekday (only happens on the first partial week of the month) -> back to Monday.
            d.setDate(d.getDate() + (dow === 0 ? 1 : 1 - dow));
            return d.toLocaleDateString('en-CA');
          })();
          const weekAssessment = weekKey ? weeklyAssessments[weekKey] : null;
          const weekGrade = weekAssessment?.process_grade || null;
          const gradeColor = weekGrade
            ? (weekGrade <= 'B' ? '#22c55e' : weekGrade === 'C' ? '#f59e0b' : '#ef4444')
            : 'var(--text-muted)';

          return (
            <React.Fragment key={`week-${weekIdx}`}>
              {weekCells.map((cell, ci) => {
                if (!cell) return <div key={`empty-${weekIdx}-${ci}`} className="cal-cell cal-empty" />;
                const { dayNum, dateStr, log } = cell;
                const hasActivity = log && parseInt(log.trade_count) > 0;
                const pnl = hasActivity ? parseFloat(log.daily_pnl || 0) : null;
                const cls = ['cal-cell',
                  hasActivity ? (pnl > 0 ? 'cal-win' : pnl < 0 ? 'cal-loss' : 'cal-flat') : '',
                  dateStr === todayStr ? 'cal-today' : '',
                  hasActivity ? 'cal-clickable' : '',
                ].join(' ');
                return (
                  <div key={dateStr} className={cls} onClick={() => hasActivity && handleDayClick(dateStr, log)}>
                    <span className="cal-day-num">{dayNum}</span>
                    {hasActivity && (
                      <>
                        <span className={`cal-day-pnl ${pnl >= 0 ? 'positive' : 'negative'}`}>
                          {pnl >= 0 ? '+' : ''}${formatNumber(pnl, 0)}
                        </span>
                        <span className="cal-trade-count">{log.trade_count}t</span>
                      </>
                    )}
                    {hasActivity && (
                      <button
                        className="cal-intraday-btn"
                        title="View intraday chart"
                        onClick={e => { e.stopPropagation(); openDayModal(dateStr, log, true); }}
                      >📈</button>
                    )}
                  </div>
                );
              })}
              {weekTradingDays > 0 && (
                <div
                  className="cal-week-summary"
                  style={{ gridColumn: '1 / -1' }}
                  onClick={() => setWeekExpanded(prev => ({ ...prev, [weekIdx]: !prev[weekIdx] }))}
                >
                  <span className="cal-week-range">
                    {new Date(weekRangeStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {' – '}
                    {new Date(weekRangeEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="cal-week-sep">·</span>
                  <span>{weekTradingDays} trading {weekTradingDays === 1 ? 'day' : 'days'}</span>
                  <span className="cal-week-sep">·</span>
                  <span>P&L: <span className={weekPnl >= 0 ? 'positive' : 'negative'}>{weekPnl >= 0 ? '+' : ''}${formatNumber(weekPnl, 0)}</span></span>
                  <span className="cal-week-sep">·</span>
                  <span
                    style={{ fontSize: 12, color: gradeColor, cursor: weekGrade ? 'pointer' : 'default', fontWeight: weekGrade ? 700 : 400 }}
                    onClick={weekGrade ? (e) => { e.stopPropagation(); setSelectedWeekReport(weekKey); } : undefined}
                    title={weekGrade ? 'Click to view weekly report' : 'Assessment runs Sunday 6 PM ET'}
                  >
                    {weekGrade ? `Grade: ${weekGrade}` : 'Grade pending'}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              )}
              {isExpanded && weekTradingDays > 0 && (
                <div className="cal-week-detail" style={{ gridColumn: '1 / -1' }}>
                  {weekAssessment?.assessment_text ? (
                    <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: 'var(--text-primary)', fontFamily: '"Courier New", Courier, monospace' }}>
                      {weekAssessment.assessment_text}
                    </pre>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                      {weekGrade ? 'Assessment text not available.' : 'Full weekly assessment generates Sunday at 6 PM ET.'}
                    </span>
                  )}
                  {weekGrade && (
                    <button
                      style={{ marginTop: 8, fontSize: 11, background: 'none', border: `1px solid ${gradeColor}60`, borderRadius: 4, padding: '2px 10px', cursor: 'pointer', color: gradeColor }}
                      onClick={(e) => { e.stopPropagation(); setSelectedWeekReport(weekKey); }}
                    >
                      View full report ›
                    </button>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {selectedWeekReport && (
        <div style={{ marginTop: 24 }}>
          <WeeklyReportPanel
            initialWeekStart={selectedWeekReport}
            key={selectedWeekReport}
          />
          <button
            style={{ fontSize: 11, background: 'none', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-muted)', marginTop: 4 }}
            onClick={() => setSelectedWeekReport(null)}
          >
            Close report
          </button>
        </div>
      )}

      {selectedDay && (
        <DayModal
          day={selectedDay}
          trades={modalTrades}
          loading={modalLoading}
          selectedAccounts={selectedAccounts}
          onClose={() => setSelectedDay(null)}
          openToChart={selectedDay?.openToChart || false}
        />
      )}

    </div>
  );
}


// ==================== INTRADAY CHART SECTION ====================

// Fixed 2026-08-19 (gap_direction_bug_survives_calendarview_and_repair_script): the old
// bare-substring check (type.includes('_UP')) mis-orients any _GAP_UP/_GAP_DOWN
// conditional-variant setup (e.g. WPP_FADE_SHORT_GAP_UP matched "_UP" -> LONG, wrong --
// it's a SHORT). Reuses the canonical inferDirection() (server/config/setupTypes.js,
// already strips the _GAP_(UP|DOWN) suffix before checking) instead of a 3rd local copy.
function isLongSetupType(type) {
  return inferDirection(type) === 'LONG';
}

function IntradayChartSection({ dateStr }) {
  const [bars, setBars] = React.useState([]);
  const [setups, setSetups] = React.useState([]);
  const [levels, setLevels] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [hoveredSetup, setHoveredSetup] = React.useState(null);
  const [hoverBar, setHoverBar] = React.useState(null);
  const [hitRatesData, setHitRatesData] = React.useState(null);

  React.useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API_URL}/chart/live-day?date=${dateStr}`).then(r => r.json()),
      fetch(`${API_URL}/setups/for-date?date=${dateStr}`).then(r => r.json()),
    ]).then(([cd, sd]) => {
      const rth = (cd?.bars || []).filter(b => {
        const t = new Date(b.ts); const h = t.getUTCHours(), m = t.getUTCMinutes();
        return (h === 9 && m >= 30) || (h > 9 && h < 16);
      });
      setBars(rth);
      setSetups(Array.isArray(sd) ? sd : []);
      setLevels(cd?.levels || {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [dateStr]);

  React.useEffect(() => {
    fetch(`${API_URL}/engine-reads/hit-rates`).then(r => r.json()).then(d => { if (!d.error) setHitRatesData(d); }).catch(() => {});
  }, []);

  if (loading) return <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading chart…</div>;
  if (!bars.length) return <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No price bar data for {dateStr}</div>;

  const SVG_W = 900, SVG_H = 380;
  const M = { t: 10, r: 66, b: 22, l: 10 };
  const iW = SVG_W - M.l - M.r;
  const iH = SVG_H - M.t - M.b;

  const ibHigh = levels.ibHigh ? parseFloat(levels.ibHigh) : null;
  const ibLow  = levels.ibLow  ? parseFloat(levels.ibLow)  : null;

  // Domain from bars + IB only — setup T1/stop levels are excluded so they don't compress the bars.
  // pad = barRange * 0.167 makes bars fill ~75% of the chart height.
  const domainPx = bars.flatMap(b => [parseFloat(b.high), parseFloat(b.low)]);
  if (ibHigh) domainPx.push(ibHigh);
  if (ibLow)  domainPx.push(ibLow);
  const rawMin = Math.min(...domainPx), rawMax = Math.max(...domainPx);
  const pad = (rawMax - rawMin) * 0.167;
  const yMin = rawMin - pad, yMax = rawMax + pad;
  const yScale = p => M.t + iH * (1 - (p - yMin) / (yMax - yMin));
  const xScale = i => M.l + (i + 0.5) * (iW / bars.length);
  const barW = Math.max(1, iW / bars.length * 0.65);

  // Map each setup to its arrow position on the chart.
  // Long  ▲ : arrow sits below the bar's low, tip pointing up toward the bar.
  // Short ▼ : arrow sits above the bar's high, tip pointing down toward the bar.
  const setupsPlotted = setups.map(s => {
    const idx = bars.findIndex(b => new Date(b.ts).toISOString().slice(11, 16) === s.fired_time);
    if (idx < 0) return null;
    const isLong = isLongSetupType(s.setup_type);
    const entryPx = isLong
      ? (s.entry_zone_low ?? s.price_at_detection)
      : (s.entry_zone_high ?? s.price_at_detection);
    if (!entryPx) return null;
    const bar = bars[idx];
    // Arrow size scales with conviction
    const aw = s.stars === 3 ? 8 : s.stars === 2 ? 6 : 5;  // half-width
    const ah = s.stars === 3 ? 13 : s.stars === 2 ? 10 : 8; // height
    const gap = 3; // px gap between bar and arrow tip
    const x = xScale(idx);
    // tipY = the pointy end (closest to the bar), baseY = the flat end
    const tipY  = isLong ? yScale(parseFloat(bar.low))  + gap      : yScale(parseFloat(bar.high)) - gap;
    const baseY = isLong ? tipY + ah                               : tipY - ah;
    const color = s.status === 'ACTIVE' ? '#ffffff'
      : s.resolution === 'TARGET_HIT' ? '#4ade80'
      : s.resolution === 'STOP_HIT'   ? '#f87171'
      : '#FFD700';
    // Anchor y for hover hit-testing: midpoint of arrow
    const hitY = (tipY + baseY) / 2;
    return { ...s, x, tipY, baseY, hitY, aw, ah, entryPx, isLong, color, barIdx: idx };
  }).filter(Boolean);

  const handleSvgMouseMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) / rect.width * SVG_W;
    const svgY = (e.clientY - rect.top) / rect.height * SVG_H;
    const idx = Math.round((svgX - M.l) / (iW / bars.length) - 0.5);
    setHoverBar(idx >= 0 && idx < bars.length ? idx : null);
    const hit = setupsPlotted.find(s => Math.abs(s.x - svgX) < 14 && Math.abs(s.hitY - svgY) < 14);
    setHoveredSetup(hit || null);
  };

  return (
    <React.Fragment>
    <div style={{ background: '#0d1117', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden', position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleSvgMouseMove}
        onMouseLeave={() => { setHoverBar(null); setHoveredSetup(null); }}>

        <rect width={SVG_W} height={SVG_H} fill="#0d1117" />

        {/* Grid */}
        {[0.2, 0.4, 0.6, 0.8].map(pct => {
          const y = M.t + iH * pct;
          const price = yMax - (yMax - yMin) * pct;
          return <g key={pct}>
            <line x1={M.l} x2={SVG_W - M.r} y1={y} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
            <text x={SVG_W - M.r + 4} y={y + 4} fill="#64748b" fontSize={9}>{fmtP(price)}</text>
          </g>;
        })}

        {/* IB High / Low lines */}
        {ibHigh && ibHigh > yMin && ibHigh < yMax && (<g>
          <line x1={M.l} x2={SVG_W - M.r} y1={yScale(ibHigh)} y2={yScale(ibHigh)} stroke="#60a5fa" strokeWidth={1.5} opacity={0.8} />
          <text x={SVG_W - M.r + 4} y={yScale(ibHigh) - 3} fill="#60a5fa" fontSize={9} fontWeight="600">IBH {fmtP(ibHigh)}</text>
        </g>)}
        {ibLow && ibLow > yMin && ibLow < yMax && (<g>
          <line x1={M.l} x2={SVG_W - M.r} y1={yScale(ibLow)} y2={yScale(ibLow)} stroke="#60a5fa" strokeWidth={1.5} opacity={0.8} />
          <text x={SVG_W - M.r + 4} y={yScale(ibLow) + 11} fill="#60a5fa" fontSize={9} fontWeight="600">IBL {fmtP(ibLow)}</text>
        </g>)}

        {/* T1 and stop horizontal lines from each setup */}
        {setupsPlotted.map((s, i) => (<g key={`lvl-${i}`}>
          {s.t1_level && s.t1_level > yMin && s.t1_level < yMax && (
            <line x1={s.x} x2={SVG_W - M.r} y1={yScale(s.t1_level)} y2={yScale(s.t1_level)}
              stroke="#4ade80" strokeWidth={1} strokeDasharray="5 3" opacity={0.55} />
          )}
          {s.stop_level && s.stop_level > yMin && s.stop_level < yMax && (
            <line x1={s.x} x2={SVG_W - M.r} y1={yScale(s.stop_level)} y2={yScale(s.stop_level)}
              stroke="#f87171" strokeWidth={1} strokeDasharray="5 3" opacity={0.55} />
          )}
        </g>))}

        {/* Candlesticks */}
        {bars.map((b, i) => {
          const o = parseFloat(b.open), h = parseFloat(b.high), l = parseFloat(b.low), c = parseFloat(b.close);
          const x = xScale(i); const bull = c >= o; const col = bull ? '#26a69a' : '#ef5350';
          return <g key={i}>
            <line x1={x} x2={x} y1={yScale(h)} y2={yScale(l)} stroke={col} strokeWidth={0.8} opacity={0.9} />
            <rect x={x - barW/2} y={Math.min(yScale(o), yScale(c))} width={barW} height={Math.max(1, Math.abs(yScale(o) - yScale(c)))} fill={col} opacity={0.9} />
          </g>;
        })}

        {/* Setup marker arrows — no dots, just arrows */}
        {setupsPlotted.map((s, i) => {
          // Long ▲: tip at top (tipY < baseY), pointing up toward bar
          // Short ▼: tip at bottom (tipY > baseY), pointing down toward bar
          const pts = s.isLong
            ? `${s.x},${s.tipY} ${s.x - s.aw},${s.baseY} ${s.x + s.aw},${s.baseY}`
            : `${s.x},${s.tipY} ${s.x - s.aw},${s.baseY} ${s.x + s.aw},${s.baseY}`;
          const isHovered = hoveredSetup === s;
          const opacity = isHovered ? 1 : 0.88;
          const stroke = isHovered ? '#fff' : 'rgba(255,255,255,0.2)';
          if (s.status === 'ACTIVE') {
            return <polygon key={`arr-${i}`} points={pts} fill={s.color} stroke={stroke} strokeWidth={0.8}>
              <animate attributeName="opacity" values="0.88;0.3;0.88" dur="1.5s" repeatCount="indefinite" />
            </polygon>;
          }
          return <polygon key={`arr-${i}`} points={pts} fill={s.color} opacity={opacity} stroke={stroke} strokeWidth={0.8} />;
        })}

        {/* Hover bar crosshair */}
        {hoverBar !== null && hoverBar < bars.length && (() => {
          const b = bars[hoverBar]; const x = xScale(hoverBar); const c = parseFloat(b.close);
          return <g>
            <line x1={M.l} x2={SVG_W - M.r} y1={yScale(c)} y2={yScale(c)} stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="2 4" />
            <line x1={x} x2={x} y1={M.t} y2={SVG_H - M.b} stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="2 4" />
            <rect x={SVG_W - M.r + 2} y={yScale(c) - 8} width={58} height={16} rx={3} fill="#1e293b" stroke="rgba(100,116,139,0.5)" strokeWidth={1} />
            <text x={SVG_W - M.r + 6} y={yScale(c) + 4} fill="#e2e8f0" fontSize={9} fontFamily="monospace">{c.toFixed(2)}</text>
            <rect x={x - 20} y={SVG_H - M.b + 2} width={40} height={14} rx={3} fill="#1e293b" stroke="rgba(100,116,139,0.5)" strokeWidth={1} />
            <text x={x} y={SVG_H - M.b + 12} fill="#94a3b8" fontSize={8} textAnchor="middle">{new Date(b.ts).toISOString().slice(11, 16)}</text>
          </g>;
        })()}

        {/* X-axis time labels */}
        {bars.map((b, i) => {
          const t = new Date(b.ts).toISOString().slice(11, 16);
          if (!t.endsWith(':00') && !t.endsWith(':30')) return null;
          return <text key={i} x={xScale(i)} y={SVG_H - 6} fill="#64748b" fontSize={8} textAnchor="middle">{t}</text>;
        })}
      </svg>

      {/* Setup hover tooltip */}
      {hoveredSetup && (
        <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(15,23,42,0.96)', border: '1px solid rgba(100,116,139,0.5)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#e2e8f0', minWidth: 190, zIndex: 20, pointerEvents: 'none', backdropFilter: 'blur(4px)' }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: hoveredSetup.color, fontSize: 13 }}>
            {(SETUP_DISPLAY_LABELS[hoveredSetup.setup_type] || hoveredSetup.setup_type.replace(/_/g,' '))}
            {hoveredSetup.stars > 0 && <span style={{ marginLeft: 6 }}>{'★'.repeat(hoveredSetup.stars)}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px' }}>
            <span style={{ color: '#94a3b8' }}>Fired</span><span style={{ fontFamily: 'monospace' }}>{hoveredSetup.fired_time} ET</span>
            <span style={{ color: '#94a3b8' }}>Entry</span><span style={{ fontFamily: 'monospace' }}>{fmtP(hoveredSetup.entryPx, 2)}</span>
            {hoveredSetup.stop_level != null && <><span style={{ color: '#94a3b8' }}>Stop</span><span style={{ color: '#f87171', fontFamily: 'monospace' }}>{fmtP(hoveredSetup.stop_level, 2)}</span></>}
            {hoveredSetup.t1_level != null && <><span style={{ color: '#94a3b8' }}>{hoveredSetup.t1_label || 'T1'}</span><span style={{ color: '#4ade80', fontFamily: 'monospace' }}>{fmtP(hoveredSetup.t1_level, 2)}</span></>}
            <span style={{ color: '#94a3b8' }}>Result</span><span style={{ color: hoveredSetup.color }}>{hoveredSetup.resolution || hoveredSetup.status || '—'}</span>
          </div>
        </div>
      )}

      {/* Setup legend below chart */}
      {setupsPlotted.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderTop: '1px solid rgba(100,116,139,0.15)' }}>
          {setupsPlotted.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8' }}>
              <span style={{ fontSize: 11, color: s.color }}>{s.isLong ? '▲' : '▼'}</span>
              <span style={{ color: s.color }}>{CAL_SETUP_SHORT_LABELS[s.setup_type] || s.setup_type}</span>
              <span>{s.fired_time}</span>
              {s.stars > 0 && <span style={{ color: '#f59e0b' }}>{'★'.repeat(s.stars)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>

    {/* All setups for the day — full list, chronological */}
    {setups.length > 0 && (
      <div style={{ marginTop: 12, background: 'var(--card-bg)', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid rgba(100,116,139,0.15)' }}>
          All Setups ({setups.length})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {[...setups].sort((a, b) => (a.fired_time || '').localeCompare(b.fired_time || '')).map((s, i) => {
            const isLong = isLongSetupType(s.setup_type);
            const label = SETUP_DISPLAY_LABELS[s.setup_type] || s.setup_type.replace(/_/g, ' ');
            const isLive = s.status === 'ACTIVE';
            const resInfo = SETUP_RESOLUTION_TEXT[s.resolution] || null;
            const conviction = getSetupConviction(s.setup_type, hitRatesData, 'NEUTRAL');
            const fmtPx = v => v != null ? fmtP(parseFloat(v), 2) : '—';
            return (
              <div key={s.id || i} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', flexWrap: 'wrap',
                borderBottom: i < setups.length - 1 ? '1px solid rgba(100,116,139,0.1)' : 'none',
              }}>
                <span style={{ fontSize: 13, color: isLong ? '#4ade80' : '#f87171', minWidth: 14 }}>{isLong ? '▲' : '▼'}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', minWidth: 160 }}>{label}</span>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#94a3b8' }}>
                  E {fmtPx(s.entry_zone_low ?? s.price_at_detection)}
                  {s.entry_zone_high != null && s.entry_zone_high !== s.entry_zone_low ? `–${fmtPx(s.entry_zone_high)}` : ''}
                  {' · '}<span style={{ color: '#f87171' }}>S {fmtPx(s.stop_level)}</span>
                  {' · '}<span style={{ color: '#4ade80' }}>{s.t1_label || 'T1'} {fmtPx(s.t1_level)}</span>
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                  {conviction.tracked && (
                    <span style={{ fontSize: 11, color: '#94a3b8' }} title={conviction.note}>
                      {conviction.confident ? `${conviction.hitRate}% n=${conviction.n}` : `limited sample (n=${conviction.n || 0})`}
                    </span>
                  )}
                  {isLive ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', borderRadius: 4, padding: '2px 8px', letterSpacing: '0.06em' }}>LIVE</span>
                  ) : resInfo ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: resInfo.color, background: `${resInfo.color}1a`, border: `1px solid ${resInfo.color}66`, borderRadius: 4, padding: '2px 8px', letterSpacing: '0.06em' }}>{resInfo.label}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>
                  )}
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#94a3b8' }}>{s.fired_time} ET</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    )}
    </React.Fragment>
  );
}

// ── Client-side image resize + upload helper ──────────────────────────────────
// Draws to canvas (max 1200px wide), exports as JPEG ~80% quality → ~200KB target.
// No server-side image processing needed.
async function resizeAndUploadAnnotationImage(file, dateStr) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_W = 1200;
      const scale = img.width > MAX_W ? MAX_W / img.width : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        const fd = new FormData();
        fd.append('file', blob, 'chart.jpg');
        fetch(`${API_URL}/annotations/upload-image?date=${dateStr}`, { method: 'POST', body: fd })
          .then(r => r.json())
          .then(d => d.path ? resolve(d.path) : reject(new Error(d.error || 'Upload failed')))
          .catch(reject);
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image load failed')); };
    img.src = objectUrl;
  });
}

// ── AnnotationBlock — inline per-session annotation editor ───────────────────
function AnnotationBlock({ dateStr, groupKey, tradeIds, existing, isEditing, onStartEdit, onCancelEdit, onSaved, onDeleted }) {
  const [text, setText] = useState(existing?.annotation_text || '');
  const [setupType, setSetupType] = useState(existing?.setup_type || '');
  const [contextMarker, setContextMarker] = useState(existing?.context_marker || 'planned');
  const [imagePath, setImagePath] = useState(existing?.image_path || null);
  const [imagePreview, setImagePreview] = useState(existing?.image_path ? `/uploads/${existing.image_path}` : null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Sync draft when editing starts on an existing annotation
  useEffect(() => {
    if (isEditing) {
      setText(existing?.annotation_text || '');
      setSetupType(existing?.setup_type || '');
      setContextMarker(existing?.context_marker || 'planned');
      setImagePath(existing?.image_path || null);
      setImagePreview(existing?.image_path ? `/uploads/${existing.image_path}` : null);
    }
  }, [isEditing, groupKey]);

  const handleImageSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const path = await resizeAndUploadAnnotationImage(file, dateStr);
      setImagePath(path);
      setImagePreview(`/uploads/${path}`);
    } catch (err) {
      console.error('Image upload failed', err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSave = async () => {
    if (!text.trim() && !imagePath) return;
    setSaving(true);
    try {
      const body = { trade_date: dateStr, trade_ids: tradeIds, annotation_text: text.trim() || null, setup_type: setupType.trim() || null, context_marker: contextMarker, image_path: imagePath || null };
      let resp;
      if (existing?.id) {
        resp = await fetch(`${API_URL}/annotations/${existing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        resp = await fetch(`${API_URL}/annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      const d = await resp.json();
      if (d.annotation) onSaved(d.annotation);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!existing?.id) { onCancelEdit(); return; }
    await fetch(`${API_URL}/annotations/${existing.id}`, { method: 'DELETE' });
    onDeleted(existing.id);
  };

  const removeImage = () => { setImagePath(null); setImagePreview(null); };

  // Display mode — annotation exists, not editing
  if (!isEditing && existing) {
    return (
      <div className="ann-display">
        <div className="ann-display-meta">
          <span className={`ann-marker ann-marker-${existing.context_marker}`}>
            {existing.context_marker === 'planned' ? 'Planned' : 'Reaction'}
          </span>
          {existing.setup_type && <span className="ann-setup-chip">{existing.setup_type}</span>}
          <button className="ann-edit-btn" onClick={onStartEdit}>Edit</button>
          <button className="ann-delete-btn" onClick={handleDelete}>×</button>
        </div>
        {existing.annotation_text && (
          <div className="ann-display-text">{existing.annotation_text}</div>
        )}
        {existing.image_path && (
          <div className="ann-image-thumb-wrap">
            <img
              src={`/uploads/${existing.image_path}`}
              alt="Chart"
              className="ann-image-thumb"
              onClick={() => setLightboxOpen(true)}
            />
            {lightboxOpen && (
              <div className="ann-lightbox" onClick={() => setLightboxOpen(false)}>
                <img src={`/uploads/${existing.image_path}`} alt="Chart full" className="ann-lightbox-img" />
                <span className="ann-lightbox-hint">click to close</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Add-note button — no annotation, not editing
  if (!isEditing && !existing) {
    return (
      <button className="ann-add-btn" onClick={onStartEdit}>+ note</button>
    );
  }

  // Edit/create mode
  return (
    <div className="ann-editor">
      <textarea
        className="ann-textarea"
        placeholder="What I saw / why I took it…"
        value={text}
        onChange={e => setText(e.target.value)}
        rows={3}
        autoFocus
      />
      <div className="ann-editor-row">
        <input
          className="ann-setup-input"
          placeholder="Setup type (free text)"
          value={setupType}
          onChange={e => setSetupType(e.target.value)}
          maxLength={120}
        />
        <div className="ann-context-toggle">
          <button
            className={`ann-ctx-btn${contextMarker === 'planned' ? ' active' : ''}`}
            onClick={() => setContextMarker('planned')}
          >Planned</button>
          <button
            className={`ann-ctx-btn${contextMarker === 'reaction' ? ' active' : ''}`}
            onClick={() => setContextMarker('reaction')}
          >Reaction</button>
        </div>
      </div>
      <div className="ann-editor-row">
        {imagePreview ? (
          <div className="ann-image-preview-wrap">
            <img src={imagePreview} alt="Preview" className="ann-image-preview" />
            <button className="ann-image-remove" onClick={removeImage} title="Remove image">×</button>
          </div>
        ) : (
          <button className="ann-image-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : '+ Chart image'}
          </button>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageSelect} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="ann-cancel-btn" onClick={onCancelEdit}>Cancel</button>
          <button className="ann-save-btn" onClick={handleSave} disabled={saving || (!text.trim() && !imagePath)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DayModal({ day, trades, loading, selectedAccounts, onClose, openToChart = false }) {
  const { dateStr, log } = day;
  const [highlightedGroup, setHighlightedGroup] = useState(null);
  const rowRefs = useRef({});
  const [localTagEdits, setLocalTagEdits] = useState(new Map());
  const [tagInputValues, setTagInputValues] = useState({});
  const [activeTagGroup, setActiveTagGroup] = useState(null);
  const [crosshair, setCrosshair] = useState(null);
  const [chartHoveredPayload, setChartHoveredPayload] = useState(null);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [coachingData, setCoachingData] = useState(null);
  const [coachingLoading, setCoachingLoading] = useState(true);
  const [coachingRead, setCoachingRead] = useState(false);
  const [aiReview, setAiReview] = useState(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [aiReviewEstimate, setAiReviewEstimate] = useState(null);
  const [modalTab, setModalTab] = useState('TRADES');
  const [persistingFeedback, setPersistingFeedback] = useState(false);
  const [chartExpanded, setChartExpanded] = useState(openToChart);
  const chartSectionRef = useRef(null);
  const [annotations, setAnnotations] = useState([]);
  const [editingGroupKey, setEditingGroupKey] = useState(null);
  const [selectedFillIds, setSelectedFillIds] = useState(new Set());
  const [selectionEditorOpen, setSelectionEditorOpen] = useState(false);

  useEffect(() => {
    if (openToChart && chartSectionRef.current) {
      setTimeout(() => chartSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
    }
  }, [openToChart]);

  const [feedbackLogs, setFeedbackLogs] = React.useState([]);
  useEffect(() => {
    fetch(`${API_URL}/acd/feedback?days=365`)
      .then(r => r.json())
      .then(d => setFeedbackLogs((d.feedback || []).filter(f => f.trade_date === dateStr)))
      .catch(() => {});
  }, [dateStr]);

  useEffect(() => {
    fetch(`${API_URL}/annotations?date=${dateStr}`)
      .then(r => r.json())
      .then(d => setAnnotations(d.annotations || []))
      .catch(() => {});
  }, [dateStr]);

  useEffect(() => {
    setCoachingData(null);
    setCoachingLoading(true);
    setCoachingRead(false);
    fetch(`${API_URL}/calendar/coaching/${dateStr}`)
      .then(r => r.json())
      .then(d => {
        setCoachingData(d.coaching || null);
        setCoachingRead(d.coaching?.coaching_read || false);
      })
      .catch(() => setCoachingData(null))
      .finally(() => setCoachingLoading(false));
    // Load AI setup review — auto-generate if setups exist and no review yet
    setAiReview(null);
    setAiReviewEstimate(null);
    setAiReviewLoading(false);
    fetch(`${API_URL}/playbook/daily-review/${dateStr}`)
      .then(r => r.json())
      .then(d => {
        if (d.exists) {
          setAiReview(d);
        } else {
          // Auto-generate if there are resolved setups for this date
          fetch(`${API_URL}/playbook/daily-review/${dateStr}/estimate`, { method: 'POST' })
            .then(r => r.json())
            .then(est => {
              if (est.setup_count > 0) {
                setAiReviewLoading(true);
                fetch(`${API_URL}/playbook/daily-review/${dateStr}/generate`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ confirmed: true }),
                })
                  .then(r => r.json())
                  .then(d => { if (!d.error) setAiReview(d); })
                  .catch(() => {})
                  .finally(() => setAiReviewLoading(false));
              } else {
                setAiReviewEstimate(est);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [dateStr]);

  // Filter by selected accounts, then deduplicate
  const accountFiltered = selectedAccounts.length === 0
    ? trades
    : trades.filter(t => selectedAccounts.includes(t.custom_fields?.account));

  // No client-side dedup — the import service already prevents DB duplicates via count-based dedup.
  // Client-side dedup was silently dropping valid EP fills that shared prices/times with
  // non-EP fills in the same session (common with scaling positions).
  const fills = [...accountFiltered].sort((a, b) => {
    const timeDiff = new Date(a.entry_time) - new Date(b.entry_time);
    if (timeDiff !== 0) return timeDiff;
    return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
  });

  // Map each fill.id → flat-to-flat group key using EP in Exit DateTime as boundary
  const fillGroupMap = useMemo(() => {
    const map = new Map();
    const bySymDir = new Map();
    fills.forEach(f => {
      const k = `${f.symbol}|${f.direction}`;
      if (!bySymDir.has(k)) bySymDir.set(k, []);
      bySymDir.get(k).push(f);
    });
    bySymDir.forEach((group, symDir) => {
      const sorted = [...group].sort((a, b) => {
        const td = new Date(a.entry_time) - new Date(b.entry_time);
        if (td !== 0) return td;
        return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
      });
      const sessionEndTimes = [...new Set(
        sorted
          .filter(f => {
            const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
            return typeof exitDT === 'string' && exitDT.trimEnd().endsWith('EP');
          })
          .map(f => f.exit_time)
      )].sort();
      const boundaries = sessionEndTimes.length > 0
        ? sessionEndTimes
        : [sorted[sorted.length - 1]?.exit_time].filter(Boolean);
      sorted.forEach(fill => {
        const boundary = boundaries.find(b => new Date(b) >= new Date(fill.exit_time));
        const assignTo = boundary ?? boundaries[boundaries.length - 1];
        map.set(fill.id, `${symDir}|${assignTo}`);
      });
    });
    return map;
  }, [fills]);

  // Map each fill.id → fill label (Entry / Add / Partial Exit / Exit) using BP/EP markers
  const fillLabelMap = useMemo(() => {
    const map = new Map();
    const byGroup = new Map();
    fills.forEach(f => {
      const k = fillGroupMap.get(f.id);
      if (!k) return;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(f);
    });
    byGroup.forEach(group => {
      const sorted = [...group].sort((a, b) => {
        const td = new Date(a.entry_time) - new Date(b.entry_time);
        if (td !== 0) return td;
        return (a.custom_fields?.sierra_row ?? 0) - (b.custom_fields?.sierra_row ?? 0);
      });
      const hasBPEP = sorted.some(f => {
        const sd = f.custom_fields?.sierra_data || {};
        return sd['Entry DateTime']?.includes('BP') || sd['Exit DateTime']?.includes('EP');
      });
      if (hasBPEP) {
        // TAL format: use BP/EP markers + position qty tracking
        let prevCloseQty = 0;
        sorted.forEach(fill => {
          const sd = fill.custom_fields?.sierra_data || {};
          const isBP = !!sd['Entry DateTime']?.includes('BP');
          const isEP = !!sd['Exit DateTime']?.includes('EP');
          const openQty = Math.abs(parseFloat(sd['Open Position Quantity'] ?? 0));
          const closeQty = Math.abs(parseFloat(sd['Close Position Quantity'] ?? 0));
          const isAdd = !isBP && prevCloseQty > 0 && openQty > prevCloseQty;
          prevCloseQty = closeQty;
          map.set(fill.id, isBP ? 'Entry' : isEP ? 'Exit' : (isAdd ? 'Add' : 'Partial Exit'));
        });
      } else {
        // Activity Log format: use OpenClose + position tracking to label fills
        let position = 0;
        sorted.forEach(fill => {
          const openClose = fill.custom_fields?.open_close || fill.custom_fields?.sierra_data?.OpenClose || '';
          const buySell = fill.custom_fields?.buy_sell || fill.custom_fields?.sierra_data?.BuySell || '';
          const qty = fill.quantity || 0;
          const isOpen = openClose === 'Open';
          const isBuy = buySell === 'Buy';
          const posBefore = position;
          position += isBuy ? qty : -qty;
          const posAfter = position;
          let label;
          if (isOpen) {
            label = posBefore === 0 ? 'Entry' : 'Add';
          } else {
            label = posAfter === 0 ? 'Exit' : 'Partial Exit';
          }
          map.set(fill.id, label);
        });
      }
    });
    return map;
  }, [fills, fillGroupMap]);

  // Tags derived from EP fill's tags field per group
  const derivedGroupTags = useMemo(() => {
    const map = new Map();
    fills.forEach(f => {
      const group = fillGroupMap.get(f.id);
      if (!group || map.has(group)) return;
      const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
      if (!exitDT.trimEnd().endsWith('EP')) return;
      const raw = f.tags;
      if (!raw) return;
      const tags = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',').filter(Boolean) : []);
      if (tags.length > 0) map.set(group, tags);
    });
    return map;
  }, [fills, fillGroupMap]);

  const getGroupTags = (group) =>
    localTagEdits.has(group) ? localTagEdits.get(group) : (derivedGroupTags.get(group) || []);

  // Map each groupKey → its annotation (if one exists).
  // An annotation covers a group if any of its trade_ids belong to a fill in that group.
  const annotationByGroup = useMemo(() => {
    const fillIdToGroup = new Map();
    fills.forEach(f => { const g = fillGroupMap.get(f.id); if (g) fillIdToGroup.set(f.id, g); });
    const map = new Map();
    annotations.forEach(ann => {
      for (const tid of ann.trade_ids) {
        const g = fillIdToGroup.get(tid);
        if (g && !map.has(g)) { map.set(g, ann); break; }
      }
    });
    return map;
  }, [annotations, fills, fillGroupMap]);

  const annotatedFillIds = useMemo(() => {
    const s = new Set();
    annotations.forEach(ann => ann.trade_ids.forEach(id => s.add(id)));
    return s;
  }, [annotations]);

  const toggleFillSelect = (id) => {
    setSelectedFillIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const saveGroupTags = async (group, tags) => {
    setLocalTagEdits(prev => new Map(prev).set(group, tags));
    const epFill = fills.find(f => {
      const exitDT = f.custom_fields?.sierra_data?.['Exit DateTime'] || '';
      return fillGroupMap.get(f.id) === group && exitDT.trimEnd().endsWith('EP');
    });
    if (!epFill) return;
    try {
      await fetch(`${API_URL}/trades/${epFill.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: JSON.stringify(tags) }),
      });
    } catch (e) { console.error(e); }
  };

  const addTag = (group, tag) => {
    const current = getGroupTags(group);
    if (!current.includes(tag)) saveGroupTags(group, [...current, tag]);
  };

  const removeTag = (group, tag) => {
    saveGroupTags(group, getGroupTags(group).filter(t => t !== tag));
  };

  // startBalance: 0 for TAL format (chart shows relative intraday P&L)
  const firstFill = fills[0];
  const firstFillBalance = parseFloat(
    firstFill?.custom_fields?.account_balance ||
    firstFill?.custom_fields?.sierra_data?.AccountBalance || 0
  );
  const firstFillPnl = parseFloat(firstFill?.pnl) || 0;
  const startBalance = firstFillBalance > 0 ? firstFillBalance - firstFillPnl : 0;

  // Build LINE data using Cumulative P&L (CumPL) diff — the same source the calendar backend uses.
  // FlatToFlat and SUM(f.pnl) are unreliable across sessions; CumPL is the ground truth.
  // Strategy:
  //   startCumPL = firstEP.CumPL − firstEP.FlatToFlat  (the CumPL before today's trading)
  //   intradayCumPnl at each EP = startBalance + (EP.CumPL − startCumPL)
  // FlatToFlat Profit/Loss (C) accumulates within a session.
  // Only the EP row gets the "F" suffix, marking the FINAL session P&L.
  // Sum those "F" values in time order → intraday cumulative P&L (verified = -$652).
  const getFtfStr = f => String(
    f.custom_fields?.sierra_data?.['FlatToFlat Profit/Loss (C)'] ||
    f.custom_fields?.flat_to_flat_pl || ''
  ).trim();
  const isFinalFill = f => getFtfStr(f).toUpperCase().endsWith('F');
  const parseFtf = f => parseFloat(getFtfStr(f).replace(/\s*F$/i, '')) || 0;

  const epFillsSorted = fills
    .filter(isFinalFill)
    .sort((a, b) => new Date(a.exit_time) - new Date(b.exit_time));

  const exitPoints = [];
  const epSessionPnlMap = new Map(); // epFill.id → session P&L

  // Helper to read Cumulative P&L from a fill
  const parseCumPL = f => {
    const v = f.custom_fields?.sierra_data?.['Cumulative Profit/Loss (C)'] ||
      f.custom_fields?.cumulative_pl;
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  // CumPL is per-account — can't mix values from multiple accounts on the same chart.
  const isMultiAccount = new Set(fills.map(f => f.custom_fields?.account).filter(Boolean)).size > 1;

  if (epFillsSorted.length > 0) {
    // Build epSessionPnlMap from "F" fills (accurate per-session P&L for dots/tooltips)
    epFillsSorted.forEach(f => epSessionPnlMap.set(f.id, parseFtf(f)));

    if (!isMultiAccount) {
      // Single account: use CumPL for detailed intra-session line
      const firstEPCumPL = parseCumPL(epFillsSorted[0]);
      const startCumPL = firstEPCumPL != null
        ? firstEPCumPL - parseFtf(epFillsSorted[0])
        : null;

      if (startCumPL != null) {
        // Use ALL fills' CumPL for the line — shows adds and partial exits within each session.
        [...fills]
          .sort((a, b) => new Date(a.exit_time) - new Date(b.exit_time))
          .forEach(f => {
            const cumPL = parseCumPL(f);
            if (cumPL == null) return;
            exitPoints.push({
              time: new Date(f.exit_time).getTime(),
              cumPnl: startBalance + (cumPL - startCumPL),
              isEntry: false,
              trade: f,
            });
          });
      } else {
        // CumPL not available — fall back to EP-only steps
        let running = startBalance;
        epFillsSorted.forEach(f => {
          running += parseFtf(f);
          exitPoints.push({ time: new Date(f.exit_time).getTime(), cumPnl: running, isEntry: false, trade: f });
        });
      }
    } else {
      // Multi-account: CumPL values are per-account and can't be mixed.
      // Sum FlatToFlat session P&Ls across all accounts in time order.
      let running = 0;
      epFillsSorted.forEach(f => {
        running += parseFtf(f);
        exitPoints.push({ time: new Date(f.exit_time).getTime(), cumPnl: running, isEntry: false, trade: f });
      });
    }
  } else {
    // Fallback for non-TAL format (no F marker): sum all fill pnls
    let running = startBalance;
    fills.forEach(f => {
      running += parseFloat(f.pnl) || 0;
      exitPoints.push({ time: new Date(f.exit_time).getTime(), cumPnl: running, isEntry: false, trade: f });
    });
  }

  // totalPnl: sum of all "F" FlatToFlat values (matches calendar); fallback to SUM(pnl)
  const totalPnl = epFillsSorted.length > 0
    ? epFillsSorted.reduce((s, f) => s + parseFtf(f), 0)
    : fills.reduce((s, f) => s + (parseFloat(f.pnl) || 0), 0);

  // Build SESSION dot data: one dot per flat-to-flat group placed at the BP entry time.
  // Dots sit at the P&L level BEFORE the session, colored by session result.
  // Colored line segments (green/red) are overlaid on a dim base line.
  const seenGroupDots = new Set();
  const entryPoints = [];
  const sessionSegs = []; // { entryTs, exitTs, color, key }

  fills.forEach(f => {
    const groupKey = fillGroupMap.get(f.id);
    if (!groupKey || seenGroupDots.has(groupKey)) return;
    const label = fillLabelMap.get(f.id);
    const groupFills = fills.filter(gf => fillGroupMap.get(gf.id) === groupKey);
    const hasBP = groupFills.some(gf => fillLabelMap.get(gf.id) === 'Entry');
    // Trigger once per group via the BP fill (or first fill if no BP)
    if (hasBP && label !== 'Entry') return;
    if (!hasBP && f !== groupFills[0]) return;
    seenGroupDots.add(groupKey);

    // P&L: CumPL diff from epSessionPnlMap (same source as calendar). Fallback to FlatToFlat.
    const epFill = groupFills.find(gf => fillLabelMap.get(gf.id) === 'Exit');
    let groupPnl;
    if (epFill && epSessionPnlMap.has(epFill.id)) {
      groupPnl = epSessionPnlMap.get(epFill.id);
    } else {
      const flatToFlatRaw = String(
        epFill?.custom_fields?.sierra_data?.['FlatToFlat Profit/Loss (C)'] ||
        epFill?.custom_fields?.flat_to_flat_pl || ''
      ).trim().replace(/\s*F$/i, '');
      groupPnl = flatToFlatRaw !== ''
        ? parseFloat(flatToFlatRaw)
        : groupFills.reduce((s, gf) => s + (parseFloat(gf.pnl) || 0), 0);
    }

    // Max Open Quantity: max across all fills in the group
    const maxOpenQty = groupFills.reduce((mx, gf) => {
      const q = parseFloat(gf.custom_fields?.sierra_data?.['Max Open Quantity'] ?? 0);
      return Math.max(mx, q);
    }, 0) || f.quantity;

    // Place dot at BP entry time (start of session)
    const entryTs = new Date(f.entry_time).getTime();
    const exitTs = epFill ? new Date(epFill.exit_time).getTime() : new Date(f.exit_time).getTime();

    // cumPnl just before this session (last exitPoint at or before entryTs)
    let cumBefore = startBalance;
    for (const ep of exitPoints) {
      if (ep.time <= entryTs) cumBefore = ep.cumPnl;
      else break;
    }

    // Register colored segment for this session
    sessionSegs.push({
      entryTs, exitTs,
      color: groupPnl >= 0 ? '#22c55e' : '#ef4444',
      key: `seg${sessionSegs.length}`
    });

    entryPoints.push({
      time: entryTs,
      cumPnl: cumBefore,
      isEntry: true,
      trade: { ...f, pnl: groupPnl, quantity: maxOpenQty, exit_time: epFill?.exit_time || f.exit_time }
    });
  });

  const earliestTime = fills.length > 0
    ? Math.min(...fills.map(f => new Date(f.entry_time).getTime()))
    : 0;

  // Merge all raw points; at the same timestamp, entry dot wins
  const rawPoints = fills.length === 0 ? [] : [
    { time: earliestTime - 120000, cumPnl: startBalance, isEntry: false, trade: null },
    ...exitPoints.map(ep => ({ ...ep, isEntry: false, trade: null })),
    ...entryPoints,
  ].sort((a, b) => a.time - b.time || (a.isEntry ? 1 : -1));

  const timeMap = new Map();
  for (const pt of rawPoints) {
    if (!timeMap.has(pt.time) || pt.isEntry) timeMap.set(pt.time, pt);
  }

  // Build a lookup: entryTs → entry point (for tooltip persistence)
  const entryByTs = new Map(entryPoints.map(ep => [ep.time, ep]));

  const chartData = [...timeMap.values()].sort((a, b) => a.time - b.time).map(pt => {
    const row = { time: pt.time, cumPnl: pt.cumPnl, isEntry: pt.isEntry, trade: pt.trade };
    sessionSegs.forEach(seg => {
      row[seg.key] = (pt.time >= seg.entryTs && pt.time <= seg.exitTs) ? pt.cumPnl : null;
    });
    // For non-entry points within a session, attach session info so the tooltip persists
    if (!pt.isEntry) {
      const seg = sessionSegs.find(s => pt.time > s.entryTs && pt.time <= s.exitTs);
      if (seg) {
        const ep = entryByTs.get(seg.entryTs);
        if (ep) { row.sessionTrade = ep.trade; row.sessionCumBefore = ep.cumPnl; }
      }
    }
    return row;
  });

  const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const fmtTime = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtElapsed = (entry, exit) => {
    const s = Math.floor((new Date(exit) - new Date(entry)) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    return `${Math.floor(m/60)}h ${m%60}m`;
  };

  // Y reference line: at startBalance (0 intraday P&L mark)
  const refY = startBalance;

  const handleDotClick = (trade) => {
    if (!trade) return;
    const group = fillGroupMap.get(trade.id);
    setHighlightedGroup(prev => prev === group ? null : group);
    // Scroll to the first fill in the group
    const firstInGroup = fills.find(f => fillGroupMap.get(f.id) === group);
    if (firstInGroup) {
      const el = rowRefs.current[firstInGroup.id];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const DotRenderer = (props) => {
    const { cx, cy, payload } = props;
    if (!payload.isEntry || cx == null || cy == null) return <g />;
    const isHighlighted = highlightedGroup && fillGroupMap.get(payload.trade?.id) === highlightedGroup;
    const color = (parseFloat(payload.trade?.pnl) || 0) >= 0 ? '#22c55e' : '#ef4444';
    return (
      <g style={{ cursor: 'pointer' }} onClick={() => handleDotClick(payload.trade)}>
        {/* Invisible larger hit area */}
        <circle cx={cx} cy={cy} r={12} fill="transparent" />
        <circle
          cx={cx} cy={cy}
          r={isHighlighted ? 8 : 5}
          fill={color}
          stroke={isHighlighted ? '#fff' : '#0f0f1a'}
          strokeWidth={isHighlighted ? 2.5 : 2}
        />
      </g>
    );
  };

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    const t = d.isEntry ? d.trade : d.sessionTrade;
    if (!t) return null;
    const cumBefore = d.isEntry ? d.cumPnl : (d.sessionCumBefore ?? d.cumPnl);
    const group = fillGroupMap.get(t.id);
    const tags = group ? getGroupTags(group) : [];
    const cum = cumBefore + (parseFloat(t.pnl) || 0);
    return (
      <div className="day-modal-tooltip">
        <div><strong>{t.symbol}</strong> &nbsp;<span className={`direction-badge ${t.direction?.toLowerCase()}`}>{t.direction}</span></div>
        <div>Qty: {t.quantity} &nbsp;·&nbsp; {fmtTime(t.entry_time)}</div>
        {t.custom_fields?.account && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'monospace' }}>{t.custom_fields.account.split('-').pop()}</div>
        )}
        <div className={(parseFloat(t.pnl) || 0) >= 0 ? 'positive' : 'negative'}><strong>P&L: ${formatNumber(t.pnl)}</strong></div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Cumulative: <span className={cum >= 0 ? 'positive' : 'negative'}><strong>${formatNumber(cum)}</strong></span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Duration: {fmtElapsed(t.entry_time, t.exit_time)}</div>
        {tags.length > 0 && (
          <div className="tooltip-tags">
            {tags.map(tag => <span key={tag} className="tag-chip small">{tag}</span>)}
          </div>
        )}
      </div>
    );
  };

  const pnlPositive = totalPnl >= 0;

  const _hoveredTrade = (() => {
    if (!chartHoveredPayload) return null;
    return chartHoveredPayload.isEntry ? chartHoveredPayload.trade : chartHoveredPayload.sessionTrade;
  })();
  const hoveredAccount = isMultiAccount ? (_hoveredTrade?.custom_fields?.account || null) : null;
  const hoveredGroup = _hoveredTrade ? (fillGroupMap.get(_hoveredTrade.id) || null) : null;

  // Daily stats (computed from existing session/fill data)
  const sessionCount = entryPoints.length;
  const sessionWins = entryPoints.filter(ep => (parseFloat(ep.trade.pnl) || 0) > 0).length;
  const sessionLosses = entryPoints.filter(ep => (parseFloat(ep.trade.pnl) || 0) < 0).length;
  const winRate = sessionCount > 0 ? Math.round(sessionWins / sessionCount * 100) : 0;
  const sessionPnls = entryPoints.map(ep => parseFloat(ep.trade.pnl) || 0);
  const bestTradePnl = sessionPnls.length > 0 ? Math.max(...sessionPnls) : null;
  const worstTradePnl = sessionPnls.length > 0 ? Math.min(...sessionPnls) : null;
  const bestSession = bestTradePnl != null ? entryPoints.find(ep => (parseFloat(ep.trade.pnl) || 0) === bestTradePnl) : null;
  const worstSession = worstTradePnl != null ? entryPoints.find(ep => (parseFloat(ep.trade.pnl) || 0) === worstTradePnl) : null;

  const getSessionMaxProfit = (groupKey) => {
    const gFills = fills.filter(f => fillGroupMap.get(f.id) === groupKey);
    const vals = gFills.map(f =>
      parseFloat(f.custom_fields?.max_open_profit ||
                 f.custom_fields?.sierra_data?.['Max Open Profit (C)'] || 0)
    ).filter(v => v > 0);
    return vals.length > 0 ? Math.max(...vals) : 0;
  };

  const losingSessions = entryPoints.filter(ep => (parseFloat(ep.trade.pnl) || 0) < 0);
  const largestOpenProfitNotTaken = losingSessions.length > 0
    ? Math.max(...losingSessions.map(ep => getSessionMaxProfit(fillGroupMap.get(ep.trade.id))))
    : 0;
  const totalMaxOpenProfit = entryPoints.reduce((s, ep) => s + getSessionMaxProfit(fillGroupMap.get(ep.trade.id)), 0);
  const sessionEfficiency = totalMaxOpenProfit > 0 ? Math.round(totalPnl / totalMaxOpenProfit * 100) : null;

  const avgCapture = (() => {
    if (selectedAccounts.length !== 1) return null;
    const ratios = entryPoints
      .map(ep => {
        const mfe = getSessionMaxProfit(fillGroupMap.get(ep.trade.id));
        return mfe > 0 ? (parseFloat(ep.trade.pnl) || 0) / mfe : null;
      })
      .filter(r => r !== null);
    return ratios.length > 0 ? Math.round(ratios.reduce((s, r) => s + r, 0) / ratios.length * 100) : null;
  })();

  const allTimes = fills.flatMap(f => [new Date(f.entry_time).getTime(), new Date(f.exit_time).getTime()].filter(t => !isNaN(t)));
  const firstEntryMs = allTimes.length > 0 ? Math.min(...allTimes) : null;
  const lastExitMs = allTimes.length > 0 ? Math.max(...allTimes) : null;
  const timeInMarket = firstEntryMs != null && lastExitMs != null ? fmtElapsed(new Date(firstEntryMs), new Date(lastExitMs)) : null;
  const sessionResult = totalPnl > 0 ? 'WIN' : totalPnl < 0 ? 'LOSS' : 'BREAKEVEN';

  return (
    <div className="day-modal-overlay" onClick={onClose}>
      <div className="day-modal" onClick={e => e.stopPropagation()}>
        <div className="day-modal-header">
          <div>
            <h2>{dateLabel}</h2>
            {selectedAccounts.length > 0 && (
              <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{selectedAccounts[0]}</span>
                {selectedAccounts.length > 1 && (
                  <>
                    {accountsExpanded && selectedAccounts.slice(1).map(a => (
                      <React.Fragment key={a}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>|</span>
                        <span>{a}</span>
                      </React.Fragment>
                    ))}
                    <button
                      onClick={() => setAccountsExpanded(e => !e)}
                      style={{ fontSize: 13, fontWeight: 400, color: 'var(--accent-purple)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                    >
                      {accountsExpanded ? '▲ less' : `▼ +${selectedAccounts.length - 1} more`}
                    </button>
                  </>
                )}
              </div>
            )}
            <span className={`day-modal-pnl ${pnlPositive ? 'positive' : 'negative'}`}>
              {pnlPositive ? '+' : ''}${formatNumber(totalPnl)} &nbsp;·&nbsp; {fills.length} fills &nbsp;·&nbsp;
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                ${formatNumber(fills.reduce((s, f) => s + (parseFloat(f.quantity) || 0), 0) * 0.50 * 2)} paid in commissions
              </span>
            </span>
          </div>
          <button className="day-modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(30,41,59,0.8)', marginBottom: 16 }}>
          {[
            { id: 'TRADES', label: 'Trades' },
            { id: 'SETUPS', label: 'Setup Review', dot: aiReview },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setModalTab(tab.id)}
              style={{
                padding: '8px 18px',
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: 'none',
                border: 'none',
                borderBottom: modalTab === tab.id ? '2px solid #38bdf8' : '2px solid transparent',
                color: modalTab === tab.id ? '#38bdf8' : '#475569',
                cursor: 'pointer',
                marginBottom: -1,
                transition: 'color 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {tab.label}
              {tab.dot && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#38bdf8', display: 'inline-block', flexShrink: 0 }} />
              )}
            </button>
          ))}
        </div>

        {modalTab === 'SETUPS' ? (() => {
          const generateReview = async () => {
            setAiReviewLoading(true);
            try {
              const r = await fetch(`${API_URL}/playbook/daily-review/${dateStr}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmed: true }),
              });
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              setAiReview(d);
              setAiReviewEstimate(null);
            } catch (e) {
              alert('Review failed: ' + e.message);
            } finally {
              setAiReviewLoading(false);
            }
          };

          const augmentReview = async () => {
            setAiReviewLoading(true);
            try {
              const r = await fetch(`${API_URL}/playbook/daily-review/${dateStr}/augment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              setAiReview(d);
            } catch (e) {
              alert('Augment failed: ' + e.message);
            } finally {
              setAiReviewLoading(false);
            }
          };

          const persistFeedback = async () => {
            setPersistingFeedback(true);
            try {
              const r = await fetch(`${API_URL}/playbook/daily-review/${dateStr}/persist-feedback`, { method: 'POST' });
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              alert(`Saved ${d.persisted} rating${d.persisted !== 1 ? 's' : ''} to performance audit.`);
            } catch (e) {
              alert('Persist failed: ' + e.message);
            } finally {
              setPersistingFeedback(false);
            }
          };

          const VERDICT_COLORS = {
            GOOD:             { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)',  text: '#4ade80' },
            LATE:             { bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)',  text: '#fbbf24' },
            EARLY:            { bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)',  text: '#fbbf24' },
            CHASED:           { bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.3)',   text: '#f87171' },
            CALIBRATED:       { bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.3)',   text: '#4ade80' },
            TOO_TIGHT:        { bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.3)',   text: '#f87171' },
            TOO_WIDE:         { bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)',  text: '#fbbf24' },
            TOO_CONSERVATIVE: { bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)',  text: '#fbbf24' },
            TOO_AGGRESSIVE:   { bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.3)',   text: '#f87171' },
          };

          const Chip = ({ label }) => {
            const c = VERDICT_COLORS[label] || { bg: 'rgba(71,85,105,0.2)', border: 'rgba(71,85,105,0.4)', text: '#94a3b8' };
            return (
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', padding: '3px 8px', borderRadius: 4, background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
                {label}
              </span>
            );
          };

          const StarRating = ({ rating }) => (
            <span style={{ fontSize: 15, letterSpacing: 1 }}>
              {[1,2,3,4,5].map(i => (
                <span key={i} style={{ color: i <= rating ? '#fbbf24' : '#334155' }}>★</span>
              ))}
            </span>
          );

          const ratings = Array.isArray(aiReview?.stop_target_analysis) ? aiReview.stop_target_analysis : [];

          // Build lookup: setup_type → actual DB row (for real prices + correct times)
          const setupDetailsMap = {};
          (aiReview?.setup_details || []).forEach(s => {
            if (!setupDetailsMap[s.setup_type]) setupDetailsMap[s.setup_type] = s;
          });
          // fired_at is TIMESTAMP WITHOUT TIME ZONE; OR/IB setups store ET time as-is (09:30 = 9:30 AM ET)
          // using getUTC* reads the stored value directly without shifting
          const fmtET = ts => {
            if (!ts) return null;
            const d = new Date(ts);
            return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
          };

          if (aiReviewLoading) return (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#475569', fontSize: 13, fontStyle: 'italic' }}>
              Generating AI review…
            </div>
          );

          if (!aiReview) return (
            <div style={{ padding: '24px 0' }}>
              <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16, lineHeight: 1.6 }}>
                Claude reviews every setup that fired — entry quality, stop/target calibration, and patterns worth tracking.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {aiReviewEstimate && (
                  <span style={{ fontSize: 12, color: '#475569' }}>
                    {aiReviewEstimate.setup_count} setup{aiReviewEstimate.setup_count !== 1 ? 's' : ''} · est. ${(aiReviewEstimate.estimated_cost_usd || 0).toFixed(4)}
                  </span>
                )}
                <button
                  onClick={generateReview}
                  style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.3)', borderRadius: 5, padding: '6px 16px', cursor: 'pointer' }}
                >
                  Generate Setup Review
                </button>
              </div>
            </div>
          );

          return (
            <div>
              {/* Narrative */}
              <div style={{ background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: 8, padding: '14px 18px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: '#38bdf8', textTransform: 'uppercase' }}>Session Narrative</span>
                  {aiReview.cost_usd && (
                    <span style={{ fontSize: 10, color: '#334155', fontFamily: 'monospace' }}>${parseFloat(aiReview.cost_usd).toFixed(4)}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
                  {aiReview.augmented_response || aiReview.ai_response}
                </div>
                {Array.isArray(aiReview.data_requests) && aiReview.data_requests.length > 0 && !aiReview.augmented_response && (
                  <div style={{ marginTop: 12, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 6, padding: '8px 12px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                      Claude needs more data for full precision:
                    </div>
                    {aiReview.data_requests.map((dr, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#94a3b8', marginBottom: 3 }}>
                        {dr.type} {dr.window ? `(${dr.window})` : ''} — {dr.reason}
                      </div>
                    ))}
                    <button
                      onClick={augmentReview}
                      disabled={aiReviewLoading}
                      style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
                    >
                      Get More Detail
                    </button>
                  </div>
                )}
              </div>

              {/* Per-setup rating cards */}
              {ratings.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: '#64748b', textTransform: 'uppercase', marginBottom: 12 }}>
                    Setup Ratings
                  </div>
                  {ratings.map((r, i) => {
                    const detail = setupDetailsMap[r.setup_type];
                    const timeStr = detail ? fmtET(detail.fired_at) : (r.fired_at || null);
                    return (
                    <div key={i} style={{ background: 'rgba(15,23,42,0.6)', border: `1px solid ${r.rating >= 4 ? 'rgba(34,197,94,0.25)' : r.rating <= 2 ? 'rgba(239,68,68,0.25)' : 'rgba(51,65,85,0.6)'}`, borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: '#f1f5f9', letterSpacing: '0.04em' }}>
                            {r.setup_type}
                          </span>
                          {timeStr && (
                            <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{timeStr}</span>
                          )}
                        </div>
                        <StarRating rating={r.rating || 0} />
                      </div>

                      {/* Actual price levels + outcome */}
                      {detail && (detail.entry_zone_low || detail.stop_level || detail.t1_level) && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontFamily: 'monospace', fontSize: 12, marginBottom: 4 }}>
                            {detail.entry_zone_low && (
                              <span><span style={{ color: '#64748b' }}>Entry </span><span style={{ color: '#e2e8f0' }}>{detail.entry_zone_low}{detail.entry_zone_high && detail.entry_zone_high !== detail.entry_zone_low ? `–${detail.entry_zone_high}` : ''}</span></span>
                            )}
                            {detail.stop_level && (
                              <span><span style={{ color: '#64748b' }}>Stop </span><span style={{ color: '#f87171' }}>{detail.stop_level}</span></span>
                            )}
                            {detail.t1_level && (
                              <span><span style={{ color: '#64748b' }}>T1 </span><span style={{ color: '#4ade80' }}>{detail.t1_level}</span></span>
                            )}
                          </div>
                          {(detail.mae_points != null || detail.mfe_points != null) && (
                            <div style={{ display: 'flex', gap: 14, fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>
                              {detail.mae_points != null && (
                                <span>MAE <span style={{ color: '#fbbf24' }}>{detail.mae_points}pt</span>{detail.stop_level && detail.entry_zone_low ? <span style={{ color: '#475569' }}> / {Math.abs(parseFloat(detail.stop_level) - parseFloat(detail.entry_zone_low)).toFixed(0)}pt stop</span> : ''}</span>
                              )}
                              {detail.mfe_points != null && (
                                <span>MFE <span style={{ color: '#4ade80' }}>{detail.mfe_points}pt</span>{detail.t1_level && detail.entry_zone_low ? <span style={{ color: '#475569' }}> / {Math.abs(parseFloat(detail.t1_level) - parseFloat(detail.entry_zone_low)).toFixed(0)}pt T1</span> : ''}</span>
                              )}
                              {detail.resolution && (
                                <span style={{ color: detail.resolution === 'TARGET_HIT' ? '#4ade80' : detail.resolution === 'STOP_HIT' ? '#f87171' : '#64748b' }}>
                                  {detail.resolution.replace('_', ' ')}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Verdict chips */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                        {r.entry_quality && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Entry</span>
                            <Chip label={r.entry_quality} />
                          </div>
                        )}
                        {r.stop_verdict && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stop</span>
                            <Chip label={r.stop_verdict} />
                            {r.stop_verdict !== 'CALIBRATED' && r.stop_recommended_pts && (
                              <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                                {r.stop_current_pts}pt → {r.stop_recommended_pts}pt
                              </span>
                            )}
                          </div>
                        )}
                        {r.t1_verdict && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>T1</span>
                            <Chip label={r.t1_verdict} />
                            {r.t1_verdict !== 'CALIBRATED' && r.t1_recommended_pts && (
                              <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
                                {r.t1_current_pts}pt → {r.t1_recommended_pts}pt
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Reasoning */}
                      {r.reasoning && (
                        <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.65, borderTop: '1px solid rgba(51,65,85,0.5)', paddingTop: 9 }}>
                          {r.reasoning}
                        </div>
                      )}
                    </div>
                    );
                  })}

                </div>
              )}
            </div>
          );
        })() : null}

        {modalTab === 'TRADES' && (<>

        {/* Trade Feedback Logs */}
        {feedbackLogs.length > 0 && (
          <div style={{ marginBottom: 12, padding: '10px 14px', background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#818cf8', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Trade Feedback Log ({feedbackLogs.length})</div>
            {feedbackLogs.map(f => (
              <div key={f.id} style={{ padding: '4px 0', borderBottom: '1px solid rgba(30,41,59,0.3)', fontSize: 11 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, color: f.action === 'TAKEN' ? '#22c55e' : '#f59e0b' }}>{f.action}</span>
                  <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{f.setup_type}</span>
                  <span style={{ color: '#94a3b8' }}>{f.direction}</span>
                  {f.contracts > 1 && <span style={{ color: '#94a3b8' }}>{f.contracts}ct</span>}
                  <span style={{ color: '#94a3b8' }}>{(f.tags || []).join(', ')}</span>
                  {f.pnl != null && <span style={{ color: f.pnl >= 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace', fontWeight: 700 }}>${f.pnl}</span>}
                </div>
                {f.note && <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', marginTop: 2 }}>{f.note}</div>}
              </div>
            ))}
          </div>
        )}

        {/* AI Coaching Review */}
        {(() => {
          const parseCoaching = (text) => {
            if (!text) return null;
            const secs = [
              { key: 'WHAT HAPPENED',    color: '#60a5fa' },
              { key: 'WHAT WORKED',      color: '#4ade80' },
              { key: 'WHAT TO IMPROVE',  color: '#fb923c' },
              { key: "TOMORROW'S WATCH", color: '#c084fc' },
            ];
            const out = [];
            secs.forEach((s, i) => {
              const marker = s.key + ':';
              const start = text.indexOf(marker);
              if (start === -1) return;
              const from = start + marker.length;
              const nextIdx = secs.slice(i + 1)
                .map(ns => text.indexOf(ns.key + ':'))
                .filter(p => p > start)[0] ?? text.length;
              out.push({ ...s, content: text.slice(from, nextIdx).trim() });
            });
            return out.length ? out : null;
          };

          const regenerateCoaching = async () => {
            setCoachingLoading(true);
            try {
              const r = await fetch(`${API_URL}/calendar/coaching/${dateStr}/regenerate`, { method: 'POST' });
              const d = await r.json();
              if (d.error) { alert('Regenerate failed: ' + d.error); return; }
              setCoachingData(d.coaching);
              setCoachingRead(false);
            } catch (e) {
              alert('Regenerate failed: ' + e.message);
            } finally {
              setCoachingLoading(false);
            }
          };

          const sections = coachingData ? parseCoaching(coachingData.coaching_text) : null;
          return (
            <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 10, padding: '16px 20px', margin: '0 0 16px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', color: '#818cf8', textTransform: 'uppercase' }}>AI Coaching Review</span>
                  {coachingData && !coachingRead && (
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', flexShrink: 0 }} />
                  )}
                </div>
                <button
                  onClick={regenerateCoaching}
                  disabled={coachingLoading}
                  style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.08)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: 4, padding: '3px 10px', cursor: coachingLoading ? 'default' : 'pointer', opacity: coachingLoading ? 0.5 : 1 }}
                >
                  {coachingLoading ? '...' : '↺ Regenerate'}
                </button>
              </div>
              {coachingLoading ? (
                <div style={{ color: '#94a3b8', fontSize: 14, fontStyle: 'italic' }}>Generating review...</div>
              ) : !coachingData ? (
                <div style={{ background: 'rgba(51,65,85,0.35)', borderRadius: 7, padding: '12px 16px', color: '#94a3b8', fontSize: 14, lineHeight: 1.7 }}>
                  No coaching review for this session.<br />
                  Reviews generate at 4:45 PM ET on trading days, or click ↺ Regenerate above.
                </div>
              ) : sections ? (
                <div>
                  {sections.map(sec => (
                    <div key={sec.key} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', color: sec.color, textTransform: 'uppercase', marginBottom: 5 }}>{sec.key}</div>
                      <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.65 }}>{sec.content}</div>
                    </div>
                  ))}
                  {!coachingRead && (
                    <button onClick={() => { setCoachingRead(true); fetch(`${API_URL}/calendar/coaching/${dateStr}/read`, { method: 'PATCH' }).catch(() => {}); }}
                      style={{ marginTop: 4, fontSize: 12, color: '#94a3b8', background: 'none', border: '1px solid #334155', borderRadius: 5, padding: '4px 12px', cursor: 'pointer' }}>
                      Mark as Read
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{coachingData.coaching_text}</div>
              )}
            </div>
          );
        })()}

        {/* Intraday Chart */}
        <div ref={chartSectionRef} style={{ borderTop: '1px solid var(--border-color)', marginTop: 8 }}>
          <button
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' }}
            onClick={() => setChartExpanded(e => !e)}
          >
            <span>📈 Intraday Chart — setup markers</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{chartExpanded ? '▲ collapse' : '▼ expand'}</span>
          </button>
          {chartExpanded && <IntradayChartSection dateStr={dateStr} />}
        </div>

        {!loading && sessionCount > 0 && (
          <div className="day-stats-grid">
            <div className={`day-stats-result ${sessionResult === 'WIN' ? 'win' : sessionResult === 'LOSS' ? 'loss' : 'flat'}`}>
              {sessionResult}
            </div>
            <div className="day-stats-item">
              <span className="day-stats-label">Sessions</span>
              <span className="day-stats-value">
                {sessionCount} &nbsp;·&nbsp; <span className="positive">{sessionWins}W</span> &nbsp;·&nbsp; <span className="negative">{sessionLosses}L</span>
              </span>
            </div>
            <div className="day-stats-item">
              <span className="day-stats-label">Win Rate</span>
              <span className="day-stats-value">{winRate}%</span>
            </div>
            {bestTradePnl != null && (
              <div className="day-stats-item">
                <span className="day-stats-label">Best</span>
                <span className="day-stats-value positive">
                  +${formatNumber(bestTradePnl, 0)}{bestSession ? ` @ ${fmtTime(bestSession.time)}` : ''}
                </span>
              </div>
            )}
            {worstTradePnl != null && (
              <div className="day-stats-item">
                <span className="day-stats-label">Worst</span>
                <span className={`day-stats-value ${worstTradePnl < 0 ? 'negative' : 'positive'}`}>
                  {worstTradePnl >= 0 ? '+' : ''}${formatNumber(worstTradePnl, 0)}{worstSession ? ` @ ${fmtTime(worstSession.time)}` : ''}
                </span>
              </div>
            )}
            {largestOpenProfitNotTaken > 0 && (
              <div className="day-stats-item">
                <span className="day-stats-label">Open profit left</span>
                <span className="day-stats-value" style={{ color: 'var(--accent-amber, #f59e0b)' }}>
                  +${formatNumber(largestOpenProfitNotTaken, 0)}
                </span>
              </div>
            )}
            {sessionEfficiency != null && (
              <div className="day-stats-item">
                <span className="day-stats-label">Efficiency</span>
                <span className={`day-stats-value ${sessionEfficiency >= 50 ? 'positive' : sessionEfficiency >= 0 ? '' : 'negative'}`}>
                  {sessionEfficiency}%
                </span>
              </div>
            )}
            {avgCapture != null && (
              <div className="day-stats-item">
                <span className="day-stats-label">Capture</span>
                <span className="day-stats-value" style={{ color: avgCapture >= 80 ? '#22c55e' : avgCapture >= 50 ? '#f59e0b' : '#ef4444' }}>
                  {avgCapture}%
                </span>
              </div>
            )}
            {timeInMarket && (
              <div className="day-stats-item">
                <span className="day-stats-label">Time in market</span>
                <span className="day-stats-value">{timeInMarket}</span>
              </div>
            )}
            {isMultiAccount && (
              <div className="day-stats-item" style={{ minWidth: 140 }}>
                <span className="day-stats-label">Account</span>
                <span className="day-stats-value" style={{
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: hoveredAccount ? '#e2e8f0' : '#64748b',
                  fontWeight: hoveredAccount ? 700 : 400,
                }}>
                  {hoveredAccount ? hoveredAccount.split('-').pop() : '—'}
                </span>
              </div>
            )}
          </div>
        )}


        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>Loading...</div>
        ) : chartData.length < 2 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>No trade data for selected account</div>
        ) : (
          <div className="day-modal-chart">
            {crosshair && (
              <div
                className="chart-yaxis-label"
                style={{ top: crosshair.pixelY + 20 }}
              >
                ${formatNumber(crosshair.yValue, 0)}
              </div>
            )}
            {crosshair && (
              <div
                className="chart-xaxis-label"
                style={{ left: crosshair.pixelX + 10 }}
              >
                {new Date(crosshair.xValue).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            )}
            <ResponsiveContainer width="100%" height={380}>
              <LineChart
                data={chartData}
                margin={{ top: 20, right: 24, left: 10, bottom: 8 }}
                onMouseMove={e => {
                  if (e?.activeCoordinate && e?.activePayload?.length) {
                    setCrosshair({
                      pixelY: e.activeCoordinate.y,
                      pixelX: e.activeCoordinate.x,
                      yValue: e.activePayload[0].value,
                      xValue: e.activeLabel,
                    });
                    setChartHoveredPayload(e.activePayload[0]?.payload ?? null);
                  }
                }}
                onMouseLeave={() => { setCrosshair(null); setChartHoveredPayload(null); }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']}
                  tickFormatter={ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}
                  tick={{ fontSize: 13, fill: 'var(--text-muted)' }}
                />
                <YAxis
                  tickFormatter={v => `$${formatNumber(v, 0)}`}
                  tick={{ fontSize: 13, fill: 'var(--text-muted)' }}
                  width={80}
                />
                <ReferenceLine y={refY} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1 }}
                />
                <Line
                  type="stepAfter"
                  dataKey="cumPnl"
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth={1.5}
                  dot={<DotRenderer />}
                  activeDot={{ r: 0 }}
                  isAnimationActive={false}
                />
                {sessionSegs.map(seg => (
                  <Line
                    key={seg.key}
                    type="stepAfter"
                    dataKey={seg.key}
                    stroke={seg.color}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 0 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {!loading && exitPoints.length > 0 && (
          <details style={{ margin: '0 24px 12px', fontSize: 13, color: 'var(--text-muted)' }}>
            <summary style={{ cursor: 'pointer', marginBottom: 6 }}>
              📊 Chart data ({exitPoints.length} points, total: ${exitPoints.length > 0 ? (exitPoints[exitPoints.length-1].cumPnl - startBalance).toFixed(2) : 0})
            </summary>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>#</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>EP Exit Time</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Account</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>FlatToFlat raw</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Session P&L</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {exitPoints.map((ep, i) => {
                  const ftfRaw = getFtfStr(ep.trade);
                  const sessionPnl = epSessionPnlMap.get(ep.trade?.id);
                  const account = ep.trade?.custom_fields?.account;
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '2px 6px' }}>{i + 1}</td>
                      <td style={{ padding: '2px 6px' }}>{new Date(ep.time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', fontSize: 12 }} title={account || ''}>{account ? account.split('-').pop() : '—'}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', fontFamily: 'monospace' }}>{ftfRaw}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: sessionPnl >= 0 ? '#22c55e' : '#ef4444' }}>${fmtP(sessionPnl, 2)}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: ep.cumPnl >= startBalance ? '#22c55e' : '#ef4444' }}>${fmtP(ep.cumPnl - startBalance, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        )}

        {!loading && fills.length > 0 && (
          <div className="day-modal-trade-list">
            {selectedFillIds.size > 0 && !selectionEditorOpen && (
              <div className="ann-selection-bar">
                <span>{selectedFillIds.size} trade{selectedFillIds.size !== 1 ? 's' : ''} selected</span>
                <button className="ann-sel-note-btn" onClick={() => { setSelectionEditorOpen(true); setEditingGroupKey(null); }}>
                  Add note
                </button>
                <button className="ann-sel-clear-btn" onClick={() => setSelectedFillIds(new Set())}>✕ Clear</button>
              </div>
            )}
            {selectionEditorOpen && (
              <div className="ann-selection-editor-wrap">
                <div className="ann-selection-editor-header">
                  <span>Annotating {selectedFillIds.size} selected trade{selectedFillIds.size !== 1 ? 's' : ''}</span>
                  <button className="ann-sel-clear-btn" onClick={() => { setSelectionEditorOpen(false); setSelectedFillIds(new Set()); }}>✕ Clear selection</button>
                </div>
                <AnnotationBlock
                  key={`sel-${[...selectedFillIds].sort().join('-')}`}
                  dateStr={dateStr}
                  groupKey={`sel-${[...selectedFillIds].sort().join('-')}`}
                  tradeIds={[...selectedFillIds]}
                  existing={null}
                  isEditing={true}
                  onStartEdit={() => {}}
                  onCancelEdit={() => { setSelectionEditorOpen(false); setSelectedFillIds(new Set()); }}
                  onSaved={ann => {
                    setAnnotations(prev => { const without = prev.filter(a => a.id !== ann.id); return [...without, ann]; });
                    setSelectionEditorOpen(false);
                    setSelectedFillIds(new Set());
                  }}
                  onDeleted={id => setAnnotations(prev => prev.filter(a => a.id !== id))}
                />
              </div>
            )}
            {(hoveredGroup ? fills.filter(f => fillGroupMap.get(f.id) === hoveredGroup) : fills).map((t, i, arr) => {
              const group = fillGroupMap.get(t.id);
              const prevGroup = i > 0 ? fillGroupMap.get(arr[i - 1].id) : null;
              const isGroupStart = group !== prevGroup;
              return (
                <React.Fragment key={t.id}>
                  {isGroupStart && i > 0 && <div className="day-modal-group-divider" />}
                  {isGroupStart && (() => {
                    const allTags = getGroupTags(group);
                    const qualityTag = allTags.find(t => /^Q:[123]$/.test(t));
                    const currentQuality = qualityTag ? parseInt(qualityTag[2]) : null;
                    const displayTags = allTags.filter(t => !/^Q:[123]$/.test(t));
                    const MGI_PRESETS = ['POC','VAH','VAL','HVN','LVN','Open Drive','Balance','Imbalance','Gap Fill','Excess','Poor High','Poor Low'];

                    const setQuality = (q) => {
                      const withoutQ = allTags.filter(t => !/^Q:[123]$/.test(t));
                      saveGroupTags(group, currentQuality === q ? withoutQ : [...withoutQ, `Q:${q}`]);
                    };

                    return (
                      <div className="group-tags-row">
                        {/* Entry quality rating */}
                        <div className="quality-rating">
                          <span className="quality-label">Setup:</span>
                          {[1,2,3].map(q => (
                            <button
                              key={q}
                              className={`quality-btn q${q}${currentQuality === q ? ' active' : ''}`}
                              onClick={() => setQuality(q)}
                              title={q === 1 ? 'A — High conviction' : q === 2 ? 'B — Decent setup' : 'C — Low conviction'}
                            >{q === 1 ? 'A' : q === 2 ? 'B' : 'C'}</button>
                          ))}
                        </div>

                        <div className="tags-divider" />

                        {/* MGI/custom tags */}
                        <div className="tags-area">
                          {displayTags.map(tag => (
                            <span key={tag} className="tag-chip">
                              {tag}
                              <button className="tag-remove" onClick={() => removeTag(group, tag)}>×</button>
                            </span>
                          ))}

                          {/* MGI preset quick-add */}
                          {activeTagGroup === group ? (
                            <>
                              <div className="mgi-presets">
                                {MGI_PRESETS.filter(p => !displayTags.includes(p)).map(p => (
                                  <button key={p} className="mgi-preset-btn"
                                    onMouseDown={e => { e.preventDefault(); addTag(group, p); }}>
                                    {p}
                                  </button>
                                ))}
                              </div>
                              <input
                                autoFocus
                                className="tag-input"
                                value={tagInputValues[group] || ''}
                                placeholder="type MGI tag + Enter..."
                                onChange={e => setTagInputValues(p => ({ ...p, [group]: e.target.value }))}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && e.target.value.trim()) {
                                    addTag(group, e.target.value.trim());
                                    setTagInputValues(p => ({ ...p, [group]: '' }));
                                  }
                                  if (e.key === 'Escape') {
                                    setTagInputValues(p => ({ ...p, [group]: '' }));
                                    setActiveTagGroup(null);
                                  }
                                }}
                                onBlur={() => {
                                  if (tagInputValues[group]?.trim()) addTag(group, tagInputValues[group].trim());
                                  setTagInputValues(p => ({ ...p, [group]: '' }));
                                  setActiveTagGroup(null);
                                }}
                              />
                              <button className="tag-add-btn" style={{ opacity: 0.5 }} onClick={() => setActiveTagGroup(null)}>done</button>
                            </>
                          ) : (
                            <button className="tag-add-btn" onClick={() => setActiveTagGroup(group)}>+ MGI tag</button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {isGroupStart && (() => {
                    const groupFills = fills.filter(f => fillGroupMap.get(f.id) === group);
                    const groupTradeIds = groupFills.map(f => f.id);
                    return (
                      <AnnotationBlock
                        key={`ann-${group}`}
                        dateStr={dateStr}
                        groupKey={group}
                        tradeIds={groupTradeIds}
                        existing={annotationByGroup.get(group) || null}
                        isEditing={editingGroupKey === group}
                        onStartEdit={() => { setEditingGroupKey(group); setSelectionEditorOpen(false); setSelectedFillIds(new Set(groupTradeIds)); }}
                        onCancelEdit={() => { setEditingGroupKey(null); setSelectedFillIds(new Set()); }}
                        onSaved={ann => {
                          setAnnotations(prev => { const without = prev.filter(a => a.id !== ann.id); return [...without, ann]; });
                          setEditingGroupKey(null);
                          setSelectedFillIds(new Set());
                        }}
                        onDeleted={id => { setAnnotations(prev => prev.filter(a => a.id !== id)); setSelectedFillIds(new Set()); }}
                      />
                    );
                  })()}
                  {isGroupStart && selectedAccounts.length === 1 && (() => {
                    const gFills = fills.filter(f => fillGroupMap.get(f.id) === group);
                    const epFill = gFills.find(f => fillLabelMap.get(f.id) === 'Exit');
                    let groupPnl;
                    if (epFill && epSessionPnlMap.has(epFill.id)) {
                      groupPnl = epSessionPnlMap.get(epFill.id);
                    } else {
                      groupPnl = gFills.reduce((s, f) => s + (parseFloat(f.pnl) || 0), 0);
                    }
                    const groupMfe = getSessionMaxProfit(group);
                    if (groupMfe <= 0) return null;
                    const pnl = parseFloat(groupPnl) || 0;
                    let lineColor, captureLabel;
                    if (pnl >= groupMfe * 0.999) {
                      lineColor = '#22c55e';
                      captureLabel = 'Captured: 100%';
                    } else if (pnl > 0) {
                      lineColor = '#f59e0b';
                      captureLabel = `Captured: ${Math.round(pnl / groupMfe * 100)}%`;
                    } else {
                      lineColor = '#ef4444';
                      captureLabel = `Gave back: $${formatNumber(groupMfe + Math.abs(pnl), 0)}`;
                    }
                    const pnlStr = (pnl >= 0 ? '+' : '') + '$' + formatNumber(pnl, 0);
                    return (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '4px 14px',
                        fontSize: 12, fontWeight: 600,
                        background: `${lineColor}12`,
                        borderLeft: `3px solid ${lineColor}`,
                      }}>
                        <span style={{ color: pnl >= 0 ? '#86efac' : '#fca5a5' }}>P&L: {pnlStr}</span>
                        <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
                        <span style={{ color: '#94a3b8' }}>MFE: +${formatNumber(groupMfe, 0)}</span>
                        <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
                        <span style={{ color: lineColor }}>{captureLabel}</span>
                      </div>
                    );
                  })()}
                  <div
                    ref={el => { rowRefs.current[t.id] = el; }}
                    className={`day-modal-trade-row ${(parseFloat(t.pnl) || 0) >= 0 ? 'win' : 'loss'}${highlightedGroup && group === highlightedGroup ? ' highlighted' : ''}${annotatedFillIds.has(t.id) ? ' annotated' : ''}${selectedFillIds.has(t.id) ? ' ann-selected' : ''}`}
                    onClick={() => setHighlightedGroup(prev => prev === group ? null : group)}
                  >
                    <span
                      className={`ann-row-check${selectedFillIds.has(t.id) ? ' checked' : ''}`}
                      onClick={e => { e.stopPropagation(); toggleFillSelect(t.id); }}
                      title="Select for annotation"
                    />
                    {(() => {
                      const lbl = fillLabelMap.get(t.id);
                      const cls = lbl === 'Entry' ? 'entry' : lbl === 'Exit' ? 'full-exit' : lbl === 'Add' ? 'add-on' : lbl === 'Partial Exit' ? 'partial-exit' : t.direction?.toLowerCase();
                      return <span className={`direction-badge ${cls}`}>{lbl || t.direction}</span>;
                    })()}
                    {t.direction && (
                      <span className={`direction-badge ${t.direction.toLowerCase()}`} style={{ fontSize: 11, opacity: 0.8 }}>
                        {t.direction === 'LONG' ? '↑ LONG' : '↓ SHORT'}
                      </span>
                    )}
                    <span>{t.symbol}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>×{t.quantity}</span>
                    {(() => {
                      const lbl = fillLabelMap.get(t.id);
                      const execPrice = (lbl === 'Partial Exit' || lbl === 'Exit') ? t.exit_price : t.entry_price;
                      return execPrice != null && execPrice !== '' ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'monospace' }}>@ {formatNumber(execPrice, 2)}</span>
                      ) : null;
                    })()}
                    {t.custom_fields?.account && (
                      <span style={{ color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', border: '1px solid var(--border-color)', borderRadius: 3, padding: '0 4px' }} title={t.custom_fields.account}>
                        {t.custom_fields.account.split('-').pop()}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{fmtTime(t.entry_time)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{fmtElapsed(t.entry_time, t.exit_time)}</span>
                    {parseFloat(t.custom_fields?.max_open_profit) > 0 && (
                      <span style={{ fontSize: 12, color: '#6366f1', fontWeight: 600 }}>
                        MFE +${formatNumber(t.custom_fields.max_open_profit, 0)}
                      </span>
                    )}
                    <span className={(parseFloat(t.pnl) || 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>{(parseFloat(t.pnl) || 0) >= 0 ? '+' : ''}${formatNumber(t.pnl)}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}

        </>)}

      </div>
    </div>
  );
}

export default CalendarView;
