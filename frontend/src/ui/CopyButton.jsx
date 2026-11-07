// Copy, then a check (Neil, 11/07/2026 - effects rebuilt from interior.dev,
// house style, no new dependency). The copy icon turns into a green check for
// a moment so a copy is never silent; a blocked clipboard says so instead of
// pretending. `value` is the text, or a function that returns it at click
// time. `what` names the thing ("email" -> "Copy email") for the tooltip and,
// icon only, the button's name. Callers style the box (`style`, `className`);
// the swap itself is the `.nx-copy` rules in style.css (opacity + scale only).
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

export default function CopyButton({ value, what = '', label = 'Copy', copiedLabel = 'Copied', iconOnly = false, size = 13, className = '', style, title }) {
  const [state, setState] = useState('idle');   // idle | done | failed
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = what ? `Copy ${what}` : label;
  const copy = async (e) => {
    e.stopPropagation();
    let ok = false;
    try {
      await navigator.clipboard.writeText(String((typeof value === 'function' ? value() : value) ?? ''));
      ok = true;
    } catch { /* blocked: say so below */ }
    setState(ok ? 'done' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1600 : 2600);
  };
  const words = state === 'done' ? copiedLabel : state === 'failed' ? 'Copy Failed' : label;
  return (
    <button type="button" className={`nx-copy ${className}`.trim()} data-state={state} onClick={copy} style={style}
      title={state === 'failed' ? 'Copying is blocked here - select the text and copy it' : (title || name)}
      aria-label={iconOnly ? (state === 'done' ? copiedLabel : name) : undefined}>
      <span className="nx-copy-icon" aria-hidden="true"><Copy size={size} /><Check size={size} /></span>
      {!iconOnly && <span>{words}</span>}
      {iconOnly && <span className="nx-sr" aria-live="polite">{state === 'done' ? copiedLabel : state === 'failed' ? 'Copy Failed' : ''}</span>}
    </button>
  );
}
