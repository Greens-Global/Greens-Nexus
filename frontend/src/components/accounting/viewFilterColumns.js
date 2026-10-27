import { formatDate } from '../../lib/datetime';
import { dayOf, isNumeric, numOf, textOf } from './tableView/model';

// The filter boxes (columnFilters.jsx) of a table that already has a table
// view (./tableView): one definition per column, read from the view's own
// column list, so a table never describes its columns twice (item 14, Charmi
// 10/26: "There should be search option for all").
//
//   amount / number  =, >, <, >=, <=, Between on the figure (numOf)
//   date             "contains" on the day as MM/DD/YYYY (12/0 finds December)
//   text             "contains" on what the cell reads (textOf)
//   noFilter         no box (an action column)
//
//   const filterCols = useMemo(() => filterColumnsOf(COLUMNS), [COLUMNS]);
//   const filters = useColumnFilters(rows, filterCols);
//   const view = useTableView('key', COLUMNS, filters.rows);
//
// Two options, each { [key]: (r) => '...' } for a text or date column:
//   also     adds what the box should also find, e.g. a vendor's number
//            behind its name
//   instead  replaces what the box searches, e.g. a name cell that also
//            shows a code, or a date cell read as shown ("01/01/2026 to
//            Month to Month") rather than as one day

/** The day a date cell holds, as MM/DD/YYYY ('' when blank). */
export function dayText(col, row) {
  const day = dayOf(col, row);
  return day ? formatDate(day) : textOf(col, row);
}

/** The filter box definitions of a table view's columns. */
export function filterColumnsOf(columns, { also = {}, instead = {} } = {}) {
  return (columns || []).filter((c) => c && !c.noFilter).map((c) => {
    if (isNumeric(c)) return { key: c.key, label: c.label, num: true, value: (r) => numOf(c, r) };
    const more = also[c.key];
    const read = instead[c.key] || (c.type === 'date' ? (r) => dayText(c, r) : (r) => textOf(c, r));
    return {
      key: c.key, label: c.label,
      text: more ? (r) => `${read(r)} ${more(r) || ''}` : read,
      ...(c.type === 'date' ? { placeholder: 'MM/DD/YYYY' } : {}),
    };
  });
}

/** The filter cells on a table whose own stylesheet has no rule for them:
 *  the boxes' tight padding, the pinned first column (`pinned`) with its heading. */
export const filterCellOf = (pinned = '') => (col) => ({ className: pinned && col.key === pinned ? 'acct-head' : undefined, style: { padding: '3px 4px 4px' } });
