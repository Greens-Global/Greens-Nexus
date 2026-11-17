/** A plain block of the page (Neil, 11/17/2026: no bordered box per section).
 *  It only holds its contents; `divider` puts a hairline above it to separate
 *  it from what came before. */
export function Card({ children, divider = false, id, style }) {
  return (
    <div id={id} style={{ padding: divider ? '20px 0 0' : 0, borderTop: divider ? '1px solid var(--border-color)' : 'none', minWidth: 0, ...style }}>
      {children}
    </div>
  );
}
