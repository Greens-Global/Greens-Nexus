// The signer's own text box on a PDF page in Nexus Sign. A field with a
// `format` (federal forms, Neil 11/02/2026) masks as it is typed and shows
// the live digit count where the mask alone does not say; the server's 422
// message for the field shows under the box. `style` is the field's place on
// the page (absolute, in percent); `inputStyle` is the zoom-safe box the
// overlay already draws (16px type scaled to the 11px look on phones).
import { applyMask, formatCount, formatPlaceholder, formatInputMode } from '../../lib/fieldFormats';

export default function SignTextField({ field: f, value, onChange, disabled = false, style, inputStyle, error = '', innerRef }) {
  const fmt = f.format || '';
  const count = fmt && !error ? formatCount(fmt, value) : '';
  const note = error || count;
  const mode = formatInputMode(fmt);
  const label = f.label || 'Text';
  return (
    <>
      <input ref={innerRef} value={value || ''} disabled={disabled} aria-label={label} aria-invalid={error ? 'true' : undefined}
        placeholder={formatPlaceholder(fmt) || 'Text'} inputMode={mode || undefined}
        autoComplete={f.sensitive ? 'off' : undefined}
        onChange={e => onChange(fmt ? applyMask(fmt, e.target.value) : e.target.value)}
        style={{ ...(inputStyle || style), border: `2.2px ${error ? 'solid #dc2626' : 'dashed #fbbf24'}`,
          background: error ? 'rgba(220,38,38,0.06)' : 'rgba(251,191,36,0.1)', borderRadius: 6, padding: '0 6px' }} />
      {note && (
        <span role={error ? 'alert' : undefined}
          style={{ position: 'absolute', left: style?.left, top: `calc(${style?.top || '0%'} + ${style?.height || '0%'} + 2px)`, zIndex: 2,
            fontSize: 10.5, lineHeight: 1.3, fontFamily: 'Inter,sans-serif', fontWeight: error ? 700 : 600, whiteSpace: 'nowrap',
            color: error ? '#b91c1c' : 'var(--muted)', background: 'rgba(255,255,255,0.92)', padding: '1px 4px', borderRadius: 3,
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)', pointerEvents: 'none' }}>
          {note}
        </span>
      )}
    </>
  );
}
