import { useEffect, useRef, useState } from 'react';
import { Folder, FileText, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { useDialogFocus, dialogKeyDown } from '../lib/useDialogFocus';

// ── Shared Egnyte file picker modal (Documents module) ───────────────────────
// Used from both DocumentsBrowser.jsx's CreateDocModal and DocumentBuilder.jsx's
// Import popover - folder-at-a-time browse, pick a supported file, and it's
// handed back as a real File (same shape a local <input type=file> pick gives),
// so callers feed it into the exact same importDocumentFile() pipeline either
// way. Read-only - never writes to Egnyte (that's esign.py's separate,
// already-existing _egnyte_push() archival feature).
//
// PDF Tools (views/pdfTools/) uses the same picker over the Egnyte module's own
// listing, to open and to choose a folder to save in: `browse`, `canPick`,
// `onFileClick` (a click hands back the row, nothing is fetched here), `footer`
// ({ path, loading, files }) and `describeError` change that. With none of them
// passed it is the importer's picker, as it always was.
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = { background: 'var(--card)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };

const SUPPORTED = (f) => f.supported;

export default function EgnyteBrowser({
  onPick, onClose, title = 'Browse Egnyte', browse = api.egnyteBrowse, fetchFile = api.egnyteFetchFile,
  canPick = SUPPORTED, pickHint = 'Unsupported file type for import', describeError, startPath = '', onFileClick, footer,
}) {
  const panelRef = useRef(null);
  useDialogFocus(panelRef);
  const [path, setPath] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fetchingPath, setFetchingPath] = useState('');

  const load = (p, orRoot = false) => {
    setLoading(true);
    setError('');
    browse(p).then(d => { setData(d); setPath(p); setLoading(false); })
      .catch(e => {
        // A remembered start folder that has gone is not worth an error.
        if (orRoot && p) { load(''); return; }
        if (describeError) setError(describeError(e));
        else setError(e.status === 503
          ? "Egnyte isn't connected yet - ask an admin to configure it."
          : (e.message || 'Could not browse Egnyte'));
        setLoading(false);
      });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(startPath, !!startPath); }, []);

  const pickFile = (file) => {
    setFetchingPath(file.path);
    fetchFile(file.path)
      .then(({ blob }) => {
        onPick(new File([blob], file.name, { type: blob.type || 'application/octet-stream' }));
      })
      .catch(e => setError(e.message || 'Could not fetch that file'))
      .finally(() => setFetchingPath(''));
  };

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div ref={panelRef} className="nx-popup" style={cardStyle} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
          dialogKeyDown(e);
        }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={16} /></button>
        </div>

        {!error && (
          <div style={{ padding: '8px 18px', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
            <button onClick={() => load('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: path ? 'var(--muted)' : 'var(--ink)', fontWeight: path ? 400 : 700, padding: 0 }}>root</button>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ChevronRight size={11} />
                <button onClick={() => load(crumbs.slice(0, i + 1).join('/'))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: i === crumbs.length - 1 ? 'var(--ink)' : 'var(--muted)', fontWeight: i === crumbs.length - 1 ? 700 : 400, padding: 0 }}>
                  {c}
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="nx-fill" style={{ flex: 1, display: 'block', overflowY: 'auto', padding: 8, minHeight: 200 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
          )}
          {!loading && error && (
            <div style={{ padding: '30px 20px', textAlign: 'center' }}>
              <AlertTriangle size={26} style={{ color: 'hsl(30,80%,48%)', marginBottom: 10 }} />
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>{error}</div>
              <button type="button" className="secondary-btn" style={{ marginTop: 12 }} onClick={() => load(path)}>Try Again</button>
            </div>
          )}
          {!loading && !error && data && (
            <>
              {data.folders.length === 0 && data.files.length === 0 && (
                <div style={{ padding: 30, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>Empty folder.</div>
              )}
              {data.folders.map(f => (
                <button key={f.path} onClick={() => load(f.path)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' }}>
                  <Folder size={15} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} /> {f.name}
                </button>
              ))}
              {data.files.map(f => (
                <button key={f.path} onClick={() => canPick(f) && (onFileClick ? onFileClick(f) : pickFile(f))} disabled={!canPick(f) || !!fetchingPath}
                  title={canPick(f) ? '' : pickHint}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', borderRadius: 8, cursor: canPick(f) ? 'pointer' : 'default', fontSize: 13, color: canPick(f) ? 'var(--ink)' : 'var(--muted)', opacity: canPick(f) ? 1 : 0.55 }}>
                  {fetchingPath === f.path ? <Spinner size={15} style={{ flexShrink: 0 }} /> : <FileText size={15} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
        {footer?.({ path, loading, files: data?.files || [] })}
      </div>
    </div>
  );
}
