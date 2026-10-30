import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Delete Company (Hold to confirm, Neil, Oct 30 2026): a company reaches every
// worker linked to it, so its Delete opens a dialog that says what goes, and
// the dialog's button is a 1.8 s hold that waits for the server - a refusal
// keeps the dialog open with the reason.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, hrScope: null, can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com',
    myRole: 'administrator', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
const deleteEntity = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, key) => (key === 'deleteEntity' ? deleteEntity : () => Promise.resolve([])) });
  return { api, default: api };
});

const { CompanySetupPage } = await import('./HR');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_MAJOR_MS } = await import('../ui/HoldButton');

const entities = [{ id: 'co1', name: 'Greens Co' }, { id: 'co2', name: 'MCD' }];

afterEach(() => { cleanup(); deleteEntity.mockClear(); vi.useRealTimers(); });

function setup() {
  const onChangedEntities = vi.fn(() => Promise.resolve());
  const toastOk = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DialogHost />
      <CompanySetupPage entities={entities} onChangedEntities={onChangedEntities} onChangedSites={() => {}} toastOk={toastOk} toastErr={() => {}} />
    </QueryClientProvider>,
  );
  return { onChangedEntities, toastOk };
}

describe('Delete Company', () => {
  it('opens a dialog that says what goes; the delete runs only on a full hold', async () => {
    const { onChangedEntities, toastOk } = setup();
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    expect(await screen.findByText('Delete "Greens Co"? Workers keep their record but lose this company link.')).toBeTruthy();
    const hold = screen.getByRole('button', { name: 'Delete Company, press and hold' });
    vi.useFakeTimers();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(HOLD_MAJOR_MS - 400); });
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(deleteEntity).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(deleteEntity).toHaveBeenCalledTimes(1);
    expect(deleteEntity).toHaveBeenCalledWith('co1');
    expect(onChangedEntities).toHaveBeenCalled();
    expect(toastOk).toHaveBeenCalledWith('Company deleted.');
  });

  it('a refusal keeps the dialog open with the reason', async () => {
    deleteEntity.mockImplementationOnce(() => Promise.reject(new Error('Workers are still linked to this company.')));
    const { toastOk } = setup();
    fireEvent.click(screen.getAllByTitle('Delete')[1]);
    const hold = await screen.findByRole('button', { name: 'Delete Company, press and hold' });
    vi.useFakeTimers();
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(screen.getByRole('alert').textContent).toBe('Workers are still linked to this company.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(toastOk).not.toHaveBeenCalled();
  });
});
