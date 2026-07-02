/** Dashed-border placeholder for empty lists/sections, with centered message content. */
export function EmptyState({ children }) {
  return (
    <div
      style={{
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--text-secondary)',
        fontSize: '0.875rem',
        border: '1px dashed var(--border-color)',
        borderRadius: 12,
      }}
    >
      {children}
    </div>
  );
}
