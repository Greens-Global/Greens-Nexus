import { ChevronDown } from 'lucide-react';

/** Collapsible bordered section with a header (title, optional subtitle/count/badge) and toggle chevron. */
export function CollapsibleSection({ title, sub, count, badge, open, onToggle, children }) {
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', backgroundColor: 'var(--bg-card)' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          width: '100%',
          textAlign: 'left',
          padding: '14px 16px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <ChevronDown
          size={17}
          style={{ flexShrink: 0, color: 'var(--text-secondary)', transition: 'transform 0.18s', transform: open ? 'none' : 'rotate(-90deg)' }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1rem', fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>
              {title}
            </span>
            {count != null && (
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  padding: '1px 8px',
                  borderRadius: 999,
                }}
              >
                {count}
              </span>
            )}
            {badge}
          </span>
          {sub && (
            <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {sub}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-color)' }}>
          <div style={{ paddingTop: 14 }}>{children}</div>
        </div>
      )}
    </div>
  );
}
