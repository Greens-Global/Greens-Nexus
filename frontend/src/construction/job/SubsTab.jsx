// Subs (Round Two item 7, Neil, 11/05/2026): the subcontractors on the job,
// each one of Intacct's vendors picked through Accounting's vendor list -
// never typed in, never a second directory - with their papers beside
// (VendorCompliance: insurance, workers comp, license, W-9). The managers
// are belled 30 and 7 days before a paper lapses and the day it does.
import { useEffect, useState } from 'react';
import { HardHat, Plus } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDate } from '../../lib/datetime';
import { CARD } from '../ui';
import { useLoad } from '../lib/job';
import VendorCompliance, { PapersLabel } from '../VendorCompliance';
import { OutsideLinksSection, SendLinkSheet } from '../OutsideLinks';

const quiet = { fontSize: '0.82rem', color: 'var(--text-secondary)' };

/** Find one of Intacct's vendors (the job's managers only - names and ids,
 *  never contact details). Shared with the Money tab's commitments. */
export function VendorPicker({ projectId, pick, onPick, onError }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    const text = q.trim();
    if (!text || pick) { setFound([]); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.searchConstructionVendors(text, projectId)
        .then((d) => { if (live) setFound(d?.vendors || []); })
        .catch((e) => { if (live) onError?.(e?.message || 'The vendor list could not be read.'); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, pick, projectId, onError]);
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input className="form-input" aria-label="Find a vendor" placeholder="Find a vendor on the Intacct list…" value={pick ? pick.name : q}
        style={{ width: '100%' }} onChange={(e) => { onPick(null); setQ(e.target.value); }} />
      {found.length > 0 && (
        <ul role="listbox" aria-label="Vendors" style={{ listStyle: 'none', margin: '4px 0 0', padding: 4, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-card)', position: 'absolute', left: 0, right: 0, zIndex: 5, boxShadow: 'var(--shadow-md)' }}>
          {found.map((v) => (
            <li key={v.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => { onPick(v); setFound([]); }}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '6px 8px', fontFamily: 'inherit', fontSize: '0.86rem', cursor: 'pointer', color: 'var(--text-primary)' }}>
                {v.name} <span style={{ ...quiet, fontSize: '0.76rem' }}>{v.id}{v.inactive ? ' · Inactive in Intacct' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddSub({ project, onAdded }) {
  const [pick, setPick] = useState(null);
  const [round, setRound] = useState(0);   // a new picker after each add
  const [trade, setTrade] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (e) => {
    e.preventDefault();
    if (!pick) return;
    setBusy(true); setError('');
    try { await api.addJobSub(project.id, { vendor_id: pick.id, trade: trade.trim() }); setPick(null); setRound((r) => r + 1); setTrade(''); onAdded(); }
    catch (err) { setError(err?.message || 'Could not add that sub.'); }
    setBusy(false);
  };
  return (
    <form onSubmit={add} aria-label="Add a Sub" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 240px' }}>
          <VendorPicker key={round} projectId={project.id} pick={pick} onPick={setPick} onError={setError} />
        </div>
        <input className="form-input" aria-label="Trade" placeholder="Trade (e.g. Plumbing)" value={trade} onChange={(e) => setTrade(e.target.value)} style={{ flex: '1 1 160px' }} />
        <button type="submit" className="primary-btn" disabled={!pick || busy}><Plus size={14} />{busy ? 'Adding…' : 'Add Sub'}</button>
      </div>
      <div style={quiet}>A sub not on the list is added in Accounting &gt; Vendors &amp; Customers first - the vendor record is Intacct&apos;s.</div>
      {error && <div role="alert" style={{ fontSize: '0.8rem', color: 'hsl(var(--color-red))' }}>{error}</div>}
    </form>
  );
}

export default function SubsTab({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobSubs(project.id), project.id);
  const [open, setOpen] = useState('');
  // Round Three item 4 (11/11/2026): a sub's punch list by an outside link.
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(0);
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={2} height={56} borderRadius={8} />;
  const subs = data.subs || [];
  const lapsed = subs.filter((s) => s.compliance?.state === 'expired' || s.compliance?.state === 'missing').length;
  return (
    <>
    <section style={{ ...CARD, marginBottom: 14 }} aria-label="Subs">
      <h3 style={{ fontSize: '1.05rem', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}><HardHat size={16} />Subs</h3>
      <p style={{ ...quiet, margin: '0 0 12px' }}>
        {subs.length === 0 ? 'No subcontractor on this job yet. ' : `${subs.length} on the job${lapsed ? `, ${lapsed} without current insurance` : ''}. `}
        Each sub is an Intacct vendor; their papers are kept once and shared with Accounting. Managers are belled 30 and 7 days before a paper lapses.
      </p>
      {subs.map((s) => (
        <div key={s.linkId} data-sub={s.vendorId} style={{ padding: '9px 0', borderTop: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ fontSize: '0.88rem' }}><b>{s.name}</b>{s.trade ? ` · ${s.trade}` : ''} <span style={{ ...quiet, fontSize: '0.76rem' }}>{s.vendorId}</span></div>
              <div style={quiet}>{s.compliance?.issues?.length ? s.compliance.issues.join(' ') : 'Papers current.'}{s.since ? ` Since ${formatDate(s.since)}.` : ''}</div>
            </div>
            <PapersLabel compliance={s.compliance} />
            {data.canEdit && (
              <button type="button" className="secondary-btn" aria-expanded={open === s.vendorId} onClick={() => setOpen(open === s.vendorId ? '' : s.vendorId)} style={{ padding: '6px 10px', fontSize: '0.8rem' }}>Papers</button>
            )}
            {data.canEdit && (
              <button type="button" className="secondary-btn" onClick={() => setSending(s)} style={{ padding: '6px 10px', fontSize: '0.8rem' }}>Send Punch List</button>
            )}
            {data.canEdit && (
              <HoldButton label="Remove" ariaLabel={`Take ${s.name} off the job`} doneLabel="Removed" holdMs={HOLD_RECORD_MS} size="sm"
                onConfirm={() => api.endJobSub(s.linkId).then(reload)} fallbackMessage="Take this sub off the job?" />
            )}
          </div>
          {open === s.vendorId && (
            <div style={{ marginTop: 10, padding: 12, border: '1px solid var(--border-color)', borderRadius: 8 }}>
              <VendorCompliance vendorId={s.vendorId} initial={s.compliance} onSaved={reload} />
            </div>
          )}
        </div>
      ))}
      {data.canEdit && <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 8, paddingTop: 12 }}><AddSub project={project} onAdded={reload} /></div>}
    </section>
    {data.canEdit && <OutsideLinksSection project={project} refresh={sent} />}
    {sending && (
      <SendLinkSheet project={project} kind="sub" refId={sending.vendorId} what={`${sending.name}'s punch list`}
        onClose={() => setSending(null)} onSent={() => setSent((n) => n + 1)} />
    )}
    </>
  );
}
