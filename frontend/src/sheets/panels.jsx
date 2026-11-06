// Sheets: the side sheets (Format Cells, Conditional Formatting, Data
// Validation, Named Ranges, Sort Range, Remove Duplicates, Split Text,
// Keyboard Shortcuts) and the small popovers (filter, dropdown list, note,
// variable picker). Side sheets ride the house `.modal-overlay >
// .modal-content.nx-popup` rule, so they slide in from the right on a
// computer and are a bottom sheet on a phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Trash2, Search, Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { ColorGrid, THEME_COLORS, STANDARD_COLORS, useDismiss } from '../components/docRibbon/ui';
import { SHORTCUTS, keyLabel, isMac } from './shortcuts.js';
import { NUMBER_FORMATS } from './format.js';
import { FONTS, BORDER_STYLES, CF_TYPES, DV_OPS, FILTER_OPS } from './model.js';

const COLOR_ROWS = [THEME_COLORS.map((h) => [h]), STANDARD_COLORS.map((h) => [h])];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function SidePanel({ title, onClose, children, foot, label }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-overlay nxs-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content nx-popup nxs-panel" role="dialog" aria-modal="true" aria-label={label || title}>
        <div className="nxs-panel-head">
          <h2>{title}</h2>
          <button type="button" className="nxs-icon" aria-label="Close" title="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="nxs-panel-body nx-fill">{children}</div>
        {foot && <div className="nxs-panel-foot">{foot}</div>}
      </div>
    </div>
  );
}

const Row = ({ label, children }) => (
  <label className="nxs-field"><span>{label}</span>{children}</label>
);

// ── Keyboard Shortcuts ──────────────────────────────────────────────────
export function ShortcutsPanel({ onClose }) {
  const [q, setQ] = useState('');
  const groups = SHORTCUTS.map(([g, list]) => [g, list.filter(([k, l]) => !q || `${keyLabel(k)} ${l}`.toLowerCase().includes(q.toLowerCase()))]).filter(([, l]) => l.length);
  return (
    <SidePanel title="Keyboard Shortcuts" onClose={onClose}>
      <div className="nxs-search"><Search size={14} /><input autoFocus placeholder="Search shortcuts" aria-label="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {groups.map(([g, list]) => (
        <section key={g} className="nxs-keys">
          <h3>{g}</h3>
          {list.map(([k, l]) => (
            <div key={k + l} className="nxs-key-row"><span>{l}</span><kbd>{keyLabel(k)}</kbd></div>
          ))}
        </section>
      ))}
      {!groups.length && <p className="nxs-empty">No shortcut matches that.</p>}
      <p className="nxs-hint-text">{isMac ? 'Cmd and Option on this Mac.' : 'On a Mac, use Cmd for Ctrl and Option for Alt.'}</p>
    </SidePanel>
  );
}

// ── Format Cells (Ctrl+1) ───────────────────────────────────────────────
export function FormatPanel({ s = {}, onStyle, onBorder, onClose }) {
  const [bStyle, setBStyle] = useState('thin');
  const [bColor, setBColor] = useState('#000000');
  const bk = (kind) => onBorder(kind, bStyle, bColor);
  return (
    <SidePanel title="Format Cells" onClose={onClose}>
      <h3 className="nxs-sub">Number</h3>
      <Row label="Format">
        <select className="form-input" value={s.nf || ''} onChange={(e) => onStyle({ nf: e.target.value || null, d: null })}>
          {NUMBER_FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Row>
      {['number', 'currency', 'percent'].includes(s.nf) && (
        <Row label="Decimal Places">
          <input className="form-input" type="number" min={0} max={10} value={Number.isInteger(s.d) ? s.d : 2}
            onChange={(e) => onStyle({ d: clamp(parseInt(e.target.value, 10) || 0, 0, 10) })} />
        </Row>
      )}
      <h3 className="nxs-sub">Font</h3>
      <Row label="Font">
        <select className="form-input" value={s.ff || 'Inter'} onChange={(e) => onStyle({ ff: e.target.value === 'Inter' ? null : e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </Row>
      <Row label="Size">
        <select className="form-input" value={s.fs || 13} onChange={(e) => onStyle({ fs: +e.target.value === 13 ? null : +e.target.value })}>
          {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Row>
      <div className="nxs-btnrow">
        {[['b', Bold, 'Bold'], ['i', Italic, 'Italic'], ['u', Underline, 'Underline'], ['st', Strikethrough, 'Strikethrough']].map(([k, Icon, l]) => (
          <button key={k} type="button" className={`nxs-toggle${s[k] ? ' is-on' : ''}`} aria-pressed={!!s[k]} title={l} aria-label={l} onClick={() => onStyle({ [k]: !s[k] })}><Icon size={15} /></button>
        ))}
      </div>
      <Row label="Text Color"><ColorGrid rows={COLOR_ROWS} current={s.fc} onPick={(h) => onStyle({ fc: h.toLowerCase() })} onNone={() => onStyle({ fc: null })} noneLabel="Automatic" /></Row>
      <Row label="Fill Color"><ColorGrid rows={COLOR_ROWS} current={s.bg} onPick={(h) => onStyle({ bg: h.toLowerCase() })} onNone={() => onStyle({ bg: null })} /></Row>
      <h3 className="nxs-sub">Alignment</h3>
      <Row label="Horizontal">
        <select className="form-input" value={s.ha || ''} onChange={(e) => onStyle({ ha: e.target.value || null })}>
          <option value="">Automatic</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select>
      </Row>
      <Row label="Vertical">
        <select className="form-input" value={s.va || ''} onChange={(e) => onStyle({ va: e.target.value || null })}>
          <option value="">Bottom</option><option value="top">Top</option><option value="middle">Middle</option>
        </select>
      </Row>
      <label className="nxs-check"><input type="checkbox" checked={!!s.wrap} onChange={(e) => onStyle({ wrap: e.target.checked })} /> Wrap Text</label>
      <h3 className="nxs-sub">Borders</h3>
      <div className="nxs-btnrow">
        <select className="form-input" aria-label="Border Style" value={bStyle} onChange={(e) => setBStyle(e.target.value)}>
          {BORDER_STYLES.map((b) => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1)}</option>)}
        </select>
        <input type="color" aria-label="Border Color" value={bColor} onChange={(e) => setBColor(e.target.value)} className="nxs-color" />
      </div>
      <div className="nxs-btnrow nxs-wrap">
        {[['all', 'All Borders'], ['outer', 'Outer'], ['inner', 'Inner'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'No Borders']].map(([k, l]) => (
          <button key={k} type="button" className="secondary-btn nxs-small" onClick={() => bk(k)}>{l}</button>
        ))}
      </div>
    </SidePanel>
  );
}

// ── Conditional Formatting ──────────────────────────────────────────────
const CF_WORDS = {
  gt: 'Greater Than', gte: 'Greater Than or Equal To', lt: 'Less Than', lte: 'Less Than or Equal To', eq: 'Equal To', neq: 'Not Equal To',
  between: 'Between', contains: 'Text Contains', notContains: 'Text Does Not Contain', before: 'Date Is Before', after: 'Date Is After',
  empty: 'Is Empty', notEmpty: 'Is Not Empty', formula: 'Custom Formula Is', scale: 'Color Scale',
};
const PRESETS = [
  { label: 'Green', style: { bg: '#dcfce7', fc: '#166534' } }, { label: 'Red', style: { bg: '#fee2e2', fc: '#991b1b' } },
  { label: 'Yellow', style: { bg: '#fef9c3', fc: '#854d0e' } }, { label: 'Blue', style: { bg: '#dbeafe', fc: '#1e40af' } },
  { label: 'Bold', style: { b: true } },
];
const SCALES = [
  { label: 'White to Green', colors: ['#ffffff', '#57bb8a'] }, { label: 'Red, Yellow, Green', colors: ['#e67c73', '#ffd666', '#57bb8a'] },
  { label: 'Green, Yellow, Red', colors: ['#57bb8a', '#ffd666', '#e67c73'] }, { label: 'White to Blue', colors: ['#ffffff', '#4a86e8'] },
];
export function ConditionalPanel({ rules, selA1, onSave, onDelete, onClose, toastErr }) {
  const blank = { id: null, range: selA1, type: 'gt', a: '', b: '', f: '', preset: 0, scale: 1 };
  const [form, setForm] = useState(blank);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const needsA = !['empty', 'notEmpty', 'scale', 'formula'].includes(form.type);
  const save = () => {
    if (!form.range.trim()) { toastErr?.('Type the range the rule applies to, like A1:C20.'); return; }
    if (form.type === 'formula' && !form.f.trim().startsWith('=')) { toastErr?.('A custom formula starts with =.'); return; }
    const ok = onSave(form.id, {
      range: form.range.trim(), type: form.type,
      a: needsA ? form.a : undefined, b: form.type === 'between' ? form.b : undefined,
      f: form.type === 'formula' ? form.f.trim() : undefined,
      style: form.type === 'scale' ? undefined : PRESETS[form.preset].style,
      colors: form.type === 'scale' ? SCALES[form.scale].colors : undefined,
    });
    if (ok !== false) setForm({ ...blank, range: form.range });
  };
  return (
    <SidePanel title="Conditional Formatting" onClose={onClose}
      foot={<><button type="button" className="secondary-btn" onClick={() => setForm({ ...blank })}>New Rule</button><button type="button" className="primary-btn" onClick={save}>{form.id ? 'Save Rule' : 'Add Rule'}</button></>}>
      {rules.length > 0 && (
        <section className="nxs-rules">
          <h3 className="nxs-sub">Rules on This Tab</h3>
          {rules.map((r) => (
            <div key={r.id} className={`nxs-rule${form.id === r.id ? ' is-on' : ''}`}>
              <button type="button" className="nxs-rule-main" onClick={() => setForm({
                id: r.id, range: r.a1, type: r.type, a: r.a ?? '', b: r.b ?? '', f: r.fText || '',
                preset: Math.max(0, PRESETS.findIndex((p) => JSON.stringify(p.style) === JSON.stringify(r.style || {}))),
                scale: Math.max(0, SCALES.findIndex((s) => JSON.stringify(s.colors) === JSON.stringify(r.colors || []))),
              })}>
                <span className="nxs-swatch" style={r.type === 'scale' ? { background: `linear-gradient(90deg, ${(r.colors || []).join(',')})` } : { background: r.style?.bg || 'var(--card)', color: r.style?.fc, fontWeight: r.style?.b ? 700 : 400 }}>123</span>
                <span><b>{r.a1}</b><br />{CF_WORDS[r.type]}{r.a != null && r.a !== '' ? ` ${r.a}` : ''}{r.type === 'between' ? ` and ${r.b}` : ''}{r.type === 'formula' ? ` ${r.fText}` : ''}</span>
              </button>
              <button type="button" className="nxs-icon" aria-label="Delete Rule" title="Delete Rule" onClick={() => onDelete(r.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </section>
      )}
      <h3 className="nxs-sub">{form.id ? 'Edit Rule' : 'Add a Rule'}</h3>
      <Row label="Apply to Range"><input className="form-input" value={form.range} onChange={set('range')} placeholder="A1:C20" spellCheck={false} /></Row>
      <Row label="Format Cells If">
        <select className="form-input" value={form.type} onChange={set('type')}>
          {CF_TYPES.map((t) => <option key={t} value={t}>{CF_WORDS[t]}</option>)}
        </select>
      </Row>
      {needsA && <Row label={form.type === 'between' ? 'From' : 'Value'}><input className="form-input" value={form.a} onChange={set('a')} placeholder={['before', 'after'].includes(form.type) ? 'MM/DD/YYYY' : ''} /></Row>}
      {form.type === 'between' && <Row label="To"><input className="form-input" value={form.b} onChange={set('b')} /></Row>}
      {form.type === 'formula' && <Row label="Formula (for the first cell of the range)"><input className="form-input" value={form.f} onChange={set('f')} placeholder="=B2>C2" spellCheck={false} /></Row>}
      {form.type === 'scale'
        ? <Row label="Colors"><select className="form-input" value={form.scale} onChange={(e) => setForm((f) => ({ ...f, scale: +e.target.value }))}>{SCALES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}</select></Row>
        : (
          <Row label="Formatting Style">
            <div className="nxs-btnrow nxs-wrap">
              {PRESETS.map((p, i) => (
                <button key={p.label} type="button" className={`nxs-preset${form.preset === i ? ' is-on' : ''}`} aria-pressed={form.preset === i}
                  style={{ background: p.style.bg || 'var(--card)', color: p.style.fc, fontWeight: p.style.b ? 700 : 500 }}
                  onClick={() => setForm((f) => ({ ...f, preset: i }))}>{p.label}</button>
              ))}
            </div>
          </Row>
        )}
    </SidePanel>
  );
}

// ── Data Validation ─────────────────────────────────────────────────────
const DV_WORDS = { list: 'Dropdown From a List', range: 'Dropdown From a Range', checkbox: 'Checkbox', number: 'Number', date: 'Date' };
const OP_WORDS = { between: 'Between', gte: 'At Least', lte: 'At Most', gt: 'More Than', lt: 'Less Than', eq: 'Equal To' };
export function ValidationPanel({ rules, selA1, initialKind = 'list', onSave, onDelete, onClose, toastErr }) {
  const blank = { id: null, range: selA1, kind: initialKind, items: '', src: '', op: 'between', a: '', b: '', reject: true };
  const [form, setForm] = useState(blank);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = () => {
    if (!form.range.trim()) { toastErr?.('Type the range the rule applies to, like B2:B50.'); return; }
    const items = form.items.split(/\n|,/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
    if (form.kind === 'list' && !items.length) { toastErr?.('Add at least one item, separated by commas.'); return; }
    if (form.kind === 'range' && !form.src.trim()) { toastErr?.('Type the range that holds the choices, like Lists!A1:A20.'); return; }
    const ok = onSave(form.id, {
      range: form.range.trim(), kind: form.kind, reject: !!form.reject,
      items: form.kind === 'list' ? items : undefined, src: form.kind === 'range' ? form.src.trim() : undefined,
      op: ['number', 'date'].includes(form.kind) ? form.op : undefined,
      a: ['number', 'date'].includes(form.kind) ? form.a : undefined, b: ['number', 'date'].includes(form.kind) && form.op === 'between' ? form.b : undefined,
    });
    if (ok !== false) setForm({ ...blank, range: form.range });
  };
  return (
    <SidePanel title="Data Validation" onClose={onClose}
      foot={<><button type="button" className="secondary-btn" onClick={() => setForm({ ...blank })}>New Rule</button><button type="button" className="primary-btn" onClick={save}>{form.id ? 'Save Rule' : 'Add Rule'}</button></>}>
      {rules.length > 0 && (
        <section className="nxs-rules">
          <h3 className="nxs-sub">Rules on This Tab</h3>
          {rules.map((r) => (
            <div key={r.id} className={`nxs-rule${form.id === r.id ? ' is-on' : ''}`}>
              <button type="button" className="nxs-rule-main" onClick={() => setForm({ id: r.id, range: r.a1, kind: r.kind, items: (r.items || []).join(', '), src: r.srcText || '', op: r.op || 'between', a: r.a ?? '', b: r.b ?? '', reject: r.reject !== false })}>
                <span><b>{r.a1}</b><br />{DV_WORDS[r.kind]}{r.kind === 'list' ? `: ${(r.items || []).slice(0, 4).join(', ')}${(r.items || []).length > 4 ? '...' : ''}` : ''}{r.kind === 'range' ? `: ${r.srcText}` : ''}</span>
              </button>
              <button type="button" className="nxs-icon" aria-label="Delete Rule" title="Delete Rule" onClick={() => onDelete(r.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </section>
      )}
      <h3 className="nxs-sub">{form.id ? 'Edit Rule' : 'Add a Rule'}</h3>
      <Row label="Apply to Range"><input className="form-input" value={form.range} onChange={set('range')} placeholder="B2:B50" spellCheck={false} /></Row>
      <Row label="Criteria">
        <select className="form-input" value={form.kind} onChange={set('kind')}>
          {Object.entries(DV_WORDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Row>
      {form.kind === 'list' && <Row label="Items (separated by commas)"><textarea className="form-input" rows={3} value={form.items} onChange={set('items')} placeholder="Open, In Progress, Done" /></Row>}
      {form.kind === 'range' && <Row label="Range With the Choices"><input className="form-input" value={form.src} onChange={set('src')} placeholder="Lists!A1:A20" spellCheck={false} /></Row>}
      {['number', 'date'].includes(form.kind) && (
        <>
          <Row label="Condition"><select className="form-input" value={form.op} onChange={set('op')}>{DV_OPS.map((o) => <option key={o} value={o}>{OP_WORDS[o]}</option>)}</select></Row>
          <Row label={form.op === 'between' ? 'From' : 'Value'}><input className="form-input" value={form.a} onChange={set('a')} placeholder={form.kind === 'date' ? 'MM/DD/YYYY' : ''} /></Row>
          {form.op === 'between' && <Row label="To"><input className="form-input" value={form.b} onChange={set('b')} placeholder={form.kind === 'date' ? 'MM/DD/YYYY' : ''} /></Row>}
        </>
      )}
      {form.kind !== 'checkbox' && (
        <fieldset className="nxs-radio">
          <legend>If the Data Is Invalid</legend>
          <label><input type="radio" name="dv-reject" checked={!!form.reject} onChange={() => setForm((f) => ({ ...f, reject: true }))} /> Reject the Input</label>
          <label><input type="radio" name="dv-reject" checked={!form.reject} onChange={() => setForm((f) => ({ ...f, reject: false }))} /> Show a Warning</label>
        </fieldset>
      )}
    </SidePanel>
  );
}

// ── Named Ranges ────────────────────────────────────────────────────────
export function NamesPanel({ names, selA1, onSave, onDelete, onClose }) {
  const [name, setName] = useState('');
  const [range, setRange] = useState(selA1);
  return (
    <SidePanel title="Named Ranges" onClose={onClose}
      foot={<button type="button" className="primary-btn" onClick={() => { if (onSave(name.trim(), range.trim()) !== false) setName(''); }}>Add Name</button>}>
      <p className="nxs-hint-text">Use a name in a formula instead of its cells: =SUM(Sales). It keeps pointing at the same cells when rows or columns move.</p>
      {names.map((n) => (
        <div key={n.key} className="nxs-rule">
          <div className="nxs-rule-main"><span><b>{n.name}</b><br />{n.a1}</span></div>
          <button type="button" className="nxs-icon" aria-label={`Delete ${n.name}`} title="Delete" onClick={() => onDelete(n.key)}><Trash2 size={14} /></button>
        </div>
      ))}
      <h3 className="nxs-sub">Add a Name</h3>
      <Row label="Name"><input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales" maxLength={64} spellCheck={false} /></Row>
      <Row label="Range"><input className="form-input" value={range} onChange={(e) => setRange(e.target.value)} placeholder="B2:B50" spellCheck={false} /></Row>
    </SidePanel>
  );
}

// ── Sort Range, Remove Duplicates, Split Text to Columns ───────────────
export function SortPanel({ cols, onSort, onClose }) {
  const [header, setHeader] = useState(false);
  const [keys, setKeys] = useState([{ c: cols[0]?.c ?? 0, desc: false }]);
  const labelOf = (c) => (header ? cols.find((x) => x.c === c)?.head || cols.find((x) => x.c === c)?.letter : `Column ${cols.find((x) => x.c === c)?.letter}`);
  return (
    <SidePanel title="Sort Range" onClose={onClose}
      foot={<button type="button" className="primary-btn" onClick={() => { onSort({ header, keys }); onClose(); }}>Sort</button>}>
      <label className="nxs-check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Data Has a Header Row</label>
      {keys.map((k, i) => (
        <div key={i} className="nxs-btnrow">
          <span className="nxs-sortby">{i === 0 ? 'Sort By' : 'Then By'}</span>
          <select className="form-input" value={k.c} aria-label={i === 0 ? 'Sort By' : 'Then By'} onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? { ...x, c: +e.target.value } : x)))}>
            {cols.map((c) => <option key={c.c} value={c.c}>{labelOf(c.c)}</option>)}
          </select>
          <select className="form-input" value={k.desc ? 'desc' : 'asc'} aria-label="Order" onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? { ...x, desc: e.target.value === 'desc' } : x)))}>
            <option value="asc">A to Z</option><option value="desc">Z to A</option>
          </select>
          {i > 0 && <button type="button" className="nxs-icon" aria-label="Remove" onClick={() => setKeys((ks) => ks.filter((_, j) => j !== i))}><X size={14} /></button>}
        </div>
      ))}
      {keys.length < 3 && <button type="button" className="secondary-btn nxs-small" onClick={() => setKeys((ks) => [...ks, { c: cols[0]?.c ?? 0, desc: false }])}>Add Another Sort Column</button>}
    </SidePanel>
  );
}
export function DedupePanel({ cols, onRun, onClose }) {
  const [header, setHeader] = useState(false);
  const [pick, setPick] = useState(() => new Set(cols.map((c) => c.c)));
  return (
    <SidePanel title="Remove Duplicates" onClose={onClose}
      foot={<button type="button" className="primary-btn" disabled={!pick.size} onClick={() => { onRun({ header, cols: [...pick] }); onClose(); }}>Remove Duplicates</button>}>
      <p className="nxs-hint-text">Rows with the same values in the checked columns are removed; the first one stays.</p>
      <label className="nxs-check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Data Has a Header Row</label>
      <h3 className="nxs-sub">Columns to Compare</h3>
      {cols.map((c) => (
        <label key={c.c} className="nxs-check"><input type="checkbox" checked={pick.has(c.c)}
          onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(c.c); else n.delete(c.c); return n; })} /> {header ? c.head || c.letter : `Column ${c.letter}`}</label>
      ))}
    </SidePanel>
  );
}
export function SplitPanel({ onRun, onClose }) {
  const [sep, setSep] = useState('auto');
  const [custom, setCustom] = useState('');
  return (
    <SidePanel title="Split Text to Columns" onClose={onClose}
      foot={<button type="button" className="primary-btn" onClick={() => { onRun(sep === 'custom' ? custom : sep); onClose(); }} disabled={sep === 'custom' && !custom}>Split</button>}>
      <p className="nxs-hint-text">Each selected cell is split across the columns to its right.</p>
      <Row label="Separator">
        <select className="form-input" value={sep} onChange={(e) => setSep(e.target.value)}>
          <option value="auto">Detect Automatically</option><option value=",">Comma</option><option value=";">Semicolon</option>
          <option value=".">Period</option><option value=" ">Space</option><option value="custom">Custom</option>
        </select>
      </Row>
      {sep === 'custom' && <Row label="Custom Separator"><input className="form-input" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={10} /></Row>}
    </SidePanel>
  );
}

// ── popovers ────────────────────────────────────────────────────────────
/** A small box at a point that fits a 375px phone. */
export function Pop({ at, onClose, children, width = 280, label }) {
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const w = Math.min(width, window.innerWidth - 16);
  const style = { position: 'fixed', zIndex: 1000, width: w, left: clamp(at.x, 8, window.innerWidth - w - 8) };
  if (at.up) style.bottom = window.innerHeight - at.y; else style.top = clamp(at.y, 8, window.innerHeight - 120);
  return <div ref={ref} className="nxs-popbox" style={style} role="dialog" aria-label={label}>{children}</div>;
}

const OPS_WORDS = { '': 'None', gt: 'Greater Than', gte: 'At Least', lt: 'Less Than', lte: 'At Most', eq: 'Is Equal To', neq: 'Is Not Equal To', between: 'Is Between', contains: 'Text Contains', notContains: 'Text Does Not Contain', empty: 'Is Empty', notEmpty: 'Is Not Empty' };
export function FilterPop({ at, title, values, crit = {}, onApply, onSort, onClose }) {
  const [hide, setHide] = useState(() => new Set(crit.hide || []));
  const [op, setOp] = useState(crit.op || '');
  const [a, setA] = useState(crit.a ?? '');
  const [b, setB] = useState(crit.b ?? '');
  const [q, setQ] = useState('');
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <Pop at={at} onClose={onClose} width={300} label={`Filter ${title}`}>
      <div className="nxs-pop-title">{title}</div>
      <div className="nxs-btnrow">
        <button type="button" className="secondary-btn nxs-small" onClick={() => { onSort(false); onClose(); }}>Sort A to Z</button>
        <button type="button" className="secondary-btn nxs-small" onClick={() => { onSort(true); onClose(); }}>Sort Z to A</button>
      </div>
      <div className="nxs-pop-label">Filter by Condition</div>
      <select className="form-input" aria-label="Condition" value={op} onChange={(e) => setOp(e.target.value)}>
        {FILTER_OPS.map((o) => <option key={o} value={o}>{OPS_WORDS[o]}</option>)}
      </select>
      {op && !['empty', 'notEmpty'].includes(op) && <input className="form-input" aria-label="Value" value={a} onChange={(e) => setA(e.target.value)} placeholder="Value" />}
      {op === 'between' && <input className="form-input" aria-label="And" value={b} onChange={(e) => setB(e.target.value)} placeholder="And" />}
      <div className="nxs-pop-label">Filter by Values</div>
      <div className="nxs-btnrow">
        <button type="button" className="nxs-link" onClick={() => setHide(new Set())}>Select All</button>
        <button type="button" className="nxs-link" onClick={() => setHide(new Set(values.map((v) => v.text)))}>Clear</button>
      </div>
      <div className="nxs-search"><Search size={13} /><input aria-label="Search values" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" /></div>
      <div className="nxs-values">
        {shown.slice(0, 500).map((v) => (
          <label key={v.text} className="nxs-check"><input type="checkbox" checked={!hide.has(v.text)}
            onChange={(e) => setHide((h) => { const n = new Set(h); if (e.target.checked) n.delete(v.text); else n.add(v.text); return n; })} />
            <span>{v.text === '' ? '(Blanks)' : v.text}</span><span className="nxs-count">{v.count}</span></label>
        ))}
      </div>
      <div className="nxs-pop-foot">
        <button type="button" className="secondary-btn nxs-small" onClick={() => { onApply(null); onClose(); }}>Clear Filter</button>
        <button type="button" className="primary-btn nxs-small" onClick={() => {
          const out = {};
          if (hide.size) out.hide = [...hide].slice(0, 5000);
          if (op) { out.op = op; if (!['empty', 'notEmpty'].includes(op)) out.a = a; if (op === 'between') out.b = b; }
          onApply(Object.keys(out).length ? out : null);
          onClose();
        }}>Apply</button>
      </div>
    </Pop>
  );
}

export function ListPick({ at, items, current, onPick, onClose }) {
  return (
    <Pop at={at} onClose={onClose} width={240} label="Choose a Value">
      <div className="nxs-values" role="listbox">
        {items.length ? items.map((it) => (
          <button key={it} type="button" role="option" aria-selected={it === current} className={`nxs-opt${it === current ? ' is-on' : ''}`} onClick={() => { onPick(it); onClose(); }}>{it}</button>
        )) : <p className="nxs-empty">No choices yet.</p>}
        {current && <button type="button" className="nxs-opt nxs-muted" onClick={() => { onPick(''); onClose(); }}>Clear</button>}
      </div>
    </Pop>
  );
}

export function NoteEditor({ at, note, onSave, onDelete, onClose }) {
  const [text, setText] = useState(note?.text || '');
  return (
    <Pop at={at} onClose={onClose} width={280} label="Note">
      <div className="nxs-pop-title">{note ? 'Edit Note' : 'Insert Note'}</div>
      {note?.by && <div className="nxs-pop-label">{note.by}{note.atText ? `, ${note.atText}` : ''}</div>}
      <textarea className="form-input" rows={4} autoFocus value={text} maxLength={5000} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { onSave(text.trim()); onClose(); } }} />
      <div className="nxs-pop-foot">
        {note && <button type="button" className="secondary-btn nxs-small" onClick={() => { onDelete(); onClose(); }}>Delete Note</button>}
        <button type="button" className="primary-btn nxs-small" onClick={() => { onSave(text.trim()); onClose(); }}>Save</button>
      </div>
    </Pop>
  );
}

/** The Documents Variable Library, searchable and grouped. */
export function VariablePicker({ at, variables, values, onPick, onClose }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const out = new Map();
    for (const v of variables || []) {
      if (q && !`${v.label} ${v.token} ${v.group}`.toLowerCase().includes(q.toLowerCase())) continue;
      const g = v.group || 'Other';
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(v);
    }
    return [...out.entries()];
  }, [variables, q]);
  return (
    <Pop at={at} onClose={onClose} width={320} label="Insert a Variable">
      <div className="nxs-pop-title">Insert a Variable</div>
      <div className="nxs-search"><Search size={13} /><input autoFocus aria-label="Search variables" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search variables" /></div>
      <div className="nxs-values nxs-vars">
        {groups.map(([g, list]) => (
          <div key={g}>
            <div className="nxs-pop-label">{g}</div>
            {list.map((v) => (
              <button key={v.token} type="button" className="nxs-opt" onClick={() => { onPick(v.token); onClose(); }}>
                <span>{v.label || v.token}</span>
                <span className="nxs-muted">{values?.[v.token] != null && values[v.token] !== '' ? String(values[v.token]).slice(0, 40) : `{{${v.token}}}`}</span>
              </button>
            ))}
          </div>
        ))}
        {!groups.length && <p className="nxs-empty">{(variables || []).length ? 'No variable matches that.' : 'No variables are set up yet.'}</p>}
      </div>
    </Pop>
  );
}
