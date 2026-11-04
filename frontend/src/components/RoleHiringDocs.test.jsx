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
    { id: 't-jd-admin', name: 'Admin Associate JD', category: 'job_description', publishedVersion: 2 },
  ]),
  updateJobRole: (...a) => updateJobRole(...a),
  uploadRoleJdFile: (...a) => uploadRoleJdFile(...a),
  removeRoleJdFile: (...a) => removeRoleJdFile(...a),
  getJdSources: () => Promise.resolve([
    { id: 'jr-clerk-a', name: 'Clerk', companyName: 'Greens A', file: '', hasDuties: true },
    { id: 'jr-sup-a', name: 'Site Supervisor', companyName: 'Greens A', file: 'Supervisor JD.pdf', hasDuties: true },
  ]),
  copyRoleJd: (...a) => copyRoleJd(...a),
} }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: () => Promise.resolve(true) } }));
// Pranshu, 11/03/2026: copy the same role's job description from another company.
const copyRoleJd = vi.fn((id) => Promise.resolve({ id, job_description: 'Runs the site.', jd_file: { name: 'Supervisor JD.pdf', pages: 1 } }));
// Neil, 11/03/2026: or a file - a PDF, or a Word file the server converts - sent after the offer letter.
const uploadRoleJdFile = vi.fn((id, file) => Promise.resolve({ id, jd_file: { name: file.name, pages: 2, uploadedAt: '2026-11-03T15:00:00Z' } }));
const removeRoleJdFile = vi.fn(id => Promise.resolve({ id, jd_file: {} }));
const { default: RoleHiringDocs } = await import('./RoleHiringDocs');

describe('RoleHiringDocs', () => {
  // Pranshu, 11/04/2026: or pick it from Documents - linked, so a change there reaches the next offer.
  it('Pick From Documents links a Job Description template, saved on change', async () => {
    updateJobRole.mockClear();
    const onSaved = vi.fn();
    render(<RoleHiringDocs role={{ id: 'jr-admin', name: 'Admin Associate', job_description: '', hiring_docs: [] }}
      onSaved={onSaved} toastOk={() => {}} toastErr={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Pick From Documents' }));
    const pick = await screen.findByLabelText('Job description from Documents');
    expect([...pick.options].map(o => o.textContent)).toEqual(['- pick a job description -', 'Admin Associate JD']);   // Job Description templates only
    fireEvent.change(pick, { target: { value: 't-jd-admin' } });
    await waitFor(() => expect(updateJobRole).toHaveBeenCalledWith('jr-admin', { jd_template_id: 't-jd-admin' }));
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByText(/Linked, not copied/)).toBeTruthy();
  });

  it('opens on Pick From Documents when the role is linked', async () => {
    render(<RoleHiringDocs role={{ id: 'jr-admin', name: 'Admin Associate', job_description: '', hiring_docs: [],
      jd_template: { id: 't-jd-admin', name: 'Admin Associate JD', publishedVersion: 2, active: true } }}
      toastOk={() => {}} toastErr={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Pick From Documents' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(screen.getByLabelText('Job description from Documents').value).toBe('t-jd-admin'));
    expect(screen.getByText('Open In Documents')).toBeTruthy();
  });

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

  it('uploads a job description file, then removes it', async () => {
    function Host() {
      const [role, setRole] = React.useState({ id: 'jr-sup', name: 'Site Supervisor', job_description: 'Runs the site.', hiring_docs: [] });
      return <RoleHiringDocs role={role} onSaved={saved => setRole(r => ({ ...r, ...saved }))} toastOk={() => {}} toastErr={() => {}} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('radio', { name: 'Upload A File' }));
    const file = new File(['%PDF-1.4'], 'Supervisor JD.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    fireEvent.change(screen.getByLabelText('Job description file'), { target: { files: [file] } });
    expect(await screen.findByText('Supervisor JD.docx')).toBeTruthy();
    expect(uploadRoleJdFile).toHaveBeenCalledWith('jr-sup', file);
    expect(screen.getByText(/2 pages - uploaded 11\/03\/2026/)).toBeTruthy();
    // The typed duties say the file wins while it is there.
    fireEvent.click(screen.getByRole('radio', { name: 'Type It' }));
    expect(screen.getByText(/is attached and goes out instead of these duties/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Upload A File' }));
    fireEvent.click(screen.getByLabelText('Remove job description file'));
    expect(await screen.findByText('Choose A PDF Or Word File')).toBeTruthy();
    expect(removeRoleJdFile).toHaveBeenCalledWith('jr-sup');
  });

  it('copies the job description from the same role in another company, listed first', async () => {
    function Host() {
      const [role, setRole] = React.useState({ id: 'jr-sup-b', name: 'Site Supervisor', job_description: '', hiring_docs: [] });
      return <RoleHiringDocs role={role} onSaved={saved => setRole(r => ({ ...r, ...saved }))} toastOk={() => {}} toastErr={() => {}} />;
    }
    render(<Host />);
    const pick = await screen.findByLabelText('Copy job description from');
    expect([...pick.options].map(o => o.textContent).slice(1))
      .toEqual(['Site Supervisor - Greens A (Supervisor JD.pdf)', 'Clerk - Greens A']);
    fireEvent.change(pick, { target: { value: 'jr-sup-a' } });
    await waitFor(() => expect(copyRoleJd).toHaveBeenCalledWith('jr-sup-b', 'jr-sup-a'));
    expect(await screen.findByText('Supervisor JD.pdf')).toBeTruthy();       // the file came with it
  });
});
