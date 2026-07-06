import React, { useState, useEffect } from 'react';

export default function PreSessionChecklist() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const storageKey = `tj-prep-checklist-${todayStr}`;

  const [checkedItems, setCheckedItems] = useState(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : { macro: false, risk: false, levels: false, mindset: false };
    } catch {
      return { macro: false, risk: false, levels: false, mindset: false };
    }
  });
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(checkedItems));
  }, [checkedItems, storageKey]);

  // Auto-collapse after market open (9:30 ET)
  useEffect(() => {
    const check = () => {
      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
      const h = parseInt(etParts.find(p => p.type === 'hour').value, 10);
      const m = parseInt(etParts.find(p => p.type === 'minute').value, 10);
      if (h * 60 + m >= 9 * 60 + 30) setCollapsed(true);
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  const toggleItem = (key) => {
    setCheckedItems(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const allChecked = Object.values(checkedItems).every(v => v);

  if (collapsed) {
    return (
      <div
        style={{ ...cardStyle, padding: '8px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setCollapsed(false)}
      >
        <span style={{ ...titleStyle, fontSize: 12 }}>PRE-SESSION CHECKLIST</span>
        <span style={allChecked ? lockedBadgeStyle : { ...unlockedBadgeStyle, background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
          {allChecked ? '✓ PRE-FLIGHT COMPLETED' : 'INCOMPLETE — TAP TO OPEN'}
        </span>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>📋 Pre-Session Checklist Gate</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={allChecked ? lockedBadgeStyle : unlockedBadgeStyle}>
            {allChecked ? 'GATE LOCKED' : 'GATE OPEN'}
          </span>
          <button
            onClick={() => setCollapsed(true)}
            style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
            title="Collapse"
          >×</button>
        </div>
      </div>

      <div style={listStyle}>
        <label style={itemStyle(checkedItems.macro)}>
          <input
            type="checkbox"
            checked={checkedItems.macro}
            onChange={() => toggleItem('macro')}
            style={checkboxStyle}
          />
          <div style={textContainerStyle}>
            <strong style={labelStyle(checkedItems.macro)}>📰 Macro News Gate</strong>
            <span style={descStyle}>Times checked. No entries 5 min before/after high-impact releases.</span>
          </div>
        </label>

        <label style={itemStyle(checkedItems.risk)}>
          <input
            type="checkbox"
            checked={checkedItems.risk}
            onChange={() => toggleItem('risk')}
            style={checkboxStyle}
          />
          <div style={textContainerStyle}>
            <strong style={labelStyle(checkedItems.risk)}>🛑 Max Risk Defined</strong>
            <span style={descStyle}>Logged daily loss limit. Position sizing matches Monday fade protocol.</span>
          </div>
        </label>

        <label style={itemStyle(checkedItems.levels)}>
          <input
            type="checkbox"
            checked={checkedItems.levels}
            onChange={() => toggleItem('levels')}
            style={checkboxStyle}
          />
          <div style={textContainerStyle}>
            <strong style={labelStyle(checkedItems.levels)}>🎯 Levels Mapped in Sierra</strong>
            <span style={descStyle}>OFL Balance Zone bounds, G-Line, and LIS levels drawn on active chart.</span>
          </div>
        </label>

        <label style={itemStyle(checkedItems.mindset)}>
          <input
            type="checkbox"
            checked={checkedItems.mindset}
            onChange={() => toggleItem('mindset')}
            style={checkboxStyle}
          />
          <div style={textContainerStyle}>
            <strong style={labelStyle(checkedItems.mindset)}>🧘 Executional Acceptance</strong>
            <span style={descStyle}>I accept outcome uncertainty and will not chase breakouts inside balance.</span>
          </div>
        </label>
      </div>

      {allChecked && (
        <div style={successBannerStyle}>
          🚀 Ready to trade. Execution bias is aligned with statistical prep limits.
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  borderRadius: 10,
  padding: '14px 18px',
  background: 'var(--card-bg)',
  border: '1px solid var(--border-color)',
  fontFamily: 'Arial, sans-serif'
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
  paddingBottom: 8
};

const titleStyle = {
  fontSize: 13,
  fontWeight: 700,
  color: '#cbd5e1',
  letterSpacing: '0.05em',
  textTransform: 'uppercase'
};

const lockedBadgeStyle = {
  fontSize: 11,
  fontWeight: 800,
  background: 'rgba(16, 185, 129, 0.15)',
  color: '#34d399',
  padding: '2px 8px',
  borderRadius: 4,
  letterSpacing: '0.04em'
};

const unlockedBadgeStyle = {
  fontSize: 11,
  fontWeight: 800,
  background: 'rgba(239, 68, 68, 0.15)',
  color: '#f87171',
  padding: '2px 8px',
  borderRadius: 4,
  letterSpacing: '0.04em'
};

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8
};

const itemStyle = (isChecked) => ({
  display: 'flex',
  alignItems: 'flex-start',
  padding: '8px 10px',
  borderRadius: 6,
  background: isChecked ? 'rgba(16, 185, 129, 0.02)' : 'rgba(255, 255, 255, 0.01)',
  border: isChecked ? '1px solid rgba(16, 185, 129, 0.15)' : '1px solid rgba(255, 255, 255, 0.03)',
  cursor: 'pointer',
  transition: 'all 0.15s ease'
});

const checkboxStyle = {
  marginTop: 3,
  marginRight: 10,
  cursor: 'pointer',
  accentColor: '#10b981'
};

const textContainerStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2
};

const labelStyle = (isChecked) => ({
  fontSize: 12,
  color: isChecked ? '#34d399' : '#cbd5e1',
  fontWeight: 700
});

const descStyle = {
  fontSize: 11,
  color: '#94a3b8',
  lineHeight: 1.4
};

const successBannerStyle = {
  marginTop: 12,
  padding: '8px 12px',
  background: 'rgba(16, 185, 129, 0.1)',
  border: '1px solid rgba(16, 185, 129, 0.25)',
  borderRadius: 6,
  fontSize: 11.5,
  color: '#34d399',
  fontWeight: 600,
  textAlign: 'center',
  animation: 'pulse 2s infinite'
};
