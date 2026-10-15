import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Make An Offer in three steps (Oct 15): HR says employee or contractor
// (never guessed) and Nexus shows the ONE offer letter for that hire and the
// packet that follows; the offer asks only what the documents print; the
// documents' own HR questions come last; problems show only on Continue.

const letter = { id: 's-offer', name: 'US Employee Offer', documents: ['Offer Of Employment'], problems: [],
  prints: ['work_location'], printsPay: true,
  hrQuestions: [{ token: 'probation_period', label: 'Probation Period', type: 'text', required: true, pay: false, options: [] },
                { token: 'joining_bonus', label: 'Joining Bonus', type: 'text', required: false, pay: true, options: [] }] };
const packet = { id: 's-hire', name: 'Analyst Hiring', documents: ['NDA'], problems: [], prints: [], hrQuestions: [], personQuestions: ['PAN Number'] };
const offerOptions = vi.fn((cid, p) => Promise.resolve({
  country: 'US', companyCountry: 'US', choices: [{ id: 's-offer', name: 'US Employee Offer', workerType: 'employee', country: 'US' }],
  offerLetter: p.worker_type === 'employee' ? letter : null,
  hiringPacket: p.worker_type === 'employee' ? packet : null,
  missing: p.worker_type === 'contractor' ? 'No offer letter is set up for a Contractor in US at Greens yet.' : '',
}));
const startOffer = vi.fn(() => Promise.resolve({ id: 'ev-offer', candidateId: 'c1', kind: 'offer', status: 'review' }));
vi.mock('../api', () => ({ api: {
  offerOptions: (...a) => offerOptions(...a),
  startOffer: (...a) => startOffer(...a),
  hiringOptions: () => Promise.resolve({ roles: [{ id: 'jr-an', name: 'Analyst', department: 'Accounting', defaultManagerEmail: '' }], departments: ['Accounting'] }),
  getDocTemplates: () => Promise.resolve([]),
} }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }) }));
const { default: OfferModal } = await import('./OfferModal');

const cand = { id: 'c1', firstName: 'Jane', lastName: 'Doe', email: 'jane@gmail.com', company: 'co', roleId: 'jr-an', expectedStart: '2030-11-02' };
const next = () => fireEvent.click(screen.getByText('Continue'));

describe('OfferModal', () => {
  it('asks employee or contractor first, then only what the chosen letter needs, step by step', async () => {
    const onStarted = vi.fn();
    render(<OfferModal candidate={cand} canSeePay onClose={() => {}} onStarted={onStarted} toastErr={() => {}} />);
    await waitFor(() => expect(offerOptions).toHaveBeenCalled());
    expect(screen.queryByText(/Offer letter:/)).toBeNull();          // nothing guessed
    expect(screen.queryByText('Choose Employee or Contractor.')).toBeNull();   // nothing nags before you choose
    await waitFor(() => expect(screen.getByText('Continue').closest('button')).not.toBeDisabled());
    next();
    expect(screen.getByText('Choose Employee or Contractor.')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Contractor' }));
    await waitFor(() => expect(screen.getByText(/No offer letter is set up for a Contractor/)).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'Employee' }));
    await waitFor(() => expect(screen.getByText('US Employee Offer')).toBeTruthy());
    expect(screen.getByText(/Analyst Hiring/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Continue').closest('button')).not.toBeDisabled());
    next();
    expect(screen.getByText('The offer')).toBeTruthy();
    expect(screen.getByLabelText('Primary Work Location')).toBeTruthy();   // the letter prints it
    fireEvent.change(screen.getByLabelText('Primary Work Location'), { target: { value: 'Irvine, CA' } });
    fireEvent.change(screen.getByLabelText('Pay'), { target: { value: '85000' } });
    next();
    expect(screen.getByLabelText('Probation Period *')).toBeTruthy();       // the letter asks HR
    fireEvent.click(screen.getByText('Create Offer Letter'));
    expect(screen.getByText('Answer Probation Period.')).toBeTruthy();       // required, said at the field's step
    fireEvent.change(screen.getByLabelText('Probation Period *'), { target: { value: '90 days' } });
    fireEvent.change(screen.getByLabelText('Joining Bonus'), { target: { value: '$2,000' } });
    fireEvent.click(screen.getByText('Create Offer Letter'));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-offer' })));
    const [cid, body] = startOffer.mock.calls[0];
    expect(cid).toBe('c1');
    expect(body.inputs).toMatchObject({ worker_type: 'employee', employment_type: 'full_time', country: 'US', role_id: 'jr-an',
      work_location: 'Irvine, CA', merge: { probation_period: '90 days' } });
    expect(body.pay_values).toEqual({ joining_bonus: '$2,000' });            // pay never goes in merge
    expect(body.pay).toMatchObject({ base: 85000, payBasis: 'salary' });
  });

  it('hides pay from someone without Pay & Benefits', async () => {
    render(<OfferModal candidate={cand} canSeePay={false} onClose={() => {}} onStarted={() => {}} toastErr={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Employee' }));
    await waitFor(() => expect(screen.getByText('US Employee Offer')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Continue').closest('button')).not.toBeDisabled());
    next();
    expect(screen.queryByLabelText('Pay')).toBeNull();
    next();
    expect(screen.getByLabelText('Joining Bonus').disabled).toBe(true);
  });
});
