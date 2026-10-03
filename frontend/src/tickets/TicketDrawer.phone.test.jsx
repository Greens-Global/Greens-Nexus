import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

// The ticket sheet on a phone (Oct 3): the tab strip is one row that swipes,
// the footer stacks (Done full width on its own row, Delete inside More),
// every small control is a thumb-sized target, and an intake screenshot opens
// in the in-app viewer. vitest's setup says "not a phone" (matchMedia false),
// so each test here turns the phone breakpoint on itself.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
const ACTIVITY = [
  { id: 'a1', type: 'created', actorId: 'req@example.com', at: '2026-10-01T15:04:00Z',
    detail: JSON.stringify({ subject: 'Printer jam', type: 'incident', priority: 'medium', application: 'Printer', typeFields: {} }) },
  { id: 'a2', type: 'updated', actorId: 'agent@example.com', at: '2026-10-02T16:30:00Z',
    detail: 'changed priority from Medium to a very long value that would otherwise squeeze into a sliver' },
];
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  const named = {
    getTicketActivity: () => Promise.resolve(ACTIVITY),
    getMyTicketAccess: () => Promise.resolve({ canAct: false }),
  };
  return { api: new Proxy({}, { get: (_, k) => named[k] || empty }) };
});
vi.mock('./TicketAtoms', async (importOriginal) => ({
  ...(await importOriginal()),
  TicketSelect: ({ value, onChange, options, disabled }) => (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(options || []).map((o) => (Array.isArray(o) ? { id: o[0], label: o[1] } : o))
        .map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  ),
}));

const OPEN = {
  id: 't1', code: '000001', subject: 'Printer jam', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: 'agent@example.com', approvalStatus: 'none', typeFields: {},
  images: ['https://example.supabase.co/storage/v1/object/public/ticket-evidence/a.png'],
  taskIds: ['task-1'],
  links: [{ ticketId: 't2', type: 'relates' }],
};
const OTHER = { id: 't2', code: '000002', subject: 'A very long linked ticket subject that would push the remove button off a phone screen', status: 'open', priority: 'low', type: 'incident', typeFields: {} };
let current = OPEN;
const updateTicket = vi.fn(() => Promise.resolve(current));
const deleteTicket = vi.fn(() => Promise.resolve());
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [current, OTHER], ticketsLoaded: true,
    tasks: [{ id: 'task-1', code: 'T-1', title: 'Replace toner', status: 'todo' }], projects: [],
    myEmail: 'agent@example.com', nameOf: (e) => e, updateTicket, deleteTicket, refresh: vi.fn(),
    addTicketLink: vi.fn(() => Promise.resolve()), removeTicketLink: vi.fn(() => Promise.resolve()) }),
}));

const { TicketDrawer, TicketActionDialog } = await import('./TicketsView');

function setPhone(isPhone) {
  window.matchMedia = (q) => ({
    matches: isPhone && (q.includes('max-width: 640px') || q.includes('pointer: coarse')),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}
const realMatchMedia = window.matchMedia;
beforeEach(() => setPhone(true));
afterEach(() => {
  cleanup(); current = OPEN; window.matchMedia = realMatchMedia;
  updateTicket.mockClear(); deleteTicket.mockClear(); vi.restoreAllMocks();
});

const prioritySelect = () => screen.getAllByRole('combobox').find((el) => [...el.options].some((o) => o.value === 'urgent'));

describe('TicketDrawer on a phone', () => {
  it('shows the tabs as one scrolling row of 40px targets', () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const overview = screen.getByRole('button', { name: /Overview/ });
    const strip = overview.parentElement;
    expect(strip.className).toContain('scroll-tabs');
    expect(strip.style.flexWrap).toBe('nowrap');
    for (const name of [/Overview/, /Conversation/, /Attachments/, /Activity/]) {
      const b = screen.getByRole('button', { name });
      expect(b.style.minHeight).toBe('40px');
      expect(b.style.flexShrink).toBe('0');
    }
    expect(overview.getAttribute('data-tab-active')).toBe('true');
  });

  it('puts Done full width on its own row and Delete inside More', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done.style.width).toBe('100%');
    // Delete no longer leads the row - it is one tap further, in More.
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    const more = screen.getByRole('button', { name: /More/ });
    expect(more.style.minHeight).toBe('44px');
    // The ticket's moves share the row above Done.
    const resolve = screen.getByRole('button', { name: /Mark Resolved/ });
    expect(resolve.parentElement).toBe(more.parentElement);
    expect(done.parentElement).not.toBe(more.parentElement);

    fireEvent.click(more);
    const del = await screen.findByRole('menuitem', { name: /Delete Ticket/ });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { fireEvent.click(del); });
    expect(deleteTicket).toHaveBeenCalledWith('t1');
  });

  it('shows "Unsaved changes" as a line above the buttons and still asks before discarding', () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.change(prioritySelect(), { target: { value: 'high' } });
    const note = screen.getByText('Unsaved changes');
    const stack = screen.getByRole('button', { name: 'Done' }).parentElement;
    expect(stack.firstChild.contains(note)).toBe(true);
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ask).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives the edit pencil a 36px target', () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const pencil = screen.getByRole('button', { name: 'Edit title and description' });
    expect(pencil.style.minHeight).toBe('36px');
    expect(pencil.style.minWidth).toBe('36px');
  });

  it('opens an intake screenshot in the in-app viewer, not a new tab', () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    expect(document.querySelector('a[target="_blank"] img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open screenshot 1' }));
    expect(screen.getByRole('button', { name: 'Close viewer' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(screen.queryByRole('button', { name: 'Close viewer' })).toBeNull();
  });

  it('keeps the link and task remove buttons on screen at 36px', () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const removeLink = screen.getByRole('button', { name: 'Remove link' });
    expect(removeLink.style.minHeight).toBe('36px');
    const subject = removeLink.previousElementSibling;
    expect(subject.style.minWidth).toMatch(/^0(px)?$/);
    expect(subject.style.flex).toMatch(/^1/);
    expect(screen.getByRole('button', { name: 'Unlink task' }).style.minHeight).toBe('36px');
  });

  it('stacks Approve and Reject full width at 44px', () => {
    current = { ...OPEN, approvalStatus: 'pending', approverId: 'agent@example.com' };
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const approve = screen.getByRole('button', { name: /Approve/ });
    const reject = screen.getByRole('button', { name: /Reject/ });
    expect(approve.style.minHeight).toBe('44px');
    expect(reject.style.minHeight).toBe('44px');
    expect(approve.parentElement.style.flexDirection).toBe('column');
    expect(approve.parentElement.style.alignItems).toBe('stretch');
  });

  it('rates with real 40px star buttons', () => {
    current = { ...OPEN, status: 'closed', requesterId: 'agent@example.com', csatRating: 0, resolution: 'fixed' };
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    const star = screen.getByRole('button', { name: 'Rate 4 of 5' });
    expect(star.style.minHeight).toBe('40px');
    // A tap's synthetic mouseenter lights nothing on a touch screen.
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Rate 5 of 5' }));
    expect(screen.getByRole('button', { name: 'Rate 5 of 5' }).querySelector('svg').style.fill).toBe('none');
    fireEvent.click(star);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rate 4 of 5' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('puts who and when on one line above what happened, in one column', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    const detail = await screen.findByText(/changed priority from Medium/);
    const when = screen.getAllByText((_, el) => el?.tagName === 'SPAN' && el.style.fontSize === '12px' && /\d{2}\/\d{2}\/\d{4}/.test(el.textContent));
    expect(when.length).toBeGreaterThan(0);
    // The detail sits in its own row under the name line, not beside it.
    const nameLine = screen.getByText('agent@example.com', { selector: 'span' }).parentElement;
    expect(nameLine.contains(detail)).toBe(false);
    // The original-request card is one column.
    const card = screen.getByText(/Original request/).parentElement;
    const grid = [...card.children].find((el) => el.style.display === 'grid');
    expect(grid.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(grid.style.overflowWrap).toBe('anywhere');
  });
});

describe('TicketActionDialog on a phone', () => {
  it('does not autofocus the textarea (the keyboard would cover the buttons)', () => {
    render(<TicketActionDialog mode="reopen" ticket={OPEN} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });

  it('still autofocuses it on a desktop', () => {
    setPhone(false);
    render(<TicketActionDialog mode="reopen" ticket={OPEN} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });

  it('gives the rating stars 44px targets', () => {
    render(<TicketActionDialog mode="confirm" ticket={{ ...OPEN, status: 'resolved' }} onSubmit={vi.fn()} onClose={vi.fn()} />);
    const star = screen.getByRole('button', { name: '3 stars' });
    expect(star.style.minHeight).toBe('44px');
    expect(star.style.minWidth).toBe('44px');
  });
});

describe('TicketDrawer on a desktop is unchanged', () => {
  it('keeps Delete leading the footer row and the tabs wrapping', () => {
    setPhone(false);
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Delete/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull();
    const strip = screen.getByRole('button', { name: /Overview/ }).parentElement;
    expect(strip.className).toBe('');
    expect(strip.style.flexWrap).toBe('wrap');
    expect(within(document.body).getByRole('button', { name: 'Done' }).style.width).toBe('');
    expect(document.querySelector('a[target="_blank"] img')).toBeTruthy();
  });
});
