import { useState, useEffect, useMemo, useRef } from 'react';
import { QuestionnairesModal, InterviewPanel, LeaderboardModal } from '../components/Interviews';
import {
  Users, Plus, Search, X, Loader2, Mail, Phone, Briefcase, MapPin,
  ChevronLeft, Network, CalendarOff, UserPlus, Pencil, FileText,
  CheckCircle, XCircle, ChevronRight, History, CalendarDays, Camera,
  Building2, Trash2, MapPinned, Wallet, Landmark, Lock, Contact, Heart,
  ShieldCheck, Shield, AlertTriangle,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import ESign from '../components/ESign';
import TimeAdmin from '../components/TimeAdmin';

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
function EmployeeFormModal({ employee, employees, entities = [], onClose, onSaved, toastErr }) {
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
    company:         employee?.company || '',
    contractor:      employee?.contractor || {},
    notes:           employee?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const setC = (k, v) => setF(prev => ({ ...prev, contractor: { ...(prev.contractor || {}), [k]: v } }));
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
          <div>
            <label style={FL}>COMPANY / ENTITY</label>
            <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={e => set('company', e.target.value)}>
              <option value="">— not set —</option>
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </div>
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
                    <option value="hourly">Hourly</option><option value="fixed_fee">Fixed fee</option><option value="daily">Daily</option><option value="monthly">Monthly retainer</option>
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

// ── Documents (Phase 3) — private bucket, viewed via short-lived signed URLs ──
const DOC_KINDS = [['resume', 'Resume'], ['id', 'ID'], ['contract', 'Contract'], ['certificate', 'Certificate'], ['other', 'Other']];

// Mailbox export — start a Graph-backed .eml zip and poll it to completion.
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
    try { const j = await api.startMailboxExport(employee.id); setJob(j); toastOk('Mailbox export started — this can take a while for large mailboxes.'); }
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
// stored here — Items stays the single source of truth; this deep-links into it.
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
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>Loading…</div>
      ) : total === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {employee.workEmail ? 'No assigned equipment or active checkouts.' : 'No work email yet — provision the account to link assets.'}
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
  // Usage location drives license compliance — guess India from the profile, else US
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Provision accounts — {fullName(e)}</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          {!result ? (<>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
              Creates the Microsoft 365 account (with a temp password shown once to you), assigns the license — which
              is what creates the Outlook mailbox — sets the Entra reporting line, and emails a welcome note to their
              personal address. Asana and Ignite stay manual checklist items for now.
            </p>
            <label style={FL}>WORK EMAIL (becomes their sign-in) *</label>
            <input className="form-input" style={{ width: '100%', marginBottom: 14 }} value={email} onChange={ev => setEmail(ev.target.value)} />
            <label style={FL}>USAGE LOCATION (where they'll use the license) *</label>
            <select className="form-input" style={{ width: '100%', marginBottom: 14 }} value={usageLoc} onChange={ev => setUsageLoc(ev.target.value)}>
              <option value="US">United States</option>
              <option value="IN">India</option>
            </select>
            <label style={FL}>LICENSES{picked.size > 0 ? ` (${picked.size} selected)` : ' — none selected: no mailbox'}</label>
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
                      {s.status === 'manual' ? 'manual step' : s.status}{s.detail ? ` — ${s.detail}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {result.tempPassword && (
              <div style={{ marginTop: 16, background: 'hsla(var(--color-orange),0.08)', border: '1px solid hsla(var(--color-orange),0.35)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'hsl(var(--color-orange))', marginBottom: 5 }}>TEMP PASSWORD — SHOWN ONLY ONCE</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 14, fontWeight: 700 }}>{result.tempPassword}</code>
                  <button className="secondary-btn" style={{ fontSize: 11.5, padding: '4px 10px' }}
                    onClick={() => navigator.clipboard?.writeText(result.tempPassword)}>Copy</button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>Share it with {e.firstName} directly — they must change it on first sign-in. It is not stored anywhere.</div>
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

// ── Profile photo editor — view, re-crop (pan + zoom slider, thirds grid),
//    or choose a new photo; exports a 512px square JPEG via canvas ────────────
function PhotoEditorModal({ employee: e, onClose, onSaved, toastOk, toastErr }) {
  const STAGE = 280;
  const [imgSrc, setImgSrc]   = useState(e.photoUrl || '');
  const [isRemote, setIsRemote] = useState(!!e.photoUrl);
  const [nat, setNat]         = useState(null);          // { w, h } natural size
  const [zoom, setZoom]       = useState(1);
  const [off, setOff]         = useState({ x: 0, y: 0 });
  const [busy, setBusy]       = useState(false);
  const imgRef  = useState({ current: null })[0];
  const dragRef = useState({ current: null })[0];

  const baseScale = nat ? STAGE / Math.min(nat.w, nat.h) : 1;
  const scale = baseScale * zoom;

  const clamp = (o, z = zoom) => {
    if (!nat) return o;
    const s = baseScale * z;
    return {
      x: Math.min(0, Math.max(STAGE - nat.w * s, o.x)),
      y: Math.min(0, Math.max(STAGE - nat.h * s, o.y)),
    };
  };

  function onImgLoad(ev) {
    const w = ev.target.naturalWidth, h = ev.target.naturalHeight;
    setNat({ w, h });
    const s = STAGE / Math.min(w, h);
    setZoom(1);
    setOff({ x: (STAGE - w * s) / 2, y: (STAGE - h * s) / 2 });
  }

  function pickFile(file) {
    if (!file) return;
    if (imgSrc && !isRemote) URL.revokeObjectURL(imgSrc);
    setImgSrc(URL.createObjectURL(file));
    setIsRemote(false);
    setNat(null);
  }

  function onZoom(z) {
    // Keep the stage centre fixed while zooming
    if (!nat) { setZoom(z); return; }
    const sOld = baseScale * zoom, sNew = baseScale * z;
    const cx = (STAGE / 2 - off.x) / sOld, cy = (STAGE / 2 - off.y) / sOld;
    setZoom(z);
    setOff(clamp({ x: STAGE / 2 - cx * sNew, y: STAGE / 2 - cy * sNew }, z));
  }

  async function save() {
    if (!imgSrc || !nat || busy) return;
    setBusy(true);
    try {
      const blob = await new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext('2d');
        const src = STAGE / scale;
        try {
          ctx.drawImage(imgRef.current, -off.x / scale, -off.y / scale, src, src, 0, 0, 512, 512);
        } catch (err) { reject(err); return; }
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not read the image — pick the file again.')), 'image/jpeg', 0.9);
      });
      const form = new FormData();
      form.append('file', blob, 'avatar.jpg');
      const updated = await api.uploadEmployeePhoto(e.id, form);
      onSaved(updated);
      toastOk('Profile photo updated.');
      onClose();
    } catch (err) {
      toastErr(err?.message || 'Could not save the photo — try choosing the file again.');
      setBusy(false);
    }
  }

  const gridLine = (pos, vertical) => (
    <div style={{ position: 'absolute', background: 'rgba(255,255,255,0.55)', pointerEvents: 'none',
      ...(vertical ? { left: pos, top: 0, bottom: 0, width: 1 } : { top: pos, left: 0, right: 0, height: 1 }) }} />
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={ev => ev.target === ev.currentTarget && !busy && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Profile photo</h3>
          <button onClick={onClose} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          {imgSrc ? (
            <div
              onPointerDown={ev => { ev.currentTarget.setPointerCapture(ev.pointerId); dragRef.current = { x: ev.clientX - off.x, y: ev.clientY - off.y }; }}
              onPointerMove={ev => { if (dragRef.current) setOff(clamp({ x: ev.clientX - dragRef.current.x, y: ev.clientY - dragRef.current.y })); }}
              onPointerUp={() => { dragRef.current = null; }}
              style={{ position: 'relative', width: STAGE, height: STAGE, borderRadius: 14, overflow: 'hidden', background: 'var(--mist)', cursor: 'grab', touchAction: 'none', flexShrink: 0 }}>
              <img ref={el => { imgRef.current = el; }} src={imgSrc} alt="" draggable={false}
                crossOrigin={isRemote ? 'anonymous' : undefined} onLoad={onImgLoad}
                style={{ position: 'absolute', left: off.x, top: off.y, width: nat ? nat.w * scale : 'auto', height: nat ? nat.h * scale : 'auto', maxWidth: 'none', userSelect: 'none' }} />
              {/* Rule-of-thirds grid */}
              {gridLine(STAGE / 3, true)}{gridLine((STAGE / 3) * 2, true)}
              {gridLine(STAGE / 3, false)}{gridLine((STAGE / 3) * 2, false)}
              <div style={{ position: 'absolute', inset: 0, border: '1px solid rgba(255,255,255,0.4)', borderRadius: 14, pointerEvents: 'none' }} />
            </div>
          ) : (
            <div style={{ width: STAGE, height: STAGE, borderRadius: 14, border: '1.5px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              No photo yet — choose one below
            </div>
          )}
          {/* Zoom slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: STAGE }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>−</span>
            <input type="range" min="1" max="3" step="0.01" value={zoom} disabled={!nat}
              onChange={ev => onZoom(Number(ev.target.value))}
              style={{ flex: 1, accentColor: 'var(--pine)' }} />
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 700 }}>+</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Drag to reposition · slide to zoom</div>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <label className="secondary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <Camera size={13} /> {imgSrc ? 'Change photo' : 'Choose photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={ev => { pickFile(ev.target.files?.[0]); ev.target.value = ''; }} />
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={!nat || busy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!nat || busy) ? 0.6 : 1 }}>
              {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Save photo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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

// The soonest date that matters for this person — right-to-work doc expiry or,
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
  const stubFileRef = useRef(null);
  useEffect(() => {
    let live = true;
    api.getCompensation(employee.id)
      .then(r => { if (live) setData({ comp: r.compensation || {}, bank: r.bank || [] }); })
      .catch(() => { if (live) setData({ comp: {}, bank: [] }); });
    api.hrPaystubs(employee.id).then(r => { if (live) setStubs(r); }).catch(() => {});
    return () => { live = false; };
  }, [employee.id, reloadToken]);

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
    if (!window.confirm('Delete this paystub?')) return;
    try { await api.deleteEmployeeDoc(id); setStubs(s => s.filter(x => x.id !== id)); } catch { /* noop */ }
  };

  const money = (v, cur) => v ? `${cur === 'INR' ? '₹' : '$'}${Number(v).toLocaleString()}` : '—';
  const label = (list, v) => (list.find(([x]) => x === v) || [])[1] || v || '';
  const sectionLabel = txt => <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', margin: '16px 0 8px' }}>{txt}</div>;
  const row2 = (k, lbl, value) => (
    <div key={k} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 150, flexShrink: 0 }}>{lbl}</span>
      <span style={{ fontSize: 13.5, color: value ? 'var(--ink)' : 'var(--muted)' }}>{value || '—'}</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, flex: 1 }}><Lock size={12} /> Restricted · compensation grant</span>
        <button className="secondary-btn" onClick={onEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Pencil size={13} /> Edit</button>
      </div>
      {!data ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Loading…</div>
      ) : (
        <>
          {sectionLabel('Base pay')}
          {row2('base', 'Base', data.comp.base ? `${money(data.comp.base, data.comp.currency)} · ${label(PAY_BASIS, data.comp.payBasis)}` : '')}
          {row2('freq', 'Frequency', label(PAY_FREQ, data.comp.frequency))}
          {row2('eff', 'Effective', data.comp.effectiveDate)}
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

// "Ask HR" inbox — employee self-service requests raised from My HR. Open ones
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
      toastOk?.('Resolved — the employee has been notified');
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
        Employee requests — {open.length} open
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
                          Add to employee documents
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


function EmployeeDetail({ e, employees, companyName = '', canSeeComp = false, onEdit, onBack, isMobile, toastOk, toastErr, onEmployeeUpdated }) {
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
  const tabs = [
    ['overview', 'Overview', Contact],
    canSeeComp && ['pay', 'Pay & Benefits', Wallet],
    ['compliance', 'Compliance', ShieldCheck],
    ['assets', 'Assets', Briefcase],
    ['documents', 'Documents', FileText],
  ].filter(Boolean);
  const expiry = nextExpiry(e);
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '22px 24px', boxShadow: 'var(--shadow-sm)' }}>
      {isMobile && (
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', padding: 0, marginBottom: 14 }}>
          <ChevronLeft size={15} /> All people
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
        {/* Avatar opens the photo editor: view, re-crop with grid + zoom, or change */}
        <button title="View or change profile photo" onClick={() => setPhotoOpen(true)}
          style={{ position: 'relative', cursor: 'pointer', flexShrink: 0, background: 'none', border: 'none', padding: 0 }}>
          <Avatar e={e} size={56} />
          <span style={{ position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--card)' }}>
            <Camera size={11} />
          </span>
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{fullName(e)}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {[e.jobTitle, e.employeeCode].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button onClick={() => setStatusOpen(true)} title="Change status (with reason)"
          style={{ padding: '3px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 700, background: sm.bg, color: sm.fg, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {sm.label} <Pencil size={10} />
        </button>
        <button className="secondary-btn" onClick={() => onEdit(e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Pencil size={13} /> Edit
        </button>
        {!e.m365Id ? (
          <button className="primary-btn" onClick={() => setProvisionOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'hsl(var(--color-green))' }}>
            <CheckCircle size={13} /> Provision accounts
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
      </div>
      {/* Stat cards — all derived from the loaded record, no extra fetch */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <StatCard label="Tenure" value={fmtTenure(e.startDate) || '—'} sub={e.startDate ? `since ${e.startDate}` : 'no start date'} />
        <StatCard label="Direct reports" value={reports.length} sub={manager ? `reports to ${fullName(manager)}` : 'no manager'} />
        <StatCard label="Type" value={TYPE_LABEL[e.employmentType] || '—'} sub={e.department || '—'} />
        {expiry
          ? <StatCard label={expiry.label} value={expiry.days < 0 ? 'Expired' : `${expiry.days}d`} sub={expiry.date} tone={expiry.days < 0 ? 'red' : expiry.days <= 60 ? 'orange' : undefined} />
          : <StatCard label="Compliance" value="Clear" sub="no upcoming expiry" />}
      </div>

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
              {row(Briefcase, 'Department', [e.department, TYPE_LABEL[e.employmentType]].filter(Boolean).join(' · '))}
              {companyName && row(Building2, 'Company', companyName)}
              {row(CalendarOff, 'Start date', e.startDate)}
              {row(MapPin, 'Location', e.location)}
              {e.employmentType === 'contractor' && e.contractor?.billing_client && row(Briefcase, 'Billing client', e.contractor.billing_client)}
              {e.employmentType === 'contractor' && e.contractor?.contract_end && row(CalendarOff, 'Contract end', e.contractor.contract_end)}
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
              {row(CalendarDays, 'Date of birth', e.personal?.dob)}
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

        {tab === 'documents' && (
          <>
            <DocumentsSection employeeId={e.id} toastOk={toastOk} toastErr={toastErr} />
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
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', phone: '', role_title: '', department: 'Operations', expected_start: '', source: '', notes: '' });
  const [busy, setBusy] = useState(false);
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
          <div><label style={FL}>DEPARTMENT</label>
            <select className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
              {DEPTS.map(d => <option key={d}>{d}</option>)}
            </select></div>
          {input('EXPECTED START', 'expected_start', { type: 'date' })}
          {input('SOURCE', 'source', { placeholder: 'Referral, LinkedIn…' })}
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
                  View resume
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
                <CalendarDays size={13} /> Interview room
              </button>
            )}
            {c.email && onSendForSignature && c.stage !== 'rejected' && (
              <button className="secondary-btn" onClick={() => { onSendForSignature(c); onClose(); }}
                title="Send an offer letter or other document to this candidate via a secure e-sign link (no login needed)"
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FileText size={13} /> Send for signature
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

  useEffect(() => { api.getCandidates().then(setCandidates).catch(() => setCandidates([])); }, []);

  async function moveStage(c, stage, note) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.updateCandidate(c.id, { stage, stage_note: note || '' });
      setCandidates(prev => prev.map(x => x.id === c.id ? updated : x));
      setDetail(null);
      if (stage === 'hired') {
        toastOk(`${candName(c)} hired — added to People as Onboarding (${updated.createdEmployee?.employeeCode || ''}).`);
        if (updated.createdEmployee) onEmployeeCreated(updated.createdEmployee);
      } else if (stage === 'rejected') toastOk(`${candName(c)} marked rejected.`);
      else toastOk(`${candName(c)} → ${STAGE_META[stage].label}.`);
    } catch (err) { toastErr(err?.message || 'Could not update stage.'); }
    setBusy(false);
  }

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
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.roleTitle || c.department || '—'}</div>
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
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Add one and walk them through Applied → Hired — hiring creates the employee record automatically.</div>
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
        /* Desktop: kanban lanes — full height so the board reads as a board */
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

// ── Org chart (Phase 5) — top-down node chart on a pan/zoom canvas ────────────
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

// A single node card — minimal, fixed-width, avatar-forward, with a coloured
// division accent bar down its left edge. The reports pill hangs off the bottom
// edge and doubles as the collapse toggle. data-orgcard lets the canvas tell a
// card press from a pan; data-email lets drop resolve the target across the
// zoom transform.
function OrgNodeCard({ e, kids, isCollapsed, onToggle, onSelect, dnd, entityName, highlight, divName, divColor, isHead, dim }) {
  const email = (e.workEmail || '').toLowerCase();
  const isTarget = dnd.overKey === email && dnd.draggingId && dnd.draggingId !== e.id;
  const isDragging = dnd.draggingId === e.id;
  return (
    <div data-orgcard="1" data-email={email} style={{ position: 'relative', paddingBottom: kids > 0 ? 12 : 0 }}>
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
        <Avatar e={e} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fullName(e)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.jobTitle || '—'}</div>
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
        dim={ctx.activeDiv && div !== ctx.activeDiv} />
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
          <Avatar e={e} size={52} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{fullName(e)}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[e.jobTitle, e.department].filter(Boolean).join(' · ') || '—'}
            </div>
            {e.workEmail && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.workEmail}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 6 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 22px 18px' }}>
          <label style={lbl}>Reports to</label>
          <select className="form-input" style={{ width: '100%' }} value={f.manager_email}
            onChange={ev => setF(x => ({ ...x, manager_email: ev.target.value }))}>
            <option value="">— No manager (top of a tree) —</option>
            {managerOptions.map(p => <option key={p.id} value={(p.workEmail || '').toLowerCase()}>{fullName(p)}{p.jobTitle ? ` — ${p.jobTitle}` : ''}</option>)}
          </select>

          <label style={lbl}>Job title</label>
          <input className="form-input" style={{ width: '100%' }} value={f.job_title} onChange={ev => setF(x => ({ ...x, job_title: ev.target.value }))} />

          <label style={lbl}>Department</label>
          <input className="form-input" style={{ width: '100%' }} value={f.department} onChange={ev => setF(x => ({ ...x, department: ev.target.value }))} />

          <label style={lbl}>Company</label>
          <select className="form-input" style={{ width: '100%' }} value={f.company} onChange={ev => setF(x => ({ ...x, company: ev.target.value }))}>
            <option value="">—</option>
            {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>

          <label style={lbl}>Division lead of</label>
          <input className="form-input" style={{ width: '100%' }} list="org-divisions"
            placeholder="e.g. Operations — leave blank if not a division lead"
            value={f.division} onChange={ev => setF(x => ({ ...x, division: ev.target.value }))} />
          <datalist id="org-divisions">
            {(divisionNames || []).map(d => <option key={d} value={d} />)}
          </datalist>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
            {f.division.trim()
              ? `Everyone reporting under ${fullName(e)} is coloured as “${f.division.trim()}”, until another lead is tagged below them.`
              : inherited
                ? `Inherits “${inherited}” from their manager. Type a name here to make ${fullName(e)} their own division lead.`
                : `Not in any division. Type a name to make ${fullName(e)} a division lead — their whole team inherits it.`}
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
                    <Avatar e={p} size={28} />
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

  // Everyone below `email` in the tree — used to refuse drops that would loop
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

  async function drop(targetEmail) {
    const dragged = people.find(p => p.id === draggingId);
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
        toastErr(`${fullName(target)} reports up to ${fullName(dragged)} — that would create a loop.`);
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

  // Pointer-based drag (works with mouse AND touch — native HTML5 drag does
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
      const el = document.elementFromPoint(m.clientX, m.clientY);
      const detach = el && el.closest ? el.closest('[data-detach]') : null;
      const card = el && el.closest ? el.closest('[data-email]') : null;
      const em = card && card.getAttribute('data-email');
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
        if (st.target) drop(st.target); else { setDraggingId(null); setOverKey(null); }
      } else if (st) {
        setSelected(st.person);    // no meaningful movement → treat as a tap
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dnd = { draggingId, setDraggingId, overKey, setOverKey, drop, onCardPointerDown };
  // Managers (people with reports) before leaves, then alphabetical — keeps
  // wide sibling rows readable
  const kidCount = e => (childrenMap.get((e.workEmail || '').toLowerCase()) || []).length;
  for (const arr of childrenMap.values()) {
    arr.sort((a, b) => (kidCount(b) - kidCount(a)) || fullName(a).localeCompare(fullName(b)));
  }
  const hasManager = e => (e.managerEmail || '') && emails.has((e.managerEmail || '').toLowerCase());
  const roots = people.filter(e => !hasManager(e) && (childrenMap.get((e.workEmail || '').toLowerCase()) || []).length > 0);
  // Busacta-style: surface the unlinked instead of hiding them — forces the data complete
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
  // Filtering rebuilds the tree from the filtered set — unmatched managers drop
  // out and their matching reports surface as roots.
  const departments = [...new Set(people.map(e => e.department).filter(Boolean))].sort();
  const q = orgQ.trim().toLowerCase();
  // Company/department FILTER the tree; search FINDS within it (expand + center
  // + highlight) — filtering by name would amputate the person's whole subtree.
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
  };

  // ── Pan & zoom canvas — the chart never overflows the page; you pan/zoom
  // within a fixed viewport. Default = 100% zoom, centered; Fit is opt-in.
  const centerView = () => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    const kw = k.scrollWidth;
    setZoom(1);
    // Centre on the content midpoint — when the tree is wider than the canvas
    // this puts the middle in view (edges pan-reachable) rather than left-pinning.
    setPan({ x: (c.clientWidth - kw) / 2, y: 24 });
  });
  const fitToView = () => requestAnimationFrame(() => {
    const c = canvasRef.current, k = contentRef.current;
    if (!c || !k) return;
    // scrollWidth reports untransformed layout size — no zoom correction needed
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
      <div style={{ fontSize: 14, fontWeight: 600 }}>Add people first — the chart draws itself from each person's "Reports to".</div>
    </div>
  );
  return (
    <div>
      {/* Toolbar: expand controls · full-width search · filters + count (People-tab style) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button className="secondary-btn" style={{ fontSize: 12, flex: '0 0 auto' }}
          onClick={() => { setCollapsedSet(new Set()); setTimeout(centerView, 60); }}>Expand all</button>
        <button className="secondary-btn" style={{ fontSize: 12, flex: '0 0 auto' }}
          onClick={() => { setCollapsedSet(new Set([...visChildren.keys()])); setTimeout(centerView, 60); }}>Collapse all</button>
        <div className="search-bar" style={{ flex: '1 1 240px', minWidth: 200 }}>
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

      {/* Division legend — click a chip to spotlight that division (dim the rest).
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
            <button onClick={() => setActiveDiv('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--muted)', fontFamily: 'Inter,sans-serif' }}>Clear spotlight</button>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 4 }}>· set a division on the "lead" in their side panel</span>
        </div>
      )}

      {/* Detach zone appears only mid-drag — drag a card here to unlink it */}
      {draggingId && (
        <div data-detach="1"
          style={{ marginBottom: 10, border: `2px dashed ${overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--line)'}`, borderRadius: 12, padding: '10px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: overKey === '__none__' ? 'hsl(var(--color-red))' : 'var(--muted)', background: overKey === '__none__' ? 'hsla(var(--color-red),0.06)' : 'transparent' }}>
          Drag here to remove their reporting line
        </div>
      )}

      {/* The chart canvas — drag empty space to pan, controls to zoom/fit.
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
          Drag the canvas to move around · tap a card for details · drag a card onto someone to re-assign
        </span>
      </div>

      {visUnlinked.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'hsl(var(--color-orange))', textTransform: 'uppercase', marginBottom: 8 }}>
            No reporting line — drag onto the chart above, or tap to set who they report to
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

      {/* Floating drag ghost — follows the pointer/finger while dragging a card */}
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
              <option value="">— pick a person —</option>
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
        placeholder={selected.length ? 'Add another person…' : 'Filter by person — type a name…'}
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


// "Who's out this week" — Mon–Sun strip merging both leave sources: HR-recorded
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
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Everyone's in — no approved or pending leave this week.</div>
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
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', opacity: 0.6 }}>—</div>
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
  const [selF, setSelF] = useState([]);          // people filter — empty = everyone
  const [balances, setBalances] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const year = new Date().getFullYear();
  const empF = selF.length === 1 ? selF[0] : 'All';   // balances show for exactly one person

  useEffect(() => { api.getLeave().then(setLeave).catch(() => setLeave([])); }, []);
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

  if (leave === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Loader2 size={26} style={{ animation: 'spin 0.8s linear infinite', color: 'var(--muted)' }} /></div>;

  const visible = selF.length === 0 ? leave : leave.filter(r => selF.includes(r.employeeId));
  const pending = visible.filter(r => r.status === 'pending').length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <PeopleFilter employees={employees} selected={selF} onChange={setSelF} />
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{pending} pending · {visible.length} shown</span>
        {/* Employees request their own leave from My HR — this is the approve/track
            view. HR keeps a de-emphasised "log on behalf" for phone-ins and
            staff without portal access. */}
        <button className="secondary-btn" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} onClick={() => setFormOpen(true)}>
          <Plus size={13} /> Log on behalf
        </button>
      </div>

      <WhosOutWeek employees={employees} hrLeave={leave} selIds={selF} />

      {/* Balance cards when a person is picked — used computes from approvals */}
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
                    {r.startDate}{r.endDate && r.endDate !== r.startDate ? ` → ${r.endDate}` : ''}{r.reason ? ` · ${r.reason}` : ''}
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
        onSaved={r => { setLeave(prev => [r, ...prev]); toastOk('Leave request recorded — pending approval.'); }} />}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────
// ── Companies / legal entities manager (HR Section A) ────────────────────────
function EntitiesModal({ entities, onClose, onChanged, toastOk, toastErr }) {
  const blank = { name: '', legal_name: '', country: '', tax_id: '', registered_address: '', signatory: '', notes: '' };
  const [mode, setMode] = useState(null);   // null = list · 'new' · <id> editing
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const startNew = () => { setF(blank); setMode('new'); };
  const startEdit = en => { setF({ name: en.name, legal_name: en.legalName || '', country: en.country || '', tax_id: en.taxId || '', registered_address: en.registeredAddress || '', signatory: en.signatory || '', notes: en.notes || '' }); setMode(en.id); };

  async function save() {
    if (!f.name.trim() || busy) return; setBusy(true);
    try {
      if (mode === 'new') await api.createEntity(f); else await api.updateEntity(mode, f);
      await onChanged(); toastOk('Company saved.'); setMode(null);
    } catch (e) { toastErr(e?.message || 'Could not save company.'); }
    setBusy(false);
  }
  async function remove(en) {
    if (!window.confirm(`Delete “${en.name}”? Workers keep their record but lose this company link.`)) return;
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{mode ? (mode === 'new' ? 'Add Company' : 'Edit Company') : 'Companies & Entities'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        {mode ? (
          <>
            <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1 / -1' }}>{field('NAME *', 'name', { autoFocus: true, placeholder: 'e.g. Greens India' })}</div>
              {field('LEGAL NAME', 'legal_name', { placeholder: 'full registered name' })}
              <div>
                <label style={FL}>COUNTRY</label>
                <select className="form-input" style={{ width: '100%' }} value={f.country} onChange={e => set('country', e.target.value)}>
                  <option value="">—</option><option value="US">United States (US)</option><option value="IN">India (IN)</option>
                </select>
              </div>
              {field('TAX ID (EIN / GSTIN)', 'tax_id')}
              {field('AUTHORIZED SIGNATORY', 'signatory', { placeholder: 'name, title' })}
              <div style={{ gridColumn: '1 / -1' }}>{field('REGISTERED ADDRESS', 'registered_address')}</div>
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
              {entities.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--muted)' }}>
                  <p style={{ fontSize: 13, marginBottom: 14 }}>No companies yet. Add your legal entities so every worker can be tied to one.</p>
                  <button className="secondary-btn" onClick={seedDefaults} disabled={busy} style={{ marginRight: 8 }}>Add Greens · Greens India · MCD · Oversite</button>
                </div>
              ) : entities.map(en => (
                <div key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{en.name} {en.country && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>· {en.country}</span>}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[en.legalName, en.taxId && `Tax ${en.taxId}`, en.signatory].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                  <button className="secondary-btn" onClick={() => startEdit(en)} style={{ padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Pencil size={13} /> Edit</button>
                  <button onClick={() => remove(en)} title="Delete" style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'hsl(var(--color-red))', display: 'flex', padding: 7 }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button className="primary-btn" onClick={startNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add Company</button>
            </div>
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
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = status !== employee.status;

  const isInactive = status === 'inactive';
  const isLeft = status === 'offboarded';
  const showOff = isInactive || isLeft;
  const mailboxAction = isInactive ? 'delegate' : (isLeft ? leftChoice : '');
  const needsDelegate = mailboxAction === 'delegate' || mailboxAction === 'share';
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
    if (mailboxAction === 'share') psLines.push('# Shared mailboxes <50GB need no license — remove it after converting.');
  }
  const psScript = psLines.join('\n');
  const copyPs = () => navigator.clipboard?.writeText(psScript)
    .then(() => toastOk('PowerShell copied to clipboard.'))
    .catch(() => toastErr('Copy failed — select the text and copy manually.'));

  function buildOffboarding() {
    if (!showOff) return null;
    return {
      mailboxAction,
      delegateTo: needsDelegate ? trustees : [],
      exportRequested,
      freeUpLicense: mailboxAction === 'remove',
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
      {manager && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Defaulted to their manager <b>{fullName(manager)}</b> from the org chart — add or remove below.</div>}
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
          <option value="">— add a colleague —</option>
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Change status — {fullName(employee)}</h3>
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
                    <span>All equipment {employee.firstName} still holds in Item Management will be <strong>force-returned</strong> automatically — checkouts closed and permanent assignments sent back to stock.</span>
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
                    <span>On <strong>Apply</strong>, Nexus blocks sign-in and <strong>releases the license</strong> back to the pool automatically. Group-assigned licenses can’t be pulled per-user — if any are, the confirmation will name them so you can remove the person from that group.</span>
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
                  {STATUS_META[h.from]?.label || h.from} → {STATUS_META[h.to]?.label || h.to} · {h.effectiveDate || (h.at || '').slice(0, 10)}{h.reason ? ` · ${h.reason}` : ''}
                  {h.offboarding?.mailboxAction ? ` · mailbox: ${h.offboarding.mailboxAction}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy || !changed} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (busy || !changed) ? 0.6 : 1 }}>{busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />} Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── Right-to-work & compliance (HR Section B — open to HR) ───────────────────
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Right to Work — {fullName(employee)}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={FL}>WORK AUTHORIZATION</label><select className="form-input" style={{ width: '100%' }} value={c.workAuth} onChange={e => set('workAuth', e.target.value)}><option value="">—</option>{WORK_AUTH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
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

// ── Personal details + emergency contact (HR Section B — open to HR) ─────────
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Personal — {fullName(employee)}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label style={FL}>DATE OF BIRTH</label><input className="form-input" style={{ width: '100%' }} type="date" value={p.dob} onChange={e => set('dob', e.target.value)} /></div>
            <div><label style={FL}>GENDER</label><select className="form-input" style={{ width: '100%' }} value={p.gender} onChange={e => set('gender', e.target.value)}><option value="">—</option><option>Male</option><option>Female</option><option>Other</option><option>Prefer not to say</option></select></div>
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

// ── Compensation + bank (HR Section B — gated by hr_comp grant / owner) ──────
const PAY_BASIS = [['salary', 'Salary'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['fixed_fee', 'Fixed fee']];
const PAY_FREQ  = [['monthly', 'Monthly'], ['semimonthly', 'Semi-monthly'], ['biweekly', 'Bi-weekly'], ['weekly', 'Weekly']];
const BANK_TYPES = [['checking', 'Checking'], ['savings', 'Savings'], ['current', 'Current']];
const BENEFIT_TYPES = [['health', 'Health'], ['dental', 'Dental'], ['vision', 'Vision'], ['life', 'Life'], ['disability', 'Disability'], ['retirement', 'Retirement / 401k / PF'], ['other', 'Other']];

function CompensationModal({ employee, onClose, toastOk, toastErr }) {
  const [comp, setComp] = useState({ base: '', payBasis: 'salary', frequency: 'monthly', currency: 'USD', effectiveDate: '', history: [], benefits: [] });
  const [bank, setBank] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const setC = (k, v) => setComp(p => ({ ...p, [k]: v }));

  useEffect(() => {
    let live = true;
    api.getCompensation(employee.id)
      .then(r => { if (!live) return; setComp({ base: '', payBasis: 'salary', frequency: 'monthly', currency: 'USD', effectiveDate: '', history: [], benefits: [], ...(r.compensation || {}) }); setBank(r.bank || []); })
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
    if (busy) return; setBusy(true);
    try {
      const clean = { ...comp }; delete clean.history;   // server owns history
      await api.saveCompensation(employee.id, { compensation: clean, bank });
      toastOk('Compensation saved.'); onClose();
    } catch (e) { toastErr(e?.message || 'Could not save compensation.'); setBusy(false); }
  }
  const money = (v, cur) => v ? `${cur === 'INR' ? '₹' : '$'}${Number(v).toLocaleString()}` : '—';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: 'min(92dvh, 780px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-green),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Wallet size={17} color="hsl(var(--color-green))" />
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Pay, Benefits & Bank — {fullName(employee)}</h3>
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
              <div><label style={FL}>CURRENCY</label><select className="form-input" style={{ width: '100%' }} value={comp.currency} onChange={e => setC('currency', e.target.value)}><option value="USD">USD</option><option value="INR">INR</option></select></div>
              <div><label style={FL}>PAY BASIS</label><select className="form-input" style={{ width: '100%' }} value={comp.payBasis} onChange={e => setC('payBasis', e.target.value)}>{PAY_BASIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label style={FL}>PAY FREQUENCY</label><select className="form-input" style={{ width: '100%' }} value={comp.frequency} onChange={e => setC('frequency', e.target.value)}>{PAY_FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label style={FL}>EFFECTIVE DATE</label><input className="form-input" style={{ width: '100%' }} type="date" value={comp.effectiveDate} onChange={e => setC('effectiveDate', e.target.value)} /></div>
            </div>

            {comp.history?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.04em', marginBottom: 8 }}>HISTORY</div>
                {comp.history.map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>
                    <span>{money(h.base, h.currency)} · {h.payBasis || ''}</span>
                    <span>{h.effectiveDate || (h.changedAt || '').slice(0, 10)}</span>
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
            <button className="secondary-btn" onClick={addBank} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add bank account</button>
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

// ── Work sites registry (HR Section A — geofence foundation for Time Clock) ───
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
    if (!window.confirm(`Delete work site “${s.name}”?`)) return;
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
                  <option value="">— any —</option>
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
                    <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[s.address, (s.latitude && s.longitude) ? `${s.latitude}, ${s.longitude} · ${s.radiusM}m` : ''].filter(Boolean).join(' · ') || '—'}</div>
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

export default function HR({ activeSub, onSubChange }) {
  // Legacy subviews (hr-ms / hr-asana / …) all collapse into People for now.
  // 'hr-esign-*' deep-links (bell/toast clicks) land on the E-Sign tab — ESign
  // reads the raw navSub to pick its own sub-tab (inbox vs sent requests).
  const navSub = String(activeSub || '').startsWith('hr-esign') ? 'hr-esign' : activeSub;
  const sub = ['hr-people', 'hr-hiring', 'hr-org', 'hr-leave', 'hr-time', 'hr-esign'].includes(navSub) ? navSub : 'hr-people';
  const [esignPrefill, setEsignPrefill] = useState(null);   // candidate → Send-for-signature handoff
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
  const [entities,  setEntities]  = useState([]);
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  const [sites,     setSites]     = useState([]);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [toast,     setToast]     = useState(null);
  const { canAccessModule } = useRole();
  const canSeeComp = canAccessModule('hr_comp', 'owner', 'viewer');

  const toastErr = msg => { setToast({ msg, kind: 'error' }); setTimeout(() => setToast(null), 5000); };
  const toastOk  = msg => { setToast({ msg, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };

  const [syncBusy, setSyncBusy] = useState(false);
  // One action: pull the directory (people + fields) AND their profile photos.
  async function runSync() {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      const r = await api.syncM365();
      const bits = [];
      if (r.created) bits.push(`${r.created} added`);
      bits.push(`${r.linked} linked`, `${r.updated} updated`);
      if (r.removed?.length) bits.push(`${r.removed.length} removed (shared/inactive)`);
      if (r.unlinked?.length) bits.push(`unlinked (account deleted): ${r.unlinked.join(', ')}`);
      // Photos are a second, slower pass — don't fail the whole sync if it errors.
      try {
        const p = await api.syncM365Photos();
        if (p.updated) bits.push(`${p.updated} photos`);
      } catch { /* photo pass is best-effort */ }
      toastOk(`M365 sync: ${bits.join(' · ')}.`);
      load();
    } catch (err) { toastErr(err?.message || 'Sync failed.'); }
    setSyncBusy(false);
  }

  function load() {
    api.getEmployees()
      .then(rows => { setEmployees(rows); setError(''); })
      .catch(err => setError(err?.message || 'Could not load employees.'))
      .finally(() => setLoading(false));
  }
  const loadEntities = () => api.getEntities().then(setEntities).catch(() => setEntities([]));
  const loadSites = () => api.getWorkSites().then(setSites).catch(() => setSites([]));
  useEffect(load, []);
  useEffect(() => { loadEntities(); loadSites(); }, []);
  const entityName = id => entities.find(en => en.id === id)?.name || '';

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
    // Profile edits auto-mirror to the linked Entra account (backend, best-effort)
    // — tell the user whether M365 actually took the change.
    if (saved.entra) {
      if (saved.entra.synced) toastOk('Saved — profile synced to Microsoft 365.');
      else toastErr(`Saved in Nexus, but the M365 sync failed: ${saved.entra.error || 'Graph error'}. Use "Push to M365" to retry.`);
    }
  };

  const TABS = [
    ['hr-people', 'People'], ['hr-hiring', 'Hiring'], ['hr-org', 'Org Chart'], ['hr-leave', 'Leave'], ['hr-time', 'Time'], ['hr-esign', 'E-Sign'],
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 18 }}>
        <div className="view-title-group">
          <h2>Human Resources</h2>
          <p>People, hiring, org structure and leave — one source of truth</p>
        </div>
        {sub === 'hr-people' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <button className="secondary-btn" disabled={syncBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Pull people from M365 (only @greensglobal.com and @greensstorage.com) — new people added, existing profiles linked, empty fields + profile photos backfilled from Entra."
              onClick={runSync}>
              {syncBusy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <History size={14} />} Sync from M365
            </button>
            <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Manage companies / legal entities"
              onClick={() => setEntitiesOpen(true)}>
              <Building2 size={14} /> Companies
            </button>
            <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              title="Manage work sites (for geofenced clock-in)"
              onClick={() => setSitesOpen(true)}>
              <MapPinned size={14} /> Work Sites
            </button>
            <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
              onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus size={15} /> Add Employee
            </button>
          </div>
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

      {sub === 'hr-hiring' && (
        <HiringTab isMobile={isMobile} toastOk={toastOk} toastErr={toastErr}
          onEmployeeCreated={emp => setEmployees(prev => [...prev, emp].sort((a, b) => fullName(a).localeCompare(fullName(b))))}
          onSendForSignature={c => {
            setEsignPrefill({
              candidateId: c.id, title: `Offer — ${candName(c)}`,
              parties: [{ role_key: 'employee', name: candName(c), email: c.email, kind: 'external', ordinal: 2 }],
            });
            onSubChange('hr-esign');
          }} />
      )}
      {sub === 'hr-org' && <OrgChartTab employees={employees} entities={entities} onUpdated={onSaved} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-leave' && <LeaveTab employees={employees} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-time' && <TimeAdmin employees={employees} toastOk={toastOk} toastErr={toastErr} />}
      {sub === 'hr-esign' && (
        <ESign employees={employees} entities={entities} prefill={esignPrefill} navSub={activeSub}
          onPrefillConsumed={() => setEsignPrefill(null)} toastOk={toastOk} toastErr={toastErr} />
      )}

      {sub === 'hr-people' && (<>
        <EmployeeRequestsPanel toastOk={toastOk} toastErr={toastErr} />
        {/* KPI strip — skeleton shimmer while loading, never a flash of zeros */}
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {[['card-blue', 'Total People', counts.total], ['card-green', 'Active', counts.active],
            ['card-orange', 'Onboarding', counts.onboarding], ['card-purple', 'Departments', counts.depts]]
            .map(([cls, label, value]) => (
              <div key={label} className={`kpi-card ${cls}`}>
                <div className="kpi-label">{label}</div>
                <div className="kpi-value">
                  {loading
                    ? <span className="skel" style={{ width: 46, height: 20, margin: '7px 0' }} />
                    : value}
                </div>
              </div>
            ))}
        </div>

        {/* Filters — search fills the row, the two dropdowns stay compact on the right */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div className="search-bar" style={{ flex: '1 1 260px', minWidth: 200 }}>
            <Search size={13} style={{ flexShrink: 0 }} />
            <input placeholder="Search people…" value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={13} /></button>}
          </div>
          <select className="form-input" value={deptF} onChange={e => setDeptF(e.target.value)} style={{ flex: '0 0 auto', width: 150, padding: '6px 10px', fontSize: 13, height: 34 }}>
            <option value="All">All departments</option>
            {DEPTS.map(d => <option key={d}>{d}</option>)}
          </select>
          <select className="form-input" value={statusF} onChange={e => setStatusF(e.target.value)} style={{ flex: '0 0 auto', width: 140, padding: '6px 10px', fontSize: 13, height: 34 }}>
            <option value="All">All statuses</option>
            {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            {loading
              ? <span className="skel" style={{ width: 150, height: 11, verticalAlign: 'middle' }} />
              : `${counts.total} total · ${counts.active} active · ${filtered.length} shown`}
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
          /* Master–detail on desktop; list ⇄ detail swap on phones.
             Both panes are capped to the viewport: the list scrolls inside
             itself (the page no longer grows to 100+ rows tall) and the detail
             is sticky, so clicking anyone — even at the bottom — keeps their
             profile in view without scrolling back up. */
          <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'start' }}>
            {(!isMobile || !selected) && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-sm)', ...(isMobile ? {} : { maxHeight: 'calc(100vh - 280px)', minHeight: 380, overflowY: 'auto' }) }}>
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
              <div style={isMobile ? undefined : { position: 'sticky', top: 68, alignSelf: 'start', maxHeight: 'calc(100vh - 280px)', minHeight: 380, overflowY: 'auto' }}>
                {selected ? (
                  <EmployeeDetail e={selected} employees={employees} isMobile={isMobile}
                    companyName={entityName(selected.company)} canSeeComp={canSeeComp}
                    toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved}
                    onEdit={emp => { setEditing(emp); setFormOpen(true); }}
                    onBack={() => setSelectedId(null)} />
                ) : (
                  <div style={{ textAlign: 'center', padding: '64px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
                    <Users size={28} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
                    <div style={{ fontSize: 13 }}>Select a person to see their profile.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </>)}

      {formOpen && (
        <EmployeeFormModal employee={editing} employees={employees} entities={entities}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onSaved={onSaved} toastErr={toastErr} />
      )}
      {entitiesOpen && (
        <EntitiesModal entities={entities} onClose={() => setEntitiesOpen(false)}
          onChanged={loadEntities} toastOk={toastOk} toastErr={toastErr} />
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
