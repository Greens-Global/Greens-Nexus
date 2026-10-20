// The ticket drawer's property block names the tenant renting the ticket's unit
// at a Cubby store - for staff with Operations read only (Oct 20 2026).
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const role = { ops: true };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ canAccessModule: () => role.ops }) }));
vi.mock('./ticketPropertyLink', async () => ({
  ...(await vi.importActual('./ticketPropertyLink')),
  usePropertyUnits: () => ({ units: [], strict: false, loading: false, required: false }),
}));
vi.mock('../api', () => ({ api: { getOpsTicketTenant: vi.fn(async () => ({ tenant: 'Pat Example' })) } }));

import { api } from '../api';
import { TicketPropertyDetail } from './TicketPropertyFields';

const ticket = { id: 't1', status: 'open', propertyAssetId: 'esc', propertyName: 'Greens Storage Escondido', propertyUnit: 'E347' };

beforeEach(() => { api.getOpsTicketTenant.mockClear(); role.ops = true; });

describe('TicketPropertyDetail tenant', () => {
  it('shows the tenant for Operations staff', async () => {
    render(<TicketPropertyDetail v={ticket} />);
    expect(await screen.findByText('Pat Example')).toBeTruthy();
    expect(api.getOpsTicketTenant).toHaveBeenCalledWith('esc', 'E347');
  });
  it('never asks for anyone without Operations read, nor for Common Area', async () => {
    role.ops = false;
    const { unmount } = render(<TicketPropertyDetail v={ticket} />);
    unmount();
    role.ops = true;
    render(<TicketPropertyDetail v={{ ...ticket, propertyUnit: 'Common Area' }} />);
    await waitFor(() => expect(screen.getByText(/View Property/)).toBeTruthy());
    expect(api.getOpsTicketTenant).not.toHaveBeenCalled();
    expect(screen.queryByText(/Tenant:/)).toBeNull();
  });
});
