// "Keep Mine or Use Theirs?" (field offline, Neil 11/03/2026). A change made
// on the phone met a newer value on the server (a 409). Nothing is
// overwritten until the person picks: Keep Mine sends theirs-over-mine
// again (the kind's rebase), Use Theirs drops the phone's change. A
// question, so the centered card (CLAUDE.md: questions stay centered).
import { useState } from 'react';
import { Modal } from '../../tasks/components';
import { NX, FONT, btn } from '../../tasks/theme';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';

const shown = (v) => {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'Changed';
  return String(v);
};

/** Rows that differ between the phone's change and the server's value. A
 *  kind can say it better (handler.compare); this is the plain fallback:
 *  every top-level field of the change that the server holds differently. */
export function compareRows(entry, handler) {
  try {
    if (handler?.compare) return handler.compare(entry, entry.server) || [];
  } catch { /* fall back */ }
  const mine = entry?.payload && typeof entry.payload === 'object' ? (entry.payload.body || entry.payload) : {};
  const theirs = entry?.server && typeof entry.server === 'object' ? (entry.server.current || entry.server) : {};
  return Object.keys(mine)
    .filter((k) => k in theirs && JSON.stringify(mine[k]) !== JSON.stringify(theirs[k]))
    .slice(0, 12)
    .map((k) => ({ label: k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()), mine: shown(mine[k]), theirs: shown(theirs[k]) }));
}

export default function ConflictCard({ entry, handler, title, onChoose, onClose }) {
  const [busy, setBusy] = useState('');
  const rows = compareRows(entry, handler);
  const choose = async (choice) => {
    setBusy(choice);
    try { await onChoose(choice); } finally { setBusy(''); }
  };
  // Use Theirs throws the phone's change away - held, like any discard - and
  // is offered only where the kind knows how to take the server's value.
  const theirs = typeof handler?.useTheirs === 'function';
  const footer = (
    <>
      {theirs && (
        <HoldButton label="Use Theirs" doneLabel="Kept Theirs" holdMs={HOLD_RECORD_MS} icon={null} disabled={!!busy}
          fallbackMessage="Use the server's value and drop your change from this phone? It cannot be brought back."
          onConfirm={() => choose('theirs')} />
      )}
      <button type="button" style={btn('primary')} disabled={!!busy} onClick={() => choose('mine')}>Keep Mine</button>
    </>
  );
  return (
    <Modal title="Keep Mine or Use Theirs?" placement="center" width="min(520px, 92vw)" minHeight="auto" onClose={onClose} footer={footer} zIndex={4400}>
      <div style={{ fontFamily: FONT, fontSize: 13, color: NX.ink, lineHeight: 1.5 }}>
        <p style={{ margin: '0 0 10px' }}>
          {title ? <strong>{title}</strong> : 'This change'} was changed on the server while you were offline.
          {entry?.error ? ` ${entry.error}` : ''}
        </p>
        {rows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 10 }}>
            <thead>
              <tr>
                {['Field', 'Yours (on This Phone)', 'Theirs (on the Server)'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: NX.dim, fontWeight: 600, borderBottom: `1px solid ${NX.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td style={{ padding: '6px 8px', borderBottom: `1px solid ${NX.border2}`, fontWeight: 600 }}>{r.label}</td>
                  <td style={{ padding: '6px 8px', borderBottom: `1px solid ${NX.border2}` }}>{r.mine}</td>
                  <td style={{ padding: '6px 8px', borderBottom: `1px solid ${NX.border2}` }}>{r.theirs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ margin: 0, color: NX.dim, fontSize: 12.5 }}>
          {theirs
            ? 'Keep Mine sends your change over theirs. Use Theirs (press and hold) keeps what is on the server and drops your change from this phone.'
            : 'Keep Mine sends your change over theirs. To keep what is on the server instead, close this and Discard your change.'}
        </p>
      </div>
    </Modal>
  );
}
