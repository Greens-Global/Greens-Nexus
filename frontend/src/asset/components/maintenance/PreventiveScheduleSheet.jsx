// A preventive maintenance schedule on a property (Construction plan phase 5,
// Neil 11/03/2026) - the recurring service, set up straight here instead of
// from a resolved ticket. Fixed dates (every month on the 1st, weekly on
// Monday, quarterly), after each completion (the next one N days after the
// last ticket closes), or by meter (a vehicle's odometer, an equipment's hour
// meter). Each due occurrence files ONE ticket for the team, with this
// checklist (backend maintenance_services.py). Saved through the property
// ticket endpoints - nothing here writes the Asset Management workspace.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../../api.js';
import { DateField } from '../../../tasks/components';
import { Modal } from '../shared/Modal.jsx';
import { presetDue } from '../../lib/pmSchedule.js';

const KINDS = [['calendar', 'Fixed Dates'], ['floating', 'After Each Completion'], ['meter', 'By Meter']];
const UNITS = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
const PRIORITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']];

function fromService(s) {
  return {
    kind: s?.kind || 'calendar', subject: s?.subject || '', description: s?.description || '',
    priority: s?.priority || 'medium', application: s?.application || '', departmentId: s?.departmentId || '',
    location: s?.location || '', assigneeEmail: s?.assigneeEmail || '', assetId: s?.assetId || '',
    checklist: s?.checklist?.length ? [...s.checklist] : [''], leadDays: s?.leadDays ?? 7,
    unit: s?.recurrenceUnit || 'month', every: s?.recurrenceEvery || 1, nextDue: s?.nextDue || '',
    meterEvery: s?.meterEvery || '', meterNext: s?.meterNext || '',
  };
}

const lbl = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' };

export default function PreventiveScheduleSheet({ propertyId, svc = null, onClose, onSaved }) {
  const [v, setV] = useState(() => fromService(svc));
  const [opts, setOpts] = useState(null);
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  useEffect(() => {
    let live = true;
    api.getPmScheduleOptions(propertyId).then((o) => {
      if (!live) return;
      setOpts(o);
      setV((x) => (x.departmentId || o.departments.length !== 1 ? x : { ...x, departmentId: o.departments[0].id }));
      if (o.canAssign) api.getPeopleDirectory().then((p) => { if (live) setPeople(Array.isArray(p) ? p : []); }).catch(() => {});
    }).catch((e) => { if (live) setErr(e?.message || 'The schedule options could not load.'); });
    return () => { live = false; };
  }, [propertyId]);
  const equipment = useMemo(() => opts?.equipment || [], [opts]);
  const asset = useMemo(() => equipment.find((e) => e.id === v.assetId) || null, [equipment, v.assetId]);
  const meterUnit = asset?.kind === 'vehicle' ? 'mi' : 'h';
  const units = opts?.units?.units || [];

  const body = () => {
    const out = {
      kind: v.kind, subject: v.subject.trim(), description: v.description, priority: v.priority,
      application: v.application, hr_department_id: v.departmentId, location: v.location,
      asset_id: v.assetId, checklist: v.checklist.map((c) => c.trim()).filter(Boolean),
      lead_days: Number(v.leadDays) || 0,
    };
    if (opts?.canAssign) out.assignee_email = v.assigneeEmail;
    if (svc && !svc.active) out.active = true;   // saving a stopped schedule restarts it
    if (v.kind === 'meter') {
      out.meter_every = Number(v.meterEvery) || 0;
      if (v.meterNext !== '' && v.meterNext != null) out.meter_next = Number(v.meterNext);
    } else {
      out.recurrence_unit = v.unit; out.recurrence_every = Number(v.every) || 1;
      if (!svc || v.nextDue !== svc.nextDue || v.kind !== svc.kind) out.next_due = v.nextDue;
    }
    return out;
  };
  const missing = !v.subject.trim() ? 'Give the schedule a name.'
    : !v.departmentId ? 'Pick the team that does the work.'
      : v.kind === 'meter' ? (!v.assetId ? 'Pick the vehicle or equipment.' : !(Number(v.meterEvery) > 0) ? 'Say how often by the meter.' : '')
        : (!v.nextDue && (!svc || v.kind !== svc.kind || svc.nextDue)) ? 'Pick the first due date.' : '';
  const save = async () => {
    if (missing) { setErr(missing); return; }
    setBusy(true); setErr('');
    try {
      if (svc) await api.updateMaintenanceService(propertyId, svc.id, { ...body(), rev: svc.rev || '' });
      else await api.createPmSchedule(propertyId, body());
      onSaved?.();
    } catch (e) { setErr(e?.message || 'The schedule did not save.'); setBusy(false); }
  };

  return (
    <Modal title={svc ? `Edit Schedule · ${svc.subject}` : 'New Preventive Schedule'} onClose={onClose} isDirty
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy || !opts}>{busy ? 'Saving...' : 'Save Schedule'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={lbl}>Name
          <input className="form-input" value={v.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={200}
            placeholder="HVAC Filter Change" aria-label="Name" />
        </label>
        <div style={lbl}>
          How It Repeats
          <div role="radiogroup" aria-label="How It Repeats" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 4, borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', alignSelf: 'flex-start' }}>
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={v.kind === k} onClick={() => set({ kind: k })}
                style={{ border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
                  background: v.kind === k ? 'var(--bg-card)' : 'transparent', boxShadow: v.kind === k ? 'var(--shadow-sm)' : 'none',
                  color: v.kind === k ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{label}</button>
            ))}
          </div>
          <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
            {v.kind === 'calendar' ? 'Due on set dates, whether or not the last one is done.'
              : v.kind === 'floating' ? 'The next one is due a set time after the last ticket is done.'
                : 'Due each time the reading passes the next mark.'}
          </span>
        </div>

        {v.kind !== 'meter' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <label style={lbl}>Every
              <span style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" type="number" min={1} max={365} value={v.every} onChange={(e) => set({ every: e.target.value })} style={{ width: 80 }} aria-label="Every" />
                <select className="form-input" value={v.unit} onChange={(e) => set({ unit: e.target.value })} aria-label="Repeat Unit">
                  {UNITS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </span>
            </label>
            <div style={lbl}>{v.kind === 'floating' && svc?.waitingOnCompletion ? 'Next Due (after the open ticket)' : 'First Due'}
              <DateField value={v.nextDue} onChange={(d) => set({ nextDue: d || '' })} noPast />
            </div>
            {v.kind === 'calendar' && (
              <div style={{ ...lbl, gridColumn: '1 / -1' }}>Quick Picks
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[['monthly1', 'Every Month on the 1st'], ['mondays', 'Weekly on Monday'], ['quarterly', 'Quarterly']].map(([k, l]) => (
                    <button key={k} type="button" className="secondary-btn" onClick={() => set(presetDue(k))}>{l}</button>
                  ))}
                </span>
              </div>
            )}
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={lbl}>{v.kind === 'meter' ? 'Vehicle or Equipment' : 'Equipment (Optional)'}
            <select className="form-input" value={v.assetId} onChange={(e) => set({ assetId: e.target.value })} aria-label="Equipment">
              <option value="">{v.kind === 'meter' ? 'Pick One' : 'The Property Itself'}</option>
              {equipment.map((e) => <option key={e.id} value={e.id}>{e.name}{e.readingLabel ? ` (${e.readingLabel})` : ''}</option>)}
            </select>
          </label>
          {v.kind === 'meter' && (<>
            <label style={lbl}>Every ({meterUnit === 'mi' ? 'Miles' : 'Hours'})
              <input className="form-input" type="number" min={1} value={v.meterEvery} onChange={(e) => set({ meterEvery: e.target.value })} aria-label="Meter Every" />
            </label>
            <label style={lbl}>Next At ({meterUnit})
              <input className="form-input" type="number" min={0} value={v.meterNext} onChange={(e) => set({ meterNext: e.target.value })}
                placeholder={asset?.reading != null && v.meterEvery ? String(Number(asset.reading) + Number(v.meterEvery)) : ''} aria-label="Next At" />
              <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{asset?.readingLabel ? `Reads ${asset.readingLabel} now, from its Asset Management record.` : 'No reading on its record yet - log one in Records.'}</span>
            </label>
          </>)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={lbl}>Team
            <select className="form-input" value={v.departmentId} onChange={(e) => set({ departmentId: e.target.value })} aria-label="Team">
              <option value="">Pick One</option>
              {(opts?.departments || []).map((d) => <option key={d.id} value={d.id}>{d.companyName ? `${d.name} (${d.companyName})` : d.name}</option>)}
            </select>
          </label>
          <label style={lbl}>Topic
            <select className="form-input" value={v.application} onChange={(e) => set({ application: e.target.value })} aria-label="Topic">
              <option value="">General</option>
              {(opts?.topics || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>
          {opts?.canAssign && (
            <label style={lbl}>Assign To
              <select className="form-input" value={v.assigneeEmail} onChange={(e) => set({ assigneeEmail: e.target.value })} aria-label="Assign To">
                <option value="">The Team's Default</option>
                {people.map((p) => <option key={p.email} value={(p.email || '').toLowerCase()}>{p.name || p.email}</option>)}
              </select>
            </label>
          )}
          <label style={lbl}>Priority
            <select className="form-input" value={v.priority} onChange={(e) => set({ priority: e.target.value })} aria-label="Priority">
              {PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {units.length > 0 && (
            <label style={lbl}>Where
              <select className="form-input" value={v.location} onChange={(e) => set({ location: e.target.value })} aria-label="Where">
                <option value="">Common Area</option>
                {units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
          )}
          {v.kind !== 'meter' && (
            <label style={lbl}>Open the Ticket
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                <input className="form-input" type="number" min={0} max={60} value={v.leadDays} onChange={(e) => set({ leadDays: e.target.value })} style={{ width: 80 }} aria-label="Days Early" />
                days before it is due
              </span>
            </label>
          )}
        </div>

        <div style={lbl}>Checklist
          {v.checklist.map((c, i) => (
            <span key={i} style={{ display: 'flex', gap: 6 }}>
              <input className="form-input" value={c} placeholder={i === 0 ? 'Change the filter' : 'Another step'} aria-label={`Step ${i + 1}`}
                onChange={(e) => set({ checklist: v.checklist.map((x, j) => (j === i ? e.target.value : x)) })} />
              <button type="button" className="secondary-btn" aria-label={`Remove step ${i + 1}`} onClick={() => set({ checklist: v.checklist.filter((_, j) => j !== i).concat(v.checklist.length === 1 ? [''] : []) })}><Trash2 size={14} /></button>
            </span>
          ))}
          <button type="button" className="secondary-btn" onClick={() => set({ checklist: [...v.checklist, ''] })} style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add a Step</button>
        </div>
        <label className="nx-fill" style={lbl}>Details
          <textarea className="form-input" rows={4} value={v.description} onChange={(e) => set({ description: e.target.value })} placeholder="What the technician should know." aria-label="Details" style={{ minHeight: 90 }} />
        </label>
        {err && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13 }}>{err}</div>}
      </div>
    </Modal>
  );
}
