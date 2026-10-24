import { useAccountingPrefs } from '../prefs';
import { useTableViewWith } from './useTableView';

// The standard table view of the Accounting tables (10/23 meeting, item 01).
// See ./model for what a view holds, ./useTableView for how it is kept per
// person, ./controls for the bar and headings (./panels loads on first use).

/** useTableView(tableKey, columns, rows, { sort, onOpen }) - see ./useTableView. */
export function useTableView(tableKey, columns, rows, options) {
  return useTableViewWith(useAccountingPrefs(), tableKey, columns, rows, options);
}
export { TableViewBar, ViewHead } from './controls';
export { viewCells } from './cells';
export { preloadPanels } from './load';
export { applyView, viewTable, sumColumn, isNumeric, textOf, numOf } from './model';
