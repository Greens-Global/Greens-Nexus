// One row of an AnchoredMenu: icon + label, full width, hover tint.
export function MenuRow({ icon: Icon, onClick, children, danger = false }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', borderRadius: 7, fontSize: 13, fontWeight: 600, color: danger ? 'hsl(var(--color-red))' : 'var(--text-primary)', fontFamily: 'inherit' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      {Icon && <Icon size={15} style={{ color: danger ? 'hsl(var(--color-red))' : 'var(--text-secondary)', flexShrink: 0 }} />} {children}
    </button>
  );
}
