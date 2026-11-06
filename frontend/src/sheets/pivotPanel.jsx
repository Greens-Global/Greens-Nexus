// Sheets: the Pivot Editor (a side sheet, like Format Cells) and the panel
// that creates a pivot. Every change saves at once, Google Sheets style.
import { useState } from 'react';
import { ArrowUp, ArrowDown, X, Trash2, Search } from 'lucide-react';
import { SidePanel } from './panels.jsx';
import { PIVOT_FNS, PIVOT_SHOW, PIVOT_GROUPS } from './model.js';

const SHOW_WORDS = { '': 'Default', row: '% of Row', col: '% of Column', total: '% of Grand Total' };
const GROUP_WORDS = { '': 'No Grouping', year: 'Year', quarter: 'Quarter', month: 'Month', day: 'Day' };
const SECTION = { rows: 'Rows', cols: 'Columns', values: 'Values', filters: 'Filters' };
const MAX = { rows: 5, cols: 5, values: 10, filters: 10 };

export function PivotCreatePanel({ srcA1, onCreate, onClose }) {
  const [src, setSrc] = useState(srcA1);
  const [where, setWhere] = useState('new');
  const [at, setAt] = useState('');
  return (
    <SidePanel title="Create Pivot Table" onClose={onClose}
      foot={<button type="button" className="primary-btn" onClick={() => onCreate({ src, where, at })} disabled={where === 'here' && !at.trim()}>Create</button>}>
      <label className="nxs-field"><span>Data Range (with a header row)</span>
        <input className="form-input" value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} placeholder="A1:D100" /></label>
      <fieldset className="nxs-radio">
        <legend>Insert To</legend>
        <label><input type="radio" name="pv-where" checked={where === 'new'} onChange={() => setWhere('new')} /> New Tab</label>
        <label><input type="radio" name="pv-where" checked={where === 'here'} onChange={() => setWhere('here')} /> Existing Tab</label>
      </fieldset>
      {where === 'here' && (
        <label className="nxs-field"><span>Starting Cell</span>
          <input className="form-input" value={at} onChange={(e) => setAt(e.target.value)} spellCheck={false} placeholder="'Sheet 1'!H1" autoFocus /></label>
      )}
    </SidePanel>
  );
}

/** The Pivot Editor. cfg is the stored pivot; fields = [{col, name}] from its source. */
export function PivotPanel({ cfg, fields, srcA1, canEdit, valuesOf, onChange, onSource, onDelete, onClose }) {
  const [src, setSrc] = useState(srcA1);
  const [openFilter, setOpenFilter] = useState('');
  const [q, setQ] = useState('');
  const nameOf = (col) => fields.find((f) => f.col === col)?.name || 'Missing Column';
  const set = (part, list) => onChange({ ...cfg, [part]: list });
  const list = (part) => cfg[part] || [];
  const addField = (part, col) => {
    if (!col) return;
    const base = { col };
    const item = part === 'values' ? { ...base, fn: 'SUM', show: '' } : part === 'filters' ? { ...base, hide: [] } : { ...base, sort: 'asc', group: '' };
    set(part, [...list(part), item]);
  };
  const patch = (part, i, p) => set(part, list(part).map((x, j) => {
    if (j !== i) return x;
    const next = { ...x, ...p };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next;
  }));
  const move = (part, i, d) => { const l = list(part).slice(); const j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; set(part, l); };
  const remove = (part, i) => set(part, list(part).filter((_, j) => j !== i));

  const section = (part) => (
    <section key={part} className="nxs-pv-sec">
      <div className="nxs-pv-head">
        <h3 className="nxs-sub">{SECTION[part]}</h3>
        <select className="form-input nxs-pv-add" aria-label={`Add to ${SECTION[part]}`} value="" disabled={!canEdit || list(part).length >= MAX[part]}
          onChange={(e) => addField(part, e.target.value)}>
          <option value="">Add</option>
          {fields.map((f) => <option key={f.col} value={f.col}>{f.name}</option>)}
        </select>
      </div>
      {list(part).map((x, i) => (
        <div key={`${x.col}-${i}`} className="nxs-pv-item">
          <div className="nxs-pv-row">
            <b>{part === 'values' ? `${x.fn} of ${nameOf(x.col)}` : nameOf(x.col)}</b>
            <span className="nxs-pv-tools">
              <button type="button" className="nxs-icon" aria-label="Move Up" title="Move Up" disabled={!canEdit || i === 0} onClick={() => move(part, i, -1)}><ArrowUp size={13} /></button>
              <button type="button" className="nxs-icon" aria-label="Move Down" title="Move Down" disabled={!canEdit || i === list(part).length - 1} onClick={() => move(part, i, 1)}><ArrowDown size={13} /></button>
              <button type="button" className="nxs-icon" aria-label={`Remove ${nameOf(x.col)}`} title="Remove" disabled={!canEdit} onClick={() => remove(part, i)}><X size={13} /></button>
            </span>
          </div>
          {(part === 'rows' || part === 'cols') && (
            <div className="nxs-btnrow nxs-wrap">
              <select className="form-input" aria-label="Order" value={x.by != null ? `v${x.by}` : x.sort || 'asc'} disabled={!canEdit}
                onChange={(e) => { const v = e.target.value; patch(part, i, v.startsWith('v') ? { by: +v.slice(1) } : { sort: v, by: undefined }); }}>
                <option value="asc">A to Z</option>
                <option value="desc">Z to A</option>
                {(cfg.values || []).map((vf, vi) => <option key={vi} value={`v${vi}`}>By {vf.fn} of {nameOf(vf.col)}</option>)}
              </select>
              {x.by != null && (
                <select className="form-input" aria-label="Direction" value={x.sort || 'asc'} disabled={!canEdit} onChange={(e) => patch(part, i, { sort: e.target.value })}>
                  <option value="asc">Smallest First</option><option value="desc">Largest First</option>
                </select>
              )}
              <select className="form-input" aria-label="Group Dates" value={x.group || ''} disabled={!canEdit} onChange={(e) => patch(part, i, { group: e.target.value })}>
                {PIVOT_GROUPS.map((g) => <option key={g} value={g}>{GROUP_WORDS[g]}</option>)}
              </select>
            </div>
          )}
          {part === 'values' && (
            <div className="nxs-btnrow nxs-wrap">
              <select className="form-input" aria-label="Summarize By" value={x.fn} disabled={!canEdit} onChange={(e) => patch(part, i, { fn: e.target.value })}>
                {PIVOT_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select className="form-input" aria-label="Show As" value={x.show || ''} disabled={!canEdit} onChange={(e) => patch(part, i, { show: e.target.value })}>
                {PIVOT_SHOW.map((s) => <option key={s} value={s}>{SHOW_WORDS[s]}</option>)}
              </select>
            </div>
          )}
          {part === 'filters' && (
            <>
              <button type="button" className="secondary-btn nxs-small" onClick={() => { setOpenFilter(openFilter === `${i}` ? '' : `${i}`); setQ(''); }}>
                {(x.hide || []).length ? `Showing all but ${(x.hide || []).length}` : 'Showing All Items'}
              </button>
              {openFilter === `${i}` && (() => {
                const values = valuesOf(x.col);
                const hide = new Set(x.hide || []);
                const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
                const setHide = (h) => patch(part, i, { hide: [...h].slice(0, 5000) });
                return (
                  <div className="nxs-pv-filter">
                    <div className="nxs-btnrow">
                      <button type="button" className="nxs-link" disabled={!canEdit} onClick={() => setHide(new Set())}>Select All</button>
                      <button type="button" className="nxs-link" disabled={!canEdit} onClick={() => setHide(new Set(values.map((v) => v.text)))}>Clear</button>
                    </div>
                    <div className="nxs-search"><Search size={13} /><input aria-label="Search values" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" /></div>
                    <div className="nxs-values">
                      {shown.slice(0, 500).map((v) => (
                        <label key={v.text} className="nxs-check"><input type="checkbox" disabled={!canEdit} checked={!hide.has(v.text)}
                          onChange={(e) => { const h = new Set(hide); if (e.target.checked) h.delete(v.text); else h.add(v.text); setHide(h); }} />
                          <span>{v.text}</span><span className="nxs-count">{v.count}</span></label>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      ))}
      {!list(part).length && <p className="nxs-empty">{part === 'values' ? 'Add a field to summarize.' : 'None yet.'}</p>}
    </section>
  );

  return (
    <SidePanel title="Pivot Table Editor" onClose={onClose}
      foot={canEdit && <button type="button" className="secondary-btn" onClick={onDelete}><Trash2 size={14} /> Delete Pivot Table</button>}>
      <label className="nxs-field"><span>Data Range</span>
        <input className="form-input" value={src} spellCheck={false} disabled={!canEdit} onChange={(e) => setSrc(e.target.value)}
          onBlur={() => { if (src.trim() !== srcA1) onSource(src.trim()); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
      <label className="nxs-check"><input type="checkbox" checked={cfg.totals !== false} disabled={!canEdit} onChange={(e) => onChange({ ...cfg, totals: e.target.checked })} /> Show Totals</label>
      {!fields.length && <p className="nxs-hint-text">The data range is gone or has no rows under its header. Pick a new one.</p>}
      {['rows', 'cols', 'values', 'filters'].map(section)}
    </SidePanel>
  );
}
