// "Update status" dialog for a single Development Timeline row. Kept separate from the row's
// main edit form (SimpleRowModal, ../shared/SimpleRowModal.jsx) because a status change requires
// a reason + effective date — status is NOT one of the plain editable fields in that form (it's
// filtered out there).
//
// Called from the asset page's "Development Timeline" tab via the Status column's chip button
// (see SimpleRecordTable's onStatusClick, ../shared/SimpleRecordTable.jsx).
//
// IMPORTANT for integration: onSave is called with THREE args — (status, date, reason) — since
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
  const [reason, setReason] = useState('');

  const handleSave = () => {
    if (!status) {
      alert('Please pick a status.');
      return;
    }
    if (!reason.trim()) {
      alert('Please give a reason for the status change.');
      return;
    }
    onSave(status, date, reason.trim());
  };

  return (
    <Modal
      title="Update status"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={handleSave}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-group">
          <label>Status</label>
          <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Select…</option>
            {TIMELINE_STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Date</label>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-group form-group-full">
          <label>
            Reason <span style={{ color: 'hsl(var(--color-red))' }}>*</span>
          </label>
          <textarea
            className="form-input"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is the status changing?"
          />
        </div>
      </div>
    </Modal>
  );
}
