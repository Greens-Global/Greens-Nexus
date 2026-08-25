/* eslint-disable react-hooks/refs -- the org-chart canvas reads container/zoom refs during render for pan-zoom fit-to-view; safe intentional reads the React-Compiler rule flags */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { QuestionnairesModal, InterviewPanel, LeaderboardModal } from '../components/Interviews';
import {
  Users, Plus, Search, X, Loader2, Mail, Phone, Briefcase, MapPin,
  ChevronLeft, Network, CalendarOff, UserPlus, Pencil, FileText,
  CheckCircle, XCircle, ChevronRight, History, CalendarDays, Camera,
  Building2, Trash2, MapPinned, Wallet, Landmark, Lock, Contact, Heart,
  ShieldCheck, Shield, AlertTriangle, Clock, ArrowUpRight, RotateCcw,
  ChevronDown,
} from 'lucide-react';
import { api } from '../api';
import { geocode } from '../asset/lib/geo';
import { formatDate, formatDateTime } from '../lib/datetime';
import { dialog } from '../ui/dialog';
import { usePeopleDirectory } from '../lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/queryClient';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import { useRole, MODULES, MODULE_LEVELS, ROLES } from '../contexts/RoleContext';
import TimeAdmin from '../components/TimeAdmin';
import ModuleTabs from '../components/ModuleTabs';
import PhotoEditorModal from '../components/PhotoEditorModal';
import RolesAccess, { LevelPill, ModuleLevelPill, TierBadge } from './RolesAccess';
// External tab folded into People (Neil, Aug 24: one master list) - only the
// shared pieces remain in use: badge, invite modal, lifecycle section.
import { ExternalBadge, InviteExternalModal, inviteOutcomeToast, ExternalPersonSection } from './ExternalUsersPanel';
import { capabilityText } from '../lib/moduleCapabilities';
import PersonHover from '../components/PersonHoverCard';
import EgnytePersonFolder from '../egnyte/EgnytePersonFolder';
import InvestorChart from '../components/InvestorChart';
import { takePendingPerson } from '../lib/personNav';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { TaskChecklist, punchTime } from '../components/WorkLogDrawer';

// ── HR module - Phase 1: employee master + People directory ──────────────────
// Hiring pipeline, org chart and leave land in later phases (tabs are stubs).
// Old hardcoded onboarding/disclosure screens were dummy data - removed.

const EMP_TYPES = [
  ['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['contractor', 'Contractor'], ['intern', 'Intern'],
];
const TYPE_LABEL = Object.fromEntries(EMP_TYPES);

const STATUS_META = {
  onboarding: { label: 'Onboarding', bg: 'hsla(var(--color-blue),0.1)',    fg: 'hsl(var(--color-blue))' },
  active:     { label: 'Active',     bg: 'hsla(var(--color-green),0.1)',   fg: 'hsl(var(--color-green))' },
  inactive:   { label: 'Inactive',   bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  offboarded: { label: 'Left',       bg: 'var(--mist)',                    fg: 'var(--muted)' },
};

// The status dropdown's "Deleted" entry. Deliberately NOT a STATUS_META member:
// removal is orthogonal to employment status (a removed person keeps whatever
// status they had, so it can be restored unchanged), and it selects a different
// LIST rather than filtering the current one. The sentinel cannot collide with a
// real status value.
const DELETED_F = '__deleted__';

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

const AVATAR_HUES = ['215,75%,45%', '142,60%,35%', '30,80%,48%', '271,60%,48%', '350,65%,48%'];
const fullName = e => [e.firstName, e.lastName].filter(Boolean).join(' ');
const initials = e => `${(e.firstName || '?')[0]}${(e.lastName || '')[0] || ''}`.toUpperCase();
const hueFor = e => AVATAR_HUES[(e.employeeCode || e.id || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_HUES.length];

// `card={false}` for avatars already inside a clickable row (the People table,
// org-chart nodes) - those rows select the person themselves, so a nested click
// target and a floating card would fight the row.
function Avatar({ e, size = 38, card = true }) {
  const img = e.photoUrl
    ? <img src={e.photoUrl} alt="" style={{ width: size, height: size, borderRadius: size * 0.28, objectFit: 'cover', flexShrink: 0 }} />
    : (
      <div style={{ width: size, height: size, borderRadius: size * 0.28, background: `hsla(${hueFor(e)},0.13)`, color: `hsl(${hueFor(e)})`, fontSize: size * 0.34, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {initials(e)}
      </div>
    );
  return <PersonHover email={e.workEmail} name={fullName(e)} disabled={!card}>{img}</PersonHover>;
}

function useIsMobile(bp = 900) {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${bp}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const h = e => setMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [bp]);
  return mobile;
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────
function EmployeeFormModal({ employee, employees, entities = [], isAdmin = false, canSeeComp = false, initialType = 'full_time', onClose, onSaved, toastOk, toastErr }) {
  const editing = !!employee;
  const [jobRoles, setJobRoles] = useState([]);
  const [jobRoleId, setJobRoleId] = useState('');
  useEffect(() => { if (isAdmin && !editing) api.getJobRoles().then(setJobRoles).catch(() => {}); }, [isAdmin, editing]);
  const seedFrom = (e) => ({
    first_name:      e?.firstName || '',
    last_name:       e?.lastName || '',
    work_email:      e?.workEmail || '',
    personal_email:  e?.personalEmail || '',
    phone:           e?.phone || '',
    job_title:       e?.jobTitle || '',
    designation:     e?.designation || '',
    employee_code:   e?.employeeCode || '',
    department:      e?.department || '',
    employment_type: e?.employmentType || initialType,
    start_date:      e?.startDate || '',
    manager_email:   e?.managerEmail || '',
    status:          e?.status || 'active',
    location:        e?.location || '',
    company:         e?.company || '',
    identity_type:   e?.identityType || 'internal',
    contractor:      e?.contractor || {},
    notes:           e?.notes || '',
  });
  const [f, setF] = useState(() => seedFrom(employee));
  // The row this modal opened from can be STALE: other surfaces change the
  // record without this view's list refetching - assigning a job role (from
  // Roles & Access or the card's Access tab) rewrites job_title server-side,
  // and can set a default manager. Re-read the person on open and refresh any
  // field the user hasn't already retyped: an untouched field still equals the
  // stale seed, so only those are replaced and in-progress edits are never
  // clobbered. (contractor is a nested object - left to its live edit state.)
  useEffect(() => {
    if (!editing || !employee?.id) return;
    let live = true;
    api.getEmployees().then((rows) => {
      if (!live) return;
      const fresh = (rows || []).find((r) => r.id === employee.id);
      if (!fresh) return;
      const orig = seedFrom(employee);
      const next = seedFrom(fresh);
      setF((cur) => {
        const merged = { ...cur };
        for (const k of Object.keys(next)) {
          if (k === 'contractor') continue;
          if (cur[k] === orig[k]) merged[k] = next[k];
        }
        return merged;
      });
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, employee?.id]);
  const [busy, setBusy] = useState(false);
  // Department options come from the SELECTED company - no company, no department.
  const [deptOptions, setDeptOptions] = useState([]);
  const [deptLoading, setDeptLoading] = useState(false);
  // Inline "add a department" so an empty company list never dead-ends the form.
  const [addingDept, setAddingDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [deptSaving, setDeptSaving] = useState(false);
  async function saveNewDept() {
    const name = newDeptName.trim();
    if (!name || deptSaving) return;
    setDeptSaving(true);
    try {
      const list = await api.addCompanyDepartment(f.company, name);
      setDeptOptions(list.map(d => d.name));
      set('department', name);
      setAddingDept(false); setNewDeptName('');
    } catch (err) {
      toastErr(err?.message || 'Could not add the department.');
    } finally { setDeptSaving(false); }
  }
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const setC = (k, v) => setF(prev => ({ ...prev, contractor: { ...(prev.contractor || {}), [k]: v } }));

  // Compensation (gated by the comp-access grant). Keyed by work email; loads the
  // current rate when editing, saved right after the profile on Save.
  const [comp, setComp] = useState({ payType: 'hourly', currency: 'USD', hourlyRate: '', monthlySalary: '', weekendOtAmount: '1000', fullDayHours: '8', timeTrackingExempt: false });
  const [compDirty, setCompDirty] = useState(false);
  const setW = (k, v) => { setComp(prev => ({ ...prev, [k]: v })); setCompDirty(true); };
  useEffect(() => {
    if (!canSeeComp || !editing || !employee?.workEmail) return;
    api.timePayrollRateGet(employee.workEmail).then(r => {
      if (!r?.isSet) return;
      setComp({ payType: r.payType || 'hourly', currency: r.currency || 'USD',
                hourlyRate: r.hourlyRate ? String(r.hourlyRate) : '',
                monthlySalary: r.monthlySalary ? String(r.monthlySalary) : '',
                weekendOtAmount: r.weekendOtAmount != null ? String(r.weekendOtAmount) : '1000',
                fullDayHours: r.fullDayHours ? String(r.fullDayHours) : '8',
                timeTrackingExempt: !!r.timeTrackingExempt });
    }).catch(() => {});
  }, [canSeeComp, editing, employee?.workEmail]);
  useEffect(() => {
    if (!f.company) { setDeptOptions([]); return; }
    setDeptLoading(true);
    api.getCompanyDepartments(f.company)
      .then(list => setDeptOptions(list.map(d => d.name)))
      .catch(() => setDeptOptions([]))
      .finally(() => setDeptLoading(false));
  }, [f.company]);
  const isContractor = f.employment_type === 'contractor';
  const cInput = (label, key, props = {}) => (
    <div>
      <label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={(f.contractor || {})[key] || ''} onChange={e => setC(key, e.target.value)} {...props} />
    </div>
  );

  // Manager picker: anyone with a work email (yourself excluded when editing)
  const managers = employees.filter(e => e.workEmail && e.id !== employee?.id);

  async function save() {
    if (!f.first_name.trim() || busy) return;
    setBusy(true);
    try {
      const saved = editing ? await api.updateEmployee(employee.id, f) : await api.createEmployee(f);
      const wemail = (saved?.workEmail || f.work_email || '').trim();
      // Compensation, keyed by work email - saved after the profile. Any warning is
      // HELD and fired LAST so the single-slot toast doesn't overwrite it with the
      // profile "Saved"/M365 message.
      let wageWarn = '';
      if (canSeeComp && compDirty && wemail) {
        const up = await ensureStepUp();   // payroll writes need a fresh step-up when enforced
        if (!up.ok) {
          wageWarn = up.cancelled ? 'Profile saved - wage skipped (identity check cancelled).'
            : 'Profile saved - wage skipped (identity check did not complete).';
        } else {
          try {
            await api.timePayrollRate({
              email: wemail, pay_type: comp.payType, currency: comp.currency,
              hourly_rate: parseFloat(comp.hourlyRate) || 0,
              monthly_salary: parseFloat(comp.monthlySalary) || 0,
              weekend_ot_amount: parseFloat(comp.weekendOtAmount) || 0,
              full_day_hours: parseFloat(comp.fullDayHours) || 8,
              time_tracking_exempt: !!comp.timeTrackingExempt,
            });
          } catch (err) { wageWarn = `Profile saved, but the wage could not be saved: ${err?.message || 'error'} - set it on the Pay tab.`; }
        }
      } else if (canSeeComp && compDirty && !wemail) {
        wageWarn = 'Profile saved - the wage needs a work email; set it once the email is provisioned.';
      }
      // New hire + a chosen job role → set their access + tier now. Needs a work
      // email; if not provisioned yet, prompt to set it later on the Access tab.
      if (!editing && jobRoleId) {
        if (wemail) {
          try { await api.assignJobRole(jobRoleId, wemail); toastOk?.(`${fullName(saved)} added - job role & access assigned.`); }
          catch (err) { toastErr(err?.message || 'Employee added, but the job role could not be assigned - set it on their Access tab.'); }
        } else {
          toastOk?.('Employee added - assign their job role from the Access tab once a work email is set.');
        }
      } else if (!editing && !saved.entra) {
        toastOk?.('Employee added.');   // plain add (no job role, no M365) had no confirmation before
      }
      onSaved(saved);
      onClose();
      if (wageWarn) toastErr(wageWarn);   // LAST → wins the single toast slot
    } catch (err) {
      toastErr(err?.message || 'Could not save employee.');
      setBusy(false);
    }
  }

  const input = (label, key, props = {}) => (
    <div>
      <label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} />
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-green),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <UserPlus size={17} color="hsl(var(--color-green))" />
          </div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{editing ? `Edit ${fullName(employee)}` : initialType === 'contractor' ? 'Add Independent Contractor' : 'Add Employee'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {input('FIRST NAME *', 'first_name', { autoFocus: !editing })}
          {input('LAST NAME', 'last_name')}
          {input('WORK EMAIL', 'work_email', { type: 'email', placeholder: 'empty until provisioned' })}
          {input('PERSONAL EMAIL', 'personal_email', { type: 'email' })}
          {input('PHONE', 'phone')}
          {input('JOB TITLE', 'job_title')}
          {input('DESIGNATION', 'designation')}
          {/* Editable so Nexus codes can line up with the QuickBooks employee
              codes payroll already uses (Charmi, Aug 21). Auto-assigned on add. */}
          {editing && input('EMPLOYEE CODE', 'employee_code', { placeholder: 'e.g. GG-001 or the QuickBooks code' })}
          {/* Company FIRST, then Department - departments come from the chosen
              company, so asking for it first keeps the form in reading order.
              Changing company clears the department (it belongs to the old company). */}
          <div>
            <label style={FL}>COMPANY / ENTITY</label>
            <select className="form-input" style={{ width: '100%' }} value={f.company}
              onChange={e => { set('company', e.target.value); set('department', ''); setAddingDept(false); }}>
              <option value="">- not set -</option>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </div>
          <div>
            <label style={FL}>DEPARTMENT</label>
            {addingDept ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="form-input" style={{ flex: 1, minWidth: 0 }} autoFocus placeholder="New department name"
                  value={newDeptName} onChange={e => setNewDeptName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveNewDept(); if (e.key === 'Escape') { setAddingDept(false); setNewDeptName(''); } }} />
                <button className="primary-btn" onClick={saveNewDept} disabled={!newDeptName.trim() || deptSaving}
                  style={{ padding: '0 12px', opacity: (!newDeptName.trim() || deptSaving) ? 0.6 : 1 }}>
                  {deptSaving ? '…' : 'Add'}
                </button>
              </div>
            ) : (
              <select className="form-input" style={{ width: '100%' }} value={f.department} disabled={!f.company}
                onChange={e => set('department', e.target.value)}>
                {!f.company
                  ? <option value="">- pick a company first -</option>
                  : <>
                      <option value="">{deptLoading ? 'Loading…' : (deptOptions.length ? '- select -' : '- none yet -')}</option>
                      {f.department && !deptOptions.includes(f.department) && <option value={f.department}>{f.department} (current)</option>}
                      {deptOptions.map(d => <option key={d}>{d}</option>)}
                    </>}
              </select>
            )}
            {!!f.company && !deptLoading && !addingDept && (
              <button onClick={() => setAddingDept(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 5, fontSize: 11.5, fontWeight: 600, color: 'hsl(var(--color-green))' }}>
                + Add a department to this company
              </button>
            )}
          </div>
          <div>
            <label style={FL}>EMPLOYMENT TYPE</label>
            <select className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
              {EMP_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {input('START DATE', 'start_date', { type: 'date' })}
          <div>
            <label style={FL}>STATUS</label>
            <select className="form-input" style={{ width: '100%' }} value={f.status} onChange={e => set('status', e.target.value)}>
              {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={FL}>REPORTS TO</label>
            <select className="form-input" style={{ width: '100%' }} value={f.manager_email} onChange={e => set('manager_email', e.target.value)}>
              <option value="">- no reporting line -</option>
              {managers.map(m => <option key={m.id} value={m.workEmail}>{fullName(m)} ({m.workEmail})</option>)}
            </select>
          </div>
          {input('LOCATION', 'location', { placeholder: 'e.g. Escondido office' })}
          <div>
            <label style={FL}>ACCOUNT TYPE</label>
            <select className="form-input" style={{ width: '100%' }} value={f.identity_type} onChange={e => set('identity_type', e.target.value)}>
              <option value="internal">Internal (MS 365 staff)</option>
              <option value="guest">Guest (Entra B2B partner)</option>
              <option value="external">External (no MS 365 login)</option>
            </select>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>External/guest people can be sandboxed to specific companies on the Access tab.</div>
          </div>
          {isAdmin && !editing && (
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'color-mix(in srgb, var(--ink) 4%, transparent)' }}>
              <label style={FL}>JOB ROLE &amp; ACCESS</label>
              <select className="form-input" style={{ width: '100%' }} value={jobRoleId} onChange={e => setJobRoleId(e.target.value)}>
                <option value="">- set later on the Access tab -</option>
                {jobRoles.map(r => <option key={r.id} value={r.id}>{r.name} · {ROLES[r.tier]?.label || r.tier}</option>)}
              </select>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Sets their access &amp; seniority tier from a job role at onboarding. Needs a work email; otherwise assign it later on their card.</div>
            </div>
          )}
          {isContractor && (
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'hsla(var(--color-orange),0.05)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-orange))', letterSpacing: '.04em', marginBottom: 12 }}>CONTRACTOR ENGAGEMENT</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1 / -1' }}>{cInput('SCOPE / ROLE', 'scope', { placeholder: 'what they are engaged to do' })}</div>
                {cInput('SOW REFERENCE', 'sow_ref', { placeholder: 'SOW doc # / link' })}
                {cInput('BILLING CLIENT', 'billing_client', { placeholder: 'client this contractor bills to' })}
                {cInput('CONTRACT START', 'contract_start', { type: 'date' })}
                {cInput('CONTRACT END', 'contract_end', { type: 'date' })}
                {cInput('RATE', 'rate', { placeholder: 'e.g. 85' })}
                <div>
                  <label style={FL}>RATE TYPE</label>
                  <select className="form-input" style={{ width: '100%' }} value={(f.contractor || {}).rate_type || 'hourly'} onChange={e => setC('rate_type', e.target.value)}>
                    <option value="hourly">Hourly</option><option value="fixed_fee">Fixed Fee</option><option value="daily">Daily</option><option value="monthly">Monthly Retainer</option>
                  </select>
                </div>
                <div>
                  <label style={FL}>CURRENCY</label>
                  <select className="form-input" style={{ width: '100%' }} value={(f.contractor || {}).currency || 'USD'} onChange={e => setC('currency', e.target.value)}>
                    <option value="USD">USD</option><option value="INR">INR</option>
                  </select>
                </div>
                {cInput('ENGAGEMENT AREA', 'engagement_area', { placeholder: 'e.g. Escondido dev / remote' })}
              </div>
            </div>
          )}
          {canSeeComp && !isContractor && (
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'hsla(var(--color-blue),0.05)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-blue))', letterSpacing: '.04em', marginBottom: 12 }}>PAYROLL WAGE</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={FL}>PAY TYPE</label>
                  <select className="form-input" style={{ width: '100%' }} value={comp.payType} onChange={e => setW('payType', e.target.value)}>
                    <option value="hourly">Hourly</option>
                    <option value="fixed">Fixed (monthly salary)</option>
                  </select>
                </div>
                <div>
                  <label style={FL}>CURRENCY</label>
                  <select className="form-input" style={{ width: '100%' }} value={comp.currency} onChange={e => setW('currency', e.target.value)}>
                    <option value="USD">USD ($)</option><option value="INR">INR (₹)</option>
                  </select>
                </div>
                <div>
                  <label style={FL}>TIME TRACKING</label>
                  <select className="form-input" style={{ width: '100%' }} value={comp.timeTrackingExempt ? 'exempt' : 'tracked'}
                    onChange={e => setW('timeTrackingExempt', e.target.value === 'exempt')}>
                    <option value="tracked">Tracked (punches and hours)</option>
                    <option value="exempt">Exempt (salaried - no time tracking)</option>
                  </select>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>Exempt hides the punch card, timer and hours widgets for this person.</div>
                </div>
                {comp.payType === 'hourly' ? (
                  <div>
                    <label style={FL}>HOURLY RATE</label>
                    <input className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={comp.hourlyRate} onChange={e => setW('hourlyRate', e.target.value)} placeholder="0.00" />
                  </div>
                ) : (
                  <>
                    <div>
                      <label style={FL}>MONTHLY SALARY</label>
                      <input className="form-input" type="number" min="0" step="1" style={{ width: '100%' }} value={comp.monthlySalary} onChange={e => setW('monthlySalary', e.target.value)} placeholder="e.g. 30000" />
                    </div>
                    <div>
                      <label style={FL}>WEEKEND OT / DAY</label>
                      <input className="form-input" type="number" min="0" step="1" style={{ width: '100%' }} value={comp.weekendOtAmount} onChange={e => setW('weekendOtAmount', e.target.value)} placeholder="e.g. 1000" />
                    </div>
                  </>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
                {comp.payType === 'fixed'
                  ? 'Fixed: paid the monthly salary; a missed weekday deducts salary / days-in-month. A weekday is Present at 5h+, Half day from 4h to 5h, Absent under 4h; each weekend day worked adds the weekend overtime.'
                  : 'Hourly: paid per hour worked, with overtime per the timecard.'}
                {!editing && !f.work_email && ' Needs a work email to save the wage.'}
              </div>
            </div>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={FL}>NOTES</label>
            <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
              value={f.notes} onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!f.first_name.trim() || busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.first_name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
            {editing ? 'Save Changes' : 'Add Employee'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Documents (Phase 3) - private bucket, viewed via short-lived signed URLs ──
const DOC_KINDS = [['resume', 'Resume'], ['id', 'ID'], ['contract', 'Contract'], ['certificate', 'Certificate'], ['other', 'Other']];

// Mailbox export - start a Graph-backed .eml zip and poll it to completion.
function MailboxExportSection({ employee, toastOk, toastErr }) {
  const [job, setJob] = useState(undefined);   // undefined = loading, null = none
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getMailboxExport(employee.id).then(setJob).catch(() => setJob(null)); }, [employee.id]);
  const active = job && (job.status === 'pending' || job.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { api.getExportStatus(job.id).then(setJob).catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [active, job?.id]);

  if (!employee.m365Id) return null;   // export needs a linked M365 mailbox

  async function start() {
    if (busy) return; setBusy(true);
    try { const j = await api.startMailboxExport(employee.id); setJob(j); toastOk('Mailbox export started - this can take a while for large mailboxes.'); }
    catch (e) { toastErr(e?.message || 'Could not start export.'); }
    setBusy(false);
  }
  async function download() {
    try { const { url } = await api.getExportUrl(job.id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr(e?.message || 'Could not get download link.'); }
  }

  const pct = active && job?.total > 0 ? Math.min(100, Math.round((job.count / job.total) * 100)) : null;
  const status = job === undefined ? '' :
    !job ? 'No export yet.' :
    job.status === 'done' ? `Ready · ${job.message} · ${(job.updatedAt || '').slice(0, 10)}` :
    job.status === 'error' ? `Failed · ${job.message}` :
    job.total > 0 ? `Exporting… ${job.count} of ${job.total} messages (${pct}%)` :
    job.count > 0 ? `Exporting… ${job.count} messages so far` :
    'Starting… counting the mailbox';

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Mail size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Mailbox export
        </span>
        {job?.status === 'done' && (
          <button className="secondary-btn" onClick={download} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
            <FileText size={12} /> Download .zip
          </button>
        )}
        <button className="secondary-btn" onClick={start} disabled={busy || active}
          style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
          {(busy || active) ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <History size={12} />} {job?.status === 'done' ? 'Re-export' : 'Export emails'}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: job?.status === 'error' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
        {status}{status && ' '}
        {job?.status === 'error' && /Mail\.Read/i.test(job.message || '') && <em>Grant the Mail.Read app permission in Entra, then re-export.</em>}
      </div>
      {active && (
        <div style={{ marginTop: 8, height: 6, borderRadius: 6, background: 'var(--line)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 6, background: 'hsl(var(--color-green))',
            width: pct !== null ? `${pct}%` : '15%',
            transition: 'width .4s ease',
          }} />
        </div>
      )}
    </div>
  );
}

// Live read of what a person holds in Item Management (Section B5). No data is
// stored here - Items stays the single source of truth; this deep-links into it.
function AssetsSection({ employee }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.getEmployeeAssets(employee.id).then(setData).catch(() => setData({ assignments: [], checkouts: [] })); }, [employee.id]);
  const goToItems = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'active-checkouts' } }));
  const assignments = data?.assignments || [];
  const checkouts = data?.checkouts || [];
  const total = assignments.length + checkouts.length;

  const line = (icon, name, meta, key) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{meta}</div>
      </div>
    </div>
  );

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Briefcase size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Assets held {data && `· ${total}`}
        </span>
        <button className="secondary-btn" onClick={goToItems} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
          Open in Item Management <ChevronRight size={12} />
        </button>
      </div>
      {!data ? (
        <SkeletonBlocks count={4} height={40} />
      ) : total === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {employee.workEmail ? 'No assigned equipment or active checkouts.' : 'No work email yet - provision the account to link assets.'}
        </div>
      ) : (
        <div>
          {assignments.map(a => line(
            <Briefcase size={14} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />,
            a.name, [a.serial && `SN ${a.serial}`, a.type, 'permanent assignment'].filter(Boolean).join(' · '), `a-${a.id}`))}
          {checkouts.map(c => line(
            <History size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />,
            c.itemName, [c.itemType, c.status === 'pending_receipt' ? 'awaiting receipt' : 'checked out', c.days && `${c.days}d`].filter(Boolean).join(' · '), `c-${c.id}`))}
        </div>
      )}
    </div>
  );
}

// Per-person geofence (Aug 25): assign a work location + radius to this person,
// so their punches are judged against it instead of the shared work sites. Two
// ways to pick the point without typing coordinates: "use last punch location"
// (reads their most recent located punch) and an address search (geocoded via
// the shared Nominatim helper). A Google Maps link lets the admin eyeball the
// pin before saving.
function GeofenceSection({ employee, toastOk, toastErr }) {
  const { canAccessModule } = useRole();
  const canEdit = canAccessModule('hr', 'manager', 'editor');
  const [data, setData] = useState(null);        // { geofence, lastPunchLocation }
  const [radius, setRadius] = useState(150);
  const [pending, setPending] = useState(null);  // staged {lat,lng,label,source} not yet saved
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);

  const load = () => api.getGeofence(employee.id)
    .then(d => { setData(d); if (d.geofence?.radiusM) setRadius(d.geofence.radiusM); })
    .catch(() => setData({ geofence: {}, lastPunchLocation: null }));
  useEffect(() => { setPending(null); setAddr(''); load(); }, [employee.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const gf = data?.geofence || {};
  const hasGeofence = (gf.radiusM || 0) > 0;
  const lp = data?.lastPunchLocation || null;
  const mapsLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

  const useLastPunch = () => {
    if (!lp) return;
    setPending({ lat: lp.lat, lng: lp.lng, source: 'last_punch',
      label: `From last punch - ${formatDateTime(lp.at)}${lp.workSiteName ? ` (${lp.workSiteName})` : ''}` });
  };
  const searchAddress = async () => {
    if (!addr.trim() || searching) return;
    setSearching(true);
    try {
      const coord = await geocode(addr.trim());
      if (!coord) toastErr('No match for that address - try adding the city and state.');
      else setPending({ lat: String(coord[0]), lng: String(coord[1]), source: 'address', label: addr.trim() });
    } catch { toastErr('Address lookup failed - try again in a moment.'); }
    finally { setSearching(false); }
  };
  const save = async () => {
    const loc = pending || (hasGeofence ? { lat: gf.lat, lng: gf.lng, label: gf.label, source: gf.source } : null);
    if (!loc || busy) return;
    setBusy(true);
    try {
      const r = await api.setGeofence(employee.id, { lat: loc.lat, lng: loc.lng, radius_m: radius, label: loc.label, source: loc.source });
      setData(d => ({ ...(d || {}), geofence: r })); setPending(null); toastOk('Work location saved.');
    } catch (e) { toastErr(e?.message || 'Could not save the work location.'); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (busy) return;
    if (!await dialog.confirm('Remove this personal geofence? Their punches will fall back to the shared work sites.', { title: 'Remove geofence', confirmText: 'Remove' })) return;
    setBusy(true);
    try {
      const r = await api.setGeofence(employee.id, { radius_m: 0 });
      setData(d => ({ ...(d || {}), geofence: r })); setPending(null); setRadius(150);
      toastOk('Personal geofence removed.');
    } catch (e) { toastErr(e?.message || 'Could not remove.'); }
    finally { setBusy(false); }
  };

  const RADII = [50, 100, 150, 250, 500, 1000];
  const preview = pending || (hasGeofence ? { lat: gf.lat, lng: gf.lng, label: gf.label, source: gf.source } : null);

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 10 }}>
        <MapPinned size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Work location & geofence
      </div>

      {!data ? <SkeletonBlocks count={3} height={40} /> : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
            When set, this person's clock-ins are judged against this spot and radius instead of the shared work sites - for home-based, field or single-site staff. With none set, they use the nearest work site as before.
          </div>

          {/* Current / staged location */}
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'var(--mist)', marginBottom: 14 }}>
            {preview ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <MapPin size={15} style={{ color: 'hsl(var(--color-green))' }} />
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{preview.label || 'Assigned work location'}</span>
                  {pending && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-orange))', background: 'hsla(var(--color-orange),0.12)', padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: '.05em' }}>Unsaved</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  {(+preview.lat).toFixed(5)}, {(+preview.lng).toFixed(5)}
                  {' · '}<a href={mapsLink(preview.lat, preview.lng)} target="_blank" rel="noreferrer" style={{ color: 'var(--pine)', fontWeight: 600 }}>View on map <ArrowUpRight size={11} style={{ verticalAlign: 'middle' }} /></a>
                  {!pending && gf.setBy && <span> · set by {gf.setBy}{gf.setAt ? ` on ${formatDate(gf.setAt)}` : ''}</span>}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No personal geofence - punches use the shared work sites.</div>
            )}
          </div>

          {canEdit && (
            <>
              {/* Two ways to pick the point */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }} className="acc-grid">
                <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>Use last punch location</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, minHeight: 30 }}>
                    {lp ? `Their most recent located punch - ${formatDateTime(lp.at)}.` : 'No located punch on record yet. They need to clock in with location once, or use address search.'}
                  </div>
                  <button className="secondary-btn" disabled={!lp} onClick={useLastPunch}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: lp ? 1 : 0.55 }}>
                    <MapPin size={13} /> Use last punch
                  </button>
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>Search an address</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="form-input" style={{ flex: 1, fontSize: 12.5 }} placeholder="Street, city, state" value={addr}
                      onChange={e => setAddr(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchAddress(); }} />
                    <button className="secondary-btn" onClick={searchAddress} disabled={!addr.trim() || searching}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: addr.trim() ? 1 : 0.55 }}>
                      {searching ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={13} />}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Finds the coordinates for you - no typing lat/long.</div>
                </div>
              </div>

              {/* Radius + save */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Radius</label>
                <select className="form-input" style={{ width: 140 }} value={radius} onChange={e => setRadius(+e.target.value)}>
                  {RADII.map(r => <option key={r} value={r}>{r < 1000 ? `${r} m` : `${r / 1000} km`}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                {hasGeofence && <button className="secondary-btn" onClick={clear} disabled={busy} style={{ color: 'hsl(var(--color-red))' }}>Remove geofence</button>}
                <button className="primary-btn" onClick={save} disabled={busy || !preview}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: preview ? 1 : 0.55 }}>
                  {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save location
                </button>
              </div>
            </>
          )}
          <style>{`@media (max-width:640px){.acc-grid{grid-template-columns:1fr !important}}`}</style>
        </>
      )}
    </div>
  );
}

// day.toISOString().slice(0,10) but in local time, not UTC - a UTC-based cut
// would flip to the wrong calendar day for anyone west of Greenwich.
function localIsoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function lastWeekRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  return [localIsoDate(start), localIsoDate(end)];
}

// Read-only log of a person's Beginning/End-of-day posts (Section: Time Clock's
// BOD/EOD composer). Source of truth stays in timeclock.py's TimeBod table;
// this only reads, newest first, so a manager doesn't have to scroll Teams to
// see what someone said they'd do and what was left pending. Defaults to the
// trailing week; the date filter pages back through older history. BOD and
// EOD render together on the same card for each day.
function WorkLogsSection({ employee }) {
  const [[start, end], setRange] = useState(lastWeekRange);
  const [logs, setLogs] = useState(null);
  const load = useCallback((quiet = false) => {
    if (!quiet) setLogs(null);
    api.getEmployeeBod(employee.id, start, end).then(r => setLogs(r.logs || []))
      .catch(() => { if (!quiet) setLogs([]); });   // a failed background poll keeps the last good data on screen
  }, [employee.id, start, end]);
  useEffect(() => { load(); }, [load]);
  // Live while viewing this range: a manager watching a report shouldn't have
  // to reopen the tab to see a punch that just landed. Quiet refresh (keeps
  // the current cards on screen) only while the range covers today, and only
  // while the tab is actually visible - same pattern as TimeClock's own poll.
  useEffect(() => {
    const today = localIsoDate(new Date());
    if (today < start || today > end) return undefined;
    return pollWhileVisible(() => load(true), 15000);
  }, [load, start, end]);

  // Group the flat, newest-first list into one card per local_date (BOD + EOD together).
  const byDate = [];
  for (const l of logs || []) {
    let group = byDate.find(g => g.date === l.date);
    if (!group) { group = { date: l.date, bod: null, eod: null }; byDate.push(group); }
    group[l.kind] = l;
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Clock size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Work logs (BOD/EOD)
        </span>
        <button className="secondary-btn" onClick={() => setRange(lastWeekRange())} style={{ fontSize: 11.5, padding: '4px 10px' }}>This week</button>
        <input className="form-input" type="date" value={start} onChange={ev => setRange([ev.target.value, end])} style={{ fontSize: 12, width: 140 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
        <input className="form-input" type="date" value={end} onChange={ev => setRange([start, ev.target.value])} style={{ fontSize: 12, width: 140 }} />
      </div>
      {logs === null ? (
        <SkeletonBlocks count={3} height={54} />
      ) : byDate.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {!employee.workEmail ? 'No work email yet - work logs key off it.' : 'No work logs posted in this date range.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {byDate.map(g => (
            <div key={g.date} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '11px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>{g.date}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {[['Beginning of day', g.bod, 'bod', 'Punched in'], ['End of day', g.eod, 'eod', 'Punched out']].map(([label, slot, kind, punchLabel]) => (
                  <div key={label} style={{ background: 'var(--mist)', borderRadius: 10, padding: '9px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>{label}</span>
                      {slot?.punchAt && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--wk-brand, var(--ink))' }} title={`${punchLabel} at ${punchTime(slot.punchAt)}`}>
                          {punchLabel} {punchTime(slot.punchAt)}
                        </span>
                      )}
                    </div>
                    {slot ? (<>
                      <div style={{ fontSize: 12.5, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{slot.message || <span style={{ color: 'var(--muted)' }}>(no message)</span>}</div>
                      <TaskChecklist tasks={slot.tasks} kind={kind} />
                    </>) : (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>-</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentsSection({ employeeId, toastOk, toastErr }) {
  const [docs, setDocs] = useState(null);
  const [kind, setKind] = useState('other');
  const [uploading, setUploading] = useState(false);
  useEffect(() => { api.getEmployeeDocs(employeeId).then(setDocs).catch(() => setDocs([])); }, [employeeId]);

  async function upload(file) {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      const doc = await api.uploadEmployeeDoc(employeeId, form);
      setDocs(prev => [doc, ...(prev || [])]);
      toastOk(`${file.name} uploaded.`);
    } catch (err) { toastErr(err?.message || 'Upload failed.'); }
    setUploading(false);
  }
  async function view(doc) {
    try { const { url } = await api.getDocUrl(doc.id); window.open(url, '_blank', 'noopener'); }
    catch (err) { toastErr(err?.message || 'Could not open document.'); }
  }
  async function remove(doc) {
    try { await api.deleteEmployeeDoc(doc.id); setDocs(prev => prev.filter(d => d.id !== doc.id)); toastOk('Document removed.'); }
    catch (err) { toastErr(err?.message || 'Could not delete.'); }
  }
  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <FileText size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Documents
        </span>
        <select className="form-input" value={kind} onChange={e => setKind(e.target.value)} style={{ padding: '3px 8px', fontSize: 11.5, height: 28 }}>
          {DOC_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="secondary-btn" style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '5px 12px' }}>
          {uploading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={12} />} Upload
          <input type="file" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {docs === null ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
        : docs.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No documents yet.</div>
        : docs.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px', color: 'var(--muted)', textTransform: 'uppercase', flexShrink: 0 }}>
              {d.kind}
            </span>
            <button onClick={() => view(d)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontWeight: 600, fontSize: 12.5, fontFamily: 'Inter,sans-serif', padding: 0, flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.fileName}
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 11, flexShrink: 0 }}>{fmtSize(d.sizeBytes)}</span>
            <button onClick={() => remove(d)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 3 }}><X size={13} /></button>
          </div>
        ))}
    </div>
  );
}

// ── Provisioning modal (Phase 4) ──────────────────────────────────────────────
const STEP_LABEL = {
  m365_user: 'Microsoft 365 account', m365_license: 'License + mailbox',
  m365_manager: 'Reporting line in Entra', asana: 'Asana', ignite: 'Ignite', welcome_email: 'Welcome email',
};
const STEP_COLOR = { ok: '--color-green', failed: '--color-red', manual: '--color-orange', skipped: null, pending: null };

function ProvisionModal({ employee: e, onClose, onDone, toastErr }) {
  const guess = `${(e.firstName || '').toLowerCase()}.${(e.lastName || '').toLowerCase()}`.replace(/\.+$/, '') + '@greensglobal.com';
  const [email, setEmail] = useState(e.workEmail || guess);
  // Usage location drives license compliance - guess India from the profile, else US
  const [usageLoc, setUsageLoc] = useState(() =>
    /india/i.test(`${e.location} ${e.department} ${e.notes}`) ? 'IN' : 'US');
  const [skus, setSkus] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    api.getProvisionSkus().then(rows => {
      setSkus(rows);
      // Pre-tick the standard new-hire license (Business Basic) when in stock
      setPicked(new Set(rows.filter(s => s.isDefault && s.available > 0).map(s => s.skuId)));
    }).catch(err => { setSkus([]); toastErr(err?.message || 'Could not load licenses.'); });
  }, [toastErr]);

  const togglePick = id => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.provisionEmployee(e.id, { work_email: email.trim(), license_sku_ids: [...picked], usage_location: usageLoc });
      setResult(res);
      onDone(res.employee);
    } catch (err) { toastErr(err?.message || 'Provisioning failed.'); }
    setBusy(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={ev => ev.target === ev.currentTarget && !busy && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 500, maxHeight: 'min(92dvh, 680px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Provision accounts - {fullName(e)}</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          {!result ? (<>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
              Creates the Microsoft 365 account (with a temp password shown once to you), assigns the license - which
              is what creates the Outlook mailbox - sets the Entra reporting line, and emails a welcome note to their
              personal address. Asana and Ignite stay manual checklist items for now.
            </p>
            <label style={FL}>WORK EMAIL (becomes their sign-in) *</label>
            <input className="form-input" style={{ width: '100%', marginBottom: 14 }} value={email} onChange={ev => setEmail(ev.target.value)} />
            <label style={FL}>USAGE LOCATION (where they'll use the license) *</label>
            <select className="form-input" style={{ width: '100%', marginBottom: 14 }} value={usageLoc} onChange={ev => setUsageLoc(ev.target.value)}>
              <option value="US">United States</option>
              <option value="IN">India</option>
            </select>
            <label style={FL}>LICENSES{picked.size > 0 ? ` (${picked.size} selected)` : ' - none selected: no mailbox'}</label>
            {skus === null ? <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /> : (
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 220, overflowY: 'auto' }}>
                {skus.map((s, i) => {
                  const out = s.available <= 0;
                  return (
                    <label key={s.skuId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: i > 0 ? '1px solid var(--line)' : 'none', cursor: out ? 'default' : 'pointer', opacity: out ? 0.5 : 1, userSelect: 'none' }}>
                      <input type="checkbox" disabled={out} checked={picked.has(s.skuId)} onChange={() => togglePick(s.skuId)}
                        style={{ cursor: out ? 'not-allowed' : 'pointer', accentColor: 'var(--pine)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {s.displayName || s.skuPartNumber}
                          {s.isDefault && <span style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', borderRadius: 20, padding: '1px 7px' }}>STANDARD</span>}
                        </div>
                        <div style={{ fontSize: 11, color: out ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                          {out ? 'No licenses available' : `${s.available} of ${s.total} available`}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </>) : (<>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {result.steps.map(s => (
                <div key={s.step} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13 }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 4, flexShrink: 0, background: STEP_COLOR[s.status] ? `hsl(var(${STEP_COLOR[s.status]}))` : 'var(--line)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{STEP_LABEL[s.step]}</span>
                    <span style={{ color: 'var(--muted)', marginLeft: 7, fontSize: 12 }}>
                      {s.status === 'manual' ? 'manual step' : s.status}{s.detail ? ` - ${s.detail}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {result.tempPassword && (
              <div style={{ marginTop: 16, background: 'hsla(var(--color-orange),0.08)', border: '1px solid hsla(var(--color-orange),0.35)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'hsl(var(--color-orange))', marginBottom: 5 }}>TEMP PASSWORD - SHOWN ONLY ONCE</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 14, fontWeight: 700 }}>{result.tempPassword}</code>
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 10px' }}
                    onClick={() => navigator.clipboard?.writeText(result.tempPassword)}>Copy</button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>Share it with {e.firstName} directly - they must change it on first sign-in. It is not stored anywhere.</div>
              </div>
            )}
          </>)}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          {!result ? (<>
            <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-btn" onClick={run} disabled={busy || !email.trim()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'hsl(var(--color-green))' }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />}
              {busy ? 'Provisioning…' : 'Provision now'}
            </button>
          </>) : <button className="primary-btn" onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// Profile photo editor now lives in components/PhotoEditorModal.jsx (shared
// with TopHeader -> MyProfileModal's self-service flow, which needs it
// without pulling this whole view into the always-loaded header bundle).

// ── Profile detail pane ───────────────────────────────────────────────────────
// Whole-month tenure from a start date, e.g. "2y 3m". Null if unknown/future.
function fmtTenure(startDate) {
  if (!startDate) return null;
  const d = new Date(startDate + 'T00:00:00'); if (isNaN(d)) return null;
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  if (months < 0) return null;
  const y = Math.floor(months / 12), m = months % 12;
  return y ? (m ? `${y}y ${m}m` : `${y}y`) : `${m}m`;
}

// The soonest date that matters for this person - right-to-work doc expiry or,
// for contractors, contract end. Returns { label, date, days } or null.
function nextExpiry(e) {
  const cands = [
    e.compliance?.expiryDate && { label: 'Doc expiry', date: e.compliance.expiryDate },
    e.employmentType === 'contractor' && e.contractor?.contract_end && { label: 'Contract end', date: e.contractor.contract_end },
  ].filter(Boolean).map(c => ({ ...c, days: daysUntil(c.date) })).filter(c => c.days !== null);
  if (!cands.length) return null;
  return cands.sort((a, b) => a.days - b.days)[0];
}

function StatCard({ label, value, sub, tone }) {
  const color = tone === 'red' ? 'hsl(var(--color-red))' : tone === 'orange' ? 'hsl(var(--color-orange))' : 'var(--ink)';
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 3, color, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  );
}

// Restricted read view of pay/benefits/bank; edit opens the full CompensationModal.
// reloadToken bumps after the modal closes so saved changes show without a reload.
function PayTab({ employee, reloadToken, onEdit }) {
  const [data, setData] = useState(null);
  const [stubs, setStubs] = useState([]);
  const [stubPeriod, setStubPeriod] = useState('');
  const [stubBusy, setStubBusy] = useState(false);
  const [stepLocked, setStepLocked] = useState(false);   // comp/bank need a fresh step-up
  const [suToken, setSuToken] = useState(0);
  const stubFileRef = useRef(null);
  useEffect(() => {
    let live = true;
    api.getCompensation(employee.id)
      .then(r => { if (live) { setStepLocked(false); setData({ comp: r.compensation || {}, bank: r.bank || [] }); } })
      .catch(e => {
        // Compensation/bank require a fresh step-up MFA - show the Verify gate.
        if (isStepUpRequired(e)) { if (live) setStepLocked(true); return; }
        if (live) setData({ comp: {}, bank: [] });
      });
    api.hrPaystubs(employee.id).then(r => { if (live) setStubs(r); }).catch(() => {});
    return () => { live = false; };
  }, [employee.id, reloadToken, suToken]);

  if (stepLocked) return <StepUpNeeded label="Compensation, bank and paystub details are confidential." onVerified={() => setSuToken(n => n + 1)} />;

  const uploadStub = async (file) => {
    if (!file) return;
    setStubBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('period', stubPeriod);
      const created = await api.hrPaystubUpload(employee.id, form);
      setStubs(s => [created, ...s]);
      setStubPeriod('');
    } catch { /* surfaced by list not changing */ }
    finally { setStubBusy(false); if (stubFileRef.current) stubFileRef.current.value = ''; }
  };
  const openStub = async (id) => {
    try { const { url } = await api.getDocUrl(id); window.open(url, '_blank', 'noopener'); } catch { /* noop */ }
  };
  const deleteStub = async (id) => {
    if (!await dialog.confirm('Delete this paystub?', { title: 'Delete paystub', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteEmployeeDoc(id); setStubs(s => s.filter(x => x.id !== id)); } catch { /* noop */ }
  };

  const money = (v, cur) => v ? `${cur === 'INR' ? '₹' : '$'}${Number(v).toLocaleString()}` : '-';
  const label = (list, v) => (list.find(([x]) => x === v) || [])[1] || v || '';
  const sectionLabel = txt => <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', margin: '16px 0 8px' }}>{txt}</div>;
  const row2 = (k, lbl, value) => (
    <div key={k} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 150, flexShrink: 0 }}>{lbl}</span>
      <span style={{ fontSize: 13.5, color: value ? 'var(--ink)' : 'var(--muted)' }}>{value || '-'}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, flex: 1 }}><Lock size={12} /> Restricted · compensation grant</span>
        <button className="secondary-btn" onClick={onEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Pencil size={13} /> Edit</button>
      </div>
      {!data ? (
        <SkeletonBlocks count={4} height={44} />
      ) : (
        <>
          {sectionLabel('Base pay')}
          {row2('base', 'Base', data.comp.base ? `${money(data.comp.base, data.comp.currency)} · ${label(PAY_BASIS, data.comp.payBasis)}` : '')}
          {row2('freq', 'Frequency', label(PAY_FREQ, data.comp.frequency))}
          {row2('eff', 'Effective', formatDate(data.comp.effectiveDate))}
          {sectionLabel('Benefits & deductions')}
          {(data.comp.benefits || []).length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>None recorded.</div>
            : data.comp.benefits.map((bn, i) => row2(`bn${i}`, label(BENEFIT_TYPES, bn.type), [bn.plan, bn.deduction && `${money(bn.deduction, data.comp.currency)}/paycheck`, bn.note].filter(Boolean).join(' · ')))}
          {sectionLabel('Bank accounts')}
          {data.bank.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>None recorded.</div>
            : data.bank.map((acc, i) => row2(`bk${i}`, acc.bankName || 'Account', [acc.holder, maskId(acc.number), acc.routingOrIfsc, label(BANK_TYPES, acc.type)].filter(Boolean).join(' · ')))}

          {sectionLabel('Paystubs')}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <input className="form-input" placeholder='Pay period, e.g. "Jun 16 – Jun 30, 2026"' value={stubPeriod}
              onChange={e => setStubPeriod(e.target.value)} style={{ flex: 1, minWidth: 200, fontSize: 12.5 }} />
            <input ref={stubFileRef} type="file" accept="application/pdf" style={{ display: 'none' }}
              onChange={e => uploadStub(e.target.files?.[0])} />
            <button className="secondary-btn" disabled={stubBusy} onClick={() => stubFileRef.current?.click()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {stubBusy ? 'Uploading…' : 'Upload PDF'}
            </button>
          </div>
          {stubs.length === 0
            ? <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>None uploaded. The employee sees these under My HR.</div>
            : stubs.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <FileText size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <button onClick={() => openStub(s.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', padding: 0 }}>
                  {s.fileName}
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.createdAt?.slice(0, 10)}</span>
                <button onClick={() => deleteStub(s.id)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// "Ask HR" inbox - employee self-service requests raised from My HR. Open ones
// surface at the top of the People tab; resolving notifies the employee and
// shows your response on their My HR screen.
function EmployeeRequestsPanel({ toastOk, toastErr }) {
  const [reqs, setReqs] = useState([]);
  const [resolving, setResolving] = useState(null);   // request id with the reply box open
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [filedKind, setFiledKind] = useState('other');
  const [filed, setFiled] = useState({});             // request id -> true once added to docs
  useEffect(() => { api.hrSelfRequests().then(setReqs).catch(() => {}); }, []);
  const open = reqs.filter(r => r.status === 'open');
  if (open.length === 0) return null;
  const TYPE_LABEL = { document: 'Document update', profile: 'Profile change', question: 'Question', other: 'Request' };
  const resolve = async (id) => {
    setBusy(true);
    try {
      await api.hrSelfRequestResolve(id, { response });
      setReqs(rs => rs.map(r => r.id === id ? { ...r, status: 'resolved', response } : r));
      setResolving(null); setResponse('');
      toastOk?.('Resolved - the employee has been notified');
    } catch (e) { toastErr?.(e?.message || 'Could not resolve'); }
    finally { setBusy(false); }
  };
  const viewAttachment = async (id) => {
    try { const { url } = await api.hrSelfRequestAttachmentUrl(id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open attachment'); }
  };
  const fileAttachment = async (id) => {
    try {
      await api.hrSelfRequestAttachToEmployee(id, filedKind);
      setFiled(p => ({ ...p, [id]: true }));
      toastOk?.("Added to the employee's documents");
    } catch (e) { toastErr?.(e?.message || 'Could not add to documents'); }
  };
  return (
    <div style={{ border: '1px solid hsla(var(--color-blue),0.25)', borderRadius: 12, background: 'hsla(var(--color-blue),0.03)', padding: '14px 16px', marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-blue))', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
        Employee requests - {open.length} open
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {open.map(r => (
          <div key={r.id} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{r.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}> · {TYPE_LABEL[r.type] || r.type} · {r.createdAt?.slice(0, 10)}</span>
                <div style={{ fontSize: 12.5, color: 'var(--ink)', marginTop: 3 }}>{r.message}</div>
                {r.attachmentName && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                    <button onClick={() => viewAttachment(r.id)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: 12, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0 }}>
                      <FileText size={12} /> {r.attachmentName}
                    </button>
                    {filed[r.id] ? (
                      <span style={{ fontSize: 11.5, color: 'hsl(var(--color-green))', fontWeight: 600 }}>✓ Added to their documents</span>
                    ) : (
                      <>
                        <select className="form-input" value={filedKind} onChange={e => setFiledKind(e.target.value)}
                          style={{ fontSize: 11.5, padding: '3px 22px 3px 8px', height: 'auto' }}>
                          <option value="id">ID</option>
                          <option value="contract">Contract</option>
                          <option value="certificate">Certificate</option>
                          <option value="resume">Resume</option>
                          <option value="other">Other</option>
                        </select>
                        <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 10px' }}
                          onClick={() => fileAttachment(r.id)}>
                          Add to Employee Documents
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {resolving !== r.id && (
                <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px', flexShrink: 0 }}
                  onClick={() => { setResolving(r.id); setResponse(''); }}>
                  Resolve
                </button>
              )}
            </div>
            {resolving === r.id && (
              <div style={{ marginTop: 8 }}>
                <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder="Reply to the employee (they see this on My HR)…" value={response}
                  onChange={e => setResponse(e.target.value)} autoFocus />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                  <button className="secondary-btn" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => setResolving(null)} disabled={busy}>Cancel</button>
                  <button className="primary-btn" style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => resolve(r.id)} disabled={busy}>
                    {busy ? 'Resolving…' : 'Mark resolved'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


// ── Access section on a person's card (admin-only) - the "assign it on the
// person's card" flow: pick their Job Role (sets tier + base access) + any extra
// groups, and see the resolved effective access. Backed by /jobroles/effective.
const _accBox = { border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--paper)' };
const _accLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };

function AccessPicker({ title, items, onPick, onClose, renderItem }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', zIndex: 1200, padding: 18 }}>
      <div onClick={ev => ev.stopPropagation()} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', width: 'min(440px,100%)', maxHeight: '80vh', overflow: 'auto', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{title}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        {items.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: 14, textAlign: 'center' }}>Nothing to add.</div>
          : items.map(it => (
            <button key={it.id} onClick={() => onPick(it)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', width: '100%', textAlign: 'left', marginBottom: 7, cursor: 'pointer' }}>
              {renderItem(it)}
            </button>
          ))}
      </div>
    </div>
  );
}

function EmployeeAccess({ email, identityType = 'internal', toastOk, toastErr, onChanged }) {
  const [data, setData] = useState(null);
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [pick, setPick] = useState(null);   // 'role' | 'group' | null
  const [scopes, setScopes] = useState([]);       // company sandbox for external/guest users
  const [entities, setEntities] = useState([]);
  const [addCo, setAddCo] = useState('');
  const [addHrCo, setAddHrCo] = useState('');   // company-scoped People admin picker (internal users)
  const load = () => api.getEffectiveAccess(email).then(setData).catch(() => setData({ tier: 'employee', job_role: null, extra_groups: [], modules: [] }));
  const loadScopes = () => api.getAccessScopes(email).then(setScopes).catch(() => setScopes([]));
  useEffect(() => { if (email) { setData(null); load(); loadScopes(); } }, [email]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.getJobRoles().then(setRoles).catch(() => {}); api.getGroups().then(gs => setGroups(gs.filter(g => !g.is_job_role))).catch(() => {}); api.getEntities().then(setEntities).catch(() => {}); }, []);
  const isExternal = identityType === 'external' || identityType === 'guest';

  if (!email) return <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '20px 4px' }}>This person has no work email yet - provision their account first to manage access.</div>;
  if (!data) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>;

  // onChanged refreshes the parent employee record too - assigning a job role
  // now also rewrites the person's job TITLE (server-side), so the card header
  // must re-read it, not just the access panel.
  const assign = async jr => { try { await api.assignJobRole(jr.id, email); setPick(null); toastOk(`Job role set to “${jr.name}” - their title now matches.`); load(); onChanged?.(); } catch (err) { toastErr(err?.message || 'Could not set job role.'); } };
  const addGroup = async g => { try { await api.addGroupMembers(g.id, [email]); setPick(null); toastOk(`Added “${g.name}”.`); load(); } catch (err) { toastErr(err?.message || 'Could not add group.'); } };
  const removeGroup = async g => { try { await api.removeGroupMember(g.id, email); toastOk(`Removed “${g.name}”.`); load(); } catch (err) { toastErr(err?.message || 'Could not remove.'); } };
  const held = new Set((data.extra_groups || []).map(g => g.id));
  const entityName = id => entities.find(en => en.id === id)?.name || id;
  const companyScopes = scopes.filter(s => s.scopeType === 'entity' && s.moduleId !== 'hr');
  const hrScopes = scopes.filter(s => s.scopeType === 'entity' && s.moduleId === 'hr');
  const scopedCoIds = new Set(companyScopes.map(s => s.scopeId));
  const hrCoIds = new Set(hrScopes.map(s => s.scopeId));
  const addScope = async () => { if (!addCo) return; try { setScopes(await api.addAccessScope(email, { module_id: 'company', scope_type: 'entity', scope_id: addCo })); setAddCo(''); toastOk(`Limited to ${entityName(addCo)}.`); } catch (err) { toastErr(err?.message || 'Could not add scope.'); } };
  const addHrScope = async () => { if (!addHrCo) return; try { setScopes(await api.addAccessScope(email, { module_id: 'hr', scope_type: 'entity', scope_id: addHrCo })); setAddHrCo(''); toastOk(`People access limited to ${entityName(addHrCo)}.`); } catch (err) { toastErr(err?.message || 'Could not add scope.'); } };
  const removeScope = async s => { try { setScopes(await api.deleteAccessScope(email, s.id)); toastOk(`Removed ${entityName(s.scopeId)} limit.`); } catch (err) { toastErr(err?.message || 'Could not remove scope.'); } };

  return (
    <div>
      <div className="acc-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={_accBox}>
          <div style={_accLabel}>Job role</div>
          {data.job_role ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>{data.job_role.name}</span><TierBadge tier={data.job_role.tier} />
            </div>
          ) : <div style={{ color: 'var(--muted)', fontSize: 13 }}>No job role assigned yet.</div>}
          {data.job_role?.description && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{data.job_role.description}</div>}
          <button className="secondary-btn" style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setPick('role')}>
            <Shield size={13} /> {data.job_role ? 'Change job role' : 'Set job role'}
          </button>
        </div>
        <div style={_accBox}>
          <div style={_accLabel}><span>Additional groups</span><span>{(data.extra_groups || []).length}</span></div>
          {(data.extra_groups || []).length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>None - access comes from the job role.</div>
            : (data.extra_groups || []).map(g => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>{g.name}</span>
                <button onClick={() => removeGroup(g)} title="Remove" style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
              </div>
            ))}
          <button className="secondary-btn" style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setPick('group')}>
            <Plus size={13} /> Add Group
          </button>
        </div>
      </div>

      <div style={{ ..._accLabel, margin: '22px 0 10px' }}>Effective access · {(data.modules || []).length} modules</div>
      {(data.modules || []).length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>No module access yet - set a job role above.</div> : (
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
          {(data.modules || []).map((m, i) => {
            const mod = MODULES.find(x => x.id === m.module);
            return (
              <div key={m.module} style={{ display: 'grid', gridTemplateColumns: '1fr auto 1.3fr', alignItems: 'start', gap: 10, padding: '10px 14px', borderBottom: i < data.modules.length - 1 ? '1px solid var(--line)' : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{mod?.label || m.module}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{capabilityText(m.module, m.level, mod?.label)}</div>
                </div>
                <LevelPill level={m.level} title={`${mod?.label || m.module} · ${MODULE_LEVELS[m.level]?.label || m.level}\n${capabilityText(m.module, m.level, mod?.label)}`} />
                <span style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right' }}>{m.manual ? <>added via <b style={{ color: 'var(--ink)' }}>{m.source}</b></> : 'via job role'}</span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Access = job-role bundle + any groups, taking the highest level per module.</div>

      {!isExternal && (
        <div style={{ ..._accBox, marginTop: 22 }}>
          <div style={_accLabel}><span>People admin companies</span><span>{hrScopes.length || 'all'}</span></div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 12px' }}>
            With none set, an HR grant covers <b>every</b> company. Add companies to limit this person's People, Time and Leave administration to just those - they won't see or change anyone else's records. Directory and task assignment stay company-wide.
          </div>
          {hrScopes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {hrScopes.map(s => (
                <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', borderRadius: 20, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                  {entityName(s.scopeId)}
                  <button onClick={() => removeScope(s)} title="Remove limit" aria-label={`Remove ${entityName(s.scopeId)}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 }}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="form-input" style={{ flex: 1 }} value={addHrCo} onChange={e => setAddHrCo(e.target.value)}>
              <option value="">- add a company -</option>
              {entities.filter(en => !hrCoIds.has(en.id)).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
            <button className="secondary-btn" onClick={addHrScope} disabled={!addHrCo} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: addHrCo ? 1 : 0.6 }}><Plus size={13} /> Limit</button>
          </div>
        </div>
      )}

      {isExternal && (
        <div style={{ ..._accBox, marginTop: 22, background: 'hsla(var(--color-orange),0.05)', borderColor: 'hsla(var(--color-orange),0.25)' }}>
          <div style={_accLabel}><span>Company access · external user</span><span>{companyScopes.length || 'all'}</span></div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 12px' }}>
            Limit this {identityType} user to specific companies. With none set, an <b>external</b> user sees nothing (fail-closed); a guest is unrestricted until you add a limit.
          </div>
          {companyScopes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {companyScopes.map(s => (
                <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', borderRadius: 20, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                  {entityName(s.scopeId)}
                  <button onClick={() => removeScope(s)} title="Remove limit" aria-label={`Remove ${entityName(s.scopeId)}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 }}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="form-input" style={{ flex: 1 }} value={addCo} onChange={e => setAddCo(e.target.value)}>
              <option value="">- add a company -</option>
              {entities.filter(en => !scopedCoIds.has(en.id)).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
            <button className="secondary-btn" onClick={addScope} disabled={!addCo} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: addCo ? 1 : 0.6 }}><Plus size={13} /> Limit</button>
          </div>
        </div>
      )}

      {pick === 'role' && <AccessPicker title="Choose a Job Role" items={roles} onClose={() => setPick(null)} onPick={assign}
        renderItem={jr => (<><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{jr.name}</div><div style={{ marginTop: 3 }}><TierBadge tier={jr.tier} /></div></div><span style={{ fontSize: 11, color: 'var(--muted)' }}>{jr.member_count} ppl</span></>)} />}
      {pick === 'group' && <AccessPicker title="Add a Group" items={groups.filter(g => !held.has(g.id))} onClose={() => setPick(null)} onPick={addGroup}
        renderItem={g => (<div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{g.name}</div><div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{(g.allowed_modules || []).map(mm => <ModuleLevelPill key={mm.id} moduleId={mm.id} level={mm.level} />)}</div></div>)} />}
      <style>{`@media (max-width:640px){.acc-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

// The external-lifecycle box on an external/guest person's People profile
// (invite state, Resend Invite, Deactivate/Reactivate, Remove). Reads the same
// admin endpoint the old External tab used, so behavior and copy stay one
// implementation (ExternalPersonSection).
function ExternalLifecycle({ e, toastOk, toastErr, onChanged, onRemoved }) {
  const [ext, setExt] = useState(null);
  const load = useCallback(() => {
    api.getExternalUsers().then(rows => {
      const em = (e.workEmail || '').toLowerCase();
      setExt((rows || []).find(r => (r.email || '').toLowerCase() === em) || null);
    }).catch(() => setExt(null));
  }, [e.workEmail]);
  useEffect(() => { load(); }, [load]);
  if (!ext) return null;
  return (
    <ExternalPersonSection ext={ext} toastOk={toastOk} toastErr={toastErr}
      onChanged={() => { load(); onChanged?.(); }} onRemoved={() => onRemoved?.()} />
  );
}

function EmployeeDetail({ e, employees, companyName = '', canSeeComp = false, isAdmin = false, onEdit, onBack, isMobile, toastOk, toastErr, onEmployeeUpdated, onRemoved, onRestored, onExternalChanged }) {
  // Removed from Nexus (soft delete) - the record is intact and restorable.
  const isRemoved = !!e.deletedAt;
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [compOpen, setCompOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [tab, setTab] = useState('overview');
  const [payReload, setPayReload] = useState(0);   // bump to refetch PayTab after an edit
  const [restoreBusy, setRestoreBusy] = useState(false);
  // Nexus-only removal - separate from offboarding (which deprovisions M365).
  // REVERSIBLE since Aug 11: the record is hidden, not destroyed, and the copy
  // says so. It used to warn that history would be deleted, which was true and
  // is the reason nobody dared use it.
  async function removeFromNexus() {
    if (!await dialog.confirm(
      `Remove ${fullName(e)} from Nexus? They disappear from the directory and everywhere else in Nexus, but nothing is deleted - you can restore them any time from the Deleted filter. It does NOT change or deprovision their Microsoft 365 account - use "Change status -> Left" for a full offboarding.`,
      { title: 'Remove from Nexus only', confirmText: 'Remove from Nexus', danger: true })) return;
    try {
      await api.deleteEmployee(e.id);
      toastOk(`${fullName(e)} removed from Nexus. Restore them any time from the Deleted filter.`);
      onRemoved?.(e.id);
    } catch (err) { toastErr(err?.message || 'Could not remove from Nexus.'); }
  }
  async function restoreToNexus() {
    setRestoreBusy(true);
    try {
      const restored = await api.restoreEmployee(e.id);
      toastOk(`${fullName(e)} restored to Nexus.`);
      onRestored?.(restored);
    } catch (err) { toastErr(err?.message || 'Could not restore this person.'); }
    setRestoreBusy(false);
  }
  const sm = STATUS_META[e.status] || STATUS_META.active;
  // Case-insensitive email match - manager_email is stored lowercased server-side
  // and the org chart matches the same way, so a reassignment there reflects here.
  const meEmail = (e.workEmail || '').toLowerCase();
  const mgrEmail = (e.managerEmail || '').toLowerCase();
  const manager = mgrEmail ? employees.find(m => (m.workEmail || '').toLowerCase() === mgrEmail) : null;
  const reports = meEmail ? employees.filter(r => (r.managerEmail || '').toLowerCase() === meEmail) : [];
  const row = (Icon, label, value) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: value ? 'var(--ink)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value || '-'}</span>
    </div>
  );
  const tabs = [
    ['overview', 'Overview', Contact],
    canSeeComp && ['pay', 'Pay & Benefits', Wallet],
    ['compliance', 'Compliance', ShieldCheck],
    ['assets', 'Assets', Briefcase],
    ['location', 'Location', MapPinned],
    ['documents', 'Documents', FileText],
    isAdmin && ['access', 'Access', Shield],
    ['bod', 'Work Logs', Clock],
  ].filter(Boolean);
  const expiry = nextExpiry(e);
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '22px 24px', boxShadow: 'var(--shadow-sm)' }}>
      {isMobile && (
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0, marginBottom: 14 }}>
          <ChevronLeft size={15} /> All People
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
        {/* Avatar opens the photo editor: view, re-crop with grid + zoom, or change */}
        <button title="View or change profile photo" onClick={() => setPhotoOpen(true)}
          style={{ position: 'relative', cursor: 'pointer', flexShrink: 0, background: 'none', border: 'none', padding: 0 }}>
          <Avatar e={e} size={56} card={false} />
          <span style={{ position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--card)' }}>
            <Camera size={11} />
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {fullName(e)}
            {e.identityType && e.identityType !== 'internal' && (
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 20, background: 'hsla(var(--color-orange),0.14)', color: 'hsl(var(--color-orange))' }}>
                {e.identityType === 'guest' ? 'Guest' : 'External'}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {[e.jobTitle, e.employeeCode].filter(Boolean).join(' · ')}
          </div>
        </div>
        {/* A removed person is read-only: Restore is the only way forward, so
            editing, status changes and provisioning are all withheld rather
            than left live on a record that is not currently in the company. */}
        {isRemoved ? (
          <>
            <span style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: 'hsla(var(--color-red),0.12)', color: 'hsl(var(--color-red))' }}>
              Removed
            </span>
            {isAdmin && (
              <button className="primary-btn" onClick={restoreToNexus} disabled={restoreBusy}
                title="Put this person back into Nexus with their full record"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <RotateCcw size={13} /> {restoreBusy ? 'Restoring…' : 'Restore to Nexus'}
              </button>
            )}
          </>
        ) : (
        <>
        <button onClick={() => setStatusOpen(true)} title="Change status (with reason)"
          style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: sm.bg, color: sm.fg, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {sm.label} <Pencil size={10} />
        </button>
        <button className="secondary-btn" onClick={() => onEdit(e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Pencil size={13} /> Edit
        </button>
        {isAdmin && (
          <button className="secondary-btn" onClick={removeFromNexus}
            title="Remove this person's Nexus record only - does not touch Microsoft 365"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'hsl(var(--color-red))', borderColor: 'hsla(var(--color-red),0.35)' }}>
            <Trash2 size={13} /> Remove from Nexus
          </button>
        )}
        {!e.m365Id ? (
          <button className="primary-btn" onClick={() => setProvisionOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'hsl(var(--color-green))' }}>
            <CheckCircle size={13} /> Provision Accounts
          </button>
        ) : (
          <>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' }}>M365 ✓</span>
            <button className="secondary-btn" disabled={pushBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
              title="Push name, title, department, phone, office (and manager) from Nexus back to their Entra account"
              onClick={async () => {
                setPushBusy(true);
                try {
                  const r = await api.pushToEntra(e.id);
                  const mgr = r.manager === true ? ' · manager' : '';
                  toastOk(`Pushed ${r.written.length} fields${mgr} to M365.`);
                } catch (err) { toastErr(err?.message || 'Could not push to M365.'); }
                setPushBusy(false);
              }}>
              {pushBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Network size={13} />} Push to M365
            </button>
            {e.personalEmail && (
              <button className="secondary-btn" disabled={welcomeBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
                title="Send the branded welcome email to their personal address again"
                onClick={async () => {
                  setWelcomeBusy(true);
                  try { const r = await api.resendWelcome(e.id); toastOk(`Welcome email sent to ${r.sentTo}.`); }
                  catch (err) { toastErr(err?.message || 'Could not send welcome email.'); }
                  setWelcomeBusy(false);
                }}>
                {welcomeBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Mail size={13} />} Resend welcome
              </button>
            )}
          </>
        )}
        </>
        )}
      </div>
      {isRemoved && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'hsla(var(--color-red),0.08)', border: '1px solid hsla(var(--color-red),0.25)', fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.55 }}>
          Removed from Nexus{e.deletedBy ? ` by ${e.deletedBy}` : ''}
          {e.deletedAt ? ` on ${formatDate(e.deletedAt)}` : ''}. Their record is kept in full and
          nothing was deleted. Their Microsoft 365 account was never changed.
        </div>
      )}
      {/* Stat cards - all derived from the loaded record, no extra fetch */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <StatCard label="Tenure" value={fmtTenure(e.startDate) || '-'} sub={e.startDate ? `since ${formatDate(e.startDate)}` : 'no start date'} />
        <StatCard label="Direct reports" value={reports.length} sub={manager ? `reports to ${fullName(manager)}` : 'no manager'} />
        <StatCard label="Type" value={TYPE_LABEL[e.employmentType] || '-'} sub={e.department || '-'} />
        {expiry
          ? <StatCard label={expiry.label} value={expiry.days < 0 ? 'Expired' : `${expiry.days}d`} sub={formatDate(expiry.date)} tone={expiry.days < 0 ? 'red' : expiry.days <= 60 ? 'orange' : undefined} />
          : <StatCard label="Compliance" value="Clear" sub="no upcoming expiry" />}
      </div>

      {/* External/guest lifecycle - lives on the profile now that the People
          directory is the master list (Neil, Aug 24). Admin-only, matching the
          endpoint behind it. */}
      {isAdmin && !isRemoved && ['guest', 'external'].includes(e.identityType || 'internal') && (
        <ExternalLifecycle e={e} toastOk={toastOk} toastErr={toastErr}
          onChanged={onExternalChanged} onRemoved={() => onRemoved?.(e.id)} />
      )}

      {/* Tab strip */}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 4, marginTop: 18, borderBottom: '1px solid var(--line)' }}>
        {tabs.map(([id, tlabel, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', background: 'none', border: 'none', borderBottom: `2px solid ${tab === id ? 'var(--pine)' : 'transparent'}`, color: tab === id ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1 }}>
            <Icon size={14} /> {tlabel}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {tab === 'overview' && (
          <>
            <div>
              {row(Mail, 'Work email', e.workEmail)}
              {row(Mail, 'Personal', e.personalEmail)}
              {row(Phone, 'Phone', e.phone)}
              {e.designation && row(Briefcase, 'Designation', e.designation)}
              {row(Briefcase, 'Department', [e.department, TYPE_LABEL[e.employmentType]].filter(Boolean).join(' · '))}
              {companyName && row(Building2, 'Company', companyName)}
              {row(CalendarOff, 'Start date', formatDate(e.startDate))}
              {row(MapPin, 'Location', e.location)}
              {e.employmentType === 'contractor' && e.contractor?.billing_client && row(Briefcase, 'Billing client', e.contractor.billing_client)}
              {e.employmentType === 'contractor' && e.contractor?.contract_end && row(CalendarOff, 'Contract end', formatDate(e.contractor.contract_end))}
              {e.employmentType === 'contractor' && e.contractor?.rate && row(FileText, 'Rate', [e.contractor.rate, e.contractor.currency, e.contractor.rate_type].filter(Boolean).join(' '))}
              {row(Network, 'Reports to', manager ? `${fullName(manager)} (${manager.employeeCode})` : e.managerEmail)}
              {reports.length > 0 && row(Users, 'Direct reports', reports.map(fullName).join(', '))}
              {e.notes && row(FileText, 'Notes', e.notes)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 2px' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
                <Contact size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Personal details
              </span>
              <button className="secondary-btn" onClick={() => setPersonalOpen(true)} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
                <Pencil size={12} /> Edit
              </button>
            </div>
            <div>
              {row(CalendarDays, 'Date of birth', formatDate(e.personal?.dob))}
              {row(Lock, 'National ID', e.personal?.nationalId ? maskId(e.personal.nationalId) : '')}
              {row(Heart, 'Emergency contact', e.personal?.emergency?.name ? [e.personal.emergency.name, e.personal.emergency.relationship && `(${e.personal.emergency.relationship})`, e.personal.emergency.phone].filter(Boolean).join(' · ') : '')}
            </div>
          </>
        )}

        {tab === 'pay' && canSeeComp && (
          <PayTab employee={e} reloadToken={payReload} onEdit={() => setCompOpen(true)} />
        )}

        {tab === 'compliance' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>Right-to-work &amp; compliance</span>
              <button className="secondary-btn" onClick={() => setComplianceOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <Pencil size={13} /> Edit
              </button>
            </div>
            <div>
              {row(ShieldCheck, 'Work auth', e.compliance?.workAuth ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {WORK_AUTH.find(([v]) => v === e.compliance.workAuth)?.[1] || e.compliance.workAuth}
                  {(() => { const m = VERIFY_STATUS[e.compliance.status || 'unverified']; return <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 700, background: m.bg, color: m.fg }}>{m.label}</span>; })()}
                </span>
              ) : '')}
              {row(FileText, 'Document', [DOC_TYPES.find(([v]) => v === e.compliance?.docType)?.[1], e.compliance?.docNumber].filter(Boolean).join(' · '))}
              {row(CalendarDays, 'Issued', e.compliance?.issueDate)}
              {e.compliance?.expiryDate ? (() => {
                const d = daysUntil(e.compliance.expiryDate); const warn = d !== null && d <= 60;
                return row(warn ? AlertTriangle : CalendarDays, 'Doc expiry', (
                  <span style={{ color: warn ? (d < 0 ? 'hsl(var(--color-red))' : 'hsl(var(--color-orange))') : 'inherit', fontWeight: warn ? 700 : 400 }}>
                    {e.compliance.expiryDate}{d !== null && (d < 0 ? ' · expired' : ` · in ${d}d`)}
                  </span>
                ));
              })() : row(CalendarDays, 'Doc expiry', '')}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', margin: '16px 0 8px' }}>Consents</div>
            {CONSENTS.map(([k, clabel]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 }}>
                {e.compliance?.consents?.[k] ? <CheckCircle size={15} style={{ color: 'hsl(var(--color-green))' }} /> : <XCircle size={15} style={{ color: 'var(--muted)' }} />}
                <span style={{ color: e.compliance?.consents?.[k] ? 'var(--ink)' : 'var(--muted)' }}>{clabel}</span>
              </div>
            ))}
          </>
        )}

        {tab === 'assets' && <AssetsSection employee={e} />}

        {tab === 'location' && <GeofenceSection employee={e} toastOk={toastOk} toastErr={toastErr} />}

        {tab === 'access' && isAdmin && <EmployeeAccess email={meEmail} identityType={e.identityType} toastOk={toastOk} toastErr={toastErr} onChanged={onEmployeeUpdated} />}

        {tab === 'bod' && <WorkLogsSection employee={e} />}

        {tab === 'documents' && (
          <>
            <DocumentsSection employeeId={e.id} toastOk={toastOk} toastErr={toastErr} />
            {/* The person's wired Egnyte folder (Neil, Aug 6): hiring package,
                invoices, payment proofs live in Egnyte, not as Nexus uploads.
                Resolution + re-pointing happen in Egnyte - Wiring. */}
            {e.workEmail && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>Egnyte Folder</div>
                <EgnytePersonFolder email={e.workEmail} personName={fullName(e)} />
              </div>
            )}
            <MailboxExportSection employee={e} toastOk={toastOk} toastErr={toastErr} />
          </>
        )}
      </div>
      {photoOpen && (
        <PhotoEditorModal employee={e} toastOk={toastOk} toastErr={toastErr}
          onClose={() => setPhotoOpen(false)} onSaved={onEmployeeUpdated} />
      )}
      {provisionOpen && (
        <ProvisionModal employee={e} toastErr={toastErr}
          onClose={() => setProvisionOpen(false)}
          onDone={updated => { onEmployeeUpdated(updated); toastOk(`${fullName(e)} provisioned.`); }} />
      )}
      {compOpen && (
        <CompensationModal employee={e} toastOk={toastOk} toastErr={toastErr} onClose={() => { setCompOpen(false); setPayReload(n => n + 1); }} />
      )}
      {personalOpen && (
        <PersonalModal employee={e} toastOk={toastOk} toastErr={toastErr} onClose={() => setPersonalOpen(false)} onSaved={onEmployeeUpdated} />
      )}
      {complianceOpen && (
        <ComplianceModal employee={e} toastOk={toastOk} toastErr={toastErr} onClose={() => setComplianceOpen(false)} onSaved={onEmployeeUpdated} />
      )}
      {statusOpen && (
        <StatusChangeModal employee={e} employees={employees} toastOk={toastOk} toastErr={toastErr} onClose={() => setStatusOpen(false)} onSaved={onEmployeeUpdated} />
      )}
    </div>
  );
}

// ── Hiring pipeline (Phase 2) ─────────────────────────────────────────────────
const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired'];
const STAGE_META = {
  applied:   { label: 'Applied',   hue: '215,15%,55%' },
  screening: { label: 'Screening', hue: '215,75%,45%' },
  interview: { label: 'Interview', hue: '30,80%,48%' },
  offer:     { label: 'Offer',     hue: '271,60%,48%' },
  hired:     { label: 'Hired',     hue: '142,60%,35%' },
  rejected:  { label: 'Rejected',  hue: '350,65%,48%' },
};
const candName = c => [c.firstName, c.lastName].filter(Boolean).join(' ');
const daysSince = iso => Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));

function CandidateFormModal({ onClose, onSaved, toastErr }) {
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', phone: '', role_title: '', department: '', expected_start: '', source: '', company: '', notes: '' });
  const [busy, setBusy] = useState(false);
  // Companies come server-filtered: a company-scoped admin only sees (and can
  // only pick) their own, and the backend refuses anything else anyway.
  const [entities, setEntities] = useState([]);
  useEffect(() => { api.getEntities().then(setEntities).catch(() => {}); }, []);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  async function save() {
    if (!f.first_name.trim() || busy) return;
    setBusy(true);
    try { onSaved(await api.createCandidate(f)); onClose(); }
    catch (err) { toastErr(err?.message || 'Could not add candidate.'); setBusy(false); }
  }
  const input = (label, key, props = {}) => (
    <div><label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} /></div>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: 'min(92dvh, 680px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Add Candidate</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {input('FIRST NAME *', 'first_name', { autoFocus: true })}
          {input('LAST NAME', 'last_name')}
          {input('EMAIL', 'email', { type: 'email' })}
          {input('PHONE', 'phone')}
          {input('ROLE APPLYING FOR', 'role_title')}
          {input('DEPARTMENT', 'department', { placeholder: 'target area - set for real on hire' })}
          {input('EXPECTED START', 'expected_start', { type: 'date' })}
          {input('SOURCE', 'source', { placeholder: 'Referral, LinkedIn…' })}
          <div><label style={FL}>HIRING COMPANY</label>
            <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={e => set('company', e.target.value)}>
              <option value="">- pick a company -</option>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>NOTES</label>
            <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!f.first_name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />} Add Candidate
          </button>
        </div>
      </div>
    </div>
  );
}

function CandidateDetailModal({ candidate: c, onClose, onStage, onSendForSignature, onUpdated, onOpenInterviews, busy }) {
  const [history, setHistory] = useState(null);
  const [note, setNote] = useState('');
  const [ivEdit, setIvEdit] = useState(false);
  const [ivAt, setIvAt] = useState(c.interviewAt ? c.interviewAt.slice(0, 16) : '');
  const [ivBusy, setIvBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeRef = useRef(null);
  useEffect(() => { api.getCandidateHistory(c.id).then(setHistory).catch(() => setHistory([])); }, [c.id]);
  const idx = STAGES.indexOf(c.stage);
  const next = idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
  const terminal = c.stage === 'hired' || c.stage === 'rejected';
  const sm = STAGE_META[c.stage];

  const saveInterview = async (value) => {
    setIvBusy(true);
    try { const u = await api.updateCandidate(c.id, { interview_at: value }); onUpdated?.(u); setIvEdit(false); }
    catch { /* keep editor open */ }
    finally { setIvBusy(false); }
  };
  const uploadResume = async (file) => {
    if (!file) return;
    setResumeBusy(true);
    try { const u = await api.candidateResumeUpload(c.id, (() => { const f = new FormData(); f.append('file', file); return f; })()); onUpdated?.(u); }
    catch { /* noop */ }
    finally { setResumeBusy(false); if (resumeRef.current) resumeRef.current.value = ''; }
  };
  const viewResume = async () => {
    try { const { url } = await api.candidateResumeUrl(c.id); window.open(url, '_blank', 'noopener'); } catch { /* noop */ }
  };
  const prettyIv = c.interviewAt ? (() => {
    try { return new Date(c.interviewAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return c.interviewAt; }
  })() : '';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 540, maxHeight: 'min(92dvh, 720px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{candName(c)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>{[c.roleTitle, c.department, c.source].filter(Boolean).join(' · ')}</div>
          </div>
          <span style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: `hsla(${sm.hue},0.12)`, color: `hsl(${sm.hue})`, flexShrink: 0 }}>{sm.label}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 24px' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {c.email && <span><Mail size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />{c.email}</span>}
            {c.phone && <span><Phone size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />{c.phone}</span>}
            {c.expectedStart && <span><CalendarDays size={12} style={{ verticalAlign: 'middle', marginRight: 6 }} />Expected start {c.expectedStart}</span>}
            {c.notes && <span style={{ background: 'var(--mist)', borderRadius: 8, padding: '8px 12px', color: 'var(--ink)', marginTop: 4 }}>{c.notes}</span>}
          </div>
          {/* Interview + resume */}
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <CalendarDays size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              {!ivEdit ? (
                <>
                  <span style={{ fontSize: 12.5, color: c.interviewAt ? 'var(--ink)' : 'var(--muted)', fontWeight: c.interviewAt ? 600 : 400 }}>
                    {c.interviewAt ? `Interview: ${prettyIv}` : 'No interview scheduled'}
                  </span>
                  {!terminal && (
                    <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => { setIvAt(c.interviewAt ? c.interviewAt.slice(0, 16) : ''); setIvEdit(true); }}>
                      {c.interviewAt ? 'Reschedule' : 'Schedule interview'}
                    </button>
                  )}
                  {c.interviewAt && !terminal && (
                    <button onClick={() => saveInterview('')} disabled={ivBusy}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)', fontFamily: 'Inter,sans-serif', padding: 0 }}>
                      Clear
                    </button>
                  )}
                </>
              ) : (
                <>
                  <input type="datetime-local" className="form-input" value={ivAt} onChange={e => setIvAt(e.target.value)}
                    style={{ fontSize: 12.5, padding: '5px 9px', height: 'auto' }} />
                  <button className="primary-btn" style={{ fontSize: 11.5, padding: '5px 12px' }} disabled={!ivAt || ivBusy} onClick={() => saveInterview(ivAt)}>
                    {ivBusy ? 'Saving…' : 'Save'}
                  </button>
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '5px 10px' }} onClick={() => setIvEdit(false)}>Cancel</button>
                </>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <FileText size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              {c.resumeUrl ? (
                <button onClick={viewResume}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-blue))', fontFamily: 'Inter,sans-serif', padding: 0 }}>
                  View Resume
                </button>
              ) : (
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No resume on file</span>
              )}
              <input ref={resumeRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={e => uploadResume(e.target.files?.[0])} />
              <button className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} disabled={resumeBusy} onClick={() => resumeRef.current?.click()}>
                {resumeBusy ? 'Uploading…' : c.resumeUrl ? 'Replace' : 'Upload resume'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {onOpenInterviews && !['rejected', 'hired'].includes(c.stage) && (
              <button className="primary-btn" onClick={() => onOpenInterviews(c)}
                title="Teams invite, live questionnaire, AI answer fill and calibrated scoring"
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <CalendarDays size={13} /> Interview Room
              </button>
            )}
            {c.email && onSendForSignature && c.stage !== 'rejected' && (
              <button className="secondary-btn" onClick={() => { onSendForSignature(c); onClose(); }}
                title="Send an offer letter or other document to this candidate via a secure e-sign link (no login needed)"
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FileText size={13} /> Send for Signature
              </button>
            )}
          </div>
          {/* Stage history timeline */}
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              <History size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Stage history
            </div>
            {history === null ? (
              <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
            ) : history.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 12.5, borderBottom: '1px solid var(--line)' }}>
                <span style={{ fontWeight: 700, color: `hsl(${(STAGE_META[h.toStage] || STAGE_META.applied).hue})`, flexShrink: 0 }}>
                  {(STAGE_META[h.toStage] || { label: h.toStage }).label}
                </span>
                <span style={{ color: 'var(--muted)', flex: 1 }}>{h.note}</span>
                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{new Date(h.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
            ))}
          </div>
          {!terminal && (
            <div style={{ marginTop: 16 }}>
              <label style={FL}>NOTE FOR THIS MOVE (optional)</label>
              <input className="form-input" style={{ width: '100%' }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Round 2 cleared, strong references" />
            </div>
          )}
        </div>
        {!terminal && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', flexShrink: 0 }}>
            <button onClick={() => onStage(c, 'rejected', note)} disabled={busy}
              style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'Inter,sans-serif' }}>
              <XCircle size={13} /> Reject
            </button>
            {next && (
              <button className="primary-btn" onClick={() => onStage(c, next, note)} disabled={busy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: next === 'hired' ? 'hsl(var(--color-green))' : undefined }}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : next === 'hired' ? <CheckCircle size={14} /> : <ChevronRight size={14} />}
                {next === 'hired' ? 'Mark Hired' : `Move to ${STAGE_META[next].label}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HiringTab({ isMobile, toastOk, toastErr, onEmployeeCreated, onSendForSignature }) {
  const [candidates, setCandidates] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [qOpen, setQOpen] = useState(false);        // questionnaires manager
  const [lbOpen, setLbOpen] = useState(false);      // interview leaderboard
  const [ivFor, setIvFor] = useState(null);         // candidate for the interview room
  const [loadErr, setLoadErr] = useState(false);

  const loadCandidates = useCallback(() => {
    setLoadErr(false); setCandidates(null);
    api.getCandidates().then(setCandidates).catch(() => setLoadErr(true));
  }, []);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  async function moveStage(c, stage, note) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.updateCandidate(c.id, { stage, stage_note: note || '' });
      setCandidates(prev => prev.map(x => x.id === c.id ? updated : x));
      setDetail(null);
      if (stage === 'hired') {
        toastOk(`${candName(c)} hired - added to People as Onboarding (${updated.createdEmployee?.employeeCode || ''}).`);
        if (updated.createdEmployee) onEmployeeCreated(updated.createdEmployee);
      } else if (stage === 'rejected') toastOk(`${candName(c)} marked rejected.`);
      else toastOk(`${candName(c)} → ${STAGE_META[stage].label}.`);
    } catch (err) { toastErr(err?.message || 'Could not update stage.'); }
    setBusy(false);
  }

  if (loadErr) return <ErrorBanner message="Couldn't load candidates right now." onRetry={loadCandidates} />;
  if (candidates === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>;

  const open = candidates.filter(c => !['hired', 'rejected'].includes(c.stage));
  const closed = candidates.filter(c => ['hired', 'rejected'].includes(c.stage));
  const byStage = s => candidates.filter(c => c.stage === s);

  const card = c => {
    const hue = hueFor({ employeeCode: c.id });
    return (
      <button key={c.id} onClick={() => setDetail(c)}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 13px', marginBottom: 8, boxShadow: 'var(--shadow-sm)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: `hsla(${hue},0.13)`, color: `hsl(${hue})`, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {`${(c.firstName || '?')[0]}${(c.lastName || '')[0] || ''}`.toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candName(c)}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.roleTitle || c.department || '-'}</div>
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{daysSince(c.updatedAt)}d</span>
        </div>
        {(c.interviewAt || c.interviewScore != null) && !['hired', 'rejected'].includes(c.stage) && (
          <div style={{ marginTop: 7, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {c.interviewAt && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: 'hsla(var(--color-purple),0.1)', color: 'hsl(var(--color-purple))' }}>
                <CalendarDays size={10} />
                {(() => { try { return new Date(c.interviewAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return c.interviewAt; } })()}
              </span>
            )}
            {c.interviewScore != null && (
              <span title="Calibrated interview score (0–100)"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 12,
                  background: c.interviewScore >= 70 ? 'hsla(var(--color-green),0.12)' : c.interviewScore >= 45 ? 'hsla(var(--color-orange),0.12)' : 'hsla(var(--color-red),0.12)',
                  color: c.interviewScore >= 70 ? 'hsl(var(--color-green))' : c.interviewScore >= 45 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))' }}>
                🏆 {c.interviewScore}
              </span>
            )}
          </div>
        )}
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setQOpen(true)}>Questionnaires</button>
          <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setLbOpen(true)}>Leaderboard</button>
          <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setShowClosed(s => !s)}>
            {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
          </button>
          <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add Candidate
          </button>
        </div>
      </div>

      {/* Pipeline stats */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
        {[['card-blue', 'In pipeline', open.length, 'Applied → Offer'],
          ['card-orange', 'Interviews booked', candidates.filter(c => c.interviewAt && !['hired', 'rejected'].includes(c.stage)).length, 'Teams invites out'],
          ['card-purple', 'Offers out', byStage('offer').length, 'Awaiting decision'],
          ['card-green', 'Hired', byStage('hired').length, 'Became employees']].map(([cls, label, value, sub]) => (
          <div key={label} className={`kpi-card ${cls}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-delta">{sub}</div>
          </div>
        ))}
      </div>

      {candidates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <UserPlus size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>No candidates yet.</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Add one and walk them through Applied → Hired - hiring creates the employee record automatically.</div>
        </div>
      ) : isMobile ? (
        /* Phone: stage-grouped stacks, same data as the desktop board */
        <div>
          {[...STAGES.slice(0, 4), ...(showClosed ? ['hired', 'rejected'] : [])].map(s => {
            const items = byStage(s);
            if (!items.length) return null;
            return (
              <div key={s} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 8px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${STAGE_META[s].hue})` }} />
                  <b style={{ fontSize: 11.5, letterSpacing: '.06em', textTransform: 'uppercase' }}>{STAGE_META[s].label}</b>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 20, padding: '1px 8px', color: 'var(--muted)' }}>{items.length}</span>
                </div>
                {items.map(card)}
              </div>
            );
          })}
        </div>
      ) : (
        /* Desktop: kanban lanes - full height so the board reads as a board */
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${showClosed ? 6 : 4}, 1fr)`, gap: 12, alignItems: 'stretch' }}>
          {[...STAGES.slice(0, 4), ...(showClosed ? ['hired', 'rejected'] : [])].map(s => {
            const items = byStage(s);
            return (
              <div key={s} style={{ background: 'rgba(255,255,255,0.55)', border: '1px solid var(--line)', borderRadius: 14, padding: 10,
                minHeight: 'max(420px, calc(100vh - 470px))', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 10px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${STAGE_META[s].hue})` }} />
                  <b style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase' }}>{STAGE_META[s].label}</b>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 20, padding: '0 7px', color: 'var(--muted)' }}>{items.length}</span>
                </div>
                {items.map(card)}
                {items.length === 0 && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px dashed var(--line)', borderRadius: 10, margin: '2px 2px 4px', minHeight: 90 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', opacity: 0.8 }}>No one in {STAGE_META[s].label.toLowerCase()}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {addOpen && <CandidateFormModal onClose={() => setAddOpen(false)} toastErr={toastErr}
        onSaved={c => { setCandidates(prev => [c, ...prev]); toastOk(`${candName(c)} added to the pipeline.`); }} />}
      {detail && <CandidateDetailModal candidate={detail} onClose={() => setDetail(null)} onStage={moveStage} onSendForSignature={onSendForSignature} busy={busy}
        onOpenInterviews={cand => { setDetail(null); setIvFor(cand); }}
        onUpdated={u => { setCandidates(prev => prev.map(x => x.id === u.id ? u : x)); setDetail(u); }} />}
      {qOpen && <QuestionnairesModal onClose={() => setQOpen(false)} toastOk={toastOk} toastErr={toastErr} />}
      {lbOpen && <LeaderboardModal onClose={() => setLbOpen(false)} toastOk={toastOk} toastErr={toastErr} />}
      {ivFor && <InterviewPanel candidate={ivFor} onClose={() => { setIvFor(null); api.getCandidates().then(setCandidates).catch(() => {}); }} toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}

// ── Org chart (Phase 5) - top-down node chart on a pan/zoom canvas ────────────
// Functional divisions colour the chart: a person's division is their own
// head-tag if set, else inherited from the nearest tagged manager above them.
// A fixed palette keeps each division's colour stable across renders.
const DIVISION_PALETTE = [
  '212 90% 52%',   // blue
  '150 60% 40%',   // green
  '270 68% 58%',   // purple
  '26 88% 52%',    // orange
  '338 74% 56%',   // pink
  '188 72% 40%',   // teal
  '45 88% 48%',    // amber
  '0 72% 56%',     // red
];
const divColorFor = (name, names) => {
  if (!name) return '';
  const i = names.indexOf(name);
  return DIVISION_PALETTE[(i < 0 ? 0 : i) % DIVISION_PALETTE.length];
};

// A single node card - minimal, fixed-width, avatar-forward, with a coloured
// division accent bar down its left edge. The reports pill hangs off the bottom
// edge and doubles as the collapse toggle. data-orgcard lets the canvas tell a
// card press from a pan; data-email lets drop resolve the target across the
// zoom transform.
function OrgNodeCard({ e, kids, isCollapsed, onToggle, onSelect, dnd, entityName, highlight, divName, divColor, isHead, dim, onUnlink = null }) {
  const email = (e.workEmail || '').toLowerCase();
  const isTarget = dnd.overKey === email && dnd.draggingId && dnd.draggingId !== e.id;
  const isDragging = dnd.draggingId === e.id;
  return (
    <div data-orgcard="1" data-email={email} style={{ position: 'relative', paddingBottom: kids > 0 ? 12 : 0 }}>
      {/* × = take this person out of the reporting line (Visesh, Aug 11) - the
          direct alternative to dragging them into open space. Outside the
          overflow-hidden card so it can sit on the corner. */}
      {onUnlink && !isDragging && (
        <button
          title="Remove from the reporting line"
          aria-label={`Remove ${fullName(e)} from the reporting line`}
          onPointerDown={ev => ev.stopPropagation()}
          onClick={ev => { ev.stopPropagation(); onUnlink(e); }}
          style={{ position: 'absolute', top: -7, right: -7, zIndex: 2, width: 20, height: 20, borderRadius: '50%',
            border: '1.5px solid var(--line)', background: 'var(--card)', color: 'var(--muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
            boxShadow: 'var(--shadow-sm)' }}>
          <X size={11} />
        </button>
      )}
      <div
        onPointerDown={ev => dnd.onCardPointerDown(ev, e)}
        style={{
          position: 'relative', width: 216, padding: '12px 14px 12px 18px', display: 'flex', alignItems: 'center', gap: 11,
          background: isTarget ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
          border: `1.5px solid ${isTarget ? 'hsl(var(--color-green))' : highlight ? 'hsl(var(--color-blue))' : 'var(--line)'}`,
          borderRadius: 14, boxShadow: highlight ? '0 0 0 3px hsla(var(--color-blue),0.15)' : 'var(--shadow-sm)',
          cursor: 'grab', opacity: dim ? 0.3 : isDragging ? 0.4 : 1, overflow: 'hidden',
          touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
          transition: 'border-color 0.1s, box-shadow 0.1s, opacity 0.12s',
        }}>
        {divColor && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: `hsl(${divColor})` }} />}
        <Avatar e={e} size={40} card={false} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName(e)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.jobTitle || '-'}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)', opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[e.department, entityName(e.company)].filter(Boolean).join(' · ')}
          </div>
          {isHead && divName && (
            <span style={{ display: 'inline-block', marginTop: 3, fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: `hsl(${divColor})`, background: `hsla(${divColor},0.12)`, borderRadius: 6, padding: '1px 6px' }}>
              {divName} lead
            </span>
          )}
        </div>
      </div>
      {kids > 0 && (
        <button onClick={ev => { ev.stopPropagation(); onToggle(email); }}
          title={isCollapsed ? 'Show team' : 'Hide team'}
          style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 11px', borderRadius: 20,
            border: '1.5px solid var(--line)', background: isCollapsed ? 'var(--mist)' : 'var(--card)',
            fontSize: 10.5, fontWeight: 800, color: 'hsl(var(--color-blue))', cursor: 'pointer',
            fontFamily: 'Inter,sans-serif', boxShadow: 'var(--shadow-sm)', whiteSpace: 'nowrap' }}>
          {kids}
          <ChevronRight size={11} style={{ transform: isCollapsed ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform 0.12s' }} />
        </button>
      )}
    </div>
  );
}

// Recursive top-down layout with pure-div connectors: parent stub → sibling
// rail (outer halves transparent at the ends) → child stub.
function OrgTreeNode({ e, ctx }) {
  const email = (e.workEmail || '').toLowerCase();
  const kids = ctx.visChildren.get(email) || [];
  const open = kids.length > 0 && !ctx.collapsedSet.has(email);
  const div = ctx.divisionOf(e);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <OrgNodeCard e={e} kids={kids.length} isCollapsed={ctx.collapsedSet.has(email)}
        onToggle={ctx.toggle} onSelect={ctx.setSelected} dnd={ctx.dnd}
        entityName={ctx.entityName} highlight={ctx.isHighlight(e)}
        divName={div} divColor={ctx.divColor(div)} isHead={!!(e.division || '').trim()}
        dim={ctx.activeDiv && div !== ctx.activeDiv}
        onUnlink={e.managerEmail ? ctx.onUnlink : null} />
      {open && (
        <>
          <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            {kids.map((k, i) => (
              <div key={k.id} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
                {kids.length > 1 && (
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', height: 2 }}>
                    <div style={{ flex: 1, background: i === 0 ? 'transparent' : 'var(--line)' }} />
                    <div style={{ flex: 1, background: i === kids.length - 1 ? 'transparent' : 'var(--line)' }} />
                  </div>
                )}
                <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
                <OrgTreeNode e={k} ctx={ctx} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Right-hand detail drawer: view + edit reporting line, title, department, and
// the functional-division head tag.
function OrgSidePanel({ e, people, entities, entityName, descendants, divisionNames, inheritedDivision, onClose, onSelect, onSaved, toastOk, toastErr }) {
  const init = () => ({ manager_email: e.managerEmail || '', job_title: e.jobTitle || '', department: e.department || '', company: e.company || '', division: e.division || '' });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(init()); }, [e.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const myEmail = (e.workEmail || '').toLowerCase();
  const blocked = descendants(myEmail);           // can't report to your own subtree
  const managerOptions = people.filter(p => p.id !== e.id && p.workEmail && !blocked.has((p.workEmail || '').toLowerCase()));
  const reports = people.filter(p => (p.managerEmail || '').toLowerCase() === myEmail && myEmail);
  const dirty = f.manager_email !== (e.managerEmail || '') || f.job_title !== (e.jobTitle || '') || f.department !== (e.department || '') || f.company !== (e.company || '') || f.division !== (e.division || '');
  // Division inherited from a manager above (shown when this person isn't a lead themselves)
  const inherited = (inheritedDivision || '').trim();

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.updateEmployee(e.id, f);
      onSaved(saved);
      toastOk(`${fullName(e)} updated.`);
    } catch (err) { toastErr(err?.message || 'Could not save.'); }
    finally { setBusy(false); }
  };

  const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.05em' };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1300, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,0.35)' }}
      onClick={ev => ev.target === ev.currentTarget && onClose()}>
      <div style={{ width: 'min(400px, 94vw)', height: '100%', background: 'var(--card)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.15s ease' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar e={e} size={52} card={false} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{fullName(e)}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[e.jobTitle, e.department].filter(Boolean).join(' · ') || '-'}
            </div>
            {e.workEmail && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.workEmail}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 6 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 22px 18px' }}>
          <label style={lbl}>Reports to</label>
          <select className="form-input" style={{ width: '100%' }} value={f.manager_email}
            onChange={ev => setF(x => ({ ...x, manager_email: ev.target.value }))}>
            <option value="">- No manager (top of a tree) -</option>
            {managerOptions.map(p => <option key={p.id} value={(p.workEmail || '').toLowerCase()}>{fullName(p)}{p.jobTitle ? ` - ${p.jobTitle}` : ''}</option>)}
          </select>

          <label style={lbl}>Job title</label>
          <input className="form-input" style={{ width: '100%' }} value={f.job_title} onChange={ev => setF(x => ({ ...x, job_title: ev.target.value }))} />

          <label style={lbl}>Department</label>
          <input className="form-input" style={{ width: '100%' }} value={f.department} onChange={ev => setF(x => ({ ...x, department: ev.target.value }))} />

          <label style={lbl}>Company</label>
          <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={ev => setF(x => ({ ...x, company: ev.target.value }))}>
            <option value="">-</option>
            {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>

          <label style={lbl}>Division lead of</label>
          <input className="form-input" style={{ width: '100%' }} list="org-divisions"
            placeholder="e.g. Operations - leave blank if not a division lead"
            value={f.division} onChange={ev => setF(x => ({ ...x, division: ev.target.value }))} />
          <datalist id="org-divisions">
            {(divisionNames || []).map(d => <option key={d} value={d} />)}
          </datalist>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
            {f.division.trim()
              ? `Everyone reporting under ${fullName(e)} is coloured as “${f.division.trim()}”, until another lead is tagged below them.`
              : inherited
                ? `Inherits “${inherited}” from their manager. Type a name here to make ${fullName(e)} their own division lead.`
                : `Not in any division. Type a name to make ${fullName(e)} a division lead - their whole team inherits it.`}
          </div>

          <button className="primary-btn" onClick={save} disabled={!dirty || busy}
            style={{ marginTop: 16, width: '100%', justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: dirty ? 1 : 0.5 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> : <CheckCircle size={14} />} Save changes
          </button>

          {reports.length > 0 && (
            <>
              <label style={lbl}>Direct reports ({reports.length})</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {reports.map(p => (
                  <button key={p.id} onClick={() => onSelect(p)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
                    <Avatar e={p} size={28} card={false} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{fullName(p)}</span>
                      <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>{p.jobTitle || p.department || ''}</span>
                    </span>
                    <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OrgChartTab({ employees, entities = [], onUpdated, toastOk, toastErr }) {
  // Two charts, one tab (Neil, Aug 11): the reporting tree, and the investor
  // book grouped by relationship owner - investors don't report to anyone.
  const [chartMode, setChartMode] = useState('org');   // 'org' | 'investors'
  const [draggingId, setDraggingId] = useState(null);
  const [overKey, setOverKey] = useState(null); // target workEmail, or '__none__' for the clear zone
  const [selected, setSelected] = useState(null);        // side-panel person
  const [orgQ, setOrgQ] = useState('');                   // name/title search
  const [orgCompany, setOrgCompany] = useState('');       // entity id filter
  const [orgDept, setOrgDept] = useState('');             // department filter
  const [collapsedSet, setCollapsedSet] = useState(new Set());
  const [seeded, setSeeded] = useState(false);
  const [activeDiv, setActiveDiv] = useState('');   // legend highlight filter
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 24 });
  const [dragGhost, setDragGhost] = useState(null);   // {name, x, y} while dragging a card
  const canvasRef = useRef(null);
  const contentRef = useRef(null);
  const dragRef = useRef(null);
  const people = employees.filter(e => e.status !== 'offboarded');

  // First render: show the top two levels at full size (roots + their direct
  // reports); deeper teams start collapsed behind their pill. Keeps the chart
  // readable instead of shrinking 40 people into ant-sized cards.
  useEffect(() => {
    if (seeded || !people.length) return;
    const emailSet = new Set(people.map(p => (p.workEmail || '').toLowerCase()).filter(Boolean));
    const isRoot = p => !((p.managerEmail || '') && emailSet.has((p.managerEmail || '').toLowerCase()));
    const rootEmails = new Set(people.filter(isRoot).map(p => (p.workEmail || '').toLowerCase()));
    const managers = new Set(people.filter(p =>
      people.some(k => (k.managerEmail || '').toLowerCase() === (p.workEmail || '').toLowerCase() && p.workEmail))
      .map(p => (p.workEmail || '').toLowerCase()));
    setCollapsedSet(new Set([...managers].filter(m => !rootEmails.has(m))));
    setSeeded(true);
  }, [people, seeded]);
  const emails = new Set(people.map(e => (e.workEmail || '').toLowerCase()).filter(Boolean));
  const byEmail = new Map(people.map(e => [(e.workEmail || '').toLowerCase(), e]));
  const childrenMap = new Map();
  for (const e of people) {
    const m = (e.managerEmail || '').toLowerCase();
    if (m && emails.has(m)) {
      if (!childrenMap.has(m)) childrenMap.set(m, []);
      childrenMap.get(m).push(e);
    }
  }

  // Everyone below `email` in the tree - used to refuse drops that would loop
  function descendants(email) {
    const seen = new Set();
    const queue = [email];
    while (queue.length) {
      for (const kid of childrenMap.get(queue.pop()) || []) {
        const ke = (kid.workEmail || '').toLowerCase();
        if (ke && !seen.has(ke)) { seen.add(ke); queue.push(ke); }
      }
    }
    return seen;
  }

  async function drop(targetEmail, dragged) {
    setDraggingId(null); setOverKey(null);
    if (!dragged) return;
    if (targetEmail === '__none__') {
      if (!dragged.managerEmail) return;
      targetEmail = '';
    } else {
      const target = byEmail.get(targetEmail);
      if (!target || target.id === dragged.id) return;
      if ((dragged.managerEmail || '').toLowerCase() === targetEmail) return;
      const myEmail = (dragged.workEmail || '').toLowerCase();
      if (myEmail && descendants(myEmail).has(targetEmail)) {
        toastErr(`${fullName(target)} reports up to ${fullName(dragged)} - that would create a loop.`);
        return;
      }
    }
    try {
      const saved = await api.updateEmployee(dragged.id, { manager_email: targetEmail });
      onUpdated(saved);
      toastOk(targetEmail
        ? `${fullName(dragged)} now reports to ${fullName(byEmail.get(targetEmail))}.`
        : `${fullName(dragged)} removed from the reporting line.`);
    } catch (err) { toastErr(err?.message || 'Could not change the reporting line.'); }
  }

  // Pointer-based drag (works with mouse AND touch - native HTML5 drag does
  // neither on a touch display). A small threshold distinguishes a tap (opens
  // the side panel) from a drag; while dragging we track the card under the
  // pointer via elementFromPoint (robust through the zoom transform) and show a
  // floating name ghost. Drop on a card = re-assign; on the detach zone = unlink.
  const onCardPointerDown = (ev, person) => {
    if (ev.button != null && ev.button > 0) return;   // primary button / touch only
    const start = { x: ev.clientX, y: ev.clientY };
    dragRef.current = { person, start, dragging: false, target: null };
    const move = (m) => {
      const st = dragRef.current; if (!st) return;
      if (!st.dragging) {
        if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
        st.dragging = true; setDraggingId(st.person.id);
      }
      st.last = { x: m.clientX, y: m.clientY };
      const el = document.elementFromPoint(m.clientX, m.clientY);
      const detach = el && el.closest ? el.closest('[data-detach]') : null;
      const card = el && el.closest ? el.closest('[data-email]') : null;
      let em = card && card.getAttribute('data-email');
      // Forgiving drops (Visesh, Aug 11): a drop doesn't have to land ON a
      // card - snap to the nearest card within reach, so "put them roughly
      // there" works. Excludes the dragged person's own card.
      if (!detach && (!em || em === (st.person.workEmail || '').toLowerCase())) {
        let best = null, bestD = 130;   // screen px reach
        for (const node of document.querySelectorAll('[data-email]')) {
          const ne = node.getAttribute('data-email');
          if (!ne || ne === (st.person.workEmail || '').toLowerCase()) continue;
          const r = node.getBoundingClientRect();
          const dx = Math.max(r.left - m.clientX, 0, m.clientX - r.right);
          const dy = Math.max(r.top - m.clientY, 0, m.clientY - r.bottom);
          const d = Math.hypot(dx, dy);
          if (d < bestD) { bestD = d; best = ne; }
        }
        em = best;
      }
      st.target = detach ? '__none__'
        : (em && em !== (st.person.workEmail || '').toLowerCase()) ? em : null;
      setOverKey(st.target);
      setDragGhost({ name: fullName(st.person), x: m.clientX, y: m.clientY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const st = dragRef.current; dragRef.current = null;
      setDragGhost(null);
      if (st && st.dragging) {
        if (st.target) {
          drop(st.target, st.person);
        } else {
          // Dropped in open space, beyond snapping reach of any card: that IS
          // the gesture for "take them out of the reporting line" - but only
          // inside the chart canvas, so releasing over the toolbar is a no-op.
          const c = canvasRef.current && st.last
            ? canvasRef.current.getBoundingClientRect() : null;
          const inCanvas = c && st.last.x >= c.left && st.last.x <= c.right
            && st.last.y >= c.top && st.last.y <= c.bottom;
          if (inCanvas && st.person.managerEmail) drop('__none__', st.person);
          else { setDraggingId(null); setOverKey(null); }
        }
      } else if (st) {
        setSelected(st.person);    // no meaningful movement → treat as a tap
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dnd = { draggingId, setDraggingId, overKey, setOverKey, drop, onCardPointerDown };
  // Managers (people with reports) before leaves, then alphabetical - keeps
  // wide sibling rows readable
  const kidCount = e => (childrenMap.get((e.workEmail || '').toLowerCase()) || []).length;
  for (const arr of childrenMap.values()) {
    arr.sort((a, b) => (kidCount(b) - kidCount(a)) || fullName(a).localeCompare(fullName(b)));
  }
  const hasManager = e => (e.managerEmail || '') && emails.has((e.managerEmail || '').toLowerCase());
  const roots = people.filter(e => !hasManager(e) && (childrenMap.get((e.workEmail || '').toLowerCase()) || []).length > 0);
  // Busacta-style: surface the unlinked instead of hiding them - forces the data complete
  const unlinked = people.filter(e => !hasManager(e) && !(childrenMap.get((e.workEmail || '').toLowerCase()) || []).length);
  const linked = people.length - unlinked.length;

  // ── Functional divisions: a person's division is their own head-tag, else
  // inherited from the nearest tagged manager up the chain. Memoised per email.
  const divisionNames = [...new Set(people.map(e => (e.division || '').trim()).filter(Boolean))].sort();
  const divColor = name => divColorFor(name, divisionNames);
  const _divCache = new Map();
  const divisionOf = (person) => {
    let cur = person, hops = 0;
    while (cur && hops < 30) {
      const em = (cur.workEmail || '').toLowerCase();
      if (_divCache.has(em)) return _divCache.get(em);
      const own = (cur.division || '').trim();
      if (own) { if (em) _divCache.set(em, own); return own; }
      const mgr = (cur.managerEmail || '').toLowerCase();
      if (!mgr || !byEmail.has(mgr)) break;
      cur = byEmail.get(mgr); hops++;
    }
    const em0 = (person.workEmail || '').toLowerCase();
    if (em0) _divCache.set(em0, '');
    return '';
  };
  const divisionCounts = {};
  for (const p of people) { const d = divisionOf(p); if (d) divisionCounts[d] = (divisionCounts[d] || 0) + 1; }

  // ── Filters: company (live from the entities table), department, name search.
  // Filtering rebuilds the tree from the filtered set - unmatched managers drop
  // out and their matching reports surface as roots.
  const departments = [...new Set(people.map(e => e.department).filter(Boolean))].sort();
  const q = orgQ.trim().toLowerCase();
  // Company/department FILTER the tree; search FINDS within it (expand + center
  // + highlight) - filtering by name would amputate the person's whole subtree.
  const visible = people.filter(e =>
    (!orgCompany || e.company === orgCompany) &&
    (!orgDept || e.department === orgDept));
  const visEmails = new Set(visible.map(e => (e.workEmail || '').toLowerCase()).filter(Boolean));
  const visChildren = new Map();
  for (const e of visible) {
    const m = (e.managerEmail || '').toLowerCase();
    if (m && visEmails.has(m)) {
      if (!visChildren.has(m)) visChildren.set(m, []);
      visChildren.get(m).push(e);
    }
  }
  for (const arr of visChildren.values()) {
    arr.sort((a, b) => ((visChildren.get((b.workEmail || '').toLowerCase()) || []).length
      - (visChildren.get((a.workEmail || '').toLowerCase()) || []).length)
      || fullName(a).localeCompare(fullName(b)));
  }
  const visHasManager = e => (e.managerEmail || '') && visEmails.has((e.managerEmail || '').toLowerCase());
  const visRoots = visible.filter(e => !visHasManager(e) && (visChildren.get((e.workEmail || '').toLowerCase()) || []).length > 0);
  const visUnlinked = visible.filter(e => !visHasManager(e) && !(visChildren.get((e.workEmail || '').toLowerCase()) || []).length);
  const entityName = id => (entities || []).find(en => en.id === id)?.name || '';
  const filtered = !!(orgCompany || orgDept || q);

  const toggle = (email) => setCollapsedSet(s => {
    const n = new Set(s);
    if (n.has(email)) n.delete(email); else n.add(email);
    return n;
  });

  const ctx = {
    visChildren, collapsedSet, toggle, setSelected, dnd, entityName,
    isHighlight: (e) => !!q && fullName(e).toLowerCase().includes(q),
    divisionOf, divColor, activeDiv,
    onUnlink: (person) => drop('__none__', person),
  };

  // ── Pan & zoom canvas - the chart never overflows the page; you pan/zoom
  // within a fixed viewport. Default = 100% zoom, centered; Fit is opt-in.
  const centerView = () => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    const kw = k.scrollWidth;
    setZoom(1);
    // Centre on the content midpoint - when the tree is wider than the canvas
    // this puts the middle in view (edges pan-reachable) rather than left-pinning.
    setPan({ x: (c.clientWidth - kw) / 2, y: 24 });
  });
  const fitToView = () => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    // scrollWidth reports untransformed layout size - no zoom correction needed
    const kw = k.scrollWidth, kh = k.scrollHeight;
    if (!kw || !kh) return;
    const s = Math.max(0.35, Math.min(1, (c.clientWidth - 48) / kw, (c.clientHeight - 48) / kh));
    setZoom(s);
    setPan({ x: Math.max(24, (c.clientWidth - kw * s) / 2), y: 24 });
  });
  useEffect(() => { if (seeded) centerView(); }, [orgCompany, orgDept, seeded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search = find & focus: expand every ancestor of the first match (plus the
  // match's own team), then glide the canvas so their card sits centre-stage.
  useEffect(() => {
    if (!q || !seeded) return;
    const match = visible.find(e => fullName(e).toLowerCase().includes(q) || (e.jobTitle || '').toLowerCase().includes(q));
    if (!match) return;
    const byEmailAll = new Map(visible.map(p => [(p.workEmail || '').toLowerCase(), p]));
    const chain = [];
    let cur = match, hops = 0;
    while (cur && (cur.managerEmail || '') && hops < 20) {
      const m = (cur.managerEmail || '').toLowerCase();
      if (!byEmailAll.has(m)) break;
      chain.push(m);
      cur = byEmailAll.get(m);
      hops++;
    }
    const me = (match.workEmail || '').toLowerCase();
    setCollapsedSet(s => {
      const n = new Set(s);
      chain.forEach(a => n.delete(a));
      if (me) n.delete(me);              // show their own team too
      return n;
    });
    // Let the expansion render, then centre the card in the viewport.
    const t = setTimeout(() => {
      const c = canvasRef.current, k = contentRef.current;
      const el = k && me ? k.querySelector(`[data-email="${me.replace(/"/g, '')}"]`) : null;
      if (!c || !el) return;
      const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
      setPan(p => ({
        x: p.x + (cr.width / 2 - (er.left + er.width / 2 - cr.left)),
        y: p.y + (cr.height / 3 - (er.top + er.height / 2 - cr.top)),
      }));
    }, 80);
    return () => clearTimeout(t);
  }, [q, seeded]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPan = (ev) => {
    if (ev.target.closest && ev.target.closest('[data-orgcard]')) return;   // card press, not a pan
    const sx = ev.clientX - pan.x, sy = ev.clientY - pan.y;
    const move = (m) => setPan({ x: m.clientX - sx, y: m.clientY - sy });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const zoomBy = (f) => setZoom(z => Math.max(0.3, Math.min(1.6, +(z * f).toFixed(3))));

  if (!people.length) return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
      <Network size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 14, fontWeight: 600 }}>Add people first - the chart draws itself from each person's "Reports to".</div>
    </div>
  );
  return (
    <div>
      {/* Org ⇄ Investors switch */}
      <div style={{ display: 'inline-flex', gap: 2, background: 'var(--mist)', borderRadius: 10, padding: 3, marginBottom: 14 }}>
        {[['org', 'Organization', Network], ['investors', 'Investors', Briefcase]].map(([key, label, Icon]) => (
          <button key={key} onClick={() => setChartMode(key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'Inter,sans-serif', fontSize: 12.5, fontWeight: 700,
              background: chartMode === key ? 'var(--card)' : 'transparent',
              color: chartMode === key ? 'var(--ink)' : 'var(--muted)',
              boxShadow: chartMode === key ? 'var(--shadow-sm)' : 'none' }}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {chartMode === 'investors' ? (
        <InvestorChart employees={employees} toastOk={toastOk} toastErr={toastErr} />
      ) : (
      <>
      {/* Toolbar: expand controls · full-width search · filters + count (People-tab style) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button className="secondary-btn" style={{ fontSize: 12, flex: '0 0 auto' }}
          onClick={() => { setCollapsedSet(new Set()); setTimeout(centerView, 60); }}>Expand all</button>
        <button className="secondary-btn" style={{ fontSize: 12, flex: '0 0 auto' }}
          onClick={() => { setCollapsedSet(new Set([...visChildren.keys()])); setTimeout(centerView, 60); }}>Collapse all</button>
        {/* Kit proportion: search is a field, not a runway - cap its width. */}
        <div className="search-bar" style={{ flex: '1 1 240px', minWidth: 200, maxWidth: 360, height: 34 }}>
          <Search size={13} style={{ flexShrink: 0 }} />
          <input placeholder="Search people…" value={orgQ} onChange={ev => setOrgQ(ev.target.value)} />
          {orgQ && <button onClick={() => setOrgQ('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
        </div>
        <select className="form-input" value={orgCompany} onChange={ev => setOrgCompany(ev.target.value)}
          style={{ width: 150, flex: '0 0 auto', fontSize: 12.5, fontWeight: 600, padding: '7px 26px 7px 10px', height: 34 }}>
          <option value="">All companies</option>
          {(entities || []).map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <select className="form-input" value={orgDept} onChange={ev => setOrgDept(ev.target.value)}
          style={{ width: 150, flex: '0 0 auto', fontSize: 12.5, fontWeight: 600, padding: '7px 26px 7px 10px', height: 34 }}>
          <option value="">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: '0 0 auto', whiteSpace: 'nowrap' }}>
          {visible.length}{filtered ? ` of ${people.length}` : ''} people · {linked} linked
        </span>
      </div>

      {/* Division legend - click a chip to spotlight that division (dim the rest).
          Colours match each card's left accent bar. */}
      {divisionNames.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Divisions</span>
          {divisionNames.map(d => {
            const on = activeDiv === d, col = divColor(d);
            return (
              <button key={d} onClick={() => setActiveDiv(on ? '' : d)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 11px', borderRadius: 20,
                  border: `1.5px solid ${on ? `hsl(${col})` : 'var(--line)'}`, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  background: on ? `hsla(${col},0.12)` : 'var(--card)', fontSize: 11.5, fontWeight: 700,
                  color: on ? `hsl(${col})` : 'var(--ink)', opacity: activeDiv && !on ? 0.55 : 1, transition: 'opacity 0.12s' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: `hsl(${col})` }} />
                {d}
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--muted)' }}>{divisionCounts[d] || 0}</span>
              </button>
            );
          })}
          {activeDiv && (
            <button onClick={() => setActiveDiv('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--muted)', fontFamily: 'Inter,sans-serif' }}>Clear Spotlight</button>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 4 }}>· set a division on the "lead" in their side panel</span>
        </div>
      )}

      {/* Detach zone appears only mid-drag - drag a card here to unlink it */}
      {draggingId && (
        <div data-detach="1"
          style={{ marginBottom: 10, border: `2px dashed ${overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--line)'}`, borderRadius: 12, padding: '10px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--muted)', background: overKey === '__none__' ? 'hsla(var(--color-red),0.06)' : 'transparent' }}>
          Drag here to remove their reporting line
        </div>
      )}

      {/* The chart canvas - drag empty space to pan, controls to zoom/fit.
          Card drag is pointer-based (see onCardPointerDown), so it works with a
          finger and resolves the drop target through the zoom transform. */}
      <div ref={canvasRef} onPointerDown={startPan}
        style={{ position: 'relative', height: 'max(480px, calc(100vh - 380px))', overflow: 'hidden',
          borderRadius: 16, border: `1px solid ${draggingId ? 'hsl(var(--color-green))' : 'var(--line)'}`, cursor: 'grab', touchAction: 'none',
          background: 'var(--card)',
          backgroundImage: 'radial-gradient(circle, var(--line) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        {visRoots.length === 0 && visUnlinked.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No one matches these filters.
          </div>
        ) : (
          <div ref={contentRef} style={{ position: 'absolute', left: 0, top: 0,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0',
            display: 'flex', alignItems: 'flex-start', gap: 48, padding: 4, width: 'max-content' }}>
            {visRoots.map(r => <OrgTreeNode key={r.id} e={r} ctx={ctx} />)}
          </div>
        )}

        {/* Zoom controls */}
        <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 5, boxShadow: 'var(--shadow-md)' }}>
          {[['−', () => zoomBy(1 / 1.25)], [`${Math.round(zoom * 100)}%`, fitToView], ['+', () => zoomBy(1.25)]].map(([label, fn], i) => (
            <button key={i} onClick={fn} title={i === 1 ? 'Fit to view' : ''}
              style={{ minWidth: 34, height: 30, borderRadius: 8, border: 'none', background: i === 1 ? 'var(--mist)' : 'transparent',
                fontSize: i === 1 ? 11 : 16, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
              {label}
            </button>
          ))}
        </div>
        <span style={{ position: 'absolute', left: 14, bottom: 14, fontSize: 10.5, color: 'var(--muted)', pointerEvents: 'none' }}>
          Drag a card near someone to re-assign · drop in open space (or press ×) to remove the reporting line · tap for details
        </span>
      </div>

      {visUnlinked.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'hsl(var(--color-orange))', textTransform: 'uppercase', marginBottom: 8 }}>
            No reporting line - drag onto the chart above, or tap to set who they report to
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {visUnlinked.map(e => {
              const d = divisionOf(e);
              return (
                <OrgNodeCard key={e.id} e={e} kids={0} isCollapsed={false}
                  onToggle={() => {}} onSelect={setSelected} dnd={dnd} entityName={entityName} highlight={false}
                  divName={d} divColor={divColor(d)} isHead={!!(e.division || '').trim()} dim={false} />
              );
            })}
          </div>
        </div>
      )}

      {/* Floating drag ghost - follows the pointer/finger while dragging a card */}
      {dragGhost && (
        <div style={{ position: 'fixed', left: dragGhost.x + 14, top: dragGhost.y + 8, zIndex: 2000, pointerEvents: 'none',
          background: 'var(--ink)', color: 'var(--card)', fontSize: 12, fontWeight: 700, padding: '5px 11px', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' }}>
          {dragGhost.name}
          <span style={{ opacity: 0.7, fontWeight: 500 }}>{overKey === '__none__' ? ' → unlink' : overKey ? ' → drop to re-assign' : ''}</span>
        </div>
      )}

      {selected && (
        <OrgSidePanel e={selected} people={people} entities={entities || []} entityName={entityName}
          descendants={descendants} divisionNames={divisionNames}
          inheritedDivision={(selected.division || '').trim() ? '' : divisionOf(selected)}
          onClose={() => setSelected(null)} onSelect={setSelected}
          onSaved={saved => { onUpdated(saved); setSelected(saved); }}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      </>
      )}
    </div>
  );
}

// ── Leave tracker (Phase 6) ───────────────────────────────────────────────────
const LEAVE_TYPES = [['annual', 'Annual'], ['sick', 'Sick'], ['unpaid', 'Unpaid']];
const LEAVE_STATUS = {
  pending:  { label: 'Pending',  bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  approved: { label: 'Approved', bg: 'hsla(var(--color-green),0.1)',   fg: 'hsl(var(--color-green))' },
  rejected: { label: 'Rejected', bg: 'hsla(var(--color-red),0.1)',     fg: 'hsl(var(--color-red))' },
};

function LeaveFormModal({ employees, onClose, onSaved, toastErr }) {
  const [f, setF] = useState({ employee_id: '', leave_type: 'annual', start_date: '', end_date: '', days: 1, reason: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const canSave = f.employee_id && f.start_date && f.days > 0;
  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    try { onSaved(await api.createLeave({ ...f, days: Number(f.days) })); onClose(); }
    catch (err) { toastErr(err?.message || 'Could not record leave.'); setBusy(false); }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 480, maxHeight: 'min(92dvh, 620px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>New Leave Request</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>EMPLOYEE *</label>
            <select className="form-input" style={{ width: '100%' }} value={f.employee_id} onChange={e => set('employee_id', e.target.value)}>
              <option value="">- pick a person -</option>
              {employees.filter(e => e.status !== 'offboarded').map(e => <option key={e.id} value={e.id}>{fullName(e)} ({e.employeeCode})</option>)}
            </select></div>
          <div><label style={FL}>TYPE</label>
            <select className="form-input" style={{ width: '100%' }} value={f.leave_type} onChange={e => set('leave_type', e.target.value)}>
              {LEAVE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div><label style={FL}>DAYS *</label>
            <input className="form-input" type="number" min="0.5" step="0.5" style={{ width: '100%' }} value={f.days} onChange={e => set('days', e.target.value)} /></div>
          <div><label style={FL}>FROM *</label>
            <input className="form-input" type="date" style={{ width: '100%' }} value={f.start_date} onChange={e => set('start_date', e.target.value)} /></div>
          <div><label style={FL}>TO</label>
            <input className="form-input" type="date" style={{ width: '100%' }} value={f.end_date} onChange={e => set('end_date', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>REASON</label>
            <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.reason} onChange={e => set('reason', e.target.value)} /></div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={!canSave || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!canSave || busy) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />} Submit
          </button>
        </div>
      </div>
    </div>
  );
}

// Searchable multi-person filter: type to find people, pick several as chips.
// Empty selection = everyone.
function PeopleFilter({ employees, selected, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const selSet = new Set(selected);
  const matches = q.trim()
    ? employees.filter(e => !selSet.has(e.id) && fullName(e).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
    : [];
  const pick = (e) => { onChange([...selected, e.id]); setQ(''); };
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      border: '1px solid var(--line)', borderRadius: 10, padding: '5px 10px', background: 'var(--card)', minWidth: 260, flex: '0 1 460px' }}>
      <Search size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      {selected.map(id => {
        const e = employees.find(x => x.id === id);
        return (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))', borderRadius: 8, padding: '2px 8px' }}>
            {e ? fullName(e) : id}
            <X size={11} style={{ cursor: 'pointer' }} onClick={() => onChange(selected.filter(x => x !== id))} />
          </span>
        );
      })}
      <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'Enter' && matches[0]) { e.preventDefault(); pick(matches[0]); }
          if (e.key === 'Backspace' && !q && selected.length) onChange(selected.slice(0, -1));
        }}
        placeholder={selected.length ? 'Add another person…' : 'Filter by person - type a name…'}
        style={{ flex: 1, minWidth: 140, border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, fontFamily: 'Inter,sans-serif', color: 'var(--ink)', padding: '3px 0' }} />
      {selected.length > 0 && (
        <button onClick={() => onChange([])} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)', fontFamily: 'Inter,sans-serif', flexShrink: 0 }}>Clear</button>
      )}
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', zIndex: 60, overflow: 'hidden' }}>
          {matches.map(e => (
            <button key={e.id} onMouseDown={ev => { ev.preventDefault(); pick(e); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12.5, fontFamily: 'Inter,sans-serif', color: 'var(--ink)' }}
              onMouseEnter={ev => ev.currentTarget.style.background = 'var(--mist)'}
              onMouseLeave={ev => ev.currentTarget.style.background = 'none'}>
              {fullName(e)} <span style={{ color: 'var(--muted)', fontSize: 11 }}>· {e.department || e.jobTitle || ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// "Who's out this week" - Mon–Sun strip merging both leave sources: HR-recorded
// leave (HrLeaveRequest) and self-service time off (Time Clock / My HR).
function WhosOutWeek({ employees, hrLeave, selIds = [] }) {
  const [timeoff, setTimeoff] = useState([]);
  useEffect(() => { api.timeOffList('').then(setTimeoff).catch(() => {}); }, []);
  const byId = Object.fromEntries(employees.map(e => [e.id, e]));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Respect the people filter: empty selection = everyone.
  const selSet = new Set(selIds);
  const selEmails = new Set(selIds.map(id => (byId[id]?.workEmail || '').toLowerCase()).filter(Boolean));
  const entries = [
    ...(hrLeave || []).filter(r => ['approved', 'pending'].includes(r.status))
      .filter(r => !selSet.size || selSet.has(r.employeeId)).map(r => ({
        name: fullName(byId[r.employeeId] || { firstName: '?' }),
        start: r.startDate || r.start_date || '', end: r.endDate || r.end_date || '',
        status: r.status, type: r.leaveType || r.type || '',
      })),
    ...timeoff.filter(r => ['approved', 'pending'].includes(r.status))
      .filter(r => !selSet.size || selEmails.has((r.email || '').toLowerCase())).map(r => ({
        name: r.name || (r.email || '').split('@')[0].replace('.', ' '),
        start: r.startDate || '', end: r.endDate || '', status: r.status, type: r.type || '',
      })),
  ].filter(e => e.start && e.end);

  const weekHasAnyone = days.some(d => entries.some(e => e.start <= isoD(d) && isoD(d) <= e.end));

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', marginBottom: 16, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 10 }}>
        Who's out this week
      </div>
      {!weekHasAnyone ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Everyone's in - no approved or pending leave this week.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
          {days.map(d => {
            const key = isoD(d);
            const isToday = key === isoD(today);
            const out = entries.filter(e => e.start <= key && key <= e.end);
            return (
              <div key={key} style={{ borderRadius: 10, padding: '7px 8px', minHeight: 58, background: isToday ? 'hsla(var(--color-blue),0.06)' : 'var(--mist)', outline: isToday ? '1.5px solid hsla(var(--color-blue),0.4)' : 'none' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: isToday ? 'hsl(var(--color-blue))' : 'var(--muted)', marginBottom: 5 }}>
                  {d.toLocaleDateString('en-US', { weekday: 'short' })} {d.getDate()}
                </div>
                {out.length === 0 ? (
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', opacity: 0.6 }}>-</div>
                ) : out.map((e, i) => (
                  <div key={i} title={`${e.name} · ${e.type}${e.status === 'pending' ? ' (pending)' : ''}`}
                    style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 6px', borderRadius: 8, marginBottom: 3,
                      background: e.status === 'approved' ? 'hsla(var(--color-green),0.12)' : 'hsla(var(--color-orange),0.12)',
                      color: e.status === 'approved' ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name.split(' ')[0]}{e.status === 'pending' ? ' ?' : ''}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function LeaveTab({ employees, toastOk, toastErr }) {
  const [leave, setLeave] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selF, setSelF] = useState([]);          // people filter - empty = everyone
  const [balances, setBalances] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const year = new Date().getFullYear();
  const empF = selF.length === 1 ? selF[0] : 'All';   // balances show for exactly one person

  const loadLeave = useCallback(() => {
    setLoadErr(false); setLeave(null);
    api.getLeave().then(setLeave).catch(() => setLoadErr(true));   // don't mask a failure as "no requests"
  }, []);
  useEffect(() => { loadLeave(); }, [loadLeave]);
  useEffect(() => {
    if (empF === 'All') { setBalances(null); return; }
    api.getLeaveBalances(empF, year).then(setBalances).catch(() => setBalances(null));
  }, [empF, year]);

  const byId = Object.fromEntries(employees.map(e => [e.id, e]));

  async function decide(r, action) {
    setBusyId(r.id);
    try {
      const updated = await api.decideLeave(r.id, { action });
      setLeave(prev => prev.map(x => x.id === r.id ? updated : x));
      toastOk(`Leave ${action === 'approve' ? 'approved' : 'rejected'} for ${fullName(byId[r.employeeId] || { firstName: '?' })}.`);
      if (empF === r.employeeId) api.getLeaveBalances(empF, year).then(setBalances).catch(() => {});
    } catch (err) { toastErr(err?.message || 'Could not update request.'); }
    setBusyId(null);
  }

  if (loadErr) return <ErrorBanner message="Couldn't load leave requests right now." onRetry={loadLeave} />;
  if (leave === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>;

  const visible = selF.length === 0 ? leave : leave.filter(r => selF.includes(r.employeeId));
  const pending = visible.filter(r => r.status === 'pending').length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <PeopleFilter employees={employees} selected={selF} onChange={setSelF} />
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{pending} pending · {visible.length} shown</span>
        {/* Employees request their own leave from My HR - this is the approve/track
            view. HR keeps a de-emphasised "log on behalf" for phone-ins and
            staff without portal access. */}
        <button className="secondary-btn" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} onClick={() => setFormOpen(true)}>
          <Plus size={13} /> Log on Behalf
        </button>
      </div>

      <WhosOutWeek employees={employees} hrLeave={leave} selIds={selF} />

      {/* Balance cards when a person is picked - used computes from approvals */}
      {balances && (
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {balances.map(b => (
            <div key={b.leaveType} className={`kpi-card ${b.leaveType === 'annual' ? 'card-green' : b.leaveType === 'sick' ? 'card-orange' : 'card-blue'}`}>
              <div className="kpi-label">{LEAVE_TYPES.find(([v]) => v === b.leaveType)?.[1]} {year}</div>
              <div className="kpi-value">{b.used}<span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}> / {b.allocated || '∞'} used</span></div>
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <CalendarOff size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 13.5 }}>No leave requests{empF !== 'All' ? ' for this person' : ''} yet.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.map(r => {
            const e = byId[r.employeeId];
            const lm = LEAVE_STATUS[r.status] || LEAVE_STATUS.pending;
            return (
              <div key={r.id} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', boxShadow: 'var(--shadow-sm)' }}>
                {e ? <Avatar e={e} size={34} /> : null}
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{e ? fullName(e) : 'Unknown'} <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 12 }}>· {LEAVE_TYPES.find(([v]) => v === r.leaveType)?.[1]} · {r.days} day{r.days !== 1 ? 's' : ''}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
                    {formatDate(r.startDate)}{r.endDate && r.endDate !== r.startDate ? ` → ${formatDate(r.endDate)}` : ''}{r.reason ? ` · ${r.reason}` : ''}
                  </div>
                  {r.decisionNote && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Note: {r.decisionNote}</div>}
                </div>
                <span style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: lm.bg, color: lm.fg, flexShrink: 0 }}>{lm.label}</span>
                {r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => decide(r, 'reject')} disabled={busyId === r.id}
                      style={{ background: 'none', border: '1px solid hsla(var(--color-red),0.4)', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: 'hsl(var(--color-red))', fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
                      Reject
                    </button>
                    <button className="primary-btn" onClick={() => decide(r, 'approve')} disabled={busyId === r.id}
                      style={{ fontSize: 12, padding: '5px 14px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {busyId === r.id ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={12} />} Approve
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {formOpen && <LeaveFormModal employees={employees} toastErr={toastErr} onClose={() => setFormOpen(false)}
        onSaved={r => { setLeave(prev => [r, ...prev]); toastOk('Leave request recorded - pending approval.'); }} />}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
// ── Companies / legal entities manager (HR Section A) ────────────────────────
// Manage one company's department list (Neil: departments live within a company,
// custom per company - not a Nexus-wide hardcoded list).
function CompanyDepartments({ entity, employees = [], toastOk, toastErr }) {
  const [depts, setDepts] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);   // department being renamed
  const [editName, setEditName] = useState('');
  const cancelRef = useRef(false);   // set on Escape so the ensuing onBlur doesn't SAVE
  const [loadErr, setLoadErr] = useState(false);
  const qc = useQueryClient();
  // A dept add/rename/remove changes the choices in every people/department picker
  // and the directory's department labels - refresh the shared caches so they don't
  // show a stale name until the next reload.
  const refreshDirectory = () => qc.invalidateQueries({ queryKey: qk.peopleDirectory });
  const load = () => { setLoadErr(false); return api.getCompanyDepartments(entity.id).then(setDepts).catch(() => setLoadErr(true)); };
  useEffect(() => { setDepts(null); load(); }, [entity.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Anyone with a work email can lead triage - not restricted to this company, since
  // a shared function (IT, Finance) often serves several entities.
  const staff = employees.filter(e => e.workEmail && e.status !== 'offboarded');
  async function add() {
    const n = name.trim();
    if (!n || busy) return; setBusy(true);
    try { const list = await api.addCompanyDepartment(entity.id, n); setDepts(list); setName(''); refreshDirectory(); }
    catch (e) { toastErr(e?.message || 'Could not add department.'); }
    setBusy(false);
  }
  async function remove(d) {
    if (!await dialog.confirm(
      `Delete the "${d.name}" department? Anyone currently assigned to it will be left with no department - you can reassign them on their profile.`,
      { title: 'Delete department', confirmText: 'Delete', danger: true })) return;
    try { const list = await api.deleteCompanyDepartment(entity.id, d.id); setDepts(list); refreshDirectory(); }
    catch (e) { toastErr(e?.message || 'Could not remove department.'); }
  }
  async function rename(d) {
    const n = editName.trim();
    setEditId(null);
    if (!n || n === d.name) return;
    try {
      const list = await api.updateCompanyDepartment(entity.id, d.id, { name: n });
      setDepts(list);
      refreshDirectory();
      toastOk?.(`Renamed “${d.name}” to “${n}” - people already in it follow the new name.`);
    } catch (e) { toastErr(e?.message || 'Could not rename department.'); }
  }
  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '16px 22px' }}>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px' }}>
        Departments for <strong>{entity.name}</strong>. These are the only choices when picking a department for someone in this company.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input className="form-input" style={{ flex: 1 }} placeholder="e.g. Estimating" value={name}
          onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} maxLength={40} />
        <button className="primary-btn" onClick={add} disabled={!name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
          <Plus size={14} /> Add
        </button>
      </div>
      {loadErr ? <ErrorBanner message="Couldn't load departments right now." onRetry={load} />
        : depts === null ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>Loading…</div>
        : depts.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: '10px 0' }}>No departments yet - add the first one above.</div>
        : (
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 32px', gap: 10, padding: '8px 12px', background: 'var(--paper)', borderBottom: '1px solid var(--line)', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
              <span>Department</span><span />
            </div>
            {depts.map(d => (
              <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '1fr 32px', gap: 10, padding: '8px 12px', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
                {editId === d.id ? (
                  <input className="form-input" autoFocus value={editName} maxLength={40}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { cancelRef.current = true; setEditId(null); } }}
                    onBlur={() => { if (cancelRef.current) { cancelRef.current = false; return; } rename(d); }}
                    style={{ fontSize: 13, padding: '4px 8px' }} />
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <button onClick={() => { setEditId(d.id); setEditName(d.name); }} title={`Rename ${d.name}`} aria-label={`Rename ${d.name}`}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: '50%', padding: 0, flexShrink: 0 }}
                      onMouseOver={e => { e.currentTarget.style.background = 'var(--paper)'; e.currentTarget.style.color = 'var(--ink)'; }}
                      onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                      <Pencil size={12} />
                    </button>
                  </span>
                )}
                <button onClick={() => remove(d)} title={`Remove ${d.name}`} aria-label={`Remove ${d.name}`}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: '50%', padding: 0 }}
                  onMouseOver={e => { e.currentTarget.style.background = 'hsla(var(--color-red),0.14)'; e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                  onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 16 }}>
        Tickets raised against a department arrive unassigned and notify its <strong>ticket lead</strong> (and backup), who assigns them to an employee.
        A department with no lead notifies nobody - its tickets sit in the triage queue until someone picks them up.
      </p>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Removing a department leaves anyone already in it untouched - it just stops being pickable.</p>
    </div>
  );
}

function EntitiesModal({ entities, employees = [], onClose, onChanged, toastOk, toastErr, scoped = false }) {
  const blank = { name: '', legal_name: '', country: '', tax_id: '', registered_address: '', signatory: '', notes: '', domains: '', manager_email: '' };
  const [mode, setMode] = useState(null);   // null = list · 'new' · <id> editing
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  // People directory for the manager pickers + the group manager (one person
  // above all companies; stored server-side as a singleton setting).
  const { data: people = [] } = usePeopleDirectory();
  const [groupMgr, setGroupMgr] = useState('');
  const [groupMgrBusy, setGroupMgrBusy] = useState(false);
  useEffect(() => {
    api.getGroupManager().then(r => setGroupMgr(r?.email || '')).catch(() => {});
  }, []);
  const personName = email => people.find(p => (p.email || '').toLowerCase() === (email || '').toLowerCase())?.name || '';
  async function saveGroupMgr(email) {
    setGroupMgr(email); setGroupMgrBusy(true);
    try { await api.setGroupManager(email); toastOk(email ? 'Group manager set.' : 'Group manager cleared.'); }
    catch (e) { toastErr(e?.message || 'Could not save group manager.'); }
    setGroupMgrBusy(false);
  }
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const startNew = () => { setF(blank); setMode('new'); };
  const startEdit = en => { setF({ name: en.name, legal_name: en.legalName || '', country: en.country || '', tax_id: en.taxId || '', registered_address: en.registeredAddress || '', signatory: en.signatory || '', notes: en.notes || '', domains: en.domains || '', manager_email: en.managerEmail || '' }); setMode(en.id); };
  const deptId = (typeof mode === 'string' && mode.startsWith('dept:')) ? mode.slice(5) : null;
  const deptEntity = deptId ? entities.find(e => e.id === deptId) : null;

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      if (mode === 'new') await api.createEntity(f); else await api.updateEntity(mode, f);
      await onChanged(); toastOk('Company saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save company.'); }
    setBusy(false);
  }
  async function remove(en) {
    if (!await dialog.confirm(`Delete "${en.name}"? Workers keep their record but lose this company link.`, { title: 'Delete company', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteEntity(en.id); await onChanged(); toastOk('Company deleted.'); }
    catch (e) { toastErr(e?.message || 'Could not delete company.'); }
  }
  async function seedDefaults() {
    setBusy(true);
    try {
      for (const [name, country] of [['Greens', 'US'], ['Greens India', 'IN'], ['MCD', 'US'], ['Oversite', 'US']]) await api.createEntity({ name, country });
      await onChanged(); toastOk('Added the 4 default entities.');
    } catch (e) { toastErr(e?.message || 'Could not add defaults.'); }
    setBusy(false);
  }
  const field = (label, key, props = {}) => (
    <div>
      <label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} />
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Building2 size={17} color="hsl(var(--color-blue))" />
          </div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{deptId ? `Departments · ${deptEntity?.name || ''}` : mode ? (mode === 'new' ? 'Add Company' : 'Edit Company') : 'Company Setup'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        {deptId ? (
          <>
            {deptEntity
              ? <CompanyDepartments entity={deptEntity} employees={employees} toastOk={toastOk} toastErr={toastErr} />
              : <div style={{ flex: 1, padding: 24, color: 'var(--muted)' }}>Company not found.</div>}
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="secondary-btn" onClick={() => setMode(null)}>Back</button>
            </div>
          </>
        ) : mode ? (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}>{field('NAME *', 'name', { autoFocus: true, placeholder: 'e.g. Greens India' })}</div>
              {field('LEGAL NAME', 'legal_name', { placeholder: 'full registered name' })}
              <div>
                <label style={FL}>COUNTRY</label>
                <select className="form-input" style={{ width: '100%' }} value={f.country} onChange={e => set('country', e.target.value)}>
                  <option value="">-</option><option value="US">United States (US)</option><option value="IN">India (IN)</option>
                </select>
              </div>
              {field('TAX ID (EIN / GSTIN)', 'tax_id')}
              {field('AUTHORIZED SIGNATORY', 'signatory', { placeholder: 'name, title' })}
              <div>
                <label style={FL}>COMPANY MANAGER</label>
                <select className="form-input" style={{ width: '100%' }} value={f.manager_email} onChange={e => set('manager_email', e.target.value)}>
                  <option value="">- not set -</option>
                  {people.map(p => <option key={p.email} value={p.email}>{p.name} ({p.email})</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>{field('REGISTERED ADDRESS', 'registered_address')}</div>
              <div style={{ gridColumn: '1 / -1' }}>
                {field('EMAIL DOMAINS', 'domains', { placeholder: 'e.g. aaravconstruction.com - comma-separated' })}
                <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>
                  Sync from M365 imports accounts on these domains and tags them to this company automatically (never overwrites a company already set on a profile).
                </p>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={FL}>NOTES</label>
                <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.notes} onChange={e => set('notes', e.target.value)} />
              </div>
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="secondary-btn" onClick={() => setMode(null)} disabled={busy}>Back</button>
              <button className="primary-btn" onClick={save} disabled={!f.name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.name.trim() || busy) ? 0.6 : 1 }}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 10px 13px', borderBottom: '1px solid var(--line)', marginBottom: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Group manager</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Oversees every company - the escalation step above each company's manager.</div>
                </div>
                <select className="form-input" disabled={groupMgrBusy} value={groupMgr} onChange={e => saveGroupMgr(e.target.value)} style={{ width: 220, fontSize: 12.5, flexShrink: 0 }}>
                  <option value="">- not set -</option>
                  {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
                </select>
              </div>
              {entities.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
                  <p style={{ fontSize: 13, marginBottom: 14 }}>No companies yet. Add your legal entities so every worker can be tied to one.</p>
                  <button className="secondary-btn" onClick={seedDefaults} disabled={busy} style={{ marginRight: 8 }}>Add Greens · Greens India · MCD · Oversite</button>
                </div>
              ) : entities.map(en => (
                <div key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{en.name} {en.country && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>· {en.country}</span>}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[en.legalName, en.taxId && `Tax ${en.taxId}`, en.signatory, en.managerEmail && personName(en.managerEmail) && `Manager ${personName(en.managerEmail)}`, en.domains && en.domains.split(',').map(d => '@' + d.trim()).join(' ')].filter(Boolean).join(' · ') || '-'}</div>
                  </div>
                  <button className="secondary-btn" onClick={() => setMode('dept:' + en.id)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Building2 size={13} /> Departments</button>
                  <button className="secondary-btn" onClick={() => startEdit(en)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
                  {!scoped && <button onClick={() => remove(en)} title="Delete" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>}
                </div>
              ))}
            </div>
            {!scoped && (
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="primary-btn" onClick={startNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Company</button>
            </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Inline status change with reason + effective date (HR Section B6) ────────
// M365 admin-center deep-links for the steps Graph can't perform (mailbox
// delegation, shared-mailbox conversion, license removal, mailbox export).
const EXO_MAILBOXES = 'https://admin.exchange.microsoft.com/#/mailboxes';
const M365_USERS    = 'https://admin.microsoft.com/#/users';
const PURVIEW_EXPORT = 'https://compliance.microsoft.com/contentsearchv2';

function StatusChangeModal({ employee, employees = [], onClose, onSaved, toastOk, toastErr }) {
  const [status, setStatus] = useState(employee.status || 'active');
  const [reason, setReason] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [leftChoice, setLeftChoice] = useState('remove');   // offboarded: 'remove' | 'share'
  const [exportRequested, setExportRequested] = useState(false);
  // Task handover: who inherits this person's work, and whether their
  // finished tasks come along. Only offered when they're actually leaving.
  const [handoverTo, setHandoverTo] = useState('');
  const [handoverIncludeCompleted, setHandoverIncludeCompleted] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = status !== employee.status;

  const isInactive = status === 'inactive';
  const isLeft = status === 'offboarded';
  const showOff = isInactive || isLeft;
  const mailboxAction = isInactive ? 'delegate' : (isLeft ? leftChoice : '');
  const needsDelegate = mailboxAction === 'delegate' || mailboxAction === 'share';
  // Allow Apply when the status changed OR - for someone already inactive/left -
  // when there's a mailbox/license action to (re-)run (e.g. free a license that
  // didn't release the first time).
  const canApply = changed || (showOff && (mailboxAction !== '' || exportRequested || handoverTo));
  const colleagues = employees.filter(x => x.workEmail && x.id !== employee.id);
  // Default the trustee to the person's manager (reports-to) from the org chart.
  const manager = employees.find(x => (x.workEmail || '').toLowerCase() === (employee.managerEmail || '').toLowerCase());
  const [trustees, setTrustees] = useState(() => (manager?.workEmail ? [manager.workEmail.toLowerCase()] : []));
  const addTrustee = () => { if (pick && !trustees.includes(pick)) setTrustees(t => [...t, pick]); setPick(''); };
  const removeTrustee = em => setTrustees(t => t.filter(x => x !== em));
  const nameFor = em => { const c = employees.find(x => (x.workEmail || '').toLowerCase() === em); return c ? fullName(c) : em; };

  // Exchange PowerShell to run (Graph can't do shared conversion / permissions).
  const upn = employee.workEmail || '<user-upn>';
  const psLines = [];
  if (needsDelegate && trustees.length) {
    psLines.push('Connect-ExchangeOnline');
    if (mailboxAction === 'share') psLines.push(`Set-Mailbox -Identity ${upn} -Type Shared`);
    trustees.forEach(t => psLines.push(`Add-MailboxPermission -Identity ${upn} -User ${t} -AccessRights FullAccess -AutoMapping $true`));
    if (mailboxAction === 'share') psLines.push('# Shared mailboxes <50GB need no license - remove it after converting.');
  }
  const psScript = psLines.join('\n');
  const copyPs = () => navigator.clipboard?.writeText(psScript)
    .then(() => toastOk('PowerShell copied to clipboard.'))
    .catch(() => toastErr('Copy failed - select the text and copy manually.'));

  function buildOffboarding() {
    if (!showOff) return null;
    return {
      mailboxAction,
      delegateTo: needsDelegate ? trustees : [],
      exportRequested,
      freeUpLicense: mailboxAction === 'remove',
      handoverTo: isLeft ? handoverTo : '',
      handoverIncludeCompleted,
    };
  }

  async function save() {
    if (busy) return;
    if (needsDelegate && trustees.length === 0) { toastErr('Pick who should get mailbox access.'); return; }
    setBusy(true);
    try {
      const saved = await api.changeEmployeeStatus(employee.id, { status, reason, effectiveDate, offboarding: buildOffboarding() });
      onSaved(saved);
      const m = saved.m365;
      const bits = [];
      if (m?.signIn) bits.push(`sign-in ${m.signIn}`);
      if (m?.licenses) bits.push(`license ${m.licenses}`);
      if (m?.export) bits.push('mailbox export started');
      if (m?.error) bits.push(`M365 issue: ${m.error}`);
      const it = saved.items;
      const ho = saved.handover;
      if (ho && (ho.reassigned || ho.projectsTransferred)) {
        const parts = [
          ho.reassigned && `${ho.reassigned} task${ho.reassigned === 1 ? '' : 's'} reassigned`,
          ho.moved && `${ho.moved} moved to a handover project`,
          ho.projectsTransferred && `${ho.projectsTransferred} project${ho.projectsTransferred === 1 ? '' : 's'} transferred`,
        ].filter(Boolean);
        bits.push(parts.join(' + '));
      }
      if (it && (it.checkouts || it.assignments)) {
        const parts = [it.checkouts && `${it.checkouts} checkout${it.checkouts === 1 ? '' : 's'}`, it.assignments && `${it.assignments} assignment${it.assignments === 1 ? '' : 's'}`].filter(Boolean);
        bits.push(`${parts.join(' + ')} force-returned`);
      }
      const auto = bits.length ? ` · ${bits.join(', ')}` : '';
      const manual = needsDelegate ? ' Run the PowerShell to finish mailbox access.' : '';
      toastOk(`Status set to ${STATUS_META[status]?.label || status}.${auto}${manual}`);
      onClose();
    } catch (e) { toastErr(e?.message || 'Could not change status.'); setBusy(false); }
  }

  const radio = (val, label, sub) => (
    <label style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 10, border: `1px solid ${leftChoice === val ? 'var(--pine)' : 'var(--line)'}`, background: leftChoice === val ? 'hsla(var(--color-green),0.06)' : 'transparent', cursor: 'pointer', marginBottom: 8 }}>
      <input type="radio" name="leftChoice" checked={leftChoice === val} onChange={() => setLeftChoice(val)} style={{ marginTop: 2 }} />
      <div><div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div></div>
    </label>
  );
  const delegatePicker = (
    <div>
      <label style={FL}>GRANT MAILBOX ACCESS TO</label>
      {manager && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Defaulted to their manager <b>{fullName(manager)}</b> from the org chart - add or remove below.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {trustees.map(t => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 20, padding: '3px 6px 3px 11px', fontSize: 12, fontWeight: 600 }}>
            {nameFor(t)}
            <button onClick={() => removeTrustee(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 0 }}><X size={12} /></button>
          </span>
        ))}
        {trustees.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No one selected yet.</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <select className="form-input" style={{ flex: 1 }} value={pick} onChange={e => setPick(e.target.value)}>
          <option value="">- add a colleague -</option>
          {colleagues.filter(c => !trustees.includes((c.workEmail || '').toLowerCase()))
            .map(c => <option key={c.id} value={(c.workEmail || '').toLowerCase()}>{fullName(c)} ({c.workEmail})</option>)}
        </select>
        <button className="secondary-btn" onClick={addTrustee} disabled={!pick} style={{ padding: '6px 12px' }}>Add</button>
      </div>
      {psScript && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            RUN IN EXCHANGE POWERSHELL
            <button className="secondary-btn" onClick={copyPs} style={{ padding: '2px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={11} /> Copy</button>
          </div>
          <pre style={{ margin: 0, background: '#1e293b', color: '#e5e7eb', borderRadius: 8, padding: '10px 12px', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' }}>{psScript}</pre>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 500, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Change status - {fullName(employee)}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '18px 24px', display: 'grid', gap: 14, overflowY: 'auto', flex: 1 }}>
          <div><label style={FL}>NEW STATUS</label>
            <select className="form-input" style={{ width: '100%' }} value={status} onChange={e => setStatus(e.target.value)}>
              {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select>
          </div>
          <div><label style={FL}>EFFECTIVE DATE</label><input className="form-input" style={{ width: '100%' }} type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} /></div>
          <div><label style={FL}>REASON</label><textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={reason} onChange={e => setReason(e.target.value)} placeholder="why the change (kept in the audit trail)" /></div>

          {showOff && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'hsla(var(--color-orange),0.05)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-orange))', letterSpacing: '.04em', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Mail size={13} /> MAILBOX HANDLING</div>
              {isInactive && (
                <>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>Grant a colleague read/write access to {employee.firstName}’s mailbox while they’re inactive.</p>
                  {delegatePicker}
                </>
              )}
              {isLeft && (
                <>
                  {radio('remove', 'Remove email & free up the license', 'Block sign-in, strip the M365 license so it returns to the pool.')}
                  {radio('share', 'Convert to a shared mailbox', 'Keep the mailbox alive (no license) and grant colleagues access.')}
                  {mailboxAction === 'share' && delegatePicker}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)', fontSize: 12, color: 'var(--muted)' }}>
                    <Briefcase size={13} style={{ flexShrink: 0, marginTop: 1, color: 'hsl(var(--color-orange))' }} />
                    <span>All equipment {employee.firstName} still holds in Item Management will be <strong>force-returned</strong> automatically - checkouts closed and permanent assignments sent back to stock.</span>
                  </div>
                  {/* Task handover. The picker is the curated Nexus People list
                      (the `employees` prop), never an M365/GAL-derived one. */}
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Hand over their tasks</div>
                    <input list="handover-people" value={handoverTo}
                      onChange={e => setHandoverTo(e.target.value.trim().toLowerCase())}
                      placeholder="Search for a person - leave blank to skip"
                      style={{ width: '100%', padding: '7px 9px', fontSize: 13, borderRadius: 8, border: '1px solid var(--line)' }} />
                    <datalist id="handover-people">
                      {colleagues.map(c => <option key={c.id} value={(c.workEmail || '').toLowerCase()}>{fullName(c)}</option>)}
                    </datalist>
                    {handoverTo && (
                      <>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={handoverIncludeCompleted}
                            onChange={e => setHandoverIncludeCompleted(e.target.checked)} style={{ width: 16, height: 16 }} />
                          Include completed tasks
                        </label>
                        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                          Their open tasks are reassigned to {nameFor(handoverTo)}. Tasks that already belong to a
                          project stay in it; anything with no project is collected into a new
                          <strong> Handover - {fullName(employee)}</strong> project owned by them, along with any
                          projects {employee.firstName} owned.
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={exportRequested} onChange={e => setExportRequested(e.target.checked)} style={{ width: 16, height: 16 }} />
                Export their mailbox to a ZIP first
              </label>
              {/* What Nexus automates on Apply vs. what genuinely needs the admin
                  centre. 'Remove' = sign-in block + license release are automatic
                  (Graph); only shared-mailbox conversion needs Exchange PowerShell. */}
              {mailboxAction === 'remove' ? (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
                  <div style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                    <CheckCircle size={14} style={{ flexShrink: 0, marginTop: 1, color: 'hsl(var(--color-green))' }} />
                    <span>On <strong>Apply</strong>, Nexus blocks sign-in and <strong>releases the license</strong> back to the pool automatically. Group-assigned licenses can’t be pulled per-user - if any are, the confirmation will name them so you can remove the person from that group.</span>
                  </div>
                  <a href={M365_USERS} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 11, color: 'hsl(var(--color-blue))', textDecoration: 'none' }}>Verify licenses in M365 <ChevronRight size={11} /></a>
                </div>
              ) : (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 6 }}>DO THIS IN M365 (Graph can’t convert shared mailboxes)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <a href={EXO_MAILBOXES} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ fontSize: 11.5, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>Mailbox access <ChevronRight size={12} /></a>
                    {exportRequested && <a href={PURVIEW_EXPORT} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ fontSize: 11.5, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>Export mailbox <ChevronRight size={12} /></a>}
                  </div>
                </div>
              )}
            </div>
          )}

          {employee.statusLog?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', marginBottom: 6 }}>RECENT CHANGES</div>
              {employee.statusLog.slice(0, 4).map((h, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--muted)', padding: '3px 0' }}>
                  {STATUS_META[h.from]?.label || h.from} → {STATUS_META[h.to]?.label || h.to} · {formatDate(h.effectiveDate || (h.at || '').slice(0, 10))}{h.reason ? ` · ${h.reason}` : ''}
                  {h.offboarding?.mailboxAction ? ` · mailbox: ${h.offboarding.mailboxAction}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy || !canApply} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (busy || !canApply) ? 0.6 : 1 }}>{busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── Right-to-work & compliance (HR Section B - open to HR) ───────────────────
const WORK_AUTH = [['citizen', 'Citizen'], ['permanent_resident', 'Permanent resident'], ['work_visa', 'Work visa'], ['permit', 'Work permit'], ['other', 'Other']];
const DOC_TYPES = [['passport', 'Passport'], ['national_id', 'National ID'], ['visa', 'Visa'], ['work_permit', 'Work permit'], ['other', 'Other']];
const VERIFY_STATUS = { unverified: { label: 'Unverified', fg: 'var(--muted)', bg: 'var(--mist)' }, verified: { label: 'Verified', fg: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' }, rejected: { label: 'Rejected', fg: 'hsl(var(--color-red))', bg: 'hsla(var(--color-red),0.12)' } };
const CONSENTS = [['bgCheck', 'Background check consent'], ['dataProcessing', 'Data processing consent'], ['handbook', 'Handbook acknowledgment']];

// Days until an ISO date (negative = past). '' → null.
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

function ComplianceModal({ employee, onClose, onSaved, toastOk, toastErr }) {
  const c0 = employee.compliance || {};
  const [c, setC] = useState({
    workAuth: c0.workAuth || '', docType: c0.docType || 'passport', docNumber: c0.docNumber || '',
    issueDate: c0.issueDate || '', expiryDate: c0.expiryDate || '', status: c0.status || 'unverified',
    consents: { bgCheck: false, dataProcessing: false, handbook: false, ...(c0.consents || {}) },
    verifiedBy: c0.verifiedBy || '', verifiedAt: c0.verifiedAt || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setC(prev => ({ ...prev, [k]: v }));
  const setConsent = (k, v) => setC(prev => ({ ...prev, consents: { ...prev.consents, [k]: v } }));

  async function save() {
    if (busy) return; setBusy(true);
    try { const saved = await api.updateEmployee(employee.id, { compliance: c }); onSaved(saved); toastOk('Compliance saved.'); onClose(); }
    catch (e) { toastErr(e?.message || 'Could not save.'); setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-purple),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ShieldCheck size={17} color="hsl(var(--color-purple))" /></div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Right to Work - {fullName(employee)}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={FL}>WORK AUTHORIZATION</label><select className="form-input" style={{ width: '100%' }} value={c.workAuth} onChange={e => set('workAuth', e.target.value)}><option value="">-</option>{WORK_AUTH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label style={FL}>DOCUMENT TYPE</label><select className="form-input" style={{ width: '100%' }} value={c.docType} onChange={e => set('docType', e.target.value)}>{DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={FL}>DOCUMENT NUMBER</label><input className="form-input" style={{ width: '100%' }} value={c.docNumber} onChange={e => set('docNumber', e.target.value)} /></div>
            <div><label style={FL}>ISSUE DATE</label><input className="form-input" style={{ width: '100%' }} type="date" value={c.issueDate} onChange={e => set('issueDate', e.target.value)} /></div>
            <div><label style={FL}>EXPIRY DATE</label><input className="form-input" style={{ width: '100%' }} type="date" value={c.expiryDate} onChange={e => set('expiryDate', e.target.value)} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={FL}>VERIFICATION STATUS</label>
              <select className="form-input" style={{ width: '100%' }} value={c.status} onChange={e => set('status', e.target.value)}>
                {Object.entries(VERIFY_STATUS).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '10px 0 0' }}>Upload the actual passport / visa scan in the Documents section below the profile (private, signed-URL access).</p>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', margin: '18px 0 10px' }}>CONSENT CHECKLIST</div>
          {CONSENTS.map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!c.consents[k]} onChange={e => setConsent(k, e.target.checked)} style={{ width: 16, height: 16 }} />
              {label}
            </label>
          ))}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: busy ? 0.6 : 1 }}>{busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Personal details + emergency contact (HR Section B - open to HR) ─────────
function maskId(v) {
  const s = (v || '').replace(/\s/g, '');
  return s.length > 4 ? `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}` : s;
}

function PersonalModal({ employee, onClose, onSaved, toastOk, toastErr }) {
  const p0 = employee.personal || {};
  const [p, setP] = useState({
    dob: p0.dob || '', gender: p0.gender || '', nationalId: p0.nationalId || '',
    currentAddress: p0.currentAddress || '', permanentAddress: p0.permanentAddress || '',
    emergency: { name: '', relationship: '', phone: '', email: '', ...(p0.emergency || {}) },
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setP(prev => ({ ...prev, [k]: v }));
  const setE = (k, v) => setP(prev => ({ ...prev, emergency: { ...prev.emergency, [k]: v } }));

  async function save() {
    if (busy) return; setBusy(true);
    try { const saved = await api.updateEmployee(employee.id, { personal: p }); onSaved(saved); toastOk('Personal details saved.'); onClose(); }
    catch (e) { toastErr(e?.message || 'Could not save.'); setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Contact size={17} color="hsl(var(--color-blue))" /></div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Personal - {fullName(employee)}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={FL}>DATE OF BIRTH</label><input className="form-input" style={{ width: '100%' }} type="date" value={p.dob} onChange={e => set('dob', e.target.value)} /></div>
            <div><label style={FL}>GENDER</label><select className="form-input" style={{ width: '100%' }} value={p.gender} onChange={e => set('gender', e.target.value)}><option value="">-</option><option>Male</option><option>Female</option><option>Other</option><option>Prefer not to say</option></select></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={FL}>NATIONAL ID / SSN / AADHAAR</label><input className="form-input" style={{ width: '100%' }} value={p.nationalId} onChange={e => set('nationalId', e.target.value)} placeholder="stored securely, shown masked" /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={FL}>CURRENT ADDRESS</label><textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={p.currentAddress} onChange={e => set('currentAddress', e.target.value)} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={FL}>PERMANENT ADDRESS</label><textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={p.permanentAddress} onChange={e => set('permanentAddress', e.target.value)} /></div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--color-red))', letterSpacing: '.04em', margin: '18px 0 10px' }}>EMERGENCY CONTACT</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={FL}>NAME</label><input className="form-input" style={{ width: '100%' }} value={p.emergency.name} onChange={e => setE('name', e.target.value)} /></div>
            <div><label style={FL}>RELATIONSHIP</label><input className="form-input" style={{ width: '100%' }} value={p.emergency.relationship} onChange={e => setE('relationship', e.target.value)} placeholder="e.g. spouse" /></div>
            <div><label style={FL}>PHONE</label><input className="form-input" style={{ width: '100%' }} value={p.emergency.phone} onChange={e => setE('phone', e.target.value)} /></div>
            <div><label style={FL}>EMAIL</label><input className="form-input" style={{ width: '100%' }} type="email" value={p.emergency.email} onChange={e => setE('email', e.target.value)} /></div>
          </div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: busy ? 0.6 : 1 }}>{busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Compensation + bank (HR Section B - gated by hr_comp grant / owner) ──────
const PAY_BASIS = [['salary', 'Salary'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['fixed_fee', 'Fixed fee']];
const PAY_FREQ  = [['monthly', 'Monthly'], ['semimonthly', 'Semi-monthly'], ['biweekly', 'Bi-weekly'], ['weekly', 'Weekly']];
// Default pay frequency by pay type (Charmi, Aug 4): hourly and US salary -> biweekly;
// India (INR) salary -> monthly. Applied when pay basis/currency changes; the user
// can still override via the dropdown.
const defaultPayFreq = (payBasis, currency) =>
  payBasis === 'hourly' ? 'biweekly' : (currency === 'INR' ? 'monthly' : 'biweekly');
const BANK_TYPES = [['checking', 'Checking'], ['savings', 'Savings'], ['current', 'Current']];
const BENEFIT_TYPES = [['health', 'Health'], ['dental', 'Dental'], ['vision', 'Vision'], ['life', 'Life'], ['disability', 'Disability'], ['retirement', 'Retirement / 401k / PF'], ['other', 'Other']];

function CompensationModal({ employee, onClose, toastOk, toastErr }) {
  const [comp, setComp] = useState({ base: '', payBasis: 'salary', frequency: 'biweekly', currency: 'USD', effectiveDate: '', history: [], benefits: [] });
  const [bank, setBank] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const setC = (k, v) => setComp(p => ({ ...p, [k]: v }));

  useEffect(() => {
    let live = true;
    api.getCompensation(employee.id)
      .then(r => { if (!live) return; setComp({ base: '', payBasis: 'salary', frequency: 'biweekly', currency: 'USD', effectiveDate: '', history: [], benefits: [], ...(r.compensation || {}) }); setBank(r.bank || []); })
      .catch(e => toastErr(e?.message || 'Could not load compensation.'))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [employee.id]);

  const addBank = () => setBank(b => [...b, { holder: '', bankName: '', number: '', routingOrIfsc: '', type: 'checking' }]);
  const setBankField = (i, k, v) => setBank(b => b.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const removeBank = i => setBank(b => b.filter((_, j) => j !== i));
  const benefits = comp.benefits || [];
  const addBenefit = () => setComp(p => ({ ...p, benefits: [...(p.benefits || []), { type: 'health', plan: '', deduction: '', note: '' }] }));
  const setBenefit = (i, k, v) => setComp(p => ({ ...p, benefits: (p.benefits || []).map((x, j) => j === i ? { ...x, [k]: v } : x) }));
  const removeBenefit = i => setComp(p => ({ ...p, benefits: (p.benefits || []).filter((_, j) => j !== i) }));

  async function save() {
    if (busy) return;
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) toastErr('Identity check didn’t complete.'); return; }
    setBusy(true);
    try {
      const clean = { ...comp }; delete clean.history;   // server owns history
      await api.saveCompensation(employee.id, { compensation: clean, bank });
      toastOk('Compensation saved.'); onClose();
    } catch (e) { toastErr(e?.message || 'Could not save compensation.'); setBusy(false); }
  }
  const money = (v, cur) => v ? `${cur === 'INR' ? '₹' : '$'}${Number(v).toLocaleString()}` : '-';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: 'min(92dvh, 780px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-green),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Wallet size={17} color="hsl(var(--color-green))" />
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Pay, Benefits & Bank - {fullName(employee)}</h3>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}><Lock size={11} /> Restricted · compensation grant</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /></div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 10 }}>BASE PAY</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={FL}>BASE AMOUNT</label><input className="form-input" style={{ width: '100%' }} type="number" value={comp.base} onChange={e => setC('base', e.target.value)} placeholder="e.g. 90000" /></div>
              <div><label style={FL}>CURRENCY</label><select className="form-input" style={{ width: '100%' }} value={comp.currency} onChange={e => { const cur = e.target.value; setComp(p => ({ ...p, currency: cur, frequency: defaultPayFreq(p.payBasis, cur) })); }}><option value="USD">USD</option><option value="INR">INR</option></select></div>
              <div><label style={FL}>PAY BASIS</label><select className="form-input" style={{ width: '100%' }} value={comp.payBasis} onChange={e => { const b = e.target.value; setComp(p => ({ ...p, payBasis: b, frequency: defaultPayFreq(b, p.currency) })); }}>{PAY_BASIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label style={FL}>PAY FREQUENCY</label><select className="form-input" style={{ width: '100%' }} value={comp.frequency} onChange={e => setC('frequency', e.target.value)}>{PAY_FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label style={FL}>EFFECTIVE DATE</label><input className="form-input" style={{ width: '100%' }} type="date" value={comp.effectiveDate} onChange={e => setC('effectiveDate', e.target.value)} /></div>
            </div>

            {comp.history?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 8 }}>HISTORY</div>
                {comp.history.map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
                    <span>{money(h.base, h.currency)} · {h.payBasis || ''}</span>
                    <span>{formatDate(h.effectiveDate || (h.changedAt || '').slice(0, 10))}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', margin: '20px 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}><Heart size={13} /> BENEFITS & DEDUCTIONS</div>
            {benefits.map((bn, i) => (
              <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div><label style={FL}>TYPE</label><select className="form-input" style={{ width: '100%' }} value={bn.type} onChange={e => setBenefit(i, 'type', e.target.value)}>{BENEFIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                  <div><label style={FL}>PLAN / PROVIDER</label><input className="form-input" style={{ width: '100%' }} value={bn.plan} onChange={e => setBenefit(i, 'plan', e.target.value)} /></div>
                  <div><label style={FL}>PER-PAYCHECK DEDUCTION</label><input className="form-input" style={{ width: '100%' }} type="number" value={bn.deduction} onChange={e => setBenefit(i, 'deduction', e.target.value)} placeholder={`in ${comp.currency}`} /></div>
                  <div><label style={FL}>NOTE</label><input className="form-input" style={{ width: '100%' }} value={bn.note} onChange={e => setBenefit(i, 'note', e.target.value)} /></div>
                </div>
                <button onClick={() => removeBenefit(i)} style={{ marginTop: 8, background: 'none', border: 'none', color: 'hsl(var(--color-red))', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={12} /> Remove</button>
              </div>
            ))}
            <button className="secondary-btn" onClick={addBenefit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4 }}><Plus size={13} /> Add benefit / deduction</button>

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', margin: '20px 0 10px', display: 'flex', alignItems: 'center', gap: 6 }}><Landmark size={13} /> BANK ACCOUNTS</div>
            {bank.map((acc, i) => (
              <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div><label style={FL}>ACCOUNT HOLDER</label><input className="form-input" style={{ width: '100%' }} value={acc.holder} onChange={e => setBankField(i, 'holder', e.target.value)} /></div>
                  <div><label style={FL}>BANK NAME</label><input className="form-input" style={{ width: '100%' }} value={acc.bankName} onChange={e => setBankField(i, 'bankName', e.target.value)} /></div>
                  <div><label style={FL}>ACCOUNT NUMBER</label><input className="form-input" style={{ width: '100%' }} value={acc.number} onChange={e => setBankField(i, 'number', e.target.value)} /></div>
                  <div><label style={FL}>ROUTING / IFSC</label><input className="form-input" style={{ width: '100%' }} value={acc.routingOrIfsc} onChange={e => setBankField(i, 'routingOrIfsc', e.target.value)} /></div>
                  <div><label style={FL}>TYPE</label><select className="form-input" style={{ width: '100%' }} value={acc.type} onChange={e => setBankField(i, 'type', e.target.value)}>{BANK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                </div>
                <button onClick={() => removeBank(i)} style={{ marginTop: 8, background: 'none', border: 'none', color: 'hsl(var(--color-red))', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Trash2 size={12} /> Remove</button>
              </div>
            ))}
            <button className="secondary-btn" onClick={addBank} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add Bank Account</button>
          </div>
        )}

        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy || loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (busy || loading) ? 0.6 : 1 }}>
            {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Work sites registry (HR Section A - geofence foundation for Time Clock) ───
function WorkSitesModal({ sites, entities, onClose, onChanged, toastOk, toastErr }) {
  const blank = { name: '', address: '', latitude: '', longitude: '', radius_m: 150, company: '', notes: '' };
  const [mode, setMode] = useState(null);
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const startNew = () => { setF(blank); setMode('new'); };
  const startEdit = s => { setF({ name: s.name, address: s.address || '', latitude: s.latitude || '', longitude: s.longitude || '', radius_m: s.radiusM ?? 150, company: s.company || '', notes: s.notes || '' }); setMode(s.id); };
  const entityName = id => entities.find(en => en.id === id)?.name || '';

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      const body = { ...f, radius_m: Number(f.radius_m) || 150 };
      if (mode === 'new') await api.createWorkSite(body); else await api.updateWorkSite(mode, body);
      await onChanged(); toastOk('Work site saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save work site.'); }
    setBusy(false);
  }
  async function remove(s) {
    if (!await dialog.confirm(`Delete work site "${s.name}"?`, { title: 'Delete work site', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteWorkSite(s.id); await onChanged(); toastOk('Work site deleted.'); }
    catch (e) { toastErr(e?.message || 'Could not delete.'); }
  }
  const field = (label, key, props = {}) => (
    <div><label style={FL}>{label}</label>
      <input className="form-input" style={{ width: '100%' }} value={f[key]} onChange={e => set(key, e.target.value)} {...props} /></div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: 'min(92dvh, 760px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-purple),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <MapPinned size={17} color="hsl(var(--color-purple))" />
          </div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{mode ? (mode === 'new' ? 'Add Work Site' : 'Edit Work Site') : 'Work Sites'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        {mode ? (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}>{field('NAME *', 'name', { autoFocus: true, placeholder: 'e.g. Escondido Office' })}</div>
              <div style={{ gridColumn: '1 / -1' }}>{field('ADDRESS', 'address')}</div>
              {field('LATITUDE', 'latitude', { placeholder: 'e.g. 33.1192' })}
              {field('LONGITUDE', 'longitude', { placeholder: 'e.g. -117.0864' })}
              {field('GEOFENCE RADIUS (m)', 'radius_m', { type: 'number', min: 10 })}
              <div>
                <label style={FL}>COMPANY / ENTITY</label>
                <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={e => set('company', e.target.value)}>
                  <option value="">- any -</option>
                  {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={FL}>NOTES</label>
                <textarea className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={f.notes} onChange={e => set('notes', e.target.value)} />
              </div>
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="secondary-btn" onClick={() => setMode(null)} disabled={busy}>Back</button>
              <button className="primary-btn" onClick={save} disabled={!f.name.trim() || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!f.name.trim() || busy) ? 0.6 : 1 }}>
                {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 18px' }}>
              {sites.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)', fontSize: 13 }}>No work sites yet. Add sites (with lat/long + radius) to enable geofenced clock-in later.</div>
              ) : sites.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name} {s.company && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>· {entityName(s.company)}</span>}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[s.address, (s.latitude && s.longitude) ? `${s.latitude}, ${s.longitude} · ${s.radiusM}m` : ''].filter(Boolean).join(' · ') || '-'}</div>
                  </div>
                  <button className="secondary-btn" onClick={() => startEdit(s)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
                  <button onClick={() => remove(s)} title="Delete" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="primary-btn" onClick={startNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Work Site</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── People stat cards (Work OS redesign, Jul 28) ─────────────────────────────
// Three designed cards with real mini-visuals - headcount with employment-type
// composition, status breakdown, department spread - replacing the four
// identical number tiles. Everything is computed from the live employee list;
// nothing is fabricated, and zero/loading states stay designed.
const WK_STATUS_COLOR = {
  onboarding: 'hsl(var(--color-blue))',
  active: 'hsl(var(--color-green))',
  inactive: 'hsl(var(--color-orange))',
  offboarded: 'var(--wk-faint)',
};
const WK_TYPE_COLORS = ['var(--wk-brand)', 'hsl(var(--color-blue))', 'hsl(var(--color-orange))', 'hsl(var(--color-purple))'];

function StatCardShell({ Icon, title, meta, children }) {
  // Stella card anatomy: bordered icon chip + title over a hairline divider,
  // then the body at its own rhythm (see .wkc in style.css).
  return (
    <div className="wkc">
      <div className="wkc-head">
        <span className="wkc-chip"><Icon size={14} /></span>
        <span className="wkc-title">{title}</span>
        {meta && <span className="wkc-meta">{meta}</span>}
      </div>
      <div className="wkc-body">{children}</div>
    </div>
  );
}

// Donut for the status breakdown (Stella's Task Summary form): SVG stroke
// arcs with 2px surface gaps, center total, native tooltips. Identity is
// never color-alone - the legend rows beside it carry label + count.
function StatusDonut({ segments, total }) {
  const R = 30, C = 2 * Math.PI * R, SW = 11, GAP = 2;
  const live = segments.filter(s => s.n > 0);
  let acc = 0;
  return (
    <svg viewBox="0 0 84 84" width={118} height={118} role="img" aria-label={`${total} people by status`} style={{ flexShrink: 0 }}>
      <circle cx={42} cy={42} r={R} fill="none" stroke="var(--mist)" strokeWidth={SW} />
      {total > 0 && live.map(s => {
        const frac = s.n / total;
        const len = Math.max(frac * C - (live.length > 1 ? GAP : 0), 1.5);
        const el = (
          <circle key={s.key} cx={42} cy={42} r={R} fill="none"
            stroke={s.color} strokeWidth={SW}
            strokeDasharray={`${len} ${C - len}`}
            strokeDashoffset={-acc}
            transform="rotate(-90 42 42)">
            <title>{`${s.label}: ${s.n}`}</title>
          </circle>
        );
        acc += frac * C;
        return el;
      })}
      <text x={42} y={41} textAnchor="middle" style={{ fontFamily: 'var(--wk-font)', fontSize: 20, fontWeight: 700, fill: 'var(--ink)' }}>{total}</text>
      <text x={42} y={54} textAnchor="middle" style={{ fontFamily: 'var(--wk-font)', fontSize: 8.5, fill: 'var(--muted)' }}>people</text>
    </svg>
  );
}

// Mini bar chart for hires by start year: one hue with a soft vertical
// gradient, current year emphasized, 4px rounded data-ends on the baseline,
// year labels under every bar, native tooltips.
export function HiresBars({ employees }) { // exported for reuse in other modules' sweeps
  const nowYear = new Date().getFullYear();
  const years = [nowYear - 3, nowYear - 2, nowYear - 1, nowYear];
  const buckets = years.map(y => ({
    year: y,
    n: employees.filter(e => (e.startDate || '').slice(0, 4) === String(y)).length,
  }));
  const max = Math.max(...buckets.map(b => b.n), 1);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 96 }}>
        {buckets.map(b => (
          <div key={b.year} title={`${b.year}: ${b.n} hire${b.n === 1 ? '' : 's'}`}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 5, height: '100%' }}>
            {b.n > 0 && (
              <span style={{ fontSize: 12, fontWeight: 700, color: b.year === nowYear ? 'var(--wk-brand)' : 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums' }}>{b.n}</span>
            )}
            <div style={{
              width: '100%',
              height: b.n === 0 ? 3 : Math.max(10, Math.round((b.n / max) * 74)),
              borderRadius: '6px 6px 0 0',
              background: b.n === 0 ? 'var(--mist)'
                : (b.year === nowYear
                  ? 'linear-gradient(180deg, #5f74ec 0%, var(--wk-brand) 100%)'
                  : 'linear-gradient(180deg, var(--wk-brand-tint) 0%, #ccd5f8 100%)'),
            }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
        {buckets.map(b => (
          <span key={b.year} style={{ flex: 1, textAlign: 'center', fontSize: 11.5, color: 'var(--wk-faint)', fontVariantNumeric: 'tabular-nums' }}>{b.year}</span>
        ))}
      </div>
    </div>
  );
}

// Cumulative headcount area chart (the reference dashboard's hero form):
// gradient area under a 2px line, live crosshair + tooltip on hover, and
// working time-range chips. Counts are real - everyone whose start date is
// on or before each month's end.
export function HeadcountArea({ employees }) { // exported for reuse in other modules' sweeps
  const [months, setMonths] = useState(12);
  const [hover, setHover] = useState(null); // { i, xPct }
  const W = 320, H = 96, PAD = 4;

  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0); // month end
    const iso = d.toISOString().slice(0, 10);
    buckets.push({
      label: d.toLocaleString('en-US', { month: 'short' }) + (d.getMonth() === 0 || buckets.length === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : ''),
      n: employees.filter(e => e.startDate && e.startDate <= iso).length,
    });
  }
  const max = Math.max(...buckets.map(b => b.n), 1);
  const px = i => PAD + (i / (buckets.length - 1)) * (W - PAD * 2);
  const py = n => H - PAD - (n / max) * (H - PAD * 2);

  const onMove = ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    setHover({ i: Math.round(frac * (buckets.length - 1)) });
  };
  const hb = hover ? buckets[hover.i] : null;

  // Smooth curve (research refs: soft bezier, not a jagged polyline)
  const pts = buckets.map((b, i) => ({ x: px(i), y: py(b.n) }));
  const curve = pts.reduce((acc, p, i, arr) => {
    if (!i) return `M ${p.x} ${p.y}`;
    const p0 = arr[i - 1], cx = (p0.x + p.x) / 2;
    return `${acc} C ${cx} ${p0.y}, ${cx} ${p.y}, ${p.x} ${p.y}`;
  }, '');
  const areaPath = `${curve} L ${pts[pts.length - 1].x} ${H - PAD} L ${PAD} ${H - PAD} Z`;
  const last = pts[pts.length - 1];

  return (
    <div>
      {/* Segmented range control (Stella's Day/Week/Month pattern) */}
      <div className="wk-seg" style={{ marginBottom: 12, alignSelf: 'flex-start' }}>
        {[[12, '12 months'], [24, '2 years'], [48, '4 years']].map(([m, label]) => (
          <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>{label}</button>
        ))}
      </div>
      <div style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img"
          aria-label={`Headcount over the last ${months} months, now ${buckets[buckets.length - 1].n}`}>
          <defs>
            <linearGradient id="hcArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--wk-brand)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--wk-brand)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#hcArea)" />
          <path d={curve} fill="none" stroke="var(--wk-brand)" strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hover && (
            <line x1={px(hover.i)} y1={PAD} x2={px(hover.i)} y2={H - PAD}
              stroke="var(--wk-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* Persistent end-of-line marker + value callout (the "$451"-style tag
            every reference kit uses) - hidden while hovering elsewhere */}
        {!hover && (
          <>
            <span style={{
              position: 'absolute', left: `${(last.x / W) * 100}%`, top: `${(last.y / H) * 100}%`,
              width: 9, height: 9, borderRadius: '50%', background: 'var(--wk-brand)',
              border: '2px solid var(--card)', transform: 'translate(-50%, -50%)', pointerEvents: 'none',
              boxShadow: '0 1px 4px rgba(29,33,57,.25)',
            }} />
            <span style={{
              position: 'absolute', left: `${(last.x / W) * 100}%`, top: `${(last.y / H) * 100}%`,
              transform: 'translate(-105%, -135%)',
              background: 'var(--wk-brand)', color: '#fff', borderRadius: 7, padding: '3px 9px',
              fontSize: 12, fontWeight: 700, fontFamily: 'var(--wk-font)', pointerEvents: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}>{buckets[buckets.length - 1].n}</span>
          </>
        )}
        {hover && (
          <>
            <span style={{
              position: 'absolute', left: `${(px(hover.i) / W) * 100}%`, top: `${(py(hb.n) / H) * 100}%`,
              width: 9, height: 9, borderRadius: '50%', background: 'var(--wk-brand)',
              border: '2px solid var(--card)', transform: 'translate(-50%, -50%)', pointerEvents: 'none',
              boxShadow: '0 1px 4px rgba(29,33,57,.25)',
            }} />
            <div style={{
              position: 'absolute', left: `${(px(hover.i) / W) * 100}%`, top: `${(py(hb.n) / H) * 100}%`,
              transform: `translate(${hover.i > buckets.length / 2 ? '-108%' : '8%'}, -130%)`,
              background: 'var(--ink)', color: 'var(--card)', borderRadius: 7,
              padding: '5px 9px', fontSize: 11, fontFamily: 'var(--wk-font)', fontWeight: 600,
              whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: '0 4px 12px rgba(29,33,57,.2)', zIndex: 5,
            }}>
              {hb.label.trim()} · {hb.n} {hb.n === 1 ? 'person' : 'people'}
            </div>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 10, color: 'var(--wk-faint)' }}>
          <span>{buckets[0].label.trim()}</span>
          <span>{buckets[Math.floor(buckets.length / 2)].label.trim()}</span>
          <span>{buckets[buckets.length - 1].label.trim()}</span>
        </div>
      </div>
    </div>
  );
}

// KPI tile (owner's chosen concept, Jul 28): rounded-2xl tile - one solid
// brand tile per row, the rest white - with label, big number, delta/sub
// caption, and a REAL corner arrow action (filter or jump), never decoration.
function KpiTile({ label, value, delta, sub, solid, onGo, goTitle, loading }) {
  const fg = solid ? '#fff' : 'var(--ink)';
  return (
    <div style={{
      position: 'relative', borderRadius: 16, padding: '16px 18px', minWidth: 0,
      background: solid ? 'linear-gradient(135deg, #4256e8 0%, var(--wk-brand) 100%)' : 'var(--card)',
      border: solid ? '1px solid transparent' : '1px solid var(--wk-line2)',
      boxShadow: 'var(--wk-shadow)', fontFamily: 'var(--wk-font)',
      display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center',
    }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, color: solid ? 'rgba(255,255,255,.8)' : 'var(--muted)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.02em', color: fg, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {loading ? '-' : value}
        </span>
        {delta && (
          <span style={{
            padding: '3px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 700,
            background: solid ? 'rgba(255,255,255,.22)' : 'hsla(var(--color-green),0.12)',
            color: solid ? '#fff' : 'hsl(var(--color-green))',
          }}>{delta}</span>
        )}
      </span>
      {sub && <span style={{ fontSize: 12, color: solid ? 'rgba(255,255,255,.65)' : 'var(--wk-faint)' }}>{sub}</span>}
      {onGo && (
        <button onClick={onGo} title={goTitle} aria-label={goTitle}
          style={{
            position: 'absolute', top: 12, right: 12, width: 30, height: 30, borderRadius: '50%',
            border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: solid ? 'rgba(255,255,255,.2)' : 'var(--wk-hover)',
            color: solid ? '#fff' : 'var(--muted)',
          }}>
          <ArrowUpRight size={15} />
        </button>
      )}
    </div>
  );
}

// Rounded bar chart (the concept's Revenue card): fully-rounded monthly
// headcount bars, latest bar solid brand with a value callout, labels under
// every bar, native tooltips.
function MonthlyBars({ employees }) {
  // NEW JOINERS per month, from recorded start dates - deliberately NOT a
  // cumulative headcount curve. Most legacy profiles were imported without a
  // start date, so a cumulative series claimed the company was near-empty
  // until the first dated hire (Jul 28 bug report: 57 people, bars ~0).
  // Per-month joins only assert what the data actually records.
  const now = new Date();
  const buckets = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.push({
      label: d.toLocaleString('en-US', { month: 'short' }),
      n: employees.filter(e => (e.startDate || '').slice(0, 7) === key).length,
    });
  }
  if (buckets.every(b => b.n === 0)) return (
    <div style={{ height: 155, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '0 18px' }}>
      No recorded start dates in the last 8 months - new joins chart here once profiles carry start dates.
    </div>
  );
  const max = Math.max(...buckets.map(b => b.n), 1);
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 132 }}>
        {buckets.map((b, i) => {
          const isLast = i === buckets.length - 1;
          return (
            <div key={i} title={`${b.label}: ${b.n} joined`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 6, height: '100%' }}>
              {isLast && (
                <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontVariantNumeric: 'tabular-nums' }}>{b.n}</span>
              )}
              <div style={{
                width: '100%', maxWidth: 30,
                height: b.n === 0 ? 4 : Math.max(12, Math.round((b.n / max) * 100)),
                borderRadius: 99,
                background: isLast
                  ? 'linear-gradient(180deg, #5f74ec 0%, var(--wk-brand) 100%)'
                  : 'linear-gradient(180deg, var(--wk-brand-tint) 0%, #ccd5f8 100%)',
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 7 }}>
        {buckets.map((b, i) => (
          <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 11.5, color: 'var(--wk-faint)' }}>{b.label}</span>
        ))}
      </div>
    </div>
  );
}

const DEPT_COLORS = ['#2b45e1', '#dc7a18', '#248f4b', '#8a31c9', '#b8860b'];

function PeopleStatCards({ employees, loading, isMobile, onStatusFilter, onJumpToDirectory }) {
  const total = employees.length;
  const nActive = employees.filter(e => e.status === 'active').length;
  const nOnboarding = employees.filter(e => e.status === 'onboarding').length;
  const joined = employees.filter(e => (e.startDate || '').slice(0, 4) === String(new Date().getFullYear())).length;
  const types = EMP_TYPES
    .map(([k, label], i) => ({ key: k, label, color: WK_TYPE_COLORS[i % WK_TYPE_COLORS.length], n: employees.filter(e => e.employmentType === k).length }));
  const depts = [...employees.reduce((m, e) => {
    if (e.department) m.set(e.department, (m.get(e.department) || 0) + 1);
    return m;
  }, new Map())].sort((a, b) => b[1] - a[1]);
  const deptSegs = depts.map(([name, n], i) => ({ key: name, label: name, color: DEPT_COLORS[i % DEPT_COLORS.length], n }));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(300px, 1.05fr) 1.4fr 1.15fr', gap: 14, marginBottom: 16, alignItems: 'stretch' }}>
      {/* 2×2 KPI tiles - solid brand hero + white siblings */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <KpiTile solid label="Total people" value={total} loading={loading}
          delta={joined > 0 ? `↑ ${joined}` : undefined} sub="this year"
          onGo={onJumpToDirectory} goTitle="See the directory" />
        <KpiTile label="Active" value={nActive} loading={loading} sub={total ? `${Math.round((nActive / total) * 100)}% of people` : 'no people yet'}
          onGo={() => onStatusFilter?.('active')} goTitle="Filter directory to active" />
        <KpiTile label="Onboarding" value={nOnboarding} loading={loading} sub="joining now"
          onGo={() => onStatusFilter?.('onboarding')} goTitle="Filter directory to onboarding" />
        <KpiTile label="Departments" value={depts.length} loading={loading} sub="across the company" />
      </div>

      {/* Rounded-bar headcount chart (the concept's Revenue card) */}
      <StatCardShell Icon={Users} title="New joiners" meta="last 8 months">
        <MonthlyBars employees={employees} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 14px', fontSize: 12.5, color: 'var(--muted)' }}>
          {types.filter(t => t.n > 0).map(t => (
            <span key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color }} />
              {t.label} <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{t.n}</b>
            </span>
          ))}
          {!loading && total === 0 && <span>No people yet</span>}
        </div>
      </StatCardShell>

      {/* Category donut + side legend (the concept's Sales by Category card) */}
      <StatCardShell Icon={Building2} title="By department" meta={depts.length ? `${depts.length} total` : undefined}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <StatusDonut segments={deptSegs} total={total} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
            {deptSegs.slice(0, 5).map(s => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{loading ? '-' : s.n}</span>
              </div>
            ))}
            {!loading && deptSegs.length === 0 && (
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Departments appear as people are added.</span>
            )}
          </div>
        </div>
      </StatCardShell>
    </div>
  );
}

export default function HR({ activeSub, onSubChange }) {
  // Legacy subviews (hr-ms / hr-asana / …) all collapse into People for now.
  // E-Sign moved to its own top-level Documents module (Jul 2026); legacy
  // 'hr-esign*' deep-links are redirected there by the effect below.
  // hr-external intentionally absent (Neil, Aug 24: External tab folded into
  // People) - old deep links fall through to hr-people, where externals live now.
  const sub = ['hr-people', 'hr-hiring', 'hr-org', 'hr-leave', 'hr-time', 'hr-access'].includes(activeSub) ? activeSub : 'hr-people';
  const isMobile = useIsMobile();

  // Old notifications/URLs still point at hr/hr-esign* - bounce them to Documents
  // so those links don't dead-end on the People tab.
  useEffect(() => {
    if (String(activeSub || '').startsWith('hr-esign')) {
      const dst = activeSub === 'hr-esign-requests' ? 'documents-esign-requests' : 'documents-esign';
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: dst } }));
    }
  }, [activeSub]);

  const [employees, setEmployees] = useState([]);
  // Guest/external people (Aug 24: managed from People, not a separate tab).
  // Kept OUT of `employees` on purpose - counts, org chart, manager pickers and
  // every internal-only list keep reading `employees` unchanged; the directory
  // is the one surface that merges both.
  const [extEmployees, setExtEmployees] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [search,    setSearch]    = useState('');
  const [deptF,     setDeptF]     = useState('All');
  const [companyF,  setCompanyF]  = useState('All');
  const [statusF,   setStatusF]   = useState('All');
  const [typeF,     setTypeF]     = useState('All');   // All | employee | contractor | external
  // DELETED_F is a view, not a status: a removed person keeps whatever status
  // they had, so it cannot live in STATUS_META alongside active/onboarding.
  const [deletedEmployees, setDeletedEmployees] = useState([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [formOpen,  setFormOpen]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  // One Add control (Neil, Aug 24): Add Employee / Add Independent Contractor /
  // Add External - everything lands in the master People list.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addPreset,   setAddPreset]   = useState('full_time');   // employment type the Add form opens with
  const [inviteOpen,  setInviteOpen]  = useState(false);
  const [entities,  setEntities]  = useState([]);
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const [sites,     setSites]     = useState([]);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [toast,     setToast]     = useState(null);
  const { canAccessModule, can, hrScope } = useRole();
  const canSeeComp = canAccessModule('hr_comp', 'owner', 'viewer');
  const isAdmin = can('administrator');   // Roles & Access tab is admin-only
  // Company-scoped People admin (Neil, Aug 25): hrScope = list of HrEntity ids
  // this admin is limited to (server-enforced; the lists that arrive are
  // already filtered). Non-null hides company-wide actions and shows a chip.
  const isScoped = Array.isArray(hrScope) && hrScope.length > 0;
  const scopeNames = isScoped ? hrScope.map(id => entities.find(en => en.id === id)?.name || null).filter(Boolean) : [];

  const toastErr = msg => { setToast({ msg, kind: 'error' }); setTimeout(() => setToast(null), 5000); };
  const toastOk  = msg => { setToast({ msg, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };

  // Deep link from a person hover card anywhere in Nexus (openPersonProfile).
  // Two triggers, because this view may or may not be mounted when the jump
  // fires: the stash covers a cold mount, the event covers an already-open one.
  // Waits for `employees` - the jump carries an email and only the loaded list
  // can resolve it to the row id the detail pane selects on.
  useEffect(() => {
    if (!employees.length) return undefined;
    const openFor = email => {
      const em = (email || '').trim().toLowerCase();
      if (!em) return;
      const match = [...employees, ...extEmployees].find(x => (x.workEmail || '').toLowerCase() === em);
      if (match) setSelectedId(match.id);
      else toastErr(`${em} is not in People.`);
    };
    openFor(takePendingPerson());
    const h = e => openFor(e.detail?.email);
    window.addEventListener('nexus:person', h);
    return () => window.removeEventListener('nexus:person', h);
  }, [employees, extEmployees]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncLabel, setSyncLabel] = useState('');
  // ONE button, the whole sync: the server pulls the directory (link/backfill,
  // as before), then pushes EVERY linked profile back to Entra - Nexus values
  // win, job titles go out level-stripped. It runs server-side as a background
  // job (a few minutes of Graph calls), so this just starts it and polls the
  // status row; the photos pass stays a separate best-effort follow-up.
  async function runSync() {
    if (syncBusy) return;
    setSyncBusy(true);
    setSyncLabel('Starting…');
    try {
      await api.syncM365TwoWay();
      let s = null;
      for (;;) {
        await new Promise(r => setTimeout(r, 2500));
        try { s = await api.syncM365TwoWayStatus(); } catch { continue; }
        if (s.phase === 'pull') setSyncLabel('Pulling directory…');
        else if (s.phase === 'push') setSyncLabel(`Pushing ${s.done}/${s.total}…`);
        else break;
      }
      if (s?.phase === 'failed') {
        toastErr(`M365 sync failed: ${s.errors?.[0]?.error || 'see server logs'}.`);
      } else {
        const bits = [];
        const p = s?.pull || {};
        if (p.created) bits.push(`${p.created} added`);
        bits.push(`${p.linked || 0} linked`, `${p.updated || 0} updated`);
        bits.push(`${s?.pushedOk || 0} pushed to M365`);
        if (s?.pushFailed) bits.push(`${s.pushFailed} push failure${s.pushFailed > 1 ? 's' : ''} (${(s.errors || []).slice(0, 3).map(e => e.email).join(', ')}${(s.errors || []).length > 3 ? '…' : ''})`);
        if (p.removed?.length) bits.push(`${p.removed.length} removed (shared/inactive)`);
        if (p.unlinked?.length) bits.push(`unlinked (account deleted): ${p.unlinked.join(', ')}`);
        try {
          setSyncLabel('Syncing photos…');
          const ph = await api.syncM365Photos();
          if (ph.updated) bits.push(`${ph.updated} photos`);
        } catch { /* photo pass is best-effort */ }
        toastOk(`M365 sync: ${bits.join(' · ')}.`);
      }
      load();
    } catch (err) { toastErr(err?.message || 'Sync failed.'); }
    setSyncBusy(false);
    setSyncLabel('');
  }

  function load() {
    api.getEmployees()
      .then(rows => {
        // Split internal vs guest/external. `employees` stays internal-only so
        // the Total/Active/New joiners cards, By department chart, org chart
        // and every picker built on it are unchanged; externals join the
        // DIRECTORY via extEmployees (Neil, Aug 24: one master People list).
        setEmployees(rows.filter(e => !['guest', 'external'].includes(e.identityType || 'internal')));
        setExtEmployees(rows.filter(e => ['guest', 'external'].includes(e.identityType || 'internal')));
        setError('');
      })
      .catch(err => setError(err?.message || 'Could not load employees.'))
      .finally(() => setLoading(false));
  }
  // Removed people are a SEPARATE list, fetched only when the Deleted filter is
  // chosen. They are deliberately not folded into `employees`: everything else
  // on this screen (counts, org chart, manager lookups, pickers) treats that
  // array as "the people who work here", and a removed person appearing there
  // would be the exact leak the server-side global filter exists to prevent.
  function loadDeleted() {
    setDeletedLoading(true);
    api.getDeletedEmployees()
      .then(rows => { setDeletedEmployees(rows); setError(''); })
      .catch(err => setError(err?.message || 'Could not load removed people.'))
      .finally(() => setDeletedLoading(false));
  }
  const loadEntities = () => api.getEntities().then(setEntities).catch(() => setEntities([]));
  const loadSites = () => api.getWorkSites().then(setSites).catch(() => setSites([]));
  useEffect(load, []);
  useEffect(() => { loadEntities(); loadSites(); }, []);
  const entityName = id => entities.find(en => en.id === id)?.name || '';

  // Department filter choices are the departments actually in use, scoped to the
  // chosen company - no hardcoded list.
  const deptChoices = useMemo(() => {
    const src = companyF === 'All' ? employees : employees.filter(e => e.company === companyF);
    return [...new Set(src.map(e => (e.department || '').trim()).filter(Boolean))].sort();
  }, [employees, companyF]);

  const showingDeleted = statusF === DELETED_F;
  const isExtRow = e => ['guest', 'external'].includes(e.identityType || 'internal');
  const filtered = useMemo(() => {
    // The directory is the MASTER list: internal people + guest/external
    // accounts together (Neil, Aug 24), narrowed by the worker-type filter.
    const source = showingDeleted ? deletedEmployees
      : [...employees, ...extEmployees].sort((a, b) => fullName(a).localeCompare(fullName(b)));
    return source.filter(e => {
      if (typeF === 'employee' && (isExtRow(e) || e.employmentType === 'contractor')) return false;
      if (typeF === 'contractor' && (isExtRow(e) || e.employmentType !== 'contractor')) return false;
      if (typeF === 'external' && !isExtRow(e)) return false;
      if (companyF !== 'All' && e.company !== companyF) return false;
      if (deptF !== 'All' && e.department !== deptF) return false;
      // Skipped while showing removed people - they keep their old status, so
      // matching on it here would filter the list down to nothing.
      if (!showingDeleted && statusF !== 'All' && e.status !== statusF) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return [fullName(e), e.workEmail, e.employeeCode, e.jobTitle, e.department, e.externalCompany].some(v => (v || '').toLowerCase().includes(q));
      }
      return true;
    });
  }, [employees, extEmployees, deletedEmployees, showingDeleted, typeF, companyF, deptF, statusF, search]);

  // Pagination over the FILTERED list, so search/filters always reach the whole
  // directory - a match "on page 10" simply becomes page 1 of the results.
  const PAGE_SIZE = 12;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [search, companyF, deptF, statusF, typeF]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const paged = useMemo(() => filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE),
    [filtered, curPage]);

  const selected = (showingDeleted ? deletedEmployees : [...employees, ...extEmployees])
    .find(e => e.id === selectedId) || null;
  const counts = useMemo(() => ({
    total: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    onboarding: employees.filter(e => e.status === 'onboarding').length,
    depts: new Set(employees.filter(e => e.department).map(e => e.department)).size,
  }), [employees]);

  const onRemovedFromNexus = (id) => {   // Nexus-only removal: drop from the live list and close the profile
    setEmployees(prev => prev.filter(e => e.id !== id));
    setExtEmployees(prev => prev.filter(e => e.id !== id));
    setDeletedEmployees([]);             // stale now; refetched when Deleted is opened
    setSelectedId(null);
  };
  const onRestoredToNexus = (restored) => {
    setDeletedEmployees(prev => prev.filter(e => e.id !== restored.id));
    setEmployees(prev => prev.some(e => e.id === restored.id)
      ? prev
      : [...prev, restored].sort((a, b) => fullName(a).localeCompare(fullName(b))));
    setSelectedId(null);
  };
  const onSaved = saved => {
    const isNew = !employees.some(e => e.id === saved.id) && !extEmployees.some(e => e.id === saved.id);   // add modal shows its own toast
    // Route the row to the list its identity belongs in - an edit can flip a
    // person between internal and guest/external.
    const ext = ['guest', 'external'].includes(saved.identityType || 'internal');
    const upsert = prev => {
      const i = prev.findIndex(e => e.id === saved.id);
      if (i === -1) return [...prev, saved].sort((a, b) => fullName(a).localeCompare(fullName(b)));
      const next = [...prev]; next[i] = saved; return next;
    };
    const drop = prev => prev.filter(e => e.id !== saved.id);
    setEmployees(ext ? drop : upsert);
    setExtEmployees(ext ? upsert : drop);
    setSelectedId(saved.id);
    // Profile edits auto-mirror to the linked Entra account (backend, best-effort)
    // - tell the user whether M365 actually took the change.
    if (saved.entra) {
      if (saved.entra.synced) toastOk('Saved - profile synced to Microsoft 365.');
      else toastErr(`Saved in Nexus, but the M365 sync failed: ${saved.entra.error || 'Graph error'}. Use "Push to M365" to retry.`);
    } else if (!isNew) {
      toastOk('Saved.');
    }
  };

  const TABS = [
    { key: 'hr-people', label: 'People',    Icon: Users },
    { key: 'hr-hiring', label: 'Hiring',    Icon: UserPlus },
    { key: 'hr-org',    label: 'Org Chart', Icon: Network },
    { key: 'hr-leave',  label: 'Leave',     Icon: CalendarOff },
    { key: 'hr-time',   label: 'Time',      Icon: Clock },
    // The External tab is gone (Neil, Aug 24): external/guest people live in
    // the People directory with a worker-type filter, and their lifecycle
    // actions sit on their profile card.
    ...(isAdmin ? [{ key: 'hr-access', label: 'Roles & Access', Icon: Shield }] : []),
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Full-bleed (owner call, Jul 28): use the whole viewport width - the
          .viewport padding provides the slight edge margin */}
      <div className="view-header" style={{ marginBottom: 18 }}>
        {/* Icon-chip page title (Work OS grammar - the module's meaning color) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Users size={19} />
          </span>
          <div className="view-title-group">
            <h2 style={{ fontFamily: 'var(--wk-font)' }}>People</h2>
            <p>People, hiring, org structure and leave - one source of truth</p>
          </div>
        </div>
        {sub === 'hr-people' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', alignItems: 'center' }}>
            {isScoped && (
              <span title="Your People access is limited to these companies - people, time and leave outside them are not shown."
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', fontSize: 12, fontWeight: 700 }}>
                <Building2 size={13} /> Showing: {scopeNames.length ? scopeNames.join(', ') : 'your companies'}
              </span>
            )}
            {!isScoped && (
            <button className="secondary-btn" disabled={syncBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Two-way sync: pulls the M365 directory in (new people added, profiles linked, empty fields + photos backfilled), then pushes every linked profile back to Entra - Nexus values win, job titles go out without level markers."
              onClick={runSync}>
              {syncBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <History size={14} />} {syncBusy && syncLabel ? syncLabel : 'Sync M365'}
            </button>
            )}
            <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Manage companies & their departments"
              onClick={() => setEntitiesOpen(true)}>
              <Building2 size={14} /> Company setup
            </button>
            <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Manage work sites (for geofenced clock-in)"
              onClick={() => setSitesOpen(true)}>
              <MapPinned size={14} /> Work sites
            </button>
            {/* One Add control (Neil, Aug 24): employee, independent contractor
                or external partner - all into the same master list. */}
            <div style={{ position: 'relative' }}>
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                onClick={() => setAddMenuOpen(o => !o)} aria-expanded={addMenuOpen}>
                <Plus size={15} /> Add Person <ChevronDown size={14} />
              </button>
              {addMenuOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 1190 }} onClick={() => setAddMenuOpen(false)} />
                  <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 1200, minWidth: 240, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: 6 }}>
                    {[
                      ['Add Employee', 'On payroll - full profile, provisioning, time tracking', () => { setEditing(null); setAddPreset('full_time'); setFormOpen(true); }],
                      ['Add Independent Contractor', 'Engagement scope, SOW and rate on the same record', () => { setEditing(null); setAddPreset('contractor'); setFormOpen(true); }],
                      ...(isAdmin ? [['Add External', 'Partner-company person - invited by email, code sign-in', () => setInviteOpen(true)]] : []),
                    ].map(([lbl, hint, fn]) => (
                      <button key={lbl} onClick={() => { setAddMenuOpen(false); fn(); }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', borderRadius: 8, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--mist)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{lbl}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tabs - desktop renders them centered in the top header; phones keep
          the in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TABS} active={sub} onChange={onSubChange} />

      {sub === 'hr-hiring' && (
        <HiringTab isMobile={isMobile} toastOk={toastOk} toastErr={toastErr}
          onEmployeeCreated={emp => setEmployees(prev => [...prev, emp].sort((a, b) => fullName(a).localeCompare(fullName(b))))}
          onSendForSignature={c => {
            // E-Sign lives in the Documents module now - stash the offer and jump
            // there; Documents picks up window.__esignPrefill on arrival.
            window.__esignPrefill = {
              candidateId: c.id, title: `Offer - ${candName(c)}`,
              parties: [{ role_key: 'employee', name: candName(c), email: c.email, kind: 'external', ordinal: 2 }],
            };
            window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign' } }));
          }} />
      )}
      {sub === 'hr-org' && <OrgChartTab employees={employees} entities={entities} onUpdated={onSaved} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-leave' && <LeaveTab employees={employees} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-time' && <TimeAdmin employees={employees} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-access' && isAdmin && <RolesAccess embedded />}

      {sub === 'hr-people' && (<>
        <EmployeeRequestsPanel toastOk={toastOk} toastErr={toastErr} />
        {/* Stat cards - headcount composition, status breakdown, department
            spread (real data, designed zero/loading states) */}
        <PeopleStatCards employees={employees} loading={loading} isMobile={isMobile}
          onStatusFilter={s => { setStatusF(s); setSelectedId(null); }}
          onJumpToDirectory={() => { setSelectedId(null); setStatusF('All'); }} />

        {error && (
          <div style={{ background: 'var(--bad-bg)', color: 'var(--bad-fg)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
            {error} <button onClick={() => { setLoading(true); load(); }} style={{ background: 'none', border: 'none', color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}

        {selected && isMobile ? (
          /* Phones keep the focused full-screen profile with an explicit way
             back; desktop now shows the profile IN PLACE beside the list. */
          <>
          <button onClick={() => setSelectedId(null)} className="secondary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <ChevronLeft size={14} /> Back to directory
          </button>
          <EmployeeDetail key={selected.id} e={selected} employees={employees} isMobile={isMobile}
            companyName={entityName(selected.company)} canSeeComp={canSeeComp} isAdmin={isAdmin}
            toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved} onRemoved={onRemovedFromNexus} onRestored={onRestoredToNexus}
            onExternalChanged={load}
            onEdit={emp => { setEditing(emp); setFormOpen(true); }}
            onBack={() => setSelectedId(null)} />
          </>
        ) : (
          /* Directory - Stella's employee table: card header carries the
             search + filters; gray column-header band; avatar + name + email
             rows; whole row opens the profile. */
          <div className="wkc">
            <div className="wkc-head">
              <span className="wkc-chip"><Users size={14} /></span>
              <span className="wkc-title">Directory</span>
              {!loading && filtered.length > 0 && <span className="dk-count">{filtered.length}</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div className="search-bar" style={{ width: 210 }}>
                  <Search size={13} style={{ flexShrink: 0 }} />
                  <input placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} />
                  {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
                </div>
                {/* Worker-type filter (Neil, Aug 24): the directory is the master
                    list, this narrows it to a category. */}
                <select className="form-input" value={typeF} onChange={e => { setTypeF(e.target.value); setSelectedId(null); }} style={{ width: 140, padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All people</option>
                  <option value="employee">Employees</option>
                  <option value="contractor">Contractors</option>
                  <option value="external">External &amp; guests</option>
                </select>
                <select className="form-input" value={companyF} onChange={e => { setCompanyF(e.target.value); setDeptF('All'); }} style={{ width: 150, padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All companies</option>
                  {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
                </select>
                <select className="form-input" value={deptF} onChange={e => setDeptF(e.target.value)} style={{ width: 155, padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All departments</option>
                  {deptChoices.map(d => <option key={d}>{d}</option>)}
                </select>
                {/* Choosing Deleted fetches that list here rather than in an
                    effect - the dropdown is the only way into the view, so the
                    fetch belongs to the action that causes it. */}
                <select className="form-input" value={statusF}
                  onChange={e => {
                    const next = e.target.value;
                    setStatusF(next);
                    setSelectedId(null);
                    if (next === DELETED_F) loadDeleted();
                  }}
                  style={{ width: 135, padding: '7px 10px', fontSize: 13.5, height: 38 }}>
                  <option value="All">All statuses</option>
                  {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
                  <option value={DELETED_F}>Deleted</option>
                </select>
              </div>
            </div>
            {(loading || (showingDeleted && deletedLoading)) ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
                <Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
              </div>
            ) : showingDeleted && deletedEmployees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)' }}>
                <Trash2 size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>Nobody has been removed.</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>People removed from Nexus land here, and can be restored with their full record.</div>
              </div>
            ) : !showingDeleted && employees.length + extEmployees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)' }}>
                <Users size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>No employees yet.</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>Add the first one - everything else in HR builds on these records.</div>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No matches.</div>
            ) : isMobile ? (
              <>
              <table className="ppl-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th className="ppl-col-secondary">Position</th>
                    <th className="ppl-col-secondary">Department</th>
                    <th>Status</th>
                    <th style={{ width: 34 }} aria-label="Open profile" />
                  </tr>
                </thead>
                <tbody>
                  {paged.map(e => {
                    const sm = STATUS_META[e.status] || STATUS_META.active;
                    return (
                      <tr key={e.id} onClick={() => setSelectedId(e.id)}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                            <Avatar e={e} card={false} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                                {fullName(e)}{isExtRow(e) && <ExternalBadge />}
                              </div>
                              <div className="ppl-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {e.workEmail || e.employeeCode}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="ppl-col-secondary">{e.jobTitle || '-'}</td>
                        <td className="ppl-col-secondary">{e.department || '-'}</td>
                        <td>
                          <span style={{ padding: '4px 11px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, background: sm.bg, color: sm.fg, whiteSpace: 'nowrap' }}>{sm.label}</span>
                        </td>
                        <td><ChevronRight size={14} style={{ color: 'var(--wk-faint)' }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderTop: '1px solid var(--line)', fontSize: 12.5, color: 'var(--muted)' }}>
                  <span>{(curPage - 1) * PAGE_SIZE + 1}-{Math.min(curPage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                  <span style={{ flex: 1 }} />
                  <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
                  <span style={{ fontWeight: 700 }}>Page {curPage} of {totalPages}</span>
                  <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next</button>
                </div>
              )}
              </>
            ) : (
              /* Desktop master-detail: names on the left, the profile opens in
                 place on the right - no back-navigation. The list paginates;
                 search/filters run over the WHOLE directory before paging. */
              <div style={{ display: 'grid', gridTemplateColumns: '330px 1fr', alignItems: 'stretch' }}>
                <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 460 }}>
                  <div style={{ flex: 1, overflowY: 'auto', maxHeight: '64vh' }}>
                    {paged.map(e => {
                      const sm = STATUS_META[e.status] || STATUS_META.active;
                      const active = selectedId === e.id;
                      return (
                        <button key={e.id} onClick={() => setSelectedId(e.id)}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer', background: active ? 'var(--wk-brand-tint)' : 'none', fontFamily: 'inherit' }}>
                          <Avatar e={e} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                              {fullName(e)}{isExtRow(e) && <ExternalBadge />}
                            </div>
                            <div className="ppl-cell-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.jobTitle || e.externalCompany || e.workEmail || '-'}</div>
                          </div>
                          <span title={sm.label} style={{ width: 8, height: 8, borderRadius: '50%', background: sm.fg, flexShrink: 0 }} />
                          <ChevronRight size={13} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
                        </button>
                      );
                    })}
                  </div>
                  {totalPages > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
                      <span>{(curPage - 1) * PAGE_SIZE + 1}-{Math.min(curPage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                      <span style={{ flex: 1 }} />
                      <button className="secondary-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
                      <span style={{ fontWeight: 700 }}>{curPage}/{totalPages}</span>
                      <button className="secondary-btn" style={{ padding: '3px 9px', fontSize: 11.5 }} disabled={curPage >= totalPages} onClick={() => setPage(curPage + 1)}>Next</button>
                    </div>
                  )}
                </div>
                <div style={{ padding: '16px 18px', minWidth: 0 }}>
                  {selected ? (
                    <EmployeeDetail key={selected.id} e={selected} employees={employees} isMobile={isMobile}
                      companyName={entityName(selected.company)} canSeeComp={canSeeComp} isAdmin={isAdmin}
                      toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved} onRemoved={onRemovedFromNexus} onRestored={onRestoredToNexus}
                      onExternalChanged={load}
                      onEdit={emp => { setEditing(emp); setFormOpen(true); }}
                      onBack={() => setSelectedId(null)} />
                  ) : (
                    <div style={{ padding: '64px 16px', textAlign: 'center', color: 'var(--muted)' }}>
                      <Users size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Pick a person</div>
                      <div style={{ fontSize: 12.5, marginTop: 4 }}>Their full profile opens right here - no page hopping.</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </>)}

      {formOpen && (
        <EmployeeFormModal employee={editing} employees={employees} entities={entities} isAdmin={isAdmin} canSeeComp={canSeeComp}
          initialType={addPreset}
          onClose={() => { setFormOpen(false); setEditing(null); setAddPreset('full_time'); }}
          onSaved={onSaved} toastOk={toastOk} toastErr={toastErr} />
      )}
      {inviteOpen && (
        <InviteExternalModal initial={null}
          onClose={() => setInviteOpen(false)}
          onSaved={(result) => {
            setInviteOpen(false);
            inviteOutcomeToast(result, toastOk, toastErr);
            load();   // the new external lands in the directory (master list)
          }} />
      )}
      {entitiesOpen && (
        <EntitiesModal entities={entities} employees={employees} onClose={() => setEntitiesOpen(false)}
          onChanged={() => { load(); return loadEntities(); }} toastOk={toastOk} toastErr={toastErr} scoped={isScoped} />
      )}
      {sitesOpen && (
        <WorkSitesModal sites={sites} entities={entities} onClose={() => setSitesOpen(false)}
          onChanged={loadSites} toastOk={toastOk} toastErr={toastErr} />
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
