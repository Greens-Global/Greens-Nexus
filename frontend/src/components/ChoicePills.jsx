import { useRef } from 'react';

// One choice shown as a row of pills, every option visible at once. A native
// <select> styled like the text boxes around it read as a text box - people
// never found Sick / Vacation behind it (Oct 21). Keyboard works like native
// radios: Tab lands on the chosen pill, the arrow keys (and Home / End) move
// and pick, Space / Enter pick.
export default function ChoicePills({ label, options, value, onChange }) {
  const refs = useRef([]);
  const focusAt = options.includes(value) ? value : options[0];
  const onKey = (e, i) => {
    const n = options.length;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : step ? (i + step + n) % n : -1;
    if (j < 0) return;
    e.preventDefault();
    onChange(options[j]);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {options.map((o, i) => {
        const on = o === value;
        return (
          <button key={o} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on}
            tabIndex={o === focusAt ? 0 : -1} onClick={() => onChange(o)} onKeyDown={(e) => onKey(e, i)}
            style={{ minHeight: 36, padding: '0 16px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
              border: `1px solid ${on ? 'var(--wk-brand, #15803d)' : 'var(--line)'}`,
              background: on ? 'var(--wk-brand, #15803d)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>
            {o}
          </button>
        );
      })}
    </div>
  );
}
