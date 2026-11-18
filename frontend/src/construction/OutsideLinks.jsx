// Outside links (Construction Round Three item 4, Neil, 11/11/2026): a job
// manager sends ONE person outside the company a link to ONE thing - an RFI
// to answer, or a sub's punch list to mark done with photos - no login
// (routers/construction_outside.py). The URL is shown once, right after it
// is made (only its fingerprint is kept), with Copy Link; it is emailed too
// when an address is given. The Subs tab lists every link on the job with
// how often it was used, and Turn Off ends one.
import { useState } from 'react';
import { Link2, Copy, Check } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { SettingRow, SettingCard, NumberBox } from '../components/settings/SettingsUI';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { formatDate, formatDateTime } from '../lib/datetime';
import { CARD, TONE } from './ui';
import { useLoad } from './lib/job';

const quiet = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function CopyLink({ url }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
      <input className="form-input" readOnly value={url} aria-label="The link" onFocus={(e) => e.target.select()} style={{ flex: '1 1 260px', minWidth: 0 }} />
      <button type="button" className="secondary-btn" onClick={copy} style={{ padding: '6px 12px', fontSize: 13 }}>
        {copied ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy Link</>}
      </button>
    </div>
  );
}

/** `kind` 'rfi' (refId the RFI) or 'sub' (refId the VENDORID); `what` names it. */
export function SendLinkSheet({ project, kind, refId, what, defaultName = '', defaultEmail = '', onClose, onSent }) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);
  const badEmail = email.trim() && !EMAIL.test(email.trim());
  const send = async (sendEmail) => {
    setBusy(true); setError('');
    try {
      const out = await api.sendOutsideLink(project.id, { kind, ref_id: refId, name: name.trim(), email: email.trim(), days, send_email: sendEmail });
      setMade({ ...out, emailed: sendEmail });
      onSent?.();
    } catch (e) { setError(e?.message || 'Could not make the link.'); }
    setBusy(false);
  };
  const ask = kind === 'rfi' ? 'read this RFI and answer it, with files' : 'see their punch items on this job and mark each one done with a photo';
  return (
    <Modal title={kind === 'rfi' ? 'Send to Answer' : 'Send Punch List'} onClose={onClose} width={620}>
      {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
      <p style={{ ...quiet, margin: '0 0 12px' }}>
        <b style={{ color: 'var(--text-primary)' }}>{what}</b> - one link lets them {ask}. No sign-in. It reaches nothing else on the job, and what they do is recorded under their name.
      </p>
      {made ? (
        <div data-outside-made="" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={quiet}>{made.emailed ? `Emailed to ${made.email}. ` : ''}Works until {formatDate(made.expiresAt?.slice(0, 10), '')}. This is the only time the link is shown - copy it now if you need it.</div>
          <CopyLink url={made.url} />
          <div><button type="button" className="primary-btn" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <>
          <SettingCard>
            <SettingRow title="Their Name" htmlFor="ol-name"
              control={<input id="ol-name" aria-label="Their Name" className="form-input" style={{ width: 'min(260px, 52vw)' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morgan Lee, Architect" />} />
            <SettingRow title="Their Email" htmlFor="ol-email" desc="Where the link is sent. Leave it empty to copy the link yourself."
              control={<input id="ol-email" aria-label="Their Email" type="email" className="form-input" style={{ width: 'min(260px, 52vw)' }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />} />
            <SettingRow title="Works For" desc="Days until the link stops working. Turn it off sooner from the Subs tab."
              control={<NumberBox value={days} min={1} max={60} unit="days" label="Works For" onChange={(v) => setDays(v)} />} />
          </SettingCard>
          {badEmail && <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))', marginTop: 8 }}>That is not an email address.</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" disabled={busy || badEmail} onClick={() => send(false)}><Link2 size={14} />Make Link to Copy</button>
            <button type="button" className="primary-btn" disabled={busy || badEmail || !email.trim()} onClick={() => send(true)}>{busy ? 'Sending…' : 'Email the Link'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Every outside link on the job: who, what, used, live - and Turn Off. */
export function OutsideLinksSection({ project, refresh = 0 }) {
  const { data, error, reload } = useLoad(() => api.getOutsideLinks(project.id), `${project.id}:${refresh}`);
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={1} height={48} borderRadius={8} />;
  const links = data.links || [];
  return (
    <section data-outside-links="" style={{ ...CARD, marginBottom: 14 }} aria-label="Outside Links">
      <h3 style={{ fontSize: 18, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><Link2 size={16} />Outside Links</h3>
      <p style={{ ...quiet, margin: '0 0 10px' }}>
        Links sent to people outside the company - an RFI to answer, a sub's punch list. Each reaches one thing, needs no sign-in and runs as the person who sent it.
      </p>
      {links.length === 0 ? <div style={quiet}>No links sent yet. Send one from an RFI or a sub above.</div> : links.map((l) => (
        <div key={l.id} data-outside-link={l.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border-color)' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0 }}>
            <div style={{ fontSize: 14 }}><b>{l.name || l.email || 'No name'}</b>{l.email && l.name ? ` · ${l.email}` : ''}</div>
            <div style={quiet}>
              {[l.kind === 'rfi' ? 'RFI to answer' : 'Punch list', l.createdByName ? `sent by ${l.createdByName}` : '',
                l.uses ? `opened ${l.uses} time${l.uses === 1 ? '' : 's'}${l.lastUsedAt ? `, last ${formatDateTime(l.lastUsedAt, '')}` : ''}` : 'not opened yet',
                l.live ? `works until ${formatDate(l.expiresAt.slice(0, 10), '')}` : ''].filter(Boolean).join(' · ')}
            </div>
          </div>
          <StatusLabel size="sm" label={l.live ? 'Live' : l.revokedAt ? 'Turned Off' : 'Expired'} color={l.live ? TONE.green : TONE.gray} />
          {l.live && (
            <HoldButton label="Turn Off" doneLabel="Turned Off" holdMs={HOLD_RECORD_MS} size="sm" ariaLabel={`Turn off the link for ${l.name || l.email}`}
              onConfirm={() => api.revokeOutsideLink(l.id).then(reload)} fallbackMessage="Turn this link off? It stops working right away." />
          )}
        </div>
      ))}
    </section>
  );
}
