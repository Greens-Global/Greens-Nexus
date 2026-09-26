// The Help menu's panel (opened by HelpMenu.jsx). Loaded on first open, so
// the guide's text and the search index stay out of the first page load.
//
// Top to bottom: search the guide, help for the page you are on, the standing
// links (Getting Started, all documentation, a tour where the page has one,
// What's New), and Contact Support last - self-service first.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, X, BookOpen, ListChecks, Layers, Lightbulb, ShieldCheck,
  Compass, Library, PlayCircle, Megaphone, LifeBuoy, ChevronRight, CornerDownLeft,
} from 'lucide-react';
import { searchDocs, docForView, walkthroughAnchor } from './docsSearch';
import { useDocAccess } from './docsAccess';
import { openDoc } from './openDoc';

// Guided tours that exist today, keyed by view. Each view owns its tour and
// listens for its own event (TopHeader's profile menu fires the same ones).
const TOURS = {
  tasks: 'nexus:tasks-tour',
  tickets: 'nexus:tickets-tour',
  support: 'nexus:support-tour',
};

const KIND_ICON = { module: BookOpen, walkthrough: ListChecks, feature: Layers, tip: Lightbulb, manager: ShieldCheck };
const KIND_LABEL = { module: 'Guide', walkthrough: 'How To', feature: 'Feature', tip: 'Tip', manager: 'For Managers' };
const BRAND = 'var(--wk-brand, #2b45e1)';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const nav = (view, sub) => window.dispatchEvent(
  new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));

export default function HelpPanel({ activeView, onWhatsNew, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const { allow } = useDocAccess();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(
    () => (query.trim() ? searchDocs(query, { limit: 7, allow }) : []),
    [query, allow],
  );
  const onQuery = (value) => { setQuery(value); setActive(0); };

  const pageDoc = useMemo(() => {
    const d = docForView(activeView);
    return d && allow(d.id) ? d : null;
  }, [activeView, allow]);
  const tourEvent = TOURS[activeView];

  // Every action closes the panel first; focus then belongs to wherever it goes.
  const go = (fn) => { onClose(false); fn(); };
  const pick = (r) => go(() => openDoc(r.docId, r.anchor));

  // Arrow keys walk the results, Enter opens one, Esc closes, Tab stays inside.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
    if (e.key === 'Tab') {
      const items = [...(panelRef.current?.querySelectorAll(FOCUSABLE) || [])];
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (!results.length || e.target !== inputRef.current) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[Math.min(active, results.length - 1)]); }
  };

  const links = [
    { key: 'start', Icon: Compass, label: 'Getting Started', hint: 'The layout, search, alerts and access', run: () => openDoc('getting-started') },
    { key: 'docs', Icon: Library, label: 'Browse All Documentation', hint: 'Every module, step by step', run: () => nav('support', 'documentation') },
    tourEvent && { key: 'tour', Icon: PlayCircle, label: 'Take a Tour', hint: 'A guided walk through this page', run: () => window.dispatchEvent(new CustomEvent(tourEvent)) },
    onWhatsNew && { key: 'new', Icon: Megaphone, label: "What's New", hint: 'Recent changes to Nexus', run: onWhatsNew },
  ].filter(Boolean);

  const q = query.trim();

  return (
    <div className="help-panel" role="dialog" aria-label="Help" ref={panelRef} onKeyDown={onKeyDown}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px 14px' }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Help</div>
        <button type="button" onClick={() => onClose(true)} aria-label="Close help" className="help-panel-close">
          <X size={15} />
        </button>
      </div>

      <div style={{ padding: '0 12px 10px' }}>
        <div className="help-search">
          <Search size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input ref={inputRef} type="text" value={query} onChange={(e) => onQuery(e.target.value)}
            placeholder="Search help, e.g. request time off" aria-label="Search help"
            role="combobox" aria-expanded={results.length > 0} aria-controls="help-results" aria-autocomplete="list"
            aria-activedescendant={results.length ? `help-result-${active}` : undefined}
            autoComplete="off" spellCheck={false} />
          {query && (
            <button type="button" onClick={() => { onQuery(''); inputRef.current?.focus(); }} aria-label="Clear search"
              className="help-panel-close" style={{ width: 22, height: 22 }}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {q ? (
        <div style={{ padding: '0 6px 8px' }}>
          {results.length > 0 ? (
            <ul id="help-results" role="listbox" aria-label="Help articles" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {results.map((r, i) => {
                const Icon = KIND_ICON[r.kind] || BookOpen;
                return (
                  <li key={r.id} id={`help-result-${i}`} role="option" aria-selected={i === active}>
                    <button type="button" tabIndex={-1} className={`help-row${i === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(i)} onClick={() => pick(r)}>
                      <span className="help-row-icon"><Icon size={14} /></span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="help-row-title">{r.kind === 'tip' ? r.body[0] : r.title}</span>
                        <span className="help-row-sub">
                          {r.kind === 'module' ? (r.snippet || r.group) : `${KIND_LABEL[r.kind]} in ${r.docName}`}
                        </span>
                      </span>
                      {i === active && <CornerDownLeft size={13} aria-hidden style={{ color: 'var(--muted)', flexShrink: 0, marginTop: 2 }} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div style={{ padding: '14px 10px 10px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              No articles match "{q}". Try other words, or contact support below.
            </div>
          )}
        </div>
      ) : (
        <>
          {pageDoc && (
            <div style={{ padding: '0 12px 10px' }}>
              <div className="help-section-label">Help for This Page</div>
              <div className="help-page-card">
                <button type="button" className="help-page-head" onClick={() => go(() => openDoc(pageDoc.id))}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="help-row-title">{pageDoc.name}</span>
                    <span className="help-row-sub">{pageDoc.tagline}</span>
                  </span>
                  <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                </button>
                {(pageDoc.walkthroughs || []).slice(0, 3).map((w) => (
                  <button key={w.title} type="button" className="help-page-link"
                    onClick={() => go(() => openDoc(pageDoc.id, walkthroughAnchor(w.title)))}>
                    <ListChecks size={13} style={{ flexShrink: 0, color: BRAND }} />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ padding: '0 6px 6px' }}>
            {links.map(({ key, Icon, label, hint, run }) => (
              <button key={key} type="button" className="help-row" onClick={() => go(run)}>
                <span className="help-row-icon"><Icon size={14} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="help-row-title">{label}</span>
                  <span className="help-row-sub">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div style={{ borderTop: '1px solid var(--line)', padding: 6 }}>
        <button type="button" className="help-row" onClick={() => go(() => nav('support'))}>
          <span className="help-row-icon" style={{ color: BRAND }}><LifeBuoy size={14} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="help-row-title">Contact Support</span>
            <span className="help-row-sub">Still stuck? Reach the right team from the Help Center.</span>
          </span>
        </button>
      </div>
      <div className="help-panel-hint">Press <kbd>?</kbd> anywhere to open help</div>
    </div>
  );
}
