// Test kit for the Settings save contract (Oct 23 2026, "Settings saves one
// way"): a panel mounted in a Settings group that has a typed field keeps a
// draft, says it is dirty through lib/groupDirty.js the moment that field
// changes, and has ONE SaveRow at its foot. Used by the *.contract.test.jsx
// files; not a test itself (vitest only collects *.test.*).
import { render, fireEvent } from '@testing-library/react';
import { GroupDirtyContext, makeGroupReporter } from '../../lib/groupDirty';

// Render `ui` inside a Settings group; `group.dirty` / `group.saves` follow
// what its forms report.
export function renderInGroup(ui, options) {
  const group = { dirty: false, saves: [], reports: 0 };
  const report = makeGroupReporter((d, saves) => { group.dirty = d; group.saves = saves; group.reports += 1; });
  const utils = render(<GroupDirtyContext.Provider value={report}>{ui}</GroupDirtyContext.Provider>, options);
  return { ...utils, group };
}

const TYPED = 'input:not([type]), input[type="text"], input[type="number"], input[type="email"], input[type="time"], input[type="url"], input[type="tel"], textarea';

// Every typed field in `root` that a person could edit (not a search box,
// not disabled, not read-only).
export function typedFields(root) {
  return [...root.querySelectorAll(TYPED)].filter(el => !el.disabled && !el.readOnly
    && !el.closest('[data-nx-noguard]') && el.type !== 'search'
    && !/^(search|filter|find)/i.test(el.getAttribute('placeholder') || ''));
}

// Change one typed field to a different value.
export function editField(el) {
  const v = el.value;
  const next = el.type === 'number' ? String((Number(v) || 0) + 1) : el.type === 'time' ? (v === '09:00' ? '10:00' : '09:00') : `${v}x`;
  fireEvent.change(el, { target: { value: next } });
  return next;
}

// How many Save rows the panel draws.
export const saveRows = (root) => root.querySelectorAll('[data-save-row]').length;
