import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// Approvals on a phone (Neil, 11/02/2026: "simple and actionable, tap tap tap
// and move on"): under 760px ApprovalsCenter renders approvals/ApprovalsPhone
// - one card per request, two big decisions, the chip strip, one Filter
// sheet. Every decision still runs through ApprovalsCenter's `decide` and
// lib/approvalActions.js: this file proves the surface keeps that contract.

const approvalsInbox = vi.fn();
const decided = vi.fn(() => Promise.resolve({ id: 'd1' }));
const timeOffDecide = vi.fn();
const decideReimbursement = vi.fn();
const hrLetterDecline = vi.fn();
const acceptAssignment = vi.fn();
const shiftRequestDecide = vi.fn();
vi.mock('../api', () => ({
  api: {
    approvalsInbox: (...a) => approvalsInbox(...a),
    approvalsHistory: () => Promise.resolve({ days: 30, decidedToday: 0, decidedWeek: 2, avgWaitDays: 1.5, rows: [] }),
    approvalsDecided: (...a) => decided(...a),
    timeOffDecide: (...a) => timeOffDecide(...a),
    decideReimbursement: (...a) => decideReimbursement(...a),
    hrLetterDecline: (...a) => hrLetterDecline(...a),
    acceptAssignment: (...a) => acceptAssignment(...a),
    shiftRequestDecide: (...a) => shiftRequestDecide(...a),
    declineAssignment: vi.fn(() => Promise.resolve({})),
    getPeopleDirectory: () => Promise.resolve([{ email: 'priya.s@greensglobal.com', photoUrl: '' }]),
    getTaskTablePrefs: () => Promise.resolve({ prefs: {} }),
    saveTaskTablePrefs: () => Promise.resolve({}),
  },
}));
// Every breakpoint reads as a phone.
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => true }));
const prompt = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { prompt: (...a) => prompt(...a), confirm: vi.fn(() => Promise.resolve(true)) } }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => false, myGrantedModules: new Set(), myEmail: 'me@greensglobal.com' }),
}));

// jsdom has no PointerEvent (see ApprovalCard.test.jsx).
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; }
  };
}

const { default: Approvals } = await import('./ApprovalsCenter');
const { UNDO_MS } = await import('../lib/approvalActions');
const { MOTION, setMotionEnabled } = await import('../lib/motion');

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
const A = (key, label, tone = 'plain', note = 'none') => ({ key, label, tone, note });
const TIME_OFF = 'Time Off - 11/03/2026 to 11/05/2026 (3 days)';
const MONEY = 'Reimbursement - $142.50 (2 receipts)';
const SHEETS = 'Time Sheet Review - 10/12/2026 to 10/25/2026 (4 people)';
const LETTER = 'Employment Letter - Address Proof';
const ITEM = 'Dell Monitor assigned to you';
const INBOX = {
  rows: [
    { key: 'time_off:t1', kind: 'time_off', id: 't1', group: 'timeoff', source: 'time_off', count: 1, department: 'Admin',
      person: { email: 'priya.s@greensglobal.com', name: 'Priya Sharma' },
      title: TIME_OFF, detail: 'Vacation', createdAt: iso(26),
      actions: [A('approve', 'Approve', 'primary'), A('reject', 'Reject', 'plain', 'optional')],
      link: { view: 'hr', sub: 'hr-time' }, forName: 'Max Test', priority: 'medium' },
    { key: 'reimbursement:r1', kind: 'reimbursement', id: 'r1', group: 'money', source: 'reimbursement', count: 1, department: 'Operations',
      person: { email: 'ankit.p@greensglobal.com', name: 'Ankit Patel' },
      title: MONEY, detail: 'Monitor', createdAt: iso(5),
      actions: [A('approve', 'Approve', 'primary'), A('reject', 'Reject', 'plain', 'required'), A('send_back', 'Send Back', 'plain', 'required')],
      link: { view: 'myhr', sub: 'reimbursements' }, forName: '', priority: 'urgent' },
    { key: 'timesheet_review:a|b', kind: 'timesheet_review', id: 'a|b', group: 'timesheets', source: 'timesheet_review', count: 4, department: 'Operations',
      person: { email: '', name: 'Austin' }, title: SHEETS,
      detail: '', createdAt: iso(2), actions: [A('open', 'Review')], link: { view: 'hr', sub: 'hr-time' }, forName: '', priority: 'low' },
    { key: 'hr_letter:l1', kind: 'hr_letter', id: 'l1', group: 'people', source: 'hr_letter', count: 1, department: 'Admin',
      person: { email: 'ravi.k@greensglobal.com', name: 'Ravi Kumar' }, title: LETTER, detail: 'For a bank account',
      createdAt: iso(200), actions: [A('open', 'Review'), A('decline', 'Decline', 'plain', 'required')], link: { view: 'hr', sub: 'hr-letters' }, priority: 'medium' },
    { key: 'assignment_accept:i1', kind: 'assignment_accept', id: 'i1', group: 'equipment', source: 'assignment_accept', count: 1, scope: 'act',
      person: { email: 'me@greensglobal.com', name: 'Me Myself' }, title: ITEM, detail: '', createdAt: iso(1),
      actions: [A('accept', 'Accept', 'primary'), A('decline', 'Decline', 'plain', 'optional')], link: { view: 'inventory', sub: 'assignments' }, priority: 'medium' },
  ],
  groupLabels: [{ key: 'timeoff', label: 'Time Off' }, { key: 'timesheets', label: 'Time Sheets' },
    { key: 'shifts', label: 'Shifts' }, { key: 'money', label: 'Money' }, { key: 'hiring', label: 'Hiring' },
    { key: 'people', label: 'People' }, { key: 'equipment', label: 'Equipment' }],
  errors: [],
  total: 8,
};

beforeEach(() => { [approvalsInbox, timeOffDecide, decideReimbursement, hrLetterDecline, acceptAssignment, shiftRequestDecide, prompt].forEach((f) => f.mockReset()); });
afterEach(() => { vi.useRealTimers(); setMotionEnabled(false); });

const cards = () => [...document.querySelectorAll('.apv-ph-card')];
const titles = () => cards().map((c) => c.querySelector('.apv-ph-ttl').textContent);
const strip = () => screen.getByRole('group', { name: 'Approval kinds' });
const kindChips = () => within(strip()).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'));
const chip = (name) => kindChips().find((t) => t.textContent.startsWith(name));
const chipCount = (name) => Number(chip(name).querySelector('b').textContent);
const cardCountSum = () => cards().filter((c) => !c.closest('.apv-ph-own')).reduce((t, c) => t + Number(c.getAttribute('data-count') || 1), 0);
const btn = (name) => screen.getByRole('button', { name });
const openFilters = () => fireEvent.click(within(strip()).getByRole('button', { name: /^Filter/ }));
const sheet = () => screen.getByRole('dialog');
const group = (name) => within(within(sheet()).getByRole('group', { name }));

describe('Approvals on a phone', () => {
  it('draws one card per request, chips that count what the cards show, and no keyboard panel', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    // Oldest first: Ravi's letter (200h), Priya (26h), Ankit (5h), Austin (2h); the item is Yours To Do.
    expect(titles()).toEqual([LETTER, TIME_OFF, MONEY, SHEETS, ITEM]);
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('For Max Test')).toBeTruthy();
    // The count pill: everything waiting, the four time sheets counted as four, the item as one.
    expect(screen.getByText('8 Waiting')).toBeTruthy();
    // Chips: All, then only the kinds with something in them; the number on each is the cards' total.
    expect(chipCount('All')).toBe(7);
    expect(chipCount('All')).toBe(cardCountSum());
    expect(chipCount('Time Sheets')).toBe(4);
    expect(kindChips().map((t) => t.textContent)).not.toContain('Hiring0');
    // A group of toggle chips: the one on is pressed; Filter is a plain button.
    expect(chip('All').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Money').getAttribute('aria-pressed')).toBe('false');
    expect(within(strip()).getByRole('button', { name: /^Filter/ }).hasAttribute('aria-pressed')).toBe(false);
    expect(within(strip()).queryAllByRole('tab')).toHaveLength(0);
    expect(document.querySelector('.apv-ph-own .apv-ph-sec-h').textContent).toBe('Yours To Do · 1');
    // No desktop leftovers: the rail, the tiles, the tools row and the shortcuts button are gone.
    expect(document.querySelector('.apv-rail, .apv-tiles, .apv-tools, .apv-row')).toBeNull();
    expect(screen.queryByLabelText('Keyboard shortcuts')).toBeNull();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.queryByText('Keyboard Shortcuts')).toBeNull();
  });

  // Review Focus 1: a decision leaves at once, Undo puts it back where it was,
  // and the module's endpoint is called only once the Undo window has passed.
  it('a card acted on leaves the list, comes back in place on Undo, and is sent only after the window', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    decideReimbursement.mockResolvedValue({});
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(btn(/^Approve: Reimbursement/));
    expect(titles()).toEqual([LETTER, TIME_OFF, SHEETS, ITEM]);
    expect(chipCount('All')).toBe(6);
    expect(screen.getByText('7 Waiting')).toBeTruthy();
    expect(screen.getByText('Approved - Ankit Patel, Money')).toBeTruthy();
    fireEvent.click(screen.getByText('Undo'));
    expect(titles()).toEqual([LETTER, TIME_OFF, MONEY, SHEETS, ITEM]);   // the same place, third
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(decideReimbursement).not.toHaveBeenCalled();
    fireEvent.click(btn(/^Approve: Reimbursement/));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(decideReimbursement).toHaveBeenCalledWith('r1', { action: 'approve', note: '' });
    expect(prompt).not.toHaveBeenCalled();
  });

  // Tap, tap: the second decision inside the window must not orphan the
  // first. The toast speaks for both, and one Undo brings both back, each
  // to its own place, with nothing sent.
  it('Undo after two quick decisions brings both back and sends neither', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(btn(/^Approve: Reimbursement/));
    expect(screen.getByText('Approved - Ankit Patel, Money')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS / 2); });
    fireEvent.click(btn(/^Reject: Time Off/));            // optional note: fires at once
    expect(titles()).toEqual([LETTER, SHEETS, ITEM]);
    expect(screen.getByText('2 Decisions')).toBeTruthy();
    fireEvent.click(screen.getByText('Undo'));
    expect(titles()).toEqual([LETTER, TIME_OFF, MONEY, SHEETS, ITEM]);
    expect(screen.queryByText('Undo')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS * 2); });
    expect(decideReimbursement).not.toHaveBeenCalled();
    expect(timeOffDecide).not.toHaveBeenCalled();
  });

  it('the Undo toast drops a decision once it has been sent', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    decideReimbursement.mockResolvedValue({});
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(btn(/^Approve: Reimbursement/));
    await act(async () => { vi.advanceTimersByTime(UNDO_MS - 1000); });
    fireEvent.click(btn(/^Approve: Time Off/));
    expect(screen.getByText('Approved 2 Requests')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1100); });   // the reimbursement goes out
    expect(decideReimbursement).toHaveBeenCalledWith('r1', { action: 'approve', note: '' });
    expect(screen.getByText('Approved - Priya Sharma, Time Off')).toBeTruthy();
    fireEvent.click(screen.getByText('Undo'));
    expect(titles()).toContain(TIME_OFF);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).not.toHaveBeenCalled();
  });

  // A double tap lands its second tap on the card that just slid up under
  // the finger: the list ignores taps until the glide is over.
  it('a double tap never decides the next card', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fireEvent.click(btn(/^Approve: Time Off/));
    // The reimbursement is now where Time Off was; the second tap of the double tap lands on it.
    await act(async () => { vi.advanceTimersByTime(120); });
    fireEvent.click(btn(/^Approve: Reimbursement/));
    expect(titles()).toEqual([LETTER, MONEY, SHEETS, ITEM]);
    expect(screen.getByText('Approved - Priya Sharma, Time Off')).toBeTruthy();
    // Under reduced motion the floor is 350 ms; with motion it is the glide plus 150.
    await act(async () => { vi.advanceTimersByTime(Math.max(MOTION.md + 150, 350)); });
    fireEvent.click(btn(/^Approve: Reimbursement/));
    expect(titles()).toEqual([LETTER, SHEETS, ITEM]);
    expect(screen.getByText('Approved 2 Requests')).toBeTruthy();
  });

  it("after a decision focus lands on the next card's first decision, or on Undo when nothing is left", async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    btn(/^Approve: Time Off/).focus();
    fireEvent.click(btn(/^Approve: Time Off/));
    expect(document.activeElement).toBe(btn(/^Approve: Reimbursement/));
    // The last card of the list hands focus to the one above it.
    await act(async () => { vi.advanceTimersByTime(400); });
    fireEvent.click(btn(/^Accept: Dell Monitor/));
    expect(document.activeElement).toBe(btn(/^Review: Time Sheet Review/));
  });

  it('focus goes to Undo when the last card is decided', async () => {
    approvalsInbox.mockResolvedValue({ ...INBOX, rows: INBOX.rows.filter((r) => r.kind === 'time_off') });
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    fireEvent.click(btn(/^Approve: Time Off/));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
  });

  // Review Focus 2: a no that needs a note opens the note sheet first and
  // never fires without it; the desktop prompt is never used on a phone.
  it('a reject that needs a note opens the note sheet and never fires without the note', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    decideReimbursement.mockResolvedValue({});
    hrLetterDecline.mockResolvedValue({});
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(MONEY);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(btn(/^Reject: Reimbursement/));
    const dlg = sheet();
    // The visible "Why?" label names the box; a required reason never says optional.
    const box = within(dlg).getByRole('textbox', { name: 'Why?' });
    expect(box.style.fontSize).toBe('16px');
    expect(box.getAttribute('placeholder')).toBe('Reason');
    expect(screen.getByText(MONEY, { selector: '.apv-ph-ttl' })).toBeTruthy();   // still in the list
    const send = within(dlg).getByRole('button', { name: 'Reject' });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(screen.getByText(MONEY, { selector: '.apv-ph-ttl' })).toBeTruthy();
    fireEvent.change(box, { target: { value: '  No receipt attached ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(screen.queryByText(MONEY, { selector: '.apv-ph-ttl' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(decideReimbursement).toHaveBeenCalledWith('r1', { action: 'reject', note: 'No receipt attached' });
    expect(prompt).not.toHaveBeenCalled();
    // The HR letter's Decline needs a reason too; Cancel decides nothing.
    fireEvent.click(btn(/^Decline: Employment Letter/));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(LETTER, { selector: '.apv-ph-ttl' })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(hrLetterDecline).not.toHaveBeenCalled();
  });

  // The server's `note` on the action is the one rule: optional fires at
  // once (a one-tap decision, no sheet), required always asks.
  it("an optional note never holds a decision up: time off's Reject and a shift request's Decline fire at once", async () => {
    const SHIFT = 'Shift Swap - 11/04/2026 9:00 AM';
    approvalsInbox.mockResolvedValue({ ...INBOX, rows: [...INBOX.rows,
      { key: 'shift_request:s1', kind: 'shift_request', id: 's1', group: 'shifts', source: 'shift_request', count: 1, department: 'Admin',
        person: { email: 'nina.r@greensglobal.com', name: 'Nina Rao' }, title: SHIFT, detail: '', createdAt: iso(3),
        actions: [A('approve', 'Approve', 'primary'), A('decline', 'Decline', 'plain', 'optional')], link: { view: 'shifts', sub: 'requests' }, priority: 'medium' }] });
    timeOffDecide.mockResolvedValue({});
    shiftRequestDecide.mockResolvedValue({});
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(btn(/^Reject: Time Off/));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(TIME_OFF, { selector: '.apv-ph-ttl' })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(timeOffDecide).toHaveBeenCalledWith('t1', { status: 'rejected', note: '' });
    fireEvent.click(btn(/^Decline: Shift Swap/));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(SHIFT, { selector: '.apv-ph-ttl' })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
    expect(shiftRequestDecide).toHaveBeenCalledWith('s1', { approve: false, note: '' });
    expect(prompt).not.toHaveBeenCalled();
  });

  // Review Focus 3: grouping keeps a sticky label per section and the chip
  // counts stay the sum of the cards.
  it('groups by person, type or department under sticky labels, with the chips still summing the cards', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    openFilters();
    fireEvent.click(group('Group By').getByRole('button', { name: 'Person' }));
    const heads = () => [...document.querySelectorAll('.apv-ph-sec-h')];
    // The label and its count; the oldest-waiting chip (Ravi's letter, 8 days) rides along on the right.
    const said = () => heads().map((h) => h.querySelector('.apv-ph-sec-l').textContent + h.querySelector('.apv-ph-sec-n').textContent);
    expect(said()).toEqual(['Ravi Kumar · 1', 'Priya Sharma · 1', 'Ankit Patel · 1', 'Austin · 4', 'Yours To Do · 1']);
    expect(within(heads()[0]).getByText('Oldest 8d')).toBeTruthy();
    heads().forEach((h) => expect(h.style.position).toBe('sticky'));
    expect(chipCount('All')).toBe(cardCountSum());
    fireEvent.click(group('Group By').getByRole('button', { name: 'Type' }));
    expect(said()).toEqual(['People · 1', 'Time Off · 1', 'Money · 1', 'Time Sheets · 4', 'Yours To Do · 1']);
    fireEvent.click(group('Group By').getByRole('button', { name: 'Department' }));
    expect(said()).toEqual(['Admin · 2', 'Operations · 5', 'Yours To Do · 1']);
    expect(chipCount('All')).toBe(cardCountSum());
    fireEvent.click(group('Group By').getByRole('button', { name: 'None' }));
    expect(said()).toEqual(['Yours To Do · 1']);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Review Focus 4: with reduced motion the card is simply gone; with motion
  // on it plays its exit (is-leaving) and is unmounted after the beat.
  it('reduced motion drops the card instantly and animates nothing; motion on plays the exit first', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    timeOffDecide.mockResolvedValue({});
    const realMatch = window.matchMedia;
    let reduce = true;
    window.matchMedia = (q) => ({ matches: q.includes('prefers-reduced-motion') ? reduce : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      setMotionEnabled(true);
      render(<Approvals activeSub="" onSubChange={() => {}} />);
      await screen.findByText(TIME_OFF);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(btn(/^Approve: Time Off/));
      expect(screen.queryByText(TIME_OFF, { selector: '.apv-ph-ttl' })).toBeNull();
      expect(document.querySelector('.apv-ph-ghost, .is-leaving')).toBeNull();
      fireEvent.click(screen.getByText('Undo'));
      expect(screen.getByText(TIME_OFF, { selector: '.apv-ph-ttl' })).toBeTruthy();
      // Motion on: the card stays as a leaving ghost for the beat, then goes.
      reduce = false;
      await act(async () => { vi.advanceTimersByTime(400); });   // past the double-tap lock
      fireEvent.click(btn(/^Approve: Time Off/));
      const ghost = document.querySelector('.apv-ph-ghost');
      expect(ghost).toBeTruthy();
      expect(ghost.className).toContain('is-yes');
      expect(within(ghost).getByText(TIME_OFF)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Approve: Time Off/ })).toBeNull();   // a ghost takes no taps
      await act(async () => { vi.advanceTimersByTime(MOTION.xs + MOTION.exit + 50); });
      expect(document.querySelector('.apv-ph-ghost')).toBeNull();
      expect(screen.queryByText(TIME_OFF)).toBeNull();
    } finally {
      window.matchMedia = realMatch;
    }
  });

  // Motion on, outside a test run's reduced-motion default.
  const withMotion = async (fn) => {
    const realMatch = window.matchMedia;
    window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    setMotionEnabled(true);
    try { await fn(); } finally { window.matchMedia = realMatch; }
  };

  it("the last card of a section takes the section's label with it, and its ghost sits over the list", async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    timeOffDecide.mockResolvedValue({});
    await withMotion(async () => {
      render(<Approvals activeSub="" onSubChange={() => {}} />);
      await screen.findByText(TIME_OFF);
      openFilters();
      fireEvent.click(group('Group By').getByRole('button', { name: 'Person' }));
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }));
      const labels = () => [...document.querySelectorAll('.apv-ph-sec-h')].map((h) => h.textContent);
      // Every label is a FLIP item, so the labels below glide up with the cards.
      document.querySelectorAll('.apv-ph-sec-h').forEach((h) => expect(h.getAttribute('data-flip')).toMatch(/^sec:/));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(btn(/^Approve: Time Off/));                 // Priya's only card
      const ghost = document.querySelector('.apv-ph-ghost');
      expect(ghost).toBeTruthy();
      expect(ghost.closest('.apv-ph-sec')).toBeNull();
      expect(labels().some((t) => t.startsWith('Priya Sharma'))).toBe(false);   // no "Priya Sharma · 0" for the beat
      expect(labels().some((t) => / · 0/.test(t))).toBe(false);
    });
  });

  it('the ghost leaves the way the decision went: right for a yes, left for a no, from where a swipe let go', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    await withMotion(async () => {
      render(<Approvals activeSub="" onSubChange={() => {}} />);
      await screen.findByText(TIME_OFF);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fireEvent.click(btn(/^Approve: Time Off/));
      let ghost = document.querySelector('.apv-ph-ghost');
      expect(ghost.style.getPropertyValue('--dir')).toBe('1');
      expect(ghost.style.getPropertyValue('--from-x')).toBe('0px');
      await act(async () => { vi.advanceTimersByTime(MOTION.md + 200); });
      // A left swipe on the item (Yours To Do: Decline, optional note) - it leaves left, from where it was let go.
      const item = screen.getByText(ITEM, { selector: '.apv-ph-ttl' }).closest('.apv-ph-card');
      Object.defineProperty(item, 'offsetWidth', { value: 300, configurable: true });
      const touch = (x) => ({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: 100 });
      fireEvent.pointerDown(item, touch(260));
      fireEvent.pointerMove(item, touch(240));
      fireEvent.pointerMove(item, touch(100));
      fireEvent.pointerUp(item, touch(100));
      ghost = [...document.querySelectorAll('.apv-ph-ghost')].find((g) => g.textContent.includes(ITEM));
      expect(ghost.className).toContain('is-no');
      expect(ghost.style.getPropertyValue('--dir')).toBe('-1');
      expect(ghost.style.getPropertyValue('--from-x')).toBe('-160px');
    });
  });

  it('Done, Cancel and the note submit leave through the sheet exit the X plays', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    decideReimbursement.mockResolvedValue({});
    await withMotion(async () => {
      render(<Approvals activeSub="" onSubChange={() => {}} />);
      await screen.findByText(TIME_OFF);
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const closing = () => document.querySelector('.nx-overlay.is-closing');
      openFilters();
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }));
      expect(closing()).toBeTruthy();                                  // sliding out, still drawn
      await act(async () => { vi.advanceTimersByTime(MOTION.md + 20); });
      expect(screen.queryByRole('dialog')).toBeNull();
      // Cancel on the note sheet: the same exit, and nothing decided.
      fireEvent.click(btn(/^Reject: Reimbursement/));
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
      expect(closing()).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(MOTION.md + 20); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByText(MONEY, { selector: '.apv-ph-ttl' })).toBeTruthy();
      // Submit: the sheet slides out first, then the card goes.
      await act(async () => { vi.advanceTimersByTime(400); });
      fireEvent.click(btn(/^Reject: Reimbursement/));
      fireEvent.change(within(sheet()).getByRole('textbox', { name: 'Why?' }), { target: { value: 'No receipt' } });
      fireEvent.click(within(sheet()).getByRole('button', { name: 'Reject' }));
      expect(closing()).toBeTruthy();
      expect(screen.getByText(MONEY, { selector: '.apv-ph-ttl' })).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(MOTION.md + 20); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Reject: Reimbursement/ })).toBeNull();   // decided (its ghost is leaving)
      await act(async () => { vi.advanceTimersByTime(UNDO_MS + 100); });
      expect(decideReimbursement).toHaveBeenCalledWith('r1', { action: 'reject', note: 'No receipt' });
    });
  });

  // Review Focus 5: a row that only opens its module shows Review and Open.
  it('a row that cannot run inline shows Review and Open, never a disabled Approve', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    const card = (await screen.findByText(SHEETS)).closest('.apv-ph-card');
    expect(within(card).getByRole('button', { name: /^Review:/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Open:/ })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect([...card.querySelectorAll('button')].some((b) => b.disabled)).toBe(false);
    fireEvent.click(within(card).getByRole('button', { name: /^Review:/ }));
    expect(seen).toEqual([]);
    expect(within(sheet()).getByText('Austin')).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: /^Open In / }));
    expect(seen).toEqual([{ view: 'hr', sub: 'hr-time' }]);
    window.removeEventListener('nexus:navigate', on);
    // The letter: Review and the one inline no, side by side.
    const letter = screen.getByText(LETTER).closest('.apv-ph-card');
    expect(within(letter).getByRole('button', { name: /^Review:/ })).toBeTruthy();
    expect(within(letter).getByRole('button', { name: /^Decline:/ })).toBeTruthy();
    expect(within(letter).queryByRole('button', { name: /^More:/ })).toBeNull();
  });

  it('the Filter chip carries a dot while a filter is on, and Clear Filters takes it off', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    expect(strip().querySelector('.apv-ph-dot')).toBeNull();
    openFilters();
    fireEvent.click(group('Priority').getByRole('button', { name: 'Urgent' }));
    expect(titles()).toEqual([MONEY]);                          // priority narrows Yours To Do as well
    expect(strip().querySelector('.apv-ph-dot')).toBeTruthy();
    fireEvent.click(group('Priority').getByRole('button', { name: 'All' }));
    expect(titles()).toEqual([LETTER, TIME_OFF, MONEY, SHEETS, ITEM]);
    fireEvent.click(group('Waiting').getByRole('button', { name: '3+ Days' }));
    expect(titles()).toEqual([LETTER, ITEM]);                   // waiting applies to what you decide
    fireEvent.change(within(sheet()).getByRole('searchbox'), { target: { value: 'nobody' } });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }));
    expect(screen.getByText('No approvals match your filters')).toBeTruthy();
    // A neutral mark for an empty filter; the green check is for All caught up.
    expect(document.querySelector('.apv-ph-empty-ic').className).toContain('is-filtered');
    expect(document.querySelector('.apv-ph-empty-ic svg').getAttribute('class')).toContain('search-x');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(titles()).toEqual([LETTER, TIME_OFF, MONEY, SHEETS, ITEM]);
    expect(strip().querySelector('.apv-ph-dot')).toBeNull();
  });

  it('the kind chips count what they would show under every other filter', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    await screen.findByText(TIME_OFF);
    openFilters();
    fireEvent.click(group('Priority').getByRole('button', { name: 'Urgent' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }));
    // Only Ankit's reimbursement is urgent: All 1, Money 1, and no chip for kinds with nothing urgent.
    expect(chipCount('All')).toBe(1);
    expect(chipCount('Money')).toBe(1);
    expect(chip('Time Off')).toBeUndefined();
    expect(chip('Time Sheets')).toBeUndefined();
    expect(chipCount('All')).toBe(cardCountSum());
  });

  it('the chips filter by kind through the Dashboard sub, and History is still a tap away', async () => {
    approvalsInbox.mockResolvedValue(INBOX);
    const onSubChange = vi.fn();
    const { rerender } = render(<Approvals activeSub="" onSubChange={onSubChange} />);
    await screen.findByText(TIME_OFF);
    fireEvent.click(chip('Money'));
    expect(onSubChange).toHaveBeenCalledWith('money');
    rerender(<Approvals activeSub="money" onSubChange={onSubChange} />);
    expect(titles()).toEqual([MONEY, ITEM]);
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(onSubChange).toHaveBeenCalledWith('history');
    rerender(<Approvals activeSub="history" onSubChange={onSubChange} />);
    expect(await screen.findByText(/Decided Here - Last 30 Days/)).toBeTruthy();
    expect(document.querySelector('.apv-ph-card')).toBeNull();
  });

  it('says All caught up when nothing waits', async () => {
    approvalsInbox.mockResolvedValue({ ...INBOX, rows: [], total: 0, who: { canApprove: true } });
    render(<Approvals activeSub="" onSubChange={() => {}} />);
    expect(await screen.findByText('All caught up')).toBeTruthy();
    expect(document.querySelector('.apv-ph-empty-ic').className).not.toContain('is-filtered');
    expect(document.querySelector('.apv-ph-empty-ic svg').getAttribute('class')).toMatch(/circle-check|check-circle/);
    expect(screen.getByText('Nothing waiting on you.')).toBeTruthy();
  });
});
