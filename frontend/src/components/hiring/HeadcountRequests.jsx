// Headcount requests (Neil, Oct 27 2026) - asking to hire before there is a
// candidate. A manager or HR raises one; the department head's line approves
// it, then HR (the company's HR contact, an administrator or owner, or a Full
// People grant). Approved, it becomes a Draft job opening HR prepares in
// People > Hiring > Openings. Lives in Team > Headcount (managers and anyone
// with a request to decide) and People > Hiring > Headcount (HR).
//
// The salary range is restricted: the server sends it only to Pay & Benefits
// holders and owners. Anyone raising a request may give one; afterwards it
// shows as "set" to everyone else.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Send, CheckCircle, XCircle, Pencil, Briefcase } from 'lucide-react';
import { api } from '../../api';
import { Modal, DateField, AvatarName } from '../../tasks/components';
import { StatusLabel } from '../StatusLabel';
import { SkeletonBlocks, ErrorBanner, Spinner } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { currencyOptions, moneyPrefix } from '../../asset/lib/currency';

const STATUS = {
  draft: { label: 'Draft', color: '#64748b' },
  awaiting_approval: { label: 'Awaiting Approval', color: '#d97706' },
  approved: { label: 'Approved', color: '#16a34a' },
  declined: { label: 'Declined', color: '#dc2626' },
};
const ACTIONS = {
  created: 'Created', edited: 'Edited', submitted: 'Sent For Approval', department_approved: 'Approved By The Department',
  department_declined: 'Declined By The Department', department_skipped: 'Sent Straight To HR', hr_approved: 'Approved By HR', hr_declined: 'Declined By HR',
};
const PERIOD = { year: 'per year', month: 'per month', hour: 'per hour' };
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const OTHER = '__other__';

function salaryText(r) {
  const lo = r.salaryMin, hi = r.salaryMax;
  if (lo == null && hi == null) return '';
  const p = moneyPrefix(r.salaryCurrency || 'USD');
  const f = (v) => `${p}${Number(v).toLocaleString('en-US', { maximumFractionDigits: (r.salaryPeriod === 'hour' ? 2 : 0) })}`;
  return `${lo != null && hi != null && lo !== hi ? `${f(lo)} - ${f(hi)}` : f(lo ?? hi)} ${PERIOD[r.salaryPeriod] || 'per year'}`;
}

// The approvers it waits on, each with their face. `card` is false inside the
// list row, which is itself a button.
function approverNames(list, card = true) {
  return list.map((a, i) => <span key={a.email || i}>{i ? ', ' : ''}<AvatarName email={a.email} name={a.name} size={16} card={card} /></span>);
}

function stepText(r, card = true) {
  if (r.status === 'awaiting_approval') {
    if (r.step === 'department') return r.deptApprovers.length ? <>Waiting on the department ({approverNames(r.deptApprovers, card)})</> : 'Waiting on the department (Global Admins)';
    return 'Waiting on HR';
  }
  if (r.status === 'approved') return r.openingId ? 'Approved - the job opening is with HR' : 'Approved';
  if (r.status === 'declined') return `Declined${r.declineNote ? ` - ${r.declineNote}` : ''}`;
  return 'Not sent yet';
}

export default function HeadcountRequests({ toastOk, toastErr }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null);      // null | {} (new) | a request

  const load = useCallback(() => {
    setLoadErr(false);
    return Promise.all([api.listHeadcount(), api.headcountMeta()])
      .then(([list, m]) => { setRows(list); setMeta(m); })
      .catch(() => setLoadErr(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (rows || []).filter(r => (filter === 'waiting' ? r.canDecide
    : filter === 'open' ? ['draft', 'awaiting_approval'].includes(r.status) : true)), [rows, filter]);
  const waiting = (rows || []).filter(r => r.canDecide).length;
  const open = rows?.find(r => r.id === openId) || null;
  const replace = (r) => setRows(prev => [r, ...(prev || []).filter(x => x.id !== r.id)]);

  if (loadErr) return <ErrorBanner message="Couldn't load headcount requests right now." onRetry={load} />;
  if (rows === null || meta === null) return <SkeletonBlocks count={3} height={64} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 4 }}>
          {[['all', 'All'], ['waiting', `Waiting On Me${waiting ? ` (${waiting})` : ''}`], ['open', 'In Progress']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
              className={filter === k ? 'primary-btn' : 'secondary-btn'} style={{ fontSize: 12.5, padding: '5px 12px' }}>{label}</button>
          ))}
        </div>
        {meta.canRaise && (
          <button className="primary-btn" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
            onClick={() => setEditing({})}><Plus size={14} /> New Headcount Request</button>
        )}
      </div>

      {shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <Briefcase size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>{filter === 'waiting' ? 'Nothing waiting on you.' : 'No headcount requests yet.'}</div>
          {meta.canRaise && filter === 'all' && <div style={{ fontSize: 12.5, marginTop: 4 }}>Need someone new on the team? Raise a request - the department and HR approve it, then HR posts the job.</div>}
        </div>
      ) : (
        <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(r => (
            <button key={r.id} role="listitem" onClick={() => setOpenId(r.id)}
              style={{ textAlign: 'left', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>
                  {r.openings > 1 ? `${r.openings} x ` : ''}{r.roleTitle || 'Untitled role'}
                  <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}> · {r.code}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {[r.companyName, r.department, r.location].filter(Boolean).join(' · ')} - raised by <AvatarName email={r.requestedBy} name={r.requestedByName} size={18} card={false} /> {r.submittedAt ? `on ${formatDate(r.submittedAt)}` : ''}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{stepText(r, false)}</div>
              </div>
              {r.canDecide && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--wk-brand, #2b45e1)' }} title="Waiting on you" />}
              <StatusLabel label={STATUS[r.status]?.label || r.status} color={STATUS[r.status]?.color} />
            </button>
          ))}
        </div>
      )}

      {open && <RequestDetail r={open} meta={meta} onClose={() => setOpenId(null)} onChanged={replace}
        onEdit={() => { setEditing(open); setOpenId(null); }} toastOk={toastOk} toastErr={toastErr} />}
      {editing && <RequestForm initial={editing.id ? editing : null} meta={meta} onClose={() => setEditing(null)} toastErr={toastErr}
        onSaved={(r, sent) => { replace(r); setEditing(null); toastOk?.(sent ? `${r.code} sent for approval.` : `${r.code} saved as a draft.`); }} />}
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 13.5, marginTop: 2, color: 'var(--ink)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{children}</div>
    </div>
  );
}

function RequestDetail({ r, meta, onClose, onChanged, onEdit, toastOk, toastErr }) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');

  async function run(fn, done) {
    if (busy) return;
    setBusy(true);
    try { const out = await fn(); onChanged(out); toastOk?.(done(out)); setDeclining(false); }
    catch (e) { toastErr?.(e?.message || 'Could not save that.'); }
    setBusy(false);
  }
  const approve = () => run(() => api.decideHeadcount(r.id, 'approve'), out => (out.status === 'approved' ? `${r.code} approved - the job opening is ready for HR.` : `${r.code} approved - it is with HR now.`));
  const decline = () => run(() => api.decideHeadcount(r.id, 'decline', note.trim()), () => `${r.code} declined.`);
  const submit = () => run(() => api.submitHeadcount(r.id), () => `${r.code} sent for approval.`);

  const footer = (
    <>
      {r.canEdit && <button className="secondary-btn" onClick={onEdit} disabled={busy} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Pencil size={14} /> Edit</button>}
      {r.canEdit && <button className="primary-btn" onClick={submit} disabled={busy} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Send size={14} /> {r.status === 'declined' ? 'Send Again' : 'Send For Approval'}</button>}
      {r.canDecide && !declining && <button className="secondary-btn" onClick={() => setDeclining(true)} disabled={busy} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><XCircle size={14} /> Decline</button>}
      {r.canDecide && declining && <button className="secondary-btn" onClick={() => setDeclining(false)} disabled={busy}>Cancel</button>}
      {r.canDecide && declining && <button className="primary-btn" onClick={decline} disabled={busy || !note.trim()} style={{ background: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>Decline Request</button>}
      {r.canDecide && !declining && <button className="primary-btn" onClick={approve} disabled={busy} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Approve</button>}
      {r.openingId && meta.isHr && <button className="secondary-btn" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'hr', sub: 'hr-hiring' } })); }}>Open In Hiring</button>}
    </>
  );
  return (
    <Modal title={`${r.code} - ${r.roleTitle || 'Headcount Request'}`} onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <StatusLabel label={STATUS[r.status]?.label || r.status} color={STATUS[r.status]?.color} />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{stepText(r)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0 28px' }}>
        <Fact label="Company">{r.companyName || '-'}</Fact>
        <Fact label="Department">{r.department || '-'}</Fact>
        <Fact label="Role">{r.roleTitle || '-'}</Fact>
        <Fact label="Openings">{r.openings}</Fact>
        <Fact label="Employment Type">{r.employmentLabel || '-'}</Fact>
        <Fact label="Location">{r.location || '-'}</Fact>
        <Fact label="Target Start">{r.targetStart ? formatDate(r.targetStart) : '-'}</Fact>
        <Fact label="Salary Range">{r.canSeePay ? (salaryText(r) || 'Not given') : r.hasSalary ? 'Set - shown to Pay & Benefits only' : 'Not given'}</Fact>
        <Fact label="Raised By">{r.requestedByName ? <AvatarName email={r.requestedBy} name={r.requestedByName} size={22} /> : '-'}</Fact>
        <Fact label="Approvals">
          <div>Department: {r.deptDecidedByName ? <AvatarName email={r.deptDecidedBy} name={r.deptDecidedByName} size={18} /> : r.deptApprovers.length ? approverNames(r.deptApprovers) : '-'}</div>
          <div>HR: {r.hrDecidedByName ? <AvatarName email={r.hrDecidedBy} name={r.hrDecidedByName} size={18} /> : (r.step === 'hr' ? 'waiting' : '-')}</div>
        </Fact>
      </div>
      <Fact label="Justification">{r.justification || '-'}</Fact>
      {declining && (
        <div className="nx-fill" style={{ marginTop: 12 }}>
          <label style={FL} htmlFor="hc-decline">Why Is It Declined? *</label>
          <textarea id="hc-decline" className="form-input" value={note} onChange={e => setNote(e.target.value)} autoFocus
            placeholder="The requester sees this and can change the request and send it again." style={{ width: '100%', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
        </div>
      )}
      {!declining && r.history.length > 0 && (
        <div className="nx-fill" style={{ marginTop: 14 }}>
          <div style={FL}>History</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {r.history.map((h, i) => (
              <div key={i} style={{ fontSize: 12.5, color: 'var(--ink)' }}>
                <b>{ACTIONS[h.action] || h.action}</b> - {h.byName ? <AvatarName email={h.by} name={h.byName} size={16} /> : 'Nexus'} · {formatDateTime(h.at)}
                {h.note && <div style={{ color: 'var(--muted)', marginTop: 1 }}>{h.note}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function emptyForm(m) {
  return { company: m.companyId || '', role_id: '', role_title: '', department: '', work_site_id: '', location: '',
    employment_type: 'full_time', openings: 1, target_start: '', salary_min: '', salary_max: '',
    salary_currency: 'USD', salary_period: 'year', justification: '' };
}
function fromRow(r) {
  return { company: r.company, role_id: r.roleId || (r.roleTitle ? OTHER : ''), role_title: r.roleTitle, department: r.department,
    work_site_id: r.workSiteId, location: r.location, employment_type: r.employmentType || 'full_time', openings: r.openings || 1,
    target_start: r.targetStart, salary_min: r.salaryMin ?? '', salary_max: r.salaryMax ?? '',
    salary_currency: r.salaryCurrency || 'USD', salary_period: r.salaryPeriod || 'year', justification: r.justification };
}

export function RequestForm({ initial, meta: baseMeta, onClose, onSaved, toastErr }) {
  const [meta, setMeta] = useState(baseMeta);
  const [f, setF] = useState(() => (initial ? fromRow(initial) : emptyForm(baseMeta)));
  const [start] = useState(() => JSON.stringify(f));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  // A request that is not new shows its salary only to Pay & Benefits - and
  // only they may change it (the server refuses anyone else).
  const payEditable = !initial || baseMeta.canSeePay;

  useEffect(() => {
    if (!f.company || f.company === meta.companyId) return;
    let live = true;
    api.headcountMeta(f.company).then(m => { if (live) setMeta(m); }).catch(() => {});
    return () => { live = false; };
  }, [f.company, meta.companyId]);

  const role = meta.roles.find(r => r.id === f.role_id);
  const other = f.role_id === OTHER;
  const pickRole = (id) => {
    const r = meta.roles.find(x => x.id === id);
    setF(p => ({ ...p, role_id: id, role_title: r ? r.name : (id === OTHER ? '' : p.role_title), department: r?.department || (id === OTHER ? p.department : '') }));
  };
  const problems = [
    !f.company && 'Company', !f.role_id && 'Role', other && !f.role_title.trim() && 'Role title',
    !(role?.department || f.department) && 'Department', !(Number(f.openings) >= 1) && 'Number of openings',
    !f.justification.trim() && 'Justification',
    f.salary_min !== '' && f.salary_max !== '' && Number(f.salary_min) > Number(f.salary_max) && 'A salary range whose minimum is not above its maximum',
  ].filter(Boolean);
  const dirty = JSON.stringify(f) !== start;

  async function save(submit) {
    if (busy || (submit && problems.length)) return;
    setBusy(true);
    const body = {
      company: f.company, role_id: other ? '' : f.role_id, role_title: other ? f.role_title.trim() : (role?.name || f.role_title),
      department: role?.department || f.department, work_site_id: f.work_site_id, location: f.work_site_id ? '' : f.location.trim(),
      employment_type: f.employment_type, openings: Number(f.openings) || 1, target_start: f.target_start || '',
      justification: f.justification.trim(), submit,
    };
    if (payEditable) {
      Object.assign(body, { salary_min: f.salary_min === '' ? null : Number(f.salary_min), salary_max: f.salary_max === '' ? null : Number(f.salary_max),
        salary_currency: f.salary_currency, salary_period: f.salary_period });
    }
    try {
      const out = initial ? await api.updateHeadcount(initial.id, body) : await api.createHeadcount(body);
      onSaved(out, submit);
    } catch (e) { toastErr?.(e?.message || 'Could not save the request.'); setBusy(false); }
  }

  const footer = (
    <>
      {problems.length > 0 && dirty && <span style={{ fontSize: 11.5, color: 'var(--muted)', marginRight: 'auto' }}>Still needed: {problems.join(', ')}</span>}
      <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="secondary-btn" onClick={() => save(false)} disabled={busy || !f.company}>Save Draft</button>
      <button className="primary-btn" onClick={() => save(true)} disabled={busy || problems.length > 0} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {busy ? <Spinner size={14} /> : <Send size={14} />} Send For Approval
      </button>
    </>
  );
  return (
    <Modal title={initial ? `Edit ${initial.code}` : 'New Headcount Request'} onClose={onClose} footer={footer} isDirty={dirty}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 14 }}>
        <div><label style={FL} htmlFor="hc-company">Company *</label>
          <select id="hc-company" className="form-input" style={{ width: '100%' }} value={f.company}
            onChange={e => setF(p => ({ ...p, company: e.target.value, role_id: p.role_id === OTHER ? OTHER : '', department: p.role_id === OTHER ? p.department : '', work_site_id: '' }))}>
            <option value="">- pick a company -</option>
            {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div><label style={FL} htmlFor="hc-role">Role *</label>
          <select id="hc-role" className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)} disabled={!f.company}>
            <option value="">{f.company ? '- pick a role -' : 'Pick the company first'}</option>
            {meta.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
            <option value={OTHER}>Other (a new role)</option>
          </select></div>
        {other && <div><label style={FL} htmlFor="hc-title">Role Title *</label>
          <input id="hc-title" className="form-input" style={{ width: '100%' }} value={f.role_title} onChange={e => set('role_title', e.target.value)} placeholder="e.g. Leasing Coordinator" /></div>}
        <div><label style={FL} htmlFor="hc-dept">Department *</label>
          {role?.department
            ? <div className="form-input" style={{ width: '100%', background: 'var(--mist)', display: 'flex', alignItems: 'center' }}>{role.department}</div>
            : <select id="hc-dept" className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
              <option value="">- pick a department -</option>
              {meta.departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>}
          <div style={hint}>The department&apos;s head and the people above them approve first.</div></div>
        <div><label style={FL} htmlFor="hc-site">Work Site</label>
          <select id="hc-site" className="form-input" style={{ width: '100%' }} value={f.work_site_id} onChange={e => set('work_site_id', e.target.value)}>
            <option value="">- another place (type it) -</option>
            {meta.workSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
        {!f.work_site_id && <div><label style={FL} htmlFor="hc-loc">Location</label>
          <input id="hc-loc" className="form-input" style={{ width: '100%' }} value={f.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Austin, TX or Remote" /></div>}
        <div><label style={FL} htmlFor="hc-type">Employment Type *</label>
          <select id="hc-type" className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
            {meta.employmentTypes.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select></div>
        <div><label style={FL} htmlFor="hc-n">Number Of Openings *</label>
          <input id="hc-n" type="number" min={1} max={100} className="form-input" style={{ width: '100%' }} value={f.openings} onChange={e => set('openings', e.target.value)} /></div>
        <div><label style={FL}>Target Start Date</label>
          <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.target_start} onChange={x => set('target_start', x || '')} placeholder="MM/DD/YYYY" title="Target Start Date" style={{ width: '100%' }} noPast />
          </div></div>
        {payEditable ? (
          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>Salary Range</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input aria-label="Salary Minimum" type="number" min={0} className="form-input" style={{ flex: '1 1 120px' }} value={f.salary_min} onChange={e => set('salary_min', e.target.value)} placeholder="Minimum" />
              <span style={{ color: 'var(--muted)' }}>-</span>
              <input aria-label="Salary Maximum" type="number" min={0} className="form-input" style={{ flex: '1 1 120px' }} value={f.salary_max} onChange={e => set('salary_max', e.target.value)} placeholder="Maximum" />
              <select aria-label="Currency" className="form-input" style={{ flex: '0 0 110px' }} value={f.salary_currency} onChange={e => set('salary_currency', e.target.value)}>
                {currencyOptions().slice(0, 12).map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
              <select aria-label="Pay Period" className="form-input" style={{ flex: '0 0 130px' }} value={f.salary_period} onChange={e => set('salary_period', e.target.value)}>
                <option value="year">Per Year</option><option value="month">Per Month</option><option value="hour">Per Hour</option>
              </select>
            </div>
            <div style={hint}>Restricted - only Pay &amp; Benefits and owners see it once it is saved.</div></div>
        ) : (
          <div style={{ gridColumn: '1 / -1' }}><label style={FL}>Salary Range</label>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{initial?.hasSalary ? 'Set - shown to Pay & Benefits only.' : 'Not given.'} Changing it takes Pay &amp; Benefits access.</div></div>
        )}
      </div>
      <div className="nx-fill" style={{ marginTop: 14 }}>
        <label style={FL} htmlFor="hc-why">Justification *</label>
        <textarea id="hc-why" className="form-input" value={f.justification} onChange={e => set('justification', e.target.value)}
          placeholder="Why this hire, why now - workload, a replacement, a new site..." style={{ width: '100%', fontFamily: 'Inter,sans-serif', fontSize: 13 }} />
      </div>
    </Modal>
  );
}
