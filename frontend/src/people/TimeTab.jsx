import { useEffect, useState } from 'react';
import {
  MapPinned, MapPin, Building2, Globe, ArrowLeftRight, CheckCircle, ArrowUpRight,
  CalendarClock, Users, Clock, CalendarDays, CalendarCheck,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { timeTrackingText } from '../lib/timeTracking';
import { useRole } from '../contexts/RoleContext';
import { dialog } from '../ui/dialog';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { SwitchRow } from '../components/settings/SettingsUI';
import { fmtLeave } from '../components/LeaveBalances';
import { isoDate, shiftTimeText } from '../components/shifts/shiftLib';
import { Row, SectionHead } from './shared';
import { fullName, goTo } from './lib';

// Time & Scheduling (11/03/2026; it was the Work Mode tab - the old
// 'location' key still lands here): whether the person is on the schedule,
// how and where they punch, their usual hours and shift teams, whether time
// is tracked, and their leave policy. Shifts owns the usual hours and the
// teams; Time Off owns the leave balances - this shows them and links there.
export default function TimeTab({ e, onSchedule = true, onScheduleChange, canEdit = false, canSeeComp = false, toastOk, toastErr }) {
  const name = fullName(e) || 'This person';
  const email = (e.workEmail || '').toLowerCase();
  const [busy, setBusy] = useState(false);

  async function toggle(next) {
    if (busy || !canEdit || !email) return;
    if (!next && !await dialog.confirm(
      `Take ${name} off the schedule? Their upcoming shifts become open slots. You can put them back any time.`,
      { title: 'Take Off the Schedule?', confirmText: 'Take Off the Schedule' })) return;
    setBusy(true);
    try {
      const r = await api.setOnSchedule(email, next);
      const on = r && typeof r.on === 'boolean' ? r.on : next;
      onScheduleChange?.(on);
      const n = Number(r?.openedCount || 0);
      if (on) toastOk(`${name} is on the schedule.`);
      else toastOk(n ? `${name} is off the schedule - ${n} ${n === 1 ? 'shift is now an open slot' : 'shifts are now open slots'}` : `${name} is off the schedule.`);
    } catch (err) { toastErr(err?.message || 'Could not change the schedule setting.'); }
    setBusy(false);
  }

  return (
    <div>
      <SectionHead icon={CalendarCheck} title="Schedule" first />
      <SwitchRow id={`on-schedule-${e.id}`} title="On the Schedule"
        desc={email ? 'Shows on the shift planner, can be given shifts and is checked for Late.' : 'Needs a work email first - the schedule keys off it.'}
        checked={onSchedule} onChange={toggle} disabled={!canEdit || busy || !email} />

      <GeofenceSection employee={e} toastOk={toastOk} toastErr={toastErr} />

      <ShiftFacts email={email} />

      <SectionHead icon={Clock} title="Time Tracking" />
      <TimeTrackingRow employeeId={e.id} canSeeComp={canSeeComp} />

      <SectionHead icon={CalendarDays} title="Leave Policy" />
      <LeavePolicy email={email} />
    </div>
  );
}

// Usual hours and shift teams, as the planner has them this week.
function ShiftFacts({ email }) {
  const [loaded, setState] = useState(null);   // null loading | false failed | { usual, teams }
  const state = email ? loaded : { usual: null, teams: [] };
  useEffect(() => {
    if (!email) return undefined;
    let live = true;
    const start = new Date();
    const end = new Date(); end.setDate(end.getDate() + 6);
    api.timeSchedule(isoDate(start), isoDate(end)).then(r => {
      if (!live) return;
      const id = r?.usual?.[email] || '';
      const usual = id ? (r?.shifts || []).find(p => p.id === id) || null : null;
      const teams = (r?.groups || []).filter(g => !g.archived && (g.members || []).map(m => String(m).toLowerCase()).includes(email));
      setState({ usual, teams });
    }).catch(() => { if (live) setState(false); });
    return () => { live = false; };
  }, [email]);
  const link = (labelText) => (
    <button type="button" className="secondary-btn" onClick={() => goTo('shifts', 'schedule')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {labelText} <ArrowUpRight size={12} />
    </button>
  );
  const body = (v) => (state === null ? <SkeletonBlocks count={1} height={18} /> : v);
  return (
    <>
      <SectionHead icon={CalendarClock} title="Usual Hours">{link('Edit in Shifts')}</SectionHead>
      {body(state === false
        ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>Open Shifts to see the usual hours.</div>
        : <Row icon={CalendarClock} label="Usual Hours" value={state?.usual ? `${state.usual.name} · ${shiftTimeText(state.usual)}` : 'No usual hours'} />)}
      <SectionHead icon={Users} title="Shift Teams">{link('Manage in Shifts')}</SectionHead>
      {body(state === false
        ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>Open Shifts to see the teams.</div>
        : <Row icon={Users} label="Teams" value={state?.teams?.length ? state.teams.map(g => g.name).join(', ') : 'Not on a shift team'} />)}
    </>
  );
}

// Tracked or exempt - set on the person's role in Settings > Access (Visesh, 10/02).
function TimeTrackingRow({ employeeId, canSeeComp }) {
  const [loaded, setPayroll] = useState(undefined);
  const payroll = canSeeComp ? loaded : null;
  useEffect(() => {
    if (!canSeeComp) return undefined;
    let live = true;
    api.getCompensation(employeeId).then(r => { if (live) setPayroll(r?.payroll || null); }).catch(() => { if (live) setPayroll(null); });
    return () => { live = false; };
  }, [employeeId, canSeeComp]);
  if (payroll === undefined) return <SkeletonBlocks count={1} height={18} />;
  return (
    <>
      <Row icon={Clock} label="Time Tracking" value={payroll ? timeTrackingText(payroll) : 'Set on the role'} />
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Set on the person's role in Settings &gt; Access, beside the screen-share exemption.</div>
    </>
  );
}

// The person's leave policy and what is left - People > Time > Time Off changes it.
function LeavePolicy({ email }) {
  const [loaded, setB] = useState(null);
  const b = email ? loaded : false;
  useEffect(() => {
    if (!email) return undefined;
    let live = true;
    api.leavePersonBalance(email).then(r => { if (live) setB(r || false); }).catch(() => { if (live) setB(false); });
    return () => { live = false; };
  }, [email]);
  const open = (
    <button type="button" className="secondary-btn" onClick={() => goTo('hr', 'hr-time-off')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
      Open Time Off <ArrowUpRight size={12} />
    </button>
  );
  if (b === null) return <SkeletonBlocks count={1} height={18} />;
  if (!b || b.live === false) return <><div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>Leave balances are kept under People &gt; Time &gt; Time Off.</div>{open}</>;
  if (b.benefitExempt) return <><Row icon={CalendarDays} label="Policy" value="Benefit exempt - no paid leave" />{open}</>;
  const pol = b.policy;
  return (
    <>
      <Row icon={CalendarDays} label="Policy" value={pol?.name} />
      <Row icon={CalendarDays} label="Vacation" value={b.vacation ? `${fmtLeave(b.vacation.available, pol)} available` : ''} />
      <Row icon={CalendarDays} label="Sick" value={b.sick ? `${fmtLeave(b.sick.available, pol)} available` : ''} />
      {open}
    </>
  );
}

// Work Mode and usual sites (moved from views/HR.jsx as it was, 11/03/2026).
function GeofenceSection({ employee, toastOk, toastErr }) {
  const { canAccessModule, hrTeam } = useRole();
  const canEdit = !hrTeam && canAccessModule('hr', 'manager', 'editor');   // a team view is read only
  const [data, setData] = useState(null);        // { geofence: {mode,remote,setBy,setAt}, lastPunchLocation, workSites }
  const [busy, setBusy] = useState(false);

  const load = () => api.getGeofence(employee.id)
    .then(setData)
    .catch(() => setData({ geofence: {}, lastPunchLocation: null, workSites: [] }));
  useEffect(() => { load(); }, [employee.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const gf = data?.geofence || {};
  // Older payloads carry only remote; Hybrid (Neil, Oct 22) came with mode.
  const mode = gf.mode || (gf.remote ? 'remote' : 'onsite');
  const lp = data?.lastPunchLocation || null;
  const sites = data?.workSites || [];
  // Allowed sites (Charmi, Sep 29): several, any of them is on-site; none
  // picked = any company work site. Older payloads carry one workSiteId.
  const allowed = gf.workSiteIds || (gf.workSiteId ? [gf.workSiteId] : []);
  const firstName = employee.firstName || employee.first_name || 'This person';

  const saveSites = async (ids) => {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      const r = await api.setGeofence(employee.id, { work_site_ids: ids });
      setData(d => ({ ...(d || {}), geofence: r }));
      const names = sites.filter(x => ids.includes(x.id)).map(x => x.name || 'Unnamed site');
      toastOk(ids.length ? `${firstName}'s usual locations: ${names.join(', ')}. A punch at any company location still counts as on-site.` : `${firstName} may punch from any company location.`);
    } catch (e) { toastErr(e?.message || 'Could not save the locations.'); }
    finally { setBusy(false); }
  };
  const toggleSite = (sid) => saveSites(allowed.includes(sid) ? allowed.filter(x => x !== sid) : [...allowed, sid]);

  const choose = async (next) => {
    if (busy || !canEdit || next === mode) return;
    setBusy(true);
    try {
      const r = await api.setGeofence(employee.id, { mode: next });
      setData(d => ({ ...(d || {}), geofence: r }));
      toastOk({
        remote: `${firstName} is now remote - punches from anywhere are accepted.`,
        hybrid: `${firstName} is now hybrid - punches at a company location count there, anywhere else counts as remote.`,
        onsite: `${firstName} is now on-site - punches are expected at a company location.`,
      }[next]);
    } catch (e) { toastErr(e?.message || 'Could not save the work mode.'); }
    finally { setBusy(false); }
  };

  const OPTIONS = [
    { value: 'onsite', icon: Building2, title: 'On-Site',
      body: 'Punches are expected at any company location. A punch made somewhere else is still recorded, and flagged for the manager to review.' },
    { value: 'remote', icon: Globe, title: 'Remote',
      body: 'May punch from anywhere - home, a coffee shop, another city. Nothing is flagged. At a company location, the punch still counts toward that location.' },
    { value: 'hybrid', icon: ArrowLeftRight, title: 'Hybrid',
      body: 'Works from their usual locations some days and remotely on others; punches away from a site count as remote.' },
  ];

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 10 }}>
        <MapPinned size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Work Mode
      </div>

      {!data ? <SkeletonBlocks count={3} height={40} /> : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
            Nobody is tied to a single address. A person works remote, works from our locations - any of them - or is hybrid and does both.
          </div>

          <div role="radiogroup" aria-label="Work mode" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }} className="acc-grid">
            {OPTIONS.map(o => {
              const on = mode === o.value;
              const Icon = o.icon;
              return (
                <button key={o.title} type="button" role="radio" aria-checked={on} disabled={!canEdit || busy} onClick={() => choose(o.value)}
                  style={{ textAlign: 'left', border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, background: on ? 'var(--mist)' : 'transparent',
                    borderRadius: 12, padding: 14, cursor: canEdit && !busy ? 'pointer' : 'default', font: 'inherit', color: 'inherit', opacity: !canEdit && !on ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Icon size={15} style={{ color: on ? 'var(--pine)' : 'var(--muted)' }} />
                    <span style={{ fontSize: 13.5, fontWeight: 700 }}>{o.title}</span>
                    {on && (busy
                      ? <Spinner size={13} style={{ marginLeft: 'auto' }} />
                      : <CheckCircle size={14} style={{ marginLeft: 'auto', color: 'var(--pine)' }} />)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{o.body}</div>
                </button>
              );
            })}
          </div>

          {gf.setBy && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14 }}>
              Last changed by {gf.setBy}{gf.setAt ? ` on ${formatDate(gf.setAt)}` : ''}.
            </div>
          )}

          {mode !== 'remote' && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{firstName}'s Usual Locations</div>
              {sites.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, flexWrap: 'wrap' }}>
                  <span>
                    {allowed.length
                      ? `${allowed.length === 1 ? 'This is' : `These ${allowed.length} locations are`} ${firstName}'s usual location${allowed.length === 1 ? '' : 's'} and win where two locations overlap. A punch at any company location counts as on-site; outside all of them is ${mode === 'hybrid' ? 'Remote' : 'Out of Location'}.`
                      : 'Any company location counts as on-site. Click locations to mark the usual ones - they only matter where two locations overlap.'}
                  </span>
                  {allowed.length > 0 && canEdit && (
                    <button type="button" className="secondary-btn" disabled={busy} onClick={() => saveSites([])}
                      style={{ fontSize: 11.5, padding: '3px 10px' }}>Clear Usual Locations</button>
                  )}
                </div>
              )}
              {sites.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                  No company location is placed on the map yet, so no punch can be judged on-site. Place them in Settings - Location Library.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {sites.map(st => {
                    const picked = allowed.includes(st.id);
                    const on = !allowed.length || picked;
                    return (
                      <button key={st.id} type="button" aria-pressed={picked} disabled={!canEdit || busy} onClick={() => toggleSite(st.id)}
                        title={`${st.radiusM} m fence${canEdit ? (picked ? ' - click to remove' : ' - click to allow') : ''}`}
                        style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 20, fontFamily: 'inherit', cursor: canEdit && !busy ? 'pointer' : 'default',
                          background: picked ? 'var(--mist)' : 'transparent', border: `1px solid ${picked ? 'var(--pine)' : 'var(--line)'}`,
                          color: on ? 'var(--ink)' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {picked && <CheckCircle size={11} style={{ color: 'var(--pine)' }} />}
                        {st.name || 'Unnamed location'} · {st.radiusM} m
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {lp && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              <MapPin size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Last located punch {formatDateTime(lp.at)}{lp.workSiteName ? ` - ${lp.workSiteName}` : ''}
              {' · '}<a href={`https://www.google.com/maps?q=${lp.lat},${lp.lng}`} target="_blank" rel="noreferrer" style={{ color: 'var(--pine)', fontWeight: 600 }}>View on Map <ArrowUpRight size={11} style={{ verticalAlign: 'middle' }} /></a>
            </div>
          )}
          <style>{`@media (max-width:640px){.acc-grid{grid-template-columns:1fr !important}}`}</style>
        </>
      )}
    </div>
  );
}
