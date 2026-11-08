// Drawings, the current set (Round Two item 9, 11/06/2026): the tab lists the
// current sheets, keeps superseded ones behind a toggle, and adds a sheet
// through the one construction upload with the file's kind 'drawing'.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../api', () => ({ api: {
  getJobDrawings: vi.fn(),
  addJobDrawing: vi.fn(),
  removeJobDrawing: vi.fn(),
} }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(async () => true), alert: vi.fn(), undo: vi.fn() } }));
vi.mock('../lib/upload', async (orig) => ({
  ...(await orig()),
  uploadConstructionMedia: vi.fn(async (file) => ({ error: null, payload: { kind: 'drawing', url: `https://s/construction-media/construction/pa/${file.name}`, mime_type: file.type, size_bytes: file.size, original_name: file.name } })),
}));

const { api } = await import('../../api');
const { uploadConstructionMedia } = await import('../lib/upload');
const { default: DrawingsTab } = await import('./DrawingsTab');

const sheet = (id, rev, status, extra = {}) => ({ id, sheetNumber: 'A-201', title: 'First Floor Plan', discipline: 'Architectural',
  revision: rev, revisionOn: '2026-11-02', fileUrl: `https://x/${id}.pdf`, fileName: `${id}.pdf`, status, supersededBy: '', egnytePath: '', ...extra });
const project = { id: 'pa', name: 'Job A', jobType: 'project', today: '2026-11-06' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Drawings tab', () => {
  it('shows the current sheet, the superseded one only on the toggle', async () => {
    api.getJobDrawings.mockResolvedValue({ drawings: [sheet('d2', '2', 'current'), sheet('d1', '1', 'superseded')], canEdit: false });
    render(<DrawingsTab project={project} />);
    const row = (await screen.findByText('A-201')).closest('[data-drawing]');
    expect(row.textContent).toContain('Rev 2 · 11/02/2026 · Architectural');
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByText('Superseded')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Sheet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New Revision' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Superseded' }));
    expect(screen.getByText('Superseded')).toBeInTheDocument();
  });

  it('a manager adds a new revision: the file goes up as a drawing, then the sheet is saved', async () => {
    api.getJobDrawings.mockResolvedValue({ drawings: [sheet('d1', '1', 'current')], canEdit: true });
    api.addJobDrawing.mockResolvedValue({ drawings: [], canEdit: true });
    render(<DrawingsTab project={project} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Revision' }));
    expect(screen.getByLabelText('Sheet Number')).toHaveValue('A-201');
    fireEvent.change(screen.getByLabelText('Revision'), { target: { value: '2' } });
    const file = new File(['%PDF-1.4'], 'A-201 Rev 2.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Sheet File'), { target: { files: [file] } });
    expect(screen.getByText('A-201 Rev 2.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Revision' }));
    await waitFor(() => expect(api.addJobDrawing).toHaveBeenCalledWith('pa', expect.objectContaining({
      sheet_number: 'A-201', revision: '2', title: 'First Floor Plan', file: expect.objectContaining({ kind: 'drawing' }) })));
    expect(uploadConstructionMedia).toHaveBeenCalledWith(file, { projectId: 'pa', kind: 'drawing' });
  });
});
