// The header's two Build Mode pieces (Oct 24 2026): the hook the profile menu
// reads (row only when the server says the person has it) and the chip that
// sits in the header while the mode is on. Both stay tiny - the header is on
// the critical path and the real module is lazy.
import { useBuildStore, toggleMode } from './store';

export function useBuildModeMenu() {
  const enabled = useBuildStore((s) => !!s.enabled);
  const on = useBuildStore((s) => s.on);
  return { enabled, on, toggle: toggleMode };
}

export function BuildModeChip({ onClick }) {
  return (
    <button type="button" className="bm-chip" onClick={onClick}
      title="Build Mode is on - click to turn it off (Esc)" aria-label="Build Mode is on - turn off">
      <span className="bm-chip-dot" aria-hidden="true" />
      Build Mode
    </button>
  );
}
