// Item Management - The module toasts.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { CheckCircle, XCircle, X } from 'lucide-react';

export function Toast({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" style={{ position:'fixed', bottom:24, right:24, zIndex:1200, display:'flex', flexDirection:'column', gap:8, maxWidth:340 }}>
      {toasts.map(t => (
        <div key={t.id} role="status" style={{
          display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', borderRadius:10,
          background:'var(--card)', border:`1px solid ${t.kind === 'error' ? 'hsla(var(--color-red),0.35)' : 'hsla(var(--color-green),0.35)'}`,
          boxShadow:'0 8px 28px rgba(0,0,0,0.18)',
        }}>
          {t.kind === 'error'
            ? <XCircle size={16} color="hsl(var(--color-red))" style={{ flexShrink:0, marginTop:1 }} />
            : <CheckCircle size={16} color="hsl(var(--color-green))" style={{ flexShrink:0, marginTop:1 }} />}
          <div style={{ fontSize:13, color:'var(--ink)', lineHeight:1.4, flex:1 }}>{t.message}</div>
          <button onClick={() => onDismiss(t.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', flexShrink:0 }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
