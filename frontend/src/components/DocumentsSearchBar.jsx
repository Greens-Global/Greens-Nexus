import { useEffect, useRef, useState } from 'react';
import { Search, FileText, LayoutTemplate, PenTool, Loader2 } from 'lucide-react';
import { api } from '../api';

// ── Cross-module search (Phase 6) ────────────────────────────────────────────
// Mounted in Documents.jsx's header — visible across Dashboard/My Documents/
// Templates/E-Sign. Debounced query against GET /documents/search, which
// unifies Document + DocTemplate + (permission-gated) HrSignRequest matches.
const TYPE_META = {
  document: { label: 'Document', Icon: FileText, color: 'hsl(var(--color-blue))' },
  template: { label: 'Template', Icon: LayoutTemplate, color: 'hsl(var(--color-orange))' },
  esign:    { label: 'E-Sign',   Icon: PenTool,        color: 'hsl(var(--color-green))' },
};

export default function DocumentsSearchBar({ onOpenDocument, onOpenTemplate, onGoToEsignRequests }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); setOpen(false); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      api.searchDocuments(q.trim()).then(r => { setResults(r); setOpen(true); }).catch(() => setResults([])).finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  useEffect(() => {
    const onClickOutside = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const pick = (r) => {
    setOpen(false); setQ('');
    if (r.type === 'document') onOpenDocument?.(r.id);
    else if (r.type === 'template') onOpenTemplate?.(r.id);
    else onGoToEsignRequests?.();
  };

  const grouped = ['document', 'template', 'esign'].map(type => ({
    type, items: (results || []).filter(r => r.type === type),
  })).filter(g => g.items.length);

  return (
    <div ref={boxRef} style={{ position: 'relative', minWidth: 220 }}>
      <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
      <input className="form-input" style={{ width: '100%', fontSize: 12.5, paddingLeft: 30 }}
        placeholder="Search documents, templates, e-sign…" value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)} />
      {loading && (
        <Loader2 size={13} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', animation: 'spin 1s linear infinite' }} />
      )}
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 30, maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {grouped.length === 0 ? (
            <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--muted)' }}>No matches.</div>
          ) : grouped.map(g => {
            const meta = TYPE_META[g.type];
            return (
              <div key={g.type} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '6px 8px 2px' }}>{meta.label}</div>
                {g.items.map(r => (
                  <button key={r.id} onClick={() => pick(r)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '7px 8px', borderRadius: 6, cursor: 'pointer' }}>
                    <meta.Icon size={13} style={{ color: meta.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                    {r.subtitle && <span style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.subtitle}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
