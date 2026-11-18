// One New Task from every door (Neil, 11/15/2026): a computer gets the full
// form as before; a phone gets the composer, its Details opens the full form
// with the draft, and a made task shows "Task Added" with Open and Add Another
// (which keeps the date, people and project - not the priority).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

let PHONE = true;
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => PHONE }));
const openTaskAnywhere = vi.fn();
const flashTaskRow = vi.fn();
vi.mock('./openTask', () => ({ openTaskAnywhere: (...a) => openTaskAnywhere(...a), flashTaskRow: (...a) => flashTaskRow(...a) }));
const quickProps = vi.fn();
vi.mock('./QuickCreateTask', () => ({ default: (p) => {
  quickProps(p);
  return (
    <div data-testid="composer" data-defaults={JSON.stringify(p.defaults)}>
      <button type="button" onClick={() => { p.onCreated({ id: 't1', dueOn: '2099-01-02' }, { dueOn: '2099-01-02', assigneeIds: ['bob@x.com'], projectId: 'p2', priority: 'high' }); p.onClose(); }}>Composer Create</button>
      <button type="button" onClick={() => p.onClose()}>Composer Close</button>
      <button type="button" onClick={() => p.onFullDetails({ title: 'Drafted', projectId: 'p2' })}>Composer Details</button>
      <button type="button" onClick={() => p.onFullDetails({ title: 'Typed here', projectId: 'p2' }, true)}>Composer Details Typed</button>
    </div>
  );
} }));
vi.mock('./CreateTaskModal', () => ({ default: (p) => (
  <div data-testid="full-form" data-defaults={JSON.stringify(p.defaults)} data-locked={p.lockedProjectId} data-start-dirty={String(!!p.startDirty)}>
    <button type="button" onClick={() => { p.onCreated?.({ id: 't2', dueOn: '2099-02-02', assigneeIds: ['me@x.com'], projectId: 'p2', priority: 'low' }); p.onClose(true); }}>Full Create</button>
    <button type="button" onClick={() => p.onClose(false)}>Full Cancel</button>
  </div>
) }));

import TaskCreate from './TaskCreate';

beforeEach(() => { PHONE = true; });
afterEach(() => { cleanup(); vi.useRealTimers(); openTaskAnywhere.mockReset(); flashTaskRow.mockReset(); quickProps.mockReset(); });
const click = async (name) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('TaskCreate', () => {
  it('a computer gets the full form with the same defaults, and no message after', async () => {
    PHONE = false;
    const onClose = vi.fn(); const onCreated = vi.fn();
    const defaults = { projectId: 'p1' };
    render(<TaskCreate defaults={defaults} onClose={onClose} onCreated={onCreated} lockedProjectId="p1" />);
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByTestId('full-form').dataset.locked).toBe('p1');
    await click('Full Create');
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a phone: the composer, then "Task Added" with when it is due; the page closes it when the message goes', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn(); const onCreated = vi.fn();
    render(<TaskCreate defaults={{}} onClose={onClose} onCreated={onCreated} />);
    await click('Composer Create');
    expect(onCreated).toHaveBeenCalledWith({ id: 't1', dueOn: '2099-01-02' });
    expect(flashTaskRow).toHaveBeenCalledWith('t1');
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Task Added.*Due Fri 01\/02\/2099/);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(6100); });
    expect(onClose).toHaveBeenCalled();
  });

  it('Add Another opens a fresh composer that keeps the date, people and project, not the priority', async () => {
    render(<TaskCreate defaults={{ status: 'in_progress' }} onClose={() => {}} />);
    await click('Composer Create');
    await click('Add Another');
    const next = JSON.parse(screen.getByTestId('composer').dataset.defaults);
    expect(next).toEqual({ status: 'in_progress', dueOn: '2099-01-02', assigneeIds: ['bob@x.com'], suggestedProjectId: 'p2' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Open closes it and opens the new task', async () => {
    const onClose = vi.fn();
    render(<TaskCreate defaults={{}} onClose={onClose} />);
    await click('Composer Create');
    await click('Open');
    expect(onClose).toHaveBeenCalled();
    expect(openTaskAnywhere).toHaveBeenCalledWith('t1');
  });

  it('closing the composer with nothing made closes at once', async () => {
    const onClose = vi.fn();
    render(<TaskCreate defaults={{}} onClose={onClose} />);
    await click('Composer Close');
    expect(onClose).toHaveBeenCalled();
  });

  // The full form measured "changed" against a form that already held the
  // composer's words, so closing it threw them away with no question (11/17/2026).
  it('Details with something typed in the composer opens the full form as unsaved work', async () => {
    render(<TaskCreate defaults={{}} onClose={() => {}} />);
    await click('Composer Details Typed');
    expect(screen.getByTestId('full-form').dataset.startDirty).toBe('true');
    expect(JSON.parse(screen.getByTestId('full-form').dataset.defaults)).toMatchObject({ title: 'Typed here' });
  });

  it('Details with nothing typed opens it clean, and a computer never starts unsaved', async () => {
    const { unmount } = render(<TaskCreate defaults={{}} onClose={() => {}} />);
    await click('Composer Details');
    expect(screen.getByTestId('full-form').dataset.startDirty).toBe('false');
    unmount();
    PHONE = false;
    render(<TaskCreate defaults={{ title: 'Seeded' }} onClose={() => {}} />);
    expect(screen.getByTestId('full-form').dataset.startDirty).toBe('false');
  });

  it('Details opens the full form with the draft; made there, the message shows too', async () => {
    const onClose = vi.fn();
    render(<TaskCreate defaults={{ assigneeId: 'me@x.com' }} onClose={onClose} lockedProjectId="" />);
    await click('Composer Details');
    expect(JSON.parse(screen.getByTestId('full-form').dataset.defaults)).toMatchObject({ assigneeId: 'me@x.com', title: 'Drafted', projectId: 'p2' });
    await click('Full Create');
    expect(screen.getByRole('status').textContent).toMatch(/Task Added/);
    expect(onClose).not.toHaveBeenCalled();
    await click('Add Another');
    expect(JSON.parse(screen.getByTestId('composer').dataset.defaults)).toMatchObject({ dueOn: '2099-02-02', suggestedProjectId: 'p2' });
  });

  it('a new task started elsewhere (the bolt) ends a message still showing', async () => {
    const firstClose = vi.fn();
    render(<TaskCreate defaults={{}} onClose={firstClose} />);
    await click('Composer Create');
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => { render(<TaskCreate defaults={{}} onClose={() => {}} />); });
    expect(firstClose).toHaveBeenCalled();
  });

  it('the page\'s + tapped while the message shows starts over with what it asked for', async () => {
    const first = {};
    const { rerender } = render(<TaskCreate defaults={first} onClose={() => {}} />);
    // A re-render with the SAME defaults while composing changes nothing.
    rerender(<TaskCreate defaults={first} onClose={() => {}} />);
    await click('Composer Create');
    const again = { projectId: 'p9' };
    rerender(<TaskCreate defaults={again} onClose={() => {}} />);
    expect(JSON.parse(screen.getByTestId('composer').dataset.defaults)).toEqual({ projectId: 'p9' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
