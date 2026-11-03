import { useMemo, useState, lazy, Suspense } from 'react';
import {
  Mail, Phone, MapPin, MapPinned, Building2, Globe2, FileText, Users, Lock, Heart, CalendarDays,
  Contact, Hash, UserCog, ListPlus, AlertTriangle, CheckCircle, RefreshCw,
} from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { COUNTRIES, countryName } from '../lib/countries';
import { DateField } from '../tasks/components';
import { Spinner } from '../components/AsyncState';
import { EmployeeMoreDetails } from '../components/EmployeeCustomFields';
import { useTabDraft } from './useTabDraft';
import { Row, SectionHead, Field, EditButton, TabSaveRow } from './shared';
import { BOX, DATE_BOX, GRID, maskId, changedKeys } from './lib';

// A person's Performance on their profile (Oct 29 2026) - their numbers, goals and reviews.
const PersonPerformanceSection = lazy(() => import('../performance/PersonPerformanceSection'));

const ACCOUNT_TYPES = [['internal', 'Internal (Microsoft 365 Staff)'], ['guest', 'Guest (Entra B2B Partner)'], ['external', 'External (No Microsoft 365 Login)']];
const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];

// Overview (11/03/2026): the profile, Office & Contact (kept in step with
// Microsoft 365 both ways - Neil, 10/07), Personal Details and, last, More
// Details (HR's own fields - Oct 27 2026, their own HR Only rules and save).
// Edit turns the first three on in place; one Save row saves them together.
function seedOf(e) {
  const p0 = e.personal || {};
  return {
    first_name: e.firstName || '', last_name: e.lastName || '',
    work_email: e.workEmail || '', personal_email: e.personalEmail || '',
    employee_code: e.employeeCode || '', identity_type: e.identityType || 'internal', notes: e.notes || '',
    location: e.location || '', phone: e.phone || '', office_phone: e.officePhone || '',
    street_address: e.streetAddress || '', city: e.city || '', state: e.state || '',
    postal_code: e.postalCode || '', country: e.country || '',
    // Everything else in the personal record (preferred name, a hire
    // packet's details) is kept as it was - the save replaces the whole record.
    personal: {
      ...p0,
      dob: p0.dob || '', gender: p0.gender || '', nationalId: p0.nationalId || '',
      currentAddress: p0.currentAddress || '', permanentAddress: p0.permanentAddress || '',
      emergency: { name: '', relationship: '', phone: '', email: '', ...(p0.emergency || {}) },
    },
  };
}

export default function OverviewTab({ e, employees = [], canEdit = false, canSync = false, readOnlyCustom = true, isRemoved = false, onSaved, toastOk, toastErr }) {
  const saved = useMemo(() => seedOf(e), [e]);
  const t = useTabDraft(saved, {
    label: 'Overview',
    onSave: async (draft) => {
      if (!draft.first_name.trim()) { toastErr('A first name is needed.'); return false; }
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
  const setP = (k, v) => t.patch({ personal: { ...d.personal, [k]: v } });
  const setEm = (k, v) => t.patch({ personal: { ...d.personal, emergency: { ...d.personal.emergency, [k]: v } } });
  const input = (label, key, props = {}) => (
    <Field label={label} htmlFor={`ov-${key}`}>
      <input id={`ov-${key}`} className="form-input" style={BOX} value={d[key]} onChange={set(key)} {...props} />
    </Field>
  );
  const pInput = (label, key, props = {}) => (
    <Field label={label} htmlFor={`ov-p-${key}`}>
      <input id={`ov-p-${key}`} className="form-input" style={BOX} value={d.personal[key]} onChange={ev => setP(key, ev.target.value)} {...props} />
    </Field>
  );
  const emInput = (label, key, props = {}) => (
    <Field label={label} htmlFor={`ov-em-${key}`}>
      <input id={`ov-em-${key}`} className="form-input" style={BOX} value={d.personal.emergency[key]} onChange={ev => setEm(key, ev.target.value)} {...props} />
    </Field>
  );
  const offices = useMemo(() => [...new Set(employees.map(x => (x.location || '').trim()).filter(Boolean))].sort(), [employees]);
  const address = [e.streetAddress, [e.city, [e.state, e.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  const p = e.personal || {};
  const em = p.emergency || {};

  return (
    <div>
      {!isRemoved && e.work_email && (
        <Suspense fallback={null}>
          <PersonPerformanceSection email={e.work_email} name={[e.first_name, e.last_name].filter(Boolean).join(' ')} toastOk={toastOk} toastErr={toastErr} />
        </Suspense>
      )}

      <SectionHead icon={Contact} title="Profile" first>
        {canEdit && !t.editing && <EditButton onClick={t.startEdit} />}
      </SectionHead>
      {t.editing ? (
        <div style={GRID}>
          {input('First Name', 'first_name', { autoFocus: true })}
          {input('Last Name', 'last_name')}
          {input('Work Email', 'work_email', { type: 'email', placeholder: 'empty until provisioned' })}
          {input('Personal Email', 'personal_email', { type: 'email' })}
          {/* Editable so Nexus codes can line up with the QuickBooks employee codes payroll already uses (Charmi, Aug 21). */}
          {input('Employee Code', 'employee_code', { placeholder: 'e.g. GG-001 or the QuickBooks code' })}
          <Field label="Account Type" htmlFor="ov-identity_type" hint="External and guest people can be kept to specific companies on the Access tab.">
            <select id="ov-identity_type" className="form-input" style={BOX} value={d.identity_type} onChange={set('identity_type')}>
              {ACCOUNT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Notes" htmlFor="ov-notes" wide>
            <textarea id="ov-notes" className="form-input" rows={2} style={{ ...BOX, resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
              value={d.notes} onChange={set('notes')} />
          </Field>
        </div>
      ) : (
        <div>
          <Row icon={Mail} label="Work Email" value={e.workEmail} />
          <Row icon={Mail} label="Personal Email" value={e.personalEmail} />
          <Row icon={Hash} label="Employee Code" value={e.employeeCode} />
          {e.identityType && e.identityType !== 'internal' && <Row icon={UserCog} label="Account Type" value={ACCOUNT_TYPES.find(([v]) => v === e.identityType)?.[1]} />}
          {e.notes && <Row icon={FileText} label="Notes" value={e.notes} />}
        </div>
      )}

      <OfficeContactHead e={e} canSync={canSync && !t.editing} onSynced={onSaved} toastOk={toastOk} toastErr={toastErr} />
      {t.editing ? (
        <div style={GRID}>
          <Field label="Office" htmlFor="ov-location">
            <input id="ov-location" className="form-input" style={BOX} value={d.location} onChange={set('location')} placeholder="e.g. San Clemente" list="ov-office-options" />
            <datalist id="ov-office-options">{offices.map(o => <option key={o} value={o} />)}</datalist>
          </Field>
          {input('Mobile Phone', 'phone', { type: 'tel' })}
          {input('Office Phone', 'office_phone', { type: 'tel' })}
          <Field label="Street Address" htmlFor="ov-street_address" wide>
            <input id="ov-street_address" className="form-input" style={BOX} value={d.street_address} onChange={set('street_address')} placeholder="Work address - shown in Outlook and Teams" />
          </Field>
          {input('City', 'city')}
          {input('State or Province', 'state')}
          {input('ZIP or Postal Code', 'postal_code')}
          <Field label="Country or Region" htmlFor="ov-country" hint="Where this person actually is - also drives their email signature's phone country code.">
            <select id="ov-country" className="form-input" style={BOX} value={d.country} onChange={set('country')}>
              <option value="">-</option>
              {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
            </select>
          </Field>
        </div>
      ) : (
        <div>
          <Row icon={MapPin} label="Office" value={e.location} />
          <Row icon={Phone} label="Mobile Phone" value={e.phone} />
          <Row icon={Phone} label="Office Phone" value={e.officePhone} />
          <Row icon={MapPinned} label="Street Address" value={address} />
          {e.country && <Row icon={Globe2} label="Country or Region" value={countryName(e.country)} />}
        </div>
      )}

      <SectionHead icon={Contact} title="Personal Details" />
      {t.editing ? (
        <div style={GRID}>
          <Field label="Date of Birth">
            <DateField value={d.personal.dob} onChange={v => setP('dob', v || '')} title="Date of Birth" placeholder="Pick a date" style={DATE_BOX} />
          </Field>
          <Field label="Gender" htmlFor="ov-p-gender">
            <select id="ov-p-gender" className="form-input" style={BOX} value={d.personal.gender} onChange={ev => setP('gender', ev.target.value)}>
              <option value="">-</option>
              {GENDERS.map(g => <option key={g}>{g}</option>)}
            </select>
          </Field>
          {pInput('National ID / SSN / Aadhaar', 'nationalId', { placeholder: 'stored securely, shown masked' })}
          <Field label="Current Address" htmlFor="ov-p-currentAddress" wide>
            <textarea id="ov-p-currentAddress" className="form-input" rows={2} style={{ ...BOX, resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={d.personal.currentAddress} onChange={ev => setP('currentAddress', ev.target.value)} />
          </Field>
          <Field label="Permanent Address" htmlFor="ov-p-permanentAddress" wide>
            <textarea id="ov-p-permanentAddress" className="form-input" rows={2} style={{ ...BOX, resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }} value={d.personal.permanentAddress} onChange={ev => setP('permanentAddress', ev.target.value)} />
          </Field>
          {emInput('Emergency Contact Name', 'name')}
          {emInput('Relationship', 'relationship', { placeholder: 'e.g. spouse' })}
          {emInput('Emergency Phone', 'phone', { type: 'tel' })}
          {emInput('Emergency Email', 'email', { type: 'email' })}
        </div>
      ) : (
        <div>
          <Row icon={CalendarDays} label="Date of Birth" value={formatDate(p.dob)} />
          <Row icon={Users} label="Gender" value={p.gender} />
          <Row icon={Lock} label="National ID" value={p.nationalId ? maskId(p.nationalId) : ''} />
          {/* The whole personal record reads on the main screen, addresses included (Neil, Oct 12). */}
          <Row icon={MapPinned} label="Current Address" value={p.currentAddress} />
          <Row icon={MapPinned} label="Permanent Address" value={p.permanentAddress} />
          <Row icon={Heart} label="Emergency Contact" value={em.name ? [em.name, em.relationship && `(${em.relationship})`, em.phone, em.email].filter(Boolean).join(' · ') : ''} />
        </div>
      )}

      {t.editing && (
        <TabSaveRow t={t} saveDisabled={!d.first_name.trim()} note="Saves Profile, Office & Contact and Personal Details." />
      )}

      <SectionHead icon={ListPlus} title="More Details" />
      <EmployeeMoreDetails employee={e} readOnly={readOnlyCustom} toastOk={toastOk} toastErr={toastErr} />
    </div>
  );
}

// Office and contact info as Microsoft 365 has it - kept in step both ways
// (Neil, 10/07, m365_profile_sync.py): edits here go to Microsoft 365 on save,
// edits made there come back within 15 minutes, or now with Sync Now.
function OfficeContactHead({ e, canSync, onSynced, toastOk, toastErr }) {
  const [busy, setBusy] = useState(false);
  const linked = !!e.m365Id;
  const sync = e.m365Sync || {};
  async function syncNow() {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.syncEmployeeM365(e.id);
      onSynced?.(updated);
      const r = updated?.m365Result || {};
      const label = (k) => ({ phone: 'mobile phone', office_phone: 'office phone', location: 'office', street_address: 'street address',
        city: 'city', state: 'state', postal_code: 'ZIP', country: 'country', job_title: 'job title', department: 'department' }[k] || k);
      if (r.error) toastErr(`Microsoft 365 did not take the change: ${r.error}`);
      else if (r.pulled?.length || r.pushed?.length) {
        toastOk([r.pulled?.length ? `Updated from Microsoft 365: ${r.pulled.map(label).join(', ')}.` : '',
          r.pushed?.length ? `Sent to Microsoft 365: ${r.pushed.length} field${r.pushed.length === 1 ? '' : 's'}.` : ''].filter(Boolean).join(' '));
      } else if (r.waiting?.length && !r.writesEnabled) toastOk('Up to date from Microsoft 365. This environment does not write to Microsoft 365 - production does.');
      else toastOk('Already in step with Microsoft 365.');
    } catch (err) { toastErr(err?.message || 'Could not reach Microsoft 365.'); }
    setBusy(false);
  }
  return (
    <SectionHead icon={Building2} title="Office & Contact">
      {linked && (
        <span title={sync.error ? `Last attempt failed: ${sync.error}` : 'Kept in step with Microsoft 365 both ways'}
          style={{ fontSize: 11.5, color: sync.error ? '#b45309' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {sync.error ? <AlertTriangle size={12} /> : <CheckCircle size={12} style={{ color: 'hsl(var(--color-green))' }} />}
          {sync.error ? 'Microsoft 365 sync needs attention' : sync.at ? `Synced with Microsoft 365 ${formatDateTime(sync.at)}` : 'Synced with Microsoft 365'}
        </span>
      )}
      {linked && canSync && (
        <button type="button" className="secondary-btn" onClick={syncNow} disabled={busy}
          title="Bring this person's details in step with Microsoft 365 now"
          style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
          {busy ? <Spinner size={12} /> : <RefreshCw size={12} />} Sync Now
        </button>
      )}
    </SectionHead>
  );
}
