// Settings > Global Settings > Shifts (Charmi, 09/30: "these settings should
// not be here, this should be in our global settings module"). Three
// sections, each self-contained: the shift settings (switches, team time
// zone, week start, time-off reasons), the Shift Types (the
// presets that used to be Shifts > Presets & Teams) and the Groups (who is
// scheduled together, who schedules them, their Teams chat). Registered in
// views/AdminConsole.jsx GLOBAL_CATEGORIES / GLOBAL_SECTIONS.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, X, Check, MessageSquare, Search, ChevronUp, ChevronDown, Pencil, Hash, CloudRain, CalendarDays } from 'lucide-react';
import { api } from '../../api';
import TeamsTargetPicker from '../TeamsTargetPicker';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../UnsavedChangesPrompt';
import { dialog } from '../../ui/dialog';
import { ZONE_GROUPS, zoneOptionLabel } from '../../lib/worldClockZones';
import { useNameResolver } from '../../lib/useNameResolver';
import { useRole } from '../../contexts/RoleContext';
import { formatHHMM } from '../../lib/datetime';
import { useListNav } from '../../lib/listNav';
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

// ── Company (Shifts Phase 0, Oct 2026) ───────────────────────────────────
// Shift settings, shift types and groups can belong to one company (an HR
// entity) or be shared with every company. The three panels share one
// picker; the choice is remembered per browser and kept in step across the
// panels through a window event, since each panel is its own section.
const COMPANY_KEY = 'shifts.settings.company';
const COMPANY_EVENT = 'shifts:settings-company';
const readCompany = () => { try { return localStorage.getItem(COMPANY_KEY) || ''; } catch { return ''; } };
export function useSettingsCompany() {
  const [company, setState] = useState(readCompany);
  useEffect(() => {
    const on = (e) => setState(e.detail ?? readCompany());
    window.addEventListener(COMPANY_EVENT, on);
    return () => window.removeEventListener(COMPANY_EVENT, on);
  }, []);
  const setCompany = (v) => {
    const next = v || '';
    setState(next);
    try { localStorage.setItem(COMPANY_KEY, next); } catch { /* per-viewer convenience only */ }
    window.dispatchEvent(new CustomEvent(COMPANY_EVENT, { detail: next }));
  };
  return [company, setCompany];
}
// Settle the remembered company against what the API offers; the caller's
// effect then reloads. Someone who cannot pick and is offered exactly one
// company is PINNED to it (a company-scoped administrator: their new shift
// types, groups and settings must carry that company, never '' - the tenant,
// which they may not change). Offered none, or more than one without
// picking, means the default (''). A stored company the API no longer
// offers falls back to the default. `skip` is a company that just failed to
// load - never pin back to it, or the reload would loop.
function settleCompany(r, company, setCompany, skip = '') {
  const list = Array.isArray(r?.companies) ? r.companies : null;
  if (r?.canPickCompany === false) {
    const only = list && list.length === 1 && list[0].id !== skip ? list[0].id : '';
    if (only !== (company || '')) setCompany(only);
    return;
  }
  if (!company) return;
  if (list && !list.some((c) => c.id === company)) setCompany('');
}
// A load that fails while a company is set (remembered from last time but
// gone, or no longer the viewer's to see: 403 / 404) drops the company and
// loads the defaults instead of showing the error. Returns true when it did.
function dropFailedCompany(company, setCompany, failed) {
  if (!company) return false;
  failed.current = company;
  setCompany('');
  return true;
}
const companyNameOf = (companies, id) => (companies || []).find((c) => c.id === id)?.name || 'this company';
export function CompanyPicker({ value, onChange, companies, hint }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <span style={{ ...LBL, marginBottom: 0 }}>Company</span>
      <select className="form-input" aria-label="Company" value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px', maxWidth: '100%' }}>
        <option value="">All Companies (Default)</option>
        {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {hint && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>}
    </label>
  );
}
// The company a shift type or group belongs to, on its row.
function CompanyTag({ id, companies }) {
  const shared = !id;
  return (
    <span title={shared ? 'Shared with every company' : 'Only this company'} style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 7px', border: '1px solid var(--line)', color: shared ? 'var(--muted)' : 'var(--wk-brand)', background: shared ? 'transparent' : 'var(--wk-brand-tint)', whiteSpace: 'nowrap' }}>
      {shared ? 'Shared' : companyNameOf(companies, id)}
    </span>
  );
}
// The Company select in the shift type and group forms.
function CompanySelect({ value, onChange, companies, label }) {
  return (
    <label style={{ fontSize: 11, color: 'var(--muted)', display: 'grid', gap: 4 }}>
      Company
      <select className="form-input" aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px', maxWidth: '100%' }}>
        <option value="">Shared With Every Company</option>
        {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

// ── Shift settings ───────────────────────────────────────────────────────
// Trading and open shift requests start off (Shifts Phase 0): a missing key
// reads as off for these three, on for the rest.
const OFF_BY_DEFAULT = new Set(['openShifts', 'swaps', 'offers']);
const SWITCHES = [
  ['openShifts', 'Staff can request open shifts'], ['swaps', 'Staff can swap shifts with teammates'], ['offers', 'Staff can offer their shifts to teammates'],
  ['timeOffRequests', 'Staff can request time off'],
  ['teamSchedules', "Staff can see their group's shifts in My Shifts"],
  ['teamShiftDetails', "Staff can see the notes, activities and breaks on teammates' shifts"],
  ['teamTimeOffReasons', 'Staff can see why a teammate is off, and their note'],
];
export function ShiftSettingsPanel({ toastOk, toastErr }) {
  const [company, setCompany] = useSettingsCompany();
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  // Sticky across reloads so the picker stays put while a company loads.
  const [canPick, setCanPick] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [graceDraft, setGraceDraft] = useState(null);   // null = not being typed
  const failed = useRef('');
  useEffect(() => {
    let live = true;
    setError(null);
    setCfg(null);
    api.shiftRequestSettingsGetFor(company)
      .catch((e) => (company ? Promise.reject(e) : api.shiftRequestsInbox().then((r) => r?.settings)))   // an older API has no GET
      .then((r) => {
        if (!live) return;
        const next = r || {};
        setCfg(next);
        if (next.canPickCompany !== undefined) setCanPick(next.canPickCompany === true);
        if (Array.isArray(next.companies)) setCompanies(next.companies);
        settleCompany(next, company, setCompany, failed.current);
        if (company) failed.current = '';
      })
      .catch((e) => { if (live && !dropFailedCompany(company, setCompany, failed)) setError(e?.message || 'Could not load the settings.'); });
    return () => { live = false; };
  }, [tick, company]);   // eslint-disable-line react-hooks/exhaustive-deps
  const graceShown = graceDraft ?? String(cfg?.defaultGraceMin ?? 10);
  const companyName = companyNameOf(companies, company);
  // Only the key(s) that changed go to the API: a company's override stays
  // sparse (the server stores what differs from the tenant and says whether
  // anything is left - hasOverride), and nothing stale is written back.
  async function save(patch) {
    const before = cfg;
    const next = { ...cfg, ...patch };
    setCfg(next);
    try {
      const r = await api.shiftRequestSettingsSaveFor(patch, company);
      setCfg({ ...next, hasOverride: !!company, ...(r || {}) });
      toastOk?.(company ? `Shift settings saved for ${companyName}.` : 'Shift settings saved.');
    } catch (e) { toastErr?.(e.message || 'Could not save the settings.'); setCfg(before); }
  }
  function saveGrace() {
    if (graceDraft === null) return;
    const typed = Number(graceDraft);
    setGraceDraft(null);
    if (graceDraft.trim() === '' || !Number.isFinite(typed)) return;
    const n = Math.max(0, Math.min(120, Math.round(typed)));
    if (n !== (cfg.defaultGraceMin ?? 10)) save({ defaultGraceMin: n });
  }
  async function useDefaults() {
    const ok = await dialog.confirm(`Drop the shift settings ${companyName} has of its own? It then follows the default settings, and whatever changes there.`, { title: 'Use the Defaults', confirmText: 'Use the Defaults' });
    if (!ok) return;
    try { await api.shiftRequestSettingsReset(company); toastOk?.(`${companyName} now uses the default settings.`); setTick((t) => t + 1); }
    catch (e) { toastErr?.(e?.message || 'Could not drop the settings.'); }
  }
  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {canPick && <CompanyPicker value={company} onChange={setCompany} companies={companies} hint="A company with no settings of its own follows the defaults." />}
      <AsyncSection loading={!cfg && !error} error={!!error} onRetry={() => setTick((t) => t + 1)} errorMessage="The shift settings could not be loaded right now." skeleton={<SkeletonBlocks count={3} height={36} borderRadius={8} />}>
        {cfg && (
          <div style={{ display: 'grid', gap: 14 }}>
            {company && (
              <div style={{ fontSize: 12, border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--card)' }}>
                <span style={{ flex: 1, minWidth: 200, color: cfg.hasOverride ? 'var(--ink)' : 'var(--muted)' }}>
                  {cfg.hasOverride
                    ? `${companyName} has its own settings. Changes here apply to ${companyName} only.`
                    : `Using the default settings. Changing anything here saves settings for ${companyName} only.`}
                </span>
                {cfg.hasOverride && <button type="button" className="link-btn" onClick={useDefaults} style={{ marginTop: 0, color: 'var(--wk-brand)' }}>Use the Defaults</button>}
              </div>
            )}
            <div>
              <div style={LBL}>Requests And Visibility</div>
              {SWITCHES.map(([k, text]) => (
                <label key={k} style={CHECK}><input type="checkbox" checked={OFF_BY_DEFAULT.has(k) ? cfg[k] === true : cfg[k] !== false} onChange={(e) => save({ [k]: e.target.checked })} /> {text}</label>
              ))}
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Trading (swaps, offers) and open shift requests are off unless turned on here.</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Every request still needs a manager's approval. Turning one off stops new requests of that kind. A confidential time-off reason is never shown to teammates.</div>
              {/* Shifts Phase 3b (Oct 15): staff move their own work. */}
              <div style={{ marginTop: 10 }}>
                <label style={CHECK}><input type="checkbox" checked={cfg.releaseShifts === true} onChange={(e) => save({ ...cfg, releaseShifts: e.target.checked })} /> People can release a shift to the open pool</label>
                <label style={{ ...CHECK, paddingLeft: 24, color: cfg.releaseShifts === true ? 'var(--ink)' : 'var(--muted)', cursor: cfg.releaseShifts === true ? 'pointer' : 'default' }}>
                  <input type="checkbox" disabled={cfg.releaseShifts !== true} checked={cfg.releaseNeedsApproval !== false} onChange={(e) => save({ ...cfg, releaseNeedsApproval: e.target.checked })} /> A manager approves a release
                </label>
                <label style={CHECK}><input type="checkbox" checked={cfg.openShiftsAcrossTeams === true} onChange={(e) => save({ ...cfg, openShiftsAcrossTeams: e.target.checked })} /> Open shifts can be claimed across teams</label>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Off by default. Turn on per company. With approval off, a released shift goes to the open pool right away.</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Team Time Zone</span>
                <ZonePick label="Team time zone" value={cfg.timeZone} onChange={(v) => save({ timeZone: v })} />
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>What a shift with no shift type runs on, and what a new shift type starts with.</span>
              </label>
              <label style={{ display: 'grid', gap: 4 }}><span style={LBL}>Week Starts On</span>
                <select className="form-input" aria-label="Week starts on" value={cfg.weekStart === 'sunday' ? 'sunday' : 'monday'} onChange={(e) => save({ weekStart: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px' }}>
                  <option value="monday">Monday</option>
                  <option value="sunday">Sunday</option>
                </select>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>The first column of every schedule grid.</span>
              </label>
              <label style={{ display: 'grid', gap: 4, maxWidth: 300 }}><span style={LBL}>Default Grace</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="number" min="0" max="120" step="1" className="form-input" aria-label="Default grace" value={graceShown}
                    onChange={(e) => setGraceDraft(e.target.value)} onBlur={saveGrace} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    style={{ width: 80, fontSize: 12.5, padding: '4px 8px' }} />
                  <span style={{ fontSize: 12.5 }}>minutes</span>
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Late starts this many minutes after the shift start for a shift with no shift type. A shift type carries its own grace.</span>
              </label>
            </div>
            <div>
              <div style={LBL}>Attendance</div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <MinutesField label="No-Show Alert" aria="No-show alert" value={cfg.noShowAlertMin} fallback={10} onSave={(n) => save({ ...cfg, noShowAlertMin: n })}
                  hint="Tells the person's manager, their backup manager and the team's schedulers when a shared shift has started, the grace has passed, and this many minutes have gone by with no clock-in. The alert always lands inside the six hours after the start. 0 turns it off." />
                <MinutesField label="Left Early" aria="Left early" value={cfg.leftEarlyMin} fallback={15} onSave={(n) => save({ ...cfg, leftEarlyMin: n })}
                  hint="Clocking out this many minutes before the shift's end counts as leaving early on the schedule." />
              </div>
              <label style={{ ...CHECK, marginTop: 8 }}><input type="checkbox" checked={cfg.noShowOnUsualHours === true} onChange={(e) => save({ noShowOnUsualHours: e.target.checked })} /> Alert for usual hours too</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Also alerts for office staff who have usual hours but no shift on the schedule that day. Time off and holidays excuse those.</div>
              {/* Live overtime alert (Oct 17 2026, overtime_watch.py). */}
              <label style={{ ...CHECK, marginTop: 10 }}><input type="checkbox" checked={cfg.otAlertOn === true} onChange={(e) => save({ otAlertOn: e.target.checked })} /> Alert managers before overtime</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Off unless turned on here. Tells the person's manager and their backup manager once, from the actual punches, when someone clocked in is about to reach overtime.</div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8, opacity: cfg.otAlertOn === true ? 1 : 0.6 }}>
                <MinutesField label="Daily Overtime Warning" aria="Daily overtime warning" value={cfg.otAlertDailyLeadMin} fallback={30} onSave={(n) => save({ otAlertDailyLeadMin: n })}
                  hint="Minutes before 8 worked hours in a day. People on the California overtime rule only. 0 turns it off." />
                <MinutesField label="Weekly Overtime Warning" aria="Weekly overtime warning" max={480} value={cfg.otAlertWeeklyLeadMin} fallback={120} onSave={(n) => save({ otAlertWeeklyLeadMin: n })}
                  hint="Minutes before 40 hours of regular time in a payroll week (Sunday to Saturday). 0 turns it off." />
              </div>
              {/* Require Location to Punch (Oct 19 2026, routers/timeclock.py punch()). */}
              <label style={{ ...CHECK, marginTop: 10 }}><input type="checkbox" checked={cfg.requireLocationToPunch === true} onChange={(e) => save({ requireLocationToPunch: e.target.checked })} /> Require Location to Punch</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Off unless turned on here. When on, a clock in, clock out or break punch from Nexus is refused unless the browser shares a location, and the person is shown how to turn location on. When off, a punch without a location still records and shows No Location on the Time Sheet. Missed punch requests and manager edits are not affected.</div>
              {/* Location Trail While Clocked In (Oct 20 2026, routers/location_trail.py). */}
              <label style={{ ...CHECK, marginTop: 10 }}><input type="checkbox" checked={cfg.locationTrailOn === true} onChange={(e) => save({ locationTrailOn: e.target.checked })} /> Location Trail While Clocked In</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Off unless turned on here. When on, Nexus shares each person's location about every 5 minutes while they are clocked in, paused on breaks and stopped at clock out, and only when their browser already allows location. The Time Clock page tells them it is on. Managers see live positions and each day's trail in People - Time - Location Trail. A browser cannot share while the phone screen is locked or Nexus is closed, so the trail has gaps then. Points are kept for 90 days.</div>
            </div>
            <div>
              <div style={LBL}>Rules</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>0 turns a rule off. Rules warn on the schedule; they never block.</div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <MinutesField label="Minimum Rest Between Shifts" aria="Minimum rest between shifts" unit="hours" max={24} value={cfg.ruleMinRestHours} fallback={0} onSave={(n) => save({ ...cfg, ruleMinRestHours: n })}
                  hint="Warns when someone's next shift starts sooner than this after their last one ends." />
                <MinutesField label="Most Days In A Row" aria="Most days in a row" unit="days" max={14} value={cfg.ruleMaxDaysInRow} fallback={0} onSave={(n) => save({ ...cfg, ruleMaxDaysInRow: n })}
                  hint="Warns when someone is scheduled more days in a row than this." />
                <MinutesField label="Daily Overtime After" aria="Daily overtime after" unit="hours" max={24} value={cfg.ruleDailyOtHours} fallback={0} onSave={(n) => save({ ...cfg, ruleDailyOtHours: n })}
                  hint="California daily overtime; applies to people on the California overtime rule. Someone with no payroll rate follows their country: US people get the California rule, everyone else has no overtime rules." />
                <MinutesField label="Weekly Overtime After" aria="Weekly overtime after" unit="hours" max={80} value={cfg.ruleWeeklyOtHours} fallback={0} onSave={(n) => save({ ...cfg, ruleWeeklyOtHours: n })}
                  hint="Warns when the hours scheduled in the payroll week, Sunday to Saturday, pass this - whatever day the grid starts on." />
                <MinutesField label="Most Hours Per Week" aria="Most hours per week" unit="hours" max={100} value={cfg.ruleMaxWeekHours} fallback={0} onSave={(n) => save({ ...cfg, ruleMaxWeekHours: n })}
                  hint="Warns when the hours scheduled in the week shown on the grid pass this. Applies to everyone." />
              </div>
              <label style={{ ...CHECK, marginTop: 8 }}><input type="checkbox" checked={cfg.publishReasonRequired === true} onChange={(e) => save({ publishReasonRequired: e.target.checked })} /> Require a reason to share a schedule that has warnings</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Rule warnings, approved time off and holidays ask for it; a pending request, availability or an overlap only shows. Managers see the reason in the history of the shifts it applies to. A company that does not want to be asked turns this off here{canPick ? ' - pick the company above first' : ''}.</div>
            </div>
            <div>
              <div style={LBL}>Sharing</div>
              <label style={CHECK}><input type="checkbox" checked={cfg.outlookCalendarOn === true} onChange={(e) => save({ ...cfg, outlookCalendarOn: e.target.checked })} /> Add shared shifts to people's Outlook calendars</label>
              <label style={{ display: 'grid', gap: 4, maxWidth: 300, margin: '4px 0 6px' }}><span style={{ fontSize: 12.5, fontWeight: 600, color: cfg.outlookCalendarOn !== true ? 'var(--muted)' : 'var(--ink)' }}>Show In Outlook As</span>
                <select className="form-input" aria-label="Show in Outlook as" disabled={cfg.outlookCalendarOn !== true} value={cfg.outlookShowAs === 'busy' ? 'busy' : 'free'} onChange={(e) => save({ ...cfg, outlookShowAs: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '4px 30px 4px 8px' }}>
                  <option value="free">Free</option>
                  <option value="busy">Busy</option>
                </select>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Off unless a company turns it on. Free keeps people bookable during a shift; Busy blocks the time. Each person can keep shifts out of their own calendar from My Shifts. Turning it off takes the events already added back off people's calendars.</span>
              </label>
              <label style={CHECK}><input type="checkbox" checked={cfg.confirmRequests !== false} onChange={(e) => save({ ...cfg, confirmRequests: e.target.checked })} /> Ask people to confirm a shared schedule</label>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>A share then asks each person to confirm in My Shifts; the schedule shows who has, and a manager can nudge the rest.</div>
              <CalendarSyncStatus />
            </div>
            {!company && <TimeOffReasons toastOk={toastOk} toastErr={toastErr} />}
          </div>
        )}
      </AsyncSection>
    </div>
  );
}

// The Outlook calendar sync status, for administrators (Shifts Phase 3a).
// `enabled: false` with a reason that names docs/Outlook-Calendar-Setup.md
// means the Entra permission (Calendars.ReadWrite) is not granted yet - a
// quiet amber note, never an error. A failed call shows nothing.
export function CalendarSyncStatus() {
  const role = useRole();
  const isAdmin = !!role?.can?.('administrator');
  const [st, setSt] = useState(null);
  useEffect(() => {
    if (!isAdmin) return undefined;
    let live = true;
    Promise.resolve().then(() => api.timeCalendarSyncStatus())
      .then((r) => { if (live) setSt(r && typeof r === 'object' ? r : null); })
      .catch(() => { if (live) setSt(null); });
    return () => { live = false; };
  }, [isAdmin]);
  if (!isAdmin || !st) return null;
  if (st.enabled === false) {
    const setup = /Outlook-Calendar-Setup/i.test(String(st.reason || ''));
    return setup ? (
      <div role="note" data-calendar-sync="waiting" title={st.reason || undefined} style={{ fontSize: 12, color: 'hsl(var(--color-orange))', marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <CalendarDays size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Outlook calendar sync is waiting on an Entra permission (Calendars.ReadWrite). See docs/Outlook-Calendar-Setup.md.</span>
      </div>
    ) : (
      <div data-calendar-sync="off" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Outlook calendar: off{st.reason ? ` - ${st.reason}` : ''}</div>
    );
  }
  const n = (k) => Number(st[k]) || 0;
  return (
    <div data-calendar-sync="on" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
      Outlook calendar: on - {n('ok')} synced, {n('pending')} pending{n('errors') ? `, ${n('errors')} failed` : ''}{n('skipped') ? `, ${n('skipped')} skipped` : ''}
    </div>
  );
}

// A minutes field that saves on blur or Enter, clamped to 0-`max` - the
// Default Grace idiom (Shifts Phase 1: the attendance thresholds; Phase 2:
// the rules, in hours or days).
function MinutesField({ label, aria, value, fallback, max = 240, unit = 'minutes', hint, onSave }) {
  const [draft, setDraft] = useState(null);   // null = not being typed
  const current = value ?? fallback;
  function commit() {
    if (draft === null) return;
    const typed = Number(draft);
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(typed)) return;
    const n = Math.max(0, Math.min(max, Math.round(typed)));
    if (n !== current) onSave(n);
  }
  return (
    <label style={{ display: 'grid', gap: 4, maxWidth: 300 }}><span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input type="number" min="0" max={max} step="1" className="form-input" aria-label={aria} value={draft ?? String(current)}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          style={{ width: 80, fontSize: 12.5, padding: '4px 8px' }} />
        <span style={{ fontSize: 12.5 }}>{unit}</span>
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>
    </label>
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
  const [company, setCompany] = useSettingsCompany();
  const [shifts, setShifts] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [defaultTz, setDefaultTz] = useState(BLANK.timezone);
  const [canPick, setCanPick] = useState(false);
  const [companies, setCompanies] = useState([]);
  // Whether the API lets this viewer add / edit / delete shift types at all
  // (a plain manager cannot since Phase 0); an older API says nothing = yes.
  const [canManage, setCanManage] = useState(true);
  const failed = useRef('');
  useEffect(() => {
    let live = true;
    setError(null);
    setShifts(null);
    api.timeShiftsFor(company).then((r) => {
      if (!live) return;
      setShifts(r.shifts || []);
      if (r.defaultTimezone) setDefaultTz(r.defaultTimezone);
      if (r.canPickCompany !== undefined) setCanPick(r.canPickCompany === true);
      if (Array.isArray(r.companies)) setCompanies(r.companies);
      setCanManage(r.canManage !== false);
      settleCompany(r, company, setCompany, failed.current);
      if (company) failed.current = '';
    }).catch((e) => { if (live && !dropFailedCompany(company, setCompany, failed)) setError(e?.message || 'Could not load the shift types.'); });
    return () => { live = false; };
  }, [tick, company]);   // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => setTick((t) => t + 1);

  async function save() {
    if (!form.name.trim()) { toastErr?.('Name the shift type.'); return; }
    setBusy(true);
    try {
      const payload = { ...form, company_id: form.company_id || '' };
      if (form.id) await api.timeShiftUpdate(form.id, payload); else await api.timeShiftCreate(payload);
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
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {canPick && <CompanyPicker value={company} onChange={setCompany} companies={companies} hint="A company sees the shared shift types and its own." />}
      <AsyncSection loading={!shifts && !error} error={!!error} onRetry={reload} errorMessage="The shift types could not be loaded right now." skeleton={<SkeletonBlocks count={2} height={64} borderRadius={10} />}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>The shifts a manager places with one click. A person's usual hours are one of these.</span>
          {canManage ? (
            <button type="button" className="secondary-btn" onClick={() => setForm({ ...BLANK, timezone: defaultTz, company_id: company || '' })} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> New Shift Type</button>
          ) : <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Shift types are set by company administrators.</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {shifts?.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No shift types yet.</div>}
          {(shifts || []).map((s) => (
            <div key={s.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {s.code && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--ink)', background: alpha(s.color || DEFAULT_SHIFT_COLOR, 0.14), borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}>{s.code}</span>}
                {!s.code && <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: s.color || DEFAULT_SHIFT_COLOR, flexShrink: 0 }} />}
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                {canManage && <button type="button" onClick={() => setForm({ ...s, start_hhmm: s.start, end_hhmm: s.end, grace_min: s.graceMin, break_min: s.breakMin || 0, company_id: s.companyId || '' })} aria-label={`Edit shift type ${s.name}`} title="Edit" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><Pencil size={12} /></button>}
                {canManage && <button type="button" onClick={() => remove(s)} aria-label={`Delete shift type ${s.name}`} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex' }}><Trash2 size={12} /></button>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>{formatHHMM(s.start)} - {formatHHMM(s.end)} · {daysLabel(s.days)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.graceMin}m grace{s.breakMin ? ` · ${s.breakMin}m unpaid break` : ''} · {zoneOptionLabel(s.timezone || 'America/Los_Angeles')}</div>
              {(canPick || s.companyId) && <div style={{ marginTop: 6 }}><CompanyTag id={s.companyId} companies={companies} /></div>}
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
                  <span style={{ fontSize: 10.5, fontWeight: 400 }}>Start and end above are this zone's local time - the daily briefing and Late status fire against it.</span>
                </label>
                {canPick && <CompanySelect label="Shift type company" value={form.company_id} onChange={(v) => setForm({ ...form, company_id: v })} companies={companies} />}
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
    </div>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────
// Who is scheduled together, who may build their schedule, and the Teams
// chat their BOD / EOD messages go to. Members come from the curated Nexus
// People list.
// One line per group on the weather watch (Weather Call, Oct 2026).
export function weatherLine(g) {
  if (g.weatherAlerts === false) return g.workSiteName ? `${g.workSiteName} · Weather alerts off` : 'Weather alerts off';
  if (!g.workSiteId) return 'No work site - weather alerts cannot watch this group';
  if (g.siteLocated === false) return `${g.workSiteName || 'Work site'} has no coordinates - weather alerts cannot watch this group`;
  const n = (g.weatherDeciders || []).length;
  return `${g.workSiteName || 'Work site'} · Weather alerts on · ${n ? `${n} decider${n === 1 ? '' : 's'}` : 'schedulers decide'}`;
}
const weatherTone = (g) => (g.weatherAlerts === false ? 'var(--muted)' : (!g.workSiteId || g.siteLocated === false) ? 'hsl(var(--color-orange))' : 'var(--wk-brand)');

export function ShiftGroupsPanel({ toastOk, toastErr }) {
  const nameOf = useNameResolver();
  const [company, setCompany] = useSettingsCompany();
  const [canPick, setCanPick] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [people, setPeople] = useState([]);
  // The work-site library (Weather Call, Oct 2026): a group's site is where
  // the weather watch looks. [] until it loads, or when the caller has no
  // People access to the library - the picker then shows only the saved one.
  const [sites, setSites] = useState([]);
  const [canGroups, setCanGroups] = useState(true);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    setError(null);
    api.timeShiftGroups().then((r) => {
      if (!live) return;
      setGroups(orderGroups(r.groups || []));
      setCanGroups(r.canManageGroups !== false);
      if (r.canPickCompany !== undefined) setCanPick(r.canPickCompany === true);
      if (Array.isArray(r.companies)) setCompanies(r.companies);
      settleCompany(r, company, setCompany);
    }).catch((e) => { if (live) setError(e?.message || 'Could not load the groups.'); });
    api.getPeopleDirectory().then((rows) => { if (live) setPeople(Array.isArray(rows) ? rows : []); }).catch(() => {});
    api.getWorkSites?.().then((rows) => { if (live) setSites(Array.isArray(rows) ? rows : []); }).catch(() => {});
    return () => { live = false; };
  }, [tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => setTick((t) => t + 1);
  // The picker narrows the list to the shared groups and the company's own;
  // the order saved is still the whole list's.
  const visible = useMemo(() => (groups || []).filter((g) => !company || !g.companyId || g.companyId === company), [groups, company]);
  const who = (email) => { const p = people.find((x) => emailOf(x) === (email || '').toLowerCase()); return nameOf(email, p?.name); };
  const directory = useMemo(() => people.filter((p) => emailOf(p)).map((p) => ({ email: emailOf(p), name: nameOf(emailOf(p), p.name), photoUrl: p.photoUrl || p.photo_url || '' })).sort((a, b) => a.name.localeCompare(b.name)), [people, nameOf]);

  async function save() {
    if (!form.name.trim()) { toastErr?.('Name the group.'); return; }
    setBusy(true);
    const payload = { name: form.name, members: form.members, schedulers: form.schedulers || [], teams_chat_id: form.teamsChatId || '', teams_chat_name: form.teamsChatName || '',
      teams_target: form.teamsTarget || 'chat', teams_team_id: form.teamsTeamId || '', teams_team_name: form.teamsTeamName || '',
      work_site_id: form.workSiteId || '', weather_deciders: form.weatherDeciders || [], weather_alerts: form.weatherAlerts !== false,
      company_id: form.companyId || '' };
    try {
      if (form.id) await api.timeShiftGroupSet(form.id, payload); else await api.timeShiftGroupCreate(payload);
      toastOk?.('Group saved.'); setForm(null); reload();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function remove(g) {
    const ok = await dialog.confirm(`Delete the group "${g.name}"? This can't be undone. Its ${g.members.length} member${g.members.length === 1 ? '' : 's'} keep their shifts, `
      + `but leave the group grid${g.chatId ? `, and their BOD / EOD messages stop going to its Teams ${g.teamsTarget === 'channel' ? 'channel' : 'chat'}` : ''}.`, { title: 'Delete Group', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.timeShiftGroupDelete(g.id); toastOk?.('Group deleted.'); reload(); } catch (e) { toastErr?.(e?.message || 'Could not delete the group.'); }
  }
  async function move(i, d) {
    const ids = groups.map((g) => g.id);
    const a = ids.indexOf(visible[i].id), b = ids.indexOf(visible[i + d].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    setGroups(ids.map((id) => groups.find((g) => g.id === id)));
    try { await api.timeShiftGroupOrder(ids).catch((e) => (e?.status === 404 ? api.timeShiftGroupReorder(ids) : Promise.reject(e))); toastOk?.('Group order saved.'); }
    catch (e) { toastErr?.(e?.message || 'Could not save the order.'); reload(); }
  }
  const baseline = useRef(null);
  useEffect(() => { baseline.current = form || null; }, [!!form]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!form && baseline.current !== null && JSON.stringify(form) !== JSON.stringify(baseline.current);
  const guard = useUnsavedGuard(dirty, () => setForm(null), save);
  const openForm = (g) => {
    setQ('');
    setForm(g ? { id: g.id, name: g.name, members: g.members, schedulers: g.schedulers || [], teamsChatId: g.chatId || '', teamsChatName: g.chatName || '',
      teamsTarget: g.teamsTarget || 'chat', teamsTeamId: g.teamId || '', teamsTeamName: g.teamName || '',
      workSiteId: g.workSiteId || '', weatherDeciders: g.weatherDeciders || [], weatherAlerts: g.weatherAlerts !== false, companyId: g.companyId || '' }
      : { name: '', members: [], schedulers: [], teamsChatId: '', teamsChatName: '', teamsTarget: 'chat', teamsTeamId: '', teamsTeamName: '',
        workSiteId: '', weatherDeciders: [], weatherAlerts: true, companyId: company || '' });
  };
  const toggleMember = (em) => setForm((f) => ({ ...f, members: f.members.includes(em) ? f.members.filter((x) => x !== em) : [...f.members, em] }));
  const listed = directory.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  // Up / Down / Enter in the member search (lib/listNav.js), once typed.
  const memberNav = useListNav(listed, { open: !!q.trim(), query: q, onPick: (p) => toggleMember(p.email) });

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {canPick && <CompanyPicker value={company} onChange={setCompany} companies={companies} hint="A company sees the shared groups and its own." />}
      <AsyncSection loading={!groups && !error} error={!!error} onRetry={reload} errorMessage="The groups could not be loaded right now." skeleton={<SkeletonBlocks count={2} height={64} borderRadius={10} />}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>People scheduled together. The order here is the order on the schedule.</span>
          {canGroups ? (
            <button type="button" className="secondary-btn" onClick={() => openForm(null)} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> New Group</button>
          ) : <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Groups are changed by an administrator</span>}
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {groups?.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No groups yet.</div>}
          {groups?.length > 0 && visible.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No groups for {companyNameOf(companies, company)} yet.</div>}
          {visible.map((g, i) => (
            <div key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {canGroups && (
                <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${g.name} up`} style={{ padding: 2 }}><ChevronUp size={13} /></button>
                  <button type="button" className="icon-btn" disabled={i === visible.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${g.name} down`} style={{ padding: 2 }}><ChevronDown size={13} /></button>
                </span>
              )}
              <span style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{g.name}{g.archived ? ' (Archived)' : ''}</span>
                  {(canPick || g.companyId) && <CompanyTag id={g.companyId} companies={companies} />}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {g.members.length} member{g.members.length === 1 ? '' : 's'}{g.members.length > 0 && ` · ${g.members.slice(0, 3).map(who).join(', ')}${g.members.length > 3 ? '…' : ''}`}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5, color: g.chatId ? 'var(--wk-brand)' : 'var(--muted)' }}>
                  {g.teamsTarget === 'channel' ? <Hash size={12} /> : <MessageSquare size={12} />}
                  {!g.chatId ? 'No chat or channel bound'
                    : g.teamsTarget === 'channel' ? `${g.teamName || 'Team'} › ${g.chatName || 'Channel'}`
                      : (g.chatName || 'Chat bound')}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 3, display: 'flex', alignItems: 'center', gap: 5, color: weatherTone(g) }}>
                  <CloudRain size={12} style={{ flexShrink: 0 }} />
                  <span>{weatherLine(g)}</span>
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
              {canPick && <div style={{ marginBottom: 12 }}><CompanySelect label="Group company" value={form.companyId} onChange={(v) => setForm({ ...form, companyId: v })} companies={companies} /></div>}
              <div style={{ ...LBL, display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1 }}>Members ({form.members.length})</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {form.members.map((em) => <button key={em} type="button" style={chip(true)} aria-label={`Remove ${who(em)}`} onClick={() => toggleMember(em)}>{who(em)} ×</button>)}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px', marginBottom: 6 }}>
                <Search size={13} color="var(--muted)" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people to add" className="nx-inline-edit"
                  {...memberNav.inputProps} onKeyDown={memberNav.onKeyDown} style={{ border: 'none', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
              </label>
              <div style={{ flex: 1, minHeight: 120, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
                {directory.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>No people available.</div>}
                {listed.map((p, i) => (
                  <label key={p.email} {...memberNav.optionProps(i)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', borderBottom: '1px solid var(--line)' }}>
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
                <div style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><CloudRain size={12} /> Weather - where this group works, and who makes the weather call</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.45 }}>
                  The weather watch reads the forecast for the group's work site. Without a site the group is not watched. Deciders need Manage access to Shifts (manager and above); with none named, the schedulers and then the company's managers are told.
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <label><div style={LBL}>Work Site</div>
                    <select className="form-input" aria-label="Work site" value={form.workSiteId || ''} onChange={(e) => setForm({ ...form, workSiteId: e.target.value })} style={{ width: '100%', fontSize: 13 }}>
                      <option value="">No work site</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.latitude && s.longitude ? '' : ' (no coordinates)'}</option>)}
                      {form.workSiteId && !sites.some((s) => s.id === form.workSiteId) && <option value={form.workSiteId}>{groups?.find((g) => g.id === form.id)?.workSiteName || 'Current site'}</option>}
                    </select>
                  </label>
                  <div>
                    <div style={LBL}>Weather Deciders</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {(form.weatherDeciders || []).map((em) => (
                        <button key={em} type="button" style={chip(true)} aria-label={`Remove weather decider ${who(em)}`} onClick={() => setForm({ ...form, weatherDeciders: form.weatherDeciders.filter((x) => x !== em) })}>{who(em)} ×</button>
                      ))}
                      <select className="form-input" value="" aria-label="Add a weather decider" style={{ width: 'auto', fontSize: 12.5 }}
                        onChange={(e) => { const em = e.target.value; if (em) setForm({ ...form, weatherDeciders: [...(form.weatherDeciders || []), em] }); }}>
                        <option value="">Add a decider…</option>
                        {directory.filter((p) => !(form.weatherDeciders || []).includes(p.email)).map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.weatherAlerts !== false} onChange={(e) => setForm({ ...form, weatherAlerts: e.target.checked })} aria-label="Watch the weather for this group" />
                    Watch the weather for this group
                  </label>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={{ ...LBL, display: 'inline-flex', alignItems: 'center', gap: 5 }}><MessageSquare size={12} /> Microsoft Teams - where BOD / EOD / break messages post</div>
                {/* A job role's Teams setting comes first (Neil, 10/07: set it on
                    the role in Access); this binding covers people whose role
                    sets none. */}
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.45 }}>
                  Set this on the job role instead (Access &gt; Job Roles) - a role's chat or channel is used first. This group's binding is used only for members whose role sets none.
                </div>
                {/* Group chat or a channel in a team (Pranshu, 10/06) - whichever the organization runs. */}
                <TeamsTargetPicker toastErr={toastErr}
                  value={{ type: form.teamsTarget || 'chat', id: form.teamsChatId || '', name: form.teamsChatName || '', teamId: form.teamsTeamId || '', teamName: form.teamsTeamName || '' }}
                  onChange={(t) => setForm((f) => ({ ...f, teamsTarget: t.type, teamsChatId: t.id, teamsChatName: t.name, teamsTeamId: t.teamId, teamsTeamName: t.teamName }))} />
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
    </div>
  );
}
