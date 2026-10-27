import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Duplicate Day (Neil, Oct 27 2026): HR copies one day onto others. The
// preview is the server's dry run, the write sends exactly what was
// previewed, Replace Existing is opt-in, and Undo takes the batch back.

const apiMock = vi.hoisted(() => ({ timeAddTimeDays: vi.fn(), timeDuplicateDay: vi.fn(), timeDuplicateDayUndo: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import DuplicateDayModal from './DuplicateDayModal';
import { dupPlanText, dupTemplateText, periodDays } from '../lib/duplicateDay';
import { t12 } from '../lib/addTime';

const DAYS = [
  { date: '2026-10-05', state: 'has_time', workedMin: 510, locked: '', shift: null, usual: null, timeOff: '', holiday: '' },
  { date: '2026-10-06', state: 'empty', workedMin: 0, locked: '', shift: null, usual: null, timeOff: '', holiday: '' },
  { date: '2026-10-07', state: 'has_time', workedMin: 240, locked: '', shift: null, usual: null, timeOff: '', holiday: '' },
  { date: '2026-10-08', state: 'empty', workedMin: 0, locked: 'This pay period is finalized and locked.', shift: null, usual: null, timeOff: '', holiday: '' },
];
const PLAN = (dry) => ({
  dryRun: dry, batchId: dry ? '' : 'dup-1', added: 2, replaced: 1, totalMin: 1020, source: '2026-10-05',
  template: [{ in: '08:30', out: '17:30', breaks: [['12:00', '12:30']], category: 'Operations', minutes: 510 }],
  days: [
    { date: '2026-10-06', action: 'add', minutes: 510, existingMin: 0, replaces: 0, reason: '' },
    { date: '2026-10-07', action: 'replace', minutes: 510, existingMin: 240, replaces: 2, reason: '' },
  ],
});

beforeEach(() => {
  apiMock.timeAddTimeDays.mockReset().mockResolvedValue({ email: 'dean@greensglobal.com', name: 'Dean Test', days: DAYS });
  apiMock.timeDuplicateDay.mockReset().mockImplementation((body) => Promise.resolve(PLAN(body.dry_run)));
  apiMock.timeDuplicateDayUndo.mockReset().mockResolvedValue({ voided: 8, restored: 2 });
});

const open = (props = {}) => render(
  <DuplicateDayModal email="dean@greensglobal.com" start="2026-10-05" end="2026-10-08" onClose={vi.fn()} onDone={vi.fn()} toastOk={vi.fn()} toastErr={vi.fn()} {...props} />,
);
const box = (ds) => document.querySelector(`[data-day="${ds}"] input[type="checkbox"]`);

describe('duplicateDay words', () => {
  it('say what a row does and what is copied', () => {
    expect(dupPlanText({ action: 'add', minutes: 510 })).toBe('Add 8h 30m');
    expect(dupPlanText({ action: 'replace', minutes: 510, existingMin: 240 })).toBe('Replace 4h 00m with 8h 30m');
    expect(dupPlanText({ action: 'skip', reason: 'Holiday - Founders Day.' })).toBe('Skipped - Holiday - Founders Day.');
    expect(dupTemplateText(PLAN(true).template, t12)).toBe('Copying 8:30a - 5:30p, break 12:00p - 12:30p, Operations');
    expect(dupTemplateText([{ in: '22:00', out: '06:00 +1', breaks: [], category: '' }], t12)).toBe('Copying 10:00p - 6:00a (next day)');
    expect(periodDays('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('DuplicateDayModal', () => {
  it('renders, previews, copies exactly what was previewed and undoes it', async () => {
    const onDone = vi.fn();
    open({ onDone });
    expect(await screen.findByText('Duplicate Day for Dean Test')).toBeTruthy();
    // The source day is the first one with time; it cannot be a target; locked days cannot be picked.
    await waitFor(() => expect(document.querySelector('[data-source-day]').value).toBe('2026-10-05'));
    expect(box('2026-10-05').disabled).toBe(true);
    expect(box('2026-10-08').disabled).toBe(true);
    fireEvent.click(box('2026-10-06'));
    fireEvent.click(box('2026-10-07'));
    fireEvent.click(screen.getByText('Replace Existing'));
    fireEvent.change(screen.getByPlaceholderText(/Why this day is being copied/), { target: { value: 'Paper time sheet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Replace 4h 00m with 8h 30m');
    const dry = apiMock.timeDuplicateDay.mock.calls[0][0];
    expect(dry).toMatchObject({ dry_run: true, source_date: '2026-10-05', mode: 'days', targets: ['2026-10-06', '2026-10-07'], replace: true, reason: 'Paper time sheet' });
    expect(Object.keys(dry.tz_offsets)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
    fireEvent.click(screen.getByRole('button', { name: /Copy Onto 2 Days/ }));
    await screen.findByText(/Copied onto 2 days/);
    expect({ ...apiMock.timeDuplicateDay.mock.calls[1][0], dry_run: true }).toEqual(dry);
    expect(onDone).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(apiMock.timeDuplicateDayUndo).toHaveBeenCalledWith('dup-1'));
  });

  it('fills a day in, with breaks and a type, onto All Working Days', async () => {
    open();
    await screen.findByText('Duplicate Day for Dean Test');
    fireEvent.click(screen.getByRole('radio', { name: 'Fill In A Day' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Sick Day' }));
    fireEvent.click(screen.getByRole('radio', { name: 'All Working Days' }));
    expect(document.querySelector('[data-day-grid]')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Why this day is being copied/), { target: { value: 'Paper time sheet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(apiMock.timeDuplicateDay).toHaveBeenCalled());
    const body = apiMock.timeDuplicateDay.mock.calls[0][0];
    expect(body).toMatchObject({ mode: 'working', targets: [], start: '2026-10-05', end: '2026-10-08', fill_date: '2026-10-05', category: 'Sick Day' });
    expect(body.source_date).toBeUndefined();
    expect(body.breaks).toHaveLength(1);
    expect(body.in_at < body.out_at).toBe(true);
  });

  it('asks for a reason before previewing', async () => {
    open();
    await screen.findByText('Duplicate Day for Dean Test');
    fireEvent.click(box('2026-10-06'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Say why/);
    expect(apiMock.timeDuplicateDay).not.toHaveBeenCalled();
  });
});
