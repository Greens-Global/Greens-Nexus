// The "?" in the top header and the Help widget it opens (HelpWidget.jsx - a
// messenger-style panel anchored bottom-right: Home, Messages, Help). Self-
// service comes first (Neil, Sep 26: "we want everyone to self-service as much
// as possible"): search the guide and the Knowledge Base, then ask a person.
//
// This file owns the trigger and the lifecycle:
//   - opens from the button, the "?" key anywhere outside a text field, or a
//     `nexus:help-open` window event (the phone menu's Help row - the header
//     button is hidden on phones, where a 4th right-side icon collides with
//     the centered wordmark)
//   - Esc closes and hands focus back to the "?" button; a click outside
//     closes it too
//   - remembers the last tab for the session
//   - mounts the Ticket module's own create form for Ask a Question / Send Us
//     a Message (the same trick Support.jsx uses), so there is one ticket form
// The widget's code loads on first open (or on hover of the button).
import { isTypingTarget } from '../lib/keys';
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ModalLoading } from '../components/AsyncState';
import { CircleHelp } from 'lucide-react';
import { createPortal } from 'react-dom';
import { takePendingAutoTour, AUTO_TOUR_EVENT } from '../lib/tours';

const GuidedTour = lazy(() => import('../components/GuidedTour'));

const loadWidget = () => import('./HelpWidget');
const HelpWidget = lazy(loadWidget);

// The Ticket module's create form, with the provider it reads createTicket
// from - see TicketComposer in views/Support.jsx.
const TicketComposer = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../tasks/TasksContext'),
    import('../tickets/TicketsView'),
  ]);
  return {
    default: ({ onClose, initial }) => (
      <TasksProvider><CreateTicketModal onClose={onClose} initial={initial} /></TasksProvider>
    ),
  };
});

export const HELP_OPEN_EVENT = 'nexus:help-open';

// Last tab this session - reopening lands where the person left off.
let lastTab = 'home';

/** Typing in a field (or a rich-text editor) owns the "?" key. */

// Shown while the widget's code loads, so the click never looks like it did nothing.
function WidgetLoading() {
  return (
    <div className="help-widget" role="dialog" aria-label="Help" aria-busy="true">
      <div className="hw-hero" style={{ minHeight: 150 }} />
      <div style={{ padding: 16 }}>
        {[0, 1, 2].map((i) => <div key={i} className="hw-skeleton" style={{ height: 56 }} />)}
      </div>
    </div>
  );
}

// The widget floats over every screen, so a failure inside it (or a chunk
// that fails to load after a deploy) must stay inside it.
class WidgetBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="help-widget" role="dialog" aria-label="Help" style={{ padding: 18, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Help could not load right now. Refresh the page, or{' '}
        <button type="button" onClick={this.props.onContact}
          style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600, cursor: 'pointer' }}>
          go to the Help Center
        </button>.
      </div>
    );
  }
}

export default function HelpMenu({ activeView, onWhatsNew }) {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  const show = useCallback(() => setOpen(true), []);
  // restoreFocus: Esc / the close button hand focus back to the "?" button;
  // anything that navigates away, or a click elsewhere, does not.
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    // Phones hide the "?" button (the panel opens from the menu there), and
    // focusing a hidden button drops focus nowhere.
    const btn = btnRef.current;
    if (restoreFocus && btn && window.getComputedStyle(btn).display !== 'none') btn.focus();
  }, []);

  // Esc while open closes the panel and ONLY the panel: caught on the way
  // down (capture) and stopped there, so a drawer or modal under it - whose
  // own Esc listener was added first - never hears it and keeps its draft.
  useEffect(() => {
    if (!open) return undefined;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open, close]);

  // "?" anywhere (Shift+/ on US keyboards) and the phone menu's event.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      if (open) close(); else show();
    };
    const onEvent = () => show();
    window.addEventListener('keydown', onKey);
    window.addEventListener(HELP_OPEN_EVENT, onEvent);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(HELP_OPEN_EVENT, onEvent); };
  }, [open, show, close]);

  // A click anywhere else closes it (on phones it covers the screen, so there
  // is no "elsewhere").
  useEffect(() => {
    if (!open) return undefined;
    // The panel lives at the page root (below), so a click in it is not "outside".
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target) && !e.target.closest?.('.help-widget')) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // `seed`: { subject, description } from Ask Nexus's File a Ticket (Oct 2026).
  const ask = useCallback((seed) => { setOpen(false); setComposing(seed && typeof seed === 'object' ? seed : true); }, []);

  // The built-for-this-page tour (lib/autoTour.js) for screens with no
  // hand-built one: built at the moment it starts, from the Help entry and
  // the page as it is. Leaving the screen ends it.
  const [autoSteps, setAutoSteps] = useState(null);
  useEffect(() => {
    let alive = true;
    // Loaded only when a tour starts: the Help docs are big, the header is not.
    const start = async () => {
      const [{ buildAutoTour }, { docForView }] = await Promise.all([import('../lib/autoTour'), import('./docsSearch')]);
      const steps = alive ? buildAutoTour(docForView(activeView)) : [];
      if (alive && steps.length) setAutoSteps(steps);
    };
    window.addEventListener(AUTO_TOUR_EVENT, start);
    return () => { alive = false; window.removeEventListener(AUTO_TOUR_EVENT, start); };
  }, [activeView]);
  // Sent here from the Help panel's tour list: start once the screen has drawn.
  useEffect(() => {
    if (!takePendingAutoTour(activeView)) return undefined;
    const t = setTimeout(() => window.dispatchEvent(new CustomEvent(AUTO_TOUR_EVENT)), 700);
    return () => clearTimeout(t);
  }, [activeView]);
  const [tourView, setTourView] = useState(activeView);
  if (tourView !== activeView) { setTourView(activeView); if (autoSteps) setAutoSteps(null); }
  const endAuto = useCallback(() => { setAutoSteps(null); import('../lib/autoTour').then((m) => m.clearAutoTourTags()); }, []);

  return (
    <div className="help-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="icon-btn help-menu-btn" aria-label="Help" title="Help and Support (?)"
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="?"
        onMouseEnter={loadWidget} onFocus={loadWidget}
        onClick={() => (open ? close() : show())}>
        <CircleHelp style={{ width: 17, height: 17 }} />
      </button>
      {/* The panel too: its "fixed" bottom-right measured from the blurred
          header put it above the top of the screen (Oct 28 2026). */}
      {open && createPortal(
        <WidgetBoundary onContact={() => {
          close(false);
          window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support' } }));
        }}>
          <Suspense fallback={<WidgetLoading />}>
            <HelpWidget activeView={activeView} initialTab={lastTab}
              onTabChange={(t) => { lastTab = t; }}
              onWhatsNew={onWhatsNew} onAsk={ask} onClose={close} />
          </Suspense>
        </WidgetBoundary>,
        document.body,
      )}
      {/* At the page root: inside the header, whose backdrop blur makes it
          the box "fixed" positions measure from, the spotlight sat a
          sidebar's width to the right of its target. */}
      {autoSteps && createPortal(
        <Suspense fallback={null}>
          <GuidedTour steps={autoSteps} onClose={endAuto} />
        </Suspense>,
        document.body,
      )}
      {composing && (
        <Suspense fallback={<ModalLoading />}>
          <TicketComposer onClose={() => setComposing(false)} initial={typeof composing === 'object' ? composing : null} />
        </Suspense>
      )}
    </div>
  );
}

/** Test seam - forget the remembered tab. */
export function __resetHelpTab() { lastTab = 'home'; }
