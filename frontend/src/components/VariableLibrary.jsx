import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Variable, Plus } from 'lucide-react';
import { api } from '../api';
import { tokenGroup, groupLabel, VARIABLE_DRAG_TYPE } from '../lib/mergeFieldTypes';

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

export default function VariableLibrary({ open, onClose, onInsert, localVariables = [], anchorLabel }) {
  const [variables, setVariables] = useState(null);
  const [query, setQuery] = useState('');
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // This document's own variables are merged in even before they reach a
  // saved template - otherwise a variable you just defined is missing from the
  // library you are looking at.
  const groups = useMemo(() => {
    const all = [...(variables || [])];
    const known = new Set(all.map(v => v.token));
    for (const token of localVariables) {
      if (!known.has(token)) {
        all.push({ token, label: humanize(token), group: displayGroup(token), source: 'document', usedBy: [] });
      }
    }
    const q = query.trim().toLowerCase();
    const matched = q
      ? all.filter(v => v.token.toLowerCase().includes(q)
                     || (v.label || '').toLowerCase().includes(q)
                     || (v.description || '').toLowerCase().includes(q)
                     || (v.group || '').toLowerCase().includes(q))
      : all;
    const out = new Map();
    for (const v of matched) {
      const g = v.group || 'Other';
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(v);
    }
    return [...out.entries()];
  }, [variables, localVariables, query]);

  if (!open) return null;

  const total = groups.reduce((n, [, items]) => n + items.length, 0);

  return (
    <aside style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 330, zIndex: 1200,
      background: 'var(--card)', borderLeft: '1px solid var(--line)',
      boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
    }} aria-label="Variable library">
      <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Variable size={16} style={{ color: 'var(--pine)' }} />
          <strong style={{ fontSize: 14, flex: 1 }}>Variable Library</strong>
          <button onClick={onClose} title="Close" aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
            <X size={16} />
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>
          Click to insert{anchorLabel ? ` into ${anchorLabel}` : ''}, or drag one onto the page.
        </p>
        <div style={{ position: 'relative', marginTop: 10 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input ref={searchRef} className="form-input" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search variables…"
            style={{ width: '100%', fontSize: 12.5, padding: '6px 8px 6px 27px' }} />
        </div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px 16px' }}>
        {variables === null && (
          <p style={{ fontSize: 12, color: 'var(--muted)', padding: 12 }}>Loading variables…</p>
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
          <section key={group} style={{ marginBottom: 14 }}>
            <h4 style={{
              fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--muted)', margin: '6px 0 6px 6px',
            }}>{group}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {items.map(v => (
                <button key={v.token} type="button" draggable
                  onClick={() => onInsert(v.token)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(VARIABLE_DRAG_TYPE, v.token);
                    // A plain-text fallback so a drop outside the editor (a
                    // comment box, another app) still says something useful.
                    e.dataTransfer.setData('text/plain', `{{${v.token}}}`);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={describe(v)}
                  style={{
                    textAlign: 'left', background: 'none', border: '1px solid transparent',
                    borderRadius: 7, padding: '6px 8px', cursor: 'grab', display: 'flex',
                    alignItems: 'center', gap: 8, fontFamily: 'Inter, sans-serif',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; e.currentTarget.style.borderColor = 'var(--line)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.label || v.token}
                    </span>
                    <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.token}
                    </span>
                    {v.description && (
                      /* Requirement 5: a variable carries a description, so
                         browsing tells you what it MEANS, not just its name. */
                      <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>
                        {v.description}
                      </span>
                    )}
                  </span>
                  <Plus size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
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
    ? `{{${v.token}}} - filled automatically from the document's person and company`
    : `{{${v.token}}}`;
}
