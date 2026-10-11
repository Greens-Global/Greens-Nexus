// One brief glow over a row or card whose `value` (its status, usually) just
// changed - the same cue whether the change was yours, a drop, or someone
// else's edit arriving live. Renders nothing on mount and while idle. The
// parent needs `position: relative`; the glow is an overlay, opacity only,
// so the parent's own background is never touched.
import { useChangeFlash } from '../lib/motion';

export default function ChangeFlash({ value, color }) {
  const n = useChangeFlash(value);
  if (!n) return null;
  return <span key={n} className="nx-flash" aria-hidden="true" style={color ? { '--flash': color } : undefined} />;
}
