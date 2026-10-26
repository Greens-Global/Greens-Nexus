// A reload lands back on the same screen (Charmi, 10/22: "When you do refresh
// it should take you back to the same screen. It is in HR module but not in
// accounting module"). The tab is already in the address; what a screen picked
// inside it - the period, the filters, the narrowed account - is kept for THIS
// browser tab in sessionStorage, the way HR's time card keeps the last card
// opened (PayrollTimecard, `nexus.payroll.last`). A new tab or window starts
// fresh. Each module calls these from its own view or component.
import { useEffect, useState } from 'react';

const PREFIX = 'nexus.refresh.';
// Keys a screen has written since this page loaded. Only a reload brings a
// screen back: moving around inside Nexus and coming back opens it fresh, as
// before, because by then the key is in here.
const touched = new Set();

/**
 * What was kept under `key` before this page loaded, or `fallback` (nothing
 * kept, already used in this page load, storage blocked, bad JSON).
 */
export function readRefresh(key, fallback = null) {
  if (touched.has(key)) return fallback;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Keep `value` under `key` for this tab; null / undefined forgets it. */
export function saveRefresh(key, value) {
  touched.add(key);
  try {
    if (value == null) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* storage blocked - just this visit */ }
}

/**
 * useState that survives a reload of this tab. `initial` (a value or a
 * function) is used only when nothing was kept; `accept(kept)` may refuse a
 * kept value that no longer fits (a period key that was renamed).
 */
export function useRefreshState(key, initial, accept = () => true) {
  const [value, setValue] = useState(() => {
    const kept = readRefresh(key);
    if (kept != null && accept(kept)) return kept;
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => { saveRefresh(key, value); }, [key, value]);
  return [value, setValue];
}

/** Tests: forget which keys this page load has written. */
export function resetRefreshForTests() { touched.clear(); }
