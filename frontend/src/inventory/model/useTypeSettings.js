// Item Management - each item type's Borrowable switch and longest loan
// (Items redesign, Neil 11/02/2026; GET /items/types/settings).
// One shared load for Borrow, the cart and Manage Types; save() refreshes it.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

export const LOAN_CEILING_DAYS = 90;

let _rows = null;
let _loading = null;
const _subs = new Set();

export function loadTypeSettings(force = false) {
  if (_loading) return _loading;
  if (_rows && !force) return Promise.resolve(_rows);
  _loading = api.getItemTypeSettings()
    .then((rows) => { _rows = Array.isArray(rows) ? rows : []; _subs.forEach(fn => fn(_rows)); return _rows; })
    .catch(() => { _rows = _rows || []; _subs.forEach(fn => fn(_rows)); return _rows; })
    .finally(() => { _loading = null; });
  return _loading;
}

export function _resetTypeSettings() { _rows = null; _loading = null; }

/** Borrowable for an item type: the server's effective switch; a type the
 *  server does not list (imported, never curated) follows the default rule
 *  - it is borrowable when it holds temporary items, which a Borrow listing
 *  of temporary items already means. */
export function isTypeBorrowable(byName, type) {
  const row = byName.get(String(type || '').trim().toLowerCase());
  return row ? row.borrowable !== false : true;
}

export function loanCapFor(byName, type) {
  const row = byName.get(String(type || '').trim().toLowerCase());
  return row?.loanCapDays || LOAN_CEILING_DAYS;
}

export function useTypeSettings() {
  const [rows, setRows] = useState(_rows);
  useEffect(() => {
    _subs.add(setRows);
    loadTypeSettings();
    return () => { _subs.delete(setRows); };
  }, []);
  const byName = useMemo(() => new Map((rows || []).map(r => [String(r.name || '').trim().toLowerCase(), r])), [rows]);
  return {
    rows: rows || [], loaded: rows != null, byName,
    reload: () => loadTypeSettings(true),
    async save(name, patch) {
      const next = await api.updateItemTypeSettings(name, patch);
      _rows = Array.isArray(next) ? next : _rows;
      _subs.forEach(fn => fn(_rows));
      return _rows;
    },
  };
}
