import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getAccountingLocations = vi.fn();
vi.mock('../../../api', () => ({ api: { getAccountingLocations: (...a) => getAccountingLocations(...a) } }));

import { LedgerLinkPanel } from './LedgerLinkPanel.jsx';

// Link to the Ledger (Neil, 11/19/2026): one question per owner name, the rule's match already
// picked, nothing linked until a person presses the button.
const LEDGER = { entities: [
  { code: '63000', name: 'Harbor Heritage, LLC.', parent_code: null },
  { code: '63001', name: '(G) Harbor Heritage, LLC.', parent_code: '63000' },
  { code: '61000', name: 'Harbor Family Limited Partnership', parent_code: null },
] };
const ASSETS = [
  { id: 'a', kind: 'property', name: 'Lot 1', entity: 'Harbor Heritage LLC' },
  { id: 'b', kind: 'property', name: 'Lot 2', entity: 'Harbor Heritage LL' },
  { id: 'c', kind: 'property', name: 'Canyon Store', entity: 'Vale Family Trust' },
  { id: 'd', kind: 'property', name: 'Open Field', entity: '' },
  { id: 'e', kind: 'property', name: 'Linked Already', entity: 'Harbor Heritage LLC', entityCode: '63000' },
];

beforeEach(() => { getAccountingLocations.mockReset(); });

describe('LedgerLinkPanel', () => {
  it('asks once per owner, ticks only the exact match and links what is ticked', async () => {
    getAccountingLocations.mockResolvedValue(LEDGER);
    const onLink = vi.fn();
    render(<LedgerLinkPanel assets={ASSETS} onLink={onLink} onClose={vi.fn()} />);
    expect(screen.getByText(/4 properties have no ledger entity/)).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Link Harbor Heritage LLC' })).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: 'Link Harbor Heritage LLC' }).checked).toBe(true);
    expect(screen.getByText('2 properties - Lot 1, Lot 2')).toBeTruthy();
    expect(screen.getByText('Same name in the books.')).toBeTruthy();
    // No match in the books and no owner typed: listed, never ticked, cannot be ticked without a pick.
    expect(screen.getByRole('checkbox', { name: 'Link Vale Family Trust' }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Link Open Field' }).checked).toBe(false);
    expect(screen.getByText('No owner typed on this property.')).toBeTruthy();
    expect(screen.getByText('Pick its entity, or leave it.')).toBeTruthy();
    expect(screen.getByText('Not found in the books by name - pick one, or leave it.')).toBeTruthy();
    expect(screen.queryByText('Linked Already')).toBeNull();

    expect(onLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link 2 Properties' }));
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith([{ id: 'a', code: '63000' }, { id: 'b', code: '63000' }]);
  });

  it('links nothing once the person unticks the match', async () => {
    getAccountingLocations.mockResolvedValue(LEDGER);
    render(<LedgerLinkPanel assets={ASSETS} onLink={vi.fn()} onClose={vi.fn()} />);
    const box = await screen.findByRole('checkbox', { name: 'Link Harbor Heritage LLC' });
    fireEvent.click(box);
    expect(screen.getByRole('button', { name: 'Link Properties' }).disabled).toBe(true);
    expect(screen.getByText('Tick an owner to link its properties.')).toBeTruthy();
  });

  it('says so in plain words when the person has no Accounting access', async () => {
    getAccountingLocations.mockRejectedValue({ status: 403 });
    render(<LedgerLinkPanel assets={ASSETS} onLink={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/You do not have access to Accounting/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Link/ })).toBeNull();
  });

  it('offers Try Again when the books do not answer, and never renders blank', async () => {
    getAccountingLocations.mockRejectedValueOnce({ message: 'Timed out' }).mockResolvedValueOnce(LEDGER);
    render(<LedgerLinkPanel assets={ASSETS} onLink={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('checkbox', { name: 'Link Harbor Heritage LLC' })).toBeTruthy();
  });

  it('has nothing to ask when every property is linked', () => {
    getAccountingLocations.mockResolvedValue(LEDGER);
    render(<LedgerLinkPanel assets={[ASSETS[4]]} onLink={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Every property has its ledger entity.')).toBeTruthy();
  });
});
