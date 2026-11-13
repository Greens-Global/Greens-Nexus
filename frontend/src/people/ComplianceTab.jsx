import { useMemo } from 'react';
import { ShieldCheck, FileText, CalendarDays, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { DateField } from '../tasks/components';
import { PaperworkStatus } from '../components/HiringPacket';
import { useTabDraft } from './useTabDraft';
import { Row, SectionHead, Field, EditButton, TabSaveRow } from './shared';
import { BOX, DATE_BOX, GRID, HINT, maskId, daysUntil, changedKeys } from './lib';

// ── Right-to-work & compliance (HR Section B - open to HR) ───────────────────
// Edited in place (11/03/2026). The only editable home of the PAN (India):
// Pay & Benefits shows it read only and points here.
const WORK_AUTH = [['citizen', 'Citizen'], ['permanent_resident', 'Permanent Resident'], ['work_visa', 'Work Visa'], ['permit', 'Work Permit'], ['other', 'Other']];
const DOC_TYPES = [['passport', 'Passport'], ['national_id', 'National ID'], ['visa', 'Visa'], ['work_permit', 'Work Permit'], ['other', 'Other']];
const VERIFY_STATUS = { unverified: { label: 'Unverified', fg: 'var(--muted)' }, verified: { label: 'Verified', fg: 'hsl(var(--color-green))' }, rejected: { label: 'Rejected', fg: 'hsl(var(--color-red))' } };
const CONSENTS = [['bgCheck', 'Background check consent'], ['dataProcessing', 'Data processing consent'], ['handbook', 'Handbook acknowledgment']];
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function seedOf(e) {
  const c0 = e.compliance || {};
  return {
    ...c0,
    pan: c0.pan || '',
    workAuth: c0.workAuth || '', docType: c0.docType || 'passport', docNumber: c0.docNumber || '',
    issueDate: c0.issueDate || '', expiryDate: c0.expiryDate || '', status: c0.status || 'unverified',
    consents: { bgCheck: false, dataProcessing: false, handbook: false, ...(c0.consents || {}) },
  };
}

export default function ComplianceTab({ e, canEdit = false, paperworkKey, onSaved, toastErr }) {
  const saved = useMemo(() => seedOf(e), [e]);
  const t = useTabDraft(saved, {
    label: 'Compliance',
    onSave: async (draft) => {
      if (draft.pan && !PAN_RE.test(draft.pan)) return false;
      try {
        const body = changedKeys(saved, draft);   // only what changed; the server merges it
        if (!Object.keys(body).length) return true;
        const out = await api.updateEmployee(e.id, { compliance: body });
        onSaved?.(out);
        return true;
      } catch (err) { toastErr(err?.message || 'Could not save.'); return false; }
    },
  });
  const c = t.draft || saved;
  const set = (k, v) => t.patch({ [k]: v });
  const panBad = !!c.pan && !PAN_RE.test(c.pan);
  // India only (Neil, 11/12/2026): a PAN means nothing for a US person; one already saved still shows.
  const india = e.workCountry === 'IN' || !!(e.compliance || {}).pan;
  const cur = e.compliance || {};
  const vs = VERIFY_STATUS[cur.status || 'unverified'] || VERIFY_STATUS.unverified;

  return (
    <div>
      <SectionHead icon={ShieldCheck} title="Right to Work & Compliance" first>
        {canEdit && !t.editing && <EditButton onClick={t.startEdit} />}
      </SectionHead>
      {/* The hiring packet (Oct 14) - one place to see it, kept up to date by itself. */}
      <PaperworkStatus employeeId={e.id} refreshKey={paperworkKey} />
      {t.editing ? (
        <>
          <div style={GRID}>
            <Field label="Work Authorization" htmlFor="cmp-workAuth">
              <select id="cmp-workAuth" className="form-input" style={BOX} value={c.workAuth} onChange={ev => set('workAuth', ev.target.value)}>
                <option value="">-</option>
                {WORK_AUTH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Document Type" htmlFor="cmp-docType">
              <select id="cmp-docType" className="form-input" style={BOX} value={c.docType} onChange={ev => set('docType', ev.target.value)}>
                {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Document Number" htmlFor="cmp-docNumber">
              <input id="cmp-docNumber" className="form-input" style={BOX} value={c.docNumber} onChange={ev => set('docNumber', ev.target.value)} />
            </Field>
            <Field label="Issue Date">
              <DateField value={c.issueDate} onChange={v => set('issueDate', v || '')} title="Issue Date" placeholder="Pick a date" style={DATE_BOX} />
            </Field>
            <Field label="Expiry Date">
              <DateField value={c.expiryDate} onChange={v => set('expiryDate', v || '')} title="Expiry Date" placeholder="Pick a date" style={DATE_BOX} />
            </Field>
            <Field label="Verification Status" htmlFor="cmp-status">
              <select id="cmp-status" className="form-input" style={BOX} value={c.status} onChange={ev => set('status', ev.target.value)}>
                {Object.entries(VERIFY_STATUS).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
              </select>
            </Field>
            {india && (
            <Field label="PAN (India)" htmlFor="compliance-pan">
              <input id="compliance-pan" className="form-input" style={{ ...BOX, borderColor: panBad ? 'hsl(var(--color-red))' : undefined }} value={c.pan} maxLength={10}
                onChange={ev => set('pan', ev.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="ABCDE1234F" aria-invalid={panBad} />
              <div style={{ ...HINT, color: panBad ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                {panBad ? 'PAN is 5 letters, 4 digits and a letter, e.g. ABCDE1234F.' : "Printed on the person's invoices when they are a contractor."}
              </div>
            </Field>
            )}
          </div>
          <div style={HINT}>Upload the passport or visa scan on the Documents tab (private, signed-link access).</div>
        </>
      ) : (
        <div>
          <Row icon={ShieldCheck} label="Work Authorization" value={cur.workAuth ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {WORK_AUTH.find(([v]) => v === cur.workAuth)?.[1] || cur.workAuth}
              <span style={{ fontSize: 12, fontWeight: 600, color: vs.fg }}>{vs.label}</span>
            </span>
          ) : ''} />
          <Row icon={FileText} label="Document" value={[DOC_TYPES.find(([v]) => v === cur.docType)?.[1], cur.docNumber].filter(Boolean).join(' · ')} />
          <Row icon={CalendarDays} label="Issued" value={formatDate(cur.issueDate, cur.issueDate || '')} />
          {india && <Row icon={FileText} label="PAN (India)" value={cur.pan ? maskId(cur.pan) : ''} />}
          {(() => {
            if (!cur.expiryDate) return <Row icon={CalendarDays} label="Doc Expiry" value="" />;
            const dd = daysUntil(cur.expiryDate); const warn = dd !== null && dd <= 60;
            return <Row icon={warn ? AlertTriangle : CalendarDays} label="Doc Expiry" value={(
              <span style={{ color: warn ? (dd < 0 ? 'hsl(var(--color-red))' : 'hsl(var(--color-orange))') : 'inherit', fontWeight: warn ? 700 : 400 }}>
                {formatDate(cur.expiryDate, cur.expiryDate)}{dd !== null && (dd < 0 ? ' · expired' : ` · in ${dd}d`)}
              </span>
            )} />;
          })()}
        </div>
      )}

      <SectionHead title="Consents" />
      {CONSENTS.map(([k, label]) => (t.editing ? (
        <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!c.consents[k]} onChange={ev => set('consents', { ...c.consents, [k]: ev.target.checked })} style={{ width: 16, height: 16 }} />
          {label}
        </label>
      ) : (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 }}>
          {cur.consents?.[k] ? <CheckCircle size={15} style={{ color: 'hsl(var(--color-green))' }} /> : <XCircle size={15} style={{ color: 'var(--muted)' }} />}
          <span style={{ color: cur.consents?.[k] ? 'var(--ink)' : 'var(--muted)' }}>{label}</span>
        </div>
      )))}

      {t.editing && <TabSaveRow t={t} saveDisabled={panBad} />}
    </div>
  );
}
