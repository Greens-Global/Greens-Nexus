import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
  renderPacketPreview: () => Promise.resolve({ blob: new Blob(['%PDF']) }),
} }));
vi.mock('../lib/docBuilderImport', () => ({ importDocumentFile: () => Promise.resolve({ json: DOC, pageSetup: { size: 'letter' } }) }));
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
