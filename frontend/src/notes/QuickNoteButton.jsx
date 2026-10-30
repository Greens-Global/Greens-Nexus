// Quick Note's opener (Oct 29 2026): the shortcut and the panel. No button of
// its own any more - the + menu's New Note opens it on every screen, so the
// top bar's scratchpad button is gone (Neil, Oct 30 2026).
//
// Ctrl+Alt+N (Ctrl+Cmd+N on a Mac) - not Ctrl/Cmd+Shift+N, which every
// browser keeps for a private window and never hands to the page. The key is
// read as e.key, so an AltGr letter (Ctrl+Alt on many keyboards, e.g. Polish
// AltGr+N = ń) is typed as usual and never caught here. Anything can also
// open it with the `nexus:quick-note` window event. The panel and its editor
// load on first use, not with the header.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ModalLoading } from '../components/AsyncState';
import WidgetBoundary from '../components/WidgetBoundary';
import { isQuickNoteKey } from './notesModel';

const QuickNotePanel = lazy(() => import('./QuickNotePanel'));

export default function QuickNoteButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onKey = (e) => { if (isQuickNoteKey(e)) { e.preventDefault(); setOpen((o) => !o); } };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('nexus:quick-note', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('nexus:quick-note', onOpen); };
  }, []);
  // A move to another screen (Open in Notes, a bell) closes it.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('nexus:navigate', close);
    return () => window.removeEventListener('nexus:navigate', close);
  }, [open, close]);
  if (!open) return null;
  return (
    // A crash in the panel closes it, never the header.
    <WidgetBoundary name="quick-note" resetKey={String(open)}>
      <Suspense fallback={<ModalLoading />}>
        <QuickNotePanel onClose={close} />
      </Suspense>
    </WidgetBoundary>
  );
}
