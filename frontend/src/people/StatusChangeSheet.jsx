// Change Status (HR Section B6) - a sheet from the right (the shared Modal).
//
// One way to leave (Neil, 11/03/2026): this sheet never makes anyone Left.
// Onboarding, Active and Inactive change here, with a reason and an
// effective date kept in the audit trail; leaving is Offboard
// (components/HrPersonActions.jsx OffboardModal), which records the
// termination date and runs every leaver step once. The server refuses
// 'offboarded' on POST /hr/employees/{id}/status for the same reason.
//
// Going Inactive can grant a colleague access to the mailbox while they are
// away (Exchange PowerShell - Graph has no coverage), export the mailbox
// first, and start the leave checklist.
import { useEffect, useState } from 'react';
import { CheckCircle, ChevronRight, FileText, Mail, X, LogOut } from 'lucide-react';
import { api } from '../api';
import { Spinner } from '../components/AsyncState';
import { Modal, DateField, PersonSelect } from '../tasks/components';
import { formatDate } from '../lib/datetime';

const EXO_MAILBOXES = 'https://admin.exchange.microsoft.com/#/mailboxes';
const PURVIEW_EXPORT = 'https://compliance.microsoft.com/contentsearchv2';

// The statuses this sheet sets. Left is Offboard's alone.
const SHEET_STATUSES = [['onboarding', 'Onboarding'], ['active', 'Active'], ['inactive', 'Inactive']];
const LABEL = { onboarding: 'Onboarding', active: 'Active', inactive: 'Inactive', offboarded: 'Left', staged: 'Staged' };

const lbl = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 };
const fullName = (e) => [e?.firstName, e?.lastName].filter(Boolean).join(' ');
const pickRows = (list) => {
  const seen = new Set();
  return list.filter((e) => {
    const em = (e.workEmail || '').toLowerCase();
    if (!em || seen.has(em)) return false;
    seen.add(em);
    return true;
  }).map((e) => ({ email: e.workEmail.toLowerCase(), name: fullName(e) }));
};

export default function StatusChangeSheet({ employee, employees = [], onClose, onSaved, onOffboard, toastOk, toastErr }) {
  const current = employee.status || 'active';
  const [status, setStatus] = useState(SHEET_STATUSES.some(([v]) => v === current) ? current : '');
  const [reason, setReason] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  // null = still loading the person's checklists; then { kind: true } for open ones.
  const [openKinds, setOpenKinds] = useState(null);
  const [startChecklistToo, setStartChecklistToo] = useState(true);
  useEffect(() => {
    api.getEmployeeChecklists(employee.id)
      .then((r) => setOpenKinds(Object.fromEntries((r.checklists || []).filter((c) => c.status === 'open').map((c) => [c.kind, true]))))
      .catch(() => setOpenKinds({}));
  }, [employee.id]);
  const [exportRequested, setExportRequested] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = !!status && status !== current;
  const isInactive = status === 'inactive';
  const offerChecklist = changed && isInactive && openKinds !== null && !openKinds.inactive;
  const colleagues = employees.filter((x) => x.workEmail && x.id !== employee.id);
  const manager = employees.find((x) => (x.workEmail || '').toLowerCase() === (employee.managerEmail || '').toLowerCase());
  const [trustees, setTrustees] = useState(() => (manager?.workEmail ? [manager.workEmail.toLowerCase()] : []));
  const addTrustee = () => { if (pick && !trustees.includes(pick)) setTrustees((t) => [...t, pick]); setPick(''); };
  const nameFor = (em) => { const c = employees.find((x) => (x.workEmail || '').toLowerCase() === em); return c ? fullName(c) : em; };
  // Someone already Inactive can re-run the mailbox step (e.g. a delegation
  // that did not take the first time) without changing their status.
  const canApply = changed || (isInactive && (trustees.length > 0 || exportRequested));

  const upn = employee.workEmail || '<user-upn>';
  const psScript = isInactive && trustees.length
    ? ['Connect-ExchangeOnline', ...trustees.map((t) => `Add-MailboxPermission -Identity ${upn} -User ${t} -AccessRights FullAccess -AutoMapping $true`)].join('\n')
    : '';
  const copyPs = () => navigator.clipboard?.writeText(psScript)
    .then(() => toastOk('PowerShell copied to clipboard.'))
    .catch(() => toastErr('Copy failed - select the text and copy manually.'));

  async function save() {
    if (busy || !canApply) return;
    if (isInactive && trustees.length === 0 && !exportRequested && !changed) { toastErr('Pick who should get mailbox access.'); return; }
    setBusy(true);
    try {
      const offboarding = isInactive
        ? { mailboxAction: trustees.length ? 'delegate' : '', delegateTo: trustees, exportRequested, freeUpLicense: false, handoverTo: '', handoverIncludeCompleted: false }
        : null;
      const saved = await api.changeEmployeeStatus(employee.id, { status, reason, effectiveDate, offboarding });
      if (offerChecklist && startChecklistToo) {
        const d = new Date();
        const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        try {
          const cl = await api.startChecklist(employee.id, { kind: 'inactive', anchor_date: effectiveDate || todayIso, exit_type: '' });
          toastOk(`${cl.kindLabel} checklist started - ${cl.total - cl.done} steps, ${cl.overdue} already due. Open the Checklist tab to work through them.`);
        } catch (err) { toastErr(`Status saved, but the checklist did not start: ${err?.message || 'unknown error'}`); }
      }
      onSaved(saved);
      const m = saved.m365;
      const bits = [];
      if (m?.signIn) bits.push(`sign-in ${m.signIn}`);
      if (m?.export) bits.push('mailbox export started - download it from the Documents tab once it is ready');
      if (m?.error) bits.push(`M365 issue: ${m.error}`);
      const auto = bits.length ? ` · ${bits.join(', ')}` : '';
      const manual = psScript ? ' Run the PowerShell to finish mailbox access.' : '';
      toastOk(`Status set to ${LABEL[status] || status}.${auto}${manual}`);
      onClose();
    } catch (e) { toastErr(e?.message || 'Could not change status.'); setBusy(false); }
  }

  return (
    <Modal title={`Change Status - ${fullName(employee)}`} onClose={onClose} zIndex={4100}
      isDirty={(changed || !!reason.trim()) && !busy}
      footer={<>
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary-btn" onClick={save} disabled={busy || !canApply}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (busy || !canApply) ? 0.6 : 1 }}>
          {busy ? <Spinner size={14} /> : <CheckCircle size={14} />} Apply
        </button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, fontFamily: 'Inter,sans-serif' }}>
        <div>
          <label style={lbl} htmlFor="status-new">New Status</label>
          <select id="status-new" className="form-input" style={{ width: '100%' }} value={status} onChange={(e) => setStatus(e.target.value)}>
            {!status && <option value="">{LABEL[current] || current} - pick a new status</option>}
            {SHEET_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {/* Leaving is never a status pick (Neil, 11/03/2026). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
            <LogOut size={13} style={{ flexShrink: 0 }} />
            <span>Leaving the company is Offboard - it records the termination date and returns their equipment, hands over their tasks and closes their accounts.</span>
            {onOffboard && current !== 'offboarded' && (
              <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => { onClose(); onOffboard(); }}>
                Offboard Instead
              </button>
            )}
          </div>
        </div>
        <div>
          <label style={lbl}>Effective Date</label>
          <DateField value={effectiveDate} onChange={(v) => setEffectiveDate(v || '')} placeholder="MM/DD/YYYY" title="Effective date" style={{ width: '100%' }} />
        </div>
        <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={lbl} htmlFor="status-reason">Reason</label>
          <textarea id="status-reason" className="form-input" rows={3} style={{ width: '100%', flex: 1, resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
            value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the change (kept in the audit trail)" />
        </div>

        {offerChecklist && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <input type="checkbox" checked={startChecklistToo} onChange={(e) => setStartChecklistToo(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--pine)' }} />
            <span>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>Also Start the Leave or Suspension Checklist</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>
                Lists who blocks access, covers the inbox and re-routes approvals while {employee.firstName || 'they'} are away.
              </span>
            </span>
          </label>
        )}

        {isInactive && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}><Mail size={14} /> Mailbox While They Are Away</div>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>Grant a colleague access to {employee.firstName || 'their'}&apos;s mailbox while they are inactive.</p>
            {manager && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Defaulted to their manager <b>{fullName(manager)}</b> from the org chart - add or remove below.</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
              {trustees.map((t) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, borderBottom: '1px solid var(--line)', paddingBottom: 2 }}>
                  {nameFor(t)}
                  <button type="button" aria-label={`Remove ${nameFor(t)}`} onClick={() => setTrustees((x) => x.filter((y) => y !== t))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={12} /></button>
                </span>
              ))}
              {trustees.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No one selected yet.</span>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <PersonSelect value={pick || null} onChange={(v) => setPick(v || '')}
                  people={pickRows(colleagues.filter((c) => !trustees.includes((c.workEmail || '').toLowerCase())))}
                  placeholder="Add a colleague" allowNone={false} ariaLabel="Add a Colleague"
                  style={{ height: 38, padding: '0 13px', borderRadius: 10, fontSize: 13.5, fontWeight: 400 }} />
              </div>
              <button type="button" className="secondary-btn" onClick={addTrustee} disabled={!pick} style={{ padding: '6px 12px' }}>Add</button>
            </div>
            {psScript && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Run in Exchange PowerShell
                  <button type="button" className="secondary-btn" onClick={copyPs} style={{ padding: '2px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileText size={11} /> Copy</button>
                </div>
                <pre style={{ margin: 0, background: '#1e293b', color: '#e5e7eb', borderRadius: 8, padding: '10px 12px', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' }}>{psScript}</pre>
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={exportRequested} onChange={(e) => setExportRequested(e.target.checked)} style={{ width: 16, height: 16 }} />
              Export their mailbox to a ZIP first
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <a href={EXO_MAILBOXES} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>Mailbox Access <ChevronRight size={12} /></a>
              {exportRequested && <a href={PURVIEW_EXPORT} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={{ fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px' }}>Export Mailbox <ChevronRight size={12} /></a>}
            </div>
          </div>
        )}

        {employee.statusLog?.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Recent Changes</div>
            {employee.statusLog.slice(0, 4).map((h, i) => (
              <div key={i} style={{ fontSize: 12.5, color: 'var(--muted)', padding: '3px 0' }}>
                {LABEL[h.from] || h.from} to {LABEL[h.to] || h.to} · {formatDate(h.effectiveDate || (h.at || '').slice(0, 10))}{h.reason ? ` · ${h.reason}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
