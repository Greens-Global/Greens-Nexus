// Open From Documents: the library rows that have a PDF this person can fetch
// (lib/pdfToolsHandoff.js decides, the same rule as the side panel's preview).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { SkeletonBlocks } from '../../components/AsyncState';
import { StatusWord } from '../../components/DocumentSidePanel';
import { mergeRows, rowStatus } from '../../lib/documentLibrary';
import { documentTarget } from '../../lib/pdfToolsHandoff';
import { formatDate } from '../../lib/datetime';

export default function OpenFromDocuments({ onPick, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getDocumentLibrary(), api.listPacketDocuments({}).catch(() => [])])
      .then(([library, hr]) => {
        if (!alive) return;
        setError('');
        setRows(mergeRows(library, hr).filter((row) => !!documentTarget(row)));
      })
      .catch(() => { if (alive) setError('Could not load your documents. Try again in a moment.'); });
    return () => { alive = false; };
  }, [attempt]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows || [];
    return (rows || []).filter((row) => String(row.title || '').toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <Modal title="Open From Documents" onClose={onClose} placement="center">
      <input type="search" className="form-input" placeholder="Search documents" aria-label="Search documents"
        value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 12 }} />
      <div className="nx-fill" style={{ display: 'block', overflowY: 'auto', minHeight: 200 }}>
        {error && (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
            <div>{error}</div>
            <button type="button" className="secondary-btn" style={{ marginTop: 12 }}
              onClick={() => { setError(''); setRows(null); setAttempt((n) => n + 1); }}>Try Again</button>
          </div>
        )}
        {!error && rows === null && <SkeletonBlocks count={6} height={40} borderRadius={8} />}
        {!error && rows !== null && shown.length === 0 && (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
            {q.trim() ? 'No document matches that search.' : 'There are no documents with a PDF to open.'}
          </div>
        )}
        {!error && shown.map((row) => (
          <button key={row.id} type="button" onClick={() => onPick(documentTarget(row))}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--line)', padding: '10px 8px', cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
            <StatusWord status={rowStatus(row)} />
            {row.updatedAt && <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{formatDate(row.updatedAt)}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
