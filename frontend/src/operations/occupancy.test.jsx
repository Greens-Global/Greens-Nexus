import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { attentionItems, combine, periodRange } from './model';
import { mailboxOccupancy, rentedAll, storageOccupancy, storageRent } from './occupancy';
import { Overview } from './OpsTabs';
import UnitClasses from './UnitClasses';

const saveOpsUnitClasses = vi.fn();
vi.mock('../api', () => ({ api: { saveOpsUnitClasses: (...a) => saveOpsUnitClasses(...a) } }));

// Mailboxes get their own occupancy (Neil, Oct 20 2026 Ops review). The
// fixture is Valley Center's Cubby counts on Oct 20: the screen read 59.9%
// because 236 unrented mailboxes (which Cubby marks unrentable) and 4
// switched-off records sat in the "off market" storage count.

function facility(id, shortName, over = {}) {
  return {
    id, name: `Greens Storage ${shortName}`, shortName, asOf: '2026-10-20',
    units: { total: 568, rented: 465, vacant: 80, unavailable: 23 },
    mailboxes: { total: 279, rented: 43, vacant: 0, unavailable: 236 },
    excludedUnits: 4,
    area: { total: 60000, rented: 50000 },
    rent: { rentRoll: 10580000, mailboxRentRoll: 120000, streetRented: 11000000, vacantPotential: 900000, belowStreetGap: 0, belowStreetCount: 0 },
    autoPay: 323, protected: 0,
    pastDue: { total: 0, tenants: 0, buckets: { d0_30: 0, d30_60: 0, d60_90: 0, d90_120: 0, d120_plus: 0, unknown: 0 }, rows: [] },
    locks: { toPlace: [], toRemove: [], applied: 0 },
    history: [{ month: '2026-10', moveIns: 13, moveOuts: 6, rented: 465 }],
    moves: { insMtd: 13, outsMtd: 6, movingOut: [], movingIn: [], daily: [{ date: '2026-10-02', ins: 13, outs: 6 }] },
    rentChanges: { count: 0, lift: 0 },
    unitTypes: [
      { name: "10' x 10' Storage - Interior, Lower", kind: 'storage', total: 568, rented: 465, vacant: 80, unavailable: 23, street: 15000, rentSum: 10460000, vacantPotential: 900000 },
      { name: "0' x 3' mailbox", kind: 'mailbox', total: 279, rented: 43, vacant: 0, unavailable: 236, street: 2800, rentSum: 120000, vacantPotential: 0 },
    ],
    belowStreet: [], offMarket: [],
    leads: { total: 0, open: 0, reserved: 0, converted: 0, byStatus: {}, rows: [] },
    tasks: { open: 0, overdue: 0, rows: [] },
    payments: { collectedMtd: 0, daily: [], failed: [] },
    ...over,
  };
}

const range = periodRange('this-month', '2026-10-20');

function renderOverview(fs) {
  const data = combine(fs);
  render(<Overview data={data} facilities={fs} scope={fs} many={fs.length > 1} range={range}
    focus={null} go={vi.fn()} onPick={vi.fn()} onJump={vi.fn()} />);
}

const kpi = (label) => screen.getByRole('button', { name: new RegExp(`^${label}, `) });

describe('occupancy rule', () => {
  it('storage reads of rentable units; mailboxes of all mailboxes', () => {
    const f = facility('vc', 'Valley Center');
    expect(storageOccupancy(f.units)).toMatchObject({ rented: 465, rentable: 545, offMarket: 23 });
    expect(storageOccupancy(f.units).share).toBeCloseTo(0.853, 3);
    expect(mailboxOccupancy(f.mailboxes)).toMatchObject({ rented: 43, total: 279 });
    expect(mailboxOccupancy({ total: 0 })).toBeNull();
    expect(mailboxOccupancy(undefined)).toBeNull();                     // a payload from before the split
    expect(rentedAll(f)).toBe(508);
    expect(storageRent(f)).toBe(10460000);
  });

  it('adds mailboxes across facilities, apart from storage', () => {
    const all = combine([facility('vc', 'Valley Center'), facility('es', 'Escondido', {
      units: { total: 802, rented: 773, vacant: 24, unavailable: 5 }, mailboxes: { total: 77, rented: 29, vacant: 0, unavailable: 48 },
    })]);
    expect(all.units).toEqual({ total: 1370, rented: 1238, vacant: 104, unavailable: 28 });
    expect(all.mailboxes).toEqual({ total: 356, rented: 72, vacant: 0, unavailable: 284 });
    expect(all.unitTypes.find((t) => t.kind === 'mailbox').total).toBe(558);
  });

  it('no longer flags Valley Center as mostly off market', () => {
    expect(attentionItems([facility('vc', 'Valley Center')]).some((a) => a.section === 'off-market')).toBe(false);
  });
});

describe('Overview occupancy KPIs', () => {
  it('shows storage occupancy of rentable units and a separate mailbox figure', () => {
    renderOverview([facility('vc', 'Valley Center')]);
    expect(kpi('Storage Occupancy').textContent).toContain('85.3%');
    expect(kpi('Storage Occupancy').textContent).toContain('465 of 545 rentable units - 23 off market not counted');
    expect(kpi('Mailbox Occupancy').textContent).toContain('15.4%');
    expect(kpi('Mailbox Occupancy').textContent).toContain('43 of 279 mailboxes rented');
    // Autopay covers every renter, mailboxes too: 323 of 508.
    expect(kpi('On Autopay').textContent).toContain('323 of 508 rented units');
    expect(screen.getByText(/Mailboxes are counted apart/)).toBeTruthy();
    expect(screen.queryByText('59.9%')).toBeNull();
  });

  it('shows no mailbox figure where there are no mailboxes', () => {
    renderOverview([facility('fa', 'Fairfield', { mailboxes: { total: 0, rented: 0, vacant: 0, unavailable: 0 } })]);
    expect(screen.queryByRole('button', { name: /^Mailbox Occupancy, / })).toBeNull();
    expect(screen.queryByText(/Mailboxes are counted apart/)).toBeNull();
  });
});

describe('the mailbox rule on screen', () => {
  const rules = { mailbox: ['mailbox', 'mail box'], excluded: ['deactivated'] };

  it('names the rule for everyone, without a Change button', () => {
    render(<UnitClasses rules={rules} canEdit={false} />);
    expect(screen.getByText(/contains "mailbox" or "mail box"/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('lets a manager change the words and re-reads the figures', async () => {
    saveOpsUnitClasses.mockReset().mockResolvedValue({});
    const onSaved = vi.fn();
    render(<UnitClasses rules={rules} canEdit onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByLabelText(/Mailbox when/), { target: { value: 'mailbox, PO Box, ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveOpsUnitClasses).toHaveBeenCalledWith({ mailbox: ['mailbox', 'PO Box'], excluded: ['deactivated'] });
  });
});
