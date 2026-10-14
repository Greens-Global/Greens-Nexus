import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Ready To Send (Oct 14): each check shows its fix - the company's HR contact
// set right here, Sign Once for the holder, the variables added to the form.

const updateEntity = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: {
    getPeopleDirectory: () => Promise.resolve([{ email: 'charmi@x.com', name: 'Charmi Shah' }]),
    updateEntity: (...a) => updateEntity(...a),
  },
}));
const { default: PacketReadiness } = await import('./PacketReadiness');
const { readinessSummary } = await import('../lib/packetFlow');

const CHECKS = [
  { key: 'documents', ok: true, severity: 'ok', label: 'Documents Published', detail: '1 document, published' },
  { key: 'role:hr', ok: false, severity: 'block', label: 'GGCon Has HR Contact', detail: 'Nobody holds HR Contact yet.',
    fix: { kind: 'entityField', field: 'hr_contact_email', entityId: 'co', role: 'hr' } },
  { key: 'once:company', ok: false, severity: 'block', label: 'Company Signed Once', detail: 'Charmi signs once.',
    fix: { kind: 'signOnce', step: 'company', email: 'charmi@x.com' } },
  { key: 'payPrints', ok: false, severity: 'warn', label: 'Pay Shows In A Document', detail: 'Not printed anywhere.',
    fix: { kind: 'template', templateId: 't1' } },
  { key: 'variables', ok: false, severity: 'block', label: 'Every Variable Is Filled', detail: 'Nothing fills PAN Number.',
    fix: { kind: 'addToForm', variables: [{ token: 'pan_number', label: 'PAN Number' }], templateId: 't1' } },
];

describe('PacketReadiness', () => {
  it('sums up what is left', () => {
    expect(readinessSummary(CHECKS)).toEqual({ tone: 'red', label: '3 To Fix' });
    expect(readinessSummary([CHECKS[0], CHECKS[3]])).toEqual({ tone: 'orange', label: '1 Warning' });
    expect(readinessSummary([CHECKS[0]])).toEqual({ tone: 'green', label: 'Ready To Send' });
  });

  it('offers each fix in place', async () => {
    const onChanged = vi.fn(); const onSignOnce = vi.fn(); const onAddToForm = vi.fn();
    render(<PacketReadiness checks={CHECKS} meEmails={['charmi@x.com']} onChanged={onChanged}
      onSignOnce={onSignOnce} onAddToForm={onAddToForm} />);
    await waitFor(() => expect(screen.getByText('Charmi Shah')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('HR Contact'), { target: { value: 'charmi@x.com' } });
    fireEvent.click(screen.getByText('Set'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updateEntity).toHaveBeenCalledWith('co', { hr_contact_email: 'charmi@x.com' });
    fireEvent.click(screen.getByText('Sign Once'));
    expect(onSignOnce).toHaveBeenCalledWith('company');
    fireEvent.click(screen.getByText('Add To Details Form'));
    expect(onAddToForm).toHaveBeenCalledWith([{ token: 'pan_number', label: 'PAN Number' }]);
    expect(screen.getAllByText('Open Template').length).toBe(2);
  });

  it('someone else must sign once - it says who', () => {
    render(<PacketReadiness checks={[CHECKS[2]]} meEmails={['me@x.com']} />);
    expect(screen.queryByText('Sign Once')).toBeNull();
    expect(screen.getByText(/Waiting for charmi@x.com/)).toBeTruthy();
  });
});
