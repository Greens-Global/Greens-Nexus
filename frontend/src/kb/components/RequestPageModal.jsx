import { useState } from 'react';
import { Modal } from '../../tasks/components';
import { api } from '../../api';
import { useToast, errText } from './Toast';

export default function RequestPageModal({ collections = [], initialQuery = '', onClose }) {
  const [q, setQ] = useState(initialQuery);
  const [note, setNote] = useState('');
  const [col, setCol] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const send = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      await api.kbRequestPage({ query: q.trim(), note, collection_id: col });
      toast('Request sent. The collection owner has been notified.');
      onClose();
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const tops = collections.filter((c) => !c.parent_id);
  return (
    <Modal title="Request a Page" onClose={onClose} minHeight="40vh"
           footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={onClose}>Cancel</button><button type="button" className="kb-btn pri" disabled={busy || !q.trim()} onClick={send}>Send Request</button></div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="kb-field"><label>What were you looking for?</label><input className="kb-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="How to issue a refund for a double charge" autoFocus /></div>
        <div className="kb-field"><label>Which collection should it live in?</label>
          <select className="kb-select" value={col} onChange={(e) => setCol(e.target.value)}><option value="">Not sure</option>{tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="kb-field"><label>Anything else</label><textarea className="kb-textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you tried, who usually knows this" /></div>
        <div className="kb-help">The owner gets a bell and a line in their Monday digest. You hear back when the page is written.</div>
      </div>
    </Modal>
  );
}
