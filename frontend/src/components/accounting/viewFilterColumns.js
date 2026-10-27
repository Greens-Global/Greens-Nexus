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
// `extra` adds what a column's box should also find ({ [key]: (r) => '...' }),
// e.g. a vendor's number behind its name.

/** The day a date cell holds, as MM/DD/YYYY ('' when blank). */
export function dayText(col, row) {
  const day = dayOf(col, row);
  return day ? formatDate(day) : textOf(col, row);
}

/** The filter box definitions of a table view's columns. */
export function filterColumnsOf(columns, extra = {}) {
  return (columns || []).filter((c) => c && !c.noFilter).map((c) => {
    if (isNumeric(c)) return { key: c.key, label: c.label, num: true, value: (r) => numOf(c, r) };
    const more = extra[c.key];
    const read = c.type === 'date' ? (r) => dayText(c, r) : (r) => textOf(c, r);
    return {
      key: c.key, label: c.label,
      text: more ? (r) => `${read(r)} ${more(r) || ''}` : read,
      ...(c.type === 'date' ? { placeholder: 'MM/DD/YYYY' } : {}),
    };
  });
}
