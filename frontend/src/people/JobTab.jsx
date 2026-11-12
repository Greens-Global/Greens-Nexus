import { useEffect, useMemo, useState } from 'react';
import { Briefcase, Building2, CalendarOff, Network, Users, FileText, Activity, Pencil } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { currencyOptions } from '../asset/lib/currency';
import { DateField, PersonSelect } from '../tasks/components';
import { ProbationCard } from '../components/HrProbation';
import { RoleHistory } from '../components/RoleChangeRequests';
import { useTabDraft } from './useTabDraft';
import { Row, SectionHead, Field, EditButton, TabSaveRow } from './shared';
import { BOX, DATE_BOX, GRID, PICK_BOX, fullName, pickRows, changedKeys } from './lib';

const RATE_TYPES = [['hourly', 'Hourly'], ['fixed_fee', 'Fixed Fee'], ['daily', 'Daily'], ['monthly', 'Monthly Retainer']];

// Job (11/03/2026): what the person does and where they sit - title,
// company and department, reporting line, employment type, start date, the
// contractor engagement, probation and the role history. Status is shown,
// never typed: Change Status (with its reason) is the one way to move it.
function seedOf(e) {
  return {
    job_title: e.jobTitle || '', designation: e.designation || '',
    company: e.company || '', department: e.department || '',
    employment_type: e.employmentType || 'full_time', start_date: e.startDate || '',
    manager_email: (e.managerEmail || '').toLowerCase(), backup_manager_email: (e.backupManagerEmail || '').toLowerCase(),
    contractor: { ...(e.contractor || {}) },
    // Division lead (the Organizational Chart colors everyone under them) and, for an
    // external, the company they work for - both moved here from the Org
    // Chart panel, which now only shows a person (11/03/2026).
    division: e.division || '', external_company: e.externalCompany || '',
  };
}

export default function JobTab({
  e, employees = [], companyName = '', viewerEmail = '', canEdit = false, isRemoved = false,
  empTypes = [], statusLabel = '', onChangeStatus, focusProbation = false, onOffboard, onReload,
  roleHistoryKey = '', onSaved, toastOk, toastErr,
  // A contractor's rate is pay: only the Pay & Benefits grant sees or sets it
  // (the server leaves it out for anyone else - People review, 11/11/2026).
  canSeePay = false,
}) {
  const saved = useMemo(() => seedOf(e), [e]);
  const t = useTabDraft(saved, {
    label: 'Job',
    onSave: async (draft) => {
      const body = changedKeys(saved, draft);
      if (!Object.keys(body).length) return true;
      try {
        const out = await api.updateEmployee(e.id, body);
        onSaved?.(out);
        return true;
      } catch (err) { toastErr(err?.message || 'Could not save.'); return false; }
    },
  });
  const d = t.draft || saved;
  const set = (k) => (ev) => t.patch({ [k]: ev.target.value });
  const setC = (k, v) => t.patch({ contractor: { ...(d.contractor || {}), [k]: v } });
  const typeLabel = Object.fromEntries(empTypes);
  const me = (viewerEmail || '').toLowerCase();

  // Companies and their departments - read only while editing.
  const [entities, setEntities] = useState([]);
  const [deptsOf, setDeptsOf] = useState({ company: '', list: [] });
  const depts = deptsOf.company === d.company ? deptsOf.list : [];
  useEffect(() => {
    if (!t.editing) return undefined;
    let live = true;
    api.getEntities().then(r => { if (live) setEntities(Array.isArray(r) ? r : []); }).catch(() => {});
    return () => { live = false; };
  }, [t.editing]);
  useEffect(() => {
    if (!t.editing || !d.company) return undefined;
    let live = true;
    const company = d.company;
    api.getCompanyDepartments(company).then(list => { if (live) setDeptsOf({ company, list: (list || []).map(x => x.name) }); }).catch(() => {});
    return () => { live = false; };
  }, [t.editing, d.company]);

  // Anyone with a work email can be the reporting line (yourself excluded);
  // external leads too (Neil, Oct 12).
  const managers = useMemo(() => pickRows(employees.filter(x => x.workEmail && x.id !== e.id)), [employees, e.id]);
  const nameFor = (em) => {
    const low = (em || '').toLowerCase();
    if (!low) return '';
    if (low === me) return 'You';
    const p = employees.find(x => (x.workEmail || '').toLowerCase() === low);
    return p ? `${fullName(p)}${p.employeeCode ? ` (${p.employeeCode})` : ''}` : em;
  };
  const meEmail = (e.workEmail || '').toLowerCase();
  const reports = meEmail ? employees.filter(r => (r.managerEmail || '').toLowerCase() === meEmail) : [];
  const isContractor = (t.editing ? d.employment_type : e.employmentType) === 'contractor';
  const isExternal = ['external', 'guest'].includes(e.identityType || 'internal');
  const c = e.contractor || {};
  // Backup Manager (Neil, Oct 13): the one set on the profile, else the
  // default the server worked out for the People list.
  const bk = (e.backupManagerEmail || e.backupManager || '').toLowerCase();
  const bkWhy = e.backupManagerEmail ? '' : e.backupManagerSource === 'hr' ? ' (default - company HR contact)' : " (default - manager's manager)";
  const cInput = (label, key, props = {}) => (
    <Field label={label} htmlFor={`job-c-${key}`}>
      <input id={`job-c-${key}`} className="form-input" style={BOX} value={(d.contractor || {})[key] ?? ''} onChange={ev => setC(key, ev.target.value)} {...props} />
    </Field>
  );

  return (
    <div>
      <SectionHead icon={Briefcase} title="Job" first>
        {canEdit && !t.editing && <EditButton onClick={t.startEdit} />}
      </SectionHead>
      {t.editing ? (
        <div style={GRID}>
          <Field label="Job Title" htmlFor="job-title">
            <input id="job-title" className="form-input" style={BOX} value={d.job_title} onChange={set('job_title')} />
          </Field>
          <Field label="Designation" htmlFor="job-designation">
            <input id="job-designation" className="form-input" style={BOX} value={d.designation} onChange={set('designation')} />
          </Field>
          {/* Company first: departments come from the chosen company, and changing it clears the department. */}
          <Field label="Company" htmlFor="job-company">
            <select id="job-company" className="form-input" style={BOX} value={d.company} onChange={ev => t.patch({ company: ev.target.value, department: '' })}>
              <option value="">- Not Set -</option>
              {d.company && !entities.some(en => en.id === d.company) && <option value={d.company}>{companyName || 'Current company'}</option>}
              {entities.map(en => <option key={en.id} value={en.id}>{en.name}</option>)}
            </select>
          </Field>
          <Field label="Department" htmlFor="job-department" hint={d.company ? 'Departments are set up in Settings > Companies > Departments.' : ''}>
            <select id="job-department" className="form-input" style={BOX} value={d.department} disabled={!d.company} onChange={set('department')}>
              {!d.company ? <option value="">- Pick a Company First -</option> : (
                <>
                  <option value="">{depts.length ? '- Select -' : '- None Yet -'}</option>
                  {d.department && !depts.includes(d.department) && <option value={d.department}>{d.department} (current)</option>}
                  {depts.map(x => <option key={x}>{x}</option>)}
                </>
              )}
            </select>
          </Field>
          <Field label="Employment Type" htmlFor="job-type">
            <select id="job-type" className="form-input" style={BOX} value={d.employment_type} onChange={set('employment_type')}>
              {empTypes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Start Date">
            <DateField value={d.start_date} onChange={v => t.patch({ start_date: v || '' })} title="Start Date" placeholder="Pick a date" style={DATE_BOX} />
          </Field>
          <Field label="Reports To" wide>
            <PersonSelect value={d.manager_email || null} onChange={v => t.patch({ manager_email: v || '' })}
              people={managers} placeholder="No reporting line" noneLabel="No Reporting Line" ariaLabel="Reports To" style={PICK_BOX} />
          </Field>
          {/* Backup Manager (Neil, Oct 13): covers this person when their manager is out, with the same rights over them. Blank = the default. */}
          <Field label="Backup Manager" wide hint="Has the same rights over this person as their manager - time sheets, punches, time off and approvals.">
            <PersonSelect value={d.backup_manager_email || null} onChange={v => t.patch({ backup_manager_email: v || '' })}
              people={managers.filter(m => m.email !== d.manager_email)}
              placeholder="Default - their manager's manager, or the company's HR contact" noneLabel="Use the Default"
              ariaLabel="Backup Manager" style={PICK_BOX} />
          </Field>
          <Field label="Division Lead Of" htmlFor="job-division" hint="Everyone reporting under this person is shown as this division on the Organizational Chart. Leave blank if they do not lead a division.">
            <input id="job-division" className="form-input" style={BOX} value={d.division} placeholder="e.g. Operations" onChange={set('division')} />
          </Field>
          {isExternal && (
            <Field label="External Company" htmlFor="job-external-company">
              <input id="job-external-company" className="form-input" style={BOX} value={d.external_company} placeholder="The company they work for" onChange={set('external_company')} />
            </Field>
          )}
        </div>
      ) : (
        <div>
          <Row icon={Briefcase} label="Job Title" value={e.jobTitle} />
          {e.designation && <Row icon={Briefcase} label="Designation" value={e.designation} />}
          <Row icon={Building2} label="Company" value={companyName} />
          <Row icon={Briefcase} label="Department" value={e.department} />
          <Row icon={Briefcase} label="Employment Type" value={typeLabel[e.employmentType] || e.employmentType} />
          <Row icon={CalendarOff} label="Start Date" value={formatDate(e.startDate)} />
          <Row icon={Network} label="Reports To" value={nameFor(e.managerEmail)} />
          {bk && <Row icon={Users} label="Backup Manager" value={`${nameFor(bk)}${bkWhy}`} />}
          {reports.length > 0 && <Row icon={Users} label="Direct Reports" value={reports.map(fullName).join(', ')} />}
          {e.division && <Row icon={Network} label="Division Lead Of" value={e.division} />}
          {isExternal && <Row icon={Building2} label="External Company" value={e.externalCompany} />}
        </div>
      )}

      {/* Status is read here, changed only through Change Status (with its reason). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <Activity size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 130, flexShrink: 0 }}>Status</span>
        <span style={{ fontSize: 13.5, color: 'var(--ink)', flex: 1 }}>{statusLabel || '-'}</span>
        {onChangeStatus && (
          <button type="button" className="secondary-btn" onClick={onChangeStatus} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <Pencil size={12} /> Change Status
          </button>
        )}
      </div>

      {isContractor && (
        <>
          <SectionHead icon={FileText} title="Contractor Engagement" />
          {t.editing ? (
            <div style={GRID}>
              <Field label="Scope / Role" htmlFor="job-c-scope" wide>
                <input id="job-c-scope" className="form-input" style={BOX} value={d.contractor?.scope || ''} onChange={ev => setC('scope', ev.target.value)} placeholder="what they are engaged to do" />
              </Field>
              {cInput('SOW Reference', 'sow_ref', { placeholder: 'SOW doc # / link' })}
              <Field label="Billing Client" htmlFor="job-c-billing_client" hint="Invoices bill to the person's own company as set on their profile.">
                <input id="job-c-billing_client" className="form-input" style={BOX} value={d.contractor?.billing_client || ''} onChange={ev => setC('billing_client', ev.target.value)} placeholder="client name, for reference" />
              </Field>
              <Field label="Contract Start">
                <DateField value={d.contractor?.contract_start || ''} onChange={v => setC('contract_start', v || '')} title="Contract Start" placeholder="Pick a date" style={DATE_BOX} />
              </Field>
              <Field label="Contract End">
                <DateField value={d.contractor?.contract_end || ''} onChange={v => setC('contract_end', v || '')} title="Contract End" placeholder="Pick a date" style={DATE_BOX} />
              </Field>
              {canSeePay && (<>
              {cInput('Rate', 'rate', { placeholder: 'e.g. 85' })}
              <Field label="Rate Type" htmlFor="job-c-rate_type">
                <select id="job-c-rate_type" className="form-input" style={BOX} value={d.contractor?.rate_type || 'hourly'} onChange={ev => setC('rate_type', ev.target.value)}>
                  {RATE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Currency" htmlFor="job-c-currency">
                <select id="job-c-currency" className="form-input" style={BOX} value={d.contractor?.currency || 'USD'} onChange={ev => setC('currency', ev.target.value)}>
                  {currencyOptions().map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select>
              </Field>
              </>)}
              {cInput('Engagement Area', 'engagement_area', { placeholder: 'e.g. Escondido dev / remote' })}
              <Field label="Next Invoice Number" htmlFor="job-c-invoice_next_number" hint="Set once - the first invoice Nexus sends uses this number, then it counts up.">
                <input id="job-c-invoice_next_number" className="form-input" style={BOX} type="number" min={1} step={1} value={d.contractor?.invoice_next_number ?? ''} onChange={ev => setC('invoice_next_number', ev.target.value)} placeholder="e.g. 1" />
              </Field>
              <Field label="Invoice Description" htmlFor="job-c-invoice_description" hint="The service line on the invoice, e.g. IT Development. Blank = the scope above.">
                <input id="job-c-invoice_description" className="form-input" style={BOX} value={d.contractor?.invoice_description || ''} onChange={ev => setC('invoice_description', ev.target.value)} placeholder="e.g. IT Development" />
              </Field>
            </div>
          ) : (
            <div>
              <Row icon={FileText} label="Scope / Role" value={c.scope} />
              <Row icon={FileText} label="SOW Reference" value={c.sow_ref} />
              <Row icon={Briefcase} label="Billing Client" value={c.billing_client} />
              <Row icon={CalendarOff} label="Contract Start" value={formatDate(c.contract_start)} />
              <Row icon={CalendarOff} label="Contract End" value={formatDate(c.contract_end)} />
              {canSeePay && <Row icon={FileText} label="Rate" value={[c.rate, c.currency, RATE_TYPES.find(([v]) => v === c.rate_type)?.[1]].filter(Boolean).join(' ')} />}
              <Row icon={FileText} label="Engagement Area" value={c.engagement_area} />
              <Row icon={FileText} label="Next Invoice Number" value={c.invoice_next_number ? String(c.invoice_next_number) : ''} />
              <Row icon={FileText} label="Invoice Description" value={c.invoice_description} />
            </div>
          )}
        </>
      )}

      {t.editing && <TabSaveRow t={t} note="Saves the job details. Status changes through Change Status." />}

      {!isRemoved && (
        <div style={{ marginTop: 18 }}>
          <ProbationCard employee={e} focus={focusProbation} toastOk={toastOk} toastErr={toastErr}
            onChanged={() => onReload?.()} onOffboard={onOffboard} />
        </div>
      )}

      <RoleHistory employeeId={e.id} refreshKey={roleHistoryKey} />
    </div>
  );
}
