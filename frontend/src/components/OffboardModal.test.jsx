import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke for Offboard (Neil, Oct 8): the last day decides where the
// paperwork goes and when they become Left.

// The modal starts on TODAY'S LOCAL date - a UTC date is already tomorrow
// in the evening in the US (after 5 PM Pacific).
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const offboard = vi.fn(() => Promise.resolve({ id: 'ev1', applyStatus: 'scheduled', effectiveDate: '2099-01-31' }));
vi.mock('../api', () => ({
  api: {
    previewOffboard: (...a) => previewOffboard(...a),
    offboard: (...a) => offboard(...a),
    offboardOptions: (...a) => offboardOptions(...a),
  },
}));
const pdfPreview = (eid, body) => Promise.resolve({
  immediate: body.inputs.last_day <= localToday(), lastDay: body.inputs.last_day,
  package: body.inputs.send_package !== false, documents: ['Separation Package'], sendTo: 'erin@x.com', why: 'they still have their work email until their last day',
  recipients: [{ order: 1, role: 'company', name: 'Hana', email: 'hana@x.com' }, { order: 2, role: 'employee', name: 'Erin Lee', email: 'erin@x.com', isSubject: true }],
  unresolved: [], egnyteSubfolder: 'Separation Documents',
});
const previewOffboard = vi.fn(pdfPreview);
const withPackage = () => Promise.resolve({ rowKey: 'employee:US:CA', kind: 'Employees In California',
  package: { settingId: 's-ca-sep', name: 'California Separation Package', engine: 'pdf' }, canSendPackage: true, noPackageText: '',
  whatTheyGet: [{ key: 'package', label: 'Separation Package', name: 'California Separation Package', sourceLabel: 'Same As All Companies - California', tone: 'same', blocks: false, fix: null }],
  hrQuestions: [] });
const offboardOptions = vi.fn(withPackage);
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [{ email: 'max@x.com', name: 'Max' }] }) }));
vi.mock('./ESign', () => ({ SignModal: () => null, AttachmentPlacer: () => null, MERGE_FIELDS: [['salary', 'Salary']] }));

const { OffboardModal } = await import('./HrPersonActions');
const erin = { id: 'e1', firstName: 'Erin', lastName: 'Lee', jobTitle: 'Analyst', workEmail: 'erin@x.com', personalEmail: 'erin@gmail.com', managerEmail: 'max@x.com' };

beforeEach(() => { offboardOptions.mockImplementation(withPackage); previewOffboard.mockImplementation(pdfPreview); offboard.mockClear(); });

describe('OffboardModal', () => {
  it('today: says their access ends now and the paperwork goes to the personal email', () => {
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(screen.getByText(/their access ends as soon as you confirm/)).toBeTruthy();
    expect(screen.getByText(/erin@gmail.com/)).toBeTruthy();
  });

  it('a future last day is scheduled', async () => {
    const onSent = vi.fn();
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    fireEvent.change(screen.getByDisplayValue(localToday()), { target: { value: '2099-01-31' } });
    expect(screen.getByText(/through 01\/31\/2099; the morning after, Nexus marks them Left by itself/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    await waitFor(() => expect(screen.getByText('Schedule Offboarding')).toBeTruthy());
    expect(screen.getByText(/Goes to erin@x.com/)).toBeTruthy();
    fireEvent.click(screen.getByText(/I confirm this is not a record/));
    fireEvent.click(screen.getByText('Schedule Offboarding'));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(offboard.mock.calls[0][1].inputs.offboarding.mailboxAction).toBe('remove');
  });
});

// Hiring Setup round 2: no separation package never blocks - the offboarding runs without documents.
describe('OffboardModal - no separation package', () => {
  it('turns the package off with the reason and a Set It Up, and offboards with send_package false', async () => {
    const text = 'No separation package is set up for Employees In California yet - the offboarding still runs, without documents.';
    offboardOptions.mockImplementation(() => Promise.resolve({ rowKey: 'employee:US:CA', kind: 'Employees In California', package: null,
      canSendPackage: false, noPackageText: text, hrQuestions: [],
      whatTheyGet: [{ key: 'package', label: 'Separation Package', name: 'Nothing Yet For Employees In California', sourceLabel: 'The offboarding still runs, without documents',
        tone: 'missing', blocks: false, fix: { action: 'setUp', target: { entityId: 'e-gg', section: 'offboarding', rowKey: 'employee:US:CA', column: 'package' } } }] }));
    const onSent = vi.fn();
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    expect(await screen.findByText(text)).toBeTruthy();
    const box = screen.getByLabelText('Send the separation package through Nexus Sign');
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(screen.getByText('Set It Up')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    fireEvent.click(await screen.findByText(/Offboard Now|Schedule Offboarding/));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(offboard.mock.calls[0][1].inputs.send_package).toBe(false);
  });

  it('with a package it starts on and shows what they get', async () => {
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('California Separation Package')).toBeTruthy();
    expect(screen.getByLabelText('Send the separation package through Nexus Sign').checked).toBe(true);
  });
});

describe('OffboardModal - round 2 review fixes', () => {
  it('a documents package never asks HR for the blanks the employee fills', async () => {
    previewOffboard.mockImplementation((eid, body) => pdfPreview(eid, body).then(p => ({ ...p, engine: 'documents', problems: [],
      unresolved: ['forwarding_address', 'forwarding_email'] })));
    const onSent = vi.fn();
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={onSent} toastErr={() => {}} />);
    await screen.findByText('California Separation Package');
    fireEvent.change(screen.getByDisplayValue('- pick one -'), { target: { value: 'resignation' } });
    fireEvent.click(screen.getByText('Review'));
    const go = (await screen.findByText(/Offboard Now|Schedule Offboarding/)).closest('button');
    expect(screen.queryByText('forwarding address')).toBeNull();
    expect(go).not.toBeDisabled();
    fireEvent.click(go);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(offboard.mock.calls[0][1].inputs.merge).toEqual({});
  });

  it('HR unchecking the package before the options arrive is kept', async () => {
    let answer;
    offboardOptions.mockImplementation(() => new Promise(r => { answer = r; }));
    render(<OffboardModal employee={erin} companyName="Greens" onClose={() => {}} onSent={() => {}} toastErr={() => {}} />);
    const box = () => screen.getByLabelText('Send the separation package through Nexus Sign');
    fireEvent.click(box());
    expect(box().checked).toBe(false);
    answer(await withPackage());
    await screen.findByText('California Separation Package');
    expect(box().checked).toBe(false);
  });
});
