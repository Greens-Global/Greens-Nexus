// The signer's own text box on a PDF page in Nexus Sign. A field with a
// `format` (federal forms, Neil 11/02/2026) masks as it is typed and shows
// the live digit count where the mask alone does not say - only while the
// box has focus, so a page of boxes does not read as a page of counters; the
// server's 422 message for the field shows under the box whether or not it
// is focused. `style` is the field's place on the page (absolute, in
// percent); `inputStyle` is the zoom-safe box the overlay already draws
// (16px type scaled to the 11px look on phones). The note wraps (a 422
// sentence can run 60 characters) and a box on the right half of the page
// anchors its note to the page's right edge, so it never runs off the page.
import { useState } from 'react';
import { applyMask, formatCount, formatPlaceholder, formatInputMode } from '../../lib/fieldFormats';

// Where the note sits: under the box, left-aligned with it on the left half
// of the page, hugging the page's right edge on the right half.
function noteAnchor(style) {
  const top = `calc(${style?.top || '0%'} + ${style?.height || '0%'} + 2px)`;
  const left = parseFloat(style?.left);
  return Number.isFinite(left) && left > 50 ? { right: 0, top } : { left: style?.left, top };
}

export default function SignTextField({ field: f, value, onChange, disabled = false, style, inputStyle, error = '', innerRef }) {
  const fmt = f.format || '';
  const [focused, setFocused] = useState(false);
  const count = fmt && !error && focused ? formatCount(fmt, value) : '';
  const note = error || count;
  const mode = formatInputMode(fmt);
  const label = f.label || 'Text';
  return (
    <>
      <input ref={innerRef} value={value || ''} disabled={disabled} aria-label={label} aria-invalid={error ? 'true' : undefined}
        placeholder={formatPlaceholder(fmt) || 'Text'} inputMode={mode || undefined}
        autoComplete={f.sensitive ? 'off' : undefined}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={e => onChange(fmt ? applyMask(fmt, e.target.value) : e.target.value)}
        style={{ ...(inputStyle || style), border: `2.2px ${error ? 'solid #dc2626' : 'dashed #fbbf24'}`,
          background: error ? 'rgba(220,38,38,0.06)' : 'rgba(251,191,36,0.1)', borderRadius: 6, padding: '0 6px' }} />
      {note && (
        <span role={error ? 'alert' : undefined}
          style={{ position: 'absolute', ...noteAnchor(style), zIndex: 2, maxWidth: 'min(60ch, 100%)', boxSizing: 'border-box',
            fontSize: 11, lineHeight: 1.3, fontFamily: 'Inter,sans-serif', fontWeight: error ? 700 : 600, whiteSpace: 'normal',
            color: error ? '#b91c1c' : 'var(--muted)', background: 'rgba(255,255,255,0.92)', padding: '1px 4px', borderRadius: 3,
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)', pointerEvents: 'none' }}>
          {note}
        </span>
      )}
    </>
  );
}
