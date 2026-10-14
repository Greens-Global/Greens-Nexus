// A packet's own Details Form (Oct 14) - "it could be for any country and any
// fields" (Pranshu). One renderer for the three places it is filled in: the
// candidate's details link (views/PublicIntake.jsx, outside the app shell, so
// every style is passed in), HR's Start Hiring Packet form, and the review
// screen. The server checks every answer (hr_packet_docs.clean_answers).

export default function DetailsFormFields({ form, values, onChange, inputStyle, labelStyle, headingStyle, hintStyle,
  className, gridMin = 220, idPrefix = 'df' }) {
  const v = values || {};
  const set = (k, val) => onChange({ ...v, [k]: val });
  const common = (f) => ({
    id: `${idPrefix}-${f.key}`, className, style: { width: '100%', boxSizing: 'border-box', ...inputStyle },
    value: v[f.key] || '', disabled: !!f.locked, required: !!f.required && !f.locked,
    placeholder: f.locked ? 'Hidden - Pay & Benefits access only' : undefined,
    onChange: e => set(f.key, e.target.value),
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${gridMin}px, 1fr))`, gap: '0 14px' }}>
      {(form || []).map((f, i) => f.type === 'heading' ? (
        <div key={`h-${i}`} style={{ gridColumn: '1 / -1', fontSize: 13.5, fontWeight: 800, marginTop: 16, ...headingStyle }}>{f.label}</div>
      ) : (
        <div key={f.key} style={f.type === 'longtext' ? { gridColumn: '1 / -1' } : undefined}>
          <label style={labelStyle} htmlFor={`${idPrefix}-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
          {f.type === 'longtext' ? <textarea rows={3} {...common(f)} style={{ ...common(f).style, resize: 'vertical', fontFamily: 'Inter,sans-serif' }} />
            : f.type === 'yesno' || f.type === 'choice' ? (
              <select {...common(f)}>
                <option value="">Choose...</option>
                {(f.type === 'yesno' ? ['Yes', 'No'] : f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input {...common(f)}
                type={{ date: 'date', email: 'email', phone: 'tel' }[f.type] || 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined} />
            )}
          {(f.last4 || f.help) && (
            <div style={{ fontSize: 11.5, color: 'var(--muted, #6b7280)', marginTop: 4, ...hintStyle }}>
              {f.help}{f.help && f.last4 ? ' ' : ''}{f.last4 ? 'Only the last 4 characters are kept.' : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
