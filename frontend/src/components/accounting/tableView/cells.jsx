import { cloneElement, isValidElement } from 'react';

/**
 * The cells of one row in the view's order: give each column's cell by key,
 * get back the ones shown. Works for header, body and totals rows alike.
 *   <tr>{viewCells(view, { vendor: <td>...</td>, total: <td>...</td> })}</tr>
 * A key with no cell gives an empty <td>.
 */
export function viewCells(view, cells, empty = null) {
  return view.columns.map((c) => {
    const cell = cells[c.key];
    if (cell === undefined) return empty ? cloneElement(empty(c), { key: c.key }) : <td key={c.key} />;
    return isValidElement(cell) ? cloneElement(cell, { key: c.key }) : cell;
  });
}
