// Add Person - ONE sheet for everyone who joins the People list (Neil,
// 11/03/2026). The first question is who you are adding; the form then asks
// only what that kind needs, and the kind decides the account type:
//   Employee               POST /hr/employees, identity internal, full-time /
//                          part-time / intern
//   Independent Contractor POST /hr/employees, employment type contractor,
//                          with the contractor engagement block
//   External               POST /external-users - the same form and the same
//                          save as Invite External User (useExternalInviteForm)
//   Guest                  POST /hr/employees, identity guest (a Microsoft 365
//                          B2B partner account)
// Status is not chosen here - the server's default applies. "On the
// Schedule" (default on) is sent as `on_schedule`. A job role picked here sets
// their access once they have a work email. One Save.
import { useEffect, useState } from 'react';
import { UserPlus, RefreshCw, UserRound, Briefcase, Building2, Globe, Check, ChevronDown } from 'lucide-react';
import { api } from '../api';
import { Spinner } from '../components/AsyncState';
import { Modal, DateField, PersonSelect } from '../tasks/components';
import { SwitchRow, SettingCard } from '../components/settings/SettingsUI';
import { useExternalInviteForm } from '../views/ExternalUsersPanel';
import { RoleOptions, rolesForCompany } from '../views/RolesAccess';
import { ROLES } from '../contexts/RoleContext';
import { COUNTRIES } from '../lib/countries';
import { currencyOptions } from '../asset/lib/currency';

// [key, label, what it means, icon] - the four cards at the top (Neil,
// 11/13/2026: a green highlight on the one picked, never a black block).
const PERSON_KINDS = [
  ['employee', 'Employee', 'On payroll, with time tracking', UserRound],
  ['contractor', 'Independent Contractor', 'Engagement, SOW and rate', Briefcase],
  ['external', 'External', 'Partner company, signs in with a code', Building2],
  ['guest', 'Guest', 'Microsoft 365 guest account', Globe],
];
const EMPLOYEE_TYPES = [['full_time', 'Full-Time'], ['part_time', 'Part-Time'], ['intern', 'Intern']];

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 };
const HINT = { fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const PICK_BOX = { height: 38, padding: '0 13px', borderRadius: 10, fontSize: 13, fontWeight: 400 };
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 };
const SECTION = { fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '20px 0 10px', paddingTop: 16, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 };
// A date box drawn like the inputs beside it (it read as loose text before).
const DATE_BOX = { width: '100%', boxSizing: 'border-box', height: 38, padding: '0 13px', border: '1px solid var(--wk-line2)', borderRadius: 10, background: 'var(--card)', fontSize: 13 };
const fullName = (e) => [e?.firstName, e?.lastName].filter(Boolean).join(' ');
const pickRows = (list) => {
  const seen = new Set();
  return list.filter((e) => {
    const em = (e.workEmail || '').toLowerCase();
    if (!em || seen.has(em)) return false;
    seen.add(em);
    return true;
  }).map((e) => ({ email: e.workEmail.toLowerCase(), name: fullName(e), external: ['guest', 'external'].includes(e.identityType || 'internal') }));
};

const BLANK = {
  first_name: '', last_name: '', work_email: '', personal_email: '', phone: '', job_title: '', designation: '',
  department: '', employment_type: 'full_time', start_date: '', manager_email: '', backup_manager_email: '',
  location: '', country: '', office_phone: '', street_address: '', city: '', state: '', postal_code: '',
  company: '', contractor: {}, notes: '',
};

export default function AddPersonSheet({
  employees = [], externals = [], entities = [], isAdmin = false, canAddExternal = isAdmin, canSeeComp = false,
  initialKind = 'employee', onClose, onSaved, onExternalSaved, toastOk, toastErr,
}) {
  const kinds = PERSON_KINDS.filter(([k]) => k !== 'external' || canAddExternal);
  const [kind, setKind] = useState(kinds.some(([k]) => k === initialKind) ? initialKind : 'employee');
  const [f, setF] = useState(BLANK);
  const [onSchedule, setOnSchedule] = useState(true);
  const [jobRoles, setJobRoles] = useState([]);
  const [jobRoleId, setJobRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  // Office, address, designation and notes: optional, folded until asked for.
  const [more, setMore] = useState(false);
  const ext = useExternalInviteForm(null);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setC = (k, v) => setF((p) => ({ ...p, contractor: { ...(p.contractor || {}), [k]: v } }));
  const isContractor = kind === 'contractor';
  const isGuest = kind === 'guest';
  const isExternal = kind === 'external';

  useEffect(() => { if (isAdmin) api.getJobRoles().then((r) => setJobRoles(Array.isArray(r) ? r : [])).catch(() => {}); }, [isAdmin]);

  // Departments come from the picked company - no company, no department.
  const [deptOptions, setDeptOptions] = useState([]);
  const [deptLoading, setDeptLoading] = useState(false);
  const [addingDept, setAddingDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [deptSaving, setDeptSaving] = useState(false);
  useEffect(() => {
    if (!f.company) { setDeptOptions([]); return; }
    setDeptLoading(true);
    api.getCompanyDepartments(f.company)
      .then((list) => setDeptOptions((list || []).map((d) => d.name)))
      .catch(() => setDeptOptions([]))
      .finally(() => setDeptLoading(false));
  }, [f.company]);
  async function saveNewDept() {
    const name = newDeptName.trim();
    if (!name || deptSaving) return;
    setDeptSaving(true);
    try {
      const list = await api.addCompanyDepartment(f.company, name);
      setDeptOptions(list.map((d) => d.name));
      set('department', name);
      setAddingDept(false); setNewDeptName('');
    } catch (err) { toastErr(err?.message || 'Could not add the department.'); }
    finally { setDeptSaving(false); }
  }

  const managers = [...employees, ...externals].filter((e) => e.workEmail);
  const dirty = isExternal ? ext.dirty : JSON.stringify(f) !== JSON.stringify(BLANK) || !!jobRoleId || !onSchedule;
  const ready = isExternal ? true : !!f.first_name.trim();

  async function save() {
    if (busy) return;
    if (isExternal) {
      setBusy(true);
      const result = await ext.submit();
      setBusy(false);
      if (result) { onExternalSaved?.(result); onClose(); }
      return;
    }
    if (!f.first_name.trim()) { toastErr('Enter their first name.'); return; }
    setBusy(true);
    try {
      const body = {
        ...f,
        employment_type: isContractor ? 'contractor' : isGuest ? (f.employment_type === 'intern' ? 'intern' : 'full_time') : f.employment_type,
        identity_type: isGuest ? 'guest' : 'internal',
        contractor: isContractor ? f.contractor : {},
        on_schedule: onSchedule,
      };
      const saved = await api.createEmployee(body);
      const wemail = (saved?.workEmail || f.work_email || '').trim();
      if (jobRoleId) {
        if (wemail) {
          try { await api.assignJobRole(jobRoleId, wemail); toastOk?.(`${fullName(saved) || f.first_name} added - job role and access assigned.`); }
          catch (err) { toastErr(err?.message || 'Added, but the job role could not be assigned - set it on their Access tab.'); }
        } else {
          toastOk?.('Added - set their job role on the Access tab once they have a work email.');
        }
      } else if (!saved?.entra) {
        toastOk?.(`${fullName(saved) || f.first_name} added.`);
      }
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toastErr(err?.message || 'Could not add this person.');
      setBusy(false);
    }
  }

  const input = (label, key, props = {}) => (
    <div>
      <label style={FL} htmlFor={`ap-${key}`}>{label}</label>
      <input id={`ap-${key}`} className="form-input" style={{ width: '100%' }} value={f[key]} onChange={(e) => set(key, e.target.value)} {...props} />
    </div>
  );
  const cInput = (label, key, props = {}) => (
    <div>
      <label style={FL} htmlFor={`ap-c-${key}`}>{label}</label>
      <input id={`ap-c-${key}`} className="form-input" style={{ width: '100%' }} value={(f.contractor || {})[key] || ''} onChange={(e) => setC(key, e.target.value)} {...props} />
    </div>
  );
  const kindLabel = kinds.find(([k]) => k === kind)?.[1] || 'Person';
  const saveLabel = isExternal ? ext.submitLabel : `Add ${kindLabel}`;

  return (
    <Modal title="Add Person" onClose={onClose} isDirty={dirty && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" onClick={save} disabled={busy || !ready}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (busy || !ready) ? 0.6 : 1 }}>
          {busy ? <Spinner size={14} /> : <UserPlus size={14} />} {saveLabel}
        </button>
      </>}>
      <div className="ap-form" style={{ fontFamily: 'Inter,sans-serif' }}>
        {/* Who you are adding: four cards, the picked one lit in the brand
            green with a check (Neil, 11/13/2026: "better highlight colors
            than black"); each card says what the kind means, so there is no
            separate hint line under them. */}
        <div style={{ ...FL, marginBottom: 8 }} id="ap-kind-label">Who Are You Adding?</div>
        <div role="radiogroup" aria-labelledby="ap-kind-label" className="ap-kinds">
          {kinds.map(([k, label, desc, Icon]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              aria-label={label} aria-describedby={`ap-kind-${k}`}
              className={`ap-kind${kind === k ? ' is-on' : ''}`}>
              <span className="ap-kind-top">
                <Icon size={16} aria-hidden="true" />
                {kind === k && <Check size={14} className="ap-kind-check" aria-hidden="true" />}
              </span>
              <span className="ap-kind-label">{label}</span>
              <span className="ap-kind-desc" id={`ap-kind-${k}`}>{desc}</span>
            </button>
          ))}
        </div>

        {isExternal ? <div style={{ marginTop: 20 }}>{ext.fields}</div> : (
          <>
            {/* Tighter (Neil, 11/13/2026: "tighten and or simplify this
                screen"): what most people fill - name, job, who they report
                to, access - in four short groups; the office, address,
                designation and notes fold under one line at the foot. */}
            <div style={{ ...SECTION, borderTop: 0, marginTop: 20, paddingTop: 0 }}>Name and Contact</div>
            <div style={GRID}>
              {input('First Name *', 'first_name', { autoFocus: true })}
              {input('Last Name', 'last_name')}
              {input('Mobile Phone', 'phone', { type: 'tel' })}
              {input(isGuest ? 'Email' : 'Work Email', 'work_email', { type: 'email', placeholder: isGuest ? 'Their own company email' : 'Empty until provisioned' })}
              {!isGuest && input('Personal Email', 'personal_email', { type: 'email' })}
            </div>

            <div style={SECTION}>{isGuest ? 'Where They Fit' : 'Job'}</div>
            <div style={GRID}>
              <div>
                <label style={FL} htmlFor="ap-company">{isGuest ? 'Company They Work With' : 'Company'}</label>
                <select id="ap-company" className="form-input" style={{ width: '100%' }} value={f.company}
                  onChange={(e) => { set('company', e.target.value); set('department', ''); setAddingDept(false); setJobRoleId(''); }}>
                  <option value="">Not set</option>
                  {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
                </select>
              </div>
              {!isGuest && (
                <div>
                  <label style={FL} htmlFor="ap-department">Department</label>
                  {addingDept ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input className="form-input" style={{ flex: 1, minWidth: 0 }} autoFocus placeholder="New department name" aria-label="New Department Name"
                        value={newDeptName} onChange={(e) => setNewDeptName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveNewDept(); if (e.key === 'Escape') { setAddingDept(false); setNewDeptName(''); } }} />
                      <button type="button" className="primary-btn" onClick={saveNewDept} disabled={!newDeptName.trim() || deptSaving} style={{ padding: '0 12px' }}>
                        {deptSaving ? <Spinner size={13} /> : 'Add'}
                      </button>
                    </div>
                  ) : (
                    <select id="ap-department" className="form-input" style={{ width: '100%' }} value={f.department} disabled={!f.company}
                      onChange={(e) => { if (e.target.value === '__new__') setAddingDept(true); else set('department', e.target.value); }}>
                      {!f.company
                        ? <option value="">Pick a company first</option>
                        : <>
                          <option value="">{deptLoading ? 'Loading…' : (deptOptions.length ? 'Select…' : 'None yet')}</option>
                          {deptOptions.map((d) => <option key={d}>{d}</option>)}
                          {/* Adding a department is a choice in the list, not a link under it. */}
                          {!deptLoading && <option value="__new__">+ Add a Department...</option>}
                        </>}
                    </select>
                  )}
                </div>
              )}
              {input('Job Title', 'job_title')}
              {kind === 'employee' && (
                <div>
                  <label style={FL} htmlFor="ap-type">Employment Type</label>
                  <select id="ap-type" className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={(e) => set('employment_type', e.target.value)}>
                    {EMPLOYEE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              )}
              {!isGuest && (
                <div>
                  <label style={FL}>Start Date</label>
                  <DateField value={f.start_date} onChange={(v) => set('start_date', v || '')} placeholder="MM/DD/YYYY" title="Start date" style={DATE_BOX} />
                </div>
              )}
            </div>

            <div style={SECTION}>Reporting</div>
            <div style={GRID}>
              <div>
                <label style={FL}>Reports To</label>
                <PersonSelect value={(f.manager_email || '').toLowerCase() || null} onChange={(v) => set('manager_email', v || '')}
                  people={pickRows(managers)} placeholder="No reporting line" noneLabel="No Reporting Line"
                  ariaLabel="Reports To" style={PICK_BOX} />
              </div>
              {!isGuest && (
                <div>
                  <label style={FL}>Backup Manager</label>
                  <PersonSelect value={(f.backup_manager_email || '').toLowerCase() || null} onChange={(v) => set('backup_manager_email', v || '')}
                    people={pickRows(managers.filter((m) => m.workEmail.toLowerCase() !== (f.manager_email || '').toLowerCase()))}
                    placeholder="Their manager's manager" noneLabel="Use the Default"
                    ariaLabel="Backup Manager" style={PICK_BOX} />
                </div>
              )}
            </div>
            {!isGuest && <div style={HINT}>The backup manager has the same rights over this person as their manager - time sheets, punches, time off and approvals. Left empty: their manager&apos;s manager, else the company&apos;s HR contact.</div>}

            <div style={SECTION}>Access and Schedule</div>
            {isAdmin && (
              <div style={{ marginBottom: 12 }}>
                <label style={FL} htmlFor="ap-role">Job Role</label>
                <select id="ap-role" className="form-input" style={{ width: '100%' }} value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)}>
                  <option value="">Set later on the Access tab</option>
                  <RoleOptions roles={rolesForCompany(jobRoles, f.company)} companyName={(id) => entities.find((en) => en.id === id)?.name || 'Another company'}
                    label={(r) => `${r.name} · ${ROLES[r.tier]?.label || r.tier}`} />
                </select>
                <div style={HINT}>Sets their access and tier. Needs a work email; otherwise set it later on their Access tab.</div>
              </div>
            )}
            <SettingCard>
              <SwitchRow id="ap-on-schedule" title="On the Schedule" checked={onSchedule} onChange={setOnSchedule}
                desc="They show on the shift planner and count toward Late and No-Show. Off for people who never work shifts." />
            </SettingCard>

            {isContractor && (
              <>
                <div style={SECTION}>Contractor Engagement</div>
                <div style={GRID}>
                  <div style={{ gridColumn: '1 / -1' }}>{cInput('Scope or Role', 'scope', { placeholder: 'What they are engaged to do' })}</div>
                  {cInput('SOW Reference', 'sow_ref', { placeholder: 'SOW doc # or link' })}
                  <div>
                    {cInput('Billing Client', 'billing_client', { placeholder: 'Client name, for reference' })}
                    <div style={HINT}>Invoices bill to the person&apos;s own company as set on their profile.</div>
                  </div>
                  <div>
                    <label style={FL}>Contract Start</label>
                    <DateField value={(f.contractor || {}).contract_start || ''} onChange={(v) => setC('contract_start', v || '')} placeholder="MM/DD/YYYY" title="Contract start" style={DATE_BOX} />
                  </div>
                  <div>
                    <label style={FL}>Contract End</label>
                    <DateField value={(f.contractor || {}).contract_end || ''} onChange={(v) => setC('contract_end', v || '')} placeholder="MM/DD/YYYY" title="Contract end" style={DATE_BOX} />
                  </div>
                  {cInput('Rate', 'rate', { placeholder: 'e.g. 85' })}
                  <div>
                    <label style={FL} htmlFor="ap-rate-type">Rate Type</label>
                    <select id="ap-rate-type" className="form-input" style={{ width: '100%' }} value={(f.contractor || {}).rate_type || 'hourly'} onChange={(e) => setC('rate_type', e.target.value)}>
                      <option value="hourly">Hourly</option><option value="fixed_fee">Fixed Fee</option><option value="daily">Daily</option><option value="monthly">Monthly Retainer</option>
                    </select>
                  </div>
                  <div>
                    <label style={FL} htmlFor="ap-currency">Currency</label>
                    <select id="ap-currency" className="form-input" style={{ width: '100%' }} value={(f.contractor || {}).currency || 'USD'} onChange={(e) => setC('currency', e.target.value)}>
                      {currencyOptions().map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                    </select>
                  </div>
                  {cInput('Engagement Area', 'engagement_area', { placeholder: 'e.g. Escondido dev / remote' })}
                  <div>
                    {cInput('Next Invoice Number', 'invoice_next_number', { type: 'number', min: 1, step: 1, placeholder: 'e.g. 1' })}
                    <div style={HINT}>Set once - the first invoice Nexus sends uses this number, then it counts up.</div>
                  </div>
                  <div>
                    {cInput('Invoice Description', 'invoice_description', { placeholder: 'e.g. IT Development' })}
                    <div style={HINT}>The service line on the invoice. Blank = the scope above.</div>
                  </div>
                </div>
              </>
            )}


            {/* Optional details, folded: one line opens them. */}
            <button type="button" className="ap-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              <ChevronDown size={15} aria-hidden="true" />
              {isGuest ? 'Notes' : 'Office, Address and Notes'}
              {!isGuest && (
                <span className="ap-more-sync" title="Changes here update the person's Microsoft 365 account, and changes made in Microsoft 365 come back here">
                  <RefreshCw size={11} aria-hidden="true" /> Synced with Microsoft 365
                </span>
              )}
            </button>
            {more && (
              <div style={{ marginTop: 10 }}>
                {!isGuest && (
                  <div style={{ ...GRID, marginBottom: 14 }}>
                    {input('Designation', 'designation')}
                    <div>
                      {input('Office', 'location', { placeholder: 'e.g. San Clemente', list: 'ap-office-options' })}
                      <datalist id="ap-office-options">
                        {[...new Set(employees.map((x) => (x.location || '').trim()).filter(Boolean))].sort().map((o) => <option key={o} value={o} />)}
                      </datalist>
                    </div>
                    {input('Office Phone', 'office_phone', { type: 'tel' })}
                    <div style={{ gridColumn: '1 / -1' }}>{input('Street Address', 'street_address', { placeholder: 'Work address - shown in Outlook and Teams' })}</div>
                    {input('City', 'city')}
                    {input('State or Province', 'state')}
                    {input('ZIP or Postal Code', 'postal_code')}
                    <div>
                      <label style={FL} htmlFor="ap-country">Country or Region</label>
                      <select id="ap-country" className="form-input" style={{ width: '100%' }} value={f.country} onChange={(e) => set('country', e.target.value)}>
                        <option value="">Not set</option>
                        {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
                      </select>
                      <div style={HINT}>Where this person actually is - also drives their email signature&apos;s phone country code.</div>
                    </div>
                  </div>
                )}
                <label style={FL} htmlFor="ap-notes">Notes</label>
                <textarea id="ap-notes" className="form-input" rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
                  value={f.notes} onChange={(e) => set('notes', e.target.value)} />
              </div>
            )}

            {canSeeComp && !isContractor && !isGuest && (
              <div style={{ ...HINT, marginTop: 14 }}>Pay, the overtime rule and time tracking are set on their Pay &amp; Benefits tab once they are added.</div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
