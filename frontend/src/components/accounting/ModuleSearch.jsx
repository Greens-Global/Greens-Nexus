import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { control } from './reportControls';

// The ledger search at the top right of every Accounting screen, as an icon
// (chat 10/26, item 13 - Urmi, after Viral's 10/22 idea: "make only icons as
// Search and when press CTR + F it will open"). It matches the screens' own
// icon searches (BarSearch, Vendors & Customers): a click or Ctrl+F opens the
// box with the cursor in it, Escape closes it and keeps what was typed (the
// icon stays lit while it holds a search), and a box left empty closes when
// it loses focus. What the search does is the shell's, unchanged.
//
// Ctrl+F belongs to the screen's own search first: Vendors & Customers opens
// its list search on Ctrl+F, so this one only takes the key when no screen
// did (the key is looked at after every other handler has had it). With a
// popup open (a journal entry, a dialog) the browser keeps its own find.

const isFindKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'f';

export default function ModuleSearch({ value, onChange, onSubmit, waiting = false }) {
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const icon = useRef(null);
  const openBox = () => {
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  const openRef = useRef(openBox);
  useEffect(() => { openRef.current = openBox; });
  // Cleared from outside (leaving Reports) while nobody is in it: back to the icon.
  useEffect(() => {
    if (!value && open && document.activeElement !== input.current) setOpen(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Capture phase: queue a look at the same key press for after every
    // other window listener (one added during the dispatch runs last), so a
    // screen's own Ctrl+F wins whenever it has one.
    const onKey = (e) => {
      if (!isFindKey(e)) return;
      const late = (ev) => {
        if (ev !== e || e.defaultPrevented) return;
        if (document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        openRef.current();
      };
      window.addEventListener('keydown', late, { once: true });
      // A key stopped before it got back to the window never reaches `late`.
      setTimeout(() => window.removeEventListener('keydown', late), 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) {
    const lit = !!value;
    return (
      <button ref={icon} type="button" onClick={openBox} aria-label="Search the Ledger" aria-expanded={false}
        title={lit ? `Search: ${value} (Ctrl+F)` : 'Search vendor, customer, invoice, amount, memo (Ctrl+F)'}
        style={{ ...control, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, padding: 0, position: 'relative',
          color: lit ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', ...(lit ? { borderColor: 'var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)' } : null) }}>
        {waiting ? <Loader2 size={14} className="spin" aria-label="Searching" /> : <Search size={14} />}
      </button>
    );
  }
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); onSubmit?.(value); }} style={{ position: 'relative' }}>
      {waiting
        ? <Loader2 size={14} className="spin" aria-label="Searching" style={{ position: 'absolute', left: 9, top: 8, color: 'var(--wk-brand, #2b45e1)' }} />
        : <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />}
      <input ref={input} type="text" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Search the ledger" autoFocus
        onBlur={() => { if (!value.trim()) setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          setOpen(false);
          requestAnimationFrame(() => icon.current?.focus());
        }}
        placeholder="Search vendor, customer, invoice, amount, memo..." style={{ ...control, width: '100%', paddingLeft: 28, paddingRight: 26 }} />
      {value && (
        <button type="button" onClick={() => { onChange(''); input.current?.focus(); }} aria-label="Clear search"
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}>
          <X size={14} />
        </button>
      )}
    </form>
  );
}
