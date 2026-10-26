import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Neil, Oct 22: the role fills itself into the place's packet - its duties
// once, and its own documents, each added or replacing one of the packet's.
const updateJobRole = vi.fn((id, body) => Promise.resolve({ id, ...body }));
vi.mock('../api', () => ({ api: {
  getDocTemplates: () => Promise.resolve([
    { id: 't-nda', name: 'Standard Confidentiality Agreement' },
    { id: 't-nda-con', name: 'Confidentiality Agreement - Construction' },
  ]),
  updateJobRole: (...a) => updateJobRole(...a),
} }));
const { default: RoleHiringDocs } = await import('./RoleHiringDocs');

describe('RoleHiringDocs', () => {
  it('saves the duties and a document that replaces the standard one', async () => {
    const onSaved = vi.fn();
    render(<RoleHiringDocs role={{ id: 'jr-con', name: 'Construction Associate', job_description: '', hiring_docs: [] }}
      onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(/None - this role signs exactly/)).toBeTruthy();
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Job Description (Duties)'), { target: { value: 'Frames walls.' } });
    await waitFor(() => expect(screen.getByText('Add Document')).toBeTruthy());
    fireEvent.click(screen.getByText('Add Document'));
    fireEvent.change(screen.getByLabelText('Role document'), { target: { value: 't-nda-con' } });
    fireEvent.change(screen.getByLabelText('Replaces'), { target: { value: 't-nda' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalledWith('jr-con', {
      job_description: 'Frames walls.', hiring_docs: [{ templateId: 't-nda-con', replaces: 't-nda' }] }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
