import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

// PDF Tools to and from the rest of Documents, on the real Documents view and the
// real side panel: the note for Nexus Sign (from both of PDF Tools' addresses),
// the tab strip asking before unsaved work goes, and Open In PDF Tools.

const h = vi.hoisted(() => ({ tabs: null, mounts: [] }));

vi.mock('../api', () => ({
  api: {
    getEmployees: () => Promise.resolve([]),
    getToursSeen: () => Promise.resolve({ seen: { documents: '2026-10-01' } }),
    markTourSeen: () => Promise.resolve({}),
    updateDocument: vi.fn(() => Promise.resolve({})),
    exportDocumentPdf: vi.fn(),
    packetDocumentPdf: vi.fn(),
    mySignFinal: vi.fn(),
    getDocumentVersions: () => Promise.resolve([]),
  },
}));
vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('./PdfEditorModule', () => ({ default: () => <div>pdf tools tab</div> }));
vi.mock('../components/DocumentsBrowser', () => ({ default: () => <div>library</div> }));
vi.mock('../components/DocumentTemplates', () => ({ default: () => <div>templates</div> }));
vi.mock('../components/ModuleTabs', () => ({
  default: ({ tabs, onChange }) => (
    <div>{tabs.map(t => <button key={t.key} type="button" onClick={() => onChange(t.key)}>{t.label}</button>)}</div>
  ),
}));
vi.mock('../components/ESign', () => ({
  default: function EsignStub({ prefill, onSentRequest }) {
    h.mounts.push(prefill);
    h.onSent = onSentRequest;
    return <div>esign tab {prefill?.title}</div>;
  },
}));

const { api } = await import('../api');
const { default: Documents } = await import('./Documents');
const { default: DocumentSidePanel } = await import('../components/DocumentSidePanel');
const { setInlineDirty } = await import('../lib/dialogGuard');
const guard = await import('../lib/dialogGuard');
const { setPendingOpen, takePendingOpen, __clearPendingOpen } = await import('../lib/pendingOpen');
const { ESIGN_PREFILL_PENDING, PDF_TOOLS_PENDING, documentTarget, freeFileName, openEgnyteInPdfTools, pdfFileName, pdfLoadFor } = await import('../lib/pdfToolsHandoff');

const prefill = () => ({ title: 'Lease', file: new File([new Uint8Array([1])], 'Lease.pdf', { type: 'application/pdf' }), source: 'pdf', parties: [] });

beforeEach(() => {
  h.mounts = [];
  __clearPendingOpen();
  setInlineDirty('pdf-tools', false);
  window.__esignPrefill = null;
  api.updateDocument.mockClear();
});
afterEach(() => { cleanup(); setInlineDirty('pdf-tools', false); });

describe('Send For Signature arrives on Nexus Sign', () => {
  it('when Documents remounts, as it does from the /pdf-editor address', async () => {
    setPendingOpen(ESIGN_PREFILL_PENDING, prefill());
    render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('esign tab Lease')).toBeTruthy());
    expect(takePendingOpen(ESIGN_PREFILL_PENDING)).toBeNull();
  });

  it('when Documents stays mounted, moving from its PDF Tools tab', async () => {
    const { rerender } = render(<Documents activeSub="documents-pdf" onSubChange={() => {}} />);
    setPendingOpen(ESIGN_PREFILL_PENDING, prefill());
    rerender(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('esign tab Lease')).toBeTruthy());
  });

  it('never links the envelope back to a library document', async () => {
    window.__esignPrefill = { title: 'Old', file: prefill().file, source: 'pdf', sourceDocumentId: 'doc-9', parties: [] };
    const { rerender } = render(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    setPendingOpen(ESIGN_PREFILL_PENDING, prefill());
    rerender(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('esign tab Lease')).toBeTruthy());
    h.onSent({ id: 'env-1' });
    expect(api.updateDocument).not.toHaveBeenCalled();
  });

  it('is not picked up on another tab', () => {
    setPendingOpen(ESIGN_PREFILL_PENDING, prefill());
    render(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    expect(takePendingOpen(ESIGN_PREFILL_PENDING)).not.toBeNull();
  });
});

describe('the Documents tab strip', () => {
  it('moves straight away with nothing unsaved', () => {
    const onSub = vi.fn();
    render(<Documents activeSub="documents-browse" onSubChange={onSub} />);
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    expect(onSub).toHaveBeenCalledWith('documents-templates');
  });

  // The prompt itself is components/DialogGuard.jsx; this answers it.
  const answerPrompt = async (value) => {
    let pending = null;
    guard.subscribe((p) => { pending = p; })();
    expect(pending).not.toBeNull();
    await act(async () => { pending.resolve(value); await Promise.resolve(); });
  };

  it('asks first with unsaved work, and stays on Keep Editing', async () => {
    const onSub = vi.fn();
    setInlineDirty('pdf-tools', true);
    render(<Documents activeSub="documents-browse" onSubChange={onSub} />);
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    expect(onSub).not.toHaveBeenCalled();
    await answerPrompt(false);
    expect(onSub).not.toHaveBeenCalled();
  });

  it('moves once they discard', async () => {
    const onSub = vi.fn();
    setInlineDirty('pdf-tools', true);
    render(<Documents activeSub="documents-browse" onSubChange={onSub} />);
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    await answerPrompt(true);
    expect(onSub).toHaveBeenCalledWith('documents-templates');
  });
});

describe('Open In PDF Tools', () => {
  const panel = (row) => render(<DocumentSidePanel row={row} folders={[]} onClose={() => {}} onEdit={() => {}} onOrganize={() => {}} />);

  it('on a document row: a note and a move to the PDF Tools tab', () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    panel({ id: 'd1', kind: 'document', title: 'Offer: Ada', status: 'final', parties: [], tags: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Open In PDF Tools' }));
    window.removeEventListener('nexus:navigate', nav);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'documents', sub: 'documents-pdf' });
    const target = takePendingOpen(PDF_TOOLS_PENDING);
    expect(target).toMatchObject({ kind: 'documents', id: 'd1', title: 'Offer: Ada', name: 'Offer Ada.pdf' });
    target.load();
    expect(api.exportDocumentPdf).toHaveBeenCalledWith('d1');
  });

  it('is not offered on an envelope with no document behind it', () => {
    panel({ id: 'e1', kind: 'envelope', title: 'Envelope', status: 'final', signStatus: 'pending', parties: [], tags: [] });
    expect(screen.queryByRole('button', { name: 'Open In PDF Tools' })).toBeNull();
  });

  it('from an Egnyte file goes to PDF Tools\' own address', () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    act(() => { openEgnyteInPdfTools({ path: '/Shared/Lease.pdf', name: 'Lease.pdf' }); });
    window.removeEventListener('nexus:navigate', nav);
    expect(nav.mock.calls[0][0].detail).toEqual({ view: 'pdf-editor' });
    expect(takePendingOpen(PDF_TOOLS_PENDING)).toEqual({ kind: 'egnyte', path: '/Shared/Lease.pdf', name: 'Lease.pdf' });
  });
});

describe('which rows have a PDF', () => {
  it('follows the side panel\'s preview rule', () => {
    expect(pdfLoadFor({ kind: 'document', id: 'd' })).toBeTruthy();
    expect(pdfLoadFor({ kind: 'document', id: 'd', signStatus: 'completed', canManageEnvelope: true })).toBeNull();
    expect(pdfLoadFor({ kind: 'document', id: 'd', signStatus: 'completed' })).toBeTruthy();
    expect(pdfLoadFor({ kind: 'envelope', id: 'e', signStatus: 'completed', partyId: 'p' })).toBeTruthy();
    expect(pdfLoadFor({ kind: 'envelope', id: 'e', signStatus: 'pending' })).toBeNull();
    expect(pdfLoadFor({ kind: 'hr', eventId: 'x', documentId: 'y' })).toBeTruthy();
    expect(pdfLoadFor({ kind: 'hr', locked: true })).toBeNull();
    expect(pdfLoadFor({ kind: 'hr', signed: true })).toBeNull();
    expect(documentTarget({ kind: 'envelope' })).toBeNull();
  });
});

describe('file names', () => {
  it('keeps a good name, adds .pdf and drops what Egnyte will not take', () => {
    expect(pdfFileName('Lease.pdf')).toBe('Lease.pdf');
    expect(pdfFileName('Lease.PDF')).toBe('Lease.PDF');
    expect(pdfFileName('Offer: A/B?')).toBe('Offer A B.pdf');
    expect(pdfFileName('   ')).toBe('document.pdf');
    expect(pdfFileName(null)).toBe('document.pdf');
  });

  it('finds the first free number, whatever the case', () => {
    expect(freeFileName('Lease.pdf', ['Lease.pdf'])).toBe('Lease (1).pdf');
    expect(freeFileName('Lease.pdf', ['Lease.pdf', 'LEASE (1).PDF', 'lease (2).pdf'])).toBe('Lease (3).pdf');
  });
});
