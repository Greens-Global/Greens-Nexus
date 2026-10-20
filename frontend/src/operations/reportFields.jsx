// Operations > Reports: the pieces the Run / Download dialog and the Schedule
// dialog share - the 60% popup shell (CLAUDE.md), period, facilities (a
// dropdown with checkboxes, not chips), report options, file format, and the
// Nexus People picker for recipients.
import { formatDate } from '../lib/datetime';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, FileSpreadsheet, FileText, Sheet, X } from 'lucide-react';
import { api } from '../api';
import { UNITS, periodName, rangeWords, resolvePeriod } from './reportPeriod';
import { isThirdParty, managedLabel } from './thirdParty';

export const FORMATS = [
  ['xlsx', 'Excel (XLSX)', 'Formatted spreadsheet with headers, totals and money columns ready to sum.', FileSpreadsheet],
  ['pdf', 'PDF', 'Print-ready, with the period and facility on every page.', FileText],
  ['csv', 'CSV', 'Plain rows for any other tool.', Sheet],
];

export function ReportModal({ title, sub, onClose, children, footer, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ops-drill-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ops-drill dash-card" role="dialog" aria-modal="true" aria-label={label || title} tabIndex={-1} ref={ref}>
        <div className="ops-drill-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
            {sub && <div className="dash-card-sub" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          <button type="button" className="ops-x" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="ops-drill-body ops-rd-body">{children}</div>
        {footer && <div className="ops-rd-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, id }) {
  return (
    <div className="ops-rd-field" role="group" aria-labelledby={id}>
      <div className="ops-rd-label" id={id}>{label}</div>
      {children}
      {hint && <div className="ops-rd-hint">{hint}</div>}
    </div>
  );
}

// `allowManual` false in a schedule (a fixed date range cannot repeat).
export function PeriodField({ meta, value, onChange, today, allowManual = true, scheduled = false }) {
  if (!meta.period && meta.pointInTime && !scheduled) {
    // One date (Balances Summary): today, or how things stood on a past day.
    const past = value?.mode === 'past';
    return (
      <Field label="As Of" id="rd-period" hint={past ? `Balances through ${formatDate(value.date)}.` : 'Balances through today.'}>
        <div className="ops-rd-row">
          <div className="ops-seg" role="radiogroup" aria-label="As Of">
            <label className="ops-seg-opt" data-on={!past}>
              <input type="radio" name="rd-asof" checked={!past} onChange={() => onChange({ mode: 'today' })} />Today
            </label>
            <label className="ops-seg-opt" data-on={past}>
              <input type="radio" name="rd-asof" checked={past} onChange={() => onChange({ mode: 'past', date: value?.date || today })} />In the Past
            </label>
          </div>
          {past && (
            <input type="date" className="form-input" aria-label="As Of Date" value={value.date || ''} max={today}
              onChange={(e) => e.target.value && onChange({ mode: 'past', date: e.target.value })} />
          )}
        </div>
      </Field>
    );
  }
  if (!meta.period) {
    return (
      <Field label="Period" id="rd-period">
        <p className="ops-rd-static">{scheduled ? 'As of when it is sent: how things stand at that moment.' : 'As of the last Cubby sync: how things stand now.'}</p>
      </Field>
    );
  }
  const modes = [['current', 'Current'], ['previous', 'Previous'], ...(allowManual ? [['manual', 'Custom Dates']] : [])];
  const resolved = resolvePeriod(value, today);
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <Field label="Period" id="rd-period"
      hint={scheduled ? `Each send covers the ${periodName(value).toLowerCase()} at that time. Sent today it would cover ${rangeWords(resolved)}.` : `Covers ${rangeWords(resolved)}.`}>
      <div className="ops-rd-row">
        <div className="ops-seg" role="radiogroup" aria-label="Period">
          {modes.map(([k, l]) => (
            <label key={k} className="ops-seg-opt" data-on={value.mode === k}>
              <input type="radio" name="rd-period-mode" value={k} checked={value.mode === k}
                onChange={() => set(k === 'manual' ? { mode: k, ...resolved } : { mode: k })} />{l}
            </label>
          ))}
        </div>
        {value.mode !== 'manual' ? (
          <select className="form-input ops-rd-select" aria-label="Period Length" value={value.unit || 'month'} onChange={(e) => set({ unit: e.target.value })}>
            {UNITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        ) : (
          <span className="ops-rd-dates">
            <input type="date" className="form-input" aria-label="From" value={value.from || ''} max={value.to || undefined}
              onChange={(e) => e.target.value && set({ from: e.target.value })} />
            <span aria-hidden="true">-</span>
            <input type="date" className="form-input" aria-label="To" value={value.to || ''} min={value.from || undefined}
              onChange={(e) => e.target.value && set({ to: e.target.value })} />
          </span>
        )}
      </div>
    </Field>
  );
}

export function facilitiesWords(ids, facilities) {
  if (!ids.length || ids.length >= facilities.length) return `All Facilities (${facilities.length})`;
  if (ids.length === 1) return facilities.find((f) => f.id === ids[0])?.shortName || '1 Facility';
  return `${ids.length} Facilities`;
}

// A dropdown with a checkbox per facility and Select All. `value` is a list of ids.
export function FacilitiesField({ facilities, value, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    box.current?.addEventListener('keydown', esc);
    const el = box.current;
    return () => { document.removeEventListener('mousedown', away); el?.removeEventListener('keydown', esc); };
  }, [open]);
  const all = value.length === facilities.length;
  const groups = useMemo(() => {
    const out = [['', facilities.filter((f) => !isThirdParty(f))]];
    facilities.filter(isThirdParty).forEach((f) => {
      const label = managedLabel(f) || 'Managed by an Operator';
      const g = out.find(([l]) => l === label);
      if (g) g[1].push(f); else out.push([label, [f]]);
    });
    return out.filter(([, list]) => list.length);
  }, [facilities]);
  const flip = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <Field label="Facilities" id="rd-fac" hint={!value.length ? 'Pick at least one facility.' : null}>
      <div className="ops-ms" ref={box}>
        <button type="button" className="ops-ms-btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>{value.length ? facilitiesWords(value, facilities) : 'No Facility Picked'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open && (
          <div className="ops-ms-pop dash-card" role="group" aria-label="Facilities">
            <label className="ops-ms-opt ops-ms-all">
              <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = !all && value.length > 0; }}
                onChange={() => onChange(all ? [] : facilities.map((f) => f.id))} />
              Select All
            </label>
            {groups.map(([label, list]) => (
              <div key={label || 'own'}>
                {label && <div className="ops-drill-h" style={{ margin: '8px 8px 2px' }}>{label}</div>}
                {list.map((f) => (
                  <label key={f.id} className="ops-ms-opt">
                    <input type="checkbox" checked={value.includes(f.id)} onChange={() => flip(f.id)} />{f.shortName}
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

export const optionDefaults = (meta) => Object.fromEntries((meta.options || []).map((o) => [o.key, o.default ?? (o.type === 'bool' ? false : o.choices?.[0]?.value ?? '')]));

// Only the options this report has, starting from its defaults.
export function cleanOptions(meta, saved) {
  const base = optionDefaults(meta);
  Object.keys(base).forEach((k) => { if (saved && saved[k] !== undefined) base[k] = saved[k]; });
  return base;
}

export function OptionsField({ meta, value, onChange }) {
  const opts = meta.options || [];
  if (!opts.length) return null;
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <Field label="Options" id="rd-opts">
      <div className="ops-rd-opts">
        {opts.map((o) => (o.type === 'select' ? (
          <label key={o.key} className="ops-rd-opt">
            <span className="ops-rd-opt-l">{o.label}</span>
            <select className="form-input ops-rd-select" value={value[o.key] ?? ''} onChange={(e) => set(o.key, e.target.value)}>
              {(o.choices || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {o.help && <span className="ops-rd-hint">{o.help}</span>}
          </label>
        ) : (
          <label key={o.key} className="ops-rd-check">
            <input type="checkbox" checked={!!value[o.key]} onChange={(e) => set(o.key, e.target.checked)} />
            <span><span className="ops-rd-opt-l">{o.label}</span>{o.help && <span className="ops-rd-hint">{o.help}</span>}</span>
          </label>
        )))}
      </div>
    </Field>
  );
}

export function optionWords(meta, value) {
  const opts = meta.options || [];
  if (!opts.length) return '';
  const on = opts.filter((o) => (o.type === 'bool' ? !!value[o.key] : value[o.key] !== (o.default ?? o.choices?.[0]?.value)));
  return on.length ? on.map((o) => (o.type === 'bool' ? o.label : `${o.label}: ${o.choices?.find((c) => c.value === value[o.key])?.label || value[o.key]}`)).join(', ') : 'Default Options';
}

export function FormatField({ value, onChange }) {
  return (
    <Field label="File Format" id="rd-format">
      <div className="ops-fmt" role="radiogroup" aria-label="File Format">
        {FORMATS.map(([k, l, about, Icon]) => (
          <label key={k} className="ops-fmt-card" data-on={value === k}>
            <input type="radio" name="rd-format" value={k} checked={value === k} onChange={() => onChange(k)} />
            <Icon size={18} aria-hidden="true" className="ops-fmt-icon" />
            <span><span className="ops-fmt-l">{l}</span><span className="ops-rd-hint">{about}</span></span>
            {value === k && <Check size={14} aria-hidden="true" className="ops-fmt-check" />}
          </label>
        ))}
      </div>
    </Field>
  );
}

// Recipients from the curated Nexus People list (CLAUDE.md), never M365.
export function PeopleField({ value, onChange }) {
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.getPeopleDirectory().then((p) => setPeople(Array.isArray(p) ? p : [])).catch(() => setPeople([])); }, []);
  const nameOf = (email) => people.find((p) => (p.email || '').toLowerCase() === email)?.name || email;
  const add = () => {
    const q = pick.trim().toLowerCase();
    const hit = people.find((p) => p.email && (p.email.toLowerCase() === q || (p.name || '').toLowerCase() === q));
    if (!hit) { setError('Pick someone from Nexus People.'); return; }
    const email = hit.email.toLowerCase();
    if (!value.includes(email)) onChange([...value, email]);
    setPick(''); setError('');
  };
  return (
    <Field label="Send To" id="rd-people" hint={error || (!value.length ? 'Add at least one person.' : null)}>
      <div className="ops-rd-row">
        <input className="form-input" style={{ flex: '1 1 240px' }} list="ops-rs-people" value={pick} aria-label="Add a Person"
          placeholder="Name or email from Nexus People" onChange={(e) => setPick(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="secondary-btn" onClick={add}>Add</button>
      </div>
      <datalist id="ops-rs-people">{people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}</datalist>
      {value.length > 0 && (
        <ul className="ops-people">
          {value.map((r) => (
            <li key={r}>
              <span className="ops-avatar" aria-hidden="true">{initials(nameOf(r))}</span>
              <span className="ops-people-n">{nameOf(r)}</span>
              <button type="button" className="ops-x" aria-label={`Remove ${nameOf(r)}`} onClick={() => onChange(value.filter((x) => x !== r))}><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

export function initials(name) {
  const parts = String(name || '').replace(/@.*/, '').split(/[\s.]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}
