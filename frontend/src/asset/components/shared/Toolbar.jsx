// The pieces every Asset Management list's toolbar row is made of (Neil,
// 11/17/2026): one summary sentence (counts as words, never stat tiles), the
// tab's own search box, and the one-line quick add (no tinted strip).
import { useState } from 'react';
import { Search } from 'lucide-react';
import { DateField } from '../../../tasks/components.jsx';
import { TONE_COLOR } from './StatusBadge.jsx';

/** One summary sentence (Neil, 11/17/2026: counts as words, never stat tiles). Parts are
 *  strings or { text, tone }; a toned part is a state and takes its color. */
export function SummarySentence({ parts, style }) {
  const list = (parts || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)', ...style }}>
      {list.map((p, i) => {
        const text = typeof p === 'string' ? p : p.text;
        const tone = typeof p === 'string' ? null : p.tone;
        return (
          <span key={i}>
            {i > 0 && <span aria-hidden="true" style={{ color: 'var(--text-muted)', margin: '0 8px' }}>·</span>}
            {i > 0 && <span style={SR_ONLY}>, </span>}
            <span style={tone ? { color: TONE_COLOR[tone] || 'inherit', fontWeight: 600 } : null}>{text}</span>
          </span>
        );
      })}
    </p>
  );
}

export const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

/** The toolbar's search box, wired to the tab's own filter text. */
export function ToolbarSearch({ value, onChange, placeholder, label, width = 240 }) {
  return (
    <div style={{ position: 'relative', width, maxWidth: '100%', flex: '0 1 auto' }}>
      <Search size={14} aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <input type="search" className="form-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label || placeholder}
        style={{ width: '100%', height: 32, fontSize: 13, padding: '6px 10px 6px 30px' }} />
    </div>
  );
}

/** The one-line quick add (Neil, 11/17/2026: no tinted strip) - words, a date, Add. */
export function QuickAddLine({ placeholder, button = 'Add', onAdd }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(() => localToday());
  const submit = () => {
    if (!text.trim()) return;
    onAdd({ date, text: text.trim() });
    setText('');
  };
  const ready = !!text.trim();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-color)' }}>
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={placeholder} aria-label={placeholder}
        className="nx-quick-add"
        style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', fontSize: 13, fontFamily: 'inherit', color: 'var(--text-primary)', padding: '4px 0' }} />
      <DateField value={date} onChange={(v) => setDate(v || localToday())} title="Date of the work" style={{ fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0, width: 116 }} />
      <button type="button" onClick={submit} disabled={!ready}
        style={{ border: 'none', background: 'none', padding: '4px 2px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: ready ? 'pointer' : 'default', color: ready ? 'hsl(var(--color-green))' : 'var(--text-muted)', flexShrink: 0 }}>
        {button}
      </button>
    </div>
  );
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

