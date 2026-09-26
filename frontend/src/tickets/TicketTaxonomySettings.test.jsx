import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// SLA & Ticket Types: each ticket type row carries a "Requires Approval"
// switch (Sep 2026). The server fills the flag in for the default-gated
// types; everything else reads as off, and Save sends the flag per type.

const CONFIG = {
  slaTargetHours: { urgent: 24, high: 48, medium: 72, low: 168 },
  types: {
    service_request: { requiresApproval: true },
    change_request: { requiresApproval: true },
    access_request: { requiresApproval: true },
  },
  typeOrder: null,
  companyField: { enabled: false, companyIds: [] },
};

vi.mock('../api', () => ({
  api: {
    getTicketTaxonomySettings: vi.fn(() => Promise.resolve(JSON.parse(JSON.stringify(CONFIG)))),
    getTicketCompanies: vi.fn(() => Promise.resolve([])),
    updateTicketTaxonomySettings: vi.fn((b) => Promise.resolve(b)),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myLevel: 4 }) }));

const { api } = await import('../api');
const TicketTaxonomySettings = (await import('./TicketTaxonomySettings')).default;
const { APPROVAL_REQUIRED, typeRequiresApproval } = await import('./ticketConfig');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

const approvalSwitch = (typeLabel) => screen.getByRole('switch', { name: `Requires Approval: ${typeLabel}` });

describe('TicketTaxonomySettings - Requires Approval', () => {
  it('shows each type with its approval switch and the hint', async () => {
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    expect(approvalSwitch('Access Request')).toHaveAttribute('aria-checked', 'true');
    expect(approvalSwitch('Service Request')).toHaveAttribute('aria-checked', 'true');
    expect(approvalSwitch('Bug Report')).toHaveAttribute('aria-checked', 'false');
    expect(approvalSwitch('Incident')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText(/New tickets of this type wait for an approver's sign-off/).length).toBeGreaterThan(0);
  });

  it('flips the switch and saves the flag per type', async () => {
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    fireEvent.click(approvalSwitch('Bug Report'));
    fireEvent.click(approvalSwitch('Access Request'));
    expect(approvalSwitch('Bug Report')).toHaveAttribute('aria-checked', 'true');
    expect(approvalSwitch('Access Request')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalledTimes(1));
    const sent = api.updateTicketTaxonomySettings.mock.calls[0][0];
    expect(sent.types.bug.requiresApproval).toBe(true);
    expect(sent.types.access_request.requiresApproval).toBe(false);
    expect(sent.types.service_request.requiresApproval).toBe(true);   // untouched stays on
  });

  it('feeds the loaded taxonomy into typeRequiresApproval, with no hardcoded list', async () => {
    // Save above triggers refreshTicketConfig(), which re-applies the fetched config.
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(typeRequiresApproval('access_request')).toBe(true));
    expect(typeRequiresApproval('bug')).toBe(false);
    expect(Object.keys(APPROVAL_REQUIRED).sort()).toEqual(['access_request', 'change_request', 'service_request']);
  });
});
