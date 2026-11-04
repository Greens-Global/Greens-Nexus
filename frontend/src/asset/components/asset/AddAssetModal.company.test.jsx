import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AddAssetModal } from './AddAssetModal.jsx';

// Add Asset asks the Company as one short field (Neil, 11/03/2026): only the
// companies this person may assign; the only one is preselected.

afterEach(cleanup);

const fill = () => {
  fireEvent.change(document.querySelector('[data-field="name"]'), { target: { value: 'Valley Center' } });
  fireEvent.change(document.querySelector('[data-field="address"]'), { target: { value: '1 Main St, Valley Center, CA 92082' } });
};

describe('AddAssetModal - Company', () => {
  it('offers only assignable companies and saves the one picked', () => {
    const onSave = vi.fn();
    render(<AddAssetModal properties={[]} onSave={onSave} onClose={() => {}}
      companies={[{ id: 'c1', name: 'Greens Storage', assignable: true }, { id: 'c2', name: 'Other Co', assignable: false }, { id: 'c3', name: 'Greens Build', assignable: true }]} />);
    const picker = document.querySelector('[data-field="companyId"]');
    expect([...picker.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Select…', 'Greens Storage', 'Greens Build']);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create Asset' }));
    expect(onSave).not.toHaveBeenCalled();                 // Company is required when there is one to pick
    fireEvent.change(picker, { target: { value: 'c3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Asset' }));
    expect(onSave.mock.calls[0][0].companyId).toBe('c3');
  });

  it('preselects the only company the person may assign', () => {
    const onSave = vi.fn();
    render(<AddAssetModal properties={[]} onSave={onSave} onClose={() => {}} companies={[{ id: 'c1', name: 'Greens Storage', assignable: true }]} />);
    expect(document.querySelector('[data-field="companyId"]').value).toBe('c1');
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create Asset' }));
    expect(onSave.mock.calls[0][0].companyId).toBe('c1');
  });
});
