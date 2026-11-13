// Type it the way you say it (11/13/2026): a task name box reads the sentence
// Say It reads, shows what it understood as chips before Enter, and applies
// only the chips still standing. Today is pinned to Thursday 10/29/2026, as
// in sayTask.test.js.
import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';
import { readTypedTask, useTypedTask, chipLabel, chipSpoken, understoodText } from './useTypedTask';
import TypedTaskChips from './TypedTaskChips';

const TODAY = '2026-10-29';   // a Thursday
const ME = 'neil@greensglobal.com';
const BOB = 'bob@greensglobal.com';
const people = [
  { email: BOB, name: 'Bob Brown' },
  { email: 'alice@greensglobal.com', name: 'Alice Wong' },
  { email: 'sam.lee@greensglobal.com', name: 'Sam Lee' },
  { email: 'sam.ortiz@greensglobal.com', name: 'Sam Ortiz' },
];
const read = (text, extra = {}) => readTypedTask(text, { people, myEmail: ME, today: TODAY, ...extra });
const SENTENCE = 'Call the HVAC vendor about the leak Friday, high priority, for Bob';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(2026, 9, 29, 12));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('readTypedTask', () => {
  it('reads the name, due date, priority and assignee from one typed sentence', () => {
    const r = read(SENTENCE);
    expect(r.title).toBe('Call the HVAC vendor about the leak');
    expect(r).toMatchObject({ dueOn: '2026-10-30', priority: 'high', assigneeIds: [BOB] });
    expect(r.chips.map((c) => c.kind)).toEqual(['date', 'priority', 'assignee']);
  });

  it('a plain name is exactly what was typed - no capital added, no opener dropped', () => {
    expect(read('  order more gloves for the crew.  ')).toEqual({ title: 'order more gloves for the crew.', dueOn: '', priority: '', assigneeIds: [], chips: [] });
    expect(read('remind me to call the bank').title).toBe('remind me to call the bank');
    expect(read('')).toEqual({ title: '', dueOn: '', priority: '', assigneeIds: [], chips: [] });
  });

  it('keeps the first letter as typed when a chip is read, and still drops a spoken opener', () => {
    expect(read('iPad case for Bob').title).toBe('iPad case');
    expect(read('remind me to renew the permit tomorrow').title).toBe('Renew the permit');
  });

  it('keeps the parser\'s rules: a name in the middle, two people called Sam, a date already gone', () => {
    expect(read('Draft the Monday meeting agenda').chips).toEqual([]);
    expect(read('Order filters for Sam').chips).toEqual([]);
    expect(read('Pay the invoice March 2').chips).toEqual([]);
    expect(read('Send the report to Bob').chips).toEqual([]);
  });

  it('a sentence that is all date is a name, and a list is never read', () => {
    expect(read('tomorrow')).toMatchObject({ title: 'tomorrow', dueOn: '', chips: [] });
    expect(read('Call the bank tomorrow\nFile the receipts Friday')).toMatchObject({ dueOn: '', chips: [] });
  });

  it('an ignored kind stays in the name', () => {
    const r = read(SENTENCE, { ignore: ['date'] });
    expect(r.title).toBe('Call the HVAC vendor about the leak Friday');
    expect(r).toMatchObject({ dueOn: '', priority: 'high', assigneeIds: [BOB] });
  });

  it('labels: what a chip shows and what its Remove button says', () => {
    const [date, priority, who] = read(SENTENCE).chips;
    const ctx = { people, myEmail: ME };
    expect(chipLabel(date, ctx)).toBe('Fri 10/30/2026');
    expect(chipLabel(priority, ctx)).toBe('High');
    expect(chipLabel(who, ctx)).toBe('Bob Brown');
    expect(chipSpoken(date, ctx)).toBe('due date Friday 10/30/2026');
    expect(chipLabel(read('File the report, assign it to me').chips[0], ctx)).toBe('You');
    expect(understoodText(read(SENTENCE).chips, ctx)).toBe('Understood: due date Friday 10/30/2026, priority High, assignee Bob Brown.');
    expect(understoodText([], ctx)).toBe('');
  });
});

// A name box wired the way the real ones are: Enter creates with what the
// hook holds in that render, then the box empties.
function Box({ onCreate, kinds, locked }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const typed = useTypedTask(text, { people, myEmail: ME, kinds, locked });
  return (
    <div>
      <input ref={ref} aria-label="Task Name" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          onCreate({ title: typed.title, dueOn: typed.dueOn, priority: typed.priority, assigneeIds: typed.assigneeIds });
          setText('');
        }} />
      <TypedTaskChips typed={typed} people={people} myEmail={ME} inputRef={ref} />
    </div>
  );
}
const box = () => screen.getByRole('textbox', { name: 'Task Name' });
const type = (v) => fireEvent.change(box(), { target: { value: v } });
const chips = () => screen.queryByRole('group', { name: 'Understood From the Task Name' });
const chipTexts = () => (chips() ? [...chips().querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : []);

describe('a task name box', () => {
  it('shows what it understood as chips before Enter, and Enter applies them', () => {
    const onCreate = vi.fn();
    render(<Box onCreate={onCreate} />);
    type(SENTENCE);
    expect(within(chips()).getByText('Fri 10/30/2026')).toBeTruthy();
    expect(within(chips()).getByText('High')).toBeTruthy();
    expect(within(chips()).getByText('Bob Brown')).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();           // nothing until Enter
    expect(box().value).toBe(SENTENCE);                 // the box keeps what was typed
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({ title: 'Call the HVAC vendor about the leak', dueOn: '2026-10-30', priority: 'high', assigneeIds: [BOB] });
    expect(chips()).toBeNull();
  });

  it('a removed chip puts its words back in the name and does not come back for this entry', () => {
    const onCreate = vi.fn();
    render(<Box onCreate={onCreate} />);
    type(SENTENCE);
    expect(chipTexts()).toEqual(['Remove due date Friday 10/30/2026', 'Remove priority High', 'Remove assignee Bob Brown']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove due date Friday 10/30/2026' }));
    expect(chipTexts()).toEqual(['Remove priority High', 'Remove assignee Bob Brown']);
    expect(document.activeElement).toBe(box());         // the cursor is back in the name
    // More typing, another date word: still not read.
    type(`${SENTENCE}, due tomorrow`);
    expect(chipTexts()).toEqual(['Remove priority High', 'Remove assignee Bob Brown']);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({ title: 'Call the HVAC vendor about the leak Friday, due tomorrow', dueOn: '', priority: 'high', assigneeIds: [BOB] });
    // The next entry reads dates again.
    type('Pay the invoice tomorrow');
    expect(chipTexts()).toEqual(['Remove due date Friday 10/30/2026']);
  });

  it('Enter applies only the chips still standing', () => {
    const onCreate = vi.fn();
    render(<Box onCreate={onCreate} />);
    type(SENTENCE);
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignee Bob Brown' }));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({ title: 'Call the HVAC vendor about the leak, high priority, for Bob', dueOn: '2026-10-30', priority: '', assigneeIds: [] });
  });

  it('nothing understood: no chips, and the name is created as typed', () => {
    const onCreate = vi.fn();
    render(<Box onCreate={onCreate} />);
    type('order more gloves for the crew');
    expect(chips()).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({ title: 'order more gloves for the crew', dueOn: '', priority: '', assigneeIds: [] });
  });

  it('reads only the kinds the box takes, and never a field the person set', () => {
    const onCreate = vi.fn();
    const { rerender } = render(<Box onCreate={onCreate} kinds={['date', 'priority']} />);
    type(SENTENCE);
    expect(chipTexts()).toEqual(['Remove due date Friday 10/30/2026', 'Remove priority High']);
    rerender(<Box onCreate={onCreate} locked={{ date: true }} />);
    expect(chipTexts()).toEqual(['Remove priority High', 'Remove assignee Bob Brown']);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith({ title: 'Call the HVAC vendor about the leak Friday', dueOn: '', priority: 'high', assigneeIds: [BOB] });
  });

  it('tells a screen reader what was understood once the typing pauses, not on every key', () => {
    render(<Box onCreate={() => {}} />);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    type('Call the vendor tomorrow');
    act(() => { vi.advanceTimersByTime(300); });
    type('Call the vendor tomorrow, high priority');
    act(() => { vi.advanceTimersByTime(300); });
    expect(live.textContent).toBe('');                  // still typing
    act(() => { vi.advanceTimersByTime(500); });
    expect(live.textContent).toBe('Understood: due date Friday 10/30/2026, priority High.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove priority High' }));
    act(() => { vi.advanceTimersByTime(800); });
    expect(live.textContent).toBe('Understood: due date Friday 10/30/2026.');
  });

  it('a chip\'s X is a real button a keyboard reaches, and says where its words came from', () => {
    render(<Box onCreate={() => {}} />);
    type(SENTENCE);
    const x = screen.getByRole('button', { name: 'Remove assignee Bob Brown' });
    expect(x.tagName).toBe('BUTTON');
    expect(x.getAttribute('tabindex')).toBeNull();
    expect(x.parentElement.getAttribute('title')).toBe('Read from "for Bob"');
  });
});
