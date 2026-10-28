// Add Time From Record's tag on a Time Sheet day (Oct 27 2026): a day HR
// keyed in from a record kept outside Nexus (a paper time sheet) says
// "Entered By HR From Record" with the batch's reason - the employee sees
// both. HR also gets the source document (the server sends `docName` on
// card.recordBatches only to HR; the link is a five-minute signed one).
import { ClipboardList, Paperclip } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';

export default function RecordTag({ recs, batches = [], toastErr }) {
  if (!recs?.length) return null;
  const byId = Object.fromEntries((batches || []).map((b) => [b.id, b]));
  const open = async (id) => {
    // The tab opens before the fetch so the browser does not treat it as a pop-up.
    const tab = window.open('', '_blank');
    try {
      const r = await api.timeRecordSourceDocUrl(id);
      if (tab && r?.url) tab.location.href = r.url; else if (r?.url) window.open(r.url, '_blank', 'noopener');
    } catch (e) { tab?.close(); toastErr?.(e?.message || 'Could not open the source document.'); }
  };
  return (
    <span data-record-tag style={{ display: 'grid', gap: 2 }}>
      {recs.map((r) => {
        const b = byId[r.batchId] || {};
        const when = b.at ? formatDateTime(b.at.endsWith('Z') ? b.at : `${b.at}Z`) : '';
        return (
          <span key={r.batchId || r.reason} style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 }}
            title={[b.by ? `Entered by ${b.by}` : '', when].filter(Boolean).join(' on ') || undefined}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, color: '#1d4ed8', background: 'rgba(29,78,216,0.08)', padding: '1px 7px', borderRadius: 6, whiteSpace: 'nowrap' }}>
              <ClipboardList size={11} /> Entered By HR From Record
            </span>
            {r.reason && <span style={{ color: 'var(--muted)', fontStyle: 'italic', minWidth: 0 }}>{r.reason}</span>}
            {b.docName && (
              <button type="button" onClick={() => open(r.batchId)} title={`Open ${b.docName}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand, #15803d)', fontWeight: 700, font: 'inherit', fontSize: 11.5 }}>
                <Paperclip size={11} /> Source Document
              </button>
            )}
          </span>
        );
      })}
    </span>
  );
}
