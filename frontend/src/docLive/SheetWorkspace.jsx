// A Sheet opened from Documents (Neil, 11/05/2026, routers/documents.py
// "Working together"). The workbook engine is frontend/src/sheets (loaded with
// this page); this file is the frame around it: the title, Share, who is here,
// the save state, and the live session (docLive/useLiveSession.js). An editor
// always works in the live session - alone it is just the save path; a viewer
// sees the saved copy and follows saves (GET /head every 10 s).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Users } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { usePeople } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import FullScreenButton, { useFullScreen } from '../components/FullScreenButton';
import { SheetEditor, seedSheetDoc, snapshotOf, validateSheetDoc } from '../sheets';
import { useLiveSession, useHeadPoll } from './useLiveSession';
import ShareDocumentDialog, { LivePeople } from './ShareDocumentDialog';
import { caretColor } from '../notes/useNoteCollab';
import './docLive.css';

const SAVE_MS = 1200;
const SAVE_WORD = { saving: 'Saving...', saved: 'Saved', error: 'Not Saved - Retrying' };

export default function SheetWorkspace({ docId, onClose, toastOk, toastErr }) {
  const { myEmail } = useRole();
  const people = usePeople();
  const me = (myEmail || '').toLowerCase();
  const myName = people.find((p) => p.email === me)?.name || me;
  const [row, setRow] = useState(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [full, toggleFull] = useFullScreen('documents-sheet');

  const load = useCallback(() => api.getDocument(docId)
    .then((r) => { setRow(r); setTitle(r.title || ''); setError(''); })
    .catch((e) => setError(e?.message || 'Could not open this sheet.')), [docId]);
  useEffect(() => { load(); }, [load]);

  const canEdit = !!row && row.access !== 'view' && row.status === 'draft';
  const live = useLiveSession({ docId, enabled: canEdit, me, name: myName, seed: seedSheetDoc, validate: validateSheetDoc });

  // A viewer (or an editor whose live session could not start) reads the saved copy.
  const readDoc = useMemo(() => {
    if (!row || (canEdit && live.status !== 'failed')) return null;
    try { const d = seedSheetDoc(row.content); validateSheetDoc(d); return d; } catch { return null; }
  }, [row, canEdit, live.status]);
  const moved = useHeadPoll(docId, row?.currentVersion, !!row && !canEdit);
  useEffect(() => { if (moved) load(); }, [moved, load]);

  // Autosave: a local change waits SAVE_MS for the next one; a failure retries.
  const timer = useRef(0);
  const pending = useRef(false);
  const saving = useRef(null);
  const flushRef = useRef(null);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!pending.current) return saving.current;
    pending.current = false;
    setSaveState('saving');
    saving.current = live.save(snapshotOf)
      .then(() => setSaveState('saved'))
      .catch((e) => {
        if (e?.status === 403) { setSaveState(''); toastErr?.('You can only view this sheet now.'); load(); return; }
        if (e?.status === 413) { setSaveState('error'); toastErr?.(e.message); return; }
        setSaveState('error');
        pending.current = true;
        timer.current = setTimeout(() => flushRef.current?.(), 5000);
      });
    return saving.current;
  }, [live, toastErr, load]);
  useEffect(() => { flushRef.current = flush; }, [flush]);
  const onChange = useCallback(() => {
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), SAVE_MS);
  }, [flush]);
  useEffect(() => {
    const warn = (e) => { if (pending.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); clearTimeout(timer.current); };
  }, []);
  const close = async () => { try { await flush(); } catch { /* the toast said so */ } onClose?.(); };

  const saveTitle = async () => {
    const t = title.trim();
    if (!t || !row || t === row.title) { setTitle(row?.title || ''); return; }
    try { const out = await api.updateDocument(docId, { title: t }); setRow((r) => ({ ...r, title: out.title })); }
    catch (e) { toastErr?.(e?.message || 'Could not rename the sheet.'); setTitle(row.title); }
  };

  if (error) return <div style={{ padding: 20 }}><ErrorBanner message={error} /><button type="button" className="secondary-btn" onClick={onClose} style={{ marginTop: 12 }}>Back</button></div>;
  if (!row) return <SkeletonBlocks count={8} height={36} />;

  const doc = canEdit && live.status !== 'failed' ? live.doc : readDoc;
  const word = !canEdit ? (row.access === 'view' ? 'View Only' : 'Read Only') : SAVE_WORD[saveState] || '';

  return (
    <div className="dl-sheet-page">
      <div className="dl-sheet-head">
        <button type="button" className="dl-icon-btn" aria-label="Back to Documents" title="Back to Documents" onClick={close}><ArrowLeft size={18} /></button>
        <input className="dl-sheet-title" value={title} disabled={!canEdit} aria-label="Sheet name" maxLength={200}
          onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setTitle(row.title); e.currentTarget.blur(); } }} />
        <span className="dl-sheet-save" aria-live="polite">{word}</span>
        {canEdit && <LivePeople peers={live.peers} status={live.status} />}
        <button type="button" className="secondary-btn" onClick={() => setShareOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Users size={14} /> Share
        </button>
        <FullScreenButton on={full} onToggle={toggleFull} className="dl-icon-btn" />
      </div>
      {canEdit && live.status === 'failed' && (
        <div className="dl-sheet-note" role="status">
          Live editing could not start, so this is the saved copy, read only.
          <button type="button" className="secondary-btn" onClick={live.restart}>Try Again</button>
        </div>
      )}
      <div className="dl-sheet-body">
        {doc
          ? <SheetEditor key={doc.guid} doc={doc} awareness={canEdit ? live.awareness : null} canEdit={canEdit && !!live.doc}
              me={{ email: me, name: myName, color: caretColor(me) }} title={row.title} onChange={onChange} toastErr={toastErr} />
          : <div style={{ padding: 16 }}><SkeletonBlocks count={10} height={28} /></div>}
      </div>
      {shareOpen && (
        <ShareDocumentDialog doc={row} canManage={row.access === 'owner'} onClose={() => setShareOpen(false)}
          onChanged={(out) => { if (out) setRow((r) => ({ ...r, sharedWith: out.sharedWith || [] })); toastOk?.('Sharing updated'); }} />
      )}
    </div>
  );
}
