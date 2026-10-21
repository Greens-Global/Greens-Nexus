import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RecordModal } from './RecordModal.jsx';

// Validation is inline (the field marked, a count in the footer), never a
// browser alert; Remove asks in the modal, never window.confirm.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));

describe('RecordModal validation', () => {
  afterEach(cleanup);
  it('marks every empty required field and counts them in the footer', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onSave = vi.fn();
    render(<RecordModal coll="warranties" row={null} onSave={onSave} onDelete={vi.fn()} onClose={vi.fn()} active={{ id: 'a1', name: 'A' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    const invalid = document.querySelectorAll('[aria-invalid="true"]');
    expect(invalid.length).toBeGreaterThan(1);
    expect(screen.getByRole('status').textContent).toMatch(/\d+ required fields missing/);
    expect(screen.getAllByRole('alert')[0].textContent).toBe('Required');
    alertSpy.mockRestore();
  });
  it('labels every control', () => {
    render(<RecordModal coll="warranties" row={null} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} active={{ id: 'a1', name: 'A' }} />);
    expect(screen.getByLabelText(/Scope \/ Item Covered/)).toBeTruthy();
    expect(screen.getByLabelText(/Contact Email/)).toBeTruthy();
  });
  it('removes through an in-modal confirmation, not window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    const onDelete = vi.fn();
    render(<RecordModal coll="vendors" row={{ id: 'v1', company: 'Pacific Striping' }} canDelete onSave={vi.fn()} onDelete={onDelete} onClose={vi.fn()} active={{ id: 'a1', name: 'A' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Remove' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
