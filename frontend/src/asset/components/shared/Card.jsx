/** Simple bordered/shadowed card wrapper. */
export function Card({ children }) {
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-sm)',
        padding: 18,
      }}
    >
      {children}
    </div>
  );
}
