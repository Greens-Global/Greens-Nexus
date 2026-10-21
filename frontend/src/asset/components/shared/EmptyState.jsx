/** Dashed-border placeholder for empty lists/sections: the message, and the action
 *  that fills the list sits inside the box (an invitation, not a dead end). */
export function EmptyState({ children, action, onAction, secondary }) {
  return (
    <div
      style={{
        padding: '32px 20px',
        textAlign: 'center',
        color: 'var(--text-secondary)',
        fontSize: '0.875rem',
        lineHeight: 1.5,
        border: '1px dashed var(--border-color)',
        borderRadius: 12,
      }}
    >
      <div>{children}</div>
      {(action || secondary) && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          {action && <button type="button" className="primary-btn" onClick={onAction}>{action}</button>}
          {secondary}
        </div>
      )}
    </div>
  );
}
