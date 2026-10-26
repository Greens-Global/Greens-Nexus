// The Settings building blocks (Oct 25 2026): one switch, one setting row and
// one number field, so every panel Settings shows reads the same - title and
// description on the left, the control on the right, a hairline between rows
// (the Linear / Stripe settings pattern). Styles are the .nx-set-* rules in
// style.css. A panel used outside Settings looks the same, which is the point.

// A real checkbox drawn as a switch: keyboard, screen readers, forms and
// `.checked` all keep working; role="switch" says what it is.
export function Switch({ checked, onChange, disabled = false, label, describedBy, ...rest }) {
  return (
    <input type="checkbox" role="switch" className="nx-switch" checked={!!checked} disabled={disabled}
      aria-label={label} aria-describedby={describedBy} onChange={(e) => onChange?.(e.target.checked)} {...rest} />
  );
}

// One setting: `title` and `desc` on the left, `control` on the right;
// `children` (the switch's own details, shown while it is on) run underneath.
// A row whose control is a switch is a label for it, so the whole row clicks.
export function SettingRow({ title, desc, control, children, nested = false, muted = false, htmlFor }) {
  const Head = htmlFor ? 'label' : 'div';
  return (
    <div className={`nx-set-row${nested ? ' is-nested' : ''}${muted ? ' is-muted' : ''}`}>
      <Head className="nx-set-row-main" htmlFor={htmlFor}>
        <span className="nx-set-row-text">
          <span className="nx-set-row-title">{title}</span>
          {desc && <span className="nx-set-row-desc" id={htmlFor ? `${htmlFor}-desc` : undefined}>{desc}</span>}
        </span>
        {control && <span className="nx-set-row-control">{control}</span>}
      </Head>
      {children && <div className="nx-set-row-more">{children}</div>}
    </div>
  );
}

// A switch row: the row is the switch's label. The switch is named by its
// title alone (`label` when the title is not plain text) and described by
// the description.
export function SwitchRow({ id, title, label, desc, checked, onChange, disabled = false, nested = false, children }) {
  return (
    <SettingRow htmlFor={id} title={title} desc={desc} nested={nested} muted={disabled}
      control={<Switch id={id} checked={checked} onChange={onChange} disabled={disabled}
        label={label || (typeof title === 'string' ? title : undefined)} describedBy={desc ? `${id}-desc` : undefined} />}>
      {children}
    </SettingRow>
  );
}

// A small number box with its unit after it - never squeezed under it.
export function NumberBox({ value, onChange, onBlur, onKeyDown, min = 0, max = 999, unit, label, width = 76, disabled = false }) {
  return (
    <span className="nx-set-number">
      <input className="form-input" type="number" min={min} max={max} step="1" value={value} disabled={disabled}
        aria-label={label} onChange={(e) => onChange?.(e.target.value)} onBlur={onBlur} onKeyDown={onKeyDown} style={{ width }} />
      {unit && <span className="nx-set-number-unit">{unit}</span>}
    </span>
  );
}

// The rows of one group sit on one card.
export function SettingCard({ children, className = '' }) {
  return <div className={`nx-set-card ${className}`.trim()}>{children}</div>;
}
