import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserCheck, X } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { SkeletonBlocks } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { useRole } from '../contexts/RoleContext';
import { StatusLabel } from './StatusLabel';

// Delegate My Approvals (Neil, Oct 17 2026). Someone who approves things
// names a stand-in for a date range (a vacation): while it is live, their
// time sheets to review, punch fixes and time off ALSO go to the stand-in,
// for their own people only - nothing moves, the delegator keeps everything.
// The server decides who may delegate (canDelegate) and refuses a bad pick or
// an overlapping range with the reason, shown here as is.
//
//   DelegateApprovalsCard   - Workday Overview: your delegations + who you cover.
//   ApprovalDelegationsAdmin - People > Leave (HR): everyone's, set for anyone.
//   ForChip                 - "For <delegator>" on a delegated row in the
//                             approval lists (Time Sheets to Review, punch
//                             requests, time off).

const STATE = {
  active: { label: 'Active', color: '#16a34a' },
  upcoming: { label: 'Upcoming', color: '#2563eb' },
  ended: { label: 'Ended', color: '#64748b' },
  revoked: { label: 'Revoked', color: '#64748b' },
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const span = (d) => (d.startDate === d.endDate ? formatDate(d.startDate) : `${formatDate(d.startDate)} - ${formatDate(d.endDate)}`);

export function ForChip({ name, email }) {
  if (!name && !email) return null;
  return <StatusLabel size="sm" label={`For ${name || email}`} color="#7c3aed"
    title={`You see this because you cover ${name || email}'s approvals`} style={{ marginLeft: 6 }} />;
}

function usePeople() {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    let live = true;
    api.getPeopleDirectory().then(r => { if (live) setPeople(Array.isArray(r) ? r : []); })
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, []);
  return people;
}

const label = { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 };

function PersonField({ title, value, people, onChange, exclude = [] }) {
  const options = useMemo(() => (people || []).filter(p => p.email && !exclude.includes(p.email)), [people, exclude]);
  const picked = (people || []).find(p => p.email === value);
  return (
    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
      <span style={label}>{title}</span>
      {value ? (
        <div className="form-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {picked?.name || value}
          </span>
          <button type="button" aria-label={`Clear ${title}`} onClick={() => onChange('')}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people: options }]} onPick={onChange} />
      )}
    </div>
  );
}

// The From / To / Note row and the save button - shared by both forms.
function DelegationForm({ people, me, admin, onSave, busy }) {
  const [delegator, setDelegator] = useState('');
  const [delegate, setDelegate] = useState('');
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const ready = delegate && start && end && end >= start && (!admin || delegator);
  const submit = async () => {
    const ok = await onSave({
      delegate_email: delegate, start_date: start, end_date: end, note: note.trim(),
      ...(admin ? { delegator_email: delegator } : {}),
    });
    if (ok) { setDelegate(''); setEnd(''); setNote(''); setDelegator(''); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {admin && <PersonField title="Whose Approvals" value={delegator} people={people} onChange={setDelegator} exclude={[delegate]} />}
        <PersonField title="Covered By" value={delegate} people={people} onChange={setDelegate}
          exclude={[admin ? delegator : me].filter(Boolean)} />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '0 1 160px' }}>
          <span style={label}>From</span>
          <input type="date" className="form-input" value={start} min={today()} onChange={e => setStart(e.target.value)} aria-label="From" />
        </label>
        <label style={{ flex: '0 1 160px' }}>
          <span style={label}>To</span>
          <input type="date" className="form-input" value={end} min={start || today()} onChange={e => setEnd(e.target.value)} aria-label="To" />
        </label>
        <label style={{ flex: '1 1 220px' }}>
          <span style={label}>Note</span>
          <input className="form-input" value={note} maxLength={400} onChange={e => setNote(e.target.value)}
            placeholder="Optional - e.g. on vacation" aria-label="Note" />
        </label>
        <button type="button" className="primary-btn" disabled={!ready || busy} onClick={submit}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <UserCheck size={14} /> {busy ? 'Saving...' : 'Delegate'}
        </button>
      </div>
      {end && start && end < start && <div style={{ fontSize: 12, color: '#b91c1c' }}>The last day is before the first day.</div>}
    </div>
  );
}

function DelegationRow({ d, who, onRevoke, busy, revokeLabel = 'Revoke' }) {
  const st = STATE[d.state] || STATE.upcoming;
  return (
    <div data-delegation={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{who}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {span(d)}{d.note ? ` · "${d.note}"` : ''}
        </div>
      </div>
      <StatusLabel size="sm" label={st.label} color={st.color} />
      {onRevoke && d.state !== 'revoked' && d.state !== 'ended' && (
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => onRevoke(d)} style={{ fontSize: 12.5 }}>{revokeLabel}</button>
      )}
    </div>
  );
}

export default function DelegateApprovalsCard({ toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const people = usePeople();
  const { myEmail = '' } = useRole() || {};
  const load = useCallback(() => {
    api.approvalDelegationsMine().then(setData).catch(() => setData({ canDelegate: false, delegations: [], covering: [] }));
  }, []);
  useEffect(load, [load]);

  if (!data) return null;          // only approvers get the card - nothing to hold a place for
  const mine = data.delegations || [];
  const covering = data.covering || [];
  if (!data.canDelegate && !covering.length) return null;

  async function save(body) {
    setBusy(true); setErr('');
    try {
      await api.approvalDelegationCreate(body);
      toastOk?.('Delegated - they will see your approvals for those days.');
      load();
      setBusy(false);
      return true;
    } catch (e) {
      setErr(e?.message || 'Could not save that.');
      setBusy(false);
      return false;
    }
  }
  async function revoke(d) {
    setBusy(true);
    try { await api.approvalDelegationRevoke(d.id); toastOk?.('Revoked.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not revoke that.'); }
    setBusy(false);
  }

  return (
    <div className="dash-card" data-card="delegate-approvals" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <UserCheck size={15} style={{ color: 'var(--wk-brand, hsl(var(--color-blue)))' }} />
        <span style={{ fontWeight: 800, fontSize: 14 }}>Delegate My Approvals</span>
      </div>
      {data.canDelegate && (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
            Away for a while? Pick who covers your approvals. For those days your team's time sheets, punch
            fixes and time off go to them too - you keep yours.
          </p>
          {people === null ? <SkeletonBlocks count={1} height={40} /> : (
            <DelegationForm people={people} me={(myEmail || '').toLowerCase()} onSave={save} busy={busy} />
          )}
          {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 8 }}>{err}</div>}
          {mine.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>Your Delegations</div>
              {mine.map(d => <DelegationRow key={d.id} d={d} who={d.delegateName || d.delegateEmail} onRevoke={revoke} busy={busy} />)}
            </div>
          )}
        </>
      )}
      {covering.length > 0 && (
        <div style={{ marginTop: data.canDelegate ? 14 : 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>You Are Covering</div>
          {/* The stand-in may end it too - the delegator is told. */}
          {covering.map(d => <DelegationRow key={d.id} d={d} who={d.delegatorName || d.delegatorEmail} onRevoke={revoke} busy={busy} revokeLabel="Stop Covering" />)}
        </div>
      )}
    </div>
  );
}

export function ApprovalDelegationsAdmin({ toastOk, toastErr }) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const [past, setPast] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const people = usePeople();
  const load = useCallback(() => {
    api.approvalDelegationsAll(past).then(r => { setFailed(false); setRows(Array.isArray(r) ? r : []); })
      .catch(e => { setRows([]); setFailed(e?.status === 403 ? 'denied' : true); });
  }, [past]);
  useEffect(load, [load]);
  if (failed === 'denied') return null;      // not HR admin - the card is not theirs

  async function save(body) {
    setBusy(true); setErr('');
    try {
      await api.approvalDelegationCreateFor(body);
      toastOk?.('Delegation saved.');
      load();
      setBusy(false);
      return true;
    } catch (e) {
      setErr(e?.message || 'Could not save that.');
      setBusy(false);
      return false;
    }
  }
  async function revoke(d) {
    setBusy(true);
    try { await api.approvalDelegationRevoke(d.id); toastOk?.('Revoked.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not revoke that.'); }
    setBusy(false);
  }

  return (
    <div className="dash-card" data-card="delegations-admin" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <UserCheck size={15} style={{ color: 'hsl(var(--color-blue))' }} />
        <span style={{ fontWeight: 800, fontSize: 14 }}>Approval Delegations</span>
        <label style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={past} onChange={e => setPast(e.target.checked)} /> Show ended and revoked
        </label>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
        Who covers whose approvals, and when. Set one for someone who is out and could not set it themselves.
      </p>
      {people === null ? <SkeletonBlocks count={1} height={40} /> : <DelegationForm people={people} admin onSave={save} busy={busy} />}
      {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 14 }}>
        {rows === null ? <SkeletonBlocks count={2} height={36} /> : failed ? (
          <div style={{ fontSize: 12.5, color: '#b91c1c' }}>Could not load the delegations.</div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No delegations right now.</div>
        ) : rows.map(d => (
          <DelegationRow key={d.id} d={d} busy={busy} onRevoke={revoke}
            who={`${d.delegatorName || d.delegatorEmail} - covered by ${d.delegateName || d.delegateEmail}`} />
        ))}
      </div>
    </div>
  );
}
