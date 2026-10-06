import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A manager reviewing a report's timesheet from Workday, without the People
// module (Pranshu, 10/06): the card is that one employee and period (no
// picker, no period arrows), no pay anywhere (the server sends none:
// payHidden), no exports or finalize, and the hours can be changed only while
// the timesheet is with this manager (canEdit).

const START = '2026-09-13';
const cardFor = (over = {}) => ({
  payType: 'hourly', email: 'erin@x.com', employeeName: 'Erin Test', periodStart: START, periodEnd: '2026-09-26',
  overtimeRule: 'federal', payHidden: true, canEdit: true, reviewId: 'r1',
  days: [{
    date: START, weekStart: START, workedMin: 420, regMin: 420, otMin: 0, dtMin: 0,
    segments: [{ in: `${START}T09:00:00`, inR: `${START}T09:00:00`, out: `${START}T16:00:00`, outR: `${START}T16:00:00`,
      inId: 'i1', outId: 'o1', workedMin: 420, regMin: 420, flags: [], breaks: [] }],
  }],
  totals: { regMin: 420, otMin: 0, dtMin: 0, workedMin: 420, missingPunches: 0, editedPunches: 0, pendingEdits: 0 },
  review: { id: 'r1', status: 'with_manager', rounds: [], parties: [], canAgree: true, canSendBack: true },
  ...over,
});

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 2, myGrantedModules: new Set(), canAccessModule: () => false, isExternal: false }),
}));
const calls = [];
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push(key); return Promise.resolve(key === 'timesheetReviewTimecard' ? globalThis.__card : []); },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; });

async function renderReview(card) {
  globalThis.__card = card;
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}><PayrollTimecard reviewId="r1" toastOk={() => {}} toastErr={() => {}} /></QueryClientProvider>);
  await screen.findByText('Erin Test');
}

describe('a manager reviewing one timesheet', () => {
  it('shows that employee and period with hours only - no pay, no picker, no exports', async () => {
    await renderReview(cardFor());
    expect(calls).toContain('timesheetReviewTimecard');
    expect(calls).not.toContain('timePayroll');                 // never the People > Time card
    expect(calls).not.toContain('timeTeam');                    // no team list
    expect(screen.queryByText('Pay rate')).toBeNull();
    expect(screen.queryByText('Wage')).toBeNull();
    expect(screen.queryByText(/Pay rate:/)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /CSV|QuickBooks|Intacct|Finalize/ })).toBeNull();
    expect(screen.getAllByText('7:00').length).toBeGreaterThan(0);   // the hours are there
  }, 20000);

  it('locks the hours when the timesheet is not with this manager', async () => {
    await renderReview(cardFor({ canEdit: false, review: { id: 'r1', status: 'with_employee', rounds: [], parties: [] } }));
    expect(screen.queryByRole('button', { name: /Fix a Break Punch/ })).toBeNull();
    expect(screen.queryByText(/Finalized/)).toBeNull();          // locked for editing, not finalized
  }, 20000);
});
