import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Settings > Hiring & Onboarding > Federal Forms (Neil, 11/02/2026): read-only
// rows - the edition built into Nexus, when it lapses, Current / Expiring /
// Expired as a soft label, and where the form came from.
const federalFormsStatus = vi.fn();
vi.mock('../../api', () => ({ api: { federalFormsStatus: (...a) => federalFormsStatus(...a) } }));

const { default: FederalFormsStatus } = await import('./FederalFormsStatus');

const FORMS = [
  { kind: 'w4', title: 'Form W-4', editionLabel: '2026', expires: '01/31/2027', state: 'ok', message: 'Form W-4 (2026) is current through 01/31/2027.', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw4.pdf' },
  { kind: 'i9', title: 'Form I-9', editionLabel: '01/20/25', expires: '05/31/2027', state: 'expiring', message: 'The Form I-9 edition in Nexus (01/20/25) expires on 05/31/2027.', sourceUrl: 'https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf' },
  { kind: 'x', title: 'Form X', editionLabel: 'v2', expires: '06/30/2027', state: 'ok', message: 'Form X (v2) is current.', sourceUrl: 'nexus:federal_forms/make_x.py' },
  { kind: 'direct_deposit', title: 'Direct Deposit Authorization', editionLabel: 'v1', expires: '', state: 'expired', message: 'The Direct Deposit Authorization edition in Nexus (v1) expired on 01/01/2026. Ask an administrator to update it before sending.', sourceUrl: 'nexus:federal_forms/make_direct_deposit.py' },
];

beforeEach(() => { federalFormsStatus.mockReset().mockResolvedValue({ forms: FORMS }); });

describe('FederalFormsStatus', () => {
  it('shows a row per form with its edition, expiry, state label and source', async () => {
    render(<FederalFormsStatus />);
    expect(await screen.findByText('Form W-4')).toBeTruthy();
    expect(screen.getByText('Form I-9')).toBeTruthy();
    expect(screen.getByText('Direct Deposit Authorization')).toBeTruthy();
    expect(screen.getAllByText('Current')).toHaveLength(2);
    expect(screen.getByText('Expiring')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    // The message carries the edition and the date: neither ever reads twice.
    expect(screen.getByText(/^The Form I-9 edition in Nexus \(01\/20\/25\) expires on 05\/31\/2027\./)).toBeTruthy();
    expect(screen.getByText(/^Form W-4 \(2026\) is current through 01\/31\/2027\./)).toBeTruthy();
    expect(screen.queryByText(/Edition 01\/20\/25\./)).toBeNull();
    expect(screen.queryByText(/Expires 05\/31\/2027/)).toBeNull();
    // A message with no date gets "Expires <date>." after it.
    expect(screen.getByText(/^Form X \(v2\) is current\. Expires 06\/30\/2027\./)).toBeTruthy();
    // No developer paths in an admin's copy.
    expect(screen.queryByText(/docs\/Federal-Forms\.md/)).toBeNull();
    expect(screen.getByText(/A new edition needs a Nexus update - ask your Nexus administrator\./)).toBeTruthy();
    // Government forms link to their source; our own form says so.
    const links = screen.getAllByRole('link', { name: /Source/ });
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://www.irs.gov/pub/irs-pdf/fw4.pdf', 'https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf']);
    expect(screen.getAllByText(/Built in Nexus/)).toHaveLength(2);
    // Soft labels: the StatusLabel, never a solid fill.
    expect(screen.getByText('Expired').closest('.nx-label')).toBeTruthy();
  });
  it('shows an error with Retry when the status cannot load', async () => {
    federalFormsStatus.mockRejectedValue(new Error('boom'));
    render(<FederalFormsStatus />);
    expect(await screen.findByText(/could not be loaded right now/)).toBeTruthy();
  });
});
