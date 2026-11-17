import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { Modal, DateField, ProjectAccessButton } from './components';

// The calendar and the Share dialog's role menu (11/17/2026):
//   - Escape closes the popover alone, not the sheet around it (it used to
//     close both, or ask to discard the form with the calendar still open);
//   - Today is offered only when today is inside min AND max;
//   - the role menu closes on a click of its own trigger;
//   - the calendar works from the keyboard.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('./TasksContext', () => ({ useTasks: () => ({ updateProject: vi.fn(), updateTeam: vi.fn(), statusMeta: {} }) }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Inside the calendar only: the date box itself is a button named by its date.
const cal = () => document.querySelector('[data-nx-calendar]');
const days = () => (cal() ? within(cal()).queryAllByRole('button', { name: /^\d{2}\/\d{2}\/\d{4}$/ }) : []);
const day = (us) => within(cal()).getByRole('button', { name: us });
// A real key press starts at the element in focus; the window hears it on the way down.
const press = (key, el = document.activeElement || document.body) => act(async () => { fireEvent.keyDown(el, { key }); });
const freeze = (y, m, d) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(y, m - 1, d, 10, 0)); };

function Sheet({ onClose, children }) {
  const [open, setOpen] = useState(true);
  return open ? <Modal title="New Task" onClose={() => { setOpen(false); onClose(); }}>{children}</Modal> : null;
}

describe('Escape with a calendar open in a sheet', () => {
  it('closes the calendar and leaves the sheet; the next Escape closes the sheet', async () => {
    const onClose = vi.fn();
    render(<Sheet onClose={onClose}><DateField value="2026-11-10" onChange={() => {}} /></Sheet>);
    fireEvent.click(screen.getByText('11/10/2026'));
    expect(days().length).toBeGreaterThan(0);
    await press('Escape', document.body);
    expect(days()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await press('Escape', document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a calendar opened from a calendar closes first', async () => {
    render(<>
      <DateField value="2026-11-10" onChange={() => {}} />
      <DateField value="2026-12-24" onChange={() => {}} />
    </>);
    fireEvent.click(screen.getByText('11/10/2026'));
    // mousedown inside a calendar never closes another one, so both stay up
    fireEvent.click(screen.getByText('12/24/2026'));
    expect(document.querySelectorAll('[data-nx-calendar]')).toHaveLength(2);
    await press('Escape', document.body);
    expect(document.querySelectorAll('[data-nx-calendar]')).toHaveLength(1);
    expect(day('11/10/2026')).toBeTruthy();
  });
});

describe('the calendar Today button', () => {
  it('is not offered when today is after max', () => {
    freeze(2026, 11, 17);
    render(<DateField value="2026-10-20" onChange={() => {}} max="2026-10-31" />);
    fireEvent.click(screen.getByText('10/20/2026'));
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('is offered when today is the last day allowed, and picks it', () => {
    freeze(2026, 11, 17);
    const onChange = vi.fn();
    render(<DateField value="2026-11-03" onChange={onChange} max="2026-11-17" />);
    fireEvent.click(screen.getByText('11/03/2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledWith('2026-11-17');
  });

  it('is still left out before min', () => {
    freeze(2026, 11, 17);
    render(<DateField value="" onChange={() => {}} min="2026-11-20" placeholder="Pick a date" />);
    fireEvent.click(screen.getByText('Pick a date'));
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });
});

describe('the calendar from the keyboard', () => {
  const openByKey = (label) => {
    const box = screen.getByText(label).closest('button');
    box.focus();
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(box);          // what Enter does to a button
    return box;
  };

  it('opens onto the selected day; arrows move by day and week, Page Down by month', async () => {
    render(<DateField value="2026-11-10" onChange={() => {}} />);
    openByKey('11/10/2026');
    expect(document.activeElement).toBe(day('11/10/2026'));
    await press('ArrowRight');
    expect(document.activeElement).toBe(day('11/11/2026'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(day('11/18/2026'));
    await press('ArrowLeft');
    await press('ArrowUp');
    expect(document.activeElement).toBe(day('11/10/2026'));
    await press('PageDown');
    expect(document.activeElement).toBe(day('12/10/2026'));
    expect(screen.getByTitle('Pick a month').textContent).toBe('December');
    await press('PageUp');
    await press('PageUp');
    expect(document.activeElement).toBe(day('10/10/2026'));
  });

  it('Page Down from the 31st lands on the last day of a shorter month', async () => {
    render(<DateField value="2027-01-31" onChange={() => {}} />);
    openByKey('01/31/2027');
    await press('PageDown');
    expect(document.activeElement).toBe(day('02/28/2027'));
  });

  it('never moves past min or max', async () => {
    render(<DateField value="2026-11-10" onChange={() => {}} min="2026-11-09" max="2026-11-12" />);
    openByKey('11/10/2026');
    await press('ArrowUp');
    expect(document.activeElement).toBe(day('11/09/2026'));
    await press('ArrowLeft');
    expect(document.activeElement).toBe(day('11/09/2026'));
    await press('PageDown');
    expect(document.activeElement).toBe(day('11/12/2026'));
  });

  it('with no date, opens onto today', () => {
    freeze(2026, 11, 17);
    render(<DateField value="" onChange={() => {}} placeholder="Pick a date" />);
    openByKey('Pick a date');
    expect(document.activeElement).toBe(day('11/17/2026'));
  });

  it('Enter picks the day and focus goes back to the date box', async () => {
    const onChange = vi.fn();
    render(<DateField value="2026-11-10" onChange={onChange} />);
    const box = openByKey('11/10/2026');
    await press('ArrowRight');
    const target = document.activeElement;
    fireEvent.keyDown(target, { key: 'Enter' });
    fireEvent.click(target);       // detail 0: a click with no press behind it
    expect(onChange).toHaveBeenCalledWith('2026-11-11');
    expect(days()).toHaveLength(0);
    expect(document.activeElement).toBe(box);
  });

  it('Escape closes it and focus goes back to the date box', async () => {
    render(<DateField value="2026-11-10" onChange={() => {}} />);
    const box = openByKey('11/10/2026');
    await press('Escape');
    expect(days()).toHaveLength(0);
    expect(document.activeElement).toBe(box);
  });

  it('Tab stays inside the calendar', async () => {
    render(<DateField value="2026-11-10" onChange={() => {}} />);
    openByKey('11/10/2026');
    const today = screen.queryByRole('button', { name: 'Today' }) || screen.getByRole('button', { name: 'Clear' });
    today.focus();
    await press('Tab');
    expect(document.activeElement).toBe(screen.getByTitle('Pick a month'));
    expect(days().length).toBeGreaterThan(0);
  });

  it('a mouse click on the box leaves focus where it was', () => {
    render(<DateField value="2026-11-10" onChange={() => {}} />);
    const box = screen.getByText('11/10/2026').closest('button');
    box.focus();
    fireEvent.pointerDown(box);
    fireEvent.click(box, { detail: 1 });
    expect(days().length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(box);
  });
});

describe('the Share dialog role menu', () => {
  const project = { id: 'p1', name: 'Roof', ownerId: 'neil@x.com', memberIds: ['sam@x.com'], memberRoles: { 'sam@x.com': 'editor' } };
  const people = [{ email: 'neil@x.com', name: 'Neil Shah' }, { email: 'sam@x.com', name: 'Sam Lee' }];
  const openShare = () => {
    render(<ProjectAccessButton project={project} teams={[]} people={people} />);
    fireEvent.click(screen.getByTitle('Share - manage who has access'));
    return screen.getAllByRole('button', { name: 'Editor' })[0];
  };
  const menuOpen = () => !!screen.queryByText('Can change settings, modify, or delete the project.');

  it('closes on a click of its own trigger', () => {
    const trigger = openShare();
    fireEvent.mouseDown(trigger); fireEvent.click(trigger);
    expect(menuOpen()).toBe(true);
    fireEvent.mouseDown(trigger); fireEvent.click(trigger);
    expect(menuOpen()).toBe(false);
  });

  it('Escape closes the menu and leaves the Share dialog open', async () => {
    const trigger = openShare();
    fireEvent.click(trigger);
    expect(menuOpen()).toBe(true);
    await press('Escape', document.body);
    expect(menuOpen()).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });
});
