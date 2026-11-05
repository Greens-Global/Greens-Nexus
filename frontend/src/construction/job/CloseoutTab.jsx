// The Job's Closeout tab (Neil, 11/03/2026, plan phase 3 "Closeout That Hands
// Over"). Three things:
//   * the closeout checklist - the "Closeout" section of the job's task
//     project (the job type's template puts it there);
//   * what is handed over - warranties (item or equipment, vendor, start,
//     end, document), permits and inspections (AHJ, number, result, date),
//     as-built and O&M documents (HandoverRecords.jsx - the permits and
//     inspections also show live on their own tab, Round Two);
//   * Close Out (held - it hands the records over and marks the job
//     Complete): each record is written to the property in Asset Management
//     through that module's own per-row save, as the person closing out, and
//     an equipment warranty onto its item in Items. A record that could not
//     be written says why, and Send to Asset Management tries again.
// Plus the owner's or client's sign-off on substantial completion through
// Nexus Sign.
import { useState } from 'react';
import { ClipboardCheck, FileSignature } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CARD, TONE } from '../ui';
import Empty from '../Empty';
import { useLoad } from '../lib/job';
import { SetUp } from './PunchTab';
import HandoverRecords from './HandoverRecords';

const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)' };
const SIGNOFF = { sent: ['Sent', TONE.blue], signed: ['Signed', TONE.green], declined: ['Declined', TONE.red], void: ['Void', TONE.gray] };

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

      <HandoverRecords project={project} data={data} reload={reload} />

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
