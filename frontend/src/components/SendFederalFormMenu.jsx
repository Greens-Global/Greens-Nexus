// "Send Federal Form" on a person's Documents tab (Neil, 11/02/2026). HR++ -
// administrators and a Full People grant that is not team-limited - sends
// one form to one employee: Form W-4, Form I-9 or the Direct Deposit
// Authorization, through POST /hr/employees/{id}/federal-forms/send. The
// menu says the edition Nexus holds (GET /hr/federal-forms/status, with the
// code's own labels until it answers); an expired edition is disabled with
// the server's sentence, and the server refuses it too. Contractors and
// externals never see it - the W-9 stays the contractor path.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileSignature } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import AnchoredMenu from './AnchoredMenu';
import { Spinner } from './AsyncState';
import { FEDERAL_FORMS, federalFormLabel } from '../lib/federalForms';

export default function SendFederalFormMenu({ employee, toastOk, toastErr, onSent }) {
  const role = useRole();
  const hrPlus = !!role && (!!role.can?.('administrator') || (role.myGrantedModules?.get?.('hr') === 'full' && !role.hrTeam));
  const isEmployee = !!employee && (employee.employmentType || 'employee') !== 'contractor' && !employee.isExternal && !employee.externalKind;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const btnRef = useRef(null);
  useEffect(() => {
    if (!open || status) return undefined;
    let live = true;
    api.federalFormsStatus()
      .then(r => { if (live) setStatus(Array.isArray(r?.forms) ? r.forms : []); })
      .catch(() => { if (live) setStatus([]); });
    return () => { live = false; };
  }, [open, status]);
  if (!hrPlus || !isEmployee) return null;

  const name = [employee.firstName, employee.lastName].filter(Boolean).join(' ') || employee.name || 'them';
  const rows = FEDERAL_FORMS.map(f => ({ ...f, ...((status || []).find(s => s.kind === f.kind) || {}) }));

  async function send(f) {
    if (busy) return;
    setBusy(f.kind);
    try {
      const r = await api.sendFederalForm(employee.id, f.kind);
      toastOk?.(`${f.title} sent to ${name} to sign.`);
      setOpen(false);
      onSent?.(r);
    } catch (e) {
      toastErr?.(e?.message || `Could not send ${f.title}.`);
    }
    setBusy('');
  }

  return (
    <>
      <button ref={btnRef} type="button" className="secondary-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
        <FileSignature size={12} aria-hidden="true" /> Send Federal Form <ChevronDown size={12} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="end" minWidth={320}
        style={{ padding: 6, fontFamily: 'Inter,sans-serif' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 10px 4px' }}>Goes out in Nexus Sign; the signed form files to {name}'s folder.</div>
        {rows.map(f => {
          const expired = f.state === 'expired';
          const sub = expired || f.state === 'expiring' ? f.message : f.hint;
          return (
            <button key={f.kind} type="button" role="menuitem" disabled={expired || !!busy} onClick={() => send(f)}
              aria-label={federalFormLabel(f)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '8px 10px',
                cursor: expired ? 'not-allowed' : 'pointer', opacity: expired ? 0.6 : 1, fontFamily: 'inherit', color: 'var(--ink)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
                {federalFormLabel(f)}
                {busy === f.kind && <Spinner size={12} />}
                {expired && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#b91c1c' }}>Expired</span>}
              </span>
              {sub && <span style={{ display: 'block', fontSize: 11.5, color: expired ? '#b91c1c' : 'var(--muted)', marginTop: 2, lineHeight: 1.4, whiteSpace: 'normal' }}>{sub}</span>}
            </button>
          );
        })}
      </AnchoredMenu>
    </>
  );
}
