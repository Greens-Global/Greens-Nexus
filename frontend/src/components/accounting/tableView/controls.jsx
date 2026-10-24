import { Suspense, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Columns3, Funnel, Save, X } from 'lucide-react';
import { Panels, preloadPanels } from './load';
import { BarMore, ColumnResizer } from '../reportControls';

// The standard table view's bar and headings (10/23 meeting, item 01). These
// are the parts that draw with the table; the panels and menus they open
// (rules, value lists, the column menu, the views) are ./panels, loaded the
// first time one opens so the Accounting screens do not carry them.
//
//   <ControlBar> ... <TableViewBar view={view} /> ... </ControlBar>
//   <thead><tr>{view.columns.map((c) => <ViewHead key={c.key} view={view} col={c} style={headStyle(c.width)} />)}</tr></thead>

const btn = (active) => ({
  height: 30, padding: '0 9px', borderRadius: 8, fontSize: '0.78rem', fontFamily: 'inherit', background: 'var(--bg-card)', boxSizing: 'border-box',
  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 260, whiteSpace: 'nowrap',
  border: `1px solid ${active ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`,
  color: active ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: active ? 600 : 400,
});
const count = { fontSize: '0.68rem', fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--wk-brand, #2b45e1)', color: '#fff' };

/**
 * View, Unsaved + Update + Clear (only after a change), Filters (with how many
 * are on) and Columns - the same controls in the same order on every
 * Accounting table. `columns={false}` leaves out the column chooser.
 * `filtersLabel`: "Row Filters" where the screen already has a report Filters
 * button (journals, departments...), so the two never share a name.
 */
export function TableViewBar({ view, columns = true, filtersLabel = 'Filters' }) {
  const [open, setOpen] = useState('');
  const viewRef = useRef(null);
  const filtersRef = useRef(null);
  const columnsRef = useRef(null);
  const toggle = (k) => { preloadPanels(); view.onOpen?.(k); setOpen((o) => (o === k ? '' : k)); };
  const anchor = open === 'filters' ? filtersRef : open === 'columns' ? columnsRef : viewRef;
  const n = view.count;
  return (
    <>
      <div ref={viewRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onPointerEnter={preloadPanels}>
        <span className="acct-bar-label" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>View</span>
        <button type="button" style={btn(!!view.activeId)} onClick={() => toggle('views')} aria-haspopup="menu" aria-expanded={open === 'views'}
          aria-label={`View: ${view.activeName}`} title={`View: ${view.activeName}. Your own saved filters, sort and columns for this table.`}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{view.activeName}</span>
          <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        </button>
      </div>
      {view.dirty && (
        <>
          <span className="acct-vh-unsaved" title="The filters, sort or columns differ from the view picked.">Unsaved</span>
          <button type="button" style={btn(true)} onClick={() => { if (!view.update()) toggle('save'); }}
            title={view.activeId ? `Save these filters, sort and columns into "${view.activeName}"` : 'Save these filters, sort and columns as a view of your own'}>
            <Save size={14} style={{ flexShrink: 0 }} /> <span className="acct-bar-label">Update</span>
          </button>
          <button type="button" style={btn(false)} onClick={view.clear} aria-label="Clear" title={`Back to the saved filters, sort and columns of "${view.activeName}"`}>
            <X size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} /> <span className="acct-bar-label">Clear</span>
          </button>
        </>
      )}
      <button ref={filtersRef} type="button" style={btn(n > 0)} onClick={() => toggle('filters')} onPointerEnter={preloadPanels} onFocus={preloadPanels}
        aria-haspopup="dialog" aria-expanded={open === 'filters'} aria-label={n ? `${filtersLabel} (${n} on)` : filtersLabel} title="Filter the rows: field, condition and value">
        <Funnel size={14} style={{ flexShrink: 0, color: n ? 'inherit' : 'var(--text-muted)' }} />
        <span className="acct-bar-label-2">{filtersLabel}</span>
        {n > 0 && <span style={count}>{n}</span>}
      </button>
      {/* On a row that runs out of room (item 02) Columns moves into the bar's
          More menu first - each heading's menu also hides and shows columns. */}
      {columns && (
        <BarMore level={1}>
          <button ref={columnsRef} type="button" style={btn(false)} onClick={() => toggle('columns')} onPointerEnter={preloadPanels}
            aria-haspopup="dialog" aria-expanded={open === 'columns'} aria-label="Show or Hide Columns" title="Show, hide and order the columns">
            <Columns3 size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} /> <span className="acct-bar-label">Columns</span>
          </button>
        </BarMore>
      )}
      {open && (
        <Suspense fallback={null}>
          <Panels kind={open} view={view} anchor={anchor} onClose={() => setOpen('')} onKind={setOpen} label={filtersLabel} />
        </Suspense>
      )}
    </>
  );
}

/**
 * A heading with the standard menu (10/23, 07:34): a click on the name opens
 * Sort Ascending / Descending, Filter This Column, Manual Width, Move Left /
 * Right, Hide and Show Hidden Column; the funnel opens the column's value list
 * (Excel style, with a search). The drag handle on its right edge resizes it.
 * Other props (className, style, title...) go on the <th> - give it
 * `position: relative` or sticky (headStyle does) for the drag handle.
 * `as="td"` draws a <td> (a header row of <td>s).
 */
export function ViewHead({ view, col, children = null, as: Tag = 'th', resize = true, ...rest }) {
  const ref = useRef(null);
  const [open, setOpen] = useState('');
  const dir = view.sortOf(col.key);
  const on = view.filtered(col.key);
  const toggle = (k) => { preloadPanels(); view.onOpen?.(k); setOpen((o) => (o === k ? '' : k)); };
  return (
    <Tag ref={ref} scope={Tag === 'th' ? 'col' : undefined} aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : undefined} {...rest}>
      <span className="acct-vh" onPointerEnter={preloadPanels}>
        <button type="button" className="acct-vh-label" onClick={() => toggle('menu')} aria-haspopup="menu" aria-expanded={open === 'menu'}
          aria-label={`${col.label}${dir ? (dir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''} - column menu`} title={`${col.label}: sort, filter, width and position`}>
          <span className="acct-vh-text">{children ?? col.label}</span>
        </button>
        {/* The arrow of a sorted column turns it the other way in one click
            (Urmi, 10/22: "again for the other way"). */}
        {dir && (
          <button type="button" className="acct-vh-sort" onClick={() => view.sortBy(col.key, dir === 'asc' ? 'desc' : 'asc')}
            aria-label={`Sort ${col.label} ${dir === 'asc' ? 'descending' : 'ascending'}`} title={dir === 'asc' ? 'Sorted ascending - click for descending' : 'Sorted descending - click for ascending'}>
            {dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
          </button>
        )}
        {!col.noFilter && (
          <button type="button" className={`acct-vh-funnel${on ? ' on' : ''}`} onClick={() => toggle('values')} aria-haspopup="dialog" aria-expanded={open === 'values'}
            aria-label={`Filter ${col.label} by value${on ? ' (on)' : ''}`} title={on ? `${col.label} is filtered` : `Pick ${col.label} values to show`}>
            <Funnel size={11} />
          </button>
        )}
      </span>
      {resize && <ColumnResizer {...view.resizer(col.key, col.label)} />}
      {open && (
        <Suspense fallback={null}>
          <Panels kind={open} view={view} col={col} anchor={ref} onClose={() => setOpen('')} onKind={setOpen} />
        </Suspense>
      )}
    </Tag>
  );
}
