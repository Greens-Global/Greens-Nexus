// Ticket SLA & Types - admin config for the two things that used to be
// hardcoded constants an engineer had to edit and redeploy to change
// (Sep 2026 - see the Admin module audit, Tier 2 items "Ticket SLA targets
// per priority" and "Ticket types & intake questions"). Manager+ only,
// mirroring the backend's require_manager gate on these endpoints - this UI
// hides the controls, the backend is the real boundary.
//
// A type's KEY, icon and color stay defined in ticketMeta.js (compiled-in
// React components/tokens aren't JSON) - this only overrides label, hint,
// whether/where it shows at intake, its intake field list, and whether new
// tickets of it require approval. Adding a brand-new type with a new icon is
// still a code change.
//
// Saving here calls refreshTicketConfig() (ticketConfig.js) so every
// already-open ticket screen picks up the change immediately, the same way
// TicketDeskSettings/TicketNotifySettings's saves take effect live.
import { useEffect, useMemo, useState } from 'react';
import { LoadingState } from '../components/AsyncState';
import { ListTree, Building2, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import SaveRow from '../components/SaveRow';
import SavedCheck from '../components/SavedCheck';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import { TICKET_TYPE_META, TICKET_TYPE_KEYS, TICKET_TYPE_ORDER, FIRST_RESPONSE_HOURS } from './ticketMeta';
import DragList from './DragList';
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

function Toggle({ on, onChange, title, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={onChange} disabled={disabled}
      title={title || (on ? 'Enabled' : 'Disabled')} style={{
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
      <DragList items={fields} getKey={(f) => f.key} onReorder={onChange} label="question" gap={8}
        renderItem={(f, handle, i) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 9, border: `1px solid ${NX.border}`, background: NX.surface, opacity: f.retired ? 0.55 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {handle}
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
      )} />
      {adding ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New question label"
            style={{ ...inputStyle, flex: 1 }} onKeyDown={(e) => e.key === 'Enter' && addField()} autoFocus />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={{ ...inputStyle, width: 140 }}>
            {FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button onClick={addField} style={{ ...btn('primary'), padding: '7px 12px' }}>Add</button>
          <button onClick={() => { setAdding(false); setNewLabel(''); }} style={{ ...btn('ghost'), padding: '7px 12px' }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '6px 10px', marginTop: 8 }}>
          <Plus size={13} /> Add Question
        </button>
      )}
    </div>
  );
}

// One type. `form` is the draft half (label, hint, questions); `shown` and
// `requiresApproval` are switches that save on click.
function TypeRow({ typeKey, meta, shown, onToggleShown, handle = null, form, requiresApproval, onToggleApproval, onChangeForm, busy = false }) {
  const [open, setOpen] = useState(false);
  const Icon = meta.icon;
  const { label, hint, fields } = form;

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        {/* Intake order is dragged by the grip; types not shown at intake
            have no order to set, so no grip. */}
        {handle || <span style={{ width: 19, flexShrink: 0 }} />}
        <Icon size={16} style={{ color: meta.color, flexShrink: 0 }} />
        <input value={label} aria-label={`${meta.label} label`} onChange={(e) => onChangeForm({ label: e.target.value })} style={{ ...inputStyle, width: 200 }} />
        <input value={hint} aria-label={`${meta.label} hint`} onChange={(e) => onChangeForm({ hint: e.target.value })} placeholder="Hint shown under the type picker"
          style={{ ...inputStyle, flex: 1 }} />
        <label title="Shown at intake" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: NX.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>
          <Toggle on={shown} onChange={onToggleShown} label={`Offered on Submit a Ticket: ${meta.label}`} disabled={busy}
            title={shown ? 'On - offered on Submit a Ticket' : 'Off - not offered on Submit a Ticket'} /> Intake
        </label>
        <button onClick={() => setOpen((o) => !o)} style={{ ...btn('ghost'), display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 10px', whiteSpace: 'nowrap' }}>
          {fields.length} {fields.length === 1 ? 'Question' : 'Questions'} {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {/* Approval switch (Sep 2026) - read server-side when a ticket is
          created or re-typed; the decision is stored on the ticket, so a
          flip never moves one that already exists. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px 10px 40px', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: NX.ink, fontWeight: 600, whiteSpace: 'nowrap' }}>
          <Toggle on={requiresApproval} onChange={onToggleApproval} disabled={busy}
            label={`Requires Approval: ${meta.label}`} title="Requires Approval" /> Requires Approval
        </label>
        <span style={{ fontSize: 11.5, color: NX.faint }}>
          New tickets of this type wait for an approver's sign-off before they can be assigned. Tickets already raised keep their current state.
        </span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${NX.border}`, padding: '12px 14px', background: NX.surface2 }}>
          <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 8 }}>
            The questions - with their Required and Retired marks - are part of the draft: they save with the Save button below.
          </div>
          <FieldEditor typeKey={typeKey} fields={fields} onChange={(next) => onChangeForm({ fields: next })} />
        </div>
      )}
    </div>
  );
}

const clampHours = (v) => Math.max(1, Math.round(Number(v)) || 1);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const mapHours = (m) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, clampHours(v)]));

// The draft half of the panel, as the server holds it: the SLA boxes (as the
// text they show) and each type's label, hint and intake questions.
function formOf(cfg) {
  if (!cfg) return null;
  const fr = { ...FIRST_RESPONSE_HOURS, ...(cfg.firstResponseHours || {}) };
  return {
    sla: Object.fromEntries(PRIORITIES.map(([k]) => [k, String(cfg.slaTargetHours?.[k] ?? '')])),
    fr: Object.fromEntries(PRIORITIES.map(([k]) => [k, String(fr[k] ?? '')])),
    types: Object.fromEntries(TICKET_TYPE_KEYS.map((k) => {
      const t = cfg.types?.[k] || {};
      return [k, { label: t.label ?? TICKET_TYPE_META[k]?.label ?? '', hint: t.hint ?? (TICKET_TYPE_META[k]?.hint || ''), fields: t.fields ?? [] }];
    })),
  };
}

// One save pattern (Settings, Oct 23 2026): the switches (Intake, Requires
// Approval, the company field and its companies) and the type order save the
// moment they change and go back with the reason when refused; the typed
// half - SLA hours, labels, hints and the intake questions - is a draft with
// one Save row at the foot that sends only what changed.
export default function TicketTaxonomySettings() {
  const { myLevel } = useRole();
  const [cfg, setCfg] = useState(null);       // what the server holds: { slaTargetHours, firstResponseHours, types, typeOrder, companyField }
  const [companies, setCompanies] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);    // a switch is saving
  const [saved, setSaved] = useState(false);  // a switch just saved
  const [err, setErr] = useState('');

  const load = () => api.getTicketTaxonomySettings().then(setCfg).catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([])); }, []);

  const savedForm = useMemo(() => formOf(cfg), [cfg]);
  const { draft, setDraft, dirty, reset } = useDraft(savedForm, { rebase: true });

  // Typed, so it is sent clamped to a whole number of at least 1 - the box
  // keeps what is typed meanwhile (clamping every keystroke turned clearing
  // "48" to retype it into "148").
  const save = async () => {
    if (!dirty || saving) return false;
    const body = {};
    if (!same(draft.sla, savedForm.sla)) body.slaTargetHours = mapHours(draft.sla);
    if (!same(draft.fr, savedForm.fr)) body.firstResponseHours = mapHours(draft.fr);
    const types = {};
    for (const k of TICKET_TYPE_KEYS) {
      // A type's entry replaces wholesale on the server: its saved switches travel with it.
      if (!same(draft.types[k], savedForm.types[k])) types[k] = { ...(cfg.types?.[k] || {}), ...draft.types[k] };
    }
    if (Object.keys(types).length) body.types = types;
    setSaving(true); setErr('');
    try {
      setCfg(await api.updateTicketTaxonomySettings(body));
      await refreshTicketConfig();
      return true;
    } catch (e) {
      setErr(e.message || String(e));
      return false;
    } finally { setSaving(false); }
  };
  useGroupDirty(dirty, save);

  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to view ticket SLA & type settings.
      </div>
    );
  }
  if (!cfg || !draft) return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;

  // A switch: shown at once, saved at once, put back when refused.
  const instant = async (body, shown) => {
    const before = cfg;
    setCfg((c) => shown(c));
    setBusy(true); setErr(''); setSaved(false);
    try {
      setCfg(await api.updateTicketTaxonomySettings(body));
      await refreshTicketConfig();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setCfg(before);
      setErr(`Could not save that change: ${e.message || String(e)}`);
    } finally { setBusy(false); }
  };

  // Only the five types exist (Oct 1) - each listed here, on or off. A saved
  // order naming a retired type (Service Request, Change) just drops it.
  const allKeys = [...TICKET_TYPE_KEYS];
  // null order = nothing saved yet: what intake offers today (the five, in the
  // default order) until the admin actually reorders or switches one.
  const order = Array.isArray(cfg.typeOrder) ? cfg.typeOrder : null;
  const shownOrder = (order ?? [...TICKET_TYPE_ORDER]).filter((k, i, arr) => allKeys.includes(k) && arr.indexOf(k) === i);
  const hidden = allKeys.filter((k) => !shownOrder.includes(k));

  const setOrder = (next) => instant({ typeOrder: next }, (c) => ({ ...c, typeOrder: next }));
  const toggleShown = (key) => {
    const cur = shownOrder;
    if (cur.includes(key) && cur.length === 1) return;   // intake always offers at least one type
    setOrder(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };
  const toggleApproval = (key) => {
    // The server fills the flag in for the default-gated types, so anything
    // without it is off - no default list is repeated here.
    const entry = { ...(cfg.types?.[key] || {}), requiresApproval: cfg.types?.[key]?.requiresApproval !== true };
    instant({ types: { [key]: entry } }, (c) => ({ ...c, types: { ...c.types, [key]: entry } }));
  };
  const setCompanyField = (p) => {
    const next = { ...cfg.companyField, ...p };
    instant({ companyField: next }, (c) => ({ ...c, companyField: next }));
  };
  const toggleCompanyId = (id) => setCompanyField({
    companyIds: cfg.companyField.companyIds.includes(id)
      ? cfg.companyField.companyIds.filter((c) => c !== id)
      : [...cfg.companyField.companyIds, id],
  });

  const setHours = (field, k, raw) => setDraft((d) => ({ ...d, [field]: { ...d[field], [k]: raw } }));
  // Leaving a box with nothing usable in it shows the number it will save
  // (a tidy-up of the draft only - nothing is saved on blur).
  const tidyHours = (field, k) => setDraft((d) => (String(clampHours(d[field][k])) === d[field][k] ? d : { ...d, [field]: { ...d[field], [k]: String(clampHours(d[field][k])) } }));
  const daysHint = (raw) => { const n = Number(raw); return raw !== '' && Number.isFinite(n) && n >= 1 ? `${(Math.round(n) / 24).toFixed(1)} days` : ' '; };
  const setTypeForm = (key, p) => setDraft((d) => ({ ...d, types: { ...d.types, [key]: { ...d.types[key], ...p } } }));
  const rowFor = (key, shown, handle = null) => (
    <TypeRow key={key} typeKey={key} meta={TICKET_TYPE_META[key]} shown={shown} handle={handle} busy={busy}
      onToggleShown={() => toggleShown(key)}
      form={draft.types[key]} requiresApproval={cfg.types?.[key]?.requiresApproval === true}
      onToggleApproval={() => toggleApproval(key)} onChangeForm={(p) => setTypeForm(key, p)} />
  );

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>

      {/* Side by side (Sep 19, Pranshu: "utilize the blank space, move the
          company field intake beside SLA") - SLA's own grid tops out at 4
          narrow number fields, which left the whole right half of the panel
          empty next to it. Both cards keep their own maxWidth so neither
          stretches absurdly wide on an ultra-wide monitor; they wrap to
          stacked full-width on a narrow one since this is a flex row, not a
          fixed 2-up grid. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 18 }}>
        <div style={{ ...card, padding: 18, flex: '1 1 380px', maxWidth: 560 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>SLA Target Hours</div>
          <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
            How many hours after a ticket is raised its SLA due date lands, by priority. Saved here, it takes effect
            immediately, server-side - no redeploy.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {PRIORITIES.map(([k, lab]) => (
              <Field key={k} label={lab} hint={daysHint(draft.sla[k])}>
                <input type="number" min={1} step={1} inputMode="numeric" aria-label={`${lab} SLA hours`}
                  value={draft.sla[k]} onChange={(e) => setHours('sla', k, e.target.value)} onBlur={() => tidyHours('sla', k)} style={inputStyle} />
              </Field>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '16px 0 4px' }}>First Response Target Hours</div>
          <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
            How soon someone other than the requester must reply where the requester can see it. Internal notes do not
            count. Both clocks pause while a ticket is waiting on the requester, and every hour counts.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {PRIORITIES.map(([k, lab]) => (
              <Field key={k} label={lab} hint={draft.fr[k] ? `${draft.fr[k]} hours` : ' '}>
                <input type="number" min={1} step={1} inputMode="numeric" aria-label={`${lab} first response hours`}
                  value={draft.fr[k]} onChange={(e) => setHours('fr', k, e.target.value)}
                  onBlur={() => tidyHours('fr', k)} style={inputStyle} />
              </Field>
            ))}
          </div>
        </div>

        <div style={{ ...card, padding: 18, flex: '1 1 380px', maxWidth: 560 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Building2 size={15} style={{ color: NX.dim }} />
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>Company Field at Intake</div>
          </div>
          <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
            Off by default - a ticket is silently filed under the requester's own company (from their People record),
            same as always. Turn this on to let them pick instead, from whichever companies you enable below. Saves as you change it.
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: NX.ink, fontWeight: 600, marginBottom: cfg.companyField.enabled ? 14 : 0 }}>
            <Toggle on={cfg.companyField.enabled} disabled={busy} label="Let the requester choose the company"
              onChange={() => setCompanyField({ enabled: !cfg.companyField.enabled })} />
            Let the requester choose the company
          </label>
          {cfg.companyField.enabled && (
            companies.length === 0 ? (
              <div style={{ fontSize: 12, color: NX.faint }}>No companies yet. Add one in Settings &gt; Companies first.</div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, letterSpacing: '.04em', marginBottom: 8 }}>OFFERED AT INTAKE</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {companies.map((c) => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: NX.ink, cursor: 'pointer' }}>
                      <input type="checkbox" disabled={busy} checked={cfg.companyField.companyIds.includes(c.id)} onChange={() => toggleCompanyId(c.id)} />
                      {c.name}
                    </label>
                  ))}
                </div>
                {cfg.companyField.companyIds.length === 0 && (
                  <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 8 }}>
                    Nothing checked yet - with none offered, the field stays hidden and every ticket still
                    files under the requester's own company.
                  </div>
                )}
                {cfg.companyField.companyIds.length === 1 && (
                  <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 8 }}>
                    Only one company checked - it's used automatically, no picker shown. Check a second to
                    make it an actual choice.
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <ListTree size={15} style={{ color: NX.dim }} />
        <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>Ticket Types & Intake Questions</div>
        <SavedCheck show={saved} />
      </div>
      <div style={{ fontSize: 12, color: NX.faint, marginBottom: 12 }}>
        The five ticket types. Each one's label, hint, whether it is offered on Submit a Ticket, the order, whether it requires approval
        and the questions it asks are all editable. At least one stays on. A retired question stays on tickets that already answered it -
        it just stops being asked. Icon and color aren't editable here. The Intake and Requires Approval switches and the order save
        as you change them.
      </div>

      {/* Drag the grip to set the order requesters see them in (saved when dropped). */}
      <DragList items={shownOrder} getKey={(k) => k} onReorder={setOrder}
        label="ticket type" gap={10}
        renderItem={(key, handle) => rowFor(key, true, handle)} />

      {hidden.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, letterSpacing: '.04em', margin: '16px 0 8px' }}>
            TURNED OFF (not offered on Submit a Ticket - tickets already raised keep their type)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {hidden.map((key) => TICKET_TYPE_META[key] && rowFor(key, false))}
          </div>
        </>
      )}

      {err && <div role="alert" style={{ color: NX.red, fontSize: 12.5, fontWeight: 600, marginTop: 14 }}>{err}</div>}
      <SaveRow dirty={dirty} busy={saving} onSave={save} onDiscard={reset}
        note="Saves the SLA hours, the type labels and hints, and the intake questions." />
    </div>
  );
}
