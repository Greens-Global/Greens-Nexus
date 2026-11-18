import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Accounting > Entities (Neil, 11/17/2026): the list renders its rows with
// their live figures and opens an entity; Structure draws the chart; the
// entity page shows the legal record (EIN masked, Show for Full only), the
// books with drill-downs, the owners and the look-through, and its chart.

const GRAPH = {
  seesInvestors: true,
  nodes: [
    { id: 'e:15001', kind: 'entity', code: '15001', label: 'Greens Global Inv 1, LLC', shape: 'partnership', status: 'active' },
    { id: 'e:67000', kind: 'entity', code: '67000', label: 'Greens Austin, LLC', shape: 'partnership', status: 'active', deal: { id: 'f1', name: 'Austin' } },
    { id: 'p:neil', kind: 'person', label: 'Neil Kadakia', shape: 'individual' },
    { id: 'inv:j', kind: 'investor', label: 'Jitendra Jain', shape: 'individual', outside: true },
  ],
  edges: [
    { from: 'p:neil', to: 'e:15001', kind: 'owns', pct: 100, source: 'entity' },
    { from: 'e:15001', to: 'e:67000', kind: 'owns', pct: 40, source: 'ir' },
    { from: 'inv:j', to: 'e:67000', kind: 'owns', pct: 60, source: 'ir' },
  ],
};
const ROWS = [
  { code: '15001', kind: 'entity', name: 'Greens Global Inv 1, LLC', typeLine: 'Multi-Member LLC, taxed as a partnership', formedState: 'DE', formedOn: '2016-02-01', status: 'active', ownedBy: 'Neil Kadakia', recorded: true },
  { code: '15001-1', kind: 'location', name: 'Inv 1 Ops', parentCode: '15001', status: 'active' },
  { code: '67000', kind: 'entity', name: 'Greens Austin, LLC', typeLine: '', formedState: 'TX', status: 'active', ownedBy: '2 members', deal: { id: 'f1', name: 'Austin' }, recorded: false },
];
const ENTITY = {
  code: '67000', kind: 'entity', recorded: true, rev: 2, name: 'Greens Austin, LLC', booksName: 'Greens Austin, LLC', legalName: 'Greens Austin, LLC',
  entityType: 'llc_multi', taxClass: 'partnership', taxClassTyped: '', typeLine: 'Multi-Member LLC, taxed as a partnership', shape: 'partnership',
  formedState: 'TX', formedOn: '2019-03-14', status: 'active', hasEin: true, einMasked: 'XX-XXX4821', einLast4: '4821',
  signers: [{ name: 'Neil Kadakia', title: 'Manager' }], foreignStates: [], holds: [], locations: [], managedBy: [], manages: [],
  deal: { id: 'f1', name: 'Austin' }, ownersHome: 'ir', ownersTotal: 100,
  owners: [{ id: 'e:15001', kind: 'entity', code: '15001', label: 'Greens Global Inv 1, LLC', pct: 40, source: 'ir' }, { id: 'inv:j', kind: 'investor', label: 'Jitendra Jain', pct: 60, source: 'ir' }],
  owned: [], ownerHistory: [],
  lookThrough: [{ id: 'p:neil', label: 'Neil Kadakia', pct: 40, via: ['Greens Global Inv 1, LLC'] }, { id: 'inv:j', label: 'Jitendra Jain', pct: 60, via: [] }],
  canEdit: true, canFull: true, seesInvestors: true,
};

vi.mock('../../../api', () => ({
  api: {
    getLegalEntities: vi.fn(async () => ({ entities: ROWS, canEdit: true, canFull: true, limited: false })),
    getLegalEntityFigures: vi.fn(async (codes) => ({ figures: Object.fromEntries(codes.map((c) => [c, { cash: 1000, assets: 5000, liabilities: 2000, bookEquity: 3000 }])) })),
    getLegalEntityStructure: vi.fn(async () => GRAPH),
    getLegalEntity: vi.fn(async () => ENTITY),
    getLegalEntityBooks: vi.fn(async () => ({ asOf: '2026-11-17', yearFrom: '2026-01-01', t12From: '2025-11-18', cash: 412380, cashAccounts: ['11101'], assets: 9840200, liabilities: 6118700, bookEquity: 3721500, revenueYtd: 1214900, netIncomeYtd: 386400, revenueT12: 1300000, netIncomeT12: 402000, partnerCapital: 3410000 })),
    getLoansByEntity: vi.fn(async () => ({ loans: [{ id: 'l1', lender: 'Chase', balance: 5900000, ratePct: 5.4, maturity: '2029-06-01', dscr: 1.38, covenantMin: 1.25, belowCovenant: false }] })),
    revealLegalEntityEin: vi.fn(async () => ({ ein: '12-3454821' })),
    getLegalEntityAgreements: vi.fn(async () => ({ fees: [], leases: [], recurring: [], jobs: [] })),
    getEntities: vi.fn(async () => []),
    getPeopleDirectory: vi.fn(async () => []),
    getTicketProperties: vi.fn(async () => ({ properties: [] })),
    searchAccountingLedger: vi.fn(async () => ({ rows: [], total: 0 })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async (p) => ({ prefs: p })),
  },
}));

import EntitiesTab from './EntitiesTab';
import EntityPage from './EntityPage';
import { api } from '../../../api';

beforeEach(() => { vi.clearAllMocks(); });

describe('Entities list', () => {
  it('lists legal entities with live figures, folds locations, searches and opens one', async () => {
    const onOpen = vi.fn();
    render(<EntitiesTab onOpen={onOpen} />);
    expect(await screen.findByText('Greens Austin, LLC')).toBeTruthy();
    expect(screen.queryByText(/Location of 15001/)).toBeNull();
    expect(screen.getByText(/2 legal entities with 1 location under them/)).toBeTruthy();
    await waitFor(() => expect(api.getLegalEntityFigures).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Show Locations'));
    expect(screen.getByText(/Location of 15001/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search entities'), { target: { value: 'austin' } });
    expect(screen.queryByText('Greens Global Inv 1, LLC')).toBeNull();
    fireEvent.click(screen.getByLabelText('Open Greens Austin, LLC'));
    expect(onOpen).toHaveBeenCalledWith('67000');
  });

  it('draws the structure chart with the legend', async () => {
    render(<EntitiesTab onOpen={() => {}} />);
    await screen.findByText('Greens Austin, LLC');
    fireEvent.click(screen.getByRole('button', { name: 'Structure' }));
    expect(await screen.findByRole('img', { name: 'Structure of every entity' })).toBeTruthy();
    expect(screen.getByLabelText('What the shapes mean').textContent).toContain('Partnership');
  });
});

describe('One entity', () => {
  it('shows the legal record, the books, the look-through and the chart', async () => {
    render(<EntityPage code="67000" onSubChange={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Greens Austin, LLC' })).toBeTruthy();
    expect(screen.getByText(/XX-XXX4821/)).toBeTruthy();
    expect(screen.getByText(/through Greens Global Inv 1, LLC/)).toBeTruthy();
    expect(await screen.findByText('$412,380')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Structure of Greens Austin, LLC' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText(/12-3454821/)).toBeTruthy();
    expect(api.revealLegalEntityEin).toHaveBeenCalledWith('67000');
  });

  it('keeps the deal\'s members in Investor Relations on the Structure tab', async () => {
    render(<EntityPage code="67000" onSubChange={() => {}} />);
    await screen.findByRole('heading', { name: 'Greens Austin, LLC' });
    fireEvent.click(screen.getByRole('tab', { name: 'Structure' }));
    expect(screen.getByText(/kept on the deal in Investor Relations/)).toBeTruthy();
  });
});
