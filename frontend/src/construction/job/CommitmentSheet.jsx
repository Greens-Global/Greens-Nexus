// A commitment on the Money tab (Round Two item 8, Neil, 11/06/2026): a
// subcontract or purchase order with one of Intacct's vendors, its signed
// copy, and the lien waivers received against it. Billed to Date is the
// books' (routers/construction_money.py) - nothing here types a payment.
// A new amount asks why (kept with before and after on the job's activity).
// Waivers are the vendor's own signed (state) form, attached as received -
// Nexus never writes waiver wording.
import { useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { api } from '../../api';
import { Modal, DateField } from '../../tasks/components';
import { SettingRow, SettingCard, NumberBox } from '../../components/settings/SettingsUI';
import SaveRow from '../../components/SaveRow';
import { ErrorBanner } from '../../components/AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { useDraft } from '../../lib/useDraft';
import { formatDate } from '../../lib/datetime';
import { filesFromPaste, uploadJobDocument } from '../lib/upload';
import { usd, WAIVER_KIND } from '../lib/money';
import { VendorPicker } from './SubsTab';

const quiet = { fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 };
const KINDS = { subcontract: 'Subcontract', purchase_order: 'Purchase Order' };
const STATUSES = { active: 'Active', closed: 'Closed', void: 'Void' };

/** Attach one PDF or photo of a page - pick, drop, or Ctrl+V. */
function FileAttach({ projectId, url, name, onChange, label }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const take = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    const out = await uploadJobDocument(file, { projectId });
    setBusy(false);
    if (out.error) setError(out.error); else onChange({ url: out.url, name: out.name });
  };
  return (
    <div onPaste={(e) => { const f = filesFromPaste(e)[0]; if (f) { e.preventDefault(); take(f); } }}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files?.[0]); }}
      tabIndex={0} aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {url && <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>{name || 'Open File'}</a>}
        <label className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem', cursor: 'pointer', margin: 0 }}>
          <Paperclip size={13} />{busy ? 'Attaching…' : url ? 'Replace' : 'Attach'}
          <input type="file" accept="application/pdf,image/*" hidden disabled={busy} onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {url && <button type="button" className="secondary-btn" style={{ padding: '6px 10px', fontSize: '0.8rem' }} onClick={() => onChange({ url: '', name: '' })}>Clear</button>}
      </div>
      <span style={{ ...quiet, fontSize: '0.74rem' }}>A PDF or a photo of the page - or press Ctrl+V to paste one.</span>
      {error && <span role="alert" style={{ fontSize: '0.78rem', color: 'hsl(var(--color-red))' }}>{error}</span>}
    </div>
  );
}

// The cost code (Round Three, 11/11/2026): an Intacct item, the same code the
// job's cost lines carry, so Committed sits beside Actual per code. The list
// is the server's (the job's own codes first); typing one not listed is fine.
function CostCodeRow({ projectId, value, onChange }) {
  const [codes, setCodes] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getJobCostCodes(projectId))
      .then((d) => { if (live) setCodes(d?.codes || []); })
      .catch(() => { if (live) setCodes([]); });
    return () => { live = false; };
  }, [projectId]);
  return (
    <SettingRow title="Cost Code" htmlFor="cm-code" desc="The Intacct item its costs post to. Left empty, it counts under No Cost Code."
      control={(
        <span>
          <input id="cm-code" aria-label="Cost Code" className="form-input" list="cm-code-list" style={{ width: 'min(240px, 52vw)' }}
            value={value} maxLength={60} placeholder="Type or pick a code" onChange={(e) => onChange(e.target.value)} />
          <datalist id="cm-code-list">
            {codes.map((c) => <option key={c.code} value={c.code}>{c.name ? `${c.code} - ${c.name}` : c.code}</option>)}
          </datalist>
        </span>
      )} />
  );
}

const blank = { kind: 'subcontract', title: '', costCode: '', amount: '', retainagePct: 0, contractUrl: '', contractName: '', notes: '', status: 'active', reason: '' };
const savedOf = (c) => (c ? {
  kind: c.kind, title: c.title, costCode: c.costCode || '', amount: String(c.amount), retainagePct: c.retainagePct || 0, contractUrl: c.contractUrl,
  contractName: c.contractName, notes: c.notes, status: c.status, reason: '',
} : blank);

function Waivers({ c, projectId, onChanged }) {
  const [w, setW] = useState({ kind: 'conditional_progress', throughOn: '', amount: '', receivedOn: '', fileUrl: '', fileName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true); setError('');
    try {
      await api.addCommitmentWaiver(c.id, { kind: w.kind, through_on: w.throughOn, amount: Number(w.amount || 0), received_on: w.receivedOn, file_url: w.fileUrl, file_name: w.fileName });
      setW({ ...w, throughOn: '', amount: '', receivedOn: '', fileUrl: '', fileName: '' });
      onChanged();
    } catch (e) { setError(e?.message || 'Could not keep that waiver.'); }
    setBusy(false);
  };
  const list = [...(c.waivers || [])].sort((a, b) => String(b.throughOn).localeCompare(String(a.throughOn)));
  return (
    <SettingCard>
      <SettingRow title="Lien Waivers" desc="The vendor's signed waiver for each payment - conditional with the invoice, unconditional once paid.">
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }} data-commitment-waivers={c.id}>
          {list.length === 0 && <span style={quiet}>None received yet.</span>}
          {list.map((x) => (
            <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.84rem', padding: '4px 0', borderTop: '1px solid var(--border-color)' }}>
              <span style={{ flex: '1 1 220px' }}>
                <b>{WAIVER_KIND[x.kind] || x.kind}</b> through {formatDate(x.throughOn, x.throughOn)}{x.amount ? ` - ${usd(x.amount)}` : ''}
                <span style={quiet}>{x.receivedOn ? ` · received ${formatDate(x.receivedOn, x.receivedOn)}` : ''}</span>
              </span>
              {x.fileUrl && <a href={x.fileUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>{x.fileName || 'Open'}</a>}
              <HoldButton label="Remove" ariaLabel="Remove this waiver" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                onConfirm={() => api.removeCommitmentWaiver(c.id, x.id).then(onChanged)} fallbackMessage="Remove this waiver? It stays on the record as removed." />
            </div>
          ))}
        </div>
      </SettingRow>
      <SettingRow title="Add a Waiver" desc="Its kind, the day it runs through, the amount, and the signed copy.">
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select aria-label="Waiver Kind" className="form-input" value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value })} style={{ width: 210 }}>
              {Object.entries(WAIVER_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <DateField value={w.throughOn} onChange={(v) => setW({ ...w, throughOn: v || '' })} placeholder="Through" title="Through" />
            <span className="nx-set-number">
              <span className="nx-set-number-unit">$</span>
              <input aria-label="Waiver Amount" className="form-input" type="number" min={0} step="0.01" style={{ width: 120 }}
                value={w.amount} onChange={(e) => setW({ ...w, amount: e.target.value })} />
            </span>
            <DateField value={w.receivedOn} onChange={(v) => setW({ ...w, receivedOn: v || '' })} placeholder="Received" title="Received" />
          </div>
          <FileAttach projectId={projectId} url={w.fileUrl} name={w.fileName} label="Signed waiver"
            onChange={({ url, name }) => setW({ ...w, fileUrl: url, fileName: name })} />
          <div>
            <button type="button" className="primary-btn" disabled={busy || !w.throughOn} onClick={add}>{busy ? 'Keeping…' : 'Add Waiver'}</button>
          </div>
          {error && <span role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</span>}
        </div>
      </SettingRow>
    </SettingCard>
  );
}

export default function CommitmentSheet({ project, commitment: c = null, onClose, onSaved }) {
  const saved = savedOf(c);
  const { draft, patch, dirty, reset } = useDraft(saved);
  const [vendor, setVendor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amountMoved = !!c && Number(draft.amount) !== Number(saved.amount);
  const missing = (!c && !vendor) ? 'Pick the vendor.'
    : !(Number(draft.amount) > 0) ? 'Enter the amount.'
      : amountMoved && draft.reason.trim().length < 3 ? 'Say why the amount changed.' : '';

  const save = async () => {
    if (busy || missing) return;
    setBusy(true); setError('');
    const body = {
      title: draft.title.trim(), cost_code: draft.costCode.trim(), amount: Number(draft.amount), retainage_pct: Number(draft.retainagePct || 0),
      contract_url: draft.contractUrl, contract_name: draft.contractName, notes: draft.notes,
    };
    try {
      if (c) await api.updateCommitment(c.id, { ...body, status: draft.status, reason: draft.reason.trim() });
      else await api.addCommitment(project.id, { ...body, kind: draft.kind, vendor_id: vendor.id });
      setBusy(false);
      onSaved();
      if (!c) onClose();
      else reset();
    } catch (e) {
      setBusy(false);
      setError(e?.message || 'Could not save that.');
    }
  };

  return (
    <Modal title={c ? `${c.number} ${c.vendorName}` : 'Add a Commitment'} onClose={onClose} width={720} isDirty={dirty || (!c && !!vendor)} onSave={save}>
      {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <SettingCard>
          {c ? (
            <SettingRow title="Vendor" desc={`${c.kindLabel}. Intacct vendor ${c.vendorId}.`} control={<b style={{ fontSize: '0.88rem' }}>{c.vendorName}</b>} />
          ) : (
            <>
              <SettingRow title="Kind" htmlFor="cm-kind" desc="A subcontract for labor and material by a sub; a purchase order for material from a supplier."
                control={(
                  <select id="cm-kind" aria-label="Kind" className="form-input" value={draft.kind} onChange={(e) => patch({ kind: e.target.value })} style={{ width: 170 }}>
                    {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                )} />
              <SettingRow title="Vendor" desc="One of Intacct's vendors - a new one is added in Accounting > Vendors & Customers first.">
                <VendorPicker projectId={project.id} pick={vendor} onPick={setVendor} onError={setError} />
              </SettingRow>
            </>
          )}
          <SettingRow title="Scope" htmlFor="cm-title">
            <input id="cm-title" aria-label="Scope" className="form-input" style={{ width: '100%' }} value={draft.title} maxLength={200}
              onChange={(e) => patch({ title: e.target.value })} placeholder="e.g. Plumbing rough-in and finish" />
          </SettingRow>
          <CostCodeRow projectId={project.id} value={draft.costCode} onChange={(v) => patch({ costCode: v })} />
          <SettingRow title="Amount" htmlFor="cm-amount" desc={c && c.originalAmount !== c.amount ? `Originally ${usd(c.originalAmount)}.` : 'What the signed contract or order is for.'}
            control={(
              <span className="nx-set-number">
                <span className="nx-set-number-unit">$</span>
                <input id="cm-amount" aria-label="Amount" className="form-input" type="number" min={0} step="0.01" style={{ width: 150 }}
                  value={draft.amount} onChange={(e) => patch({ amount: e.target.value })} />
              </span>
            )} />
          {amountMoved && (
            <SettingRow title="Why Did It Change?" htmlFor="cm-reason" desc="Kept on the job's record with the amount before and after.">
              <input id="cm-reason" aria-label="Why Did It Change?" className="form-input" style={{ width: '100%' }} value={draft.reason} maxLength={300}
                onChange={(e) => patch({ reason: e.target.value })} placeholder="e.g. Added two hose bibs, approved 11/04" />
            </SettingRow>
          )}
          <SettingRow title="Retainage" desc="Held back from each payment until the work is accepted."
            control={<NumberBox value={draft.retainagePct} min={0} max={20} unit="%" label="Retainage" onChange={(v) => patch({ retainagePct: v })} />} />
          <SettingRow title="Signed Copy" desc="The signed subcontract or purchase order.">
            <FileAttach projectId={project.id} url={draft.contractUrl} name={draft.contractName} label="Signed copy"
              onChange={({ url, name }) => patch({ contractUrl: url, contractName: name })} />
          </SettingRow>
          {c && (
            <SettingRow title="Status" htmlFor="cm-status" desc="Closed bills nothing more; Void takes it out of every figure. Nothing is deleted."
              control={(
                <select id="cm-status" aria-label="Status" className="form-input" value={draft.status} onChange={(e) => patch({ status: e.target.value })} style={{ width: 150 }}>
                  {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )} />
          )}
          <SettingRow title="Notes" htmlFor="cm-notes">
            <textarea id="cm-notes" aria-label="Notes" className="form-input" rows={3} style={{ width: '100%' }} value={draft.notes} maxLength={2000}
              onChange={(e) => patch({ notes: e.target.value })} />
          </SettingRow>
        </SettingCard>
        {c && <Waivers c={c} projectId={project.id} onChanged={onSaved} />}
      </div>
      <SaveRow dirty={dirty || (!c && !!vendor)} busy={busy} onSave={save} onDiscard={reset} saveDisabled={!!missing}
        note={missing && (dirty || vendor) ? missing : c ? undefined : 'Billed to Date is read from the books once the job is mapped.'} />
    </Modal>
  );
}
