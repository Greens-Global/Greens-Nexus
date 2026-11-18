import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { MENU_PANEL } from './menuParts.jsx';
import { cityRegion } from '../../lib/portfolioCards.js';
import { searchSuggestions } from '../../lib/portfolioQuery.js';

/**
 * The one search box (Neil, 11/17/2026). As you type, a menu: Filter By (the phrase read by
 * rules - "stabilized in TX over 3 acres", "no manager", "tax due in december" - and every
 * facet value whose name holds the words), Properties (name or address), Inside Records
 * (utilities, AHJ, permits, vendors, a VIN or plate). Nothing applies until it is picked:
 * Enter picks the highlighted row, else the top Filter By; with no suggestion Enter searches
 * the words. Up / Down move, Escape closes.
 */
export function SmartSearch({ value, onSearch, onFilter, onOpenAsset, onOpenRecord, ctx, options, store, filters, placeholder = 'Search or filter - try "self storage in CA"', autoFocusKey }) {
  const [text, setText] = useState(value || '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [menuW, setMenuW] = useState(360);
  const wrap = useRef(null);
  const input = useRef(null);
  const listId = useId();
  useEffect(() => { setText(value || ''); }, [value]);
  useEffect(() => { if (autoFocusKey) input.current?.focus(); }, [autoFocusKey]);

  const sug = useMemo(() => (open ? searchSuggestions(text, ctx, options, store, filters) : { filterBy: [], properties: [], records: [] }), [open, text, ctx, options, store, filters]);
  const flat = [
    ...sug.filterBy.map((s) => ({ kind: 'filter', s })),
    ...sug.properties.map((a) => ({ kind: 'asset', a })),
    ...sug.records.map((r) => ({ kind: 'record', r })),
  ];
  const showMenu = open && text.trim().length >= 2;
  useEffect(() => { setActive(-1); }, [text]);

  const pick = (item) => {
    setOpen(false);
    if (!item) return;
    if (item.kind === 'filter') { onFilter(item.s.patch); setText(''); }   // onFilter also clears the words
    else if (item.kind === 'asset') onOpenAsset(item.a.id);
    else onOpenRecord(item.r);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && flat[active]) pick(flat[active]);
      else if (sug.filterBy[0] && showMenu) pick({ kind: 'filter', s: sug.filterBy[0] });
      else { setOpen(false); onSearch(text.trim()); }
    } else if (e.key === 'Escape') {
      if (showMenu) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    }
  };
  const optId = (n) => `${listId}-o${n}`;
  const nF = sug.filterBy.length;
  const nP = sug.properties.length;
  const row = (item, idx, body, extra = null) => {
    return (
      <div key={idx} id={optId(idx)} role="option" aria-selected={active === idx} className={`pt-sug${active === idx ? ' is-active' : ''}`}
        onMouseEnter={() => setActive(idx)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}>
        {body}
        {extra}
      </div>
    );
  };

  return (
    <div ref={wrap} className="pt-search">
      <Search size={15} className="pt-search-icon" aria-hidden="true" />
      <input ref={input} className="form-input" value={text} placeholder={placeholder}
        role="combobox" aria-expanded={showMenu} aria-controls={listId} aria-autocomplete="list" aria-label="Search or filter properties"
        aria-activedescendant={showMenu && active >= 0 ? optId(active) : undefined}
        onChange={(e) => { setText(e.target.value); setOpen(true); if (!e.target.value) onSearch(''); }}
        onFocus={() => { setOpen(true); setMenuW(Math.max(360, wrap.current?.offsetWidth || 0)); }} onKeyDown={onKeyDown} />
      {text && (
        <button type="button" className="pt-search-clear" aria-label="Clear the search" onClick={() => { setText(''); onSearch(''); input.current?.focus(); }}>
          <X size={14} />
        </button>
      )}
      <AnchoredMenu anchorRef={wrap} open={showMenu} onClose={() => setOpen(false)} role="listbox" id={listId} aria-label="Suggestions"
        minWidth={menuW} style={{ ...MENU_PANEL, padding: '6px 0', maxWidth: 560 }}>
        {flat.length === 0 && <div className="pt-sug-empty">Nothing matches "{text.trim()}". Press Enter to search the words anyway.</div>}
        {sug.filterBy.length > 0 && (
          <div role="group" aria-label="Filter By">
            <div className="pt-menu-heading">Filter By</div>
            {sug.filterBy.map((s, k) => row({ kind: 'filter', s }, k, (
              <>
                <SlidersHorizontal size={14} className="pt-sug-icon" aria-hidden="true" />
                <span className="pt-sug-words">{s.label}{s.value ? <> <b>{s.value}</b></> : null}</span>
              </>
            ), <span className={`pt-sug-side${s.count === 0 ? ' is-zero' : ''}`}>{s.count} {s.count === 1 ? 'property' : 'properties'}</span>))}
          </div>
        )}
        {sug.properties.length > 0 && (
          <div role="group" aria-label="Properties">
            <div className="pt-menu-heading">Properties</div>
            {sug.properties.map((a, k) => {
              const photo = (a.images && a.images[0]) || a.image || '';
              return row({ kind: 'asset', a }, nF + k, (
                <>
                  <span className="pt-sug-thumb" aria-hidden="true">{photo ? <img src={photo} alt="" /> : null}</span>
                  <span className="pt-sug-words"><b>{a.siteName || a.name}</b>{cityRegion(a) ? <span className="pt-dim"> - {cityRegion(a)}</span> : null}</span>
                </>
              ));
            })}
          </div>
        )}
        {sug.records.length > 0 && (
          <div role="group" aria-label="Inside Records">
            <div className="pt-menu-heading">Inside Records</div>
            {sug.records.map((r, k) => row({ kind: 'record', r }, nF + nP + k, (
              <span className="pt-sug-words">{r.title}<span className="pt-dim"> - {r.detail}</span></span>
            ), <span className="pt-sug-side">{r.group}</span>))}
          </div>
        )}
        <div className="pt-sug-foot">Type a phrase to filter: "stabilized in TX over 3 acres", "no manager", "tax due in December". Up and down arrows move, Enter picks.</div>
      </AnchoredMenu>
    </div>
  );
}
