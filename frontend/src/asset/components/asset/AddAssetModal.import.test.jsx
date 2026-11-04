import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AddAssetModal } from './AddAssetModal.jsx';

// Import From a Spreadsheet (Neil, 11/03/2026): a Company column, matched by
// name or id, a preview that names each row's problem, and only clean rows
// created - each through onSave (the per-row save), blank = no company.

afterEach(cleanup);

const COMPANIES = [
  { id: 'c1', name: 'Greens Storage', assignable: true },
  { id: 'c2', name: 'Other Co', assignable: false },
];

const pick = (text) => {
  const input = screen.getByTestId('asset-import-file');
  fireEvent.change(input, { target: { files: [new File([text], 'assets.csv', { type: 'text/csv' })] } });
};

describe('AddAssetModal - import Company column', () => {
  it('previews every row, then creates only the ready ones with their company', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<AddAssetModal mode="import" properties={[]} onSave={onSave} onClose={onClose} companies={COMPANIES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vehicle' }));
    pick('Asset Name / Unit #,Make,Company\nTruck 1,Ford, greens  STORAGE \nTruck 2,Ram,\nTruck 3,GMC,Acme\nTruck 4,Kia,Other Co\n');

    const table = await screen.findByTestId('asset-import-preview');
    expect(onSave).not.toHaveBeenCalled();                       // nothing is saved from the preview
    const status = (line) => table.querySelector(`tr[data-line="${line}"]`).textContent;
    expect(status(2)).toMatch(/Greens Storage.*Ready/);
    expect(status(3)).toMatch(/No Company.*Ready/);
    expect(status(4)).toMatch(/Unknown Company/);
    expect(status(5)).toMatch(/Not One of Your Companies/);

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 Assets' }));
    expect(onSave).toHaveBeenCalledTimes(2);
    const [first, second] = onSave.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ name: 'Truck 1', make: 'Ford', kind: 'vehicle', assetType: 'Vehicle', companyId: 'c1' });
    expect(second.name).toBe('Truck 2');
    expect('companyId' in second).toBe(false);                   // blank never sent as a clear
    expect(onClose).toHaveBeenCalled();
  });

  it('nothing ready leaves Import off; Choose Another File goes back', async () => {
    render(<AddAssetModal mode="import" properties={[]} onSave={() => {}} onClose={() => {}} companies={COMPANIES} />);
    pick('Property / Parcel Name,Company\nLot A,Nobody\n');
    await screen.findByTestId('asset-import-preview');
    expect(screen.getByRole('button', { name: 'Import 0 Assets' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Another File' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download CSV Template' })).toBeTruthy());
  });

  it('a company list that loads after the file was picked still matches the rows', async () => {
    const props = { mode: 'import', properties: [], onSave: () => {}, onClose: () => {} };
    const { rerender } = render(<AddAssetModal {...props} companies={[]} />);
    pick('Property / Parcel Name,Company\nLot A,Greens Storage\n');
    const table = await screen.findByTestId('asset-import-preview');
    expect(table.textContent).toMatch(/Unknown Company/);
    rerender(<AddAssetModal {...props} companies={COMPANIES} />);
    expect(screen.getByTestId('asset-import-preview').textContent).toMatch(/Greens Storage.*Ready/);
    expect(screen.getByRole('button', { name: 'Import 1 Asset' }).disabled).toBe(false);
  });
});
