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
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';

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
    default: ({ onClose }) => (
      <TasksProvider><CreateTicketModal onClose={onClose} /></TasksProvider>
    ),
  };
});

export const HELP_OPEN_EVENT = 'nexus:help-open';

// Last tab this session - reopening lands where the person left off.
let lastTab = 'home';

/** Typing in a field (or a rich-text editor) owns the "?" key. */
function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable || !!el.closest?.('[contenteditable="true"], [contenteditable=""]');
}

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
          go to Support
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
    if (restoreFocus) btnRef.current?.focus();
  }, []);

  // "?" anywhere (Shift+/ on US keyboards), Esc while open, and the phone menu's event.
  useEffect(() => {
    const onKey = (e) => {
      if (open && e.key === 'Escape') { e.preventDefault(); close(true); return; }
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
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const ask = useCallback(() => { setOpen(false); setComposing(true); }, []);

  return (
    <div className="help-menu-wrap" ref={wrapRef}>
      <button ref={btnRef} type="button" className="icon-btn help-menu-btn" aria-label="Help" title="Help"
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="?"
        onMouseEnter={loadWidget} onFocus={loadWidget}
        onClick={() => (open ? close() : show())}>
        <CircleHelp style={{ width: 17, height: 17 }} />
      </button>
      {open && (
        <WidgetBoundary onContact={() => {
          close(false);
          window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support' } }));
        }}>
          <Suspense fallback={<WidgetLoading />}>
            <HelpWidget activeView={activeView} initialTab={lastTab}
              onTabChange={(t) => { lastTab = t; }}
              onWhatsNew={onWhatsNew} onAsk={ask} onClose={close} />
          </Suspense>
        </WidgetBoundary>
      )}
      {composing && (
        <Suspense fallback={null}>
          <TicketComposer onClose={() => setComposing(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** Test seam - forget the remembered tab. */
export function __resetHelpTab() { lastTab = 'home'; }
