import { useState, useEffect, useMemo } from 'react';
import {
  Users, Plus, Search, X, Loader2, Mail, Phone, Briefcase, MapPin,
  ChevronLeft, Network, CalendarOff, UserPlus, Pencil, FileText,
} from 'lucide-react';
import { api } from '../api';

// ── HR module — Phase 1: employee master + People directory ──────────────────
// Hiring pipeline, org chart and leave land in later phases (tabs are stubs).
// Old hardcoded onboarding/disclosure screens were dummy data — removed.

const DEPTS = ['Operations', 'Accounting', 'IT', 'Construction', 'Facilities', 'Marketing', 'Real Estate', 'Admin', 'HR'];
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

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

const AVATAR_HUES = ['215,75%,45%', '142,60%,35%', '30,80%,48%', '271,60%,48%', '350,65%,48%'];
const fullName = e => [e.firstName, e.lastName].filter(Boolean).join(' ');
const initials = e => `${(e.firstName || '?')[0]}${(e.lastName || '')[0] || ''}`.toUpperCase();
const hueFor = e => AVATAR_HUES[(e.employeeCode || e.id || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_HUES.length];

function Avatar({ e, size = 38 }) {
  if (e.photoUrl) return <img src={e.photoUrl} alt="" style={{ width: size, height: size, borderRadius: size * 0.28, objectFit: 'cover', flexShrink: 0 }} />;
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.28, background: `hsla(${hueFor(e)},0.13)`, color: `hsl(${hueFor(e)})`, fontSize: size * 0.34, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {initials(e)}
    </div>
  );
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
function EmployeeFormModal({ employee, employees, onClose, onSaved, toastErr }) {
  const editing = !!employee;
  const [f, setF] = useState(() => ({
    first_name:      employee?.firstName || '',
    last_name:       employee?.lastName || '',
    work_email:      employee?.workEmail || '',
    personal_email:  employee?.personalEmail || '',
    phone:           employee?.phone || '',
    job_title:       employee?.jobTitle || '',
    department:      employee?.department || 'Operations',
    employment_type: employee?.employmentType || 'full_time',
    start_date:      employee?.startDate || '',
    manager_email:   employee?.managerEmail || '',
    status:          employee?.status || 'active',
    location:        employee?.location || '',
    notes:           employee?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  // Manager picker: anyone with a work email (yourself excluded when editing)
  const managers = employees.filter(e => e.workEmail && e.id !== employee?.id);

  async function save() {
    if (!f.first_name.trim() || busy) return;
    setBusy(true);
    try {
      const saved = editing ? await api.updateEmployee(employee.id, f) : await api.createEmployee(f);
      onSaved(saved);
      onClose();
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{editing ? `Edit ${fullName(employee)}` : 'Add Employee'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {input('FIRST NAME *', 'first_name', { autoFocus: !editing })}
          {input('LAST NAME', 'last_name')}
          {input('WORK EMAIL', 'work_email', { type: 'email', placeholder: 'empty until provisioned' })}
          {input('PERSONAL EMAIL', 'personal_email', { type: 'email' })}
          {input('PHONE', 'phone')}
          {input('JOB TITLE', 'job_title')}
          <div>
            <label style={FL}>DEPARTMENT</label>
            <select className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
              {DEPTS.map(d => <option key={d}>{d}</option>)}
            </select>
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
              <option value="">— no reporting line —</option>
              {managers.map(m => <option key={m.id} value={m.workEmail}>{fullName(m)} ({m.workEmail})</option>)}
            </select>
          </div>
          {input('LOCATION', 'location', { placeholder: 'e.g. Escondido office' })}
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

// ── Profile detail pane ───────────────────────────────────────────────────────
function EmployeeDetail({ e, employees, onEdit, onBack, isMobile }) {
  const sm = STATUS_META[e.status] || STATUS_META.active;
  const manager = employees.find(m => m.workEmail && m.workEmail === e.managerEmail);
  const reports = employees.filter(r => e.workEmail && r.managerEmail === e.workEmail);
  const row = (Icon, label, value) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: value ? 'var(--ink)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value || '—'}</span>
    </div>
  );
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '22px 24px', boxShadow: 'var(--shadow-sm)' }}>
      {isMobile && (
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0, marginBottom: 14 }}>
          <ChevronLeft size={15} /> All people
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
        <Avatar e={e} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{fullName(e)}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {[e.jobTitle, e.employeeCode].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: sm.bg, color: sm.fg }}>{sm.label}</span>
        <button className="secondary-btn" onClick={() => onEdit(e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Pencil size={13} /> Edit
        </button>
      </div>
      <div style={{ marginTop: 14 }}>
        {row(Mail, 'Work email', e.workEmail)}
        {row(Mail, 'Personal', e.personalEmail)}
        {row(Phone, 'Phone', e.phone)}
        {row(Briefcase, 'Department', [e.department, TYPE_LABEL[e.employmentType]].filter(Boolean).join(' · '))}
        {row(CalendarOff, 'Start date', e.startDate)}
        {row(MapPin, 'Location', e.location)}
        {row(Network, 'Reports to', manager ? `${fullName(manager)} (${manager.employeeCode})` : e.managerEmail)}
        {reports.length > 0 && row(Users, 'Direct reports', reports.map(fullName).join(', '))}
        {e.notes && row(FileText, 'Notes', e.notes)}
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function HR({ activeSub, onSubChange }) {
  // Legacy subviews (hr-ms / hr-asana / …) all collapse into People for now
  const sub = ['hr-people', 'hr-hiring', 'hr-org', 'hr-leave'].includes(activeSub) ? activeSub : 'hr-people';
  const isMobile = useIsMobile();

  const [employees, setEmployees] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [search,    setSearch]    = useState('');
  const [deptF,     setDeptF]     = useState('All');
  const [statusF,   setStatusF]   = useState('All');
  const [selectedId, setSelectedId] = useState(null);
  const [formOpen,  setFormOpen]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [toast,     setToast]     = useState(null);

  const toastErr = msg => { setToast(msg); setTimeout(() => setToast(null), 5000); };

  function load() {
    api.getEmployees()
      .then(rows => { setEmployees(rows); setError(''); })
      .catch(err => setError(err?.message || 'Could not load employees.'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  const filtered = useMemo(() => employees.filter(e => {
    if (deptF !== 'All' && e.department !== deptF) return false;
    if (statusF !== 'All' && e.status !== statusF) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return [fullName(e), e.workEmail, e.employeeCode, e.jobTitle, e.department].some(v => (v || '').toLowerCase().includes(q));
    }
    return true;
  }), [employees, deptF, statusF, search]);

  const selected = employees.find(e => e.id === selectedId) || null;
  const counts = useMemo(() => ({
    total: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    onboarding: employees.filter(e => e.status === 'onboarding').length,
    depts: new Set(employees.filter(e => e.department).map(e => e.department)).size,
  }), [employees]);

  const onSaved = saved => {
    setEmployees(prev => {
      const i = prev.findIndex(e => e.id === saved.id);
      if (i === -1) return [...prev, saved].sort((a, b) => fullName(a).localeCompare(fullName(b)));
      const next = [...prev]; next[i] = saved; return next;
    });
    setSelectedId(saved.id);
  };

  const TABS = [
    ['hr-people', 'People'], ['hr-hiring', 'Hiring'], ['hr-org', 'Org Chart'], ['hr-leave', 'Leave'],
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div className="view-title-group">
          <h2>Human Resources</h2>
          <p>People, hiring, org structure and leave — one source of truth</p>
        </div>
        {sub === 'hr-people' && (
          <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0 }}
            onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus size={15} /> Add Employee
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="chip-row scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => onSubChange ? onSubChange(key) : null}
            style={{ padding: '7px 16px', borderRadius: 10, border: `1px solid ${sub === key ? 'var(--pine)' : 'var(--line)'}`, background: sub === key ? 'hsla(var(--color-green),0.08)' : 'var(--card)', color: sub === key ? 'hsl(var(--color-green))' : 'var(--muted)', fontWeight: sub === key ? 700 : 600, fontSize: 13, cursor: 'pointer', fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {label}
          </button>
        ))}
      </div>

      {sub !== 'hr-people' && (
        <div style={{ textAlign: 'center', padding: '64px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <Network size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>{TABS.find(([k]) => k === sub)?.[1]} is coming in the next phase.</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>The People directory is live — hiring pipeline, org chart and leave build on it.</div>
        </div>
      )}

      {sub === 'hr-people' && (<>
        {/* KPI strip */}
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="kpi-card card-blue"><div className="kpi-label">Total People</div><div className="kpi-value">{counts.total}</div></div>
          <div className="kpi-card card-green"><div className="kpi-label">Active</div><div className="kpi-value">{counts.active}</div></div>
          <div className="kpi-card card-orange"><div className="kpi-label">Onboarding</div><div className="kpi-value">{counts.onboarding}</div></div>
          <div className="kpi-card card-purple"><div className="kpi-label">Departments</div><div className="kpi-value">{counts.depts}</div></div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div className="search-bar" style={{ flex: '1 1 220px', maxWidth: 360 }}>
            <Search size={13} style={{ flexShrink: 0 }} />
            <input placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
          </div>
          <select className="form-input" value={deptF} onChange={e => setDeptF(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, height: 34 }}>
            <option value="All">All departments</option>
            {DEPTS.map(d => <option key={d}>{d}</option>)}
          </select>
          <select className="form-input" value={statusF} onChange={e => setStatusF(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, height: 34 }}>
            <option value="All">All statuses</option>
            {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            {counts.total} total · {counts.active} active · {filtered.length} shown
          </span>
        </div>

        {error && (
          <div style={{ background: 'var(--bad-bg)', color: 'var(--bad-fg)', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
            {error} <button onClick={() => { setLoading(true); load(); }} style={{ background: 'none', border: 'none', color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
            <Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} />
          </div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
            <Users size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
            <div style={{ fontSize: 14, fontWeight: 600 }}>No employees yet.</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>Add the first one — everything else in HR builds on these records.</div>
          </div>
        ) : (
          /* Master–detail on desktop; list ⇄ detail swap on phones */
          <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'start' }}>
            {(!isMobile || !selected) && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No matches.</div>
                )}
                {filtered.map((e, i) => {
                  const sm = STATUS_META[e.status] || STATUS_META.active;
                  const sel = e.id === selectedId;
                  return (
                    <button key={e.id} onClick={() => setSelectedId(e.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '11px 14px', background: sel ? 'hsla(var(--color-green),0.06)' : 'transparent', border: 'none', borderTop: i > 0 ? '1px solid var(--line)' : 'none', borderLeft: sel ? '3px solid hsl(var(--color-green))' : '3px solid transparent', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                      <Avatar e={e} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName(e)}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {[e.employeeCode, e.jobTitle, e.department].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: sm.bg, color: sm.fg, flexShrink: 0 }}>{sm.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {(!isMobile || selected) && (
              selected ? (
                <EmployeeDetail e={selected} employees={employees} isMobile={isMobile}
                  onEdit={emp => { setEditing(emp); setFormOpen(true); }}
                  onBack={() => setSelectedId(null)} />
              ) : (
                <div style={{ textAlign: 'center', padding: '64px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
                  <Users size={28} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                  <div style={{ fontSize: 13 }}>Select a person to see their profile.</div>
                </div>
              )
            )}
          </div>
        )}
      </>)}

      {formOpen && (
        <EmployeeFormModal employee={editing} employees={employees}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onSaved={onSaved} toastErr={toastErr} />
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'hsl(var(--color-red))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
