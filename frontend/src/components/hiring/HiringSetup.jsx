// Set Up Hiring (Oct 23): the way into Settings > Hiring > Hiring Documents.
// Screen 1 lists All Companies (Shared) and every company with what is left to
// do; picking one opens Screen 2 (HiringSetupCompany) in place. The chips come
// from the same server view as Screen 2, so the two never disagree.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { LoadingState, ErrorBanner } from '../AsyncState';
import HiringSetupCompany, { StatusChip } from './HiringSetupCompany';

const btn = { display: 'inline-flex', alignItems: 'center', minHeight: 38 };

export default function HiringSetup({ toastOk, toastErr, initialCompanyId = null, focus = null, onFocusUsed, refreshKey = 0, onAdvanced }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  // null = the list; '' = All Companies; an id = that company.
  const [open, setOpen] = useState(() => (focus?.entityId ?? initialCompanyId ?? null));
  const load = () => api.getHiringSetup().then(d => { setData(d); setErr(''); }).catch(e => setErr(e?.message || 'Could not load the hiring setup.'));
  // The offer's focus opens its popup once: Back and reopening the company must not pop it again.
  const [left, setLeft] = useState(focus);
  const used = () => { setLeft(null); onFocusUsed?.(); };
  useEffect(() => { if (open === null) load(); }, [open, refreshKey]);

  if (open !== null) {
    return (
      <HiringSetupCompany key={open} entityId={open} focus={left && (left.entityId ?? null) === open ? left : null} onFocusUsed={used} refreshKey={refreshKey}
        onBack={() => setOpen(null)} onAdvanced={onAdvanced} toastOk={toastOk} toastErr={toastErr} />
    );
  }
  if (err && !data) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <LoadingState label="Loading the hiring setup" />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Hiring Setup</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.5 }}>Set up each company once. Anything you don&apos;t change uses the shared version.</p>
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', padding: '16px 20px', background: 'var(--mist)' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>All Companies (Shared)</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>{data.shared?.summary}</div>
          </div>
          <button type="button" className="secondary-btn" style={btn} onClick={() => setOpen('')}>Open</button>
        </div>
        {(data.companies || []).map(c => (
          <div key={c.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', padding: '16px 20px', borderTop: '1px solid var(--line)' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{c.name}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{c.place}</span>
                <StatusChip status={c.status} chip={c.chip} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{c.summary}</div>
            </div>
            <button type="button" className="primary-btn" style={btn} onClick={() => setOpen(c.id)} aria-label={`Set Up Hiring - ${c.name}`}>Set Up Hiring</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onAdvanced?.()}
        style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)', textDecoration: 'underline', fontFamily: 'Inter,sans-serif' }}>
        Advanced: All Packets And Signing Orders
      </button>
    </div>
  );
}
