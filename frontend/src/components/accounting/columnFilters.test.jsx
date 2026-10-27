import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColumnFilterRow, columnFilterSet, columnFiltersActive, filterRowsByColumns, useColumnFilters } from './columnFilters';

// The shared filter row under the headings (10/27): what MRE and AMA had on
// their own, now one piece - text "contains", =, >, <, Between on amounts,
// the filters stacking, and the rows the screen exports.

const COLUMNS = [
  { key: 'vendor', label: 'Vendor', text: (r) => r.vendor },
  { key: 'amount', label: 'Amount', num: true, value: (r) => r.amount },
  { key: 'fee', label: 'Fee', num: true, text: (r) => r.fee },           // no value(): read from text()
  { key: 'date', label: 'Date', text: (r) => r.date, placeholder: 'MM/DD/YYYY' },
];
const ROWS = [
  { id: 'A', vendor: 'The Home Depot, Inc.', amount: 150, fee: '2.50', date: '10/01/2026' },
  { id: 'B', vendor: 'Amazon', amount: -40, fee: '0.00', date: '09/15/2026' },
  { id: 'C', vendor: 'Amazon Business', amount: 220, fee: '1.00', date: '10/20/2026' },
];
const ids = (rows) => rows.map((r) => r.id);

describe('filterRowsByColumns', () => {
  it('lets every row through with nothing typed', () => {
    expect(ids(filterRowsByColumns(ROWS, {}, COLUMNS))).toEqual(['A', 'B', 'C']);
    expect(ids(filterRowsByColumns(ROWS, { vendor: '   ', amount: { op: '>', a: '' } }, COLUMNS))).toEqual(['A', 'B', 'C']);
    expect(filterRowsByColumns(null, { vendor: 'x' }, COLUMNS)).toEqual([]);
  });

  it('text holds every word typed, any case, any order', () => {
    expect(ids(filterRowsByColumns(ROWS, { vendor: 'amazon' }, COLUMNS))).toEqual(['B', 'C']);
    expect(ids(filterRowsByColumns(ROWS, { vendor: 'depot HOME' }, COLUMNS))).toEqual(['A']);
    expect(ids(filterRowsByColumns(ROWS, { date: '10/' }, COLUMNS))).toEqual(['A', 'C']);
  });

  it('amounts compare with =, >, <, >=, <= and Between', () => {
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '>', a: '100' } }, COLUMNS))).toEqual(['A', 'C']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '<', a: '0' } }, COLUMNS))).toEqual(['B']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '>=', a: '150' } }, COLUMNS))).toEqual(['A', 'C']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '<=', a: '150' } }, COLUMNS))).toEqual(['A', 'B']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: 'between', a: '100', b: '200' } }, COLUMNS))).toEqual(['A']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: 'between', a: '200', b: '100' } }, COLUMNS))).toEqual(['A']);
    // "=" with no sign matches either sign, as in Ledger Search.
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '=', a: '40' } }, COLUMNS))).toEqual(['B']);
    expect(ids(filterRowsByColumns(ROWS, { amount: { op: '=', a: '-40' } }, COLUMNS))).toEqual(['B']);
    // A column without value() compares its text().
    expect(ids(filterRowsByColumns(ROWS, { fee: { op: '>', a: '0.5' } }, COLUMNS))).toEqual(['A', 'C']);
  });

  it('stacks the filters, and ignores one typed on a column not given', () => {
    expect(ids(filterRowsByColumns(ROWS, { vendor: 'amazon', amount: { op: '>', a: '0' } }, COLUMNS))).toEqual(['C']);
    expect(ids(filterRowsByColumns(ROWS, { notShown: 'zzz' }, COLUMNS))).toEqual(['A', 'B', 'C']);
  });

  it('says whether a box holds a filter', () => {
    expect(columnFilterSet(COLUMNS[0], 'x')).toBe(true);
    expect(columnFilterSet(COLUMNS[0], ' ')).toBe(false);
    expect(columnFilterSet(COLUMNS[1], { op: 'between', a: '', b: '5' })).toBe(true);
    expect(columnFilterSet(COLUMNS[1], { op: '=', a: '' })).toBe(false);
    expect(columnFiltersActive(COLUMNS, {})).toBe(false);
    expect(columnFiltersActive(COLUMNS, { amount: { op: '>', a: '1' } })).toBe(true);
  });
});

function Table({ columns = COLUMNS, filterColumns, onRows = () => {} }) {
  const filters = useColumnFilters(ROWS, COLUMNS);
  onRows(filters.rows);
  return (
    <>
      <span data-testid="filtering">{String(filters.filtering)}</span>
      <button type="button" onClick={filters.clear}>Clear Column Filters</button>
      <table className="acct-report acct-sticky-head">
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          <ColumnFilterRow columns={columns} filterColumns={filterColumns} typed={filters.typed} onChange={filters.setFilter}
            cellProps={(c) => ({ className: c.key === 'vendor' ? 'acct-head' : undefined })} />
        </thead>
        <tbody>{filters.rows.map((r) => <tr key={r.id}><td>{r.id}</td></tr>)}</tbody>
      </table>
    </>
  );
}

describe('ColumnFilterRow + useColumnFilters', () => {
  it('draws a "contains" box for text and the operator box for amounts, in the view order', () => {
    const { container } = render(<Table />);
    const row = container.querySelector('thead tr.acct-filter-row');
    expect(row).toBeTruthy();
    expect(row.querySelectorAll('td')).toHaveLength(4);
    expect(row.querySelector('td').className).toBe('acct-head');
    expect(screen.getByLabelText('Filter Vendor').getAttribute('placeholder')).toBe('contains');
    expect(screen.getByLabelText('Filter Date').getAttribute('placeholder')).toBe('MM/DD/YYYY');
    expect(screen.getByLabelText('Operator for Amount')).toBeTruthy();
    expect([...screen.getByLabelText('Operator for Amount').options].map((o) => o.value)).toEqual(expect.arrayContaining(['=', '>', '<', 'between']));
  });

  it('filters as typed, offers Between, and clears', () => {
    let shown = [];
    render(<Table onRows={(r) => { shown = r; }} />);
    expect(screen.getByTestId('filtering').textContent).toBe('false');
    fireEvent.change(screen.getByLabelText('Filter Vendor'), { target: { value: 'amazon' } });
    expect(ids(shown)).toEqual(['B', 'C']);
    expect(screen.getByTestId('filtering').textContent).toBe('true');
    fireEvent.change(screen.getByLabelText('Operator for Amount'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('Filter Amount'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('Filter Amount up to'), { target: { value: '300' } });
    expect(ids(shown)).toEqual(['C']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Column Filters' }));
    expect(ids(shown)).toEqual(['A', 'B', 'C']);
    expect(screen.getByLabelText('Filter Vendor').value).toBe('');
  });

  it('leaves a cell empty for a column shown with no filter', () => {
    const shownColumns = [...COLUMNS, { key: 'actions', label: 'Actions' }];
    const { container } = render(<Table columns={shownColumns} filterColumns={COLUMNS} />);
    const cells = container.querySelectorAll('tr.acct-filter-row td');
    expect(cells).toHaveLength(5);
    expect(cells[4].childElementCount).toBe(0);
  });
});
