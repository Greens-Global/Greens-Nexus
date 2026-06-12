import { useState, useEffect, useMemo } from 'react';
import {
  Users, Plus, Search, X, Loader2, Mail, Phone, Briefcase, MapPin,
  ChevronLeft, Network, CalendarOff, UserPlus, Pencil, FileText,
  CheckCircle, XCircle, ChevronRight, History, CalendarDays, Camera,
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

// ── Documents (Phase 3) — private bucket, viewed via short-lived signed URLs ──
const DOC_KINDS = [['resume', 'Resume'], ['id', 'ID'], ['contract', 'Contract'], ['certificate', 'Certificate'], ['other', 'Other']];

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
      const res = await api.provisionEmployee(e.id, { work_email: email.trim(), license_sku_ids: [...picked] });
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

// ── Profile detail pane ───────────────────────────────────────────────────────
function EmployeeDetail({ e, employees, onEdit, onBack, isMobile, toastOk, toastErr, onEmployeeUpdated }) {
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const sm = STATUS_META[e.status] || STATUS_META.active;

  async function uploadPhoto(file) {
    if (!file || photoBusy) return;
    setPhotoBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const updated = await api.uploadEmployeePhoto(e.id, form);
      onEmployeeUpdated(updated);
      toastOk('Profile photo updated.');
    } catch (err) { toastErr(err?.message || 'Photo upload failed.'); }
    setPhotoBusy(false);
  }
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
        {/* Avatar with camera overlay — uploads through the backend, never anon */}
        <label title="Upload profile photo" style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
          <Avatar e={e} size={56} />
          <span style={{ position: 'absolute', right: -4, bottom: -4, width: 22, height: 22, borderRadius: '50%', background: 'var(--pine)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--card)' }}>
            {photoBusy ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Camera size={11} />}
          </span>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden
            onChange={ev => { uploadPhoto(ev.target.files?.[0]); ev.target.value = ''; }} />
        </label>
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
        {!e.m365Id ? (
          <button className="primary-btn" onClick={() => setProvisionOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'hsl(var(--color-green))' }}>
            <CheckCircle size={13} /> Provision accounts
          </button>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' }}>M365 ✓</span>
        )}
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
      <DocumentsSection employeeId={e.id} toastOk={toastOk} toastErr={toastErr} />
      {provisionOpen && (
        <ProvisionModal employee={e} toastErr={toastErr}
          onClose={() => setProvisionOpen(false)}
          onDone={updated => { onEmployeeUpdated(updated); toastOk(`${fullName(e)} provisioned.`); }} />
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

function CandidateDetailModal({ candidate: c, onClose, onStage, busy }) {
  const [history, setHistory] = useState(null);
  const [note, setNote] = useState('');
  useEffect(() => { api.getCandidateHistory(c.id).then(setHistory).catch(() => setHistory([])); }, [c.id]);
  const idx = STAGES.indexOf(c.stage);
  const next = idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
  const terminal = c.stage === 'hired' || c.stage === 'rejected';
  const sm = STAGE_META[c.stage];
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

function HiringTab({ isMobile, toastOk, toastErr, onEmployeeCreated }) {
  const [candidates, setCandidates] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

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
      </button>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
          {open.length} in pipeline · {byStage('offer').length} offer{byStage('offer').length !== 1 ? 's' : ''} out · {byStage('hired').length} hired
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="secondary-btn" style={{ fontSize: 12.5 }} onClick={() => setShowClosed(s => !s)}>
            {showClosed ? 'Hide' : 'Show'} closed ({closed.length})
          </button>
          <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setAddOpen(true)}>
            <Plus size={14} /> Add Candidate
          </button>
        </div>
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
        /* Desktop: kanban columns */
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${showClosed ? 6 : 4}, 1fr)`, gap: 12, alignItems: 'start' }}>
          {[...STAGES.slice(0, 4), ...(showClosed ? ['hired', 'rejected'] : [])].map(s => (
            <div key={s} style={{ background: 'rgba(255,255,255,0.55)', border: '1px solid var(--line)', borderRadius: 14, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px 10px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: `hsl(${STAGE_META[s].hue})` }} />
                <b style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase' }}>{STAGE_META[s].label}</b>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 20, padding: '0 7px', color: 'var(--muted)' }}>{byStage(s).length}</span>
              </div>
              {byStage(s).map(card)}
            </div>
          ))}
        </div>
      )}

      {addOpen && <CandidateFormModal onClose={() => setAddOpen(false)} toastErr={toastErr}
        onSaved={c => { setCandidates(prev => [c, ...prev]); toastOk(`${candName(c)} added to the pipeline.`); }} />}
      {detail && <CandidateDetailModal candidate={detail} onClose={() => setDetail(null)} onStage={moveStage} busy={busy} />}
    </div>
  );
}

// ── Org chart (Phase 5) — top-down tree with connector lines ──────────────────
function OrgNode({ e, childrenMap }) {
  const kids = childrenMap.get((e.workEmail || '').toLowerCase()) || [];
  return (
    <li>
      <div className="org-card">
        <Avatar e={e} size={36} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{fullName(e)}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{[e.jobTitle, e.department].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        {kids.length > 0 && <span style={{ fontSize: 10, fontWeight: 800, background: 'hsla(var(--color-blue),0.1)', color: 'hsl(var(--color-blue))', borderRadius: 20, padding: '1px 7px', flexShrink: 0 }}>{kids.length}</span>}
      </div>
      {kids.length > 0 && <ul>{kids.map(k => <OrgNode key={k.id} e={k} childrenMap={childrenMap} />)}</ul>}
    </li>
  );
}

function OrgChartTab({ employees }) {
  const people = employees.filter(e => e.status !== 'offboarded');
  const emails = new Set(people.map(e => (e.workEmail || '').toLowerCase()).filter(Boolean));
  const childrenMap = new Map();
  for (const e of people) {
    const m = (e.managerEmail || '').toLowerCase();
    if (m && emails.has(m)) {
      if (!childrenMap.has(m)) childrenMap.set(m, []);
      childrenMap.get(m).push(e);
    }
  }
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

  if (!people.length) return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
      <Network size={32} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 14, fontWeight: 600 }}>Add people first — the chart draws itself from each person's "Reports to".</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 14 }}>
        {people.length} people · {linked} in the reporting hierarchy
      </div>
      {roots.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>Reporting hierarchy</div>
          <div className="org-tree-wrap">
            <div className="org-tree">
              <ul>{roots.map(r => <OrgNode key={r.id} e={r} childrenMap={childrenMap} />)}</ul>
            </div>
          </div>
        </div>
      )}
      {unlinked.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'hsl(var(--color-orange))', textTransform: 'uppercase', marginBottom: 8 }}>
            No reporting line — set "Reports to" on their profile
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {unlinked.map(e => (
              <div key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: 'var(--card)', border: '1px dashed hsla(var(--color-orange),0.5)', borderRadius: 12, padding: '8px 13px' }}>
                <Avatar e={e} size={28} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 12.5 }}>{fullName(e)}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{[e.jobTitle, e.department].filter(Boolean).join(' · ') || '—'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
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

function LeaveTab({ employees, toastOk, toastErr }) {
  const [leave, setLeave] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [empF, setEmpF] = useState('All');
  const [balances, setBalances] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const year = new Date().getFullYear();

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

  const visible = empF === 'All' ? leave : leave.filter(r => r.employeeId === empF);
  const pending = leave.filter(r => r.status === 'pending').length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <select className="form-input" value={empF} onChange={e => setEmpF(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, height: 34 }}>
          <option value="All">All employees</option>
          {employees.map(e => <option key={e.id} value={e.id}>{fullName(e)}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{pending} pending · {leave.length} total</span>
        <button className="primary-btn" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }} onClick={() => setFormOpen(true)}>
          <Plus size={14} /> New Leave
        </button>
      </div>

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

  const toastErr = msg => { setToast({ msg, kind: 'error' }); setTimeout(() => setToast(null), 5000); };
  const toastOk  = msg => { setToast({ msg, kind: 'ok' }); setTimeout(() => setToast(null), 4000); };

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

      {sub === 'hr-hiring' && (
        <HiringTab isMobile={isMobile} toastOk={toastOk} toastErr={toastErr}
          onEmployeeCreated={emp => setEmployees(prev => [...prev, emp].sort((a, b) => fullName(a).localeCompare(fullName(b))))} />
      )}
      {sub === 'hr-org' && <OrgChartTab employees={employees} />}
      {sub === 'hr-leave' && <LeaveTab employees={employees} toastOk={toastOk} toastErr={toastErr} />}

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
                  toastOk={toastOk} toastErr={toastErr} onEmployeeUpdated={onSaved}
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
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
