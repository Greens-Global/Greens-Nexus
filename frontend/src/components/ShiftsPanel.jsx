import { useState, useEffect } from 'react';
import { Plus, Trash2, Users, Clock, Loader2, X, Check } from 'lucide-react';
import { api } from '../api';

// ── Shifts, groups & bulk assignment ──────────────────────────────────────────
// Define shifts (time + weekdays + grace), bundle people into reusable groups,
// and apply a shift to a whole group (or a hand-picked set) in one click.

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
const BLANK = { name: '', start_hhmm: '09:00', end_hhmm: '17:00', days: '1,2,3,4,5', grace_min: 10, color: '#2563eb' };

function daysLabel(csv) {
  const set = new Set((csv || '').split(',').filter(Boolean));
  const on = DAYS.filter(([n]) => set.has(n)).map(([, l]) => l);
  if (on.length === 5 && !set.has('6') && !set.has('7')) return 'Mon–Fri';
  return on.join(', ') || '—';
}

export default function ShiftsPanel({ people = [], toastOk, toastErr }) {
  const [shifts, setShifts] = useState(null);
  const [groups, setGroups] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [form, setForm] = useState(null);          // shift being created/edited
  const [groupForm, setGroupForm] = useState(null); // {id?, name, members:[]}
  const [assignShift, setAssignShift] = useState('');
  const [assignGroup, setAssignGroup] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.timeShifts().then(r => setShifts(r.shifts)).catch(() => setShifts([]));
    api.timeShiftGroups().then(r => setGroups(r.groups)).catch(() => setGroups([]));
    api.timeShiftAssignments().then(r => setAssignments(r.assignments || {})).catch(() => {});
  };
  useEffect(load, []);

  const nameOf = (email) => {
    const p = people.find(e => (e.workEmail || e.work_email || e.email) === email);
    return p ? (p.name || `${p.firstName || p.first_name || ''} ${p.lastName || p.last_name || ''}`.trim() || email) : email;
  };
  const shiftName = (id) => (shifts || []).find(s => s.id === id)?.name || '—';

  async function saveShift() {
    if (!form.name.trim()) { toastErr('Name the shift.'); return; }
    setBusy(true);
    try {
      if (form.id) await api.timeShiftUpdate(form.id, form);
      else await api.timeShiftCreate(form);
      toastOk('Shift saved.'); setForm(null); load();
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function delShift(id) {
    try { await api.timeShiftDelete(id); toastOk('Shift deleted.'); load(); } catch (e) { toastErr(e?.message || 'Failed.'); }
  }
  async function saveGroup() {
    if (!groupForm.name.trim()) { toastErr('Name the group.'); return; }
    setBusy(true);
    try {
      if (groupForm.id) await api.timeShiftGroupSet(groupForm.id, { name: groupForm.name, members: groupForm.members });
      else await api.timeShiftGroupCreate({ name: groupForm.name, members: groupForm.members });
      toastOk('Group saved.'); setGroupForm(null); load();
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function delGroup(id) {
    try { await api.timeShiftGroupDelete(id); toastOk('Group deleted.'); load(); } catch (e) { toastErr(e?.message || 'Failed.'); }
  }
  async function doAssign() {
    const g = (groups || []).find(x => x.id === assignGroup);
    if (!assignShift || !g) { toastErr('Pick a shift and a group.'); return; }
    if (!g.members.length) { toastErr('That group has no members yet.'); return; }
    setBusy(true);
    try {
      const r = await api.timeShiftAssign({ shift_id: assignShift, emails: g.members });
      toastOk(`Assigned ${shiftName(assignShift)} to ${r.assigned} in ${g.name}.`);
      load();
    } catch (e) { toastErr(e?.message || 'Could not assign.'); }
    setBusy(false);
  }

  const emailOf = (p) => p.workEmail || p.work_email || p.email;
  const chip = (active) => ({ padding: '4px 10px', borderRadius: 8, border: `1px solid ${active ? 'var(--pine)' : 'var(--line)'}`, background: active ? 'hsla(var(--color-green),0.08)' : 'var(--card)', color: active ? 'hsl(var(--color-green))' : 'var(--muted)', fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer', fontFamily: 'Inter,sans-serif' });

  return (
    <div style={{ fontFamily: 'Inter,sans-serif', display: 'grid', gap: 20 }}>
      {/* Shifts */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Clock size={15} style={{ color: 'var(--pine)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Shifts</span>
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={() => setForm({ ...BLANK })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Plus size={12} /> New shift
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {shifts === null && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}
          {shifts && shifts.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No shifts yet.</div>}
          {shifts && shifts.map(s => (
            <div key={s.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <button onClick={() => setForm({ ...s, start_hhmm: s.start, end_hhmm: s.end, grace_min: s.graceMin })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11 }}>Edit</button>
                <button onClick={() => delShift(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c', display: 'flex' }}><Trash2 size={12} /></button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>{s.start}–{s.end} · {daysLabel(s.days)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.graceMin}m grace</div>
            </div>
          ))}
        </div>
      </div>

      {/* Groups */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Users size={15} style={{ color: 'var(--pine)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Groups</span>
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={() => setGroupForm({ name: '', members: [] })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Plus size={12} /> New group
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {groups === null && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}
          {groups && groups.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No groups yet.</div>}
          {groups && groups.map(g => (
            <div key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>{g.name}</span>
                <button onClick={() => setGroupForm({ id: g.id, name: g.name, members: g.members })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11 }}>Edit</button>
                <button onClick={() => delGroup(g.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b91c1c', display: 'flex' }}><Trash2 size={12} /></button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>
                {g.members.length} member{g.members.length === 1 ? '' : 's'}
                {g.members.length > 0 && ` · ${g.members.slice(0, 2).map(nameOf).join(', ')}${g.members.length > 2 ? '…' : ''}`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Assign */}
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 10 }}>Assign a shift to a group</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-input" value={assignShift} onChange={e => setAssignShift(e.target.value)} style={{ fontSize: 12.5, minWidth: 160 }}>
            <option value="">— shift —</option>
            {(shifts || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
          <select className="form-input" value={assignGroup} onChange={e => setAssignGroup(e.target.value)} style={{ fontSize: 12.5, minWidth: 160 }}>
            <option value="">— group —</option>
            {(groups || []).map(g => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}
          </select>
          <button className="primary-btn" onClick={doAssign} disabled={busy} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {busy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Assign
          </button>
        </div>
        {Object.keys(assignments).length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
            {Object.keys(assignments).length} employee{Object.keys(assignments).length === 1 ? '' : 's'} currently on a shift.
          </div>
        )}
      </div>

      {/* Shift create/edit modal */}
      {form && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setForm(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 420, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{form.id ? 'Edit shift' : 'New shift'}</span>
              <button onClick={() => setForm(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <input className="form-input" placeholder="Shift name (e.g. Day shift)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ fontSize: 13 }} />
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={form.start_hhmm} onChange={e => setForm({ ...form, start_hhmm: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={form.end_hhmm} onChange={e => setForm({ ...form, end_hhmm: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                <label style={{ width: 74, fontSize: 11, color: 'var(--muted)' }}>Grace<input type="number" min="0" className="form-input" value={form.grace_min} onChange={e => setForm({ ...form, grace_min: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Days</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DAYS.map(([n, l]) => {
                    const set = new Set(form.days.split(',').filter(Boolean));
                    const on = set.has(n);
                    return <button key={n} style={chip(on)} onClick={() => { on ? set.delete(n) : set.add(n); setForm({ ...form, days: [...set].sort().join(',') }); }}>{l}</button>;
                  })}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="secondary-btn" onClick={() => setForm(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveShift} disabled={busy}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Group create/edit modal */}
      {groupForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setGroupForm(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{groupForm.id ? 'Edit group' : 'New group'}</span>
              <button onClick={() => setGroupForm(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
            </div>
            <input className="form-input" placeholder="Group name (e.g. Warehouse crew)" value={groupForm.name} onChange={e => setGroupForm({ ...groupForm, name: e.target.value })} style={{ fontSize: 13, marginBottom: 12 }} />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Members ({groupForm.members.length})</div>
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 8, display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 80 }}>
              {people.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No employees available.</div>}
              {people.map(p => {
                const em = emailOf(p);
                if (!em) return null;
                const on = groupForm.members.includes(em);
                return <button key={em} style={chip(on)} onClick={() => setGroupForm({ ...groupForm, members: on ? groupForm.members.filter(x => x !== em) : [...groupForm.members, em] })}>{nameOf(em)}</button>;
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="secondary-btn" onClick={() => setGroupForm(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveGroup} disabled={busy}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
