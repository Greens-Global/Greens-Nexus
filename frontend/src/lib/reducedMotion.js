// Whether this person asked the OS for less motion. App-wide chrome (the
// New in Nexus bar, the update popup) reads it here rather than from a
// feature module's own motion helpers (components/shifts/motion.js has its
// own copy for the Shifts screens).
export function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { return false; }
}
