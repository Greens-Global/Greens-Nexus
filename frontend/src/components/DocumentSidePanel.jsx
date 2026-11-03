// The panel a Documents row opens beside the list (Neil, 10/31/2026): the page,
// who signed and who is next, the versions, and named actions - so "who are we
// waiting on?" needs no click into anything. Phones get it as a full-screen
// sheet with no page preview, since a phone's browser cannot draw a PDF in a page.
import { lazy, Suspense, useEffect, useState } from 'react';
import { X, Lock } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { setPendingOpen } from '../lib/pendingOpen';
import { openRowInPdfTools, pdfLoadFor } from '../lib/pdfToolsHandoff';
import { rowFor, rowStatus } from '../lib/documentLibrary';
import { useIsMobile } from '../lib/useIsMobile';
import HoldButton from '../ui/HoldButton';

// A form entry's row (Neil, 11/02/2026) opens the Forms panel. Lazy: it brings
// the entry viewer and the ticket / task composers along, and it imports this
// file's PanelShell.
const EntryPanel = lazy(() => import('../forms/EntryPanel'));

const go = (sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub } }));

export function StatusWord({ status }) {
  return <span className="nx-dl-status"><i className={`nx-dl-dot nx-dl-${status.tone}`} aria-hidden="true" />{status.label}</span>;
}

export function PanelShell({ title, subtitle, onClose, children }) {
  return (
    <aside className="nx-dl-panel" aria-label={title}>
      <div className="nx-dl-panel-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nx-dl-panel-title">{title}</div>
          {subtitle && <div className="nx-dl-muted">{subtitle}</div>}
        </div>
        <button type="button" className="nx-dl-icon" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      {children}
    </aside>
  );
}

// Keyed by the caller on what it shows, so a new row starts from Loading.
export function PdfPreview({ load, label }) {
  const isMobile = useIsMobile();
  const [state, setState] = useState({ url: '', error: '' });
  useEffect(() => {
    if (isMobile) return undefined;
    let live = true;
    let url = '';
    // A short wait, so stepping down the list does not render every row on the way.
    const t = setTimeout(() => {
      load().then(({ blob }) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setState({ url, error: '' });
      }).catch((e) => { if (live) setState({ url: '', error: e?.message || 'Could not draw the preview.' }); });
    }, 250);
    return () => { live = false; clearTimeout(t); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (isMobile) return null;
  if (state.error) return <div className="nx-dl-page nx-dl-page-note">{state.error}</div>;
  if (!state.url) return <div className="nx-dl-page nx-dl-page-note">Drawing the page...</div>;
  return <iframe className="nx-dl-page" title={label} src={`${state.url}#toolbar=0&navpanes=0&view=FitH`} />;
}

export function saveBlob({ blob, filename }, fallback) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `${String(fallback).replace(/[^\w .-]/g, '')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function partyLine(p) {
  if (p.status === 'signed') return { tone: 'green', text: `${p.name} signed`, when: p.signedAt };
  if (p.status === 'declined') return { tone: 'red', text: `${p.name} declined`, when: '' };
  if (p.status === 'viewed') return { tone: 'blue', text: `${p.name} - viewed, not signed`, when: p.viewedAt };
  if (p.status === 'notified') return { tone: 'blue', text: `${p.name} - notified`, when: '' };
  return { tone: 'muted', text: `${p.name} - waiting`, when: '' };
}

function Signatures({ row }) {
  if (!row.signers && !(row.parties || []).length) return null;
  return (
    <section className="nx-dl-section">
      <h4>{row.signers ? `Signatures - ${row.signed || 0} of ${row.signers}` : 'Signatures'}</h4>
      {(row.parties || []).filter((p) => p.role !== 'cc').map((p, i) => {
        const line = partyLine(p);
        return (
          <div key={`${p.name}-${i}`} className="nx-dl-step">
            <i className={`nx-dl-dot nx-dl-${line.tone}`} aria-hidden="true" />
            <div>{line.text}{line.when && <small>{formatDateTime(line.when)}</small>}</div>
          </div>
        );
      })}
    </section>
  );
}

function Details({ row, folders }) {
  const folder = folders.find((f) => f.id === row.folderId);
  const items = [
    ['For', rowFor(row) || '-'],
    ['Company', row.company],
    ['Packet', row.packet],
    ['Template', row.templateName ? `${row.templateName}${row.templateVersion ? ` v${row.templateVersion}` : ''}` : ''],
    ['Folder', row.kind === 'document' ? (folder?.name || 'No Folder') : ''],
    ['Tags', (row.tags || []).join(', ')],
    ['Updated', formatDate(row.updatedAt)],
    ['Expires', row.signStatus === 'pending' && row.expiresOn ? formatDate(row.expiresOn) : ''],
  ].filter(([, v]) => v);
  return <dl className="nx-dl-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function Versions({ docId }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let live = true;
    api.getDocumentVersions(docId).then((r) => { if (live) setRows(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [docId]);
  if (rows.length < 2) return null;
  return (
    <section className="nx-dl-section">
      <h4>Version History</h4>
      {rows.slice(0, 5).map((v) => (
        <div key={v.id} className="nx-dl-version">
          <span>Version {v.versionNo}</span>
          <span className="nx-dl-muted">{formatDate(v.editedAt)}{v.note ? ` - ${v.note}` : ''}</span>
        </div>
      ))}
      {rows.length > 5 && <div className="nx-dl-muted">Open the document for all {rows.length} versions.</div>}
    </section>
  );
}

export default function DocumentSidePanel(props) {
  const { row, onClose, onChanged, toastOk, toastErr } = props;
  if (row.kind === 'form_entry') {
    return (
      <Suspense fallback={<aside className="nx-dl-panel" aria-label={row.title}><div className="nx-dl-muted">Opening the entry...</div></aside>}>
        <EntryPanel entry={row.entry || { id: row.entryId, title: row.title, templateId: row.templateId, status: row.entryStatus }}
          onClose={onClose} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />
      </Suspense>
    );
  }
  return <DocumentRowPanel {...props} />;
}

function DocumentRowPanel({ row, folders = [], onClose, onEdit, onOrganize, onChanged, toastOk, toastErr }) {
  const [busy, setBusy] = useState('');
  const isDoc = row.kind === 'document';
  const isHr = row.kind === 'hr';
  const completed = row.signStatus === 'completed';
  const live = row.signStatus === 'pending' || completed;

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  };

  // The sealed copy reaches a party by their own route, HR by the record's.
  const openSealed = async () => {
    const { url } = await api.downloadSign(row.signRequestId);
    window.open(url, '_blank', 'noopener');
  };
  const previewLoad = () => {
    if (isHr) return api.packetDocumentPdf(row.eventId, row.documentId);
    if (completed && row.partyId) return api.mySignFinal(row.partyId);
    return api.exportDocumentPdf(row.id);
  };
  // No inline page for a sealed copy someone reaches by a link, a pay document
  // they may not open, or an envelope with no document behind it yet.
  const canPreview = isHr
    ? !row.locked && !row.signed
    : (completed ? !!row.partyId || (isDoc && !row.canManageEnvelope) : isDoc);

  const download = () => run('download', async () => {
    if (isHr) {
      if (row.signed && row.signRequestId) return openSealed();
      return saveBlob(await api.packetDocumentPdf(row.eventId, row.documentId), row.title);
    }
    if (completed && row.partyId) return saveBlob(await api.mySignFinal(row.partyId), row.title);
    if (completed && row.canManageEnvelope) return openSealed();
    return saveBlob(await api.exportDocumentPdf(row.id), row.title);
  });

  const send = () => run('send', async () => {
    const out = await api.documentSigningPdf(row.id);
    window.__esignPrefill = { title: row.title, source: 'pdf', sourceDocumentId: row.id, parties: [], signing: out };
    go('documents-esign');
  });

  const act = (key, fn, ok) => run(key, async () => { await fn(row.id); toastOk?.(ok); await onChanged?.(); });

  const remove = async () => {
    try { await api.deleteDocument(row.id); }
    catch (e) { throw new Error(e.message || 'Action failed', { cause: e }); }
    toastOk?.('Deleted');
    onClose();
    await onChanged?.();
  };

  const openTemplate = () => { setPendingOpen('doc-template', row.templateId); go('documents-templates'); };

  const canDownload = isHr ? !row.locked : (isDoc || (completed && (row.partyId || row.canManageEnvelope)));

  return (
    <PanelShell title={row.title} onClose={onClose}
      subtitle={<StatusWord status={rowStatus(row)} />}>
      {canPreview && <PdfPreview key={`${row.id}:${row.updatedAt}`} load={previewLoad} label={`Preview of ${row.title}`} />}
      {!canPreview && completed && <div className="nx-dl-muted">Open the sealed copy to read it, with its Certificate of Completion.</div>}

      {row.locked && (
        <div className="nx-dl-muted nx-dl-lock"><Lock size={13} /> This document shows pay. Opening it needs Pay &amp; Benefits access.</div>
      )}

      <div className="nx-dl-actions">
        {row.myTurn && <button type="button" className="primary-btn" onClick={() => go('documents-esign')}>Sign</button>}
        {isDoc && (
          <button type="button" className={row.myTurn ? 'secondary-btn' : 'primary-btn'} onClick={() => onEdit(row.id)}>Open</button>
        )}
        {row.signStatus === 'pending' && row.canManageEnvelope && (
          <button type="button" className="secondary-btn" disabled={busy === 'remind'}
            onClick={() => run('remind', async () => { const r = await api.remindSign(row.signRequestId); toastOk?.(`Reminded ${r.reminded}`); })}>
            {busy === 'remind' ? 'Reminding...' : 'Remind'}
          </button>
        )}
        {canDownload && (
          <button type="button" className="secondary-btn" disabled={busy === 'download'} onClick={download}>
            {busy === 'download' ? 'Preparing...' : (isHr && row.signed) || (completed && !row.partyId && row.canManageEnvelope) ? 'Open Signed Copy' : 'Download'}
          </button>
        )}
        {isDoc && row.canManage && !live && row.status !== 'archived' && (
          <button type="button" className="secondary-btn" disabled={busy === 'send'} onClick={send}>
            {busy === 'send' ? 'Preparing...' : 'Send For Signature'}
          </button>
        )}
        {pdfLoadFor(row) && (
          <button type="button" className="secondary-btn" onClick={() => openRowInPdfTools(row)}>Open In PDF Tools</button>
        )}
        {row.signRequestId && !isHr && (
          <button type="button" className="secondary-btn" onClick={() => go(row.canManageEnvelope ? 'documents-esign-requests' : 'documents-esign')}>View In Nexus Sign</button>
        )}
        {isHr && row.templateId && <button type="button" className="secondary-btn" onClick={openTemplate}>Open Template</button>}
      </div>

      <Signatures row={row} />
      <Details row={row} folders={folders} />
      {isDoc && <Versions key={row.id} docId={row.id} />}
      {isHr && <div className="nx-dl-muted">Generated by an HR packet. To change the wording, open the template.</div>}

      {isDoc && (
        <section className="nx-dl-section">
          <h4>More</h4>
          <div className="nx-dl-actions">
            {row.canManage && <button type="button" className="secondary-btn" onClick={() => onOrganize(row)}>Folder And Tags</button>}
            <button type="button" className="secondary-btn" disabled={busy === 'dup'} onClick={() => act('dup', api.duplicateDocument, 'Duplicated')}>Duplicate</button>
            {row.canManage && (row.status === 'archived'
              ? <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => act('arc', api.restoreDocument, 'Restored')}>Restore</button>
              : <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => act('arc', api.archiveDocument, 'Archived')}>Archive</button>)}
            {row.canManage && row.status === 'draft' && (
              <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete ${row.title}`}
                fallbackMessage={`Delete "${row.title}"? This can't be undone.`} onConfirm={remove} />
            )}
          </div>
        </section>
      )}
    </PanelShell>
  );
}
