import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

// The Document Builder -> Nexus Sign handoff is ONE-SHOT.
//
// Sagar, Sep 16: "the changes made by clicking on edit pdf are getting
// disappeared before going to eSign". <ESign> is mounted on the Nexus Sign tab
// (`{sub === 'documents-esign' && <ESign .../>}`), so leaving the tab and
// coming back remounts it. The prefill used to sit in Documents' state until
// the wizard CLOSED, so that remount found it, reopened the wizard and
// re-applied prefill.file - putting the original export back over the PDF the
// sender had just edited, along with their fields, title and recipients.
//
// This drives the real Documents view with a stubbed ESign that reports what
// prefill it was handed on each mount.

const updateDocument = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({
  api: {
    getDocuments: () => Promise.resolve([]),
    mySignatures: () => Promise.resolve([]),
    getDocFolders: () => Promise.resolve([]),
    getDocTemplates: () => Promise.resolve([]),
    getDocLetterheads: () => Promise.resolve([]),
    getEmployees: () => Promise.resolve([]),
    searchDocuments: () => Promise.resolve([]),
    updateDocument: (...a) => updateDocument(...a),
  },
}));
vi.mock('../lib/queries', () => ({ useEntities: () => ({ data: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('./PdfEditorModule', () => ({ default: () => <div>pdf tools tab</div> }));
vi.mock('../components/DocumentBuilder', () => ({ default: () => <div>document builder</div> }));
vi.mock('../components/EgnyteBrowser', () => ({ default: () => <div>egnyte</div> }));

// Stands in for ESign + SendWizard, mirroring their real two-layer shape: the
// tab watches [prefill] and opens the wizard; the WIZARD reads the prefill in
// its own mount effect and releases it there. `mounts` records what each
// wizard mount was handed - null meaning "opened with nothing to apply".
const mounts = [];
let sendHook = null;
// Declared at module scope, not inline in the tab's render: an inline
// component is a new type on every render, which React unmounts and remounts,
// and this test counts mounts.
function WizardStub({ prefill, onPrefillConsumed }) {
  const atMount = React.useRef(prefill);
  React.useEffect(() => {
    mounts.push(atMount.current ? atMount.current.file.name : null);
    if (atMount.current) onPrefillConsumed?.();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div>send wizard</div>;
}

function EsignStub({ prefill, onPrefillConsumed, onSentRequest }) {
  const [sendOpen, setSendOpen] = React.useState(false);
  React.useEffect(() => { if (prefill) setSendOpen(true); }, [prefill]);
  sendHook = onSentRequest;
  return (
    <div>esign tab
      {sendOpen && <WizardStub prefill={prefill} onPrefillConsumed={onPrefillConsumed} />}
    </div>
  );
}

vi.mock('../components/ESign', () => ({ default: EsignStub }));

const Documents = (await import('./Documents')).default;

const fileNamed = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });

describe('the Document Builder -> Nexus Sign prefill is consumed once', () => {
  beforeEach(() => { mounts.length = 0; sendHook = null; window.__esignPrefill = null; updateDocument.mockClear(); });

  it('does not re-apply the original export when the tab is revisited', async () => {
    window.__esignPrefill = {
      title: 'Call with Neil Kadakia', file: fileNamed('original-export.pdf'),
      source: 'pdf', sourceDocumentId: 'doc-1', parties: [],
    };
    const { rerender } = render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(mounts).toEqual(['original-export.pdf']));

    // Leave Nexus Sign for another Documents tab, then come back. <ESign>
    // unmounts and remounts; it must NOT be handed the export a second time.
    rerender(<Documents activeSub="documents-browse" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.queryByText('esign tab')).toBeNull());
    rerender(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('esign tab')).toBeTruthy());

    // Before the fix this read ['original-export.pdf', 'original-export.pdf']:
    // the wizard reopened by itself and laid the original export back down.
    expect(mounts).toEqual(['original-export.pdf']);
    expect(screen.queryByText('send wizard')).toBeNull();
  });

  it('still links the envelope back to its source document after sending', async () => {
    // The source document id outlives the prefill on purpose - it is only
    // needed once the envelope is actually sent, long after the wizard took
    // the file.
    window.__esignPrefill = {
      title: 'Call with Neil Kadakia', file: fileNamed('original-export.pdf'),
      source: 'pdf', sourceDocumentId: 'doc-42', parties: [],
    };
    render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(mounts.length).toBe(1));

    await act(async () => { sendHook({ id: 'req-7' }); });
    expect(updateDocument).toHaveBeenCalledWith('doc-42', { signRequestId: 'req-7', status: 'final' });
  });

  it('accepts a fresh handoff that arrives while Documents is already open', async () => {
    render(<Documents activeSub="documents-esign" onSubChange={() => {}} />);
    await waitFor(() => expect(screen.getByText('esign tab')).toBeTruthy());
    expect(mounts).toEqual([]);

    // "Send for signature" pressed again from the builder: a NEW prefill must
    // still get through - one-shot means once per handoff, not once ever.
    await act(async () => {
      window.__esignPrefill = {
        title: 'Second document', file: fileNamed('second-export.pdf'),
        source: 'pdf', sourceDocumentId: 'doc-2', parties: [],
      };
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
    });
    await waitFor(() => expect(mounts).toContain('second-export.pdf'));

    await act(async () => { sendHook({ id: 'req-9' }); });
    expect(updateDocument).toHaveBeenCalledWith('doc-2', { signRequestId: 'req-9', status: 'final' });
  });
});
