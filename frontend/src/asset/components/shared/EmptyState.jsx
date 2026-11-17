/** A designed empty state: an optional glyph, a title, a line that says what
 *  will live here, and the action that fills it. No dashed box (Neil,
 *  11/17/2026) - whitespace frames it. `secondary` is a second button node;
 *  `compact` is for a slot inside a list. */
export function EmptyState({ children, action, onAction, secondary, title, icon: Icon, compact = false }) {
  return (
    <div style={{ padding: compact ? '20px 16px' : '48px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
      {Icon && (
        <div aria-hidden="true" style={{ width: 40, height: 40, margin: '0 auto 12px', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'hsl(var(--color-green))' }}>
          <Icon size={18} />
        </div>
      )}
      {title && <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>}
      {children && <div style={{ maxWidth: 520, margin: '0 auto' }}>{children}</div>}
      {(action || secondary) && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 16 }}>
          {action && <button type="button" className="primary-btn" onClick={onAction}>{action}</button>}
          {secondary}
        </div>
      )}
    </div>
  );
}
