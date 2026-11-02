// The attachment viewer's Mark Up (Notes boards, Phase 2 - 11/02/2026): a
// picture or a PDF gets the button, a video does not; a picture goes straight
// to openMarkup with the caller's source; a PDF with several pages asks which.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const markup = vi.hoisted(() => ({ openMarkup: vi.fn() }));
const pdf = vi.hoisted(() => ({ pdfPageCount: vi.fn() }));
vi.mock('../lib/markup', async (importOriginal) => ({ ...(await importOriginal()), openMarkup: markup.openMarkup }));
vi.mock('../notes/board/pdfPage', () => pdf);
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => ({})) }) }));

import { AttachmentViewer } from './components';

const SRC = { kind: 'ticket', id: 't1', label: 'Ticket #4 Leak', url: '/tickets?ticket=t1' };

describe('AttachmentViewer Mark Up', () => {
  beforeEach(() => { markup.openMarkup.mockReset(); markup.openMarkup.mockResolvedValue({ id: 'note_1' }); pdf.pdfPageCount.mockReset(); });

  it('offers Mark Up on a picture and sends the caller\'s source', async () => {
    const onClose = vi.fn();
    render(<AttachmentViewer att={{ name: 'leak.png', kind: 'image', url: 'https://x/leak.png', size: '10 KB' }} onClose={onClose} markupSource={SRC} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalledTimes(1));
    expect(markup.openMarkup.mock.calls[0][0]).toMatchObject({ imageUrl: 'https://x/leak.png', name: 'leak.png', page: 1, source: SRC });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a file with no source becomes a markup of the file by name', async () => {
    render(<AttachmentViewer att={{ id: 'att_9', name: 'floor.jpg', kind: 'image', url: 'https://x/floor.jpg' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalled());
    expect(markup.openMarkup.mock.calls[0][0].source).toEqual({ kind: 'file', id: 'att_9', label: 'floor.jpg', url: '' });
  });

  it('has no Mark Up for a video', () => {
    render(<AttachmentViewer att={{ name: 'clip.mp4', kind: 'video', url: 'https://x/clip.mp4' }} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /Mark Up/ })).toBeNull();
  });

  it('a PDF with several pages asks which page, then marks that one up', async () => {
    pdf.pdfPageCount.mockResolvedValue(3);
    render(<AttachmentViewer att={{ name: 'plan.pdf', url: 'https://x/plan.pdf' }} onClose={() => {}} markupSource={SRC} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    expect(await screen.findByText('Which page should go on the board?')).toBeTruthy();
    expect(markup.openMarkup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalledTimes(1));
    expect(markup.openMarkup.mock.calls[0][0]).toMatchObject({ page: 2, mimeType: 'application/pdf' });
  });

  it('a one-page PDF goes straight to the board', async () => {
    pdf.pdfPageCount.mockResolvedValue(1);
    render(<AttachmentViewer att={{ name: 'one.pdf', url: 'https://x/one.pdf' }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    await waitFor(() => expect(markup.openMarkup).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Which page should go on the board?')).toBeNull();
  });

  it('says why when the markup could not start, and stays open', async () => {
    markup.openMarkup.mockRejectedValue(new Error('bucket down'));
    const onClose = vi.fn();
    render(<AttachmentViewer att={{ name: 'leak.png', kind: 'image', url: 'https://x/leak.png' }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Mark Up/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bucket down');
    expect(onClose).not.toHaveBeenCalled();
  });
});
