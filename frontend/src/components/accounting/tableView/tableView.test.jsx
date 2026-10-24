import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The standard table view on a screen (10/23 meeting, item 01): the Filters
// panel (rules, All / Any, the count on the button), a heading's value list
// and menu (sort, filter this column, manual width, move, hide, show hidden),
// saved views per person (Unsaved, Update, Clear) that survive a refresh, and
// totals / export that follow the filter.

vi.mock('../../../api', () => ({
  api: {
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));

import { api } from '../../../api';
import { resetAccountingPrefs } from '../prefs';
import { TableViewBar, ViewHead, useTableView, viewTable } from '.';
import { sumColumn } from './model';

const COLUMNS = [
  { key: 'date', label: 'Date', type: 'date', value: (r) => r.date, text: (r) => `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)}`, width: 100 },
  { key: 'customer', label: 'Customer', text: (r) => r.customer, width: 200 },
  { key: 'credit', label: 'Credit', type: 'amount', value: (r) => r.credit, text: (r) => r.credit.toFixed(2), width: 110, total: true },
  { key: 'memo', label: 'Memo', text: (r) => r.memo, off: true, width: 200 },
];
const ROWS = [
  { id: 1, date: '2026-09-23', customer: 'Greens Sachse', credit: 3000, memo: 'Sept' },
  { id: 2, date: '2026-09-23', customer: 'Greens Austin', credit: 3921.42, memo: 'Sept' },
  { id: 3, date: '2026-08-21', customer: 'Greens Fairfield', credit: 3000, memo: 'Aug' },
  { id: 4, date: '2026-08-21', customer: 'Greens Austin', credit: 3828.24, memo: 'Aug' },
];

let lastExport = null;
function Harness({ tableKey = 'test-table' }) {
  const view = useTableView(tableKey, COLUMNS, ROWS);
  const credit = COLUMNS[2];
  return (
    <div>
      <div role="toolbar" aria-label="Controls"><TableViewBar view={view} /></div>
      <button type="button" onClick={() => { lastExport = viewTable(view.rows, view.columns, { title: 'Lines' }); }}>Export Now</button>
      <table>
        <thead><tr>{view.columns.map((c) => <ViewHead key={c.key} view={view} col={c} style={{ position: 'relative', width: c.width }} data-testid={`th-${c.key}`} />)}</tr></thead>
        <tbody>
          {view.rows.map((r) => <tr key={r.id} data-testid="row">{view.columns.map((c) => <td key={c.key}>{c.text(r)}</td>)}</tr>)}
          <tr><td data-testid="total">{sumColumn(view.rows, credit).toFixed(2)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
const rows = () => screen.queryAllByTestId('row').map((tr) => tr.textContent);
const headings = () => Array.from(document.querySelectorAll('thead th')).map((th) => th.querySelector('.acct-vh-text')?.textContent);
const flushSave = () => act(async () => { await new Promise((r) => setTimeout(r, 450)); });

beforeEach(() => { vi.clearAllMocks(); resetAccountingPrefs(); localStorage.clear(); lastExport = null; });


// The standard table view's panels load on first use (10/23 item 01): fetched
// once up front, so a busy run never waits on them inside a test.
beforeAll(async () => { await import('./panels'); }, 30000);
describe('Filters panel', () => {
  it('adds rules (field, condition, value), matches All or Any, counts them, deletes one', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'customer' } });
    expect(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }).value).toBe('contains');
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 value' }), { target: { value: 'austin' } });
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Filters (1 on)' })).toBeTruthy();
    expect(screen.getByTestId('total').textContent).toBe('7749.66');

    // A second rule on the amount: All = both, Any = either.
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 2 field' }), { target: { value: 'credit' } });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 2 condition' }), { target: { value: 'lt' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 2 value' }), { target: { value: '3,900' } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Filters (2 on)' })).toBeTruthy();
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Match all or any rule' }), { target: { value: 'any' } });
    expect(rows()).toHaveLength(4);
    expect(screen.getByTestId('total').textContent).toBe('13749.66');

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete rule 2' }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Filters (1 on)' })).toBeTruthy();
  });

  it('offers Between for amounts and dates, and Is Empty with no value box', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(panel).getByRole('button', { name: /Add Filter/ }));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'credit' } });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }), { target: { value: 'between' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 value' }), { target: { value: '3,500' } });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Rule 1 second value' }), { target: { value: '3,900' } });
    expect(rows().map((t) => t.includes('3828.24'))).toEqual([true]);
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 field' }), { target: { value: 'date' } });
    const conditions = Array.from(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }).options).map((o) => o.textContent);
    expect(conditions).toEqual(expect.arrayContaining(['Is Before', 'Is After', 'Is Between', 'Is Empty']));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Rule 1 condition' }), { target: { value: 'empty' } });
    expect(within(panel).queryByRole('textbox', { name: 'Rule 1 value' })).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});

describe('a heading', () => {
  it('filters by picking values from its list, with a search in the list', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter Customer by value' }));
    const list = await screen.findByRole('dialog', { name: 'Customer values' });
    expect(within(list).getAllByRole('checkbox').map((b) => b.checked)).toEqual([true, true, true, true]);
    fireEvent.click(within(list).getByRole('checkbox', { name: /Greens Austin/ }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Filters (1 on)' })).toBeTruthy();
    fireEvent.change(within(list).getByRole('textbox', { name: 'Search Customer values' }), { target: { value: 'fair' } });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);    // select-all of the results + Fairfield
    fireEvent.click(within(list).getByRole('button', { name: 'Clear Filter' }));
    expect(rows()).toHaveLength(4);
  });

  it('opens its menu: sort, move, hide, show hidden, manual width, filter this column', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Credit - column menu/ }));
    let menu = await screen.findByRole('menu', { name: 'Credit column' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Sort Descending/ }));
    expect(rows()[0]).toContain('3921.42');
    expect(screen.getByTestId('th-credit').getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(screen.getByRole('button', { name: /^Credit, sorted descending - column menu/ }));
    menu = await screen.findByRole('menu', { name: 'Credit column' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Move Left/ }));
    expect(headings()).toEqual(['Date', 'Credit', 'Customer']);

    fireEvent.click(screen.getByRole('button', { name: /^Date - column menu/ }));
    menu = await screen.findByRole('menu', { name: 'Date column' });
    expect(within(menu).getByRole('menuitem', { name: /Move Left/ }).disabled).toBe(true);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Hide Column/ }));
    expect(headings()).toEqual(['Credit', 'Customer']);

    fireEvent.click(screen.getByRole('button', { name: /^Customer - column menu/ }));
    menu = await screen.findByRole('menu', { name: 'Customer column' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Show Hidden Column \(2\)/ }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Memo' }));
    expect(headings()).toEqual(['Credit', 'Customer', 'Memo']);

    fireEvent.click(screen.getByRole('button', { name: /^Customer - column menu/ }));
    menu = await screen.findByRole('menu', { name: 'Customer column' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Manual Width/ }));
    fireEvent.change(within(menu).getByRole('spinbutton', { name: 'Customer width in pixels' }), { target: { value: '320' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Set' }));
    expect(screen.getByTestId('th-customer').style.width).toBe('320px');

    fireEvent.click(screen.getByRole('button', { name: /^Customer - column menu/ }));
    menu = await screen.findByRole('menu', { name: 'Customer column' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Filter This Column/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(panel).getByRole('combobox', { name: 'Rule 1 field' }).value).toBe('customer');
    expect(document.activeElement).toBe(within(panel).getByRole('textbox', { name: 'Rule 1 value' }));
  });
});

describe('saved views', () => {
  it('marks a change Unsaved, saves it as a view, updates it, clears back to it - per person, kept on the server', async () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(screen.getByRole('button', { name: 'View: Built-in Default' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter Customer by value' }));
    const list = await screen.findByRole('dialog', { name: 'Customer values' });
    fireEvent.click(within(list).getByRole('checkbox', { name: /Greens Austin/ }));
    expect(screen.getByText('Unsaved')).toBeTruthy();

    // Update on the built-in default asks for a name.
    fireEvent.click(screen.getByRole('button', { name: /Update/ }));
    const views = await screen.findByRole('menu', { name: 'Views' });
    fireEvent.change(within(views).getByRole('textbox', { name: 'Save As a New View' }), { target: { value: 'No Austin' } });
    fireEvent.click(within(views).getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'View: No Austin' })).toBeTruthy();
    expect(screen.queryByText('Unsaved')).toBeNull();

    // A change on the saved view, then Clear goes back to the view's state.
    fireEvent.click(screen.getByRole('button', { name: /^Credit - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Credit column' })).getByRole('menuitemradio', { name: /Sort Ascending/ }));
    expect(screen.getByText('Unsaved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('th-credit').getAttribute('aria-sort')).toBeNull();

    // Update writes the change into the view.
    fireEvent.click(screen.getByRole('button', { name: /^Credit - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Credit column' })).getByRole('menuitemradio', { name: /Sort Ascending/ }));
    fireEvent.click(screen.getByRole('button', { name: /Update/ }));
    expect(screen.queryByText('Unsaved')).toBeNull();

    // Kept on the server (the person's own layout) - a refresh / sign-out finds it there.
    await waitFor(() => expect(api.saveAccountingPrefs).toHaveBeenCalled(), { timeout: 2000 });
    const saved = api.saveAccountingPrefs.mock.calls.at(-1)[0];
    const entry = saved.tableViews['test-table'];
    expect(entry.list).toHaveLength(1);
    expect(entry.list[0]).toMatchObject({ name: 'No Austin', state: { picks: { customer: { out: ['Greens Austin'] } }, sort: { col: 'credit', dir: 'asc' } } });
    expect(entry.active).toBe(entry.list[0].id);
    unmount();

    // A new session: nothing local, the server hands the layout back.
    resetAccountingPrefs();
    localStorage.clear();
    api.getAccountingPrefs.mockResolvedValueOnce({ prefs: saved });
    render(<Harness />);
    expect(await screen.findByRole('button', { name: 'View: No Austin' })).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('3000.00');

    // Back to the built-in default, and the view can be deleted.
    fireEvent.click(screen.getByRole('button', { name: 'View: No Austin' }));
    const menu = await screen.findByRole('menu', { name: 'Views' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Built-in Default/ }));
    expect(rows()).toHaveLength(4);
  });

  it('keeps an unsaved change through a refresh, still marked Unsaved', async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Credit - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Credit column' })).getByRole('menuitemradio', { name: /Sort Descending/ }));
    await flushSave();
    unmount();
    render(<Harness />);
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect(rows()[0]).toContain('3921.42');
  });

  it('each table keeps its own views', async () => {
    render(<><Harness tableKey="a" /><Harness tableKey="b" /></>);
    const [first] = screen.getAllByRole('button', { name: /^Credit - column menu/ });
    fireEvent.click(first);
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Credit column' })).getByRole('menuitemradio', { name: /Sort Descending/ }));
    expect(screen.getAllByText('Unsaved')).toHaveLength(1);
  });
});

describe('export', () => {
  it('downloads exactly the filtered, sorted, visible columns', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter Customer by value' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Customer values' })).getByRole('checkbox', { name: /Greens Sachse/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Credit - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Credit column' })).getByRole('menuitemradio', { name: /Sort Descending/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Date - column menu/ }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Date column' })).getByRole('menuitem', { name: /Hide Column/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Now' }));
    expect(lastExport.columns.map((c) => c.label)).toEqual(['Customer', 'Credit']);
    expect(lastExport.rows).toEqual([['Greens Austin', 3921.42], ['Greens Austin', 3828.24], ['Greens Fairfield', 3000]]);
    expect(lastExport.totals).toEqual(['Total - 3 rows', 10749.66]);
  });
});
