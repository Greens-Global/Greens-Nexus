import { useMemo, useRef, useState } from 'react';
import { useAccountingPrefs } from './prefs';
import { DENSITIES } from './reportControls';

// Shared table helpers for the Accounting module (Oct 7, items 21 / 32 / 34),
// the hooks behind reportControls' CustomizeButton, Pager and ColumnResizer.

/**
 * The page math, on its own so it can be tested: which rows a page holds.
 * pageSize 0 (or less) = paging off, one page with everything.
 * Returns { page, pages, start, end, from, to, total } - start/end are slice
 * indexes, from/to are the 1-based row numbers shown to people (0/0 when empty).
 */
export function pageSlice(total, pageSize, page) {
  const size = Math.floor(Number(pageSize) || 0);
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (size <= 0 || !count) return { page: 1, pages: count ? 1 : 0, start: 0, end: count, from: count ? 1 : 0, to: count, total: count };
  const pages = Math.ceil(count / size);
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const start = (p - 1) * size;
  const end = Math.min(start + size, count);
  return { page: p, pages, start, end, from: start + 1, to: end, total: count };
}

/**
 * Pages a list: usePaged(rows, pageSize, resetKey) ->
 *   { rows (this page's), page, pages, from, to, total, setPage }
 * Back to page 1 whenever `resetKey` changes (filters, period, search - pass
 * anything comparable, e.g. a string or JSON of them) or the page size does.
 * Totals and exports should keep using ALL rows, never `rows` from here.
 * Spread the result onto <Pager />.
 */
export function usePaged(rows, pageSize, resetKey = '') {
  const total = rows ? rows.length : 0;
  const key = `${pageSize}|${typeof resetKey === 'string' ? resetKey : JSON.stringify(resetKey)}`;
  const [state, setState] = useState({ page: 1, key });
  // A new key starts over at page 1 (set during render: no flash of the old page).
  let page = state.page;
  if (state.key !== key) { page = 1; setState({ page: 1, key }); }
  const s = pageSlice(total, pageSize, page);
  const shown = useMemo(() => (!rows ? [] : s.end - s.start === rows.length ? rows : rows.slice(s.start, s.end)), [rows, s.start, s.end]);
  return {
    rows: shown, page: s.page, pages: s.pages, from: s.from, to: s.to, total: s.total,
    setPage: (n) => setState({ page: Math.max(1, n), key }),
  };
}

/**
 * Column widths for a report-style table, saved per viewer per table
 * (`useAccountingPrefs` key `colWidths: { [tableKey]: { [col]: px } }`).
 *   const cols = useColumnWidths('gl', { account: 240, memo: 260 }, { min: 60 });
 *   <th style={{ position: 'relative', width: cols.width('memo') }}>Memo <ColumnResizer {...cols.resizer('memo', 'Memo')} /></th>
 * width(key)       the px width (live while dragging), or the default, or undefined
 * setWidth(k, px)  save one width;  reset(k?) forget one (or all) for this table
 * resizer(k, name) the props for <ColumnResizer /> (drag live, save on release,
 *                  double-click fits the content)
 */
export function useColumnWidths(tableKey, defaults = {}, { min = 60, max = 1200 } = {}) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const [live, setLive] = useState(null);       // { key, w } while a drag is on
  const liveRef = useRef(null);
  const saved = useMemo(() => (prefs.colWidths && typeof prefs.colWidths === 'object' ? prefs.colWidths[tableKey] || {} : {}), [prefs.colWidths, tableKey]);
  const clamp = (w) => Math.min(max, Math.max(min, Math.round(Number(w) || 0)));
  const save = (next) => setPrefs({ colWidths: { ...(prefs.colWidths || {}), [tableKey]: next } });
  const setWidth = (key, w) => save({ ...saved, [key]: clamp(w) });
  const reset = (key) => {
    if (!key) { save({}); return; }
    const next = { ...saved };
    delete next[key];
    save(next);
  };
  const width = (key) => (live?.key === key ? live.w : Number(saved[key]) || defaults[key] || undefined);
  const resizer = (key, name) => ({
    label: `Resize the ${name || key} column`,
    onDrag: (w) => { liveRef.current = { key, w: clamp(w) }; setLive(liveRef.current); },
    onEnd: () => {
      const l = liveRef.current;
      liveRef.current = null;
      setLive(null);
      if (l) setWidth(l.key, l.w);
    },
    onFit: (w) => (w > 0 ? setWidth(key, w) : reset(key)),
  });
  return { width, widths: { ...defaults, ...saved }, setWidth, reset, resizer };
}

/**
 * The person's saved choices for the shared CustomizeButton options, as props
 * ready to spread: <CustomizeButton {...useCustomizePrefs(['density', 'pageSize'])} />.
 * features: any of 'density', 'pageSize', 'historicalEntities',
 * 'historicalAccounts', 'inactiveAccounts' - only those get handlers, so only
 * those draw. Keys in useAccountingPrefs: density (or `densityKey`), pageSize
 * (or `pageSizeKey`), showHistoricalEntities, showHistoricalAccounts,
 * showInactiveAccounts (off by default).
 */
export function useCustomizePrefs(features = [], { densityKey = 'density', defaultDensity = 'compact', pageSizeKey = 'pageSize' } = {}) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const want = new Set(features);
  const out = {};
  if (want.has('density')) {
    out.density = DENSITIES.some((d) => d.key === prefs[densityKey]) ? prefs[densityKey] : defaultDensity;
    out.onDensity = (d) => setPrefs({ [densityKey]: d });
  }
  if (want.has('pageSize')) {
    out.pageSize = Math.max(0, Math.floor(Number(prefs[pageSizeKey]) || 0));
    out.onPageSize = (n) => setPrefs({ [pageSizeKey]: Math.max(0, Math.floor(Number(n) || 0)) });
  }
  if (want.has('historicalEntities')) {
    out.showHistorical = !!prefs.showHistoricalEntities;
    out.onShowHistorical = (v) => setPrefs({ showHistoricalEntities: !!v });
  }
  if (want.has('historicalAccounts')) {
    out.showHistoricalAccounts = !!prefs.showHistoricalAccounts;
    out.onShowHistoricalAccounts = (v) => setPrefs({ showHistoricalAccounts: !!v });
  }
  if (want.has('inactiveAccounts')) {
    out.showInactiveAccounts = !!prefs.showInactiveAccounts;
    out.onShowInactiveAccounts = (v) => setPrefs({ showInactiveAccounts: !!v });
  }
  return out;
}
