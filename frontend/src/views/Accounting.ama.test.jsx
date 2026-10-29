import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';

// The bell's "Open AMA" (Priyanka, 10/15: the page disappeared) lands on
// Accounting with sub 'ama' and a question to open. A render smoke test of
// that landing with the real AMA tab: the screen draws and the question's
// panel opens - never a blank page.
const THREAD = { id: 'T1', kind: 'thread', entityCode: '15000', entryNo: 'GJ-100', accountNo: '99999', accountTitle: 'Ask My Accountant', date: '2026-09-15',
  debit: 125, credit: 0, amount: 125, description: 'Batch', memo: 'Charge Card Transaction', question: 'Which property?', askedBy: 'a@x.com', accountant: 'me@x.com',
  status: 'Open', messages: [{ id: 'm1', kind: 'question', body: 'Which property?', author: 'a@x.com', at: '2026-10-14T16:00:00Z' }] };
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_t, k) => (k === 'then' ? undefined : vi.fn(async () => (
      k === 'getMyAccountingAccess' ? { limited: false }
        : k === 'getAskItems' ? { rows: [], counts: {}, accounts: [], me: 'me@x.com' }
          : k === 'getAskThread' ? THREAD
            : k === 'getAccountingPrefs' ? { prefs: {} } : {}))),
  }),
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'me@x.com', canAccessModule: () => true }) }));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => () => '' }));
vi.mock('../components/accounting/dashboard/DashContext', () => ({ DashProvider: ({ children }) => children, useDash: () => ({}) }));

import Accounting from './Accounting';
import { setPendingOpen } from '../lib/pendingOpen';
// The AMA tab is lazy; since the drill-down (10/28) it brings the transaction
// panel and ledger lines with it, and a cold first load passed findBy's 1s wait.
// Load it up front so the test times the landing, not the module transform.
import '../components/accounting/AskAccountantTab';

function Harness() {
  const [sub, setSub] = useState('ama');
  return <Accounting activeSub={sub} onSubChange={setSub} />;
}

describe('Accounting > AMA from the bell', () => {
  it('draws the AMA tab and opens the question the bell named', async () => {
    setPendingOpen('amaThread', 'T1');
    render(<Harness />);
    expect(await screen.findByRole('heading', { name: 'Ask My Accountant' })).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Ask My Accountant Question' })).toBeTruthy();
    expect(await screen.findByText('Charge Card Transaction')).toBeTruthy();
  });
});
