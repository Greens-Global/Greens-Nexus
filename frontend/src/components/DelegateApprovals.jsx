import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, UserCheck, X } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { offRangeProblem } from '../lib/delegationDays';
import { SkeletonBlocks } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { StatusLabel } from './StatusLabel';

// Delegate My Approvals (Neil, Oct 17 2026). Someone who approves things
// names a stand-in for a date range (a vacation): while it is live, their
// time sheets to review, punch fixes and time off ALSO go to the stand-in,
// for their own people only - nothing moves, the delegator keeps everything.
// The server decides who may delegate (canDelegate) and refuses a bad pick or
// an overlapping range with the reason, shown here as is.
//
// Neil, Oct 20 2026: it lives on the Workday Time Off tab, collapsed by
// default; it opens up only for the days the person is OFF (approved full-day
// time off or a company holiday - /approval-delegations/options lists them);
// and it goes only UP or ACROSS - the picker lists the server's own list of
// who may cover (their manager and up, peers, the same role level or above),
// never their own reports. An older delegation that breaks either rule keeps
// working until it ends, with its warning shown on the row.
//
//   DelegateApprovalsCard   - Workday > Time Off: your delegations + who you cover.
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

const RELATION_ORDER = ['above', 'peer', 'level'];
const RELATION_LABEL = { above: 'Up Your Reporting Line', peer: 'Same Manager', level: 'Same Level or Above' };

const span = (d) => (d.startDate === d.endDate ? formatDate(d.startDate) : `${formatDate(d.startDate)} - ${formatDate(d.endDate)}`);
const rangeSpan = (r) => (r.start === r.end ? formatDate(r.start) : `${formatDate(r.start)} - ${formatDate(r.end)}`);

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

// {delegates, offRanges} for `delegator` ('' = me). `enabled` false = not yet.
function useOptions(delegator, enabled) {
  const [opts, setOpts] = useState(null);
  const [failed, setFailed] = useState('');
  const load = useCallback(() => {
    if (!enabled) { setOpts(null); return undefined; }
    let live = true;
    setOpts(null); setFailed('');
    api.approvalDelegationOptions(delegator).then(r => {
      if (live) setOpts({ delegates: r?.delegates || [], offRanges: r?.offRanges || [] });
    }).catch(e => { if (live) { setFailed(e?.message || 'Could not load who can cover.'); setOpts({ delegates: [], offRanges: [] }); } });
    return () => { live = false; };
  }, [delegator, enabled]);
  useEffect(load, [load]);
  return [opts, failed, load];
}

const label = { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 };

function PersonField({ title, value, groups, onChange, placeholder = 'Type a name or email', nameOf }) {
  return (
    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
      <span style={label}>{title}</span>
      {value ? (
        <div className="form-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {nameOf(value) || value}
          </span>
          <button type="button" aria-label={`Clear ${title}`} onClick={() => onChange('')}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}>
            <X size={14} />
          </button>
        </div>
      ) : (
        <PersonSearchSelect placeholder={placeholder} groups={groups} onPick={onChange} />
      )}
    </div>
  );
}

// Who may cover - the server's list, grouped Up Your Reporting Line / Same
// Manager / Same Level or Above. Never the whole directory.
const delegateGroups = (delegates) => RELATION_ORDER
  .map(k => ({ label: RELATION_LABEL[k], people: (delegates || []).filter(p => p.relation === k) }))
  .filter(g => g.people.length);

// The form: (HR: whose approvals) / covered by / the days off to pick from /
// From / To / Note. `admin` picks the delegator first; the options follow them.
function DelegationForm({ people, admin, onSave, busy }) {
  const [delegator, setDelegator] = useState('');
  const [delegate, setDelegate] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [opts, optsErr] = useOptions(admin ? delegator : '', admin ? !!delegator : true);
  const offRanges = opts?.offRanges || [];
  const delegates = opts?.delegates || [];
  const off = opts !== null && offRanges.length > 0;
  const problem = offRangeProblem(start, end, offRanges);
  const ready = off && delegate && start && end && end >= start && !problem && (!admin || delegator);
  const nameOf = (em) => (delegates.find(p => p.email === em) || (people || []).find(p => p.email === em))?.name;
  useEffect(() => { setDelegate(''); setStart(''); setEnd(''); }, [delegator]);
  const pickRange = (r) => { setStart(r.start); setEnd(r.end); };
  const submit = async () => {
    const ok = await onSave({
      delegate_email: delegate, start_date: start, end_date: end, note: note.trim(),
      ...(admin ? { delegator_email: delegator } : {}),
    });
    if (ok) { setDelegate(''); setStart(''); setEnd(''); setNote(''); setDelegator(''); }
  };
  const whoseOff = admin ? 'they have' : 'you have';
  const minDay = offRanges[0]?.start;
  const maxDay = offRanges.reduce((m, r) => (r.end > m ? r.end : m), '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {admin && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <PersonField title="Whose Approvals" value={delegator} onChange={setDelegator} nameOf={nameOf}
            groups={[{ label: 'Nexus People', people: (people || []).filter(p => p.email) }]} />
        </div>
      )}
      {admin && !delegator ? null : opts === null ? <SkeletonBlocks count={1} height={40} /> : (
        <>
          {optsErr && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c' }}>{optsErr}</div>}
          {!off ? (
            <div data-delegate-disabled style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 12px', borderRadius: 10, background: 'var(--mist)' }}>
              Available when {whoseOff} approved time off. Request it above - once it is approved, pick who covers those days here.
            </div>
          ) : (
            <div>
              <span style={label}>{admin ? 'Their Time Off' : 'Your Time Off'}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {offRanges.map(r => {
                  const on = start === r.start && end === r.end;
                  return (
                    <button key={`${r.kind}-${r.start}-${r.end}`} type="button" onClick={() => pickRange(r)} aria-pressed={on}
                      className="secondary-btn"
                      style={{ fontSize: 12, ...(on ? { background: 'var(--wk-brand)', color: '#fff', borderColor: 'var(--wk-brand)' } : {}) }}>
                      {rangeSpan(r)} · {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <fieldset disabled={!off} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0, opacity: off ? 1 : 0.55, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {off ? (
                <PersonField title="Covered By" value={delegate} onChange={setDelegate} nameOf={nameOf}
                  placeholder={delegates.length ? 'Your manager, someone above them, or a peer' : 'Nobody above or beside you can approve'}
                  groups={delegateGroups(delegates)} />
              ) : (
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <span style={label}>Covered By</span>
                  <input className="form-input" disabled placeholder="Your manager, someone above them, or a peer" aria-label="Covered By" />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: '0 1 160px' }}>
                <span style={label}>From</span>
                <input type="date" className="form-input" value={start} min={minDay} max={maxDay || undefined}
                  onChange={e => setStart(e.target.value)} aria-label="From" />
              </label>
              <label style={{ flex: '0 1 160px' }}>
                <span style={label}>To</span>
                <input type="date" className="form-input" value={end} min={start || minDay} max={maxDay || undefined}
                  onChange={e => setEnd(e.target.value)} aria-label="To" />
              </label>
              <label style={{ flex: '1 1 220px' }}>
                <span style={label}>Note</span>
                <input className="form-input" value={note} maxLength={400} onChange={e => setNote(e.target.value)}
                  placeholder="Optional - e.g. on vacation" aria-label="Note" />
              </label>
              <button type="button" className="primary-btn" disabled={!ready || busy} onClick={submit}
                title={off ? undefined : `Available when ${whoseOff} approved time off`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <UserCheck size={14} /> {busy ? 'Saving...' : 'Delegate'}
              </button>
            </div>
          </fieldset>
          {end && start && end < start && <div style={{ fontSize: 12, color: '#b91c1c' }}>The last day is before the first day.</div>}
          {problem && <div style={{ fontSize: 12, color: '#b91c1c' }}>{problem}</div>}
        </>
      )}
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
        {(d.warnings || []).map(w => (
          <div key={w} data-delegation-warning style={{ display: 'flex', alignItems: 'flex-start', gap: 5, fontSize: 12, color: '#b45309', marginTop: 3 }}>
            <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} /> {w}
          </div>
        ))}
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
  const [open, setOpen] = useState(false);     // collapsed by default (Neil, Oct 20)
  const load = useCallback(() => {
    api.approvalDelegationsMine().then(setData).catch(() => setData({ canDelegate: false, delegations: [], covering: [] }));
  }, []);
  useEffect(load, [load]);
  const mine = useMemo(() => data?.delegations || [], [data]);
  const covering = useMemo(() => data?.covering || [], [data]);

  if (!data) return null;          // only approvers get the card - nothing to hold a place for
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

  const current = mine.length + covering.length;
  const warned = [...mine, ...covering].some(d => (d.warnings || []).length);
  return (
    <div className="dash-card" data-card="delegate-approvals" style={{ marginBottom: 12 }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' }}>
        {open ? <ChevronDown size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
        <UserCheck size={15} style={{ color: 'var(--wk-brand, hsl(var(--color-blue)))', flexShrink: 0 }} />
        <span style={{ fontWeight: 800, fontSize: 14 }}>Delegate My Approvals</span>
        {current > 0 && <StatusLabel size="sm" label={`${current} Current`} color={warned ? '#b45309' : '#2563eb'} />}
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 4 }}>
          {data.canDelegate ? 'Off for a while? Your manager or a peer approves for you on the days you are off.'
            : 'Approvals you cover for someone who is off.'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          {data.canDelegate && (
            <>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
                For the days you are off, your team's time sheets, punch fixes and time off also go to the person you
                pick - your manager, someone above them, or a peer. You keep yours.
              </p>
              <DelegationForm onSave={save} busy={busy} />
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
            <div style={{ marginTop: data.canDelegate ? 14 : 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>You Are Covering</div>
              {/* The stand-in may end it too - the delegator is told. */}
              {covering.map(d => <DelegationRow key={d.id} d={d} who={d.delegatorName || d.delegatorEmail} onRevoke={revoke} busy={busy} revokeLabel="Stop Covering" />)}
            </div>
          )}
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
        Who covers whose approvals, and when. Set one for someone on approved time off who could not set it themselves -
        it goes up or across, never to their own team.
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
