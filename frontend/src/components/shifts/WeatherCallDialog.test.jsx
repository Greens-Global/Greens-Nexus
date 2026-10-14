import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// The Weather Call screen (Weather Call, Oct 2026): everyone is picked by
// default and the decider unchecks who can still work with pay; one
// decision, a reason, texts on by default; Confirm asks once, then posts.
// With a call already made it is the roster of who has acknowledged, with
// a phone number beside anyone still waiting, plus Remind and Reinstate.

const weatherCallScreen = vi.fn();
const weatherCallDecide = vi.fn();
const weatherCallReinstate = vi.fn();
const weatherCallRemind = vi.fn();
const confirmAsk = vi.fn();
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: (...a) => confirmAsk(...a) } }));
vi.mock('../../api', () => ({
  api: {
    weatherCallScreen: (...a) => weatherCallScreen(...a),
    weatherCallDecide: (...a) => weatherCallDecide(...a),
    weatherCallReinstate: (...a) => weatherCallReinstate(...a),
    weatherCallRemind: (...a) => weatherCallRemind(...a),
  },
}));

const { default: WeatherCallDialog } = await import('./WeatherCallDialog');

const DAY = '2026-10-16';
const person = (email, name, over = {}) => ({ email, name, phone: true, smsOn: true, active: true, phoneNumber: '(949) 555-0101',
  shifts: [{ id: `s-${email}`, email, start: '07:00', end: '15:30', label: 'Harbor', weatherStatus: '', originalStart: '', originalEnd: '' }], ...over });
const base = (over = {}) => ({
  group: { id: 'g1', name: 'Yard Crew', workSiteName: 'Harbor View', deciders: [{ email: 'mia@x.com', name: 'Mia X' }] },
  date: DAY,
  outlook: { band: 'major', chance: 85, inches: 0.9, storm: false, alerts: [], windowStart: '7:00 AM', windowEnd: '3:30 PM', updatedAt: '2026-10-15T14:00:00Z',
    hourly: [{ time: `${DAY}T07:00`, chance: 80, inches: 0.1, code: 61 }, { time: `${DAY}T08:00`, chance: 90, inches: 0.2, code: 63 }] },
  roster: [person('ann@x.com', 'Ann X'), person('bob@x.com', 'Bob X', { smsOn: false }), person('cal@x.com', 'Cal X', { phone: false, phoneNumber: '' })],
  decision: null, canDecide: true, smsDefault: true, dayNote: '', companyId: 'ent1',
  ...over,
});
const decided = () => base({ decision: {
  id: 'd1', groupId: 'g1', groupName: 'Yard Crew', date: DAY, kind: 'cancel', outcome: 'cancelled', newStart: '', newEnd: '', moveTo: '', reason: 'Flooded access road',
  sms: true, status: 'active', unpaid: true, decidedBy: 'mia@x.com', decidedByName: 'Mia X', decidedAt: '2026-10-15T15:00:00Z', escalatedAt: '',
  selectedCount: 2, ackedCount: 1, pendingCount: 1, outlook: {},
  people: [
    { email: 'ann@x.com', name: 'Ann X', selected: true, outcome: 'cancelled', ackAt: '2026-10-15T15:10:00Z', ackVia: 'link', remindedAt: '', phoneNumber: '(949) 555-0101', channels: { bell: 'ok', sms: 'ok', email: 'ok', teams: 'ok' } },
    { email: 'cal@x.com', name: 'Cal X', selected: true, outcome: 'cancelled', ackAt: '', ackVia: '', remindedAt: '', phoneNumber: '(949) 555-0103', channels: { bell: 'ok', sms: 'no phone on file', email: 'ok', teams: 'ok' } },
    { email: 'bob@x.com', name: 'Bob X', selected: false, outcome: 'kept', ackAt: '', ackVia: '', remindedAt: '', phoneNumber: '', channels: { bell: 'ok' } },
  ] } });
const toastOk = vi.fn();
const toastErr = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  weatherCallScreen.mockReset().mockResolvedValue(base());
  weatherCallDecide.mockReset().mockResolvedValue({ id: 'd1' });
  weatherCallReinstate.mockReset().mockResolvedValue({ id: 'd1', status: 'reinstated' });
  weatherCallRemind.mockReset().mockResolvedValue({ reminded: 1 });
  confirmAsk.mockReset().mockResolvedValue(true);
  toastOk.mockReset(); toastErr.mockReset(); onChanged.mockReset();
});

// The dialog shell (role=dialog, skeleton inside) is on screen before the
// screen data resolves, so waiting for the role alone raced the mocked fetch
// and lost on a slow CI runner (Oct 13: "Unable to find a label with the text
// of: Delay the Start"). Wait for the loaded title, which only the data draws.
async function openDialog() {
  const dlg = await screen.findByRole('dialog', { name: 'Weather Call' });
  await within(dlg).findByText(/Weather Call - /);
  return dlg;
}

describe('Weather Call dialog', () => {
  it('picks everyone by default, lets the decider uncheck, asks once, then posts the call', async () => {
    render(<WeatherCallDialog groupId="g1" date={DAY} onClose={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />);
    const dlg = await openDialog();
    expect(dlg.textContent).toContain('Weather Call - Yard Crew');
    expect(dlg.textContent).toContain('85% chance · 0.90 in during 7:00 AM - 3:30 PM');
    expect(within(dlg).getByLabelText('Apply to Ann X').checked).toBe(true);
    expect(within(dlg).getByLabelText('Apply to Bob X').checked).toBe(true);
    expect(dlg.textContent).toContain('3 picked · texts to 1 · 1 has no phone on file · 1 turned texts off');
    fireEvent.click(within(dlg).getByLabelText('Apply to Bob X'));                  // Bob can work indoors with pay
    expect(dlg.textContent).toContain('2 picked · texts to 1 · 1 has no phone on file');
    fireEvent.click(within(dlg).getByRole('button', { name: /Make the Call/ }));
    expect(toastErr).toHaveBeenCalledWith('Give the crew a short reason.');            // nothing posted without a reason
    expect(weatherCallDecide).not.toHaveBeenCalled();
    fireEvent.change(within(dlg).getByLabelText('Reason'), { target: { value: 'Flooded access road' } });
    fireEvent.click(within(dlg).getByRole('button', { name: /Make the Call/ }));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledTimes(1));
    expect(confirmAsk.mock.calls[0][0]).toContain('Cancel the Day for 2 of 3 on 10/16/2026? Their day is unpaid.');
    await waitFor(() => expect(weatherCallDecide).toHaveBeenCalledTimes(1));
    expect(weatherCallDecide.mock.calls[0].slice(0, 2)).toEqual(['g1', DAY]);
    expect(weatherCallDecide.mock.calls[0][2]).toMatchObject({ kind: 'cancel', emails: ['ann@x.com', 'cal@x.com'], reason: 'Flooded access road', sms: true });
    expect(onChanged).toHaveBeenCalled();
    expect(toastOk).toHaveBeenCalledWith('Weather call made. The crew is being told.');
  });

  it('a delay carries its time, and a declined confirm posts nothing', async () => {
    confirmAsk.mockResolvedValue(false);
    render(<WeatherCallDialog groupId="g1" date={DAY} onClose={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />);
    const dlg = await openDialog();
    fireEvent.click(within(dlg).getByLabelText('Delay the Start'));
    fireEvent.change(within(dlg).getByLabelText('New start time'), { target: { value: '10:30' } });
    fireEvent.change(within(dlg).getByLabelText('Reason'), { target: { value: 'Rain until mid-morning' } });
    fireEvent.click(within(dlg).getByLabelText('Text the crew'));
    fireEvent.click(within(dlg).getByRole('button', { name: /Make the Call/ }));
    await waitFor(() => expect(confirmAsk).toHaveBeenCalledTimes(1));
    expect(confirmAsk.mock.calls[0][0]).toContain('Delay the Start for 3 of 3');
    expect(confirmAsk.mock.calls[0][0]).not.toContain('including a text');
    expect(weatherCallDecide).not.toHaveBeenCalled();
    confirmAsk.mockResolvedValue(true);
    fireEvent.click(within(dlg).getByRole('button', { name: /Make the Call/ }));
    await waitFor(() => expect(weatherCallDecide).toHaveBeenCalledTimes(1));
    expect(weatherCallDecide.mock.calls[0][2]).toMatchObject({ kind: 'delay', new_start: '10:30', sms: false });
  });

  it('shows who acknowledged, a phone number beside who is waiting, and reinstates', async () => {
    weatherCallScreen.mockResolvedValue(decided());
    render(<WeatherCallDialog groupId="g1" date={DAY} onClose={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />);
    const dlg = await openDialog();
    expect(dlg.textContent).toContain('Day cancelled for weather (unpaid)');
    expect(dlg.textContent).toContain('1 of 2 acknowledged · 1 waiting');
    const ann = dlg.querySelector('[data-ack-row="ann@x.com"]');
    const cal = dlg.querySelector('[data-ack-row="cal@x.com"]');
    const bob = dlg.querySelector('[data-ack-row="bob@x.com"]');
    expect(ann.textContent).not.toContain('(949) 555-0101');       // acknowledged: no need for the number
    expect(cal.textContent).toContain('(949) 555-0103');           // waiting: call them
    expect(cal.textContent).toContain('Waiting');
    expect(cal.textContent).toContain('text: no phone on file');
    expect(bob.textContent).toContain('Shift Stands');
    expect(within(dlg).queryByRole('button', { name: /Make the Call/ })).toBeNull();   // the form is behind "Make Another Call"
    fireEvent.click(within(dlg).getByRole('button', { name: /Remind the Silent/ }));
    await waitFor(() => expect(weatherCallRemind).toHaveBeenCalledWith('d1'));
    expect(toastOk).toHaveBeenCalledWith('Reminded 1 person.');
    fireEvent.click(within(dlg).getByRole('button', { name: /Reinstate/ }));
    await waitFor(() => expect(weatherCallReinstate).toHaveBeenCalledWith('d1'));
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Make Another Call' }));
    expect(within(dlg).getByRole('button', { name: /Make the Call/ })).toBeTruthy();
  });

  it('tells a manager who is not a decider who makes the call', async () => {
    weatherCallScreen.mockResolvedValue(base({ canDecide: false }));
    render(<WeatherCallDialog groupId="g1" date={DAY} onClose={vi.fn()} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />);
    const dlg = await openDialog();
    // The dialog shell renders before the screen data lands: wait for the line.
    await waitFor(() => expect(dlg.textContent).toContain('The weather call for this group is made by Mia X.'));
    expect(within(dlg).queryByRole('button', { name: /Make the Call/ })).toBeNull();
  });
});
