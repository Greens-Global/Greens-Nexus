import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Portfolio } from './Portfolio.jsx';
import { EMPTY_FILTERS } from '../../lib/portfolioQuery.js';

// The Properties tab (Neil, 11/17/2026): a render smoke test of the register - the view's
// name, the summary sentence and what needs you, the smart search, the filter words, the
// list with its sums, the bulk line and the views menu. The old Company dropdown and its
// "Needs a Company" option are retired: bulk Set Company and the Company filter's
// No Company replace them.

vi.mock('../../../api.js', () => ({ api: {} }));

const COMPANIES = [{ id: 'c1', name: 'Greens Storage', assignable: true }];
const ASSETS = [
  { id: 'p1', kind: 'property', name: 'Temecula', city: 'Temecula', state: 'CA', assetType: 'Self-Storage', devStage: 'Stabilized', companyId: 'c1', acreage: '9.65', unitsTotal: '516', manager: 'Sahil Desai' },
  { id: 'p2', kind: 'property', name: 'Austin', city: 'Austin', state: 'TX', assetType: 'Self-Storage', devStage: 'Stabilized', acreage: '3.45', nrsf: '151620', unitsTotal: '1005', manager: 'Neil Kadakia', taxDue: '2020-04-10' },
  { id: 'p3', kind: 'property', name: 'Georgetown', city: 'Georgetown', state: 'TX', assetType: 'Retail', devStage: 'Entitlement' },
  { id: 'p4', kind: 'property', name: 'Georgetown Yard', state: 'TX', parentId: 'p3', acreage: '2' },
  { id: 'v1', kind: 'vehicle', name: 'Ford Transit', devStage: 'In Service' },
];

function Harness({ onBulkSet = vi.fn(), openAsset = vi.fn(), initial = null }) {
  const [view, setView] = useState(initial || { id: 'all', filters: EMPTY_FILTERS, groupBy: 'none', sort: 'name' });
  const [mode, setMode] = useState('list');
  const [saved, setSaved] = useState([]);
  return (
    <Portfolio assets={ASSETS} store={{ properties: ASSETS, logs: [] }} companies={COMPANIES} canClearCompany view={{ ...view, mode }} onView={setView}
      mode={mode} onMode={setMode} saved={saved} onSaveViews={setSaved} me={{ name: 'Neil Kadakia' }} openAsset={openAsset}
      onBulkSet={onBulkSet} onCopyLink={() => {}} actions={<button type="button">New</button>} />
  );
}

afterEach(cleanup);

describe('Properties tab', () => {
  it('draws the view name, the sentence, what needs you and the list (properties only, parcels summed)', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /All Properties/ })).toBeTruthy();
    expect(screen.getByText('3 properties in 2 states - 15 acres and 152,000 rentable square feet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 date passed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 with no asset manager' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Properties' });
    expect(within(table).getByText('Temecula')).toBeTruthy();
    expect(within(table).queryByText('Ford Transit')).toBeNull();
    expect(within(table).queryByText('Georgetown Yard')).toBeNull();
    expect(within(table).getByText('Not set')).toBeTruthy();
    // The parcel group's row shows the parcels' sum.
    const row = within(table).getByText('Georgetown').closest('tr');
    expect(within(row).getByText('2.00')).toBeTruthy();
    expect(within(row).getByText(/2 parcels/)).toBeTruthy();
    // No uppercase anywhere on the register.
    expect(document.body.innerHTML).not.toMatch(/uppercase/);
  });

  it('a link in the needs line filters to it, and the words say so', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 with no asset manager' }));
    const words = screen.getByLabelText('Filters in use');
    expect(within(words).getByText('Asset Manager')).toBeTruthy();
    expect(within(words).getByText('Not set')).toBeTruthy();
    expect(screen.getByText('1 of 3 properties')).toBeTruthy();
    expect(screen.queryByText('Temecula')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Temecula')).toBeTruthy();
  });

  it('Enter in the search applies the top Filter By; plain words search', () => {
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Search or filter properties' });
    fireEvent.change(box, { target: { value: 'self storage in TX' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    const words = screen.getByLabelText('Filters in use');
    expect(within(words).getByText('Self-Storage')).toBeTruthy();
    expect(within(words).getByText('Texas')).toBeTruthy();
    expect(screen.getByText('1 of 3 properties')).toBeTruthy();
  });

  it('selecting rows brings the bulk line, which saves through onBulkSet', () => {
    const onBulkSet = vi.fn();
    render(<Harness onBulkSet={onBulkSet} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Temecula' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Austin' }));
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set Stage' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Construction' }));
    expect(onBulkSet).toHaveBeenCalledWith(['p1', 'p2'], 'stage', 'Construction');
  });

  it('the views menu counts the suggested views; picking one names the page', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /All Properties/ }));
    const mine = screen.getByRole('menuitemradio', { name: /My Properties/ });
    expect(within(mine).getByText('1')).toBeTruthy();
    fireEvent.click(mine);
    expect(screen.getByRole('button', { name: /My Properties/ })).toBeTruthy();
    expect(screen.getByText('Austin')).toBeTruthy();
    expect(screen.queryByText('Temecula')).toBeNull();
  });

  it('Gallery puts nothing on the photo and one facts line under it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Gallery' }));
    expect(screen.getByText('3.45 acres · 151,620 rentable sf · 1,005 units')).toBeTruthy();
    expect(screen.getByText('9.65 acres · 516 units')).toBeTruthy();
    expect(screen.getByText('Entitlement')).toBeTruthy();
  });

  it('opens a property from its row', () => {
    const openAsset = vi.fn();
    render(<Harness openAsset={openAsset} />);
    fireEvent.click(screen.getByText('Austin'));
    expect(openAsset).toHaveBeenCalledWith('p2', 'property');
  });
});
