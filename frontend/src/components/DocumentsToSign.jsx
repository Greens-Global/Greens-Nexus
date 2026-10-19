// Documents to Sign (Oct 18 2026): every Nexus Sign document where it is the
// signed-in person's turn, signed right here on Workday. Documents needs an
// Access Group grant a plain employee does not hold, so the bell and the
// email used to end on Access Restricted and the employee could never sign
// (the same gap TimesheetsToReview closed for Time Sheets, which stay there -
// this card leaves them out). The bell / email open /workday/sign:<party>,
// which opens that document straight away. Nothing renders when nothing waits.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSignature, PenLine } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { SignModal } from './ESign';

export default function DocumentsToSign({ focusParty = '', toastOk, toastErr }) {
  const [rows, setRows] = useState([]);
  const [signing, setSigning] = useState(focusParty || null);
  const load = useCallback(() => {
    api.mySignatures()
      .then(r => setRows((Array.isArray(r) ? r : []).filter(x => x.myTurn && x.linkKind !== 'timesheet')))
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { if (focusParty) setSigning(focusParty); }, [focusParty]);

  const signPortal = signing && createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
      <SignModal partyId={signing} onClose={() => setSigning(null)}
        onDone={() => { setSigning(null); load(); }}
        toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
    </div>, document.body);

  if (!rows.length) return signPortal || null;
  return (
    <div style={{ marginBottom: 16, border: '1px solid var(--wk-line2)', background: 'var(--card)', borderRadius: 12, padding: '12px 16px', boxShadow: 'var(--wk-shadow)' }}>
      {signPortal}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <PenLine size={15} style={{ color: 'var(--wk-brand)' }} />
        <span style={{ fontWeight: 800, fontSize: 13.5 }}>Documents to Sign</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} waiting on your signature</span>
      </div>
      {rows.map(r => (
        <div key={r.partyId} className="nx-needs-you" style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{r.title}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Sent {formatDate(r.createdAt)}{r.from ? ` by ${r.from}` : ''}{r.expiresOn ? ` · expires ${formatDate(r.expiresOn)}` : ''}
            </div>
          </div>
          <button type="button" className="primary-btn" onClick={() => setSigning(r.partyId)}
            style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <FileSignature size={13} /> Review & Sign
          </button>
        </div>
      ))}
    </div>
  );
}
