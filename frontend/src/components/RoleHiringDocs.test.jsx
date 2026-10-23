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
// Duties are edited in Set Up Hiring's Job Description popup (Oct 23).
vi.mock('./hiring/RoleDutiesModal', () => ({ default: ({ roleId, entityId }) => <div data-testid="duties-popup">{roleId}|{entityId}</div> }));
const { default: RoleHiringDocs } = await import('./RoleHiringDocs');

describe('RoleHiringDocs', () => {
  it('opens the Job Description popup, and saves a document that replaces the standard one', async () => {
    const onSaved = vi.fn();
    render(<RoleHiringDocs role={{ id: 'jr-con', name: 'Construction Associate', job_description: '', hiring_docs: [], company_id: 'e-gg' }}
      onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText(/None - this role signs exactly/)).toBeTruthy();
    expect(screen.getByText('Save').closest('button')).toBeDisabled();
    expect(screen.getByText('Not written yet.')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit Job Description'));
    expect(screen.getByTestId('duties-popup').textContent).toBe('jr-con|e-gg');
    await waitFor(() => expect(screen.getByText('Add Document')).toBeTruthy());
    fireEvent.click(screen.getByText('Add Document'));
    fireEvent.change(screen.getByLabelText('Role document'), { target: { value: 't-nda-con' } });
    expect(screen.getByText('Replaces: Job Description')).toBeTruthy();             // a formatted JD takes the page's place
    fireEvent.change(screen.getByLabelText('Replaces'), { target: { value: 't-nda' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalledWith('jr-con', {
      hiring_docs: [{ templateId: 't-nda-con', replaces: 't-nda' }] }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
