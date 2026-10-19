import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Operations: stores another operator runs (CubeSmart, Oct 20 2026). The
// upload preview (nothing saved until Save) and the facility picker's
// "CubeSmart Managed" label with its "Data as of" line.

const uploadThirdPartyReport = vi.fn();
const getFacilityOps = vi.fn();
const getThirdPartyFacilities = vi.fn();
vi.mock('../api', () => ({ api: {
  uploadThirdPartyReport: (...a) => uploadThirdPartyReport(...a),
  getFacilityOps: (...a) => getFacilityOps(...a),
  getThirdPartyFacilities: (...a) => getThirdPartyFacilities(...a),
  getCubbySync: vi.fn(), startCubbySync: vi.fn(), facilityOpsLookup: vi.fn(),
} }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, active, onChange }) => (
    <div role="tablist">{tabs.map((t) => <button key={t.key} role="tab" aria-selected={t.key === active} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>
  ),
}));

const ThirdPartyUpload = (await import('./ThirdPartyUpload')).default;
const FacilityOperations = (await import('../views/FacilityOperations')).default;

const PREVIEW = {
  kind: 'sre', fileName: 'sre.xlsx', saved: false, errors: [], unknownLabels: ['% ANNEX'],
  warnings: ['Austin 09/2026: Net Rentals (-15) is not Rented minus Vacated (-14).'],
  properties: [{ id: 'cubesmart-6992', shortName: 'Austin', managedLabel: 'CubeSmart Managed' }],
  rows: [
    { propertyId: 'cubesmart-6992', property: 'Austin', period: '2026-10', replaces: false,
      values: { total_cubes_avail: 2926, rented_during_month: 42, vacated_during_month: 58, net_rentals: -16, cubes_occ_eom: 2491, pct_rented_cube: 85.1, rental_revenue: 173504 } },
    { propertyId: 'cubesmart-6992', property: 'Austin', period: '2026-09', replaces: true, values: { total_cubes_avail: 2926 } },
  ],
};

const PROPS = [{ id: 'cubesmart-6992', shortName: 'Austin', managedLabel: 'CubeSmart Managed' }];
const file = () => new File(['x'], 'sre.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

beforeEach(() => {
  uploadThirdPartyReport.mockReset();
  getFacilityOps.mockReset();
  getThirdPartyFacilities.mockReset();
});

describe('ThirdPartyUpload', () => {
  it('previews the file without saving, then saves it with commit', async () => {
    uploadThirdPartyReport.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce({ ...PREVIEW, saved: true, savedRows: 2 });
    const onSaved = vi.fn();
    render(<ThirdPartyUpload properties={PROPS} defaultPropertyId="cubesmart-6992" onClose={() => {}} onSaved={onSaved} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Report File'), { target: { files: [file()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = await screen.findByTestId('tp-preview');
    expect(uploadThirdPartyReport).toHaveBeenCalledWith(expect.any(File), { kind: 'auto', propertyId: 'cubesmart-6992', asOf: '', commit: false });
    expect(within(preview).getByText('SRE Summary (Monthly) - Austin')).toBeInTheDocument();
    expect(within(preview).getByText(/2 rows found - 1 will replace/)).toBeInTheDocument();
    expect(within(preview).getByText('Oct 2026')).toBeInTheDocument();
    expect(within(preview).getAllByText('2,926').length).toBe(2);
    expect(within(preview).getByText('$173,504')).toBeInTheDocument();
    expect(within(preview).getByText('85.1%')).toBeInTheDocument();
    expect(within(preview).getByText(/Net Rentals \(-15\)/)).toBeInTheDocument();
    expect(within(preview).getByText('Replaces')).toBeInTheDocument();
    expect(within(preview).getByText(/% ANNEX/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(save);
    await screen.findByText('Saved 2 rows from sre.xlsx.');
    expect(uploadThirdPartyReport).toHaveBeenLastCalledWith(expect.any(File), { kind: 'auto', propertyId: 'cubesmart-6992', asOf: '', commit: true });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps Save off when the preview has an error', async () => {
    uploadThirdPartyReport.mockResolvedValueOnce({ ...PREVIEW, rows: [], errors: ['The file is for store 6992 (Austin), not Sachse.'] });
    render(<ThirdPartyUpload properties={PROPS} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Report File'), { target: { files: [file()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/not Sachse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a file the server could not read', async () => {
    uploadThirdPartyReport.mockRejectedValueOnce(new Error('Could not open that workbook. Export it again as .xlsx or .csv.'));
    render(<ThirdPartyUpload properties={PROPS} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Report File'), { target: { files: [file()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open that workbook');
  });
});

function cubesmartFacility(over = {}) {
  return {
    id: 'tp:cubesmart-6992', name: 'Greens Storage Austin', shortName: 'Austin', asOf: '2026-10-19', lat: null, lng: null,
    units: { total: 2926, rented: 2491, vacant: 414, unavailable: 21 }, area: { total: 316874, rented: 290558 },
    rent: { rentRoll: 18722000, streetRented: 0, vacantPotential: 0, belowStreetGap: 0, belowStreetCount: 0 },
    autoPay: 0, protected: 0,
    pastDue: { total: 964000, tenants: 0, buckets: { d0_30: 621000, d30_60: 214000, d60_90: 88000, d90_120: 41000, d120_plus: 0, unknown: 0 }, rows: [] },
    locks: { toPlace: [], toRemove: [], applied: 0 },
    history: [{ month: '2026-09', moveIns: 105, moveOuts: 120, rented: 2507 }, { month: '2026-10', moveIns: 42, moveOuts: 58, rented: 2491 }],
    moves: { insMtd: 42, outsMtd: 58, movingOut: [], movingIn: [], daily: [{ date: '2026-10-19', ins: 42, outs: 58 }] },
    rentChanges: { count: 0, lift: 0 }, unitTypes: [], belowStreet: [], offMarket: [],
    leads: { total: 0, open: 0, reserved: 0, converted: 0, byStatus: {}, rows: [] },
    tasks: { open: 0, overdue: 0, rows: [] },
    payments: { collectedMtd: 0, daily: [], failed: [] },
    managedBy: 'cubesmart', managedLabel: 'CubeSmart Managed',
    thirdParty: {
      propertyId: 'cubesmart-6992', source: 'cubesmart', sourceLabel: 'CubeSmart', label: 'CubeSmart Managed', storeNumber: '6992',
      dataAsOf: '2026-10-19', dataAsOfText: '10/19/2026', stale: false, flashAsOf: '2026-10-19', sreThrough: '2026-10',
      flash: {
        day: '2026-10-19',
        revenue: [{ key: 'accrued_rent', label: 'Accrued Rent', mtd: 17350400, budget: 17384100, py: 16695700 }],
        occupancy: [{ key: 'occupied', label: 'Occupied', cubes: 2491, sqft: 290558 }],
        moves: { move_ins_day: 3, move_ins_mtd: 42, move_ins_mtd_budget: 60, move_ins_mtd_py: 59, move_outs_day: 1, move_outs_mtd: 58, move_outs_mtd_budget: 61, move_outs_mtd_py: 64 },
      },
      sre: [{ month: '2026-10', totalCubesAvail: 2926, rented: 42, vacated: 58, netRentals: -16, occupiedEom: 2491, pctRentedCube: 85.1, pctRentedSqft: 91.7, rentalRevenue: 17350400, promoDiscounts: -313300, promoMoveIns: 31, arTotal: 964000 }],
    },
    ...over,
  };
}

describe('Operations facility picker', () => {
  it('labels a CubeSmart store "CubeSmart Managed" and shows how old its data is', async () => {
    getFacilityOps.mockResolvedValue({ organization: 'Greens Storage', facilities: [], trend: [], syncedAt: new Date().toISOString(), syncStatus: 'ok', cubbyConfigured: true });
    getThirdPartyFacilities.mockResolvedValue({ facilities: [cubesmartFacility()] });
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    const pill = await screen.findByRole('button', { name: /Austin\s*CubeSmart Managed/ });
    expect(pill).toHaveAttribute('title', 'CubeSmart Managed - Data as of 10/19/2026');
    fireEvent.click(pill);
    const panel = await screen.findByTestId('tp-panel');
    expect(within(panel).getByText('Austin - CubeSmart Managed')).toBeInTheDocument();
    expect(within(panel).getByText('Data as of 10/19/2026')).toBeInTheDocument();
    expect(within(panel).queryByText('Stale')).toBeNull();
    expect(within(panel).getByText('Accrued Rent')).toBeInTheDocument();
    // the Overview KPIs come from the store's reports
    // storage occupancy is rented of rentable (rented + vacant) since the mailbox split: 2491 / 2905
    expect(screen.getByRole('button', { name: /^Storage Occupancy, 85\.7%/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Monthly Rent Roll, \$187(\.2)?K/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload Report/ })).toBeInTheDocument();
  });

  it('flags a stale store and still shows Cubby facilities when the operator read fails', async () => {
    getFacilityOps.mockResolvedValue({ organization: 'Greens Storage', facilities: [], trend: [], syncedAt: new Date().toISOString(), syncStatus: 'ok', cubbyConfigured: true });
    getThirdPartyFacilities.mockResolvedValue({ facilities: [cubesmartFacility({ thirdParty: { ...cubesmartFacility().thirdParty, stale: true, dataAsOf: '2026-10-01' } })] });
    render(<FacilityOperations activeSub="overview" onSubChange={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Austin\s*CubeSmart Managed/ }));
    const panel = await screen.findByTestId('tp-panel');
    expect(within(panel).getByText('Data as of 10/01/2026')).toBeInTheDocument();
    expect(within(panel).getByText('Stale')).toBeInTheDocument();
    await waitFor(() => expect(getThirdPartyFacilities).toHaveBeenCalled());
  });
});
