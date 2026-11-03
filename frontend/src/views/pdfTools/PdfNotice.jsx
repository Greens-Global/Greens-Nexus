// A note over the editor for what happened to the open file: saved and where,
// or why not, with the way forward. It stays until dismissed or replaced - a
// failure here means the document has not gone anywhere, and it has to be read.
import { ExternalLink } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';

const COLOR = {
  ok: 'hsl(var(--color-green))',
  error: 'hsl(var(--color-red))',
  info: 'var(--muted)',
};

export default function PdfNotice({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <div role={notice.tone === 'error' ? 'alert' : 'status'} style={{
      position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 3,
      width: 'fit-content', maxWidth: 'calc(100% - 32px)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
      background: 'var(--card)', color: 'var(--ink)', border: '1px solid var(--line)',
      borderLeft: `3px solid ${COLOR[notice.tone] || COLOR.info}`, borderRadius: 6,
      boxShadow: 'var(--shadow-lg)', padding: '10px 14px', fontSize: 13, overflowWrap: 'anywhere',
    }}>
      {notice.busy && <Spinner size={14} />}
      <span>{notice.text}</span>
      {notice.link && (
        <a href={notice.link} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
          Open In Egnyte <ExternalLink size={13} aria-hidden="true" />
        </a>
      )}
      {notice.retry && <button type="button" className="secondary-btn" onClick={notice.retry}>Try Again</button>}
      {notice.pickFolder && <button type="button" className="secondary-btn" onClick={notice.pickFolder}>Choose Another Folder</button>}
      {!notice.busy && <button type="button" className="secondary-btn" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}
