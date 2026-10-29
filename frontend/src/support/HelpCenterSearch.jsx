// The search bar at the top of the Help Center page (Oct 2026). Same engine
// as the Help panel: the written guide (only pages this person may read), the
// Knowledge Base documents and courses. Results drop down as you type; Enter
// or Ask Nexus asks for a written answer instead (AskNexus.jsx), with File a
// Ticket one click away.
//
// The bar itself is tiny; the guide and the search engine load the first time
// someone focuses it (HelpCenterResults.jsx), so opening the Help Center does
// not pull the whole guide down for people who only came to check a ticket.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Search, Sparkles, X } from 'lucide-react';

const loadResults = () => import('./HelpCenterResults');
const Results = lazy(loadResults);
const Answer = lazy(() => import('./HelpCenterAnswer'));

/** @param {(seed: {subject, description}) => void} onFileTicket */
export default function HelpCenterSearch({ onFileTicket }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const q = query.trim();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const ask = (text = q) => {
    if (!text) return;
    setAsked(text);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="hc-search" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <form role="search" onSubmit={(e) => { e.preventDefault(); ask(); }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
          padding: '6px 6px 6px 14px', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
        <Search size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
        <input ref={inputRef} type="search" value={query} aria-label="Search for help"
          placeholder="Search for help, or ask a question" autoComplete="off" spellCheck={false}
          onFocus={() => { loadResults(); if (q) setOpen(true); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(!!e.target.value.trim()); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
          style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--ink)', fontSize: 16,
            fontFamily: 'inherit', padding: '6px 0' }} />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setOpen(false); setAsked(''); inputRef.current?.focus(); }}
            style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 4, display: 'grid', placeItems: 'center' }}>
            <X size={15} />
          </button>
        )}
        <button type="submit" className="primary-btn" disabled={!q}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 13, whiteSpace: 'nowrap' }}>
          <Sparkles size={14} /> Ask Nexus
        </button>
      </form>

      {open && q && (
        <Suspense fallback={null}>
          <Results query={query} onAsk={() => ask(q)} onClose={() => setOpen(false)} />
        </Suspense>
      )}

      {asked && (
        <Suspense fallback={null}>
          <Answer question={asked} onFileTicket={onFileTicket} />
        </Suspense>
      )}
    </div>
  );
}
