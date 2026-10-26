// Records Audit (Pranshu, Oct 23 2026): who is missing something HR must have
// on file, or has a document past its expiry - the same list the morning bell
// sends HR (backend hr_record_audit.py). Shown at the top of People; nothing
// is shown when every record is complete.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';

export default function RecordsAudit({ entityName, onOpen, refreshKey }) {
  const [people, setPeople] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getRecordsAudit().then(r => alive && setPeople(r.people || [])).catch(() => alive && setPeople([]));
    return () => { alive = false; };
  }, [refreshKey]);
  if (!people.length) return null;
  const n = people.length;
  return (
    <>
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid rgba(180,83,9,0.35)', background: 'rgba(180,83,9,0.07)', borderRadius: 12, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
        <AlertTriangle size={15} style={{ color: '#b45309', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 200 }}>
          <b>Records Audit:</b> {n} {n === 1 ? 'person is' : 'people are'} missing something on file or {n === 1 ? 'has' : 'have'} an expired document.
        </span>
        <button type="button" className="secondary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12.5 }}>Review</button>
      </div>
      {open && (
        <Modal title="Records Audit" onClose={() => setOpen(false)}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
            Checked every morning. HR&apos;s department head and backup get one notification per company until these are fixed. Click a person to open their profile.
          </div>
          <div className="nx-fill" style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            {people.map(p => (
              <button key={p.id} type="button" onClick={() => { setOpen(false); onOpen?.(p.id); }}
                style={{ textAlign: 'left', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px', background: 'var(--card)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>
                  {p.name} <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}>{[p.jobTitle, entityName?.(p.company)].filter(Boolean).join(' - ')}</span>
                </div>
                <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 3 }}>{p.gaps.join(', ')}</div>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
