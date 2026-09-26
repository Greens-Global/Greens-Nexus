// Shared reminder-settings panel (Sep 2026). One row per reminder: a plain
// line saying what it is and who gets it, an on/off switch, then the row's
// own fields - lists of days as chips, whole-number fields, checkboxes. Save
// only lights up when something actually changed.
//
// Used by HR & Compliance Reminders (HrReminderSettings.jsx) and Equipment
// Reminders (EquipmentReminderSettings.jsx); each passes its own rows, its
// load/save API calls and the "who can change this" note. The server decides
// edit rights and reports them as `canEdit`.
//
// Row shape: { key, title, what, who,
//   lists:  [{ field, label, min, format }]   // day chips
//   nums:   [{ field, label, suffix, min, max }]
//   checks: [{ field, label }] }
import { useEffect, useMemo, useState } from 'react';
import { X, Plus, RotateCcw, Save, Info } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { formatDateTime } from '../lib/datetime';
import { NX, FONT, btn } from '../tasks/theme';

const MAX_DAY = 365;
const MAX_ENTRIES = 10;

const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
export const beforeLabel = (n) => (n === 0 ? 'On the day' : `${dayWord(n)} before`);
export const afterLabel = (n) => `${dayWord(n)} after`;
const sortDesc = (list) => [...new Set(list)].sort((a, b) => b - a);

// The order the backend stores things in, so "dirty" never flags a
// reordering the server would undo anyway.
function normalize(cfg) {
  if (!cfg) return cfg;
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = { ...v };
    for (const [f, val] of Object.entries(v)) if (Array.isArray(val)) out[k][f] = sortDesc(val);
  }
  return out;
}

const inputStyle = (w) => ({ width: w, padding: '4px 8px', borderRadius: 8, border: `1px solid ${NX.border}`, fontSize: 12.5,
  fontFamily: FONT, color: NX.ink, background: NX.surface, boxSizing: 'border-box' });

function Toggle({ on, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      style={{ width: 38, height: 22, borderRadius: 999, border: 'none', padding: 2, flexShrink: 0,
        background: on ? NX.green : NX.border, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
    </button>
  );
}

// One editable list of days: chips with a remove button, plus a small
// "add a day" box. `min` is 0 for days before (0 = on the day), 1 for after.
function DayChips({ label, days, min, format, onChange, disabled, rowTitle }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const add = () => {
    const raw = text.trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > MAX_DAY) {
      setErr(`Enter a whole number from ${min} to ${MAX_DAY}.`);
      return;
    }
    if (days.includes(n)) { setErr('That day is already on the list.'); return; }
    if (days.length >= MAX_ENTRIES) { setErr(`You can pick up to ${MAX_ENTRIES} days.`); return; }
    onChange(sortDesc([...days, n]));
    setText(''); setErr('');
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {days.length === 0 && (
          <span style={{ fontSize: 12, color: NX.faint }}>No days picked.</span>
        )}
        {days.map(n => (
          <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 6px 3px 10px',
            borderRadius: 999, fontSize: 12, fontWeight: 600, color: NX.ink, background: NX.surface2,
            border: `1px solid ${NX.border}`, whiteSpace: 'nowrap' }}>
            {format(n)}
            {!disabled && (
              <button type="button" aria-label={`Remove ${format(n)} from ${rowTitle}`}
                onClick={() => onChange(days.filter(d => d !== n))}
                style={{ display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', border: 'none',
                  background: 'transparent', color: NX.faint, cursor: 'pointer', padding: 0 }}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {!disabled && days.length < MAX_ENTRIES && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="number" inputMode="numeric" min={min} max={MAX_DAY} value={text}
              aria-label={`Add a day to ${rowTitle} (${label.toLowerCase()})`}
              placeholder="Days" onChange={e => { setText(e.target.value); setErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              style={{ ...inputStyle(66), fontSize: 12 }} />
            <button type="button" onClick={add} disabled={!text.trim()}
              style={{ ...btn('outline'), padding: '4px 9px', fontSize: 12, opacity: text.trim() ? 1 : 0.55 }}>
              <Plus size={12} /> Add Day
            </button>
          </span>
        )}
      </div>
      {err && <div role="alert" style={{ fontSize: 11.5, color: NX.red, marginTop: 4 }}>{err}</div>}
    </div>
  );
}

function NumberField({ label, suffix, value, min, max, onChange, disabled }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.ink }}>
      {label}
      <input type="number" inputMode="numeric" min={min} max={max} value={value} disabled={disabled}
        onChange={e => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isInteger(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        style={inputStyle(58)} />
      {typeof suffix === 'function' ? suffix(value) : suffix}
    </label>
  );
}

function ReminderRow({ row, value, onChange, disabled }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const on = !!value.enabled;
  return (
    <div style={{ padding: '14px 0', borderTop: `1px solid ${NX.border}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{row.title}</div>
          <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{row.what}</div>
          <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>{row.who}</div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: NX.dim }}>
          {on ? 'On' : 'Off'}
          <Toggle on={on} disabled={disabled} label={`${row.title} reminders`} onChange={() => set({ enabled: !on })} />
        </span>
      </div>
      {on && (row.lists || []).map(l => (
        <DayChips key={l.field} label={l.label} rowTitle={row.title} days={value[l.field] || []} min={l.min}
          format={l.format} disabled={disabled} onChange={d => set({ [l.field]: d })} />
      ))}
      {on && (row.nums || row.checks) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 10 }}>
          {(row.checks || []).map(c => (
            <label key={c.field} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.ink }}>
              <input type="checkbox" checked={!!value[c.field]} disabled={disabled}
                onChange={e => set({ [c.field]: e.target.checked })} />
              {c.label}
            </label>
          ))}
          {(row.nums || []).map(n => (
            <NumberField key={n.field} label={n.label} suffix={n.suffix} min={n.min} max={n.max} disabled={disabled}
              value={value[n.field]} onChange={v => set({ [n.field]: v })} />
          ))}
        </div>
      )}
      {!on && (
        <div style={{ fontSize: 12, color: NX.faint, marginTop: 8 }}>Off - nobody is reminded about this.</div>
      )}
    </div>
  );
}

export default function ReminderSettingsPanel({ load: loadFn, save: saveFn, rows, intro, lockedNote }) {
  const [state, setState] = useState(null);   // last saved server state
  const [draft, setDraft] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);       // { ok, text }

  const load = () => {
    setLoadErr('');
    loadFn()
      .then(s => { setState(s); setDraft(normalize(s.config)); })
      .catch(e => setLoadErr(e.message || String(e)));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = useMemo(() => normalize(state?.config), [state]);
  const defaults = useMemo(() => normalize(state?.defaults), [state]);
  const dirty = !!draft && JSON.stringify(normalize(draft)) !== JSON.stringify(saved);
  const atDefaults = !!draft && JSON.stringify(normalize(draft)) === JSON.stringify(defaults);

  if (loadErr) return <ErrorBanner message={`Could not load reminder settings: ${loadErr}`} onRetry={load} />;
  if (!state || !draft) return <SkeletonBlocks count={3} height={64} borderRadius={10} />;

  const canEdit = !!state.canEdit;

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const next = await saveFn({ config: draft });
      setState(next); setDraft(normalize(next.config));
      setMsg({ ok: true, text: 'Saved. The next daily check uses these settings.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message || String(e) });
    } finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: NX.dim, lineHeight: 1.5, marginBottom: 12 }}>
        <Info size={14} style={{ flexShrink: 0, marginTop: 3 }} />
        <span>{intro}</span>
      </div>
      {!canEdit && (
        <div style={{ fontSize: 12.5, color: NX.dim, background: NX.surface2, border: `1px solid ${NX.border}`,
          borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
          {lockedNote}
        </div>
      )}

      {rows.map(row => (
        <ReminderRow key={row.key} row={row} value={draft[row.key] || {}} disabled={!canEdit || saving}
          onChange={v => { setDraft(d => ({ ...d, [row.key]: v })); setMsg(null); }} />
      ))}

      {canEdit && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 14, borderTop: `1px solid ${NX.border}` }}>
          <button type="button" onClick={save} disabled={!dirty || saving}
            style={{ ...btn('primary'), opacity: !dirty || saving ? 0.55 : 1, cursor: !dirty || saving ? 'not-allowed' : 'pointer' }}>
            <Save size={13} /> {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {dirty && (
            <button type="button" onClick={() => { setDraft(saved); setMsg(null); }} disabled={saving} style={btn('outline')}>
              Discard Changes
            </button>
          )}
          <button type="button" onClick={() => { setDraft(defaults); setMsg(null); }} disabled={atDefaults || saving}
            title="Put every reminder back to the settings Nexus started with. Save to apply."
            style={{ ...btn('ghost'), opacity: atDefaults ? 0.55 : 1 }}>
            <RotateCcw size={13} /> Reset to Defaults
          </button>
          {dirty && !msg && <span style={{ fontSize: 12, color: NX.amber }}>You have unsaved changes.</span>}
          {msg && <span role="status" style={{ fontSize: 12, color: msg.ok ? NX.green : NX.red }}>{msg.text}</span>}
        </div>
      )}
      {state.updatedAt && (
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 10 }}>
          Last changed by {state.updatedBy} on {formatDateTime(state.updatedAt)}.
        </div>
      )}
    </div>
  );
}
