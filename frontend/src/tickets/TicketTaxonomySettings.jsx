// Ticket SLA & Types - admin config for the two things that used to be
// hardcoded constants an engineer had to edit and redeploy to change
// (Sep 2026 - see the Admin module audit, Tier 2 items "Ticket SLA targets
// per priority" and "Ticket types & intake questions"). Manager+ only,
// mirroring the backend's require_manager gate on these endpoints - this UI
// hides the controls, the backend is the real boundary.
//
// A type's KEY, icon and color stay defined in ticketMeta.js (compiled-in
// React components/tokens aren't JSON) - this only overrides label, hint,
// whether/where it shows at intake, and its intake field list. Adding a
// brand-new type with a new icon is still a code change.
//
// Saving here calls refreshTicketConfig() (ticketConfig.js) so every
// already-open ticket screen picks up the change immediately, the same way
// TicketDeskSettings/TicketNotifySettings's saves take effect live.
import { useEffect, useState } from 'react';
import { Timer, ListTree, Plus, ChevronDown, ChevronUp, Save, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import { TICKET_TYPE_META } from './ticketMeta';
import { refreshTicketConfig } from './ticketConfig';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const field = { marginBottom: 14 };
const PRIORITIES = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
const FIELD_KINDS = [
  'text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio',
  'multiselect', 'person', 'multiperson', 'project', 'checklist',
];
const OPTIONS_KINDS = new Set(['select', 'radio', 'multiselect']);

function Field({ label, hint, children }) {
  return (
    <div style={field}>
      <label style={fieldLabel}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Toggle({ on, onChange, title }) {
  return (
    <button type="button" onClick={onChange} title={title || (on ? 'Enabled' : 'Disabled')} style={{
      position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0,
    }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

// Turns "Warranty End Date" into a unique typeFields key ("warrantyEndDate",
// "warrantyEndDate2", ...) - same job the server would do, done client-side
// since this never touches the server's own id generator.
function slugKey(label, existing) {
  const base = (label || 'field').trim().replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
  let key = base.charAt(0).toLowerCase() + base.slice(1) || 'field';
  let i = 2;
  while (existing.some((f) => f.key === key)) key = `${base}${i++}`;
  return key;
}

function FieldEditor({ typeKey, fields, onChange }) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newKind, setNewKind] = useState('text');

  const set = (i, patch) => onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = fields.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const addField = () => {
    if (!newLabel.trim()) return;
    const key = slugKey(newLabel, fields);
    onChange([...fields, { key, label: newLabel.trim(), type: newKind, req: false, full: newKind === 'textarea' }]);
    setNewLabel(''); setNewKind('text'); setAdding(false);
  };

  return (
    <div style={{ paddingLeft: 4 }}>
      {fields.length === 0 && (
        <div style={{ fontSize: 12.5, color: NX.faint, padding: '6px 0 10px' }}>No intake questions for this type yet.</div>
      )}
      {fields.map((f, i) => (
        <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 9, border: `1px solid ${NX.border}`, background: NX.surface, marginBottom: 8, opacity: f.retired ? 0.55 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...btn('ghost'), padding: 2, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={12} /></button>
              <button onClick={() => move(i, 1)} disabled={i === fields.length - 1} style={{ ...btn('ghost'), padding: 2, opacity: i === fields.length - 1 ? 0.3 : 1 }}><ChevronDown size={12} /></button>
            </div>
            <input value={f.label} onChange={(e) => set(i, { label: e.target.value })} style={{ ...inputStyle, flex: 1 }} placeholder="Question label" />
            <select value={f.type} onChange={(e) => set(i, { type: e.target.value })} style={{ ...inputStyle, width: 140 }}>
              {FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label title="Required" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: NX.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>
              <Toggle on={!!f.req} onChange={() => set(i, { req: !f.req })} title="Required" /> Req
            </label>
            <label title="Retired questions stay visible on tickets that already answered them, but are no longer asked" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: NX.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>
              <Toggle on={!!f.retired} onChange={() => set(i, { retired: !f.retired })} title="Retired" /> Retired
            </label>
          </div>
          {OPTIONS_KINDS.has(f.type) && (
            <input value={(f.options || []).join(', ')} onChange={(e) => set(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="Options, comma-separated" style={inputStyle} />
          )}
          {f.type === 'checklist' && (
            <input value={(f.items || []).join(', ')} onChange={(e) => set(i, { items: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="Checklist items, comma-separated" style={inputStyle} />
          )}
        </div>
      ))}
      {adding ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New question label"
            style={{ ...inputStyle, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && addField()} autoFocus />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={{ ...inputStyle, width: 140 }}>
            {FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button onClick={addField} style={{ ...btn('primary'), padding: '7px 12px' }}>Add</button>
          <button onClick={() => { setAdding(false); setNewLabel(''); }} style={{ ...btn('ghost'), padding: '7px 12px' }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '6px 10px' }}>
          <Plus size={13} /> Add question
        </button>
      )}
    </div>
  );
}

function TypeRow({ typeKey, meta, shown, onToggleShown, canMoveUp, canMoveDown, onMove, typeCfg, onChangeType }) {
  const [open, setOpen] = useState(false);
  const Icon = meta.icon;
  const label = typeCfg.label ?? meta.label;
  const hint = typeCfg.hint ?? (meta.hint || '');
  const fields = typeCfg.fields ?? [];

  return (
    <div style={{ ...card, padding: 0, marginBottom: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <Icon size={16} style={{ color: meta.color, flexShrink: 0 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button onClick={() => onMove(-1)} disabled={!canMoveUp} style={{ ...btn('ghost'), padding: 1, opacity: canMoveUp ? 1 : 0.3 }}><ChevronUp size={11} /></button>
          <button onClick={() => onMove(1)} disabled={!canMoveDown} style={{ ...btn('ghost'), padding: 1, opacity: canMoveDown ? 1 : 0.3 }}><ChevronDown size={11} /></button>
        </div>
        <input value={label} onChange={(e) => onChangeType({ label: e.target.value })} style={{ ...inputStyle, width: 200 }} />
        <input value={hint} onChange={(e) => onChangeType({ hint: e.target.value })} placeholder="Hint shown under the type picker"
          style={{ ...inputStyle, flex: 1 }} />
        <label title="Shown at intake" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: NX.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>
          <Toggle on={shown} onChange={onToggleShown} /> Intake
        </label>
        <button onClick={() => setOpen((o) => !o)} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 10px', whiteSpace: 'nowrap' }}>
          {fields.length} question{fields.length === 1 ? '' : 's'} {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${NX.border}`, padding: '12px 14px', background: NX.surface2 }}>
          <FieldEditor typeKey={typeKey} fields={fields} onChange={(next) => onChangeType({ fields: next })} />
        </div>
      )}
    </div>
  );
}

export default function TicketTaxonomySettings() {
  const { myLevel } = useRole();
  const [cfg, setCfg] = useState(null);       // raw server config: { slaTargetHours, types, typeOrder }
  const [order, setOrder] = useState([]);     // working copy of the shown/ordered type keys
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.getTicketTaxonomySettings()
    .then((c) => { setCfg(c); setOrder(Array.isArray(c.typeOrder) ? c.typeOrder : null); })
    .catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to view ticket SLA & type settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  const allKeys = Object.keys(TICKET_TYPE_META);
  // null order = "use the compiled-in default order" - shown editable as that
  // default until the admin actually reorders/toggles something.
  const shownOrder = order ?? allKeys.filter((k) => TICKET_TYPE_META[k]);
  const hidden = allKeys.filter((k) => !shownOrder.includes(k));

  const setSla = (k, v) => setCfg((c) => ({ ...c, slaTargetHours: { ...c.slaTargetHours, [k]: Math.max(1, Number(v) || 1) } }));
  const setTypeCfg = (key, patch) => setCfg((c) => ({ ...c, types: { ...c.types, [key]: { ...(c.types[key] || {}), ...patch } } }));
  const toggleShown = (key) => {
    const cur = order ?? allKeys.filter((k) => TICKET_TYPE_META[k]);
    setOrder(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };
  const moveShown = (key, dir) => {
    const cur = (order ?? allKeys.filter((k) => TICKET_TYPE_META[k])).slice();
    const i = cur.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setOrder(cur);
  };

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      const next = await api.updateTicketTaxonomySettings({ slaTargetHours: cfg.slaTargetHours, types: cfg.types, typeOrder: order });
      setCfg(next);
      setOrder(Array.isArray(next.typeOrder) ? next.typeOrder : null);
      await refreshTicketConfig();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Timer size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Ticket SLA & Types</div>
      </div>

      <div style={{ ...card, padding: 18, marginBottom: 18, maxWidth: 560 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>SLA target hours</div>
        <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
          How many hours after a ticket is raised its SLA due date lands, by priority. Changing this here takes effect
          immediately, server-side - no redeploy.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {PRIORITIES.map(([k, lab]) => (
            <Field key={k} label={lab} hint={`${(cfg.slaTargetHours[k] / 24).toFixed(1)} days`}>
              <input type="number" min={1} value={cfg.slaTargetHours[k]} onChange={(e) => setSla(k, e.target.value)} style={inputStyle} />
            </Field>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <ListTree size={15} style={{ color: NX.dim }} />
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Ticket types & intake questions</div>
      </div>
      <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
        Label, hint, intake order/visibility, and the questions each type asks are all editable. A retired question
        stays on tickets that already answered it - it just stops being asked. Icon and color aren't editable here.
      </div>

      {shownOrder.map((key, i) => TICKET_TYPE_META[key] && (
        <TypeRow key={key} typeKey={key} meta={TICKET_TYPE_META[key]} shown
          onToggleShown={() => toggleShown(key)}
          canMoveUp={i > 0} canMoveDown={i < shownOrder.length - 1} onMove={(dir) => moveShown(key, dir)}
          typeCfg={cfg.types[key] || {}} onChangeType={(patch) => setTypeCfg(key, patch)} />
      ))}

      {hidden.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, letterSpacing: '.04em', margin: '16px 0 8px' }}>
            NOT SHOWN AT INTAKE (still usable for existing tickets)
          </div>
          {hidden.map((key) => TICKET_TYPE_META[key] && (
            <TypeRow key={key} typeKey={key} meta={TICKET_TYPE_META[key]} shown={false}
              onToggleShown={() => toggleShown(key)}
              canMoveUp={false} canMoveDown={false} onMove={() => {}}
              typeCfg={cfg.types[key] || {}} onChangeType={(patch) => setTypeCfg(key, patch)} />
          ))}
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button onClick={save} disabled={saving} style={{ ...btn('primary'), display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={load} disabled={saving} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <RotateCcw size={14} /> Discard changes
        </button>
        {saved && <span style={{ color: NX.green, fontSize: 12.5, fontWeight: 600 }}>Saved.</span>}
        {err && <span style={{ color: NX.red, fontSize: 12.5, fontWeight: 600 }}>{err}</span>}
      </div>
    </div>
  );
}
