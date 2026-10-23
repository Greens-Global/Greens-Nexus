import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

// From a Word file to a published template (Oct 14): read the file, confirm
// what fills each blank and who signs each line, create and publish.

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const cell = (text) => ({ type: 'tableCell', content: [text ? p(text) : { type: 'paragraph' }] });
const DOC = { type: 'doc', content: [
  { type: 'table', content: [{ type: 'tableRow', content: [cell('Contractor Name'), cell(''), cell('PAN Number'), cell('')] }] },
  p('Client(s) Name:   '),
  p('Fully remote position based in Hyderabad, India.'),
  p('Contractor Signature:   '),
  p('Date:  '),
] };
const createDocTemplate = vi.fn(() => Promise.resolve({ id: 't-new' }));
const publishDocTemplate = vi.fn(() => Promise.resolve({ publishedVersion: 1 }));
vi.mock('../api', () => ({ api: {
  createDocTemplate: (...a) => createDocTemplate(...a),
  publishDocTemplate: (...a) => publishDocTemplate(...a),
  getDocVariables: () => Promise.resolve([]),
  renderPacketPreview: () => Promise.resolve({ blob: new Blob(['%PDF']) }),
} }));
const imported = { current: DOC };
vi.mock('../lib/docBuilderImport', () => ({ importDocumentFile: () => Promise.resolve({ json: imported.current, pageSetup: { size: 'letter' } }) }));
vi.mock('../lib/docBuilderUpload', () => ({ uploadToSupabase: () => Promise.resolve({ url: '' }) }));
const { default: WordTemplateWizard } = await import('./WordTemplateWizard');

describe('WordTemplateWizard', () => {
  it('reads the file, lets HR confirm the blanks, and creates a published template', async () => {
    const onOpen = vi.fn();
    render(<WordTemplateWizard categories={[['hr', 'HR'], ['job_description', 'Job Description']]} onClose={() => {}} onOpen={onOpen} />);
    const file = new File(['x'], 'Admin_Associate Package.docx');
    fireEvent.change(screen.getByLabelText('Word file'), { target: { files: [file] } });
    expect(screen.getByDisplayValue('Admin Associate Package')).toBeTruthy();
    fireEvent.click(screen.getByText('Read The File'));

    await waitFor(() => expect(screen.getByText('Signature Lines (1)')).toBeTruthy());
    expect(screen.getByText('Blanks (3)')).toBeTruthy();
    expect(screen.getByText('{{full_name}}')).toBeTruthy();
    expect(screen.getByText('{{pan_number}}')).toBeTruthy();
    // the client is the same for everyone - typed once
    fireEvent.change(screen.getByLabelText('Value for Client(s) Name'), { target: { value: 'Greens Global LLC' } });
    // HR changes a guess
    fireEvent.change(screen.getByLabelText('What fills PAN Number'), { target: { value: 'leave' } });

    // a blank Nexus could not know about: HR adds it from the text
    fireEvent.change(screen.getByLabelText('Text to turn into a variable'), { target: { value: 'Hyderabad' } });
    expect(screen.getByText('Found in 1 place')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Label for the new variable'), { target: { value: 'Office City' } });
    fireEvent.click(screen.getByText('Add', { selector: 'button' }));
    expect(screen.getByText('{{office_city}}')).toBeTruthy();
    expect(screen.getByText('Blanks (4)')).toBeTruthy();

    fireEvent.click(screen.getByText('Create And Publish'));
    await waitFor(() => expect(screen.getByText(/Published v1/)).toBeTruthy());
    const body = createDocTemplate.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Admin Associate Package', category: 'hr', status: 'active' });
    expect(body.signerRoles.map(r => r.key)).toEqual(['company', 'employee']);
    expect(body.content.pageSetup).toEqual({ size: 'letter' });
    const json = JSON.stringify(body.content.pages);
    expect(json).toContain('"token":"full_name"');
    expect(json).not.toContain('pan_number');                    // left blank
    expect(json).toContain('"type":"signatureBlock"');
    expect(body.fieldDefs).toEqual([expect.objectContaining({ token: 'client_name', default: 'Greens Global LLC' }),
      expect.objectContaining({ token: 'office_city', label: 'Office City' })]);
    expect(json).toContain('"token":"office_city"');
    expect(publishDocTemplate).toHaveBeenCalledWith('t-new', expect.stringContaining('Admin_Associate Package.docx'));
    fireEvent.click(screen.getByText('Open In Editor'));
    expect(onOpen).toHaveBeenCalledWith('t-new');
  });
});

// Hiring Setup (Oct 23): an uploaded sample letter - Nexus makes the
// variables itself, HR says who signs the company line and where the duties
// go, and Use This hands the published template back.
describe('WordTemplateWizard - Hiring Setup upload', () => {
  const b = (text) => ({ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] });
  const SAMPLE = { type: 'doc', content: [
    p('This agreement is between Greens Global, LLC and Jane Smith, starting 11/02/2026.'),
    p('The company pays a fee of $6,500 per month.'),
    b('2. Scope Of Work'),
    p('Contractor will provide the services described in the statement of work.'),
    b('3. Signatures'),
    p('Contractor Signature:'),
    p('COMPANY'),
    p('By: ________'),
  ] };
  const CTX = { companyLegal: 'Greens Global, LLC', companyName: 'Greens Global', signatoryName: 'Raj Patel', signatoryTitle: 'President', roleNames: [] };
  const upload = async (purpose) => {
    imported.current = SAMPLE;
    createDocTemplate.mockClear();
    const onCreated = vi.fn();
    render(<WordTemplateWizard purpose={purpose} title="Hiring Packet - Contractors In California" context={CTX} onClose={() => {}} onCreated={onCreated} />);
    expect(screen.queryByText('Template Name')).toBeNull();
    fireEvent.change(screen.getByLabelText('Word file'), { target: { files: [new File(['x'], 'Contractor Agreement.docx')] } });
    fireEvent.click(screen.getByText('Read The File'));
    await waitFor(() => expect(screen.getByText('Check What Nexus Found')).toBeTruthy());
    return onCreated;
  };

  it('makes the variables, asks who signs and where the duties go, then creates and publishes', async () => {
    const onCreated = await upload('hire');
    expect(screen.getByText(/Found \d+ blanks?, 2 signature lines and a Scope Of Work section/)).toBeTruthy();
    const became = (found) => within(screen.getByText(found).closest('[id^="ur-"]')).getByText(/./, { selector: 'b' }).textContent;
    expect(became('Jane Smith')).toBe('Full Name');
    expect(became('Greens Global, LLC')).toBe('Company Legal Name');
    expect(became('$6,500 per month')).toBe('Pay');
    fireEvent.click(screen.getByRole('radio', { name: 'Raj Patel (Signs For The Company)' }));
    expect(screen.getByRole('radio', { name: 'Print Them In Scope Of Work (Recommended)' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Use This'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = createDocTemplate.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Contractor Agreement', category: 'hr', status: 'active' });
    expect(body.signerRoles.map(r => r.key)).toEqual(['employee', 'signatory']);
    const json = JSON.stringify(body.content.pages);
    expect(json).toContain('"token":"full_name"');
    expect(json).toContain('"token":"role_description"');
    expect(json).toContain('"role":"signatory"');
    expect(json).not.toContain('Jane Smith');
    expect(onCreated).toHaveBeenCalledWith({ templateId: 't-new', name: 'Contractor Agreement', jdPlacement: 'inside', signerKeys: ['employee', 'signatory'] });
  });

  it('turning a value back into text keeps it; the duties can go on their own page', async () => {
    const onCreated = await upload('hire');
    const pay = screen.getByText('$6,500 per month').closest('[id^="ur-"]');
    fireEvent.click(within(pay).getByText('Turn Back Into Text'));
    fireEvent.click(screen.getByRole('radio', { name: 'On Their Own Page After This' }));
    fireEvent.click(screen.getByText('Use This'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const json = JSON.stringify(createDocTemplate.mock.calls[0][0].content.pages);
    expect(json).toContain('$6,500 per month');
    expect(json).toContain('statement of work');
    expect(onCreated.mock.calls[0][0].jdPlacement).toBe('page');
  });

  it('an offer letter says only the new hire signs', async () => {
    await upload('offer');
    expect(screen.getByText(/Only the new hire signs an offer letter, so Nexus leaves the company line off/)).toBeTruthy();
    expect(screen.queryByText(/looks like a job description/)).toBeNull();
  });
});
