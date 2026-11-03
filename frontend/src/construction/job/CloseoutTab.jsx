// The Job's Closeout tab (Neil, 11/03/2026, plan phase 3 "Closeout That Hands
// Over"). Three things:
//   * the closeout checklist - the "Closeout" section of the job's task
//     project (the job type's template puts it there);
//   * what is handed over - warranties (item or equipment, vendor, start,
//     end, document), permits and inspections (AHJ, number, result, date),
//     as-built and O&M documents;
//   * Close Out (held - it hands the records over and marks the job
//     Complete): each record is written to the property in Asset Management
//     through that module's own per-row save, as the person closing out, and
//     an equipment warranty onto its item in Items. A record that could not
//     be written says why, and Send to Asset Management tries again.
// Plus the owner's or client's sign-off on substantial completion through
// Nexus Sign.
import { useState } from 'react';
import { ClipboardCheck, Plus, Building2, FileSignature } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { DateField } from '../../tasks/components';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CARD, TONE } from '../ui';
import Empty from '../Empty';
import { clientId, useLoad } from '../lib/job';
import { SetUp } from './PunchTab';

const KIND_LABEL = { warranty: 'Warranty', permit: 'Permit', inspection: 'Inspection', document: 'Document' };
const RESULT = { passed: ['Passed', TONE.green], failed: ['Failed', TONE.red], partial: ['Partial', TONE.yellow], pending: ['Pending', TONE.slate] };
const DOC_CATS = [['as_built', 'As-Built'], ['om_manual', 'O&M Manual'], ['certificate', 'Certificate of Occupancy'], ['other', 'Other']];
const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)' };
const SIGNOFF = { sent: ['Sent', TONE.blue], signed: ['Signed', TONE.green], declined: ['Declined', TONE.red], void: ['Void', TONE.gray] };

function AddRecord({ project, onAdded }) {
  const [kind, setKind] = useState('warranty');
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.addCloseoutRecord(project.id, { id: clientId('rec'), kind, ...f }); setF({}); onAdded(); }
    catch (err) { setError(err.message || 'Could not add that.'); }
    setBusy(false);
  };
  const input = (k, label, ph = '') => (
    <label className="form-label" style={{ margin: 0 }}>{label}<input className="form-input" value={f[k] || ''} onChange={set(k)} placeholder={ph} /></label>
  );
  const date = (k, label) => (
    <div><span className="form-label" style={{ display: 'block' }}>{label}</span><DateField value={f[k] || ''} onChange={(v) => setF((x) => ({ ...x, [k]: v || '' }))} title={label} /></div>
  );
  return (
    <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }} aria-label="Add a Closeout Record">
      <div role="group" aria-label="Kind" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {Object.entries(KIND_LABEL).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setF({}); }}
            className={kind === k ? 'primary-btn' : 'secondary-btn'} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>{l}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {kind === 'warranty' && <>{input('title', 'Item Covered', 'e.g. Gate motor')}{input('vendor', 'Vendor')}{date('start_on', 'Start')}{date('end_on', 'End')}{input('serial', 'Serial (optional)')}{input('item_id', 'Items Id (optional)', 'For equipment in Items')}</>}
        {kind === 'permit' && <>{input('number', 'Permit Number')}{input('ahj', 'Authority (AHJ)')}{input('title', 'What It Covers')}{date('date_on', 'Issued or Finaled')}</>}
        {kind === 'inspection' && <>{input('title', 'Inspection', 'e.g. Final building')}{input('ahj', 'Authority (AHJ)')}{date('date_on', 'Date')}</>}
        {kind === 'document' && <>{input('title', 'Title', 'e.g. As-built set')}{date('date_on', 'Document Date')}</>}
        {(kind === 'permit' || kind === 'inspection') && (
          <label className="form-label" style={{ margin: 0 }}>Result
            <select className="form-input" value={f.result || ''} onChange={set('result')}>
              <option value="">Not Known</option>
              {Object.entries(RESULT).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
        {kind === 'document' && (
          <label className="form-label" style={{ margin: 0 }}>Category
            <select className="form-input" value={f.category || 'other'} onChange={set('category')}>
              {DOC_CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
      </div>
      {input('notes', 'Notes')}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
      <div><button type="submit" className="primary-btn" disabled={busy}><Plus size={14} />{busy ? 'Adding…' : `Add ${KIND_LABEL[kind]}`}</button></div>
    </form>
  );
}

function Signoff({ project, data, onChanged }) {
  const so = data.closeout?.signoff || null;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError('');
    try { await api.sendOwnerSignoff(project.id, { signer_name: name, signer_email: email }); onChanged(); }
    catch (e) { setError(e.message || 'Could not send it.'); }
    setBusy(false);
  };
  const st = so ? SIGNOFF[so.status] : null;
  return (
    <section style={{ ...CARD, marginBottom: 14 }} aria-label="Owner Sign-Off">
      <h3 style={{ fontSize: '1.05rem', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><FileSignature size={16} />Owner Sign-Off</h3>
      <p style={{ ...quiet, margin: '0 0 12px' }}>The owner or client signs the substantial completion in Nexus Sign.</p>
      {so && st && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <StatusLabel size="sm" label={st[0]} color={st[1]} />
          <span style={quiet}>{so.signerName}{so.status === 'signed' && so.signedAt ? ` signed ${formatDateTime(so.signedAt, '')}` : so.sentAt ? ` - sent ${formatDateTime(so.sentAt, '')}` : ''}</span>
        </div>
      )}
      {data.canClose && (!so || ['declined', 'void'].includes(so.status)) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="form-label" style={{ margin: 0, flex: '1 1 180px' }}>Owner or Client<input className="form-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="form-label" style={{ margin: 0, flex: '1 1 200px' }}>Their Email<input className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="primary-btn" onClick={send} disabled={busy || !name.trim() || !email.trim()}>{busy ? 'Sending…' : 'Send for Signature'}</button>
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))', marginTop: 6 }}>{error}</div>}
    </section>
  );
}

function describe(r) {
  if (r.kind === 'warranty') return [r.vendor, r.startOn || r.endOn ? `${formatDate(r.startOn, '-')} to ${formatDate(r.endOn, '-')}` : '', r.itemName ? `Item: ${r.itemName}` : '', r.serial ? `Serial ${r.serial}` : ''];
  if (r.kind === 'permit') return [r.number ? `No. ${r.number}` : '', r.ahj, r.dateOn ? formatDate(r.dateOn, '') : ''];
  if (r.kind === 'inspection') return [r.ahj, r.dateOn ? formatDate(r.dateOn, '') : ''];
  return [(DOC_CATS.find(([k]) => k === r.category) || [0, 'Other'])[1], r.dateOn ? formatDate(r.dateOn, '') : ''];
}

export default function CloseoutTab({ project, onChanged }) {
  const { data, error, reload } = useLoad(() => api.getJobCloseout(project.id), project.id);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={3} height={56} borderRadius={8} />;
  const closed = !!data.closeout?.closedOutAt;
  const unsent = (data.records || []).filter((r) => !r.written?.asset);
  const closeOut = async () => {
    setBusy(true); setMsg('');
    try {
      const out = await api.closeOutJob(project.id);
      const failed = (out.records || []).filter((r) => r.written?.error);
      setMsg(failed.length ? `${failed.length} record${failed.length === 1 ? '' : 's'} could not be handed over - see each one.` : '');
      reload(); onChanged?.();
    } catch (e) { setMsg(e.message || 'Could not close the job out.'); throw e; } finally { setBusy(false); }
  };

  return (
    <div>
      <section style={{ ...CARD, marginBottom: 14 }} aria-label="Closeout Checklist">
        <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Closeout Checklist</h3>
        <p style={{ ...quiet, margin: '0 0 12px' }}>The closeout steps on the job's schedule (Tasks).</p>
        {data.checklist.length === 0 ? (
          project.taskProjectId ? <Empty icon={ClipboardCheck} title="No closeout steps" hint="This job's schedule has no Closeout section. Add one in Tasks to track the handover here." />
            : <SetUp view={{ canStamp: project.canEdit }} project={project} onDone={reload} />
        ) : data.checklist.map((t) => (
          <div key={t.id} data-closeout={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border-color)' }}>
            <span style={{ minWidth: 0, fontSize: '0.88rem' }}>
              <b>{t.title}</b>
              {t.checklistTotal > 0 && <span style={{ color: 'var(--text-secondary)' }}> · {t.checklistDone} of {t.checklistTotal} checked</span>}
              {t.dueOn && <span style={{ color: 'var(--text-secondary)' }}> · Due {formatDate(t.dueOn, t.dueOn)}</span>}
            </span>
            <StatusLabel size="sm" label={t.completed ? 'Done' : 'Open'} color={t.completed ? TONE.green : TONE.slate} />
          </div>
        ))}
      </section>

      <section style={{ ...CARD, marginBottom: 14 }} aria-label="Handed Over">
        <h3 style={{ fontSize: '1.05rem', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><Building2 size={16} />Handed Over</h3>
        <p style={{ ...quiet, margin: '0 0 12px' }}>
          {data.property ? <>Close Out adds these to <b>{data.property.name}</b> in Asset Management{data.property.canWrite ? '' : ' (someone with edit access there has to close out, or send them later)'}; an equipment warranty also goes on its item in Items.</>
            : 'Link the job to a property (Edit Job) so Close Out can add these to Asset Management.'}
        </p>
        {(data.records || []).length === 0 ? <div style={quiet}>Nothing yet. Add the warranties, permits, inspections and documents the owner receives.</div>
          : data.records.map((r) => {
            const res = RESULT[r.result];
            return (
              <div key={r.id} data-closeout-record={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <div style={{ fontSize: '0.88rem' }}><b>{KIND_LABEL[r.kind]}</b> · {r.title || r.number}</div>
                  <div style={quiet}>{describe(r).filter(Boolean).join(' · ')}</div>
                  {r.written?.error && <div style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{r.written.error}</div>}
                </div>
                {res && <StatusLabel size="sm" label={res[0]} color={res[1]} />}
                <StatusLabel size="sm" label={r.written?.asset ? 'In Asset Management' : 'Not Handed Over'} color={r.written?.asset ? TONE.green : TONE.slate} />
                {data.canAdd && !r.written?.asset && (
                  <HoldButton label="Remove" ariaLabel="Remove this record" doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                    onConfirm={() => api.removeCloseoutRecord(r.id).then(reload)} fallbackMessage="Take this record off the closeout?" />
                )}
              </div>
            );
          })}
        {data.canAdd && <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 8, paddingTop: 12 }}><AddRecord project={project} onAdded={reload} /></div>}
      </section>

      <Signoff project={project} data={data} onChanged={reload} />

      {data.canClose && (
        <section style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} aria-label="Close Out">
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontWeight: 600 }}>{closed ? `Closed out ${formatDateTime(data.closeout.closedOutAt, '')}` : 'Close Out'}</div>
            <div style={quiet}>{closed ? (unsent.length ? `${unsent.length} record${unsent.length === 1 ? '' : 's'} still to hand over.` : 'Everything is handed over.')
              : 'Hands every record over and marks the job Complete. Nothing is deleted.'}</div>
            {msg && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{msg}</div>}
          </div>
          {!closed ? (
            <HoldButton label="Close Out" doneLabel="Closed Out" icon={ClipboardCheck} holdMs={HOLD_RECORD_MS} onConfirm={closeOut}
              fallbackMessage={`Close ${project.name} out? The records go to Asset Management and the job is marked Complete.`} />
          ) : unsent.length > 0 && (
            <button className="secondary-btn" disabled={busy} onClick={() => closeOut().catch(() => {})}>{busy ? 'Sending…' : 'Send to Asset Management'}</button>
          )}
        </section>
      )}
    </div>
  );
}
