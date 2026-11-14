// The header every Hiring sheet shares (11/14/2026): a title, one quiet line
// under it, and the close button - drawn into the shared Modal's `header`
// slot so the sheet keeps its own words while the Modal does the sheet.
import { X } from 'lucide-react';

export default function SheetHead({ titleId, title, sub, icon = null, onClose, closeDisabled = false, children }) {
  return (
    <div style={{ padding: '16px clamp(16px, 4vw, 24px)', borderBottom: '1px solid var(--line)', flexShrink: 0, fontFamily: 'Inter,sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id={titleId} style={{ fontWeight: 800, fontSize: 15, color: 'var(--ink)' }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{sub}</div>}
        </div>
        <button type="button" onClick={onClose} disabled={closeDisabled} aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
      </div>
      {children}
    </div>
  );
}
