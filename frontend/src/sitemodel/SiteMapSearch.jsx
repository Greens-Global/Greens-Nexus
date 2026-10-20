// The ONE search on the Operations Site Map (Visesh, Oct 20 2026: two search
// boxes on one screen read as "glitchy"). It sits on the map, top-left:
//   - Units at this facility: an instant prefix match on the model's units
//     ("c2" finds C214, "c-214" finds C214).
//   - Tenants and Other Facilities: the same Cubby lookup the Operations
//     search uses (remoteSearch, debounced, the newest answer wins). A hit here
//     opens that unit; a hit at another facility switches the facility and
//     opens it there; a facility with no site map offers Cubby only.
// Not-found and not-on-the-map messages show inside the popover, never as red
// text that pushes the layout around. Customer pages never pass remoteSearch,
// so no tenant data can appear there.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import { normalizeQuery } from './unitQuery.js';

const HIT_WORD = { rented: 'Leased', vacant: 'Vacant', 'off-market': 'Off Market' };
const MAX = 6;

export function SiteMapSearch({ units = [], placeName = '', statusWord = null, onPickUnit, unplaced = [], remoteSearch = null, onRemoteHit = null }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [msg, setMsg] = useState('');
  const [remote, setRemote] = useState({ term: '', status: 'idle', hits: [] });
  const latest = useRef(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const id = useId();
  const term = q.trim();
  const norm = normalizeQuery(term);

  const local = useMemo(() => {
    if (!term) return [];
    const raw = term.toUpperCase().replace(/[\s-]+/g, '');
    const hits = units.filter((u) => u.n.startsWith(raw) || u.n.startsWith(norm));
    hits.sort((a, b) => (a.n === norm ? -1 : b.n === norm ? 1 : a.n.localeCompare(b.n)));
    return hits.slice(0, MAX);
  }, [units, term, norm]);

  // Cubby: tenants anywhere and units at the other facilities.
  useEffect(() => {
    if (!remoteSearch || term.length < 2) return undefined;
    const mine = ++latest.current;
    const t = setTimeout(async () => {
      if (mine !== latest.current) return;
      setRemote({ term, status: 'loading', hits: [] });
      try {
        const hits = await remoteSearch(term);
        if (mine === latest.current) setRemote({ term, status: 'ready', hits: hits || [] });
      } catch (err) {
        console.error('Site map lookup failed', err);
        if (mine === latest.current) setRemote({ term, status: 'error', hits: [] });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [term, remoteSearch]);

  const localNames = new Set(local.map((u) => u.n));
  const remoteNow = remoteSearch && term.length >= 2 && remote.term === term ? remote : { status: remoteSearch && term.length >= 2 ? 'loading' : 'idle', hits: [] };
  const remoteHits = remoteNow.hits.filter((h) => !(h.here && localNames.has(normalizeQuery(h.unit)))).slice(0, MAX);
  const options = [...local.map((u) => ({ key: `u-${u.n}`, unit: u })), ...remoteHits.map((h) => ({ key: `h-${h.facilityId}-${h.unit}`, hit: h }))];

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const done = () => { setQ(''); setMsg(''); setActive(-1); setOpen(false); inputRef.current?.blur(); };
  const pickUnit = (n) => {
    if (onPickUnit?.(n)) { done(); return; }
    setOpen(true);
    setMsg(unplaced.some((x) => x.n === n)
      ? `Unit ${n} is here but not on the map yet. The office can point you to it.`
      : `No unit ${n || '?'} at ${placeName || 'this property'}.`);
  };
  const choose = (opt) => {
    if (opt.unit) return pickUnit(opt.unit.n);
    const h = opt.hit;
    if (h.here) return pickUnit(normalizeQuery(h.unit));
    if (h.noMap) return undefined;
    onRemoteHit?.(h); done();
    return undefined;
  };
  const submit = (e) => {
    e.preventDefault();
    if (!term) return;
    if (active >= 0 && options[active]) { choose(options[active]); return; }
    if (units.some((u) => u.n === norm)) { pickUnit(norm); return; }
    // one match opens on Enter only when it is here; another facility is a click away, never a surprise
    if (options.length === 1 && (options[0].unit || options[0].hit.here)) { choose(options[0]); return; }
    if (/^[A-Z]\d/.test(norm) && !local.length) { pickUnit(norm); return; }
    setOpen(true);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); setActive(-1); } else if (q) setQ(''); }
  };

  const show = open && !!term;
  const optId = (i) => `${id}-o${i}`;
  const row = (opt, idx) => {
    const h = opt.hit; const u = opt.unit;
    const word = u ? (statusWord ? statusWord(u) : '') : HIT_WORD[h.status] || '';
    return (
      <li key={opt.key} id={optId(idx)} role="option" aria-selected={active === idx} aria-disabled={h?.noMap || undefined}
        className="sm-sr-row" data-active={active === idx} data-off={!!h?.noMap}
        onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(idx)} onClick={() => choose(opt)}>
        <b className="sm-sr-unit">{u ? u.n : h.unit}</b>
        <span className="sm-sr-main">
          {u ? (u.w && u.d ? `${u.w} × ${u.d} ft` : '') : (h.tenant || (h.here ? placeName : h.facility))}
          {h && h.tenant ? <span className="sm-sr-muted"> · {h.here ? placeName || h.facility : h.facility}</span> : null}
          {h?.noMap ? <span className="sm-sr-muted"> · No Site Map Yet</span> : null}
        </span>
        {h?.noMap && h.url
          ? <a className="sm-sr-link" href={h.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Open in Cubby <ExternalLink size={11} aria-hidden="true" /></a>
          : word ? <span className="sm-sr-word">{word}</span> : null}
      </li>
    );
  };

  return (
    <form ref={boxRef} className="sm-search" role="search" onSubmit={submit}>
      <label className="sm-search-box">
        <Search size={15} aria-hidden="true" />
        <input ref={inputRef} type="text" value={q} placeholder="Find a unit or tenant" aria-label="Find a unit or tenant" autoComplete="off" spellCheck={false}
          role="combobox" aria-expanded={show} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={show && active >= 0 ? optId(active) : undefined}
          onChange={(e) => { setQ(e.target.value); setMsg(''); setActive(-1); setOpen(true); }}
          onFocus={() => setOpen(true)} onKeyDown={onKey} />
        {q && <button type="button" className="sm-search-x" onClick={() => { setQ(''); setMsg(''); inputRef.current?.focus(); }} aria-label="Clear search"><X size={14} aria-hidden="true" /></button>}
      </label>
      {show && (
        <div className="sm-search-pop" aria-live="polite">
          {msg && <p className="sm-sr-msg" role="status">{msg}</p>}
          <ul id={`${id}-list`} role="listbox" aria-label="Search results" className="sm-sr-list">
            {local.length > 0 && <li role="presentation" className="sm-sr-group">{placeName ? `Units at ${placeName}` : 'Units Here'}</li>}
            {local.map((u, k) => row(options[k], k))}
            {remoteSearch && term.length >= 2 && (remoteHits.length > 0 || remoteNow.status !== 'ready' || !local.length) && (
              <li role="presentation" className="sm-sr-group">Tenants and Other Facilities</li>
            )}
            {remoteHits.map((h, k) => row(options[local.length + k], local.length + k))}
          </ul>
          {remoteSearch && term.length >= 2 && remoteNow.status === 'loading' && !remoteHits.length && <p className="sm-sr-note">Searching Cubby...</p>}
          {remoteSearch && term.length >= 2 && remoteNow.status === 'error' && <p className="sm-sr-note">Cubby could not be searched. Try again.</p>}
          {!msg && !local.length && !remoteHits.length && (!remoteSearch || term.length < 2 || remoteNow.status === 'ready') && (
            <p className="sm-sr-note">{remoteSearch ? `No unit or tenant matches "${term}".` : `No unit matches "${term}".`}</p>
          )}
        </div>
      )}
    </form>
  );
}

export default SiteMapSearch;
