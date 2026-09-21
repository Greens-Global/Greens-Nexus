// Task Emails (Sept 2026) - each person's own control over task emails: when
// reminders arrive, how often overdue ones repeat, one email per task or one
// daily summary, which instant emails they get, and muted tasks/projects.
// Shown by the header menu's "Email Settings" (components/EmailSettingsModal.jsx),
// which the "Email Settings" link in every task email also opens.
// Company settings (Manage -> Notifications) stay the default; anything left on
// "Company default" here follows them. The backend is the real boundary
// (task_notify_prefs.normalize) - this form only offers valid choices.
//
// The header sits OUTSIDE the Task module's provider, so this loads its own
// project list for "Mute a Project" rather than reading TasksContext.
import { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import { api } from '../api';
import { SearchSelect } from './components';
import { SkeletonBlocks } from '../components/AsyncState';
import { ZONE_GROUPS, LOCAL_TZ, zoneOptionLabel } from '../lib/worldClockZones';
import { NX, FONT, btn, input as inputStyle } from './theme';

const label = { display: 'block', fontSize: 12.5, fontWeight: 700, color: NX.ink, marginBottom: 4 };
const hint = { fontSize: 12, color: NX.dim, margin: '0 0 8px', lineHeight: 1.45 };
const section = { padding: '14px 0', borderBottom: `1px solid ${NX.border2}` };
const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };

// 12-hour labels, per the app-wide US time format.
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

const EVENT_LABELS = {
  assigned: 'Assigned to me', mentioned: 'Mentioned in a comment',
  created: 'New task created for me', commented: 'New comment on my task',
  modified: 'Task details changed', follower_added: 'Added as collaborator',
  completed: 'Task completed', deleted: 'Task deleted', recurring: 'Recurring task due',
};

function Toggle({ on, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={onChange}
      style={{ width: 38, height: 22, borderRadius: 999, border: 'none', padding: 2, flexShrink: 0,
        background: on ? NX.green : NX.border, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1, display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
    </button>
  );
}

/** `onUnavailable` fires when the account has no Task module access (the
 *  settings API answers 403) - the modal then says so rather than showing
 *  controls that can't be saved. */
export default function EmailSettingsPanel({ onUnavailable }) {
  const [projects, setProjects] = useState([]);
  const [data, setData] = useState(null);   // server payload: prefs + company + muted lists
  const [prefs, setPrefs] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getMyTaskNotifyPrefs()
      .then((d) => { setData(d); setPrefs(d.prefs); })
      .catch((e) => {
        if (e?.status === 403) onUnavailable?.();
        else setErr(e.message || 'Could not load your email settings.');
      });
    api.getTaskProjects().then((rows) => setProjects(Array.isArray(rows) ? rows : [])).catch(() => setProjects([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => { setPrefs((p) => ({ ...p, [k]: v })); setSaved(false); };
  const dirty = !!data && JSON.stringify(prefs) !== JSON.stringify(data.prefs);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const d = await api.saveMyTaskNotifyPrefs(prefs);
      setData(d); setPrefs(d.prefs); setSaved(true);
    } catch (e) { setErr(e.message || 'Could not save.'); }
    setSaving(false);
  };

  const company = data?.company || {};
  // The same zone list the rest of Nexus offers (My Profile's World Clock,
  // shift schedules) - one curated zone per standard offset, grouped by
  // region, each labeled with its offset. This picker used to carry its own
  // seven US zones plus whatever the browser reported, which showed up raw as
  // "Asia/Calcutta" (Sagar, Sep 21).
  const savedTz = prefs?.timezone || '';
  const tzInList = Object.values(ZONE_GROUPS).some(zs => zs.includes(savedTz));
  const mutedTaskTitle = (id) => data?.mutedTasks?.find((t) => t.id === id)?.title || 'A task that no longer exists';
  const mutedProjectName = (id) => data?.mutedProjects?.find((p) => p.id === id)?.name
    || projects.find((p) => p.id === id)?.name || 'A project that no longer exists';

  return (
      <div style={{ fontFamily: FONT, color: NX.ink }}>
        <p style={{ ...hint, marginBottom: 4 }}>
          Choose which task emails you get and when. Anything left on the company default follows your company&apos;s settings.
        </p>
        {!prefs ? (err ? null : <SkeletonBlocks count={4} height={56} borderRadius={10} />) : (
          <>
            <div style={section}>
              <label style={label}>Reminder Time</label>
              <p style={hint}>Due-soon and overdue reminders arrive once a day at this time.</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select aria-label="Reminder time" value={prefs.reminderHour} onChange={(e) => set('reminderHour', Number(e.target.value))} style={{ ...sel, width: 140 }}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
                <select aria-label="Time zone" value={prefs.timezone} onChange={(e) => set('timezone', e.target.value)} style={{ ...sel, flex: 1, minWidth: 180 }}>
                  <option value={LOCAL_TZ}>Local - {zoneOptionLabel(LOCAL_TZ)}</option>
                  {/* A zone saved before this list existed (or from another
                      device) must still be selectable, or the <select> would
                      silently show the wrong one. */}
                  {!tzInList && savedTz && savedTz !== LOCAL_TZ && <option value={savedTz}>{zoneOptionLabel(savedTz)}</option>}
                  {Object.entries(ZONE_GROUPS).map(([region, zs]) => (
                    <optgroup key={region} label={region.replace(/_/g, ' ')}>
                      {zs.filter(z => z !== LOCAL_TZ).map(z => <option key={z} value={z}>{zoneOptionLabel(z)}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                <span style={{ fontSize: 13 }}>Skip reminders on weekends</span>
                <Toggle on={prefs.skipWeekends} onChange={() => set('skipWeekends', !prefs.skipWeekends)} />
              </div>
            </div>

            <div style={section}>
              <label style={label}>Due Soon Reminder</label>
              <p style={hint}>How early to be reminded before a task is due.</p>
              <select aria-label="Due soon reminder" value={String(prefs.dueSoonDays)} onChange={(e) => {
                const v = e.target.value; set('dueSoonDays', v === 'company' || v === 'off' ? v : Number(v));
              }} style={sel}>
                <option value="company">Company default ({company.dueSoonDays === 0 ? 'on the due date' : `${company.dueSoonDays} day${company.dueSoonDays === 1 ? '' : 's'} before`})</option>
                <option value="0">On the due date only</option>
                {[1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'} before</option>)}
                <option value="off">Off</option>
              </select>
            </div>

            <div style={section}>
              <label style={label}>Overdue Reminders</label>
              <p style={hint}>You always get one on the first day a task is overdue; this sets how often it repeats after that.</p>
              <select aria-label="Overdue reminders" value={prefs.overdueFrequency} onChange={(e) => set('overdueFrequency', e.target.value)} style={sel}>
                <option value="company">Company default ({company.overdueRepeatDays ? `every ${company.overdueRepeatDays} day${company.overdueRepeatDays === 1 ? '' : 's'}` : 'only once'})</option>
                <option value="daily">Every day</option>
                <option value="every2">Every 2 days</option>
                <option value="every3">Every 3 days</option>
                <option value="weekly">Once a week</option>
                <option value="once">Only once</option>
                {company.allowUserOverdueOff && <option value="off">Off</option>}
              </select>
            </div>

            <div style={section}>
              <label style={label}>Reminder Delivery</label>
              <p style={hint}>With many tasks due or overdue, one summary replaces a separate email for each.</p>
              {[['each', 'One email per task'], ['digest', 'One daily summary of all my due and overdue tasks']].map(([v, l]) => (
                <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', cursor: 'pointer' }}>
                  <input type="radio" name="reminderDelivery" checked={prefs.reminderDelivery === v} onChange={() => set('reminderDelivery', v)} /> {l}
                </label>
              ))}
            </div>

            <div style={section}>
              <label style={label}>Instant Emails</label>
              <p style={hint}>Sent as things happen. Assignments and mentions are always sent.</p>
              {[...(data.lockedEvents || []), ...(data.optionalEvents || [])].map((k) => {
                const locked = (data.lockedEvents || []).includes(k);
                const companyOff = company.enabledEvents && company.enabledEvents[k] === false;
                const on = locked || prefs.events?.[k] !== false;
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', gap: 10 }}>
                    <span style={{ fontSize: 13 }}>
                      {EVENT_LABELS[k] || k}
                      {locked && <span style={{ color: NX.faint, fontSize: 11.5 }}> - always on</span>}
                      {companyOff && <span style={{ color: NX.faint, fontSize: 11.5 }}> - turned off for everyone by your company</span>}
                    </span>
                    <Toggle on={on && !companyOff} disabled={locked || companyOff}
                      onChange={() => set('events', { ...prefs.events, [k]: !on })} />
                  </div>
                );
              })}
              <div style={{ marginTop: 8 }}>
                <label style={{ ...label, fontWeight: 600 }}>Combine Task Update Emails</label>
                <select aria-label="Combine task update emails" value={prefs.updateThrottleMinutes} onChange={(e) => set('updateThrottleMinutes', Number(e.target.value))} style={sel}>
                  <option value={0}>Send every update</option>
                  <option value={15}>At most one per task every 15 minutes</option>
                  <option value={60}>At most one per task every hour</option>
                </select>
              </div>
            </div>

            <div style={{ ...section, borderBottom: 'none' }}>
              <label style={label}>Muted</label>
              <p style={hint}>No emails at all about these, except when someone mentions you. Mute a single task from the link at the bottom of any task email.</p>
              {prefs.mutedTaskIds.length === 0 && prefs.mutedProjectIds.length === 0 && (
                <p style={{ fontSize: 12.5, color: NX.faint, margin: '0 0 8px' }}>Nothing muted.</p>
              )}
              {[...prefs.mutedProjectIds.map((id) => ['project', id, `Project: ${mutedProjectName(id)}`]),
                ...prefs.mutedTaskIds.map((id) => ['task', id, mutedTaskTitle(id)])].map(([kind, id, text]) => (
                <div key={`${kind}:${id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
                  <button type="button" title="Unmute" aria-label={`Unmute ${text}`} style={{ ...btn('ghost'), padding: '3px 8px', fontSize: 12 }}
                    onClick={() => set(kind === 'task' ? 'mutedTaskIds' : 'mutedProjectIds',
                      (kind === 'task' ? prefs.mutedTaskIds : prefs.mutedProjectIds).filter((x) => x !== id))}>
                    <X size={12} /> Unmute
                  </button>
                </div>
              ))}
              <div style={{ marginTop: 6 }}>
                <SearchSelect placeholder="Mute a Project…" searchPlaceholder="Search projects…" emptyText="No projects to mute."
                  options={projects.filter((p) => !p.archived && !prefs.mutedProjectIds.includes(p.id))
                    .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
                    .map((p) => ({ id: p.id, label: p.name }))}
                  onPick={(id) => set('mutedProjectIds', [...prefs.mutedProjectIds, id])} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
              <button style={{ ...btn('primary'), opacity: saving || !dirty ? 0.6 : 1 }} onClick={save} disabled={saving || !dirty}>
                <Save size={14} /> {saving ? 'Saving…' : 'Save Email Settings'}
              </button>
              {saved && !dirty && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
            </div>
          </>
        )}
        {err && <div style={{ fontSize: 12.5, color: NX.red, marginTop: 8 }}>{err}</div>}
      </div>
  );
}
