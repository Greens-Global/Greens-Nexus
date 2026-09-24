import { useState } from 'react';
import { fmtLong, fmtMD, mEnd, monthLong, MONTH_SHORT, mShort, shiftKey, whenTxt } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { RECON_TYPES } from '../../../accounting/dashboard/model/recon';
import { BAD, Chip, EmptyBox, Footnote, GroupRow, LoadingBox, Meter, input, mono, num, toneColor } from './Bits';
import { useDash } from './DashContext';
import { useActivity, useCloseState, useDeadlines, useFlux, useIntercompany, useRecon } from './hooks';

// Close and controls widgets: the close card, reconciliations, activity,
// intercompany, balance-sheet flux, and the filing calendar.

export function CloseWidget({ onOpenClose }) {
  const { period, act } = useDash();
  const { state, isLoading } = useCloseState();
  const [busy, setBusy] = useState(null);
  if (isLoading || !state) return <LoadingBox />;
  if (!state.n) return <EmptyBox title="No close plan yet" body="Add the close checklist under the Data tab." />;
  const open = state.rows.filter((r) => !r.done);
  const complete = async (r) => {
    setBusy(r.id);
    try { await act('close-task', { period, task_id: r.id, done: true, detail: `${r.title} · ${monthLong(period)}` }); } finally { setBusy(null); }
  };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.84rem' }}><span>{monthLong(period)} · target day 10</span><span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{state.nDone}/{state.n}</span></div>
      <Meter segments={state.phases.map((p) => ({ share: p.rows.length / state.n, color: p.done === p.rows.length ? 'var(--wk-brand, #2b45e1)' : p.done ? '#0998c3' : 'var(--border-color)', title: `${p.phase}: ${p.done}/${p.rows.length}` }))} />
      {open.length ? (
        <div>
          {open.slice(0, 5).map((r, i) => (
            <label key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: 'pointer', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
              <input type="checkbox" checked={false} disabled={busy === r.id} onChange={() => complete(r)} aria-label={`Complete ${r.title}`} style={{ marginTop: 3 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: '0.84rem', lineHeight: 1.3 }}>{r.title}</span>
                <span style={{ fontSize: '0.7rem', color: r.state === 'past_due' ? BAD : 'var(--text-muted)' }}>{r.owner} · day {r.day_offset}{r.state === 'past_due' ? ' · past due' : ''}</span>
              </span>
              <Chip>{r.phase}</Chip>
            </label>
          ))}
          {open.length > 5 ? <div style={{ paddingTop: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>+{open.length - 5} more open</div> : null}
        </div>
      ) : <div style={{ fontSize: '0.84rem', color: toneColor(true) }}>Closed - package delivered</div>}
      {onOpenClose ? <button type="button" onClick={onOpenClose} style={{ alignSelf: 'flex-start', border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: '0.74rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>Open the Close tab →</button> : null}
    </div>
  );
}

// The bookkeeper's reconciliation list (Charmi, Sep 23): per entity, every
// bank and card account with its last reconciled date, the statement
// (reconciled) balance recorded then, and the current book balance. Marking
// an account asks for the statement date and balance so "last reconciled"
// means something next month too.
export function ReconWidget({ compact }) {
  const { period, act, m, ix } = useDash();
  const { rows, reconciled, remaining, isLoading } = useRecon();
  const [busy, setBusy] = useState(null);
  const [marking, setMarking] = useState(null);   // { key, thru, stmt }
  const [error, setError] = useState('');
  if (isLoading) return <LoadingBox />;
  if (!rows.length) return <EmptyBox title="No accounts to reconcile" body="Bank and credit card accounts with activity in this scope appear here, plus loans and brokerage accounts from the Data tab." />;
  const mark = async (r, extra) => {
    setBusy(r.key);
    setError('');
    try {
      await act('recon-mark', { period, key: r.key, ...extra, detail: `${r.name}${r.ref ? ` (${r.ref})` : ''} · ${monthLong(period)}${extra?.thru ? ` · through ${fmtLong(extra.thru)}` : ''}` });
      setMarking(null);
    } catch (e) { setError(e?.message || 'Could not mark the account.'); } finally { setBusy(null); }
  };
  const submitMark = (r) => {
    if (!marking || marking.key !== r.key) return;
    const stmt = marking.stmt.trim() === '' ? null : Number(marking.stmt.replace(/[,$\s]/g, ''));
    if (stmt != null && !Number.isFinite(stmt)) { setError('Statement balance must be a number.'); return; }
    mark(r, { thru: marking.thru || null, stmt_balance: stmt });
  };
  const byType = RECON_TYPES.map((t) => ({ t, rows: rows.filter((r) => r.type === t) })).filter((g) => g.rows.length);
  const cols = compact ? 7 : 8;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div><span style={{ fontSize: '1.05rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{reconciled} of {rows.length}</span> <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>completed · {remaining} remaining · through {fmtLong(mEnd(period))}</span></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{byType.map((g) => <span key={g.t}>{g.t}: {g.rows.filter((r) => r.status === 'Reconciled').length}/{g.rows.length}</span>)}</div>
      </div>
      <Meter segments={[{ share: rows.length ? reconciled / rows.length : 0, color: 'var(--wk-brand, #2b45e1)' }]} />
      {error && <div style={{ fontSize: '0.8rem', color: BAD }}>{error}</div>}
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Account</th>{!compact ? <th>Entity</th> : null}<th>Last Reconciled</th><th style={num}>Reconciled Balance</th><th style={num}>Current Balance</th><th style={num}>Difference</th><th>Status</th><th /></tr></thead>
          <tbody>
            {byType.map((g) => (
              <GroupRows key={g.t} title={`${g.t} Accounts`} cols={cols}>
                {g.rows.map((r) => {
                  const editing = marking?.key === r.key;
                  return (
                    <tr key={r.key} style={r.nc ? { color: 'var(--text-muted)' } : undefined}>
                      <td><div>{r.name}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.gl ? `GL ${r.gl}` : r.ref}{r.nc ? ' · Non-controllable' : ''}</div></td>
                      {!compact ? <td style={{ fontSize: '0.78rem' }}>{r.entityCode ? (ix.byCode.get(r.entityCode)?.name || r.entityCode) : r.ref || '-'}</td> : null}
                      <td style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{r.thru ? fmtLong(r.thru) : 'Never'}{r.mark ? <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.mark.marked_by} · {whenTxt(r.mark.marked_at)}</div> : null}</td>
                      <td style={num}>{r.thru ? m(r.stmt, { cents: true }) : '-'}</td>
                      <td style={num}>{m(r.book, { cents: true })}</td>
                      <td style={{ ...num, color: Math.abs(r.diff) >= 0.005 ? BAD : undefined }}>{Math.abs(r.diff) >= 0.005 ? m(r.diff, { cents: true }) : '-'}</td>
                      <td>{r.status === 'Reconciled' ? <Chip tone="ok">Reconciled</Chip> : <Chip tone={r.status === 'Difference' || r.status === 'Behind' ? 'bad' : 'wait'}>{r.status}</Chip>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.status === 'Reconciled' ? null : editing ? (
                          <form style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onSubmit={(e) => { e.preventDefault(); submitMark(r); }}>
                            <input type="date" value={marking.thru} max={mEnd(period)} onChange={(e) => setMarking({ ...marking, thru: e.target.value })} style={{ ...input, padding: '3px 6px', fontSize: '0.74rem' }} aria-label="Statement date" />
                            <input inputMode="decimal" value={marking.stmt} onChange={(e) => setMarking({ ...marking, stmt: e.target.value })} placeholder="Statement balance" style={{ ...input, padding: '3px 6px', fontSize: '0.74rem', width: 120, textAlign: 'right' }} aria-label="Statement balance" />
                            <button type="submit" className="primary-btn" style={{ fontSize: '0.7rem', padding: '3px 8px' }} disabled={busy === r.key}>Save</button>
                            <button type="button" className="secondary-btn" style={{ fontSize: '0.7rem', padding: '3px 8px' }} onClick={() => setMarking(null)}>Cancel</button>
                          </form>
                        ) : (
                          <button type="button" className="secondary-btn" style={{ fontSize: '0.7rem', padding: '2px 8px' }} disabled={busy === r.key} onClick={() => setMarking({ key: r.key, thru: mEnd(period), stmt: r.book ? r.book.toFixed(2) : '' })}>Mark reconciled</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </GroupRows>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ title, cols, children }) {
  return (<><GroupRow title={title} cols={cols} />{children}</>);
}

export function ActivityWidget() {
  const { rows, isLoading } = useActivity(10);
  if (isLoading) return <LoadingBox />;
  if (!rows.length) return <EmptyBox title="No activity yet" body="Tick a close step or mark an account reconciled and it shows up here for the team." />;
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: '0.84rem' }}>{r.what}</div><div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail}</div></div>
          <div style={{ flexShrink: 0, textAlign: 'right' }}><Chip>{r.by_name}</Chip><div style={{ marginTop: 2, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{whenTxt(r.at)}</div></div>
        </div>
      ))}
    </div>
  );
}

export function IcWidget() {
  const { m, ix } = useDash();
  const { rows, isLoading } = useIntercompany();
  if (isLoading) return <LoadingBox />;
  if (!rows.length) return <EmptyBox title="No intercompany balances for this scope" body="Record due-to and due-from pairs under the Data tab." />;
  const off = rows.filter((r) => !r.matched).length;
  const name = (c) => ix.byCode.get(c)?.name || c;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div>{off ? <Chip tone="bad">{off} out of balance</Chip> : <Chip tone="ok">All matched</Chip>}</div>
      <div>
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
            <div style={{ minWidth: 0 }}><div style={{ fontSize: '0.84rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(r.from_code)} → {name(r.to_code)}</div><div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{r.description}</div></div>
            <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8 }}><span style={{ fontSize: '0.84rem', fontVariantNumeric: 'tabular-nums' }}>{m(r.due_from, { compact: true })}</span>{r.matched ? <Chip tone="ok">Matched</Chip> : <Chip tone="bad">Off {m(r.difference)}</Chip>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FluxWidget() {
  const { m, period } = useDash();
  const { rows, hasPrior } = useFlux();
  if (!hasPrior) return <EmptyBox title="No prior month to compare." />;
  if (!rows.length) return <EmptyBox title="No changes above the review threshold" body="Balances that moved more than $25K or 10% month over month appear here." />;
  const pk = shiftKey(period, 1);
  return (
    <div className="req-table-wrapper">
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>Account</th><th style={num}>{mShort(pk)}</th><th style={num}>{mShort(period)}</th><th style={num}>Change</th><th style={num}>%</th></tr></thead>
        <tbody>
          {rows.slice(0, 10).map((r) => (
            <tr key={r.id}>
              <td><span style={mono}>{r.gl}</span>{r.name}</td>
              <td style={{ ...num, color: 'var(--text-muted)' }}>{m(r.prior, { paren: true })}</td>
              <td style={num}>{m(r.balance, { paren: true })}</td>
              <td style={{ ...num, fontWeight: 600, color: toneColor(r.change >= 0) }}>{m(r.change, { paren: true })}</td>
              <td style={{ ...num, fontSize: '0.76rem', color: 'var(--text-muted)' }}>{r.prior ? pctTxt(r.changePct, 0) : 'new'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DeadlinesWidget() {
  const { items, isLoading } = useDeadlines(6);
  if (isLoading) return <LoadingBox />;
  if (!items.length) return <EmptyBox title="No deadlines on the calendar" body="Add filings and payment dates under the Data tab." />;
  return (
    <div>
      {items.map(({ deadline, date, days }, i) => (
        <div key={deadline.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
          <div style={{ width: 40, flexShrink: 0, textAlign: 'center' }}><div style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{MONTH_SHORT[Number(date.slice(5, 7)) - 1]}</div><div style={{ fontSize: '1.1rem', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{Number(date.slice(8, 10))}</div></div>
          <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: '0.84rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deadline.title}</div><div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{deadline.owner}</div></div>
          <Chip tone={days <= 7 ? 'bad' : days <= 30 ? 'wait' : 'neutral'}>{days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`}</Chip>
        </div>
      ))}
      <Footnote>Standard due dates. Confirm entity-specific deadlines with your CPA. Next: {fmtMD(items[0].date)}.</Footnote>
    </div>
  );
}
