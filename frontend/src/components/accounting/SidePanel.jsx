import { useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';

// A record opened on the right, the list still on screen (Accounting call,
// 10/23, item 03 - Viral: "instead of making a pop-up, we can do a right side
// window"; Neil: "you can quickly go down, down, down on the left and you can
// keep this on the right and just make a quick edit"). Modeled on Viral's
// demo: a header with the record's name and a one-line caption, Open Full and
// a close (X), tabs across the top when the record has several parts, the
// body scrolling inside the panel while the footer (the Save button) stays
// put at the bottom.
//
// There is no backdrop: the list behind stays clickable, so clicking another
// row swaps the panel to that record. Popups (z 500) still open above it.
// Open Full widens the panel over the whole screen for this one open only:
// every record starts in the side panel, the list beside it (UI test 10/24 -
// a remembered Open Full made every later record cover the list). Callers
// key the panel by record, so another row or the next open starts fresh.
// Escape is the caller's (it knows whether there are unsaved edits).
//
//   <SidePanel label="Change lease" title="910 SECR - Ste 100" caption="..."
//     tabs={[{ key: 'details', label: 'Details' }]} tab={tab} onTab={setTab}
//     onClose={tryClose} footer={<div className="modal-footer">...</div>}>
//     <PanelSection title="Tenant Info" caption="Who pays">...</PanelSection>
//   </SidePanel>

export default function SidePanel({ label, title, caption = null, badges = null, tabs = null, tab = '', onTab, onClose, footer = null, children }) {
  const [full, setFull] = useState(false);
  return (
    <aside className={`acct-side-panel${full ? ' is-full' : ''}`} role="dialog" aria-modal="false" aria-label={label} data-testid="acct-side-panel">
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '16px 20px 12px', borderBottom: tabs ? 'none' : '1px solid var(--border-color)' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', overflowWrap: 'anywhere' }}>{title}</h3>
          {(caption || badges) && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {badges}{caption && <span>{caption}</span>}
            </div>
          )}
        </div>
        <button type="button" className="secondary-btn" onClick={() => setFull((f) => !f)} aria-pressed={full}
          title={full ? 'Back to the side panel, the list beside it' : 'Open over the whole screen'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.76rem', padding: '4px 10px', whiteSpace: 'nowrap' }}>
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />} {full ? 'Side Panel' : 'Open Full'}
        </button>
        <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
      </header>
      {tabs && (
        <div className="scroll-tabs" role="tablist" aria-label={`${label} sections`} style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: '1px solid var(--border-color)' }}>
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => onTab(t.key)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: '0.8rem', whiteSpace: 'nowrap', padding: '8px 10px', marginBottom: -1,
                fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)',
                borderBottom: `2px solid ${tab === t.key ? 'var(--wk-brand, #2b45e1)' : 'transparent'}` }}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="acct-side-panel-body">{children}</div>
      {footer}
    </aside>
  );
}

/** A titled group of fields with a one-line caption (Viral's "Basic details - Identity, project..."). */
export function PanelSection({ title, caption = '', children, style = null }) {
  return (
    <section aria-label={title} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-card)', ...(style || {}) }}>
      <h4 style={{ margin: 0, fontSize: '0.86rem', fontWeight: 700 }}>{title}</h4>
      {caption && <p style={{ margin: '2px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>{caption}</p>}
      <div style={{ borderTop: '1px solid var(--border-color)', margin: '10px 0 12px' }} />
      {children}
    </section>
  );
}
