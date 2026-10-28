import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Add Time From Record (Neil, Oct 27 2026; was Duplicate Day): HR lays one
// day over a range, then every day is its own row - times, breaks, type, Off,
// Skip, Replace. Check is the server's dry run (a refused row says why), the
// save sends exactly what was checked, one Undo takes the batch back, and the
// record itself can be pasted (Ctrl+V).

const apiMock = vi.hoisted(() => ({
  timeRecordDays: vi.fn(), timeDuplicateDay: vi.fn(), timeDuplicateDayUndo: vi.fn(), timeRecordSourceDoc: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));

import AddTimeFromRecordModal from './AddTimeFromRecordModal';
import { dupPlanText, dupTemplateText, periodDays, rowMinutes, creditOf, rowFromShifts, defaultPicks, recordRows, recordOf, leaveTypeOf } from '../lib/duplicateDay';
import { t12 } from '../lib/addTime';
import { utcToInputTz, inputToUtcTz } from '../lib/displayTz';

const day = (date, extra = {}) => ({ date, state: 'empty', workedMin: 0, locked: '', shift: null, usual: null, timeOff: '', holiday: '',
  shifts: [], pendingFix: false, working: true, leftOut: '', future: false, india: false, ...extra });
const MON_SHIFT = [{ wellFormed: true, punches: [
  { kind: 'in', at: '2026-10-05T15:30:00', category: 'Operations' }, { kind: 'break_start', at: '2026-10-05T19:00:00', category: '' },
  { kind: 'break_end', at: '2026-10-05T19:30:00', category: '' }, { kind: 'out', at: '2026-10-06T00:30:00', category: '' }] }];
const DAYS = [
  day('2026-10-05', { state: 'has_time', workedMin: 510, shifts: MON_SHIFT }),
  day('2026-10-06'),
  day('2026-10-07', { locked: 'This pay period is finalized and locked.' }),
  day('2026-10-08'),
  day('2026-10-09', { working: false, holiday: 'Founders Day', leftOut: 'Holiday - Founders Day.' }),
  day('2026-10-10', { working: false }),
  day('2026-10-11', { working: false, future: true }),
];
const judged = (body) => (body.rows || []).map((r) => (r.date === '2026-10-08'
  ? { date: r.date, action: 'skip', reason: 'It overlaps a shift already there (9:00 PM - 11:00 PM).', minutes: 0, existingMin: 0, replaces: 0, workedMin: 0 }
  : { date: r.date, action: r.kind === 'off' ? (r.replace ? 'clear' : 'off') : r.replace ? 'replace' : 'add', reason: '', minutes: 480, existingMin: r.replace ? 510 : 0, replaces: r.replace ? 4 : 0, workedMin: 480 }));

beforeEach(() => {
  apiMock.timeRecordDays.mockReset().mockResolvedValue({ email: 'dean@greensglobal.com', name: 'Dean Test', days: DAYS, india: null });
  apiMock.timeDuplicateDay.mockReset().mockImplementation((body) => {
    const days = judged(body);
    const doing = days.filter((d) => d.action !== 'skip' && d.action !== 'off');
    return Promise.resolve({ dryRun: body.dry_run, batchId: body.dry_run ? '' : 'dup-1', days, added: doing.length, replaced: 0, cleared: 0, totalMin: 480 * doing.length });
  });
  apiMock.timeDuplicateDayUndo.mockReset().mockResolvedValue({ voided: 4, restored: 0 });
  apiMock.timeRecordSourceDoc.mockReset().mockResolvedValue({ path: 'time-records/dean@greensglobal.com/u-sheet.png', name: 'sheet.png' });
});

const open = (props = {}) => render(
  <AddTimeFromRecordModal email="dean@greensglobal.com" start="2026-10-05" end="2026-10-11" onClose={vi.fn()} onDone={vi.fn()} toastOk={vi.fn()} toastErr={vi.fn()} {...props} />,
);
const rowEl = (ds) => document.querySelector(`[data-rec-day="${ds}"]`);
const box = (ds) => rowEl(ds).querySelector('input[type="checkbox"]');
const reason = () => screen.getByPlaceholderText(/the employee reads it on every day/);

describe('Add Time From Record words and arithmetic', () => {
  it('say what a row does and add its hours up', () => {
    expect(dupPlanText({ action: 'add', minutes: 510 })).toBe('Add 8h 30m');
    expect(dupPlanText({ action: 'replace', minutes: 510, existingMin: 240 })).toBe('Replace 4h 00m with 8h 30m');
    expect(dupPlanText({ action: 'clear', existingMin: 240 })).toBe('Clear 4h 00m - Off');
    expect(dupPlanText({ action: 'skip', reason: 'Holiday - Founders Day.' })).toBe('Skipped - Holiday - Founders Day.');
    expect(dupTemplateText([{ in: '22:00', out: '06:00 +1', breaks: [], category: '' }], t12)).toBe('Copying 10:00p - 6:00a (next day)');
    expect(periodDays('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(rowMinutes({ type: 'Work', in: '08:30', out: '17:00', breaks: [{ start: '12:00', end: '12:30' }] })).toBe(480);
    expect(rowMinutes({ type: 'Work', in: '22:00', out: '06:00', breaks: [{ start: '02:00', end: '02:30' }] })).toBe(450);
    expect(rowMinutes({ type: 'Sick Day', in: '09:00', out: '17:00', breaks: [{ start: '12:00', end: '12:30' }] })).toBe(480);
    expect(rowMinutes({ type: 'Off', in: '09:00', out: '17:00' })).toBe(0);
    expect(rowMinutes({ type: 'Work', in: '08:30', out: '', breaks: [] })).toBe(0);   // a cleared box is not midnight
    expect(['Sick', 'PTO', 'Annual Leave', 'Personal time', 'Operations'].map(leaveTypeOf)).toEqual(['Sick Day', 'Vacation', 'Vacation', 'Personal', '']);
    const cfg = { fullMin: 480, halfMin: 240 };
    expect([creditOf({ type: 'Work', in: '09:00', out: '17:00', breaks: [] }, cfg), creditOf({ type: 'Work', in: '09:00', out: '13:30', breaks: [] }, cfg),
      creditOf({ type: 'Work', in: '09:00', out: '12:00', breaks: [] }, cfg), creditOf({ type: 'Vacation' }, cfg), creditOf({ type: 'Work' }, null)])
      .toEqual(['Full', 'Half', 'None', 'Paid Leave', '']);
    // A copied day: the first in to the last out, its break kept, its job type kept.
    const local = (at) => utcToInputTz(at);
    const tpl = rowFromShifts(MON_SHIFT, local);
    expect(tpl).toMatchObject({ type: 'Work', category: 'Operations', in: local(MON_SHIFT[0].punches[0].at).slice(11, 16) });
    expect(tpl.breaks).toHaveLength(1);
    // All Working Days skips punched, locked, future and non-working days; Pick Days starts empty.
    expect([...defaultPicks(DAYS, 'working')]).toEqual(['2026-10-06', '2026-10-08']);
    expect([...defaultPicks(DAYS, 'all')]).toEqual(['2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(defaultPicks(DAYS, 'days').size).toBe(0);
    // An overnight row's clock-out lands on the next day.
    const [r] = recordRows(['2026-10-06'], () => ({ type: 'Work', in: '22:00', out: '06:00', breaks: [] }), () => false, (w) => w, () => 420);
    expect(r).toMatchObject({ date: '2026-10-06', kind: 'work', in_at: '2026-10-06T22:00', out_at: '2026-10-07T06:00', replace: false, tz_offset_min: 420 });
    // The card's tag: one per batch, from the punch meta.
    expect(recordOf([{ inId: 'a', outId: 'b', breaks: [] }], { a: { entrySource: 'hr_record', batchId: 'dup-1', recordReason: 'Paper' }, b: { entrySource: 'hr_record', batchId: 'dup-1', recordReason: 'Paper' } }))
      .toEqual([{ batchId: 'dup-1', reason: 'Paper' }]);
  });
});

describe('AddTimeFromRecordModal', () => {
  it('renders the grid with each day gated', async () => {
    open();
    expect(await screen.findByText('Add Time From Record for Dean Test')).toBeTruthy();
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    expect(apiMock.timeRecordDays).toHaveBeenCalledWith('dean@greensglobal.com', '2026-10-05', '2026-10-11');
    expect(box('2026-10-06').checked).toBe(true);
    expect(box('2026-10-08').checked).toBe(true);
    expect(box('2026-10-05').checked).toBe(false);   // has punches - Skip until picked
    expect(rowEl('2026-10-05').textContent).toMatch(/Has 8h 30m/);
    expect(box('2026-10-07').disabled).toBe(true);
    expect(rowEl('2026-10-07').textContent).toMatch(/Unlock The Period First/);
    expect(box('2026-10-11').disabled).toBe(true);
    expect(rowEl('2026-10-11').textContent).toMatch(/Not Yet/);
    expect(rowEl('2026-10-09').textContent).toMatch(/Founders Day/);
    expect(screen.getByRole('button', { name: 'Check 2 Days' })).toBeTruthy();
  });

  it('edits rows on their own, checks, shows refusals, saves exactly that and undoes it', async () => {
    const onDone = vi.fn();
    open({ onDone });
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    // Tuesday becomes a Sick Day; Thursday ends at 2:00 PM; Monday (punched) is picked to replace; Saturday is Off.
    fireEvent.change(screen.getByLabelText('Type for Tue 10/06/2026'), { target: { value: 'Sick Day' } });
    fireEvent.change(screen.getByLabelText('Clock out for Thu 10/08/2026'), { target: { value: '14:00' } });
    fireEvent.click(box('2026-10-05'));
    expect(rowEl('2026-10-05').textContent).toMatch(/Replaces 8h 30m/);
    fireEvent.click(box('2026-10-10'));
    fireEvent.change(screen.getByLabelText('Type for Sat 10/10/2026'), { target: { value: 'Off' } });
    fireEvent.change(reason(), { target: { value: 'Paper time sheet for October' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check 4 Days' }));
    await waitFor(() => expect(apiMock.timeDuplicateDay).toHaveBeenCalled());
    const dry = apiMock.timeDuplicateDay.mock.calls[0][0];
    expect(dry).toMatchObject({ employee_email: 'dean@greensglobal.com', dry_run: true, start: '2026-10-05', end: '2026-10-11', reason: 'Paper time sheet for October' });
    const by = Object.fromEntries(dry.rows.map((r) => [r.date, r]));
    expect(Object.keys(by).sort()).toEqual(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-10']);
    expect(by['2026-10-06']).toMatchObject({ kind: 'work', category: 'Sick Day', breaks: [], replace: false });
    expect(by['2026-10-05'].replace).toBe(true);
    expect(by['2026-10-10']).toMatchObject({ kind: 'off', replace: false });
    expect(by['2026-10-08'].out_at).toBe(inputToUtcTz('2026-10-08T14:00'));
    expect(by['2026-10-08'].in_at).toBe(inputToUtcTz('2026-10-08T08:30'));
    // The server's refusal shows on its row.
    expect(await screen.findByText(/It overlaps a shift already there/)).toBeTruthy();
    expect(rowEl('2026-10-08').querySelector('[data-rec-status="skip"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save 2 Days/ }));
    await waitFor(() => expect(apiMock.timeDuplicateDay).toHaveBeenCalledTimes(2));
    expect({ ...apiMock.timeDuplicateDay.mock.calls[1][0], dry_run: true }).toEqual(dry);
    expect(await screen.findByText(/Saved 2 days/)).toBeTruthy();
    expect(onDone).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(apiMock.timeDuplicateDayUndo).toHaveBeenCalledWith('dup-1'));
  });

  it('needs a reason before anything is sent, and an edit after a check asks again', async () => {
    open();
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check 2 Days' }));
    expect(await screen.findByText(/Say why this time is being added/)).toBeTruthy();
    expect(apiMock.timeDuplicateDay).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: 'Paper time sheet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check 2 Days' }));
    await screen.findByRole('button', { name: /Save/ });
    fireEvent.change(screen.getByLabelText('Clock in for Tue 10/06/2026'), { target: { value: '09:00' } });
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check 2 Days' })).toBeTruthy();
  });

  it('Pick Days starts empty and a ticked day takes the template', async () => {
    open();
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: 'Pick Days' }));
    expect(box('2026-10-06').checked).toBe(false);
    fireEvent.click(box('2026-10-10'));
    expect(screen.getByLabelText('Clock in for Sat 10/10/2026').value).toBe('08:30');
    expect(screen.getByRole('button', { name: 'Check 1 Day' })).toBeTruthy();
  });

  it('shows the India contractor credit live from the hours', async () => {
    apiMock.timeRecordDays.mockResolvedValue({ name: 'Ira Test', india: { fullMin: 480, halfMin: 240 },
      days: [day('2026-10-05', { india: true }), day('2026-10-06', { india: true })] });
    open({ end: '2026-10-06' });
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    const credit = (ds) => rowEl(ds).querySelector('[data-rec-credit]').textContent;
    expect(credit('2026-10-05')).toBe('Full');   // 8:30a - 5:00p less 30 min = 8h
    fireEvent.change(screen.getByLabelText('Clock out for Mon 10/05/2026'), { target: { value: '14:00' } });
    expect(credit('2026-10-05')).toBe('Half');
    fireEvent.change(screen.getByLabelText('Clock out for Mon 10/05/2026'), { target: { value: '11:00' } });
    expect(credit('2026-10-05')).toBe('None');
    fireEvent.change(screen.getByLabelText('Type for Tue 10/06/2026'), { target: { value: 'Vacation' } });
    expect(credit('2026-10-06')).toBe('Paid Leave');
  });

  it('takes the source document from Ctrl+V and sends it with the batch', async () => {
    open();
    await waitFor(() => expect(rowEl('2026-10-06')).toBeTruthy());
    const file = new File(['png'], 'sheet.png', { type: 'image/png' });
    expect(document.querySelector('[data-source-doc]').textContent).toMatch(/or press Ctrl\+V to paste a picture/);
    fireEvent.paste(document.querySelector('[data-source-doc]'), { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    await waitFor(() => expect(apiMock.timeRecordSourceDoc).toHaveBeenCalledWith('dean@greensglobal.com', file));
    expect(apiMock.timeRecordSourceDoc).toHaveBeenCalledTimes(1);
    expect((await screen.findByText('sheet.png')).hasAttribute('data-doc-name')).toBe(true);
    fireEvent.change(reason(), { target: { value: 'Paper time sheet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check 2 Days' }));
    await waitFor(() => expect(apiMock.timeDuplicateDay).toHaveBeenCalled());
    expect(apiMock.timeDuplicateDay.mock.calls[0][0]).toMatchObject({ source_doc_path: 'time-records/dean@greensglobal.com/u-sheet.png', source_doc_name: 'sheet.png' });
  });
});
