// A Sheet's Version History (Neil, 11/05/2026): every kept copy, newest first,
// and Restore for editors. Restoring saves the old copy as a NEW version
// outside the live session on purpose - the server drops the shared state, so
// everyone's session (this one too) reopens on the restored copy - and the
// copies after it stay in the history, so a restore is never a loss.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { seedSheetDoc, validateSheetDoc } from '../sheets';

export default function SheetHistoryDialog({ docId, canRestore, nameOf, onClose, onRestored }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api.getDocumentVersions(docId).then((r) => setRows(Array.isArray(r) ? r : [])).catch((e) => { setRows([]); setError(e.message || 'Could not load the history.'); });
  }, [docId]);

  const restore = async (v) => {
    const ok = await dialog.confirm(`Restore version ${v.versionNo}? Everyone working in the sheet moves to that copy. The newer copies stay in this list.`, { confirmText: 'Restore' });
    if (!ok) return;
    setBusy(v.id); setError('');
    try {
      const full = await api.getDocumentVersion(docId, v.id);
      validateSheetDoc(seedSheetDoc(full.content));     // never put back a copy that cannot open
      await api.updateDocument(docId, { content: full.content, note: `Restored from v${v.versionNo}` });
      onRestored?.(v);
    } catch (e) {
      setError(e?.message?.startsWith('Not a sheet') ? 'That copy could not be opened, so it was not restored.' : (e.message || 'Could not restore it.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title="Version History" onClose={onClose} footer={<button type="button" className="secondary-btn" onClick={onClose}>Close</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, flex: '1 1 auto' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
          A copy is kept when someone starts working in the sheet and every ten minutes while they do.
        </p>
        {error && <ErrorBanner message={error} />}
        {!rows ? <SkeletonBlocks count={6} height={40} /> : (
          <div className="nx-fill" style={{ overflowY: 'auto', minHeight: 0, border: '1px solid var(--line)', borderRadius: 10 }}>
            {rows.length === 0 && <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)' }}>No earlier copies yet.</div>}
            {rows.map((v, i) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderTop: i ? '1px solid var(--line)' : 0, fontSize: 13 }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>Version {v.versionNo}{i === 0 ? ' - Latest' : ''}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {formatDateTime(v.editedAt)} - {nameOf?.(v.editedBy) || v.editedBy}{v.note ? ` - ${v.note}` : ''}
                  </div>
                </div>
                {canRestore && i > 0 && (
                  <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => restore(v)}>
                    {busy === v.id ? 'Restoring...' : 'Restore'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
