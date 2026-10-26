// Build Mode shell (Oct 24 2026). Mounted by App.jsx beside the other shell
// widgets. Asks the server once whether this person has Build Mode and
// lazy-imports the real module only when they do AND the mode is on - so
// everyone else downloads nothing. The toggle hotkey lives here so it works
// before the module has loaded.
import { lazy, Suspense, useEffect } from 'react';
import { useBuildStore, ensureEnabled, toggleMode, turnOn } from './store';
import { isToggleHotkey } from './lib/hotkeys';
import { startActions, stopActions } from './lib/actions';

const BuildModeApp = lazy(() => import('./BuildModeApp'));

export default function BuildMode({ view, sub }) {
  const enabled = useBuildStore((s) => s.enabled);
  const on = useBuildStore((s) => s.on);
  const pendingPin = useBuildStore((s) => s.pendingPin);

  useEffect(() => { ensureEnabled(); }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => { if (isToggleHotkey(e)) { e.preventDefault(); toggleMode(); } };
    window.addEventListener('keydown', onKey);
    // The last 30 user actions (masked) run from here on, not only while the
    // mode is on - so a pin can say what led up to the bug.
    startActions();
    return () => { window.removeEventListener('keydown', onKey); stopActions(); };
  }, [enabled]);

  // A deep link (/dev-notes?pin=<id>, or a bell) turns the mode on by itself.
  useEffect(() => { if (enabled && pendingPin && !on) turnOn(); }, [enabled, pendingPin, on]);

  if (!enabled || !on) return null;
  return (
    <Suspense fallback={null}>
      <BuildModeApp view={view} sub={sub} />
    </Suspense>
  );
}
