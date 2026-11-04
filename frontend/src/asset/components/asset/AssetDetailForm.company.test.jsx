import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// The Company field on an asset's Details (Neil, 11/03/2026): read mode names
// the company; edit mode is a picker of the companies this person may assign;
// an asset in a company outside theirs is read-only; the save hands the id.

vi.mock('./PhotoGallery.jsx', () => ({ PhotoGallery: () => null }));
vi.mock('./SiteModelSection.jsx', () => ({ SiteModelSection: () => null }));
vi.mock('./PropertyMapLink.jsx', () => ({ PropertyMapLink: () => null }));

const { AssetDetailForm } = await import('./AssetDetailForm.jsx');
const { editGuard } = await import('../../lib/editGuard.js');

const COMPANIES = [
  { id: 'c1', name: 'Greens Storage', assignable: true },
  { id: 'c2', name: 'Other Co', assignable: false },
  { id: 'c3', name: 'Greens Build', assignable: true },
];
const PROPERTY = { id: 'a1', kind: 'property', name: 'Valley Center', address: '28407 Lizard Rocks Road', city: 'Valley Center', state: 'CA' };

afterEach(cleanup);

const rowOf = (label) => document.querySelector(`[data-fl="${label.toLowerCase()}"]`);

describe('AssetDetailForm - Company', () => {
  it('shows the company by name in read mode', () => {
    render(<AssetDetailForm p={{ ...PROPERTY, companyId: 'c1' }} companies={COMPANIES} />);
    expect(rowOf('Company').textContent).toContain('Greens Storage');
    // A picker, not text: no review flag on it.
    expect(rowOf('Company').querySelector('.gt-flag')).toBeNull();
  });

  it('offers only assignable companies and saves the chosen id', () => {
    const onSaveDetail = vi.fn();
    render(<AssetDetailForm p={PROPERTY} companies={COMPANIES} onSaveDetail={onSaveDetail} onFlag={() => {}} />);
    act(() => { editGuard.startEdit(); });
    const picker = screen.getByRole('combobox', { name: 'Company' });
    const labels = [...picker.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['No Company', 'Greens Storage', 'Greens Build']);
    fireEvent.change(picker, { target: { value: 'c3' } });
    act(() => { editGuard.save(); });
    expect(onSaveDetail).toHaveBeenCalledTimes(1);
    expect(onSaveDetail.mock.calls[0][0].Company).toBe('c3');
  });

  it('is read-only for an asset in a company outside the person\'s, and keeps No Company off once set', () => {
    render(<AssetDetailForm p={{ ...PROPERTY, companyId: 'c2' }} companies={COMPANIES} />);
    act(() => { editGuard.startEdit(); });
    const picker = screen.getByRole('combobox', { name: 'Company' });
    expect(picker.disabled).toBe(true);
    expect(picker.value).toBe('c2');
    expect([...picker.querySelectorAll('option')].map((o) => o.textContent)).not.toContain('No Company');
    act(() => { editGuard.cancel(); });
  });

  it('leads a vehicle\'s first section too', () => {
    const van = { id: 'v1', kind: 'vehicle', assetType: 'Vehicle', name: 'Transit', companyId: 'c3',
      snapshot: [{ group: 'Identity', fields: [{ label: 'Make', value: 'Ford' }] }] };
    render(<AssetDetailForm p={van} companies={COMPANIES} />);
    const first = document.getElementById('gt-sec0');
    expect(first.querySelector('[data-fl]').getAttribute('data-fl')).toBe('company');
    expect(rowOf('Company').textContent).toContain('Greens Build');
  });
});
