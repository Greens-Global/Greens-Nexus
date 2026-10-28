// Small pieces every Workflows screen shares (Oct 28 2026): the Inter inline
// idiom of views/Approvals.jsx, a card, a section title, a chip, a link
// button and muted text. Components only (react-refresh): the way to open
// another module's record is lib/navigate.js, the wording of a refused call
// lib/errors.js.

export const FONT = 'Inter, sans-serif';

export function Card({ children, style, ...rest }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden', ...style }} {...rest}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, action, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--ink)', fontFamily: FONT, flex: 1, minWidth: 0 }}>
        {children}
        {count != null && <span style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>{count}</span>}
      </h3>
      {action}
    </div>
  );
}

export function Chip({ on, onClick, children, count, ...rest }) {
  return (
    <button type="button" role="tab" aria-selected={!!on} onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 13px', borderRadius: 999,
        border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--line)'}`, background: on ? 'var(--wk-brand-tint)' : 'var(--card)',
        color: on ? 'var(--wk-brand)' : 'var(--ink)', fontFamily: FONT, fontSize: 13, fontWeight: on ? 700 : 600,
        cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }} {...rest}>
      {children}
      {count != null && <span style={{ fontSize: 12, fontWeight: 700, color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{count}</span>}
    </button>
  );
}

/** A plain text button that reads as a link (a row title, Open). */
export function LinkButton({ children, onClick, title, style }) {
  return (
    <button type="button" onClick={onClick} title={title}
      style={{ background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'var(--wk-brand)', fontWeight: 600, cursor: 'pointer', textAlign: 'left', fontFamily: FONT, ...style }}>
      {children}
    </button>
  );
}

export const Muted = ({ children, style }) => <span style={{ color: 'var(--muted)', fontSize: 12.5, ...style }}>{children}</span>;
