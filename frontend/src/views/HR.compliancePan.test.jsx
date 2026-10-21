import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// PAN (India) on the Compliance section (Pranshu, 10/21): it prints on a
// contractor's invoices, so it is typed uppercased, must be 5 letters, 4
// digits and a letter, and Save stays off until it is.

const LEO = { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', status: 'active',
  employmentType: 'contractor', compliance: { workAuth: 'citizen' }, contractor: {}, personal: {} };

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const updateEmployee = vi.fn((id, body) => Promise.resolve({ ...LEO, ...body }));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (key === 'updateEmployee' ? updateEmployee : () => Promise.resolve([])),
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); updateEmployee.mockClear(); });

async function open() {
  const { ComplianceModal } = await import('./HR');
  const onSaved = vi.fn();
  render(<ComplianceModal employee={LEO} onClose={() => {}} onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
  return { input: screen.getByLabelText('PAN (INDIA)'), save: screen.getByRole('button', { name: /Save/ }), onSaved };
}

describe('Compliance - PAN (India)', () => {
  it('blocks Save on a PAN that is not in its printed form', async () => {
    const { input, save } = await open();
    fireEvent.change(input, { target: { value: 'abc12' } });
    expect(input.value).toBe('ABC12');
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/PAN is 5 letters, 4 digits and a letter/)).toBeTruthy();
    fireEvent.click(save);
    expect(updateEmployee).not.toHaveBeenCalled();
  }, 20000);

  it('saves a valid PAN uppercased with the rest of the record', async () => {
    const { input, save, onSaved } = await open();
    fireEvent.change(input, { target: { value: 'abcde 1234f' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = updateEmployee.mock.calls[0][1];
    expect(body.compliance.pan).toBe('ABCDE1234F');
    expect(body.compliance.workAuth).toBe('citizen');
  }, 20000);
});
