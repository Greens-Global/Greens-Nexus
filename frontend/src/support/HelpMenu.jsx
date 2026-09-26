// The "?" Help menu in the top header: search the guide, read the page for the
// screen you are on, or reach a person - in that order, so self-service comes
// first (Neil, Sep 26: "we want everyone to self-service as much as possible").
//
// Opens from the header button, the "?" key anywhere outside a text field, or
// a `nexus:help-open` window event (the phone menu's Help row - the header
// button is hidden on phones, where a 4th right-side icon collides with the
// centered wordmark). The panel itself (HelpPanel.jsx) loads on first open.
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';

const loadPanel = () => import('./HelpPanel');
const HelpPanel = lazy(loadPanel);

export const HELP_OPEN_EVENT = 'nexus:help-open';

/** Typing in a field (or a rich-text editor) owns the "?" key. */
function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable || !!el.closest?.('[contenteditable="true"], [contenteditable=""]');
}

// Shown for the moment the panel's code is loading, so the click never looks
// like it did nothing.
function PanelLoading() {
  return (
    <div className="help-panel" role="dialog" aria-label="Help" aria-busy="true" style={{ padding: 14 }}>
      {[70, 100, 100, 85].map((w, i) => (
        <div key={i} style={{ height: i === 0 ? 14 : 34, width: `${w}%`, borderRadius: 8, background: 'var(--mist)', marginBottom: 10 }} />
      ))}
    </div>
  );
}

// The panel sits in the header on every screen, so a failure inside it (or a
// chunk that fails to load after a deploy) must stay inside it rather than
// take the header down with it.
class PanelBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="help-panel" role="dialog" aria-label="Help" style={{ padding: 14, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Help could not load right now. Refresh the page, or{' '}
        <button type="button" onClick={this.props.onContact}
          style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600, cursor: 'pointer' }}>
          contact support
        </button>.
      </div>
    );
  }
}

export default function HelpMenu({ activeView, onWhatsNew }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const returnFocusRef = useRef(null);

  const show = useCallback(() => {
    returnFocusRef.current = document.activeElement;
    setOpen(true);
  }, []);
  // restoreFocus: Esc / the close button hand focus back to where it was;
  // picking something (which navigates) or clicking elsewhere does not.
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    if (restoreFocus && el && el !== document.body && document.contains(el)) el.focus?.();
  }, []);

  // "?" anywhere (Shift+/ on US keyboards), plus the phone menu's event.
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

  // A click or tap anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) close(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, close]);

  return (
    <div className="help-menu-wrap" ref={wrapRef}>
      <button type="button" className="icon-btn help-menu-btn" aria-label="Help" title="Help"
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="?"
        onMouseEnter={loadPanel} onFocus={loadPanel}
        onClick={() => (open ? close() : show())}>
        <CircleHelp style={{ width: 17, height: 17 }} />
      </button>
      {open && (
        <PanelBoundary onContact={() => {
          close(false);
          window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'support' } }));
        }}>
          <Suspense fallback={<PanelLoading />}>
            <HelpPanel activeView={activeView} onWhatsNew={onWhatsNew} onClose={close} />
          </Suspense>
        </PanelBoundary>
      )}
    </div>
  );
}
