import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Plus, Paperclip, Pencil } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { DateField } from '../tasks/components';
import { CredentialState } from './credentialState';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { SectionHead, Field } from './shared';
import { BOX, DATE_BOX, GRID, HINT } from './lib';

// Licenses & Certifications (Neil, 11/11/2026, Deputy parity - "training
// records"): what this person holds, when each expires and the proof. HR
// adds and changes them here; a manager reads their own team's (they
// schedule them). A shift type can require one (Shifts > Settings > Shift
// Types), and the planner warns when the person placed has none valid that
// day. The daily check bells the person, their manager and HR before an
// expiry (Settings > Notifications > HR & Compliance Reminders); an expired
// one shows on the Records Audit. Only the last four of a number are kept.

// Months after `iso`, the day clamped to the month's end - the server's add_months.
function addMonths(iso, months) {
  if (!iso || !months) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + Number(months), 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const blank = { typeId: '', issuer: '', number: '', issuedOn: '', expiresOn: '', documentId: '', note: '', verified: false, expiresTouched: false };

export default function CredentialsSection({ employee, toastOk, toastErr }) {
  const eid = employee?.id;
  const [data, setData] = useState(null);       // { credentials, types, canEdit }
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(null);       // blank (Add) or a record (Edit)
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!eid) return undefined;
    let live = true;
    setError('');
    api.hrPersonCredentials(eid)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the licenses and certifications.'); });
    return () => { live = false; };
  }, [eid, tick]);

  const canEdit = !!data?.canEdit;
  const formOpen = !!form;
  // The proof is one of this person's documents - loaded when a form opens.
  useEffect(() => {
    if (!formOpen || !canEdit || !eid) return undefined;
    let live = true;
    api.getEmployeeDocs(eid).then((r) => { if (live) setDocs((r || []).filter((d) => !['paystub', 'settlement'].includes(d.kind))); }).catch(() => {});
    return () => { live = false; };
  }, [formOpen, canEdit, eid]);

  const types = useMemo(() => data?.types || [], [data]);
  const typeOf = (id) => types.find((t) => t.id === id);
  const picked = form ? typeOf(form.typeId) : null;
  // An archived type is not in the list: a record of it keeps its own date.
  const expires = picked ? picked.expires : !!form?.expiresOn;
  const set = (patch) => setForm((f) => {
    const next = { ...f, ...patch };
    // A type's length fills the expiry from the issue date until it is typed.
    if (!next.id && !next.expiresTouched && ('issuedOn' in patch || 'typeId' in patch)) {
      const t = typeOf(next.typeId);
      if (t?.expires && t.validityMonths && next.issuedOn) next.expiresOn = addMonths(next.issuedOn, t.validityMonths);
    }
    return next;
  });

  const bad = !form ? '' : (!form.id && !form.typeId) ? 'Pick a type.'
    : (expires && !form.expiresOn) ? 'Give the expiry date.'
    : (form.issuedOn && form.expiresOn && form.expiresOn < form.issuedOn) ? 'Expires is before Issued.' : '';

  async function save() {
    if (bad || busy) return;
    setBusy(true);
    try {
      const body = { issuer: form.issuer, issuedOn: form.issuedOn, expiresOn: form.expiresOn,
        documentId: form.documentId, note: form.note, verified: !!form.verified };
      if (form.number) body.number = form.number;
      const r = form.id ? await api.updateHrCredential(form.id, body) : await api.addHrCredential(eid, { typeId: form.typeId, ...body });
      setData(r); setForm(null);
      toastOk?.(form.id ? 'Saved.' : 'Added.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  async function uploadProof(file) {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'certificate');
      if (form?.expiresOn) fd.append('expires_on', form.expiresOn);
      const doc = await api.uploadEmployeeDoc(eid, fd);
      setDocs((d) => [doc, ...d]);
      set({ documentId: doc.id });
    } catch (e) { toastErr?.(e?.message || 'Upload failed.'); }
    setUploading(false);
  }

  async function openProof(c) {
    try { const { url } = await api.getDocUrl(c.documentId); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open the proof.'); }
  }

  const head = (
    <SectionHead title="Licenses & Certifications">
      {canEdit && !form && types.length > 0 && (
        <button type="button" className="secondary-btn" onClick={() => setForm({ ...blank })}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '5px 11px' }}>
          <Plus size={13} /> Add
        </button>
      )}
    </SectionHead>
  );

  if (error) return <div>{head}<ErrorBanner message={error} onRetry={() => setTick((t) => t + 1)} /></div>;
  if (!data) return <div>{head}<SkeletonBlocks count={1} height={36} /></div>;

  const rows = data.credentials || [];
  return (
    <div data-credentials>
      {head}
      {rows.length === 0 && !form && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '6px 0' }}>
          {types.length === 0
            ? 'No license or certification types are set up yet - add them in Settings > People & Access.'
            : 'None on file.'}
        </div>
      )}
      {rows.map((c) => (form?.id === c.id ? null : (
        <div key={c.id} className="pr-row" style={{ alignItems: 'center' }}>
          <div className="pr-row-label" style={{ color: 'var(--ink)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            {c.name}
            {c.verifiedAt && <BadgeCheck size={14} color="hsl(var(--color-green))" aria-label="Verified" title={`Original seen by ${c.verifiedBy} on ${formatDate(c.verifiedAt)}`} />}
          </div>
          <div className="pr-row-value" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <CredentialState state={c.state} />
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {[c.expiresOn ? `Expires ${formatDate(c.expiresOn)}` : '', c.issuedOn ? `Issued ${formatDate(c.issuedOn)}` : '',
                c.issuer, c.numberLast4 ? `ending ${c.numberLast4}` : ''].filter(Boolean).join(' · ')}
            </span>
            {c.documentId && (canEdit
              ? <button type="button" className="pr-link" onClick={() => openProof(c)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}><Paperclip size={12} /> {c.documentName || 'Proof'}</button>
              : <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Paperclip size={12} /> Proof on file</span>)}
            {canEdit && !form && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button type="button" className="secondary-btn" aria-label={`Edit ${c.name}`} title="Edit"
                  onClick={() => setForm({ ...blank, ...c, number: '', verified: !!c.verifiedAt, expiresTouched: true })}
                  style={{ fontSize: 12, padding: '4px 9px', display: 'inline-flex', alignItems: 'center' }}><Pencil size={12} /></button>
                <HoldButton label="Remove" doneLabel="Removed" size="sm" holdMs={HOLD_RECORD_MS} ariaLabel={`Remove ${c.name}`}
                  onConfirm={async () => { const r = await api.removeHrCredential(c.id); setData(r); }} />
              </span>
            )}
          </div>
          {c.note && canEdit && <div style={{ ...HINT, gridColumn: '1 / -1' }}>{c.note}</div>}
        </div>
      )))}

      {form && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginTop: 10 }}>
          <div style={GRID}>
            {form.id ? (
              <Field label="Type"><div style={{ fontSize: 13.5, fontWeight: 600, paddingTop: 8 }}>{form.name}</div></Field>
            ) : (
              <Field label="Type" htmlFor="cred-type">
                <select id="cred-type" className="form-input" style={BOX} value={form.typeId} onChange={(e) => set({ typeId: e.target.value })}>
                  <option value="">Pick one</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Issued By" htmlFor="cred-issuer">
              <input id="cred-issuer" className="form-input" style={BOX} value={form.issuer} placeholder="e.g. California DMV" onChange={(e) => set({ issuer: e.target.value })} />
            </Field>
            <Field label="Number" htmlFor="cred-number" hint={form.id && form.numberLast4 ? `On file: ending ${form.numberLast4}. Type a new one to replace it.` : 'Only the last 4 characters are kept.'}>
              <input id="cred-number" className="form-input" style={BOX} value={form.number} autoComplete="off" onChange={(e) => set({ number: e.target.value })} />
            </Field>
            <Field label="Issued">
              <DateField value={form.issuedOn} onChange={(v) => set({ issuedOn: v || '' })} title="Issued" placeholder="Pick a date" style={DATE_BOX} />
            </Field>
            {expires && (
              <Field label="Expires" hint={!form.id && picked?.validityMonths ? `Filled from the issue date - ${picked.validityMonths} months.` : undefined}>
                <DateField value={form.expiresOn} onChange={(v) => set({ expiresOn: v || '', expiresTouched: true })} title="Expires" placeholder="Pick a date" style={DATE_BOX} />
              </Field>
            )}
            <Field label="Proof" htmlFor="cred-doc">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select id="cred-doc" className="form-input" style={{ ...BOX, flex: 1 }} value={form.documentId} onChange={(e) => set({ documentId: e.target.value })}>
                  <option value="">None</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.fileName}</option>)}
                </select>
                <label className="secondary-btn" style={{ fontSize: 12, cursor: 'pointer', padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  {uploading ? 'Uploading…' : 'Upload'}
                  <input type="file" hidden accept="image/*,application/pdf" onChange={(e) => { uploadProof(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            </Field>
            <Field label="Note" htmlFor="cred-note" wide>
              <input id="cred-note" className="form-input" style={BOX} value={form.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 12 }}>
            <input type="checkbox" checked={!!form.verified} onChange={(e) => set({ verified: e.target.checked })} />
            I have seen the original
          </label>
          {bad && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 8 }}>{bad}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="secondary-btn" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
            <button type="button" className="primary-btn" onClick={save} disabled={busy || !!bad}>{busy ? 'Saving…' : form.id ? 'Save' : 'Add'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
