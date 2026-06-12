// Update dot system — tracks which feature updates the user has scrolled past.
// Each update has a string ID, a view name (for nav dots), and a sectionId
// (the DOM element ID the IntersectionObserver watches).

const STORAGE_KEY = 'tj_update_dots_v1';

export const UPDATES = {
  'behavior-reentry-2026-06':    { view: 'dashboard', sectionId: 'section-behavior' },
  'optimization-stops-2026-06':  { view: 'dashboard', sectionId: 'section-optimization' },
  'tearsheet-regime-2026-06':    { view: 'tearsheet', sectionId: 'tearsheet-regime-region' },
};

function getSeenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch { return new Set(); }
}

export function isSeen(id) {
  return getSeenSet().has(id);
}

export function markSeen(id) {
  const s = getSeenSet();
  if (s.has(id)) return;
  s.add(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...s]));
  window.dispatchEvent(new CustomEvent('update-dot-cleared', { detail: { id } }));
}

export function hasUnseenForView(view) {
  const seen = getSeenSet();
  if (Object.entries(UPDATES).some(([id, meta]) => meta.view === view && !seen.has(id))) return true;
  return Object.entries(dynamicRegistry).some(([id, meta]) => meta.view === view && isDynamicUnseen(id));
}

// --- Dynamic (data-driven) update dots ---
// For sections whose "new" state depends on whether their fetched data changed
// since the user last opened them, rather than a one-time static announcement.

const SIG_STORAGE_KEY = 'tj_update_signatures_v1';
const dynamicRegistry = {}; // id -> { view, signature }

function getSignatures() {
  try { return JSON.parse(localStorage.getItem(SIG_STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function setSignature(id, sig) {
  const sigs = getSignatures();
  sigs[id] = sig;
  localStorage.setItem(SIG_STORAGE_KEY, JSON.stringify(sigs));
}

// Called whenever a section's data is (re)fetched. Records the latest signature
// for that section. The first time a section reports, its signature is taken as
// the seen baseline (no dot on first load).
export function reportDynamicUpdate(id, view, signature) {
  const sigs = getSignatures();
  dynamicRegistry[id] = { view, signature };
  if (sigs[id] === undefined) {
    setSignature(id, signature);
    return;
  }
  if (sigs[id] !== signature) {
    window.dispatchEvent(new CustomEvent('update-dot-cleared', { detail: { id } }));
  }
}

export function isDynamicUnseen(id) {
  const entry = dynamicRegistry[id];
  if (!entry) return false;
  const sigs = getSignatures();
  return sigs[id] !== undefined && sigs[id] !== entry.signature;
}

export function markDynamicSeen(id) {
  const entry = dynamicRegistry[id];
  if (!entry) return;
  setSignature(id, entry.signature);
  window.dispatchEvent(new CustomEvent('update-dot-cleared', { detail: { id } }));
}

// The last-seen value for a dynamic id — i.e. what the value WAS before it changed
// to its current (unseen) value. Only meaningful when isDynamicUnseen(id) is true.
export function getDynamicPreviousValue(id) {
  return getSignatures()[id];
}
