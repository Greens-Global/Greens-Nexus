import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useNexusSearch, SEARCH_PLACEHOLDER, SEARCH_HINT, SEARCH_LABEL } from './search/useNexusSearch';
import SearchResults from './search/SearchResults';

// ── The search sheet ─────────────────────────────────────────────────────────
// The same Nexus search as the header bar (components/search/useNexusSearch),
// as a full-screen sheet for phones, where the header has no room for a bar.
// Opened by the header's search icon and by Ctrl/Cmd+K or "/" on a phone;
// on a desktop those keys focus the header bar instead (TopHeader).
export default function GlobalSearch() {
  const [open,      setOpen]      = useState(false);
  const [query,     setQuery]     = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef  = useRef(null);
  const search = useNexusSearch(query, { enabled: open });


  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 30);   // after the sheet paints
    document.body.style.overflow = 'hidden';
    return () => { clearTimeout(t); document.body.style.overflow = ''; };
  }, [open]);

  // Every opening starts clean.
  const openSheet = useCallback(() => { setQuery(''); setActiveIdx(0); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);
  const pick = useCallback((row) => { setOpen(false); row.run?.(); }, []);
  useEffect(() => {
    window.addEventListener('nexus:search-open', openSheet);
    return () => window.removeEventListener('nexus:search-open', openSheet);
  }, [openSheet]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  function onKeyDown(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(search.rows.length - 1, i + 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter' && search.rows[activeIdx]) { e.preventDefault(); pick(search.rows[activeIdx]); }
  }

  if (!open) return null;
  return (
    <div className="gs-overlay" onClick={e => e.target === e.currentTarget && close()}>
      <div className="gs-panel" role="search" aria-label={SEARCH_LABEL}>
        <div className="gs-input-row">
          <Search size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input ref={inputRef} className="gs-input" placeholder={SEARCH_PLACEHOLDER} aria-label={SEARCH_LABEL}
            value={query} onChange={e => { setQuery(e.target.value); setActiveIdx(0); }} onKeyDown={onKeyDown} />
          <kbd className="gs-kbd">esc</kbd>
          {/* Phones have no Esc key and the sheet is full-screen (no backdrop
              to tap) - without this button search was a one-way door. */}
          <button onClick={close} aria-label="Close search" title="Close"
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:6, borderRadius:8, flexShrink:0 }}>
            <X size={18} />
          </button>
        </div>
        {query.trim()
          ? <SearchResults query={query} groups={search.groups} rows={search.rows} searching={search.searching}
              activeIdx={activeIdx} onActive={setActiveIdx} onPick={pick} listRef={listRef} />
          : <div className="gs-hint">{SEARCH_HINT}</div>}
      </div>
    </div>
  );
}
