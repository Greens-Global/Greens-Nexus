// Mark Up Anything (Notes boards, Phase 2 - 11/02/2026): a picture becomes a
// board with the picture placed, titled after where it came from, carrying a
// source that points back.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  viewerBlob: vi.fn(), noteUpdate: vi.fn(), addTaskAttachment: vi.fn(), addTicketAttachment: vi.fn(),
}));
const board = vi.hoisted(() => ({ createBoard: vi.fn(), openBoard: vi.fn() }));
const files = vi.hoisted(() => ({ uploadBoardFile: vi.fn() }));
const pdf = vi.hoisted(() => ({ renderPdfPage: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../notes/newBoard', () => board);
vi.mock('../notes/board/files', () => files);
vi.mock('../notes/board/pdfPage', () => pdf);
vi.mock('./storageView', () => ({ isOwnImageUrl: (u) => /supabase\.co\/storage/.test(u || '') }));

import { canMarkUp, isPdfSource, markupSource, markupTitle, placeImage, imageElement, openMarkup, MARKUP_FRAME } from './markup';

const OWN = 'https://x.supabase.co/storage/v1/object/public/task-files/tasks/shot.png';

describe('markup', () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((f) => f.mockReset());
    board.createBoard.mockReset(); board.openBoard.mockReset(); files.uploadBoardFile.mockReset(); pdf.renderPdfPage.mockReset();
    board.createBoard.mockResolvedValue({ id: 'note_9', rev: 1 });
    files.uploadBoardFile.mockResolvedValue({ id: 'f1', mimeType: 'image/png', url: OWN, created: 1 });
    apiMock.noteUpdate.mockImplementation(async (id, data) => ({ id, rev: 2, scene: data.scene }));
    apiMock.viewerBlob.mockResolvedValue({ blob: new Blob(['png'], { type: 'image/png' }) });
  });

  it('knows what can be marked up: pictures and PDFs, by type or by name', () => {
    expect(canMarkUp('image/png')).toBe(true);
    expect(canMarkUp('application/pdf')).toBe(true);
    expect(canMarkUp('', 'photo.JPG')).toBe(true);
    expect(canMarkUp('', 'https://x/y/plan.pdf?x=1')).toBe(true);
    expect(canMarkUp('video/mp4', 'clip.mp4')).toBe(false);
    expect(canMarkUp('', 'sheet.xlsx')).toBe(false);
    expect(isPdfSource('application/pdf')).toBe(true);
    expect(isPdfSource('image/png', 'a.png')).toBe(false);
  });

  it('cleans the source: a known kind keeps its id and label, anything else is a file named after the attachment', () => {
    expect(markupSource({ kind: 'ticket', id: 't_1', label: 'Ticket #12 Printer jam', url: '/tickets?ticket=t_1' }))
      .toEqual({ kind: 'ticket', id: 't_1', label: 'Ticket #12 Printer jam', url: '/tickets?ticket=t_1' });
    expect(markupSource(undefined, { id: 'att_4', name: 'floor.png' })).toEqual({ kind: 'file', id: 'att_4', label: 'floor.png', url: '' });
    // an outside URL never rides along as the back link
    expect(markupSource({ kind: 'task', id: 'k1', label: 'x', url: 'https://evil.example/' }).url).toBe('');
    expect(markupSource({ kind: 'bogus', id: 'k1', label: 'L' }, { name: 'n.png' }).kind).toBe('file');
    expect(markupTitle({ label: 'Ticket #12 Printer jam' })).toBe('Mark Up: Ticket #12 Printer jam');
    expect(markupSource({ kind: 'task', id: 'k', label: 'a'.repeat(300) }).label).toHaveLength(200);
  });

  it('places a picture to fit the frame, centered, never scaled up', () => {
    expect(placeImage(2400, 1200)).toEqual({ x: -600, y: -300, width: MARKUP_FRAME, height: 600 });
    expect(placeImage(300, 200)).toEqual({ x: -150, y: -100, width: 300, height: 200 });
    const el = imageElement('f1', placeImage(600, 400));
    expect(el.type).toBe('image'); expect(el.fileId).toBe('f1'); expect(el.width).toBe(600); expect(el.isDeleted).toBe(false);
  });

  it('openMarkup makes the board, stores the picture, saves a scene with it placed, and opens the board', async () => {
    const n = await openMarkup({ imageUrl: OWN, mimeType: 'image/png', name: 'shot.png', source: { kind: 'task', id: 'task_1', label: 'Fix the gate', url: '/tasks' } });
    expect(board.createBoard).toHaveBeenCalledWith({ title: 'Mark Up: Fix the gate', source: { kind: 'task', id: 'task_1', label: 'Fix the gate', url: '/tasks' } });
    expect(apiMock.viewerBlob).toHaveBeenCalledWith(OWN);
    expect(files.uploadBoardFile).toHaveBeenCalledTimes(1);
    expect(files.uploadBoardFile.mock.calls[0][0]).toBe('note_9');
    const scene = JSON.parse(apiMock.noteUpdate.mock.calls[0][1].scene);
    expect(apiMock.noteUpdate.mock.calls[0][1].rev).toBe(1);
    expect(scene.type).toBe('nexus-board');
    expect(scene.elements).toHaveLength(1);
    expect(scene.elements[0].fileId).toBe('f1');
    expect(scene.files.f1.url).toBe(OWN);
    expect(JSON.stringify(scene)).not.toMatch(/data:image/);
    expect(board.openBoard).toHaveBeenCalledWith('note_9');
    expect(n.rev).toBe(2);
  });

  it('a PDF is rendered to a PNG page first', async () => {
    pdf.renderPdfPage.mockResolvedValue({ blob: new Blob(['png'], { type: 'image/png' }), width: 1000, height: 1400, page: 2, pages: 3 });
    await openMarkup({ imageUrl: 'https://x.supabase.co/storage/v1/object/public/task-files/tasks/plan.pdf', mimeType: 'application/pdf', name: 'plan.pdf', page: 2, source: { kind: 'ticket', id: 't1', label: 'Ticket #3' } });
    expect(pdf.renderPdfPage).toHaveBeenCalledWith('https://x.supabase.co/storage/v1/object/public/task-files/tasks/plan.pdf', 2);
    const scene = JSON.parse(apiMock.noteUpdate.mock.calls[0][1].scene);
    expect(scene.elements[0].width).toBeLessThanOrEqual(MARKUP_FRAME);
    expect(scene.elements[0].height).toBe(MARKUP_FRAME);
  });

  it('a picture that will not store still leaves an open board, and says why', async () => {
    files.uploadBoardFile.mockRejectedValue(new Error('bucket down'));
    await expect(openMarkup({ imageUrl: OWN, mimeType: 'image/png', source: { kind: 'file', id: 'a', label: 'x.png' } })).rejects.toThrow(/could not be placed: bucket down/);
    expect(board.openBoard).toHaveBeenCalledWith('note_9');
    expect(apiMock.noteUpdate).not.toHaveBeenCalled();
  });
});
