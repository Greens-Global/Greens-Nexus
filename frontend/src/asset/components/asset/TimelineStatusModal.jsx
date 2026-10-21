// "Update status" dialog for a single Development Timeline row. Kept separate from the row's
// main edit form (SimpleRowModal, ../shared/SimpleRowModal.jsx) because a status change requires
// a reason + effective date - status is NOT one of the plain editable fields in that form (it's
// filtered out there).
//
// Called from the asset page's "Development Timeline" tab via the Status column's chip button
// (see SimpleRecordTable's onStatusClick, ../shared/SimpleRecordTable.jsx).
//
// IMPORTANT for integration: onSave is called with THREE args - (status, date, reason) - since
// the original app requires a reason for every timeline status change (recorded in the activity
// log). Any caller must persist all three, not just status/date.

import { useState } from 'react';
import { Modal } from '../shared/Modal.jsx';
import { TIMELINE_STATUS_OPTIONS } from '../../lib/timelineFields.js';

/**
 * @param current  the row's current status string (pre-fills the select)
 * @param onSave   (status, date, reason) => void
 * @param onClose  () => void
 */
export function TimelineStatusModal({ current, onSave, onClose }) {
  const [status, setStatus] = useState(current || '');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [initialDate] = useState(date);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});

  const handleSave = () => {
    const next = {};
    if (!status) next.status = 'Pick a status.';
    if (!reason.trim()) next.reason = 'A reason is required.';
    setErrors(next);
    if (next.status || next.reason) return;
    onSave(status, date, reason.trim());
  };
  const errLine = (k) => errors[k] ? <div role="alert" style={{ fontSize: '0.76rem', fontWeight: 600, color: 'hsl(var(--color-red))', marginTop: 4 }}>{errors[k]}</div> : null;
  const dirty = status !== (current || '') || date !== initialDate || !!reason.trim();

  return (
    <Modal
      title="Update Status"
      onClose={onClose}
      isDirty={dirty}
      onSave={handleSave}
      footer={
        <>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={handleSave}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-group">
          <label htmlFor="timeline-status">Status</label>
          <select id="timeline-status" className="form-input" value={status} aria-invalid={errors.status ? true : undefined} onChange={(e) => { setStatus(e.target.value); setErrors((er) => ({ ...er, status: '' })); }}>
            <option value="">Select…</option>
            {TIMELINE_STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
          {errLine('status')}
        </div>
        <div className="form-group">
          <label htmlFor="timeline-date">Date</label>
          <input id="timeline-date" type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-group form-group-full">
          <label htmlFor="timeline-reason">
            Reason <span style={{ color: 'hsl(var(--color-red))' }}>*</span>
          </label>
          <textarea
            id="timeline-reason"
            className="form-input"
            rows={2}
            value={reason}
            aria-invalid={errors.reason ? true : undefined}
            onChange={(e) => { setReason(e.target.value); setErrors((er) => ({ ...er, reason: '' })); }}
            placeholder="Why is the status changing?"
          />
          {errLine('reason')}
        </div>
      </div>
    </Modal>
  );
}
