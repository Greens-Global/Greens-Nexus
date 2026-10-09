// Styles for a column sized by useColumnWidths (./tableHooks) on a table with
// the browser's automatic layout (Oct 7, item 32 - Loans, Stress Test, MRI,
// MRE). A width on its own is only a hint there: the column still grows to
// its longest cell. So a column the person has sized gets a fixed width on
// its header and its cells clip to it ("..." with the full text on hover);
// an unsized column keeps sizing to its content, as before.
//
//   const cols = useColumnWidths('loans');
//   <th style={{ ...headStyle(cols.width('lender')) }}>Lender <ColumnResizer {...cols.resizer('lender', 'Lender')} /></th>
//   <td style={cellStyle(cols.width('lender'))}>...</td>

/** The header cell: position: relative for the drag handle, the width when set. */
export function headStyle(width, extra = null) {
  const w = Number(width) || 0;
  return { position: 'relative', ...(w ? { width: w, minWidth: w, maxWidth: w } : {}), ...(extra || {}) };
}

/** A body cell of a sized column: clipped to the width with an ellipsis. */
export function cellStyle(width, extra = null) {
  const w = Number(width) || 0;
  return { ...(w ? { width: w, minWidth: w, maxWidth: w, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}), ...(extra || {}) };
}
