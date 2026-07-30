// Egnyte module - upload into the folder currently on screen.
//
// This is the owner's core ask: "they can upload and pull directly and at the
// right folder level." The destination is always the folder the user is looking
// at, so a file lands where it belongs instead of in a generic inbox that
// somebody re-files by hand later. Bytes go straight to Egnyte through the API;
// Nexus never keeps a copy.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Upload } from 'lucide-react';
import { api } from '../api';
import { egnyteErrorMessage, filesFromPaste } from './lib';
import { BODY, Notice, Spinner } from './ui';

export default function EgnyteUpload({ folder, canWrite, onUploaded, compact = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(null);      // { done, total }
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const dragDepth = useRef(0);

  const send = useCallback(async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !canWrite) return;
    setError('');
    setDone('');
    let ok = 0;
    for (let i = 0; i < list.length; i += 1) {
      setBusy({ done: i, total: list.length });
      try {
        // Sequential on purpose: one file at a time keeps the progress count
        // honest and avoids firing N large multipart uploads at Egnyte at once.
        await api.egnyteUpload(folder, list[i]);
        ok += 1;
      } catch (err) {
        setError(egnyteErrorMessage(err, `Could not upload ${list[i].name}.`));
        break;
      }
    }
    setBusy(null);
    if (ok) {
      setDone(ok === 1 ? `Uploaded ${list[0].name}.` : `Uploaded ${ok} files.`);
      onUploaded?.();
    }
  }, [folder, canWrite, onUploaded]);

  // Ctrl+V anywhere on the screen drops the clipboard into the open folder
  // (CLAUDE.md: every upload widget accepts a paste). Listening on window rather
  // than on the zone means the user does not have to click the box first, which
  // is the whole point of a paste shortcut. Pastes aimed at a real text field
  // are left alone.
  useEffect(() => {
    if (!canWrite) return undefined;
    const onPaste = (e) => {
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      const files = filesFromPaste(e);
      if (files.length) { e.preventDefault(); send(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canWrite, send]);

  if (!canWrite) {
    return (
      <div style={{ ...BODY, fontSize: 12, color: 'var(--wk-faint)', padding: compact ? '6px 0' : '10px 0' }}>
        You have read-only access to Egnyte. Uploading needs supervisor access.
      </div>
    );
  }

  const uploading = !!busy;

  return (
    <div>
      <div
        onDragEnter={e => { e.preventDefault(); dragDepth.current += 1; setDragging(true); }}
        onDragOver={e => { e.preventDefault(); }}
        // dragDepth counts enter/leave pairs: crossing a child element fires a
        // leave on the parent, which used to make the highlight flicker off
        // while the pointer was still inside the zone.
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); send(e.dataTransfer?.files); }}
        onClick={() => !uploading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          padding: compact ? '14px 12px' : '20px 16px',
          borderRadius: 'var(--wk-r)',
          border: `2px dashed ${dragging ? 'var(--wk-brand)' : 'var(--wk-line)'}`,
          background: dragging ? 'var(--wk-brand-tint)' : 'var(--wk-hover)',
          cursor: uploading ? 'default' : 'pointer',
          textAlign: 'center',
          transition: 'border-color .15s, background .15s',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={e => { send(e.target.files); e.target.value = ''; }}
        />
        {uploading ? <Spinner size={16} /> : <Upload size={16} style={{ color: 'var(--wk-dim)', flexShrink: 0 }} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--wk-ink)' }}>
            {uploading ? `Uploading ${busy.done + 1} of ${busy.total}…` : 'Upload File'}
          </div>
          {!uploading && (
            <div style={{ ...BODY, fontSize: 11.5, marginTop: 2 }}>
              Drop files here or click to choose, or press Ctrl+V to paste from the clipboard.
            </div>
          )}
        </div>
      </div>

      {(error || done) && (
        <div style={{ marginTop: 8 }}>
          {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
          {!error && done && (
            <Notice tone="success" onDismiss={() => setDone('')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} /> {done}
              </span>
            </Notice>
          )}
        </div>
      )}
    </div>
  );
}
