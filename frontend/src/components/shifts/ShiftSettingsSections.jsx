// Settings > Global Settings > Shifts (Charmi, 09/30: "these settings should
// not be here, this should be in our global settings module"). Three
// sections, each self-contained: the shift settings (switches, team time
// zone, week start, reminders, time-off reasons), the Shift Types (the
// presets that used to be Shifts > Presets & Teams) and the Groups (who is
// scheduled together, who schedules them, their Teams chat). Registered in
// views/AdminConsole.jsx GLOBAL_CATEGORIES / GLOBAL_SECTIONS.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X, Check, MessageSquare, Link2, Search, ChevronUp, ChevronDown, Pencil } from 'lucide-react';
import { api } from '../../api';
import { graphTokenSilent, graphTokenInteractive, listMyChats } from '../../teamsGraph';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../UnsavedChangesPrompt';
import { dialog } from '../../ui/dialog';
import { ZONE_GROUPS, zoneOptionLabel } from '../../lib/worldClockZones';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatHHMM } from '../../lib/datetime';
import AsyncSection, { Spinner, SkeletonBlocks } from '../AsyncState';
import { Avatar } from '../ShiftScheduleExtras';
import { SHIFT_COLORS, orderGroups, alpha, DEFAULT_SHIFT_COLOR } from './shiftLib';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
const BLANK = { name: '', code: '', start_hhmm: '09:00', end_hhmm: '17:00', days: '1,2,3,4,5', grace_min: 10, break_min: 0, color: '#2563eb', timezone: 'America/Los_Angeles' };
const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', padding: '3px 0' };
const chip = (active) => ({ padding: '4px 10px', borderRadius: 999, border: `1px solid ${active ? 'transparent' : 'var(--wk-line2)'}`, background: active ? 'var(--wk-brand-tint)' : 'var(--card)', color: active ? 'var(--wk-brand)' : 'var(--muted)', fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer', fontFamily: 'inherit' });

function daysLabel(csv) {
  const set = new Set((csv || '').split(',').filter(Boolean));
  const on = DAYS.filter(([n]) => set.has(n)).map(([, l]) => l);
  if (on.length === 5 && !set.has('6') && !set.has('7')) return 'Mon-Fri';
  return on.join(', ') || '-';
}
const emailOf = (p) => (p.workEmail || p.work_email || p.email || '').toLowerCase();
const ZonePick = ({ value, onChange, label }) => (
  <select className="form-input" aria-label={label} value={value || 'America/Los_Angeles'} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px', maxWidth: '100%' }}>
    {Object.entries(ZONE_GROUPS).map(([region, zones]) => (
      <optgroup key={region} label={region}>{zones.map((tz) => <option key={tz} value={tz}>{zoneOptionLabel(tz)}</option>)}</optgroup>
    ))}
  </select>
);

// ── Shift settings ───────────────────────────────────────────────────────
const SWITCHES = [
  ['openShifts', 'Staff can request open shifts'], ['swaps', 'Staff can swap shifts with teammates'], ['offers', 'Staff can offer their shifts to teammates'],
  ['timeOffRequests', 'Staff can request time off'],
  ['teamSchedules', "Staff can see their group's shifts in My Shifts"],
  ['teamShiftDetails', "Staff can see the notes, activities and breaks on teammates' shifts"],
  ['teamTimeOffReasons', 'Staff can see why a teammate is off, and their note'],
];
export function ShiftSettingsPanel({ toastOk, toastErr }) {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    api.shiftRequestSettingsGet()
      .catch(() => api.shiftRequestsInbox().then((r) => r?.settings))   // an older API has no GET
      .then((r) => { if (live) setCfg(r || {}); })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the settings.'); });
    return () => { live = false; };
  }, [tick]);
  async function save(next) {
    const before = cfg;
    setCfg(next);
    try { setCfg(await api.shiftRequestSettingsSave(next)); toastOk?.('Shift settings saved.'); }
    catch (e) { toastErr?.(e.message || 'Could not save the settings.'); setCfg(before); }
  }
  return (
    <AsyncSection loading={!cfg && !error} error={!!error} onRetry={() => setTick((t) => t + 1)} errorMessage="The shift settings could not be loaded right now." skeleton={<SkeletonBlocks count={3} height={36} borderRadius={8} />}>
      {cfg && (
        <div style={{ display: 'grid', gap: 14, fontFamily: 'Inter,sans-serif' }}>
          <div>
            <div style={LBL}>Requests And Visibility</div>
            {SWITCHES.map(([k, text]) => (
              <label key={k} style={CHECK}><input type="checkbox" checked={cfg[k] !== false} onChange={(e) => save({ ...cfg, [k]: e.target.checked })} /> {text}</label>
            ))}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Every request still needs a manager's approval. Turning one off stops new requests of that kind. A confidential time-off reason is never shown to teammates.</div>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Team Time Zone</span>
              <ZonePick label="Team time zone" value={cfg.timeZone} onChange={(v) => save({ ...cfg, timeZone: v })} />
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>What a shift with no shift type runs on, and what a new shift type starts with.</span>
            </label>
            <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Week Starts On</span>
              <select className="form-input" aria-label="Week starts on" value={cfg.weekStart === 'sunday' ? 'sunday' : 'monday'} onChange={(e) => save({ ...cfg, weekStart: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px' }}>
                <option value="monday">Monday</option>
                <option value="sunday">Sunday</option>
              </select>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>The first column of every schedule grid.</span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.reminders !== false} onChange={(e) => save({ ...cfg, reminders: e.target.checked })} /> Remind staff before a scheduled shift
            </label>
            <select className="form-input" aria-label="Reminder lead time" disabled={cfg.reminders === false} value={cfg.reminderLeadMinutes || 60}
              onChange={(e) => save({ ...cfg, reminderLeadMinutes: Number(e.target.value) })} style={{ width: 'auto', fontSize: 12.5, padding: '3px 30px 3px 8px' }}>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`} before</option>)}
            </select>
          </div>
          <TimeOffReasons toastOk={toastOk} toastErr={toastErr} />
        </div>
      )}
    </AsyncSection>
  );
}

// Custom time-off reasons (e.g. "Jury Duty") next to the built-in ones.
function TimeOffReasons({ toastOk, toastErr }) {
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let live = true;
    api.timeOffTypes().then((r) => { if (live) setList(r.custom || []); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  async function save(next) {
    try { const r = await api.timeOffTypesSave({ custom: next }); setList(r.custom); setDraft(''); toastOk?.('Time-off reasons saved.'); }
    catch (e) { toastErr?.(e.message || 'Could not save the reasons.'); }
  }
  if (!list) return null;
  const add = () => { const v = draft.trim(); if (v) save([...list, v]); };
  return (
    <div>
      <div style={LBL}>Time-Off Reasons</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 6 }}>Vacation, Sick, Personal, Unpaid, 1/2 Day and Other are built in. Add the company's own.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {list.map((r) => (
          <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, border: '1px solid var(--line)', borderRadius: 999, padding: '2px 4px 2px 10px' }}>
            {r}
            <button type="button" aria-label={`Remove ${r}`} onClick={() => save(list.filter((x) => x !== r))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: 2 }}><X size={12} /></button>
          </span>
        ))}
        <input className="form-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Jury Duty" aria-label="New time-off reason"
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ width: 150, fontSize: 12.5, padding: '3px 8px' }} />
        <button type="button" className="secondary-btn" onClick={add} disabled={!draft.trim()} style={{ fontSize: 12 }}>Add Reason</button>
      </div>
    </div>
  );
}

// ── Shift Types ──────────────────────────────────────────────────────────
// A shift type is a reusable shift: name, code, color, times, zone and days.
export function ShiftTypesPanel({ toastOk, toastErr }) {
  const [shifts, setShifts] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [defaultTz, setDefaultTz] = useState(BLANK.timezone);
  useEffect(() => {
    let live = true;
    setError(null);
    api.timeShifts().then((r) => { if (live) { setShifts(r.shifts || []); if (r.defaultTimezone) setDefaultTz(r.defaultTimezone); } })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the shift types.'); });
    return () => { live = false; };
  }, [tick]);
  const reload = () => setTick((t) => t + 1);

  async function save() {
    if (!form.name.trim()) { toastErr?.('Name the shift type.'); return; }
    setBusy(true);
    try {
      if (form.id) await api.timeShiftUpdate(form.id, form); else await api.timeShiftCreate(form);
      toastOk?.('Shift type saved.'); setForm(null); reload();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function remove(s) {
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const bits = [];
    if (s.placed) bits.push(`${n(s.placed, 'shift', 'shifts')} already on the schedule ${s.placed === 1 ? 'stays' : 'stay'}, with this shift type's color and name`);
    if (s.assigned) bits.push(`${n(s.assigned, 'person loses', 'people lose')} it as their usual hours`);
    const ok = await dialog.confirm(`Delete the shift type "${s.name}"? This can't be undone.${bits.length ? ` ${bits.join('; ')}.` : ''}`, { title: 'Delete Shift Type', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.timeShiftDelete(s.id); toastOk?.('Shift type deleted.'); reload(); } catch (e) { toastErr?.(e?.message || 'Could not delete the shift type.'); }
  }
  const baseline = useRef(null);
  useEffect(() => { baseline.current = form || null; }, [!!form]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!form && baseline.current !== null && JSON.stringify(form) !== JSON.stringify(baseline.current);
  const guard = useUnsavedGuard(dirty, () => setForm(null), save);

  return (
    <AsyncSection loading={!shifts && !error} error={!!error} onRetry={reload} errorMessage="The shift types could not be loaded right now." skeleton={<SkeletonBlocks count={2} height={64} borderRadius={10} />}>
      <div style={{ fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>The shifts a manager places with one click. A person's usual hours are one of these.</span>
          <button type="button" className="secondary-btn" onClick={() => setForm({ ...BLANK, timezone: defaultTz })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> New Shift Type</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {shifts?.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No shift types yet.</div>}
          {(shifts || []).map((s) => (
            <div key={s.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', borderLeft: `4px solid ${s.color || DEFAULT_SHIFT_COLOR}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {s.code && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--ink)', background: alpha(s.color || DEFAULT_SHIFT_COLOR, 0.14), borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}>{s.code}</span>}
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <button type="button" onClick={() => setForm({ ...s, start_hhmm: s.start, end_hhmm: s.end, grace_min: s.graceMin, break_min: s.breakMin || 0 })} aria-label={`Edit shift type ${s.name}`} title="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><Pencil size={12} /></button>
                <button type="button" onClick={() => remove(s)} aria-label={`Delete shift type ${s.name}`} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex' }}><Trash2 size={12} /></button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>{formatHHMM(s.start)} - {formatHHMM(s.end)} · {daysLabel(s.days)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.graceMin}m grace{s.breakMin ? ` · ${s.breakMin}m unpaid break` : ''} · {zoneOptionLabel(s.timezone || 'America/Los_Angeles')}</div>
            </div>
          ))}
        </div>

        {form && (
          <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && guard.requestClose()}>
            <div role="dialog" aria-label={form.id ? 'Edit Shift Type' : 'New Shift Type'} style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 'clamp(420px, 60vw, 700px)', padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{form.id ? 'Edit Shift Type' : 'New Shift Type'}</span>
                <button type="button" onClick={guard.requestClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <input className="form-input" placeholder="Name (e.g. Day Shift)" aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ fontSize: 13, flex: 1 }} />
                  <input className="form-input" placeholder="Code" aria-label="Code" value={form.code} maxLength={12} onChange={(e) => setForm({ ...form, code: e.target.value })} style={{ fontSize: 13, width: 90 }} title="Short label shown on the schedule (e.g. GSV)" />
                </div>
                <div>
                  <div style={LBL}>Color</div>
                  <div style={{ display: 'flex', gap: 7 }}>
                    {SHIFT_COLORS.map((c) => (
                      <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={form.color === c} onClick={() => setForm({ ...form, color: c })}
                        style={{ width: 24, height: 24, borderRadius: 7, background: c, cursor: 'pointer', border: form.color === c ? '2px solid var(--ink)' : '2px solid transparent' }} />
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <label style={{ flex: 1, minWidth: 110, fontSize: 11, color: 'var(--muted)' }}>Start<input type="time" className="form-input" value={form.start_hhmm} onChange={(e) => setForm({ ...form, start_hhmm: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                  <label style={{ flex: 1, minWidth: 110, fontSize: 11, color: 'var(--muted)' }}>End<input type="time" className="form-input" value={form.end_hhmm} onChange={(e) => setForm({ ...form, end_hhmm: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                  <label style={{ width: 80, fontSize: 11, color: 'var(--muted)' }}>Grace (min)<input type="number" min="0" className="form-input" value={form.grace_min} onChange={(e) => setForm({ ...form, grace_min: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                  <label style={{ width: 110, fontSize: 11, color: 'var(--muted)' }} title="Unpaid minutes inside the shift, e.g. a 30-minute lunch. Scheduled hours are shown without it.">Unpaid break (min)<input type="number" min="0" max="480" step="5" className="form-input" value={form.break_min ?? 0} onChange={(e) => setForm({ ...form, break_min: e.target.value })} style={{ width: '100%', fontSize: 13 }} /></label>
                </div>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 4 }}>
                  Time zone this shift runs on
                  <ZonePick label="Shift type time zone" value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} />
                  <span style={{ fontSize: 10.5, fontWeight: 400 }}>Start and end above are this zone's local time - reminders, the daily briefing and Late status fire against it.</span>
                </label>
                <div>
                  <div style={LBL}>Days</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {DAYS.map(([n, l]) => {
                      const set = new Set(form.days.split(',').filter(Boolean));
                      const on = set.has(n);
                      return <button key={n} type="button" aria-pressed={on} style={chip(on)} onClick={() => { if (on) set.delete(n); else set.add(n); setForm({ ...form, days: [...set].sort().join(',') }); }}>{l}</button>;
                    })}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button type="button" className="secondary-btn" onClick={() => setForm(null)}>Cancel</button>
                <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? <Spinner size={13} /> : 'Save'}</button>
              </div>
            </div>
          </div>
        )}
        {guard.confirming && <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={() => setForm(null)} onSave={guard.saveAndClose} saving={guard.saving || busy} />}
      </div>
    </AsyncSection>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────
// Who is scheduled together, who may build their schedule, and the Teams
// chat their BOD / EOD messages go to. Members come from the curated Nexus
// People list.
export function ShiftGroupsPanel({ toastOk, toastErr }) {
  const nameOf = useNameResolver();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [people, setPeople] = useState([]);
  const [canGroups, setCanGroups] = useState(true);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chatList, setChatList] = useState(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    setError(null);
    api.timeShiftGroups().then((r) => { if (live) { setGroups(orderGroups(r.groups || [])); setCanGroups(r.canManageGroups !== false); } })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the groups.'); });
    api.getPeopleDirectory().then((rows) => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => {});
    return () => { live = false; };
  }, [tick]);
  const reload = () => setTick((t) => t + 1);
  const who = (email) => { const p = people.find((x) => emailOf(x) === (email || '').toLowerCase()); return nameOf(email, p?.name); };
  const directory = useMemo(() => people.filter((p) => emailOf(p)).map((p) => ({ email: emailOf(p), name: nameOf(emailOf(p), p.name), photoUrl: p.photoUrl || p.photo_url || '' })).sort((a, b) => a.name.localeCompare(b.name)), [people, nameOf]);

  async function loadChatOptions() {
    setChatLoading(true);
    let serverReason = '';
    try {
      const r = await api.timeMyChats();
      if (r?.chats?.length) { setChatList(r.chats); setChatLoading(false); return; }
      serverReason = r?.reason || 'no chats returned';
    } catch (e) { serverReason = e?.message || 'request failed'; }
    try {
      const tok = (await graphTokenSilent()) || (await graphTokenInteractive());
      setChatList(await listMyChats(tok));
    } catch (e) {
      toastErr?.(`Could not load your Teams chats - ${serverReason}; Microsoft sign-in: ${e?.errorCode || e?.message || 'failed'}.`);
      setChatList([]);
    }
    setChatLoading(false);
  }
  async function save() {
    if (!form.name.trim()) { toastErr?.('Name the group.'); return; }
    setBusy(true);
    const payload = { name: form.name, members: form.members, schedulers: form.schedulers || [], teams_chat_id: form.teamsChatId || '', teams_chat_name: form.teamsChatName || '' };
    try {
      if (form.id) await api.timeShiftGroupSet(form.id, payload); else await api.timeShiftGroupCreate(payload);
      toastOk?.('Group saved.'); setForm(null); reload();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function remove(g) {
    const ok = await dialog.confirm(`Delete the group "${g.name}"? This can't be undone. Its ${g.members.length} member${g.members.length === 1 ? '' : 's'} keep their shifts, `
      + `but leave the group grid${g.chatId ? ', and their BOD / EOD messages stop going to its Teams chat' : ''}.`, { title: 'Delete Group', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.timeShiftGroupDelete(g.id); toastOk?.('Group deleted.'); reload(); } catch (e) { toastErr?.(e?.message || 'Could not delete the group.'); }
  }
  async function move(i, d) {
    const ids = groups.map((g) => g.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    setGroups(ids.map((id) => groups.find((g) => g.id === id)));
    try { await api.timeShiftGroupOrder(ids).catch((e) => (e?.status === 404 ? api.timeShiftGroupReorder(ids) : Promise.reject(e))); toastOk?.('Group order saved.'); }
    catch (e) { toastErr?.(e?.message || 'Could not save the order.'); reload(); }
  }
  const baseline = useRef(null);
  useEffect(() => { baseline.current = form || null; }, [!!form]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!form && baseline.current !== null && JSON.stringify(form) !== JSON.stringify(baseline.current);
  const guard = useUnsavedGuard(dirty, () => setForm(null), save);
  const openForm = (g) => { setChatList(null); setQ(''); setForm(g ? { id: g.id, name: g.name, members: g.members, schedulers: g.schedulers || [], teamsChatId: g.chatId || '', teamsChatName: g.chatName || '' } : { name: '', members: [], schedulers: [], teamsChatId: '', teamsChatName: '' }); };
  const toggleMember = (em) => setForm((f) => ({ ...f, members: f.members.includes(em) ? f.members.filter((x) => x !== em) : [...f.members, em] }));
  const listed = directory.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <AsyncSection loading={!groups && !error} error={!!error} onRetry={reload} errorMessage="The groups could not be loaded right now." skeleton={<SkeletonBlocks count={2} height={64} borderRadius={10} />}>
      <div style={{ fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>People scheduled together. The order here is the order on the schedule.</span>
          {canGroups ? (
            <button type="button" className="secondary-btn" onClick={() => openForm(null)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> New Group</button>
          ) : <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Groups are changed by an administrator</span>}
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {groups?.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No groups yet.</div>}
          {(groups || []).map((g, i) => (
            <div key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {canGroups && (
                <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${g.name} up`} style={{ padding: 2 }}><ChevronUp size={13} /></button>
                  <button type="button" className="icon-btn" disabled={i === groups.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${g.name} down`} style={{ padding: 2 }}><ChevronDown size={13} /></button>
                </span>
              )}
              <span style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{g.name}{g.archived ? ' (Archived)' : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {g.members.length} member{g.members.length === 1 ? '' : 's'}{g.members.length > 0 && ` · ${g.members.slice(0, 3).map(who).join(', ')}${g.members.length > 3 ? '…' : ''}`}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5, color: g.chatId ? 'var(--wk-brand)' : 'var(--muted)' }}>
                  <MessageSquare size={12} /> {g.chatId ? (g.chatName || 'Chat bound') : 'No chat bound'}
                </div>
              </span>
              {canGroups && <button type="button" className="secondary-btn" onClick={() => openForm(g)} style={{ fontSize: 12 }}>Edit</button>}
              {canGroups && <button type="button" onClick={() => remove(g)} aria-label={`Delete group ${g.name}`} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex' }}><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>

        {form && (
          <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && guard.requestClose()}>
            <div role="dialog" aria-label={form.id ? 'Edit Group' : 'New Group'} style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 'clamp(460px, 60vw, 760px)', padding: 20, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{form.id ? 'Edit Group' : 'New Group'}</span>
                <button type="button" onClick={guard.requestClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
              </div>
              <input className="form-input" placeholder="Group name (e.g. Construction)" aria-label="Group name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ fontSize: 13, marginBottom: 12 }} />
              <div style={{ ...LBL, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1 }}>Members ({form.members.length})</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {form.members.map((em) => <button key={em} type="button" style={chip(true)} aria-label={`Remove ${who(em)}`} onClick={() => toggleMember(em)}>{who(em)} ×</button>)}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px', marginBottom: 6 }}>
                <Search size={13} color="var(--muted)" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people to add" style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
              </label>
              <div style={{ flex: 1, minHeight: 120, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
                {directory.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>No people available.</div>}
                {listed.map((p) => (
                  <label key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}>
                    <input type="checkbox" checked={form.members.includes(p.email)} onChange={() => toggleMember(p.email)} aria-label={`Add ${p.name}`} />
                    <Avatar name={p.name} photoUrl={p.photoUrl} size={22} />
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{p.name}</span>
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={LBL}>Schedulers - managers who can build this group's schedule even when its members do not report to them</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {(form.schedulers || []).map((em) => (
                    <button key={em} type="button" style={chip(true)} aria-label={`Remove scheduler ${who(em)}`} onClick={() => setForm({ ...form, schedulers: form.schedulers.filter((x) => x !== em) })}>{who(em)} ×</button>
                  ))}
                  <select className="form-input" value="" aria-label="Add a scheduler" style={{ width: 'auto', fontSize: 12.5 }}
                    onChange={(e) => { const em = e.target.value; if (em) setForm({ ...form, schedulers: [...(form.schedulers || []), em] }); }}>
                    <option value="">Add a scheduler…</option>
                    {directory.filter((p) => !(form.schedulers || []).includes(p.email)).map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><MessageSquare size={12} /> Microsoft Teams chat for BOD / EOD / break messages</div>
                {form.teamsChatId ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, padding: '5px 11px', borderRadius: 9, background: 'var(--bg)' }}>{form.teamsChatName || 'Bound chat'}</span>
                    <button type="button" className="secondary-btn" style={{ fontSize: 11.5 }} onClick={() => setForm({ ...form, teamsChatId: '', teamsChatName: '' })}>Change Or Clear</button>
                  </div>
                ) : chatList === null ? (
                  <button type="button" className="secondary-btn" onClick={loadChatOptions} disabled={chatLoading} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {chatLoading ? <Spinner size={12} /> : <Link2 size={12} />} Bind A Chat
                  </button>
                ) : chatList.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                    No Teams chats found for your account. This list only shows chats you are already a member of - create or join the group chat in Microsoft Teams first, then{' '}
                    <button type="button" onClick={loadChatOptions} disabled={chatLoading} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand)', fontWeight: 700, fontSize: 11.5 }}>refresh</button>.
                  </div>
                ) : (
                  <select className="form-input" value="" aria-label="Teams chat" style={{ fontSize: 12.5, width: '100%' }}
                    onChange={(e) => { const c = chatList.find((x) => x.id === e.target.value); if (c) setForm({ ...form, teamsChatId: c.id, teamsChatName: c.name }); }}>
                    <option value="">Pick a group chat</option>
                    {chatList.map((c) => <option key={c.id} value={c.id}>{c.name}{c.chatType === 'oneOnOne' ? ' (direct)' : ''}</option>)}
                  </select>
                )}
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5 }}>Members must be in this chat for their message to post.</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button type="button" className="secondary-btn" onClick={() => setForm(null)}>Cancel</button>
                <button type="button" className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{busy ? <Spinner size={13} /> : <Check size={13} />} Save</button>
              </div>
            </div>
          </div>
        )}
        {guard.confirming && <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={() => setForm(null)} onSave={guard.saveAndClose} saving={guard.saving || busy} />}
      </div>
    </AsyncSection>
  );
}
