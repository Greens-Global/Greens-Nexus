import { X } from 'lucide-react';

/**
 * Generic centered modal shell: overlay + card with header (title + close button),
 * scrollable body, and a footer action row. Clicking the overlay itself (not the
 * card) closes it. `wide` bumps the default max width from 560 to 760; `maxWidth`
 * overrides both.
 */
export function Modal({ title, children, footer, wide, maxWidth, onClose }) {
  return (
    <div
      className="modal-overlay"
      style={{ display: 'flex' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-content"
        style={{ width: maxWidth ? `min(94vw, ${maxWidth}px)` : undefined, maxWidth: maxWidth || (wide ? 760 : 560) }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: '4px 24px 16px' }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 24px 18px', borderTop: '1px solid var(--border-color)' }}>
          {footer}
        </div>
      </div>
    </div>
  );
}
