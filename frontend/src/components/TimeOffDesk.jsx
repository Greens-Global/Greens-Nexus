import { Fragment, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { CalendarOff, CalendarDays, Scale, Users, History as HistoryIcon, Inbox, Search, Plus, Lock, Check, X, Download } from 'lucide-react';
import { formatDate } from '../lib/datetime';
import { downloadCsv, csvName } from '../operations/csv';
import { leaveRequestDays, fmtDays } from '../lib/workdayStats';
import { TIMEOFF_FILTERS, countByStatus, filterAndSortTimeoff, nextSort, yearsOf, inPeriod } from '../lib/timeOffFilter';
import { Avatar, AvatarName } from '../tasks/components';
import { ErrorBanner, SkeletonBlocks } from './AsyncState';
import { ForChip, ApprovalDelegationsAdmin } from './DelegateApprovals';
import LeaveBalancesAdmin from './LeaveBalances';
import LeaveHistory from './LeaveHistory';

const TeamLeaveCalendar = lazy(() => import('./TeamLeaveCalendar'));
const LeaveYearEndPreview = lazy(() => import('./LeaveYearEnd').then(m => ({ default: m.LeaveYearEndPreview })));

// Time Off Desk - version B exploration (11/03/2026, frontend-design pass).
// Its own small visual world, scoped under .tob: a slate-and-leaf palette, a
// vertical section rail, a decision queue whose rows arrive in a cascade and
// slide away when decided, and a hairline ledger for the record. One bold
// element (the queue); everything else stays quiet. Reduced motion turns
// every animation off.

const STATUS = {
  pending: ['Pending', 'var(--tob-amber)'],
  approved: ['Approved', 'var(--tob-accent)'],
  rejected: ['Rejected', 'var(--tob-red)'],
  cancelled: ['Cancelled', 'var(--tob-faint)'],
};

function Confidential() {
  return (
    <span title="Confidential - the note is visible only to the employee and their approver" aria-label="Confidential"
      style={{ display: 'inline-flex', color: 'var(--tob-faint)', marginLeft: 5, verticalAlign: -1 }}><Lock size={11} /></span>
  );
}

export default function TimeOffDesk({ rows, err, onRetry, onDecide, onRequestOnBehalf, hrPanels, hrTeam, toastOk, toastErr, myEmail }) {
  const [section, setSection] = useState('requests');
  // A section loads once and stays mounted (11/03/2026: Balances took its
  // full load every visit) - switching back is instant.
  const [visited, setVisited] = useState(() => new Set(['requests']));
  const openSection = (k) => { setSection(k); setVisited(v => (v.has(k) ? v : new Set(v).add(k))); };
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState(null);
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [query, setQuery] = useState('');
  const [leaving, setLeaving] = useState(() => new Set());
  const reduce = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches).current;

  const waiting = useMemo(() => rows.filter(r => r.status === 'pending' && r.canDecide !== false), [rows]);
  // A name reads like a name, never a raw email (the email stays as the tooltip).
  const who = (r) => r.name || (r.email || '').split('@')[0].replace(/\./g, ' ');
  const todayIso = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  // Who is out right now - the context an approver checks before anything else.
  const offToday = useMemo(() => {
    const names = new Set();
    rows.forEach(o => { if (o.status === 'approved' && o.startDate && o.startDate <= todayIso && todayIso <= (o.endDate || o.startDate)) names.add(who(o)); });
    return [...names];
  }, [rows]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Approved leave that overlaps a pending request's days - the clash an
  // approver would otherwise open the calendar to find.
  const overlapsOf = (r) => {
    if (!r.startDate) return [];
    const names = new Set();
    rows.forEach(o => {
      if (o.id !== r.id && o.status === 'approved' && (o.email || '') !== (r.email || '')
        && o.startDate && o.startDate <= (r.endDate || r.startDate) && r.startDate <= (o.endDate || o.startDate)) names.add(who(o));
    });
    return [...names];
  };
  const q = query.trim().toLowerCase();
  const inRange = useMemo(() => rows.filter(r => inPeriod(r, year, month)
    && (!q || (r.name || r.email || '').toLowerCase().includes(q) || (r.type || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q))),
    [rows, year, month, q]);
  const counts = countByStatus(inRange);
  const shown = filterAndSortTimeoff(inRange, filter, sort);

  // The row slides away first, then the decision is made - motion that
  // answers the action. Reduced motion decides at once.
  const decide = (id, status) => {
    if (reduce) { onDecide(id, status); return; }
    setLeaving(prev => new Set(prev).add(id));
    setTimeout(() => { onDecide(id, status); setLeaving(prev => { const n = new Set(prev); n.delete(id); return n; }); }, 180);
  };

  const sections = [
    ['requests', 'Requests', Inbox, waiting.length],
    ['calendar', 'Calendar', CalendarDays, 0],
    ...(hrPanels && !hrTeam ? [
      ['balances', 'Balances', Scale, 0],
      ['delegations', 'Delegations', Users, 0],
      ['history', 'History', HistoryIcon, 0],
    ] : []),
  ];

  const sortHead = (key, label) => {
    const on = sort?.key === key;
    return (
      <button type="button" onClick={() => setSort(cur => nextSort(cur, key))} title={`Sort by ${label}`}
        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
          color: on ? 'var(--tob-ink)' : 'inherit', fontWeight: on ? 700 : 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}<span aria-hidden="true" style={{ fontSize: 11, opacity: on ? 1 : 0.35 }}>{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    );
  };

  const period = (r) => {
    const hm12 = (v) => { const [h, m] = (v || '').split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
    return `${formatDate(r.startDate, r.startDate)} - ${formatDate(r.endDate, r.endDate)}${r.startTime && r.endTime ? ` · ${hm12(r.startTime)} - ${hm12(r.endTime)}` : ''}`;
  };

  return (
    <div className="tob">
      <div className="tob-shell">
        <nav className="tob-rail" role="tablist" aria-label="Time Off sections" aria-orientation="vertical">
          {sections.map(([k, label, Icon, n]) => (
            <button key={k} type="button" role="tab" aria-selected={section === k} onClick={() => openSection(k)}>
              <Icon size={15} /> {label}
              {n > 0 && <span className="tob-n" title="Waiting on your decision">{n}</span>}
            </button>
          ))}
        </nav>

        <div style={{ minWidth: 0 }}>
          {visited.has('requests') && (
          <div className={section === 'requests' ? 'tob-view' : undefined} style={section === 'requests' ? undefined : { display: 'none' }}>
            <>
              <div className="tob-head" style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ marginRight: 'auto' }}>
                  {/* No "Time Off" heading under the Time Off tab (11/13/2026). */}
                  <p>
                    {waiting.length === 0 ? 'Nothing is waiting on you.' : waiting.length === 1 ? 'One request is waiting on you.' : `${waiting.length} requests are waiting on you.`}
                    {offToday.length > 0 && (
                      <span title={offToday.slice(0, 8).join(', ')}>
                        {' '}{offToday.length === 1 ? `${offToday[0]} is off today.` : `${offToday.length} people are off today.`}
                      </span>
                    )}
                  </p>
                </div>
                <div style={{ position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--tob-faint)' }} />
                  <input className="tob-in" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name"
                    aria-label="Search time-off requests" style={{ paddingLeft: 30, width: 190 }} />
                </div>
                <select className="tob-in" aria-label="Year" value={year} onChange={e => setYear(e.target.value)}>
                  <option value="">All Years</option>
                  {yearsOf(rows).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <select className="tob-in" aria-label="Month" value={month} onChange={e => setMonth(e.target.value)}>
                  <option value="">All Months</option>
                  {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
                    .map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
                </select>
                <button type="button" className="tob-no" style={{ color: 'var(--tob-ink)' }} onClick={onRequestOnBehalf}>
                  <Plus size={13} /> Request on Behalf
                </button>
              </div>

              {waiting.length > 0 && (
                <div className="tob-queue">
                  <div className="tob-q-head"><b>Decide</b><span>approving sends it on; rejecting asks you for a note</span></div>
                  {/* One person, one block (11/03/2026): someone with several
                      requests shows once, their requests stacked under the
                      name - never the same face repeated down the queue. */}
                  {(() => {
                    const groups = [];
                    const idx = new Map();
                    waiting.slice(0, 40).forEach(r => {
                      const k = (r.email || r.name || '?').toLowerCase();
                      if (!idx.has(k)) { idx.set(k, groups.length); groups.push({ key: k, first: r, reqs: [] }); }
                      groups[idx.get(k)].reqs.push(r);
                    });
                    let row = -1;
                    const reqLine = (r) => {
                      const d = leaveRequestDays(r);
                      const ov = overlapsOf(r);
                      return (<>
                        <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13, color: 'var(--tob-dim)', fontVariantNumeric: 'tabular-nums' }}>
                          <span style={{ color: 'var(--tob-ink)', fontWeight: 600, textTransform: 'capitalize' }}>{r.type || 'Time off'}</span>
                          {r.confidential && <Confidential />}
                          {' '}· {period(r)} · {fmtDays(d)} {d === 1 ? 'day' : 'days'}{r.note ? ` · "${r.note}"` : ''}
                        </div>
                        {ov.length > 0 && (
                          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tob-amber)', whiteSpace: 'nowrap' }}
                            title={`Also approved off in this period: ${ov.slice(0, 6).join(', ')}${ov.length > 6 ? '...' : ''}`}>
                            {ov.length === 1 ? `${ov[0]} is also off then` : `${ov.length} others are off then`}
                          </span>
                        )}
                        {r.awaitingHr && <span style={{ fontSize: 11, color: 'var(--tob-dim)' }} title={`Approved by ${r.firstApproverName || r.firstApprover || 'the manager'}`}>HR Approval</span>}
                        <button type="button" className="tob-no" onClick={() => decide(r.id, 'rejected')}><X size={13} /> Reject</button>
                        <button type="button" className="tob-ok" onClick={() => decide(r.id, 'approved')}><Check size={13} /> Approve</button>
                      </>);
                    };
                    return groups.map((g) => {
                      row += 1;
                      return (
                        <div key={g.key} className={`tob-q-row${g.reqs.every(r => leaving.has(r.id)) ? ' tob-out' : ''}`}
                          style={{ animationDelay: `${Math.min(row * 35, 280)}ms`, alignItems: 'flex-start' }}>
                          <Avatar email={g.first.email} name={who(g.first)} size={28} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, fontWeight: 700, textTransform: 'capitalize' }} title={g.first.email}>{who(g.first)}</span>
                              {g.first.forEmail && <ForChip name={g.first.forName} email={g.first.forEmail} />}
                              {g.reqs.length > 1 && <span style={{ fontSize: 12, color: 'var(--tob-dim)' }}>{g.reqs.length} requests</span>}
                            </div>
                            {g.reqs.map((r) => (
                              <div key={r.id} className={leaving.has(r.id) ? 'tob-out' : undefined}
                                style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '5px 0 2px' }}>
                                {reqLine(r)}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '16px 2px 0', flexWrap: 'wrap' }}>
                {TIMEOFF_FILTERS.filter(([k]) => k !== 'cancelled' || counts.cancelled > 0 || filter === 'cancelled').map(([k, label]) => (
                  <button key={k} type="button" className="tob-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {label} ({counts[k]})
                  </button>
                ))}
                <button type="button" className="tob-chip" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  title="Download what the table shows as a spreadsheet"
                  onClick={() => downloadCsv(csvName('Time Off', filter === 'all' ? '' : filter, todayIso),
                    ['Requested By', 'Type', 'First Day', 'Last Day', 'Days', 'Approver', 'Status', 'Reason'],
                    shown.map(r => [who(r), r.type || 'Time off', formatDate(r.startDate, r.startDate), formatDate(r.endDate, r.endDate),
                      r.startDate ? fmtDays(leaveRequestDays(r)) : '', r.approverName || r.approver || '',
                      (STATUS[r.status] || [r.status])[0], r.redacted ? 'Confidential' : (r.note || '')]))}>
                  <Download size={12} /> Download CSV
                </button>
              </div>
              <div className="tob-ledger">
                <div className="tob-grid tob-lhead">
                  <span>{sortHead('name', 'Requested By')}</span><span>Type</span><span>{sortHead('period', 'Period')}</span>
                  <span>Days</span><span>Approver</span><span style={{ textAlign: 'right' }}>{sortHead('status', 'Status')}</span>
                </div>
                {err ? (
                  <div style={{ padding: '14px 16px' }}><ErrorBanner message="Couldn't load time-off requests right now." onRetry={onRetry} /></div>
                ) : shown.length === 0 && (
                  <div style={{ padding: '22px 16px', fontSize: 13, color: 'var(--tob-dim)', textAlign: 'center' }}>
                    {rows.length === 0 ? 'No time-off requests yet.' : q ? 'Nothing matches your search.' : year || month ? 'No requests in that period.' : `No ${filter === 'all' ? '' : filter + ' '}requests.`}
                  </div>
                )}
                {/* One person, one block here too (11/03/2026): with no sort
                    picked the register clubs a person's requests under one
                    name; clicking a sort header flattens it for comparison. */}
                {(() => {
                  const list = shown.slice(0, 200);
                  const row = (r, showWho) => {
                  const d = leaveRequestDays(r);
                  const [word, color] = STATUS[r.status] || [r.status, 'var(--tob-dim)'];
                  return (
                    <div key={r.id} className="tob-grid" style={{ fontSize: 13 }}>
                      {showWho ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontWeight: 600 }}>
                          <Avatar email={r.email} name={who(r)} size={22} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'capitalize' }} title={r.email}>{who(r)}{r.forEmail && <ForChip name={r.forName} email={r.forEmail} />}</span>
                        </span>
                      ) : <span aria-hidden="true" />}
                      <span style={{ textTransform: 'capitalize', color: 'var(--tob-dim)' }}>{r.type || 'Time off'}{r.confidential && <Confidential />}</span>
                      <span style={{ color: 'var(--tob-dim)', fontVariantNumeric: 'tabular-nums' }} title={r.note || undefined}>
                        {period(r)}{r.note ? ` · "${r.note}"` : ''}
                        {r.requestedBy && r.requestedBy !== r.email && (
                          <span style={{ fontStyle: 'italic' }}> · filed by <AvatarName email={r.requestedBy} name={r.requestedByName || r.requestedBy.split('@')[0].replace(/\./g, ' ')} size={16} /></span>
                        )}
                      </span>
                      <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} title="Working days (Mon-Fri)">{r.startDate ? fmtDays(d) : '-'}</span>
                      <span style={{ color: 'var(--tob-dim)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        {r.approver ? (<>
                          <Avatar email={r.approver} name={r.approverName || r.approver.split('@')[0].replace(/\./g, ' ')} size={18} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.approverName || r.approver.split('@')[0].replace(/\./g, ' ')}</span>
                        </>) : '-'}
                      </span>
                      <span style={{ textAlign: 'right', fontWeight: 600, color }}>
                        {r.status === 'pending' && r.canDecide === false
                          ? <span style={{ fontSize: 11, color: 'var(--tob-dim)', fontWeight: 500 }}>{r.awaitingHr ? 'Awaiting HR Approval' : r.reviewer ? `${r.reviewer} decides` : 'Your manager decides'}</span>
                          : (<><span className="tob-dot" style={{ background: color }} />{word}</>)}
                      </span>
                    </div>
                  );
                  };
                  if (sort !== null) return list.map(r => row(r, true));
                  const groups = []; const gi = new Map();
                  list.forEach(r => {
                    const k = (r.email || r.name || '?').toLowerCase();
                    if (!gi.has(k)) { gi.set(k, groups.length); groups.push([]); }
                    groups[gi.get(k)].push(r);
                  });
                  return groups.map(rs => rs.length === 1 ? row(rs[0], true) : (
                    <Fragment key={`g-${rs[0].email || rs[0].name}`}>
                      <div className="tob-grid" style={{ fontSize: 13, backgroundImage: 'linear-gradient(var(--tob-paper), var(--tob-paper))' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontWeight: 700 }}>
                          <Avatar email={rs[0].email} name={who(rs[0])} size={22} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'capitalize' }} title={rs[0].email}>{who(rs[0])}</span>
                        </span>
                        <span />
                        <span style={{ color: 'var(--tob-dim)' }}>{rs.length} requests · {fmtDays(rs.reduce((a, r) => a + (r.startDate ? leaveRequestDays(r) : 0), 0))} days</span>
                        <span /><span /><span />
                      </div>
                      {rs.map(r => row(r, false))}
                    </Fragment>
                  ));
                })()}
                {shown.length > 200 && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--tob-dim)', textAlign: 'center' }}>Showing 200 of {shown.length} - filter to narrow down.</div>}
              </div>
            </>
          </div>
          )}
          {visited.has('calendar') && (
          <div className={section === 'calendar' ? 'tob-view' : undefined} style={section === 'calendar' ? undefined : { display: 'none' }}>
            <div className="tob-head" style={{ marginBottom: 14 }}>
              <h2>Calendar</h2>
              <p>{offToday.length === 0 ? 'Nobody is off today.' : offToday.length === 1 ? `${offToday[0]} is off today.` : `Off today: ${offToday.slice(0, 5).join(', ')}${offToday.length > 5 ? ` and ${offToday.length - 5} more` : ''}.`}</p>
            </div>
            <Suspense fallback={<SkeletonBlocks count={1} height={220} />}><TeamLeaveCalendar embedded /></Suspense>
          </div>
          )}
          {visited.has('balances') && hrPanels && !hrTeam && (
          <div className={section === 'balances' ? 'tob-view' : undefined} style={section === 'balances' ? undefined : { display: 'none' }}>
            <div className="tob-head" style={{ marginBottom: 14 }}>
              <h2>Balances</h2>
              <p>Each person's leave balances, with the year-end carryover preview.</p>
            </div>
            <Suspense fallback={<SkeletonBlocks count={1} height={120} />}><LeaveYearEndPreview toastOk={toastOk} toastErr={toastErr} /></Suspense>
            <LeaveBalancesAdmin toastOk={toastOk} toastErr={toastErr} />
          </div>
          )}
          {visited.has('delegations') && hrPanels && !hrTeam && (
          <div className={section === 'delegations' ? 'tob-view' : undefined} style={section === 'delegations' ? undefined : { display: 'none' }}>
            <div className="tob-head" style={{ marginBottom: 14 }}>
              <h2>Delegations</h2>
              <p>Who approves in someone's place while they are away.</p>
            </div>
            <ApprovalDelegationsAdmin toastOk={toastOk} toastErr={toastErr} />
          </div>
          )}
          {visited.has('history') && hrPanels && !hrTeam && (
          <div className={section === 'history' ? 'tob-view' : undefined} style={section === 'history' ? undefined : { display: 'none' }}>
            <div className="tob-head" style={{ marginBottom: 14 }}>
              <h2>History</h2>
              <p>The leave record kept from before requests moved here - read-only.</p>
            </div>
            <LeaveHistory />
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
