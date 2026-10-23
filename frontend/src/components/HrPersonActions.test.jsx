import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Promote / Change Role (Neil, Oct 8): pick the new role,
// see the change and the signing order, and send only once confirmed.

const preview = {
  title: 'Promotion Letter - Erin Lee', templateName: 'Promotion Letter', egnyteSubfolder: 'Promotion Documents',
  recipients: [{ order: 1, role: 'employee', name: 'Erin Lee', email: 'erin@x.com', who: 'employee' },
               { order: 2, role: 'manager', name: 'Max', email: 'max@x.com', who: 'manager' }],
  fromTitle: 'IT Dev Associate I', toTitle: 'IT Dev Associate II', effectiveDate: '2026-09-01',
  salaryText: '$40.00 per hour', unresolved: [], signedPeriods: [{ label: '09/06/2026 - 09/19/2026' }],
};
const send = vi.fn(() => Promise.resolve({ id: 'ev1' }));
const changeRoleNow = vi.fn(() => Promise.resolve({ employeeId: 'e1', roleName: 'IT Dev Associate II', warning: '' }));
// What They Get (Hiring Setup round 2): the letter this employee's row resolves to, the new role's duties, who signs.
const line = (key, label, name, extra = {}) => ({ key, label, name, sourceLabel: '', tone: 'same', blocks: false, fix: null, ...extra });
const ready = (eid, roleId) => Promise.resolve({
  rowKey: 'employee:US:CA', kind: 'Employees In California', letter: { settingId: 's-ca-promo', name: 'California Promotion Letter', engine: 'pdf' },
  whatTheyGet: [line('letter', 'Promotion Letter', 'California Promotion Letter'), line('signs', 'Signs', 'The Employee, then Their Manager')],
  blocked: '', hrQuestions: [],
  duties: roleId ? { roleId, text: `Duties of ${roleId}`, versionId: roleId === 'jr-2' ? 'dv-1' : '', versionLabel: 'Full-Time Employees - Anywhere', placement: 'page' } : null,
});
const promotionOptions = vi.fn(ready);
const startPromotion = vi.fn(() => Promise.resolve({ id: 'ev2' }));
const previewPromotion = vi.fn(() => Promise.resolve(preview));
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ roles: [{ id: 'jr-2', name: 'IT Dev Associate II', department: 'IT' }, { id: 'jr-3', name: 'IT Lead', department: 'IT' }] }),
    previewPromotion: (...a) => previewPromotion(...a),
    sendPromotion: (...a) => send(...a),
    startPromotion: (...a) => startPromotion(...a),
    promotionOptions: (...a) => promotionOptions(...a),
    changeRoleNow: (...a) => changeRoleNow(...a),
  },
}));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary']] }));
const packetsProps = vi.fn();
vi.mock('./HiringPacket', async (orig) => ({ ...(await orig()), PacketsModal: (props) => {
  packetsProps(props);
  return <div>Hiring Setup Open <button type="button" onClick={props.onClose}>Close Setup</button></div>;
} }));
beforeEach(() => { promotionOptions.mockImplementation(ready); promotionOptions.mockClear(); previewPromotion.mockImplementation(() => Promise.resolve(preview)); });

const { PromoteModal, RoleChangeModal } = await import('./HrPersonActions');
const erin = { id: 'e1', firstName: 'Erin', lastName: 'Lee', company: 'c1', jobTitle: 'IT Dev Associate I' };

describe('PromoteModal', () => {
  it('reviews the letter, flags signed time sheets, and sends once confirmed', async () => {
    const onSent = vi.fn();
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    await waitFor(() => expect(screen.getByLabelText("New Role's Duties").value).toBe('Duties of jr-2'));
    expect(screen.getByText('Review Letter').closest('button')).toBeDisabled();   // the reason is required (Neil, Oct 22)
    fireEvent.change(screen.getByPlaceholderText(/Annual review/), { target: { value: 'Exceeded targets' } });
    fireEvent.click(screen.getByText('Review Letter'));
    await waitFor(() => expect(screen.getByText('Promotion Letter - Erin Lee')).toBeTruthy());
    expect(screen.getByText(/2\. Max \(manager\)/)).toBeTruthy();
    expect(screen.getByText(/09\/06\/2026 - 09\/19\/2026/)).toBeTruthy();
    const btn = screen.getByText('Send For Signature').closest('button');
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(btn);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(send.mock.calls[0][1].inputs.change_type).toBe('promotion');
  });

  it('without pay access asks for the pay as written', () => {
    render(<PromoteModal employee={erin} canSeePay={false} onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByText('Promote - Erin Lee')).toBeTruthy();
    expect(screen.getByPlaceholderText(/unchanged/)).toBeTruthy();
  });

  it('offers any currency, not only USD and INR', () => {
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByRole('option', { name: /^EUR/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^AUD/ })).toBeTruthy();
  });
});

// Change Role (Neil, Oct 22): only HR, IT Admins and Global Admins see it,
// and they change the role directly - never without a reason. In People it
// asks first (Promotion hands over to the letter); Settings > Access passes no
// onPromote and knows the person by work email.
describe('RoleChangeModal', () => {
  it('in People changes the role directly, the reason required', async () => {
    const onChanged = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={() => {}} onChanged={onChanged} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Role Change Without Promotion'));
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    const btn = screen.getByRole('button', { name: /Change Role/ });
    expect(btn).toBeDisabled();                                       // the reason is required
    fireEvent.change(screen.getByPlaceholderText(/Accounting team/), { target: { value: 'Team move' } });
    fireEvent.click(btn);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(changeRoleNow).toHaveBeenCalledWith('e1', { role_id: 'jr-2', reason: 'Team move' });
  });

  it('from Settings changes it directly by work email and offers no promotion', async () => {
    const onChanged = vi.fn();
    render(<RoleChangeModal employee={{ workEmail: 'erin@x.com', firstName: 'Erin', company: 'c1' }} onClose={() => {}} onChanged={onChanged} toastErr={() => {}} />);
    expect(screen.queryByText('Promotion')).toBeNull();
    expect(screen.queryByText(/Approval/)).toBeNull();
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.change(screen.getByPlaceholderText(/Accounting team/), { target: { value: 'Covers month-end' } });
    fireEvent.click(screen.getByRole('button', { name: /Change Role/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(changeRoleNow).toHaveBeenCalledWith('erin@x.com', { role_id: 'jr-2', reason: 'Covers month-end' });
  });

  it('Promotion goes to the promotion letter', () => {
    const onPromote = vi.fn();
    render(<RoleChangeModal employee={erin} onClose={() => {}} onPromote={onPromote} onChanged={() => {}} toastErr={() => {}} />);
    fireEvent.click(screen.getByText('Promotion'));
    expect(onPromote).toHaveBeenCalled();
  });
});

// What They Get on Promote (Hiring Setup round 2).
describe('PromoteModal - What They Get', () => {
  it('a role change fetches the options and prefills the duties; once HR types, a re-pick keeps them', async () => {
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    expect(promotionOptions).toHaveBeenCalledWith('e1', '');
    expect(await screen.findByText('California Promotion Letter')).toBeTruthy();
    expect(screen.getByText('The Employee, then Their Manager')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    await waitFor(() => expect(promotionOptions).toHaveBeenLastCalledWith('e1', 'jr-2'));
    const duties = () => screen.getByLabelText("New Role's Duties");
    await waitFor(() => expect(duties().value).toBe('Duties of jr-2'));
    expect(screen.getByText(/From Full-Time Employees - Anywhere - change them for this letter only. The role is not changed./)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('IT Dev Associate II - IT'), { target: { value: 'jr-3' } });
    await waitFor(() => expect(duties().value).toBe('Duties of jr-3'));
    expect(screen.getByText(/From the role's Standard/)).toBeTruthy();
    fireEvent.change(duties(), { target: { value: 'My own words' } });
    fireEvent.change(screen.getByDisplayValue('IT Lead - IT'), { target: { value: 'jr-2' } });
    await waitFor(() => expect(promotionOptions).toHaveBeenLastCalledWith('e1', 'jr-2'));
    await new Promise(r => setTimeout(r, 20));
    expect(duties().value).toBe('My own words');
  });

  it('with no promotion letter Review Letter stays off; Set It Up opens the setup over the form, which keeps its values', async () => {
    const fix = { action: 'setUp', target: { entityId: 'c1', section: 'promotion', rowKey: 'employee:US:CA', column: 'letter' } };
    promotionOptions.mockImplementation(() => Promise.resolve({ rowKey: 'employee:US:CA', kind: 'Employees In California', letter: null,
      whatTheyGet: [line('letter', 'Promotion Letter', 'Nothing Yet For Employees In California', { tone: 'missing', blocks: true, fix,
        sourceLabel: 'Set it up to promote with a letter - Change Role Now still works' })],
      blocked: 'Set up a promotion letter first, or use Change Role Now.', duties: null, hrQuestions: [] }));
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.change(screen.getByPlaceholderText(/Annual review/), { target: { value: 'Exceeded targets' } });
    expect(await screen.findByText('Set up a promotion letter first, or use Change Role Now.')).toBeTruthy();
    expect(screen.getByText('Review Letter').closest('button')).toBeDisabled();
    const calls = promotionOptions.mock.calls.length;
    fireEvent.click(screen.getByText('Set It Up'));
    expect(screen.getByText('Hiring Setup Open')).toBeTruthy();
    expect(packetsProps).toHaveBeenLastCalledWith(expect.objectContaining({ initialCompanyId: 'c1', focus: { entityId: 'c1', section: 'promotion', rowKey: 'employee:US:CA', column: 'letter' } }));
    fireEvent.click(screen.getByText('Close Setup'));
    await waitFor(() => expect(promotionOptions.mock.calls.length).toBe(calls + 1));
    expect(screen.getByPlaceholderText(/Annual review/).value).toBe('Exceeded targets');
  });

  it('the letter\'s HR questions go in the merge, pay answers in pay_values', async () => {
    promotionOptions.mockImplementation((eid, roleId) => ready(eid, roleId).then(o => ({ ...o, letter: { ...o.letter, engine: 'documents' },
      hrQuestions: [{ token: 'review_cycle', label: 'Review Cycle', type: 'text', required: true, pay: false, options: [] },
                    { token: 'retention_bonus', label: 'Retention Bonus', type: 'text', required: false, pay: true, options: [] }] })));
    previewPromotion.mockImplementation(() => Promise.resolve({ ...preview, engine: 'documents', documents: ['Promotion Letter'], recipients: [], problems: [] }));
    const onSent = vi.fn();
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.change(screen.getByPlaceholderText(/Annual review/), { target: { value: 'Exceeded targets' } });
    await screen.findByLabelText(/Review Cycle/);
    expect(screen.getByText('Review Letter').closest('button')).toBeDisabled();       // a required answer is missing
    fireEvent.change(screen.getByLabelText(/Review Cycle/), { target: { value: 'Annual' } });
    fireEvent.change(screen.getByLabelText(/Retention Bonus/), { target: { value: '$5,000' } });
    fireEvent.click(screen.getByText('Review Letter'));
    fireEvent.click(await screen.findByText('Generate Letter'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    const body = startPromotion.mock.calls[0][1];
    expect(body.inputs.merge).toEqual({ review_cycle: 'Annual' });
    expect(body.pay_values).toEqual({ retention_bonus: '$5,000' });
    expect(body.inputs.responsibilities).toBe('Duties of jr-2');
  });

  it('a blank left after one review never drops the HR answer typed since', async () => {
    promotionOptions.mockImplementation((eid, roleId) => ready(eid, roleId).then(o => ({ ...o, letter: { ...o.letter, engine: 'documents' },
      hrQuestions: [{ token: 'relocation_note', label: 'Relocation Note', type: 'text', required: false, pay: false, options: [] }] })));
    previewPromotion.mockImplementation(() => Promise.resolve({ ...preview, engine: 'documents', documents: ['Promotion Letter'], recipients: [], problems: [], unresolved: ['relocation_note'] }));
    const calls = previewPromotion.mock.calls.length;
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    fireEvent.change(screen.getByPlaceholderText(/Annual review/), { target: { value: 'Exceeded targets' } });
    fireEvent.click(await screen.findByText('Review Letter'));
    await screen.findByText('Generate Letter');
    fireEvent.change(screen.getByLabelText(/Relocation Note/), { target: { value: 'Moves to Fresno' } });
    fireEvent.click(await screen.findByText('Review Letter'));
    await waitFor(() => expect(previewPromotion).toHaveBeenCalledTimes(calls + 2));
    expect(previewPromotion.mock.lastCall[1].inputs.merge).toEqual({ relocation_note: 'Moves to Fresno' });
  });

  it('the setup over the form reports its errors through the modal toast', async () => {
    const toastErr = vi.fn();
    const fix = { action: 'setUp', target: { entityId: 'c1', section: 'promotion', rowKey: 'employee:US:CA', column: 'letter' } };
    promotionOptions.mockImplementation(() => Promise.resolve({ rowKey: 'employee:US:CA', kind: 'Employees In California', letter: null,
      whatTheyGet: [line('letter', 'Promotion Letter', 'Nothing Yet For Employees In California', { tone: 'missing', blocks: true, fix })],
      blocked: 'Set up a promotion letter first, or use Change Role Now.', duties: null, hrQuestions: [] }));
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={toastErr} />);
    fireEvent.click(await screen.findByText('Set It Up'));
    expect(packetsProps.mock.lastCall[0].toastErr).toBe(toastErr);
  });

  it('new duties from the setup clear the shown letter; no duties shows no "From" hint', async () => {
    let text = 'Old duties';
    promotionOptions.mockImplementation((eid, roleId) => ready(eid, roleId).then(o => ({ ...o,
      whatTheyGet: [...o.whatTheyGet, line('jd', "New Role's Job Description", 'IT Dev Associate II - no duties written', { tone: 'missing',
        fix: { action: 'addDuties', target: { entityId: 'c1', section: 'promotion', roleId: 'jr-2' } } })],
      duties: roleId ? { ...o.duties, text } : null })));
    render(<PromoteModal employee={erin} canSeePay onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    await waitFor(() => expect(screen.getByText(/IT Dev Associate II - IT/)).toBeTruthy());
    text = '';
    fireEvent.change(screen.getByDisplayValue('- pick a role -'), { target: { value: 'jr-2' } });
    await waitFor(() => expect(promotionOptions).toHaveBeenLastCalledWith('e1', 'jr-2'));
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(/From .* - change them for this letter only/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Annual review/), { target: { value: 'Exceeded targets' } });
    fireEvent.click(screen.getByText('Review Letter'));
    await screen.findByText('Promotion Letter - Erin Lee');
    text = 'Duties added in the setup';
    fireEvent.click(screen.getByText('Add Duties'));
    fireEvent.click(screen.getByText('Close Setup'));
    await waitFor(() => expect(screen.getByLabelText("New Role's Duties").value).toBe('Duties added in the setup'));
    expect(screen.queryByText('Promotion Letter - Erin Lee')).toBeNull();
  });
});
