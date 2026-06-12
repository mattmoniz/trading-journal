import React, { useState, useEffect, useCallback } from 'react';
import { isSeen, markSeen, hasUnseenForView, UPDATES, reportDynamicUpdate, isDynamicUnseen, markDynamicSeen, getDynamicPreviousValue } from '../../utils/updateDots.js';

const dotStyle = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#f97316',
  marginLeft: 6,
  verticalAlign: 'middle',
  flexShrink: 0,
  boxShadow: '0 0 5px rgba(249,115,22,0.7)',
};

// Inline dot on a section header.
// Watches sectionId via IntersectionObserver — clears once the section has been
// visible and then scrolls past (exits the viewport going upward).
export function SectionUpdateDot({ id }) {
  const [seen, setSeen] = useState(() => isSeen(id));
  const sectionId = UPDATES[id]?.sectionId;

  useEffect(() => {
    if (seen || !sectionId) return;
    const el = document.getElementById(sectionId);
    if (!el) return;

    let wasVisible = false;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        wasVisible = true;
      } else if (wasVisible) {
        markSeen(id);
        setSeen(true);
      }
    }, { threshold: 0.05 });

    obs.observe(el);
    return () => obs.disconnect();
  }, [id, sectionId, seen]);

  if (seen) return null;
  return <span style={dotStyle} title="New content" />;
}

// Dot on a sidebar nav button.
// Shows if any updates for that view are still unseen.
// Listens for the custom 'update-dot-cleared' event to re-check without a page reload.
export function NavUpdateDot({ view }) {
  const [hasUnseen, setHasUnseen] = useState(() => hasUnseenForView(view));

  useEffect(() => {
    const handler = () => setHasUnseen(hasUnseenForView(view));
    window.addEventListener('update-dot-cleared', handler);
    return () => window.removeEventListener('update-dot-cleared', handler);
  }, [view]);

  if (!hasUnseen) return null;
  return <span style={{ ...dotStyle, marginLeft: 4 }} title="New content" />;
}

// Plain dot, for use wherever a section wants to render its own "updated" indicator.
// Pass onClick to make it dismissible on click (stops propagation so it doesn't
// also trigger a parent toggle).
export function Dot({ title = 'Updated since you last opened this', onClick }) {
  return (
    <span
      style={{ ...dotStyle, cursor: onClick ? 'pointer' : dotStyle.cursor }}
      title={title}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
    />
  );
}

// Hook for per-field "this value changed" dots within a section.
// `fields` is a stable-shaped object of { fieldKey: currentValue }. Returns a map
// { fieldKey: { unseen, prev, clear } } — `unseen` is true if the value changed
// since `clear` was last called for that field, `prev` is the value it changed from.
export function useFieldUpdateDots(view, sectionPrefix, fields) {
  const [, bump] = useState(0);
  const fieldsKey = JSON.stringify(fields);

  useEffect(() => {
    for (const [key, val] of Object.entries(fields)) {
      reportDynamicUpdate(`${sectionPrefix}::${key}`, view, val);
    }
    bump(x => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey]);

  useEffect(() => {
    const handler = () => bump(x => x + 1);
    window.addEventListener('update-dot-cleared', handler);
    return () => window.removeEventListener('update-dot-cleared', handler);
  }, []);

  const result = {};
  for (const key of Object.keys(fields)) {
    const id = `${sectionPrefix}::${key}`;
    result[key] = {
      unseen: isDynamicUnseen(id),
      prev: getDynamicPreviousValue(id),
      clear: () => markDynamicSeen(id),
    };
  }
  return result;
}

// Hook for data-driven "updated since last opened" dots.
// Reports `signature` (any value that changes when the underlying data changes —
// typically JSON.stringify of the relevant fetched state) every render. Returns
// [unseen, clearSeen] — `unseen` is true once `signature` differs from the value
// recorded the last time `clearSeen` was called (or false on first load, before
// any baseline exists). Call `clearSeen` when the section is opened/expanded.
export function useDataUpdateDot(id, view, signature) {
  const [, bump] = useState(0);

  useEffect(() => {
    reportDynamicUpdate(id, view, signature);
    bump(x => x + 1);
  }, [id, view, signature]);

  useEffect(() => {
    const handler = () => bump(x => x + 1);
    window.addEventListener('update-dot-cleared', handler);
    return () => window.removeEventListener('update-dot-cleared', handler);
  }, []);

  const clearSeen = useCallback(() => markDynamicSeen(id), [id]);
  return [isDynamicUnseen(id), clearSeen];
}
