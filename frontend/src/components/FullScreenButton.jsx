// Full Screen for a working surface (Neil, 10/31/2026: "a larger almost full
// screen mode" for the workflow builder and Operations). On a computer it
// folds the left navigation away and trims the page margins, so the module
// gets nearly the whole window; the header stays, because it carries the
// module's tabs. Each module remembers its own choice for the person (this
// browser only); leaving the module puts the navigation back. Phones are
// full width already, so the button does not show there.
//
//   const [full, toggleFull] = useFullScreen('workflows');
//   <FullScreenButton on={full} onToggle={toggleFull} />
//
// The CSS is the `html.nx-fullscreen` block in style.css.
import { useCallback, useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useIsMobile } from '../lib/useIsMobile';

const KEY = 'nexus.fullScreen.';
const CLASS = 'nx-fullscreen';

function read(module) {
  try { return localStorage.getItem(KEY + module) === '1'; } catch { return false; }
}
function write(module, on) {
  try { if (on) localStorage.setItem(KEY + module, '1'); else localStorage.removeItem(KEY + module); } catch { /* private window */ }
}

export function useFullScreen(module) {
  const [on, setOn] = useState(() => read(module));
  const isPhone = useIsMobile('(max-width: 900px)');
  const active = on && !isPhone;
  useEffect(() => {
    if (!active) return undefined;
    const root = document.documentElement;
    root.classList.add(CLASS);
    return () => root.classList.remove(CLASS);
  }, [active]);
  const toggle = useCallback(() => setOn((v) => { write(module, !v); return !v; }), [module]);
  return [active, toggle];
}

export default function FullScreenButton({ on, onToggle, className, style }) {
  const isPhone = useIsMobile('(max-width: 900px)');
  if (isPhone) return null;
  const Icon = on ? Minimize2 : Maximize2;
  return (
    <button type="button" className={className} onClick={onToggle} aria-pressed={on}
      title={on ? 'Exit Full Screen - bring back the navigation' : 'Full Screen - hide the navigation and use the whole window'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <Icon size={14} aria-hidden="true" /> {on ? 'Exit Full Screen' : 'Full Screen'}
    </button>
  );
}
