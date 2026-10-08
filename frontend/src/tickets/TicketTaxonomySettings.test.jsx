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
    // Retired from the five (Oct 1) - not listed at all.
    expect(screen.queryByRole('switch', { name: 'Requires Approval: Service Request' })).toBeNull();
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

const intakeSwitch = (typeLabel) => screen.getByRole('switch', { name: `Offered on Submit a Ticket: ${typeLabel}` });

describe('TicketTaxonomySettings - the five types (Oct 1)', () => {
  it('lists only the five, all on by default', async () => {
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    const listed = screen.getAllByRole('switch', { name: /^Offered on Submit a Ticket: / })
      .map((el) => el.getAttribute('aria-label').replace('Offered on Submit a Ticket: ', ''));
    expect(listed).toEqual(['Incident', 'Bug Report', 'Feature Request', 'Access Request', 'Other']);
    expect(listed.every((l) => intakeSwitch(l).getAttribute('aria-checked') === 'true')).toBe(true);
    for (const gone of ['Service Request', 'Change / Enhancement', 'Task', 'Question', 'Request']) {
      expect(screen.queryByRole('switch', { name: `Offered on Submit a Ticket: ${gone}` })).toBeNull();
    }
  });

  it('turns a type off and on, and saves only the five', async () => {
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    fireEvent.click(intakeSwitch('Feature Request'));
    expect(intakeSwitch('Feature Request')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/TURNED OFF/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalledTimes(1));
    expect(api.updateTicketTaxonomySettings.mock.calls[0][0].typeOrder).toEqual(['incident', 'bug', 'access_request', 'other']);
  });

  it('drops a retired type from an order saved before, and keeps at least one on', async () => {
    api.getTicketTaxonomySettings.mockImplementationOnce(() => Promise.resolve({
      ...JSON.parse(JSON.stringify(CONFIG)), typeOrder: ['incident', 'service_request', 'change_request'] }));
    render(<TicketTaxonomySettings />);
    await screen.findByText('Ticket types & intake questions');
    expect(intakeSwitch('Incident')).toHaveAttribute('aria-checked', 'true');
    expect(intakeSwitch('Bug Report')).toHaveAttribute('aria-checked', 'false');
    // The last one on cannot be switched off.
    fireEvent.click(intakeSwitch('Incident'));
    expect(intakeSwitch('Incident')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(intakeSwitch('Bug Report'));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.updateTicketTaxonomySettings).toHaveBeenCalledTimes(1));
    expect(api.updateTicketTaxonomySettings.mock.calls[0][0].typeOrder).toEqual(['incident', 'bug']);
  });
});
