// Item Management - a date box (Items redesign, Neil 11/02/2026).
// The shared DateField (tasks/components.jsx - MM/DD/YYYY whatever the
// region of the computer, never the browser date box) inside a field
// border, so it lines up with the other inputs on a sheet.
import { DateField } from '../../tasks/components';

export function DateBox({ value, onChange, min = '', max = '', noPast = false, placeholder = 'Pick a date', ariaLabel, style, compact = false }) {
  return (
    <span role="group" aria-label={ariaLabel} style={{
      display: 'inline-flex', alignItems: 'center', minHeight: compact ? 32 : 38, padding: compact ? '0 10px' : '0 12px',
      border: '1px solid var(--wk-line, var(--line))', borderRadius: 8, background: 'var(--card)', fontSize: 13.5,
      boxSizing: 'border-box', ...style,
    }}>
      <DateField value={value || ''} onChange={(v) => onChange(v || '')} min={min} max={max} noPast={noPast}
        placeholder={placeholder} title={ariaLabel} style={{ width: '100%' }} />
    </span>
  );
}
