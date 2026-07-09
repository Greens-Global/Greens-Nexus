// Task Module — shared building blocks used across multiple surfaces:
// custom-field type registry + editors + compact cell, a Donut chart, a
// drag-to-resize column-widths hook, a styled confirm dialog + a lightweight
// toast, and @mention rendering + the emoji set. Ported from the export's
// AddColumnMenu / CustomFieldsPanel / useColumnWidths / mentions / emojis.
import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Hash, List as ListIcon, Calendar, CheckSquare, ListOrdered, CircleDot, BarChart3,
  TrendingUp, Star, CalendarPlus, CalendarClock, Timer, Users, Check, X,
} from 'lucide-react';
import { NX, FONT, FIELD_PALETTE, btn, input as inputStyle } from './theme';
import { Avatar } from './components';

// ── Custom-field type registry (from AddColumnMenu.tsx) ──────────────────────
export const FIELD_TYPE_GROUPS = [
  { label: 'Recommended', types: [
    { type: 'text', label: 'Text/number', icon: Hash },
    { type: 'single_select', label: 'Dropdown list', icon: ListIcon },
    { type: 'date', label: 'Date', icon: Calendar },
    { type: 'checkbox', label: 'Checkbox', icon: CheckSquare },
  ] },
  { label: 'Basic', types: [
    { type: 'text', label: 'Text/number', icon: Hash },
    { type: 'autonumber', label: 'Auto-number', icon: ListOrdered },
  ] },
  { label: 'Planning/Status', types: [
    { type: 'single_select', label: 'Dropdown list', icon: ListIcon },
    { type: 'checkbox', label: 'Checkbox', icon: CheckSquare },
    { type: 'status', label: 'Status', icon: CircleDot },
    { type: 'progress', label: 'Progress', icon: BarChart3 },
    { type: 'trends', label: 'Trends', icon: TrendingUp },
    { type: 'rating', label: 'Ratings', icon: Star },
  ] },
  { label: 'Date', types: [
    { type: 'date', label: 'Date', icon: Calendar },
    { type: 'created_date', label: 'Created date', icon: CalendarPlus },
    { type: 'modified_date', label: 'Modified date', icon: CalendarClock },
    { type: 'duration', label: 'Duration', icon: Timer },
  ] },
];
export const FIELD_TYPE_LABEL = {
  text: 'Text/number', number: 'Text/number', single_select: 'Dropdown list',
  multi_select: 'Dropdown list', date: 'Date', people: 'People', checkbox: 'Checkbox',
  autonumber: 'Auto-number', status: 'Status', progress: 'Progress', rating: 'Ratings',
  trends: 'Trends', created_date: 'Created date', modified_date: 'Modified date', duration: 'Duration',
};
export const FIELD_TYPE_ICON = {
  text: Hash, number: Hash, single_select: ListIcon, multi_select: ListIcon, date: Calendar,
  people: Users, checkbox: CheckSquare, autonumber: ListOrdered, status: CircleDot,
  progress: BarChart3, rating: Star, trends: TrendingUp, created_date: CalendarPlus,
  modified_date: CalendarClock, duration: Timer,
};
export const FIELD_HAS_OPTIONS = ['single_select', 'multi_select', 'status'];

// Options may be bare strings (port's older FieldModal) or {id,label,color}. Normalise.
export function normalizeOptions(options) {
  return (options || []).map((o, i) =>
    typeof o === 'string'
      ? { id: o, label: o, color: FIELD_PALETTE[i % FIELD_PALETTE.length] }
      : { id: o.id ?? o.label, label: o.label ?? o.id, color: o.color || FIELD_PALETTE[i % FIELD_PALETTE.length] });
}

// A tiny dropdown wrapper (click-outside close) reused by the select/people editors.
export function Popover({ trigger, children, width = 180, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div style={{ position: 'absolute', top: '100%', [align]: 0, marginTop: 4, width, zIndex: 60,
          background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.16)', maxHeight: 260, overflowY: 'auto', padding: 4 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
function MenuRow({ onClick, children, active }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
      borderRadius: 7, fontSize: 13, cursor: 'pointer', color: NX.ink, background: active ? NX.hover : 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = active ? NX.hover : 'transparent'; }}>
      {children}
    </div>
  );
}

const badge = (color) => ({ display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 600 });

/**
 * Editor for one custom field on a task. `onChange(value)` persists.
 * `people` is [{email,name}]; `createdAt`/`modifiedAt` feed the read-only date types.
 */
export function CustomFieldEditor({ field, value, onChange, people = [], createdAt, modifiedAt }) {
  const type = field.type || 'text';
  const opts = normalizeOptions(field.options);

  if (type === 'single_select' || type === 'status') {
    const opt = opts.find((o) => o.id === value);
    return (
      <Popover width={176} trigger={(t) => (
        <button type="button" onClick={t} style={{ ...btn('ghost'), padding: '2px 4px' }}>
          {opt ? <span style={{ ...badge(), color: opt.color, background: `${opt.color}1a` }}>{opt.label}</span>
               : <span style={{ color: NX.faint, fontSize: 12.5 }}>Set {field.name}</span>}
        </button>
      )}>
        {(close) => (<>
          {opts.map((o) => <MenuRow key={o.id} active={o.id === value} onClick={() => { onChange(o.id); close(); }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: o.color }} />{o.label}
          </MenuRow>)}
          {value != null && <MenuRow onClick={() => { onChange(null); close(); }}><span style={{ color: NX.dim }}>Clear</span></MenuRow>}
          {opts.length === 0 && <div style={{ padding: 8, fontSize: 12, color: NX.faint }}>No options</div>}
        </>)}
      </Popover>
    );
  }
  if (type === 'multi_select') {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {opts.map((o) => {
          const on = selected.includes(o.id);
          return <button key={o.id} type="button" onClick={() => toggle(o.id)} style={{ ...badge(), cursor: 'pointer', border: 'none',
            background: on ? o.color : `${o.color}1a`, color: on ? '#fff' : o.color }}>{o.label}</button>;
        })}
        {opts.length === 0 && <span style={{ color: NX.faint, fontSize: 12 }}>No options</span>}
      </div>
    );
  }
  if (type === 'checkbox') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />;
  }
  if (type === 'date') {
    return <input type="date" defaultValue={typeof value === 'string' ? value : ''} onBlur={(e) => onChange(e.target.value || null)}
      style={{ ...inputStyle, width: 150, padding: '5px 8px' }} />;
  }
  if (type === 'created_date') return <span style={{ color: NX.dim, fontSize: 12.5 }}>{fmtShort(createdAt)}</span>;
  if (type === 'modified_date') return <span style={{ color: NX.dim, fontSize: 12.5 }}>{fmtShort(modifiedAt)}</span>;
  if (type === 'autonumber') return <span style={{ color: NX.dim, fontSize: 12.5 }}>{value != null ? String(value) : '—'}</span>;
  if (type === 'rating') {
    const n = typeof value === 'number' ? value : 0;
    return (
      <div style={{ display: 'flex', gap: 1 }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button key={i} type="button" onClick={() => onChange(i === n ? 0 : i)} title={`${i} star${i > 1 ? 's' : ''}`}
            style={{ ...btn('ghost'), padding: 1, color: NX.amber }}>
            <Star size={16} fill={i <= n ? 'currentColor' : 'none'} />
          </button>
        ))}
      </div>
    );
  }
  if (type === 'progress') {
    const n = typeof value === 'number' ? value : 0;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="range" min={0} max={100} value={n} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1, accentColor: NX.blue }} />
        <span style={{ width: 34, textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{n}%</span>
      </div>
    );
  }
  if (type === 'people') {
    const picked = people.find((u) => u.email === value);
    return (
      <Popover width={210} trigger={(t) => (
        <button type="button" onClick={t} style={{ ...btn('ghost'), padding: '2px 4px', gap: 6 }}>
          {picked ? <><Avatar email={picked.email} name={picked.name} size={18} /><span style={{ fontSize: 12.5 }}>{picked.name}</span></>
                  : <span style={{ color: NX.faint, fontSize: 12.5 }}>Set {field.name}</span>}
        </button>
      )}>
        {(close) => (<>
          {people.map((u) => <MenuRow key={u.email} active={u.email === value} onClick={() => { onChange(u.email); close(); }}>
            <Avatar email={u.email} name={u.name} size={18} />{u.name}
          </MenuRow>)}
          {value != null && <MenuRow onClick={() => { onChange(null); close(); }}><span style={{ color: NX.dim }}>Clear</span></MenuRow>}
        </>)}
      </Popover>
    );
  }
  if (type === 'number' || type === 'duration' || type === 'trends') {
    return <input type="number" defaultValue={value != null ? String(value) : ''} onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      style={{ ...inputStyle, width: 110, padding: '5px 8px' }} />;
  }
  return <input defaultValue={value != null ? String(value) : ''} onBlur={(e) => onChange(e.target.value)} style={{ ...inputStyle, padding: '5px 8px' }} />;
}

// Compact, non-interactive-ish rendering for a table cell (list view).
export function CustomFieldCell({ field, value, onChange, createdAt, modifiedAt }) {
  return <CustomFieldEditor field={field} value={value} onChange={onChange} createdAt={createdAt} modifiedAt={modifiedAt} />;
}

function fmtShort(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return String(iso).slice(0, 10); }
}

// ── Donut chart (from dashboard/charts.tsx) ──────────────────────────────────
export function Donut({ segments = [], size = 132, thickness = 16, centerLabel, centerValue }) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <svg width={size} height={size} style={{ flexShrink: 0 }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={NX.border2} strokeWidth={thickness} />
          {segments.map((s, i) => {
            const frac = (s.value || 0) / total;
            const dash = frac * c;
            const el = (
              <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} strokeLinecap="butt" />
            );
            offset += dash;
            return el;
          })}
        </g>
        {(centerValue != null || centerLabel) && (
          <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" style={{ fontFamily: FONT }}>
            <tspan x="50%" dy="-2" style={{ fontSize: 22, fontWeight: 800, fill: NX.ink }}>{centerValue}</tspan>
            {centerLabel && <tspan x="50%" dy="18" style={{ fontSize: 11, fill: NX.faint }}>{centerLabel}</tspan>}
          </text>
        )}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: NX.dim }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />
            <span style={{ color: NX.ink, fontWeight: 600 }}>{s.value}</span> {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// Horizontal bar list (from charts.tsx LightBar) — used by dashboard/reporting.
export function BarList({ rows = [], color = NX.blue }) {
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
          <span style={{ width: 120, flexShrink: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div style={{ flex: 1, height: 9, borderRadius: 6, background: NX.border2, overflow: 'hidden' }}>
            <div style={{ width: `${((r.value || 0) / max) * 100}%`, height: '100%', background: r.color || color, borderRadius: 6 }} />
          </div>
          <span style={{ width: 28, textAlign: 'right', fontWeight: 700, color: NX.ink }}>{r.value}</span>
        </div>
      ))}
      {rows.length === 0 && <div style={{ fontSize: 12, color: NX.faint }}>No data</div>}
    </div>
  );
}

// ── Column widths (from useColumnWidths.ts) ─────────────────────────────────
export function useColumnWidths(cols, opts = {}) {
  const [widths, setWidths] = useState(() => Object.fromEntries(cols.map((c) => [c.key, c.width])));
  const startResize = (key, startWidth) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const onMove = (ev) => setWidths((w) => ({ ...w, [key]: Math.max(60, startWidth + (ev.clientX - startX)) }));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };
  const template = cols.map((c) => {
    const w = widths[c.key] ?? c.width;
    return c.key === opts.growKey ? `minmax(${w}px, 1fr)` : `${w}px`;
  }).join(' ');
  return { widths, startResize, template };
}
export function ColResizer({ onMouseDown }) {
  return <span onMouseDown={onMouseDown} style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 2 }} />;
}

// ── Confirm dialog (styled replacement for window.confirm) ───────────────────
export function ConfirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger, requireText, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('');
  const blocked = requireText != null && typed !== requireText;
  return createPortal(
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 5000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: NX.surface, borderRadius: 14, width: 420, maxWidth: '100%',
        boxShadow: '0 24px 60px rgba(0,0,0,0.3)', padding: 22 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink }}>{title}</div>
        {message && <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 8, lineHeight: 1.5 }}>{message}</div>}
        {requireText != null && (
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Type "${requireText}" to confirm`}
            style={{ ...inputStyle, marginTop: 12 }} />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button onClick={onCancel} style={{ ...btn('outline') }}>Cancel</button>
          <button onClick={() => !blocked && onConfirm()} disabled={blocked}
            style={{ ...btn('primary'), background: danger ? NX.red : NX.primary, border: 'none', opacity: blocked ? 0.4 : 1 }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
/** Hook: const [confirm, node] = useConfirm(); await confirm({title,...}). Render {node}. */
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);
  const node = state ? (
    <ConfirmDialog {...state}
      onConfirm={() => { state.resolve(true); setState(null); }}
      onCancel={() => { state.resolve(false); setState(null); }} />
  ) : null;
  return [confirm, node];
}

// ── Lightweight toast (event-based; a single <TaskToaster/> mounts at the shell) ──
export function toast(message, kind = 'info') {
  window.dispatchEvent(new CustomEvent('nexus:task-toast', { detail: { message, kind } }));
}
export function TaskToaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e) => {
      const id = ++n;
      setItems((xs) => [...xs, { id, ...e.detail }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
    };
    window.addEventListener('nexus:task-toast', onToast);
    return () => window.removeEventListener('nexus:task-toast', onToast);
  }, []);
  if (!items.length) return null;
  return createPortal(
    <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 6000,
      display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', fontFamily: FONT }}>
      {items.map((it) => (
        <div key={it.id} style={{ background: NX.primary, color: '#fff', borderRadius: 10, padding: '10px 16px',
          fontSize: 13, fontWeight: 600, boxShadow: '0 10px 30px rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {it.kind === 'success' && <Check size={15} />}
          {it.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ── @mentions + emoji (from lib/mentions.tsx + lib/emojis.ts) ────────────────
export const EMOJIS = [
  '👍', '👎', '❤️', '🎉', '🔥', '😄', '😂', '😅',
  '😍', '🤔', '😎', '🙌', '👏', '🙏', '💪', '✅',
  '❌', '⚠️', '🚀', '✨', '💡', '📌', '📝', '📎',
  '⏰', '📅', '🐛', '🔧', '🚧', '🎯', '💯', '👀',
  '🤝', '🙈', '😴', '☕', '🍕', '🥳', '😬', '😱',
];
export function renderWithMentions(body, names) {
  if (!names || names.length === 0) return body;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${escaped.join('|')})`, 'g');
  const out = []; let last = 0; let key = 0; let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(<span key={key++} style={{ borderRadius: 4, background: `${NX.blue}1a`, padding: '0 3px', fontWeight: 600, color: NX.blue }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}
export function activeMention(value, caret) {
  const upto = value.slice(0, caret);
  const m = upto.match(/@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[1], start: caret - m[0].length };
}
export { X as CloseIcon };
