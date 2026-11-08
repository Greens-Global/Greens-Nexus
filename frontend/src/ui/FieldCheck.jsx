// A field that explains itself as you type (Neil, 11/07/2026 - effects
// rebuilt from interior.dev). The rule, so a form never scolds early:
//   - nothing shows until the person has typed in the field (the wrapper's
//     onChange - a value set by code is not typing);
//   - a problem shows once they pause (PAUSE_MS) or leave the field, never
//     mid-keystroke;
//   - a problem clears the moment the value is right, with a short
//     "Looks Good" check so the fix is acknowledged;
//   - the server's (or the submit's) message always shows - it is the last
//     word; the caller clears it when the value changes.
// `check(value)` returns '' or one sentence - the SAME check the submit runs
// (never a second rule).
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

const PAUSE_MS = 700;
const OK_MS = 1600;

export function useFieldCheck(value, check, serverError = '') {
  const [seen, setSeen] = useState(value);
  const [edited, setEdited] = useState(false);
  const [armed, setArmed] = useState(false);
  const [ok, setOk] = useState(false);
  const live = edited && check ? check(value) || '' : '';
  const message = serverError || (armed ? live : '');
  if (!Object.is(seen, value)) {
    setSeen(value);
    // Fixed while a problem was showing: acknowledge it.
    if (armed && !serverError && check && check(seen) && !check(value)) setOk(true);
    setArmed(false);
  }
  useEffect(() => {
    if (!edited || armed) return undefined;
    const t = setTimeout(() => setArmed(true), PAUSE_MS);
    return () => clearTimeout(t);
  }, [edited, armed, seen]);
  useEffect(() => {
    if (!ok) return undefined;
    const t = setTimeout(() => setOk(false), OK_MS);
    return () => clearTimeout(t);
  }, [ok]);
  // `onChange` goes on the field's wrapper (React change events bubble): only
  // the person typing counts as editing, never a value that arrived some
  // other way (a repeat row sliding up after one above it was removed).
  return { message, ok: ok && !message, onChange: () => setEdited(true), onBlur: () => { if (edited) setArmed(true); } };
}

export function FieldNote({ message, ok, style }) {
  if (message) return <div role="alert" className="nx-fieldnote" style={style}>{message}</div>;
  if (ok) return <div className="nx-fieldnote is-ok" role="status" style={style}><Check size={12} aria-hidden="true" /> Looks Good</div>;
  return null;
}
