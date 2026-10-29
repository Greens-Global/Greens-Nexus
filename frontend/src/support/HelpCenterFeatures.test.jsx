import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within, waitFor } from '@testing-library/react';

// Help Center additions (Oct 2026): Ask Nexus, Was This Helpful?, Known
// Issues, "I Need To...", the Help Center search bar, "Expect a reply by" and
// the failed-search record.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const role = { isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@example.com', timeTrackingExempt: false };
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => role,
}));

const calls = { ask: [], log: [], feedback: [] };
const apiState = { ask: null, askFail: null, issues: { issues: [], canEdit: false } };
vi.mock('../api', () => {
  const handlers = {
    helpAsk: (q, guide) => {
      calls.ask.push({ q, guide });
      if (apiState.askFail) return Promise.reject(apiState.askFail);
      return Promise.resolve(apiState.ask);
    },
    helpSearchLog: (q, results, source) => { calls.log.push({ q, results, source }); return Promise.resolve(null); },
    helpFeedback: (d) => { calls.feedback.push(d); return Promise.resolve({ ok: true }); },
    helpKnownIssues: () => Promise.resolve(apiState.issues),
    kbCorpusDocs: () => Promise.resolve([]),
    kbCorpusCourses: () => Promise.resolve([]),
  };
  return { api: new Proxy(handlers, { get: (t, k) => t[k] || (() => Promise.resolve([])) }) };
});

const { default: AskNexus } = await import('./AskNexus');
const { default: HelpFeedback } = await import('./HelpFeedback');
const { default: KnownIssuesBanner, KnownIssuesNotice } = await import('./KnownIssues');
const { __resetKnownIssues } = await import('./knownIssuesStore');
const { default: NeedTo } = await import('./NeedTo');
const { default: HelpCenterSearch } = await import('./HelpCenterSearch');
const { default: ExpectReply } = await import('./ExpectReply');
const { logHelpSearch, __resetHelpLog } = await import('./helpLog');
const { __resetKbCorpus } = await import('./kbCorpus');
// Warm the lazy chunks the search bar loads.
await import('./HelpCenterResults');
await import('./HelpCenterAnswer');

const allowAll = () => true;
const LOAD = { timeout: 8000 };

beforeEach(() => {
  calls.ask = []; calls.log = []; calls.feedback = [];
  apiState.ask = null; apiState.askFail = null; apiState.issues = { issues: [], canEdit: false };
  Object.assign(role, { isExternal: false, can: () => false, myGrantedModules: new Set(), timeTrackingExempt: false });
  __resetKnownIssues(); __resetHelpLog(); __resetKbCorpus();
});
afterEach(cleanup);

describe('Ask Nexus', () => {
  it('sends the guide sections for the question and shows the answer with its sources', async () => {
    apiState.ask = {
      answer: 'Open Workday and pick **Request Time Off** [1].\n1. Choose the days\n2. Send it',
      sources: [{ kind: 'guide', id: 'workday#w-request-time-off', title: 'Workday > Request Time Off', n: 1 }],
      grounded: true, offline: false,
    };
    const onFileTicket = vi.fn();
    render(<AskNexus question="How do I request time off?" allow={allowAll} onFileTicket={onFileTicket} />);
    expect(await screen.findByText('Request Time Off', { selector: 'strong' }, LOAD)).toBeTruthy();
    expect(calls.ask).toHaveLength(1);
    const { guide } = calls.ask[0];
    expect(guide.length).toBeGreaterThan(0);
    expect(guide.length).toBeLessThanOrEqual(6);
    guide.forEach((g) => { expect(Object.keys(g).sort()).toEqual(['id', 'text', 'title']); expect(g.text.length).toBeLessThanOrEqual(4000); });
    // The [1] citation is a button to the source; the steps are a list.
    expect(screen.getByRole('button', { name: 'Source: Workday > Request Time Off' })).toBeTruthy();
    expect(screen.getByText('Choose the days')).toBeTruthy();
    expect(screen.getByText('Was This Helpful?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /File a Ticket/ }));
    expect(onFileTicket).toHaveBeenCalledWith('How do I request time off?');
  });

  it('falls back to the sources when Nexus cannot write an answer, and records the question', async () => {
    apiState.ask = { answer: '', sources: [{ kind: 'kb', id: 'kb1', title: 'Gate Keypad Codes' }], grounded: false, offline: true };
    render(<AskNexus question="gate keypad battery" allow={allowAll} onFileTicket={() => {}} />);
    expect(await screen.findByText(/cannot write an answer right now/, {}, LOAD)).toBeTruthy();
    expect(screen.getByText('Gate Keypad Codes')).toBeTruthy();
    await waitFor(() => expect(calls.log).toContainEqual({ q: 'gate keypad battery', results: 1, source: 'ask' }));
  });

  it('says so when someone has asked too much this hour', async () => {
    apiState.askFail = Object.assign(new Error('You have asked Nexus 20 questions in the last hour.'), { status: 429 });
    render(<AskNexus question="anything" allow={allowAll} onFileTicket={() => {}} />);
    expect(await screen.findByText(/20 questions in the last hour/, {}, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: /File a Ticket/ })).toBeTruthy();
  });
});

describe('Was This Helpful?', () => {
  it('No asks what was missing and sends it', async () => {
    render(<HelpFeedback kind="guide" targetId="workday#tips" title="Workday > Good To Know" />);
    fireEvent.click(screen.getByRole('button', { name: /No/ }));
    await waitFor(() => expect(calls.feedback).toHaveLength(1));
    expect(calls.feedback[0]).toMatchObject({ target_kind: 'guide', target_id: 'workday#tips', helpful: false });
    fireEvent.change(screen.getByLabelText(/What was missing/), { target: { value: 'Half days' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.feedback).toHaveLength(2));
    expect(calls.feedback[1]).toMatchObject({ helpful: false, note: 'Half days' });
    expect(await screen.findByText('Thanks for the feedback.')).toBeTruthy();
  });
});

describe('Known Issues', () => {
  const ISSUE = { id: 'i1', title: 'Time Clock Is Slow', note: 'We are on it.', severity: 'outage', until: '', posted_at: '2026-10-28T17:00:00Z', expired: false };
  it('shows live issues to everyone, and only administrators can manage them', async () => {
    apiState.issues = { issues: [ISSUE], canEdit: false };
    render(<KnownIssuesBanner />);
    expect(await screen.findByText('Time Clock Is Slow')).toBeTruthy();
    expect(screen.getByText(/no need to file a ticket/i)).toBeTruthy();
    expect(screen.queryByText(/Manage Known Issues/)).toBeNull();
  });
  it('an administrator gets Manage Known Issues; an expired issue stays out of the banner', async () => {
    apiState.issues = { issues: [ISSUE, { ...ISSUE, id: 'i2', title: 'Old Notice', expired: true }], canEdit: true };
    render(<KnownIssuesBanner />);
    expect(await screen.findByText('Manage Known Issues')).toBeTruthy();
    expect(screen.queryByText('Old Notice')).toBeNull();
  });
  it('the ticket form notice names the issue', async () => {
    apiState.issues = { issues: [ISSUE], canEdit: false };
    render(<KnownIssuesNotice />);
    expect(await screen.findByText(/Known Issue: Time Clock Is Slow/)).toBeTruthy();
  });
});

describe('I Need To...', () => {
  it('goes straight to the real screen, and files Request Access as an Access Request ticket', () => {
    const onTicket = vi.fn();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    render(<NeedTo onTicket={onTicket} />);
    fireEvent.click(screen.getByRole('button', { name: /Request Time Off/ }));
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'timeclock', sub: 'timeoff' });
    fireEvent.click(screen.getByRole('button', { name: /Request Access/ }));
    expect(onTicket).toHaveBeenCalledWith({ type: 'access_request' });
    window.removeEventListener('nexus:navigate', nav);
  });
  it('hides Fix My Time Sheet from a time-tracking-exempt person', () => {
    role.timeTrackingExempt = true;
    render(<NeedTo onTicket={() => {}} />);
    expect(screen.queryByText('Fix My Time Sheet')).toBeNull();
    expect(screen.getByText('Request Time Off')).toBeTruthy();
  });
  it('an external guest without Workday sees only the ticket doors', () => {
    role.isExternal = true;
    render(<NeedTo onTicket={() => {}} />);
    expect(screen.queryByText('Request Time Off')).toBeNull();
    expect(screen.queryByText('Ask HR')).toBeNull();
    expect(screen.getByText('Report a Bug')).toBeTruthy();
  });
});

describe('Help Center search bar', () => {
  it('drops down Ask Nexus and guide results, and Enter asks Nexus', async () => {
    apiState.ask = { answer: 'Use Request Time Off [1].', sources: [{ kind: 'guide', id: 'workday', title: 'Workday', n: 1 }], grounded: true, offline: false };
    render(<HelpCenterSearch onFileTicket={() => {}} />);
    const box = screen.getByLabelText('Search for help');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'request time off' } });
    const list = await screen.findByRole('listbox', { name: 'Help results' }, LOAD);
    expect(within(list).getByText(/Ask Nexus: "request time off"/)).toBeTruthy();
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(1);
    await act(async () => { fireEvent.submit(box.closest('form')); });
    expect(await screen.findByRole('region', { name: 'Ask Nexus' }, LOAD)).toBeTruthy();
    await waitFor(() => expect(calls.ask[0]?.q).toBe('request time off'));
  });
});

describe('Expect a reply by', () => {
  it('shows the first-response deadline until someone replies', () => {
    const due = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    const { rerender } = render(<ExpectReply t={{ status: 'open', firstResponseDueAt: due, requesterId: 'me@example.com' }} />);
    expect(screen.getByTestId('expect-reply').textContent).toMatch(/^ ?Expect a reply by \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/);
    rerender(<ExpectReply t={{ status: 'open', firstResponseDueAt: due, firstResponseAt: new Date().toISOString() }} />);
    expect(screen.queryByTestId('expect-reply')).toBeNull();
    rerender(<ExpectReply t={{ status: 'waiting_user', firstResponseDueAt: due }} />);
    expect(screen.queryByTestId('expect-reply')).toBeNull();
  });
});

describe('failed-search record', () => {
  it('sends the same words from the same box once per session', () => {
    logHelpSearch('salary advance', 0, 'help');
    logHelpSearch('Salary Advance', 0, 'help');
    logHelpSearch('salary advance', 2, 'ticket-form');
    logHelpSearch('ab', 0, 'help');   // too short to mean anything
    expect(calls.log).toEqual([
      { q: 'salary advance', results: 0, source: 'help' },
      { q: 'salary advance', results: 2, source: 'ticket-form' },
    ]);
  });
});
