import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Eye, EyeOff, Funnel, MoveHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import AnchoredMenu from '../../AnchoredMenu';
import { DateField } from '../../../tasks/components';
import { MAX_RULES, kindOf, opOf, opsFor, ruleText } from './model';

// The standard table view's panels and menus (10/23 meeting, item 01), loaded
// the first time one opens (./controls lazy-loads this file):
//   filters / filter   the rules: field + condition + value, up to 20, All or Any
//   values             a heading's value list, Excel style, with a search
//   menu               a heading's menu: sort, filter this column, manual width,
//                      move left / right, hide, show hidden column (07:34)
//   columns            show / hide / order every column
//   views / save       Built-in Default and the person's own views; save as
// Viral, 07:28: "Click on add filter ... You can make a filter custom. Yes, I
// can save it here."

const panel = (width) => ({
  width, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10,
  boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10, fontSize: '0.8rem', color: 'var(--text-primary)',
});
const field = {
  height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem',
  fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', boxSizing: 'border-box', minWidth: 0,
};
const item = (on = false, disabled = false) => ({
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6,
  background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '6px 8px', font: 'inherit', fontSize: '0.8rem',
  color: disabled ? 'var(--text-muted)' : 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
});
const link = { border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', padding: 0 };
const iconBtn = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)', borderRadius: 6 };
const head = { fontSize: '0.84rem', fontWeight: 700 };
const hint = { fontSize: '0.72rem', color: 'var(--text-muted)' };
const muted = { color: 'var(--text-muted)', flexShrink: 0 };
const done = (onClick, text = 'Done') => <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={onClick}>{text}</button>;

export default function Panels({ kind, view, col = null, anchor, onClose, onKind }) {
  const common = { anchorRef: anchor, open: true, onClose };
  if (kind === 'menu' && col) return <ColumnMenu {...common} view={view} col={col} onKind={onKind} anchor={anchor} />;
  if (kind === 'values' && col) return <ValueList {...common} view={view} col={col} />;
  if (kind === 'filters' || (kind === 'filter' && col)) return <FilterPanel {...common} view={view} focusCol={kind === 'filter' ? col : null} />;
  if (kind === 'columns') return <ColumnsChooser {...common} view={view} />;
  if (kind === 'views' || kind === 'save') return <ViewsMenu {...common} view={view} saving={kind === 'save'} />;
  return null;
}

// ── Filters: the rules ─────────────────────────────────────────────────────
function RuleValue({ col, value, onChange, label, autoFocus = false }) {
  const kind = kindOf(col);
  if (kind === 'date') {
    return (
      <div style={{ ...field, display: 'flex', alignItems: 'center', flex: '1 1 130px' }}>
        <DateField value={value || ''} onChange={(v) => onChange(v || '')} placeholder="MM/DD/YYYY" title={label} style={{ width: '100%' }} />
      </div>
    );
  }
  return (
    <input type="text" inputMode={kind === 'number' ? 'decimal' : undefined} value={value} onChange={(e) => onChange(e.target.value)}
      aria-label={label} placeholder={kind === 'number' ? '0.00' : 'Value'} autoFocus={autoFocus}
      style={{ ...field, flex: '1 1 130px', textAlign: kind === 'number' ? 'right' : 'left' }} className={kind === 'number' ? 'num' : undefined} />
  );
}

function FilterPanel({ view, focusCol, ...menu }) {
  const cols = view.arranged.filter((c) => !c.noFilter);
  const byKey = new Map(view.allColumns.map((c) => [c.key, c]));
  const rules = view.state.rules;
  // The value box to put the cursor in: the column's rule when opened from a
  // heading ("Filter This Column"), else a rule added while the panel is open.
  const [initial] = useState(() => new Set(rules.map((r) => r.id)));
  const newest = rules[rules.length - 1]?.id || '';
  const focusId = focusCol ? [...rules].reverse().find((r) => r.col === focusCol.key)?.id : initial.has(newest) ? '' : newest;
  const picks = Object.keys(view.state.picks).filter((k) => byKey.has(k));
  const full = rules.length >= MAX_RULES;
  return (
    <AnchoredMenu {...menu} role="dialog" aria-label="Filters" align="end" style={{ ...panel(640), display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={head}>Filters</div>
          <div style={hint}>Up to {MAX_RULES} rules. Each is a field, a condition and a value.</div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
          Match
          <select value={view.state.match} onChange={(e) => view.setMatch(e.target.value)} aria-label="Match all or any rule" style={field}>
            <option value="all">All</option>
            <option value="any">Any</option>
          </select>
        </label>
      </div>
      {rules.length > 1 && (
        <div style={hint}>{view.state.match === 'any' ? 'A row shows when it passes any one rule.' : 'A row shows only when it passes every rule.'}</div>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        {rules.map((r, i) => {
          const col = byKey.get(r.col) || cols[0];
          if (!col) return null;
          const op = opOf(col, r.op);
          return (
            <div key={r.id} role="group" aria-label={`Rule ${i + 1}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <select value={col.key} onChange={(e) => view.setRule(r.id, { col: e.target.value })} aria-label={`Rule ${i + 1} field`} style={{ ...field, flex: '0 1 170px' }}>
                {cols.map((c) => <option key={c.key} value={c.key}>{c.label}{c.hidden ? ' (hidden)' : ''}</option>)}
                {!cols.some((c) => c.key === col.key) && <option value={col.key}>{col.label}</option>}
              </select>
              <select value={op.key} onChange={(e) => view.setRule(r.id, { op: e.target.value })} aria-label={`Rule ${i + 1} condition`} style={{ ...field, flex: '0 1 190px' }}>
                {opsFor(col).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {!op.none && <RuleValue col={col} value={r.a} onChange={(v) => view.setRule(r.id, { a: v })} label={`Rule ${i + 1} value`} autoFocus={r.id === focusId} />}
              {op.two && (
                <>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>and</span>
                  <RuleValue col={col} value={r.b} onChange={(v) => view.setRule(r.id, { b: v })} label={`Rule ${i + 1} second value`} />
                </>
              )}
              {op.none && <span style={{ flex: '1 1 130px' }} />}
              <button type="button" style={iconBtn} onClick={() => view.removeRule(r.id)} aria-label={`Delete rule ${i + 1}`} title="Delete this rule"><Trash2 size={15} /></button>
            </div>
          );
        })}
        {!rules.length && <div style={{ ...hint, padding: '4px 2px' }}>No rules yet. Add Filter starts one.</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="secondary-btn" disabled={full || !cols.length} onClick={() => view.addRule(focusCol?.key)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }} title={full ? `Up to ${MAX_RULES} rules` : 'Add a rule'}>
          <Plus size={14} /> Add Filter
        </button>
        <span style={{ flex: 1 }} />
        {(rules.length > 0 || picks.length > 0) && <button type="button" style={link} onClick={view.clearFilters}>Remove All Filters</button>}
        {done(menu.onClose)}
      </div>
      {picks.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={hint}>Picked on the headings:</span>
          {picks.map((k) => {
            const p = view.state.picks[k];
            const n = (p.in || p.out || []).length;
            const text = p.in ? `${byKey.get(k).label}: ${n} ${n === 1 ? 'value' : 'values'}` : `${byKey.get(k).label}: all but ${n}`;
            return (
              <span key={k} className="acct-vh-chip">
                {text}
                <button type="button" onClick={() => view.setPick(k, null)} aria-label={`Remove the ${byKey.get(k).label} value filter`} style={{ ...iconBtn, padding: 0 }}><X size={12} /></button>
              </span>
            );
          })}
        </div>
      )}
      {rules.length > 0 && (
        <div style={hint} aria-live="polite">
          {view.rows.length.toLocaleString('en-US')} of {view.all.length.toLocaleString('en-US')} rows pass.
          {' '}{rules.filter((r) => byKey.has(r.col)).map((r) => ruleText(r, byKey.get(r.col))).filter(Boolean).slice(0, 3).join(view.state.match === 'any' ? ' or ' : ', ')}
        </div>
      )}
    </AnchoredMenu>
  );
}

// ── A heading's value list (Excel) ─────────────────────────────────────────
const SHOW_MAX = 500;
const BLANK = '(Blanks)';
function ValueList({ view, col, ...menu }) {
  const [q, setQ] = useState('');
  const values = useMemo(() => view.distinct(col.key), [view.state, view.all, col.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = view.state.picks[col.key] || null;
  const isOn = (t) => (!pick ? true : pick.in ? pick.in.includes(t) : !pick.out.includes(t));
  const s = q.trim().toLowerCase();
  const matched = s ? values.filter((v) => (v.text || BLANK).toLowerCase().includes(s)) : values;
  const shown = matched.slice(0, SHOW_MAX);
  const all = values.map((v) => v.text);
  const allOn = matched.every((v) => isOn(v.text));
  const someOn = matched.some((v) => isOn(v.text));
  const set = (next) => view.setPick(col.key, next);
  const toggle = (t) => {
    if (!pick) { set({ out: [t] }); return; }
    if (pick.out) {
      const out = pick.out.includes(t) ? pick.out.filter((x) => x !== t) : [...pick.out, t];
      set(out.length ? { out } : null);
      return;
    }
    const inn = pick.in.includes(t) ? pick.in.filter((x) => x !== t) : [...pick.in, t];
    set(all.every((x) => inn.includes(x)) ? null : { in: inn });
  };
  const toggleAll = () => {
    if (!s) { set(allOn ? { in: [] } : null); return; }
    // With a search: the values found, on or off (Excel's "Select All Search Results").
    const found = matched.map((v) => v.text);
    if (allOn) {
      if (!pick) set({ out: found });
      else if (pick.out) set({ out: [...new Set([...pick.out, ...found])] });
      else set({ in: pick.in.filter((x) => !found.includes(x)) });
    } else if (!pick || pick.out) {
      set(pick?.out ? { in: [...new Set([...all.filter((x) => !pick.out.includes(x)), ...found])] } : { in: found });
    } else {
      set({ in: [...new Set([...pick.in, ...found])] });
    }
  };
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.indeterminate = someOn && !allOn; }, [someOn, allOn]);
  return (
    <AnchoredMenu {...menu} role="dialog" aria-label={`${col.label} values`} style={{ ...panel(320), display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Funnel size={13} style={muted} />
        <span style={{ ...head, flex: 1 }}>{col.label}</span>
        <span style={hint}>{values.length.toLocaleString('en-US')} {values.length === 1 ? 'value' : 'values'}</span>
      </div>
      <div style={{ position: 'relative' }}>
        <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values" aria-label={`Search ${col.label} values`} autoFocus
          style={{ ...field, width: '100%', paddingLeft: 26 }} />
      </div>
      <div style={{ maxHeight: 'min(360px, calc(100vh - 260px))', overflowY: 'auto', display: 'grid', gap: 1 }}>
        {matched.length > 0 && (
          <label style={{ ...item(), fontWeight: 600 }}>
            <input ref={box} type="checkbox" checked={allOn} onChange={toggleAll} />
            <span style={{ flex: 1 }}>{s ? '(Select All Search Results)' : '(Select All)'}</span>
          </label>
        )}
        {shown.map((v) => (
          <label key={v.text || BLANK} style={item()}>
            <input type="checkbox" checked={isOn(v.text)} onChange={() => toggle(v.text)} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: v.text ? 'normal' : 'italic' }} title={v.text || BLANK}>{v.text || BLANK}</span>
            <span style={{ ...hint, fontVariantNumeric: 'tabular-nums' }}>{v.n.toLocaleString('en-US')}</span>
          </label>
        ))}
        {!matched.length && <div style={{ ...hint, padding: 6 }}>{values.length ? 'No value matches.' : 'No values in the rows shown.'}</div>}
        {matched.length > SHOW_MAX && <div style={{ ...hint, padding: 6 }}>The first {SHOW_MAX} of {matched.length.toLocaleString('en-US')} are listed. Search to find the others.</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ ...hint, flex: 1 }}>The list follows the other filters.</span>
        {pick && <button type="button" style={link} onClick={() => set(null)}>Clear Filter</button>}
        {done(menu.onClose)}
      </div>
    </AnchoredMenu>
  );
}

// ── A heading's menu (07:34) ───────────────────────────────────────────────
function ColumnMenu({ view, col, onKind, anchor, ...menu }) {
  const [widthOpen, setWidthOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const measured = () => Math.round(anchor?.current?.getBoundingClientRect?.().width || 0);
  const current = view.state.widths[col.key] || measured() || col.width || 0;
  const [w, setW] = useState(String(current || ''));
  const dir = view.sortOf(col.key);
  const hidden = view.arranged.filter((c) => c.hidden);
  const close = menu.onClose;
  const act = (fn) => () => { fn(); close(); };
  const canSort = !col.noSort;
  const setWidth = (e) => {
    e?.preventDefault();
    const n = Math.round(Number(w));
    if (n > 0) { view.setWidth(col.key, n); close(); }
  };
  return (
    <AnchoredMenu {...menu} role="menu" aria-label={`${col.label} column`} style={{ ...panel(260), padding: 6 }}>
      <div style={{ ...hint, fontWeight: 700, padding: '4px 8px 6px' }}>{col.label}</div>
      {canSort && (
        <>
          <button type="button" role="menuitemradio" aria-checked={dir === 'asc'} style={item(dir === 'asc')} onClick={act(() => view.sortBy(col.key, 'asc'))}><ArrowUp size={14} style={muted} /> Sort Ascending</button>
          <button type="button" role="menuitemradio" aria-checked={dir === 'desc'} style={item(dir === 'desc')} onClick={act(() => view.sortBy(col.key, 'desc'))}><ArrowDown size={14} style={muted} /> Sort Descending</button>
          {dir && <button type="button" role="menuitem" style={item()} onClick={act(() => view.sortBy(col.key, null))}><X size={14} style={muted} /> Clear Sort</button>}
        </>
      )}
      {!col.noFilter && (
        <button type="button" role="menuitem" style={item()} onClick={() => {
          if (!view.state.rules.some((r) => r.col === col.key)) view.addRule(col.key);
          onKind('filter');
        }}>
          <Funnel size={14} style={muted} /> <span style={{ flex: 1 }}>Filter This Column</span><ChevronRight size={13} style={muted} />
        </button>
      )}
      <button type="button" role="menuitem" aria-expanded={widthOpen} style={item(widthOpen)} onClick={() => setWidthOpen((v) => !v)}>
        <MoveHorizontal size={14} style={muted} /> <span style={{ flex: 1 }}>Manual Width{current ? ` · ${current}px` : ''}</span>{widthOpen ? <ChevronDown size={13} style={muted} /> : <ChevronRight size={13} style={muted} />}
      </button>
      {widthOpen && (
        <form onSubmit={setWidth} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px 6px 30px' }}>
          <input type="number" min={40} max={1200} step={10} value={w} onChange={(e) => setW(e.target.value)} aria-label={`${col.label} width in pixels`} autoFocus
            className="num" style={{ ...field, width: 80 }} />
          <span style={hint}>px</span>
          <button type="submit" className="primary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }}>Set</button>
          {view.state.widths[col.key] && <button type="button" style={link} onClick={act(() => view.setWidth(col.key, null))}>Auto</button>}
        </form>
      )}
      {!col.fixed && (
        <>
          <button type="button" role="menuitem" disabled={!view.canMove(col.key, -1)} style={item(false, !view.canMove(col.key, -1))} onClick={act(() => view.move(col.key, -1))}><ArrowLeft size={14} style={muted} /> Move Left</button>
          <button type="button" role="menuitem" disabled={!view.canMove(col.key, 1)} style={item(false, !view.canMove(col.key, 1))} onClick={act(() => view.move(col.key, 1))}><ArrowRight size={14} style={muted} /> Move Right</button>
          <button type="button" role="menuitem" style={item()} onClick={act(() => view.show(col.key, false))}><EyeOff size={14} style={muted} /> Hide Column</button>
        </>
      )}
      <button type="button" role="menuitem" aria-expanded={hiddenOpen} disabled={!hidden.length} style={item(hiddenOpen, !hidden.length)} onClick={() => setHiddenOpen((v) => !v)}
        title={hidden.length ? undefined : 'Every column is shown'}>
        <Eye size={14} style={muted} /> <span style={{ flex: 1 }}>Show Hidden Column{hidden.length ? ` (${hidden.length})` : ''}</span>{hidden.length > 0 && (hiddenOpen ? <ChevronDown size={13} style={muted} /> : <ChevronRight size={13} style={muted} />)}
      </button>
      {hiddenOpen && hidden.map((c) => (
        <button key={c.key} type="button" role="menuitem" style={{ ...item(), paddingLeft: 30 }} onClick={act(() => view.show(c.key, true))}>{c.label}</button>
      ))}
    </AnchoredMenu>
  );
}

// ── Columns: show / hide / order ───────────────────────────────────────────
function ColumnsChooser({ view, ...menu }) {
  const cols = view.arranged;
  const custom = view.state.order.length > 0 || Object.keys(view.state.vis).length > 0 || Object.keys(view.state.widths).length > 0;
  return (
    <AnchoredMenu {...menu} role="dialog" aria-label="Columns" align="end" style={{ ...panel(300), display: 'grid', gap: 8 }}>
      <div style={head}>Columns</div>
      <div style={{ maxHeight: 'min(420px, calc(100vh - 240px))', overflowY: 'auto', display: 'grid', gap: 1 }}>
        {cols.map((c) => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label style={{ ...item(), flex: 1, cursor: c.fixed ? 'default' : 'pointer' }} title={c.fixed ? 'This column always shows' : undefined}>
              <input type="checkbox" checked={!c.hidden} disabled={!!c.fixed} onChange={(e) => view.show(c.key, e.target.checked)} />
              <span style={{ flex: 1 }}>{c.label}</span>
            </label>
            {!c.fixed && !c.hidden && (
              <>
                <button type="button" style={iconBtn} disabled={!view.canMove(c.key, -1)} onClick={() => view.move(c.key, -1)} aria-label={`Move ${c.label} left`} title="Move left"><ArrowLeft size={13} /></button>
                <button type="button" style={iconBtn} disabled={!view.canMove(c.key, 1)} onClick={() => view.move(c.key, 1)} aria-label={`Move ${c.label} right`} title="Move right"><ArrowRight size={13} /></button>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button type="button" style={{ ...link, opacity: custom ? 1 : 0.5, cursor: custom ? 'pointer' : 'default' }} disabled={!custom} onClick={view.resetColumns}>Reset Columns</button>
        {done(menu.onClose)}
      </div>
      <div style={hint}>Order, widths and hidden columns are part of the view: Update saves them.</div>
    </AnchoredMenu>
  );
}

// ── Views ──────────────────────────────────────────────────────────────────
function ViewsMenu({ view, saving = false, ...menu }) {
  const [naming, setNaming] = useState(saving);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState('');
  const [newName, setNewName] = useState('');
  const [confirm, setConfirm] = useState('');
  const close = menu.onClose;
  const save = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    view.saveAs(name);
    close();
  };
  const rename = (e) => {
    e.preventDefault();
    if (newName.trim()) view.rename(renaming, newName);
    setRenaming('');
  };
  const row = (id, label, mine) => (
    <div key={id || 'default'} style={{ display: 'flex', alignItems: 'center', gap: 2, borderRadius: 6, background: view.activeId === id ? 'var(--wk-brand-tint, #e8ecfd)' : 'none' }}>
      {renaming === id && mine ? (
        <form onSubmit={rename} style={{ display: 'flex', gap: 6, flex: 1, padding: '3px 4px' }}>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} aria-label="New name" autoFocus style={{ ...field, flex: 1 }} />
          <button type="submit" className="primary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }}>Rename</button>
        </form>
      ) : (
        <button type="button" role="menuitemradio" aria-checked={view.activeId === id} onClick={() => { view.select(id); close(); }}
          style={{ ...item(), background: 'none', flex: 1, minWidth: 0 }}>
          <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }}>{view.activeId === id ? <Check size={14} /> : null}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: view.activeId === id ? 600 : 400 }}>{label}</span>
        </button>
      )}
      {mine && renaming !== id && (confirm === id ? (
        <span style={{ display: 'inline-flex', gap: 8, paddingRight: 8 }}>
          <button type="button" style={{ ...link, color: 'var(--bad-fg, #dc2626)' }} onClick={() => { view.remove(id); setConfirm(''); }}>Delete</button>
          <button type="button" style={link} onClick={() => setConfirm('')}>Keep</button>
        </span>
      ) : (
        <>
          <button type="button" style={iconBtn} onClick={() => { setRenaming(id); setNewName(label); }} aria-label={`Rename ${label}`} title="Rename"><Pencil size={13} /></button>
          <button type="button" style={iconBtn} onClick={() => setConfirm(id)} aria-label={`Delete ${label}`} title="Delete"><Trash2 size={13} /></button>
        </>
      ))}
    </div>
  );
  return (
    <AnchoredMenu {...menu} role="menu" aria-label="Views" style={{ ...panel(320), display: 'grid', gap: 6 }}>
      <div style={{ ...hint, fontWeight: 700, padding: '2px 4px' }}>Views - yours only</div>
      <div style={{ display: 'grid', gap: 1, maxHeight: 'min(320px, calc(100vh - 280px))', overflowY: 'auto' }}>
        {row('', 'Built-in Default', false)}
        {view.views.map((v) => row(v.id, v.name, true))}
      </div>
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6 }}>
        {naming ? (
          <form onSubmit={save} style={{ display: 'grid', gap: 6 }}>
            <label htmlFor={`acct-view-name-${view.key}`} style={{ fontSize: '0.78rem', fontWeight: 600 }}>Save As a New View</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id={`acct-view-name-${view.key}`} type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Open Items Over 5,000" style={{ ...field, flex: 1 }} />
              <button type="submit" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} disabled={!name.trim()}>Save</button>
            </div>
            <div style={hint}>Keeps the filters, sort, column order, widths and hidden columns - not the figures. A name you already use is replaced.</div>
          </form>
        ) : (
          <button type="button" role="menuitem" style={{ ...item(), fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }} onClick={() => setNaming(true)}>
            <Plus size={14} /> Save As a New View...
          </button>
        )}
      </div>
    </AnchoredMenu>
  );
}
