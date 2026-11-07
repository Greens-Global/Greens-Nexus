// Record Card picker (Neil, 11/07/2026 - Macro's canvas with @links). Find a
// task, ticket, note, job or Knowledge Base page - the same search the [[
// link uses (notes/recordLink.jsx useRecordSearch, no second index) - and
// put it on the board as a card that opens it.
import { useState } from 'react';
import { Modal } from '../../../tasks/components';
import { btn } from '../../../tasks/theme';
import { useRecordSearch, RECORD_META } from '../../recordLink';

export default function RecordCardSheet({ onPick, onClose, noteId = '' }) {
  const [q, setQ] = useState('');
  const { rows, loading } = useRecordSearch(q, noteId);
  const footer = <button type="button" style={btn('outline')} onClick={onClose}>Cancel</button>;
  return (
    <Modal title="Add a Record Card" onClose={onClose} footer={footer} zIndex={4200}>
      <div className="nx-rc">
        <input className="nx-rc-q" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search tasks, tickets, notes, jobs and pages" aria-label="Search for a record" />
        <div className="nx-rc-hint">The card opens the record, and the record lists this board under Mentioned In. A task card shows whether it is done.</div>
        <div className="nx-rc-list nx-fill" role="listbox" aria-label="Records">
          {rows.map((r) => {
            const meta = RECORD_META[r.kind] || RECORD_META.note;
            const Icon = meta.icon;
            return (
              <button key={r.key} type="button" role="option" aria-selected="false" className="nx-rc-row" onClick={() => onPick(r)}>
                <Icon size={16} aria-hidden="true" />
                <span className="nx-rc-name">{r.title}</span>
                <span className="nx-rc-detail">{r.detail || meta.label}</span>
              </button>
            );
          })}
          {!rows.length && <div className="nx-rc-empty">{loading ? 'Searching…' : q.trim().length < 2 ? 'Type two letters or more to search tasks, tickets, jobs and pages.' : `Nothing matches "${q.trim()}"`}</div>}
        </div>
      </div>
    </Modal>
  );
}
