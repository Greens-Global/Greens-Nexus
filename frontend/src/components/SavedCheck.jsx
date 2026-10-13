// "Saved" with a check that draws itself - the success cue after a settings
// save. `show` is the caller's existing `saved` flag (set true after the
// request, cleared by its own timer); the cue fades out when it clears
// instead of vanishing. Under reduced motion nothing draws or fades.
import { NX } from '../tasks/theme';
import { MOTION, usePresence } from '../lib/motion';

export default function SavedCheck({ show, label = 'Saved', style }) {
  const { mounted, closing } = usePresence(show, MOTION.exitFast);
  if (!mounted) return null;
  return (
    <span role="status" className={`nx-saved${closing ? ' is-closing' : ''}`} style={{ color: NX.green, ...style }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </span>
  );
}
