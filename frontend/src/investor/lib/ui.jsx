import { useCallback, useEffect, useState } from 'react';
import { Loader, X } from 'lucide-react';
import { statusColor, statusLabel } from './format';

// ── Status as colored text + small solid dot ─────────────────────────────────
// This is the ONLY status treatment in the module - tinted chip/pill badges
// are banned app-wide (flat editorial style).
export function StatusText({ status, label, size = 12.5 }) {
  const color = statusColor(status);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color, fontSize: size, fontWeight: 600 }}>{label || statusLabel(status)}</span>
    </span>
  );
}

// Thin flat progress bar - a hairline track, never a pill badge.
export function ThinBar({ value = 0, max = 0, color = 'hsl(var(--color-blue))', height = 4 }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (Number(value) / Number(max)) * 100)) : 0;
  return (
    <div style={{ height, borderRadius: height, background: 'var(--line)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: height }} />
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '48px 0', color: 'var(--muted)', fontSize: 13 }}>
      <Loader size={15} style={{ animation: 'spin 0.8s linear infinite' }} /> {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid hsla(var(--color-red), 0.4)', borderRadius: 10, padding: '10px 14px', margin: '8px 0' }}>
      <span style={{ fontSize: 13, color: 'hsl(var(--color-red))', flex: 1 }}>{message || 'Something went wrong.'}</span>
      {onRetry && <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px', flexShrink: 0 }} onClick={onRetry}>Retry</button>}
    </div>
  );
}

// Dashed empty-state card (matches the HR.jsx idiom).
export function EmptyState({ icon: Icon, title, sub, children }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
      {Icon && <Icon size={32} style={{ opacity: 0.25, display: 'block', margin: '0 auto 10px' }} />}
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
      {sub && <div style={{ fontSize: 12.5, marginTop: 4, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>{sub}</div>}
      {children && <div style={{ marginTop: 16 }}>{children}</div>}
    </div>
  );
}

// Standard modal chrome - children supply the form (form-grid / modal-footer).
export function Modal({ title, onClose, width, children }) {
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" style={width ? { maxWidth: width } : undefined}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// form-group wrapper: <FG label="Deal Name" full>…input…</FG>
export function FG({ label, full, children }) {
  return (
    <div className={`form-group${full ? ' form-group-full' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  );
}

// People picker fed by the curated Nexus People directory
// (api.getPeopleDirectory → /myhr/directory) - never M365/GAL lists.
export function PeopleSelect({ value, onChange, people, placeholder = 'Select a person…' }) {
  return (
    <select className="form-select" value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {(people || []).map(p => (
        <option key={p.email} value={p.email}>{p.name ? `${p.name} - ${p.email}` : p.email}</option>
      ))}
    </select>
  );
}

// Local list-fetch hook: loading / error / reload, no global state. Pass the
// values your fetcher closes over as deps so filter changes refetch.
export function useIrLoad(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setLoading(true); setError('');
    return fetcher()
      .then(d => setData(d))
      .catch(e => setError(e?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/use-memo
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload };
}
