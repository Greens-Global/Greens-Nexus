// The boxes under the headings (columnFilters.jsx) for a table already on the
// standard table view (10/27): its view columns say what each box filters, so
// a table lists them once. Amounts and counts compare (=, >, <, Between); the
// rest are "contains"; the action columns (noFilter) get none. `text` swaps
// what a column's box searches - a name cell that also shows a code, say.

export function filterColumnsOf(columns, text = {}) {
  return (columns || []).filter((c) => !c.noFilter).map((c) => (c.type === 'amount' || c.type === 'number'
    ? { key: c.key, label: c.label, num: true, value: c.value }
    : { key: c.key, label: c.label, text: text[c.key] || c.text, ...(c.type === 'date' ? { placeholder: 'MM/DD/YYYY' } : {}) }));
}

/** The filter cells on a table whose own stylesheet has no rule for them:
 *  the boxes' tight padding, the pinned first column (`pinned`) with its heading. */
export const filterCellOf = (pinned = '') => (col) => ({ className: pinned && col.key === pinned ? 'acct-head' : undefined, style: { padding: '3px 4px 4px' } });
