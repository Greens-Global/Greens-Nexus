// Item Management - The module toasts.
// One store for the whole module (Items redesign, Neil 11/02/2026): any Items
// screen, sheet or the bell's handover sheet calls itemsToast(); <ItemsToasts />
// draws them above every sheet (the old stack sat at z 1200, under them).
import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, X } from 'lucide-react';

let _list = [];
const _subs = new Set();
const _emit = () => _subs.forEach(fn => fn(_list));

export function itemsToast(message, kind = 'success') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  _list = [..._list, { id, message, kind }];
  _emit();
  setTimeout(() => { _list = _list.filter(t => t.id !== id); _emit(); }, kind === 'error' ? 6000 : 4000);
}
function dismiss(id) { _list = _list.filter(t => t.id !== id); _emit(); }

export function ItemsToasts() {
  const [toasts, setToasts] = useState(_list);
  useEffect(() => { _subs.add(setToasts); setToasts(_list); return () => { _subs.delete(setToasts); }; }, []);
  return <Toast toasts={toasts} onDismiss={dismiss} />;
}

export function Toast({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 4700, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
      {toasts.map(t => (
        <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 10,
          background: 'var(--card)', border: '1px solid var(--wk-line2, var(--line))',
          boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
        }}>
          {t.kind === 'error'
            ? <XCircle size={16} color="var(--wk-red)" style={{ flexShrink: 0, marginTop: 1 }} />
            : <CheckCircle size={16} color="var(--wk-green)" style={{ flexShrink: 0, marginTop: 1 }} />}
          <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.45, flex: 1 }}>{t.message}</div>
          <button onClick={() => onDismiss(t.id)} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
