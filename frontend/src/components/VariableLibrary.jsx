import { useEffect, useMemo, useRef, useState } from 'react';
import { LoadingState } from './AsyncState';
import { X, Search, Variable, Plus, Pin, PinOff, GripVertical } from 'lucide-react';
import { api } from '../api';
import { tokenGroup, groupLabel, VARIABLE_DRAG_TYPE, FILLED_WHEN } from '../lib/mergeFieldTypes';
import AnchoredMenu from './AnchoredMenu';

// A built-in files under WHEN Nexus fills it, like the toolbar's insert picker.
const WHEN = Object.fromEntries(FILLED_WHEN.map(([k, label, where]) => [k, { label, where }]));
// The category chips' short names for those groups.
const SHORT = { person: 'Person', company: 'Company', offer: 'Offer / Hire', promotion: 'Promotion', separation: 'Separation', signers: 'Signers', document: 'Document' };

// ── Variable Library (requirement 5.2) ───────────────────────────────────────
// "Browse available variables. Select a variable. Insert it into the template.
// Ideally drag and drop. The user should not have to manually type complex
// curly-brace variables every time."
//
// Two sources, one list. The BUILT-INS the server resolves by itself from the
// subject person and company, and every variable the company's own templates
// already define - so the library grows with the library instead of needing a
// registry someone has to remember to maintain. Grouped by the dotted taxonomy
// (requirement 5.1): `principal.amount` files under "principal".
//
// Insertion is a mergeField NODE, never typed text: the chip carries the token
// and survives editing, which is what makes "{{principal.amount}}" impossible
// to typo into a document that then silently never populates.
//
// Where it opens (Neil, 11/11/2026): with an `anchorRef` (the Document
// Builder's Variables > Variable Library button) it is a flyout under that
// button, like a Word gallery - it closes when you click away, unless it is
// pinned, which keeps it floating while you drag several in. Without one it
// is the old panel at the right edge.

export default function VariableLibrary({ open, onClose, onInsert, localVariables = [], anchorLabel, anchorRef = null, pinned = false, onPin, used = null }) {
  const [variables, setVariables] = useState(null);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [error, setError] = useState('');
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError('');
    api.getDocVariables()
      .then(v => { if (live) setVariables(Array.isArray(v) ? v : []); })
      .catch(e => { if (live) { setVariables([]); setError(e?.message || 'Could not load the variable library.'); } });
    return () => { live = false; };
  }, [open]);

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  // The flyout's Escape is AnchoredMenu's; the panel keeps its own.
  useEffect(() => {
    if (!open || anchorRef) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, anchorRef]);

  // This document's own variables are merged in even before they reach a
  // saved template - otherwise a variable you just defined is missing from the
  // library you are looking at.
  const all = useMemo(() => {
    const out = [...(variables || [])];
    const known = new Set(out.map(v => v.token));
    for (const token of localVariables) {
      if (!known.has(token)) {
        out.push({ token, label: humanize(token), group: displayGroup(token), source: 'document', usedBy: [] });
      }
    }
    return out;
  }, [variables, localVariables]);
  const groupOf = (v) => (v.source === 'builtin' && WHEN[v.when]?.label) || v.group || 'Other';
  const shortOf = (g) => {
    const when = FILLED_WHEN.find(([, label]) => label === g);
    return when ? SHORT[when[0]] || g : g;
  };
  const cats = useMemo(() => {
    const order = (g) => { const i = FILLED_WHEN.findIndex(([, label]) => label === g); return i < 0 ? FILLED_WHEN.length : i; };
    return [...new Set(all.map(groupOf))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  }, [all]);   // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = all.filter((v) => (!cat || groupOf(v) === cat) && (!q
      || v.token.toLowerCase().includes(q)
      || (v.label || '').toLowerCase().includes(q)
      || (v.description || '').toLowerCase().includes(q)
      || (v.group || '').toLowerCase().includes(q)));
    const out = new Map();
    for (const v of matched) {
      const g = groupOf(v);
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(v);
    }
    return [...out.entries()];
  }, [all, query, cat]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  const flyout = !!anchorRef;

  const head = (
    <header className="nx-varlib-head">
      <div className="nx-varlib-title">
        <Variable size={15} style={{ color: 'var(--pine)' }} />
        <strong>Variable Library</strong>
        {flyout && onPin && (
          <button type="button" className="nx-varlib-icon" onClick={() => onPin(!pinned)} aria-pressed={pinned}
            title={pinned ? 'Unpin - close when I click away' : 'Pin - keep it open while I work'} aria-label={pinned ? 'Unpin the library' : 'Pin the library'}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
        <button type="button" className="nx-varlib-icon" onClick={onClose} title="Close" aria-label="Close"><X size={15} /></button>
      </div>
      <label className="nx-varlib-search">
        <Search size={13} aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search variables…" aria-label="Search variables" />
      </label>
      {cats.length > 1 && (
        <div className="nx-varlib-cats" role="group" aria-label="Show">
          <button type="button" className={!cat ? 'is-on' : ''} aria-pressed={!cat} onClick={() => setCat('')}>All</button>
          {cats.map((g) => (
            <button key={g} type="button" className={cat === g ? 'is-on' : ''} aria-pressed={cat === g} onClick={() => setCat(cat === g ? '' : g)} title={g}>{shortOf(g)}</button>
          ))}
        </div>
      )}
    </header>
  );

  const list = (
    <div className="nx-varlib-list">
      {variables === null && (
        <LoadingState compact label="Loading variables…" />
      )}
      {error && (
        <p style={{ fontSize: 12, color: 'hsl(var(--color-red))', padding: 12 }}>{error}</p>
      )}
      {variables !== null && total === 0 && !error && (
        <p style={{ fontSize: 12, color: 'var(--muted)', padding: 12 }}>
          {query ? `No variable matches "${query}".` : 'No variables yet.'}
        </p>
      )}
      {groups.map(([group, items]) => (
        <section key={group} className="nx-varlib-group">
          <h4>{group}</h4>
          {items.map(v => {
            const n = used?.[v.token] || 0;
            return (
              <button key={v.token} type="button" draggable className="nx-varlib-row"
                onClick={() => onInsert(v.token)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(VARIABLE_DRAG_TYPE, v.token);
                  // A plain-text fallback so a drop outside the editor (a
                  // comment box, another app) still says something useful.
                  e.dataTransfer.setData('text/plain', `{{${v.token}}}`);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                title={describe(v)}>
                <GripVertical size={13} className="nx-varlib-grip" aria-hidden="true" />
                <span className="nx-varlib-text">
                  <span className="nx-varlib-label">{v.label || v.token}</span>
                  <span className="nx-varlib-token">{v.token}</span>
                  {v.description && (
                    /* Requirement 5: a variable carries a description, so
                       browsing tells you what it MEANS, not just its name. */
                    <span className="nx-varlib-desc">{v.description}</span>
                  )}
                </span>
                {n > 0 ? <span className="nx-varlib-used">In Use · {n === 1 ? '1 Place' : `${n} Places`}</span>
                  : <Plus size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
  const foot = <p className="nx-varlib-foot">Click to insert{anchorLabel ? ` into ${anchorLabel}` : ''} at the cursor, or drag one onto the page.</p>;

  if (flyout) {
    return (
      <AnchoredMenu anchorRef={anchorRef} open onClose={() => { if (!pinned) onClose(); }} role="dialog" aria-label="Variable library"
        className={`nx-varlib is-flyout${pinned ? ' is-pinned' : ''}`} minWidth={340}>
        {head}{list}{foot}
      </AnchoredMenu>
    );
  }
  return (
    <aside className="nx-varlib is-panel" aria-label="Variable library">
      {head}{list}{foot}
    </aside>
  );
}


function humanize(token) {
  const tail = String(token || '').split('.').pop();
  return tail.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function displayGroup(token) {
  const g = tokenGroup(token);
  return g === 'general' ? 'This document' : groupLabel(g);
}

function describe(v) {
  if (v.usedBy?.length) {
    const shown = v.usedBy.slice(0, 3).join(', ');
    const more = v.usedBy.length > 3 ? ` +${v.usedBy.length - 3} more` : '';
    return `{{${v.token}}} - used by ${shown}${more}`;
  }
  return v.source === 'builtin'
    ? `{{${v.token}}} - filled by Nexus. ${WHEN[v.when]?.where || "From the document's person and company"}`
    : `{{${v.token}}}`;
}
