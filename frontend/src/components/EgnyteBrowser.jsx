import { useEffect, useState } from 'react';
import { Folder, FileText, ChevronRight, Loader2, X, AlertTriangle } from 'lucide-react';
import { api } from '../api';

// ── Shared Egnyte file picker modal (Documents module) ───────────────────────
// Used from both DocumentsBrowser.jsx's CreateDocModal and DocumentBuilder.jsx's
// Import popover - folder-at-a-time browse, pick a supported file, and it's
// handed back as a real File (same shape a local <input type=file> pick gives),
// so callers feed it into the exact same importDocumentFile() pipeline either
// way. Read-only - never writes to Egnyte (that's esign.py's separate,
// already-existing _egnyte_push() archival feature).
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = { background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' };

export default function EgnyteBrowser({ onPick, onClose }) {
  const [path, setPath] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fetchingPath, setFetchingPath] = useState('');

  const load = (p) => {
    setLoading(true);
    setError('');
    api.egnyteBrowse(p).then(d => { setData(d); setPath(p); })
      .catch(e => setError(e.status === 503
        ? "Egnyte isn't connected yet - ask an admin to configure it."
        : (e.message || 'Could not browse Egnyte')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(''); }, []);

  const pickFile = (file) => {
    setFetchingPath(file.path);
    api.egnyteFetchFile(file.path)
      .then(({ blob }) => {
        onPick(new File([blob], file.name, { type: blob.type || 'application/octet-stream' }));
      })
      .catch(e => setError(e.message || 'Could not fetch that file'))
      .finally(() => setFetchingPath(''));
  };

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>Browse Egnyte</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={16} /></button>
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

        <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 200 }}>
          {loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
          )}
          {!loading && error && (
            <div style={{ padding: '30px 20px', textAlign: 'center' }}>
              <AlertTriangle size={26} style={{ color: 'hsl(30,80%,48%)', marginBottom: 10 }} />
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>{error}</div>
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
                <button key={f.path} onClick={() => f.supported && pickFile(f)} disabled={!f.supported || !!fetchingPath}
                  title={f.supported ? '' : 'Unsupported file type for import'}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', borderRadius: 8, cursor: f.supported ? 'pointer' : 'default', fontSize: 13, color: f.supported ? 'var(--ink)' : 'var(--muted)', opacity: f.supported ? 1 : 0.55 }}>
                  {fetchingPath === f.path ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} /> : <FileText size={15} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
