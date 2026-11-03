import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

// Items phase 4: the host the Items view mounts. An item's own link opens
// the item (from the screen's list, else the server); one the server walls
// off shows the calm "You Do Not Have Access to This Item" state - never a
// blank screen; Close goes back to where the person was; the scanner and
// the tag sheet open from their events.

const inv = { items: [], itemsLoading: false, checkouts: [] };
vi.mock('../../contexts/InventoryContext', () => ({ useInventory: () => inv }));
vi.mock('../../components/Assignments', () => ({ useAssignments: () => ({ assignments: [] }) }));
const calls = {
  getItemByCode: vi.fn(),
  getItemTags: vi.fn(async () => []),
  getItemApprovers: vi.fn(async () => []),
  getItemCustomFields: vi.fn(async () => []),
  addItemToCart: vi.fn(async () => ({ id: 'cart-row-1' })),
};
vi.mock('../../api', () => {
  const api = new Proxy({}, { get: (_, k) => calls[k] || vi.fn(async () => []) });
  return { api, default: api };
});

const { ItemScanHost } = await import('./ItemScanHost');
const { openItemScanner, printItemTags } = await import('./events');

const DRILL = { id: 'it-a', name: 'Hammer Drill', serialNumber: 'GG-00042', itemType: 'Tools', status: 'available', ownershipType: 'transient', location: 'Austin Yard' };
const notFound = () => Object.assign(new Error('No item you can see matches that code'), { status: 404 });

afterEach(() => {
  cleanup();
  inv.items = []; inv.itemsLoading = false; inv.checkouts = [];
  Object.values(calls).forEach((f) => f.mockReset());
  calls.getItemTags.mockResolvedValue([]);
  calls.getItemApprovers.mockResolvedValue([]);
  calls.getItemCustomFields.mockResolvedValue([]);
  calls.addItemToCart.mockResolvedValue({ id: 'cart-row-1' });
});

describe('an item link', () => {
  it('opens the item from the screen\'s own list, with its primary action', async () => {
    inv.items = [DRILL];
    render(<ItemScanHost activeSub="item/it-a" onSubChange={vi.fn()} userEmail="erin@greensglobal.com" toast={vi.fn()} />);
    expect(await screen.findByText('Hammer Drill')).toBeInTheDocument();
    expect(screen.getByText('GG-00042')).toBeInTheDocument();
    expect(screen.getByText('Available to borrow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Borrow' })).toBeInTheDocument();
    expect(calls.getItemByCode).not.toHaveBeenCalled();
  });

  it('asks the server for an item the list does not hold', async () => {
    calls.getItemByCode.mockResolvedValue({ ...DRILL, id: 'it-z', name: 'Generator' });
    render(<ItemScanHost activeSub="item/it-z" onSubChange={vi.fn()} />);
    expect(await screen.findByText('Generator')).toBeInTheDocument();
    expect(calls.getItemByCode).toHaveBeenCalledWith('it-z');
  });

  it('outside the person\'s companies: the calm no-access state, never blank', async () => {
    calls.getItemByCode.mockRejectedValue(notFound());
    const onSubChange = vi.fn();
    render(<ItemScanHost activeSub="item/walled-1" onSubChange={onSubChange} />);
    // While it is asked: a skeleton, not nothing.
    expect(screen.getByRole('status', { name: 'Loading the item' })).toBeInTheDocument();
    expect(await screen.findByText('You Do Not Have Access to This Item')).toBeInTheDocument();
    expect(screen.getByTestId('nx-item-no-access')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Items' }));
    expect(onSubChange).toHaveBeenCalledWith(null);
  });

  it('waits for the list before asking the server', async () => {
    inv.itemsLoading = true;
    render(<ItemScanHost activeSub="item/it-a" onSubChange={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading the item' })).toBeInTheDocument();
    expect(calls.getItemByCode).not.toHaveBeenCalled();
  });

  it('Close goes back to the tab the person came from', async () => {
    inv.items = [DRILL];
    const onSubChange = vi.fn();
    const { rerender } = render(<ItemScanHost activeSub="catalog" onSubChange={onSubChange} />);
    expect(screen.queryByText('Hammer Drill')).toBeNull();
    rerender(<ItemScanHost activeSub="item/it-a" onSubChange={onSubChange} />);
    expect(await screen.findByText('Hammer Drill')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1));
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('catalog'));
  });

  it('Borrow puts the item in the one cart and goes to Borrow', async () => {
    inv.items = [DRILL];
    const moves = [];
    const onNav = (e) => moves.push(e.detail);
    window.addEventListener('nexus:navigate', onNav);
    const toast = vi.fn();
    render(<ItemScanHost activeSub="item/it-a" onSubChange={vi.fn()} userEmail="erin@greensglobal.com" toast={toast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Borrow' }));
    window.removeEventListener('nexus:navigate', onNav);
    expect(calls.addItemToCart).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'it-a' }));
    expect(moves).toContainEqual({ view: 'inventory', sub: 'borrow' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Hammer Drill added to your cart.', undefined));
  });

  it('Close from an item opened first (a QR tag) goes to closeSub', async () => {
    inv.items = [DRILL];
    const onSubChange = vi.fn();
    render(<ItemScanHost activeSub="item/it-a" onSubChange={onSubChange} closeSub="borrow" />);
    expect(await screen.findByText('Hammer Drill')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1));
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('borrow'));
  });

  it('a renderItem prop draws the found item instead (the redesign\'s record sheet)', async () => {
    inv.items = [DRILL];
    const renderItem = vi.fn(({ item, view }) => <div>Record for {item.name}: {view.actions.map((a) => a.key).join(',')}</div>);
    render(<ItemScanHost activeSub="item/it-a" onSubChange={vi.fn()} renderItem={renderItem} />);
    expect(await screen.findByText('Record for Hammer Drill: borrow')).toBeInTheDocument();
  });

  it('managers get Details and Print Tag on the item', async () => {
    inv.items = [DRILL];
    render(<ItemScanHost activeSub="item/it-a" onSubChange={vi.fn()} isManager />);
    expect(await screen.findByRole('button', { name: 'Details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print Tag' }));
    expect(await screen.findByRole('dialog', { name: 'Print Tags' })).toBeInTheDocument();
    await waitFor(() => expect(calls.getItemTags).toHaveBeenCalledWith(['it-a']));
  });
});

describe('the scanner and tag events', () => {
  it('openItemScanner() opens the scanner (here: no camera, so Type a Serial)', async () => {
    render(<ItemScanHost activeSub={null} onSubChange={vi.fn()} />);
    act(() => openItemScanner());
    expect(await screen.findByText('Scan an Item')).toBeInTheDocument();
    expect(screen.getByText('This Browser Cannot Scan')).toBeInTheDocument();
  });

  it('printItemTags(items) opens the tag sheet for those items', async () => {
    calls.getItemTags.mockResolvedValue([{ id: 'it-a', name: 'Hammer Drill', serialNumber: 'GG-00042', companyName: 'Alpha Storage' }]);
    render(<ItemScanHost activeSub={null} onSubChange={vi.fn()} />);
    act(() => printItemTags([DRILL]));
    expect(await screen.findByText('Alpha Storage')).toBeInTheDocument();
    expect(calls.getItemTags).toHaveBeenCalledWith(['it-a']);
  });
});
