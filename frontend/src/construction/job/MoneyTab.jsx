// The Job page's Money tab (Neil, 11/03/2026, plan phase 4 "Money"). Managers
// and above with Accounting access to the entity the job books to - the
// server decides (routers/construction_money.py) and anyone else never gets
// the tab or a figure. Lazy: its own chunk, with the Accounting side panel.
//
// What is POSTED (Actual to Date, from the books by the job's Intacct
// Project-Job) opens its ledger lines in the Accounting side panel
// (LinesPanel - lineQuery with `project=`) and every line opens its journal
// entry (EntryDetail). What is worked out (Forecast at Completion, Variance,
// Percent Spent) or kept in Nexus (the budget from the job's contract value,
// changes, requests not yet billed) stays plain and says where it comes from.
// Every table's columns resize, kept per person (useColumnWidths).
import { lazy, Suspense, useState } from 'react';
import { Landmark, Pencil, Plus } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import ProgressTrack from '../../ui/ProgressTrack';
import Amount from '../../components/accounting/Amount';
import { ColumnResizer } from '../../components/accounting/reportControls';
import { useColumnWidths } from '../../components/accounting/tableHooks';
import { cellStyle, headStyle } from '../../components/accounting/columnStyles';
import { formatDate } from '../../lib/datetime';
import { CARD, TONE } from '../ui';
import { REQUEST_STAGE, WAIVER_KIND, spendTrack, usd } from '../lib/money';
import ActualLines from './ActualLines';

// Its own chunk: only a manager adding or opening a commitment loads it.
const CommitmentSheet = lazy(() => import('./CommitmentSheet'));

const quiet = { fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 };
const h3 = { fontSize: '0.98rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' };
const STAGE_TONE = { requested: TONE.yellow, posting: TONE.blue, received: TONE.blue, paid: TONE.green };

function Figure({ label, value, hint, onDrill, testId, tone }) {
  const text = value == null ? '-' : usd(value);
  return (
    <div data-money-figure={testId} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-card)' }}>
      <span style={{ fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
      {onDrill && value != null ? (
        <button type="button" className="acct-drill" onClick={onDrill} title="See the ledger lines behind this amount" aria-label={`Ledger lines behind ${label}`}
          style={{ border: 'none', background: 'none', margin: 0, padding: 0, fontFamily: 'inherit', cursor: 'pointer', fontSize: '1.2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', textAlign: 'left', width: 'fit-content', color: tone || 'var(--text-primary)', textDecoration: 'underline', textDecorationColor: 'var(--border-color)', textUnderlineOffset: 4 }}>{text}</button>
      ) : (
        <span style={{ fontSize: '1.2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: tone || 'var(--text-primary)' }}>{text}</span>
      )}
      {hint && <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{hint}</span>}
    </div>
  );
}

/** A table with resizable columns kept per person: `cols` [{key, label, width, num}]. */
function Table({ tableKey, label, cols, children }) {
  const widths = useColumnWidths(tableKey, Object.fromEntries(cols.map((c) => [c.key, c.width])), { min: 60 });
  return (
    <div className="acct-report-wrap" style={{ background: 'var(--bg-card)', maxHeight: 'none' }}>
      <table className="acct-report" aria-label={label} style={{ width: '100%' }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} scope="col" className={c.num ? 'acct-num' : undefined} style={headStyle(widths.width(c.key))}>
                {c.label}<ColumnResizer {...widths.resizer(c.key, c.label)} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children(widths)}</tbody>
      </table>
    </div>
  );
}

const ACTUAL_COLS = (by) => [
  { key: 'code', label: by === 'item' ? 'Cost Code' : 'GL Account', width: 240 },
  { key: 'accounts', label: 'Accounts', width: 280 },
  { key: 'amount', label: 'Actual to Date', width: 140, num: true },
  { key: 'share', label: 'Share of Actual', width: 120, num: true },
];
const CHANGE_COLS = [
  { key: 'number', label: 'Number', width: 100 }, { key: 'title', label: 'Change', width: 280 },
  { key: 'status', label: 'Status', width: 130 }, { key: 'amount', label: 'Amount', width: 130, num: true },
];
const RB_COLS = [
  { key: 'item', label: 'Reimbursement', width: 240 }, { key: 'by', label: 'Requested By', width: 170 },
  { key: 'date', label: 'Purchase Date', width: 120 }, { key: 'stage', label: 'Status', width: 190 },
  { key: 'amount', label: 'Amount', width: 120, num: true },
];
const PR_COLS = [
  { key: 'item', label: 'Purchase Request', width: 240 }, { key: 'qty', label: 'Quantity', width: 90, num: true },
  { key: 'by', label: 'Requested By', width: 170 }, { key: 'date', label: 'Requested', width: 120 },
  { key: 'stage', label: 'Status', width: 190 },
];

// Commitments (Round Two item 8, 11/06/2026): subcontracts and purchase
// orders with Intacct's vendors; Billed to Date is the books' (the job's
// Project-Job lines for that vendor) and opens them; Remaining and Retainage
// Held are worked out.
const COMMIT_COLS = [
  { key: 'number', label: 'Number', width: 90 }, { key: 'vendor', label: 'Vendor', width: 200 },
  { key: 'title', label: 'Scope', width: 220 }, { key: 'amount', label: 'Amount', width: 130, num: true },
  { key: 'billed', label: 'Billed to Date', width: 130, num: true }, { key: 'remaining', label: 'Remaining', width: 120, num: true },
  { key: 'retainage', label: 'Retainage Held', width: 120, num: true }, { key: 'waiver', label: 'Lien Waiver', width: 220 },
];

const pct = (v) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;

export default function MoneyTab({ project, money, onEdit }) {
  const { data: m, error, reload } = money;
  const [lines, setLines] = useState(null);   // { row } - null row = the total
  const [sheet, setSheet] = useState(null);   // null | 'new' | a commitment id

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!m) return <SkeletonBlocks count={3} height={110} borderRadius={12} />;
  if (!m.allowed) return <div style={{ ...CARD, ...quiet }}>{m.reason || 'Money is not available on this job.'}</div>;

  const link = m.link || {};
  const actual = m.actual;
  const track = spendTrack(m);
  const open = (row = null) => setLines({ row });
  const spend = m.spend || { purchaseRequests: [], reimbursements: [] };
  const changes = m.changes || { rows: [], approved: 0, pending: 0 };
  const commits = m.commitments || { rows: [], total: 0, open: 0 };
  const openCommit = sheet && sheet !== 'new' ? commits.rows.find((c) => c.id === sheet) : null;

  return (
    <div className="acct-module" data-money-tab={project.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Landmark size={16} style={{ color: 'var(--text-secondary)' }} />
          <h3 style={h3}>Money</h3>
          {m.mapped && (
            <span style={quiet}>
              From the books - Project-Job <b>{link.project}</b> on {link.entityName ? `${link.entityName} (${link.entity})` : link.entity}, posted through {formatDate(m.asOf, m.asOf)}
            </span>
          )}
          {m.canMap && onEdit && (
            <button type="button" className="secondary-btn" onClick={onEdit} style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: '0.8rem' }}>
              <Pencil size={13} />{m.mapped ? 'Change Mapping' : 'Map to the Books'}
            </button>
          )}
        </div>
        {!m.mapped && (
          <div data-money-unmapped="" style={quiet}>
            This job is not linked to the books yet. Map it to its Intacct Project-Job on Edit Job to read its actual cost; until then only what is kept in Nexus shows here.
          </div>
        )}
        {m.booksError && <ErrorBanner message={m.booksError} onRetry={reload} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Figure testId="budget" label="Budget" value={m.budget?.amount || null}
            hint={m.budget?.amount ? `The job's contract value${m.budget.approvedChanges ? ' plus approved changes' : ''}. Not in the books by Project-Job.` : 'Set a contract value on Edit Job.'} />
          <Figure testId="committed" label="Requested, Not Yet Billed" value={m.committed?.amount ?? 0}
            hint={`Reimbursements on this job their approver approved and HR has not yet${m.committed?.purchaseRequests ? `; ${m.committed.purchaseRequests === 1 ? '1 open purchase request carries' : `${m.committed.purchaseRequests} open purchase requests carry`} no amount` : ''}.`} />
          <Figure testId="commitments" label="Committed" value={commits.total}
            hint={commits.rows.length ? `${commits.rows.length === 1 ? '1 subcontract or purchase order' : `${commits.rows.length} subcontracts and purchase orders`}; ${usd(commits.open)} not billed yet${commits.billedKnown ? '' : ' (the books are read once the job is mapped)'}.` : 'No subcontract or purchase order on this job yet.'} />
          <Figure testId="actual" label="Actual to Date" value={actual ? actual.amount : null}
            hint={actual ? 'Posted cost on this Project-Job. Open it for the ledger lines.' : 'Read from the books once the job is mapped.'}
            onDrill={actual ? () => open() : null} />
          <Figure testId="approved" label="Approved Changes" value={changes.approved} hint="Approved change orders on this job." />
          <Figure testId="pending" label="Pending Changes" value={changes.pending} hint="Change orders not decided yet." />
          <Figure testId="forecast" label="Forecast at Completion" value={m.forecast}
            hint="Worked out: the larger of the budget with its pending changes and actual to date plus commitments not billed yet plus requested, not yet billed." />
          {m.variance != null && (
            <Figure testId="variance" label="Variance" value={m.variance} tone={m.variance < 0 ? 'hsl(var(--color-red))' : undefined}
              hint="Worked out: budget less the forecast." />
          )}
          {/* Round Two (11/05/2026): the owner-builder's benchmark - the same
              facility built many times, compared per unit and per square foot. */}
          {project.units > 0 && m.forecast != null && (
            <Figure testId="per-unit" label="Cost per Unit" value={Math.round(m.forecast / project.units)}
              hint={`Worked out: forecast at completion over ${project.units.toLocaleString('en-US')} units${actual ? ` (actual so far ${usd(Math.round(actual.amount / project.units))})` : ''}.`} />
          )}
          {project.squareFeet > 0 && m.forecast != null && (
            <Figure testId="per-sqft" label="Cost per Square Foot" value={Math.round((m.forecast / project.squareFeet) * 100) / 100}
              hint={`Worked out: forecast at completion over ${project.squareFeet.toLocaleString('en-US')} sq ft${actual ? ` (actual so far ${usd(Math.round((actual.amount / project.squareFeet) * 100) / 100)})` : ''}.`} />
          )}
        </div>
        {track && (
          <ProgressTrack value={track.value} state={track.state} label="Actual against budget"
            start="Actual to Date" end={`Budget ${usd(track.budget)}`}
            note={<><b>{track.over ? `Over Budget by ${usd(track.by)}` : `${pct(m.percentSpent || 0)} spent`}</b>{' '}- worked out from the figures above</>} />
        )}
      </div>

      {actual && (
        <div style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={h3}>{actual.by === 'item' ? 'Actual to Date by Cost Code' : 'Actual to Date by GL Account'}</h3>
          {actual.rows.length === 0 ? <div style={quiet}>Nothing has posted to this Project-Job yet.</div> : (
            <Table tableKey="construction-money-actual" label="Actual to date" cols={ACTUAL_COLS(actual.by)}>
              {(w) => (
                <>
                  {actual.rows.map((r) => (
                    <tr key={r.key} data-money-row={r.key}>
                      <td style={cellStyle(w.width('code'))} title={r.label}>{r.code && r.label !== r.code ? <><span className="acct-code">{r.code}</span>{r.label}</> : r.label}</td>
                      <td style={cellStyle(w.width('accounts'))} title={r.accounts.map((a) => `${a.account_no} ${a.title}`).join(', ')}>
                        {r.accounts.map((a) => `${a.account_no} ${a.title}`).join(', ')}
                      </td>
                      <td className="acct-num" style={cellStyle(w.width('amount'))}>
                        <button type="button" className="acct-drill" aria-label={`Ledger lines behind ${r.label}`} title="See the ledger lines behind this amount"
                          onClick={() => open(r)}>
                          <Amount value={r.amount} zero="dash" />
                        </button>
                      </td>
                      <td className="acct-num" style={cellStyle(w.width('share'))} title="Worked out">{actual.amount ? pct(r.amount / actual.amount) : '-'}</td>
                    </tr>
                  ))}
                  <tr className="acct-grand">
                    <td colSpan={2} className="acct-label">Total</td>
                    <td className="acct-num">
                      <button type="button" className="acct-drill" aria-label="Ledger lines behind the total" onClick={() => open()}>
                        <Amount value={actual.amount} />
                      </button>
                    </td>
                    <td className="acct-num">{actual.amount ? '100.0%' : '-'}</td>
                  </tr>
                </>
              )}
            </Table>
          )}
          {(actual.left || []).length > 0 && (
            <div style={quiet}>
              Not counted as cost (revenue, payables, cash and equity lines on this Project-Job): {actual.left.map((a) => `${a.account_no} ${a.title}`).join(', ')}.
            </div>
          )}
          <div style={quiet}>Share of Actual is worked out. Every amount opens its ledger lines; every line opens its journal entry.</div>
        </div>
      )}

      {(commits.rows.length > 0 || m.canMap) && (
        <div data-money-commitments="" style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 style={h3}>Commitments</h3>
            {m.canMap && (
              <button type="button" className="secondary-btn" onClick={() => setSheet('new')} style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: '0.8rem' }}>
                <Plus size={13} />Add Commitment
              </button>
            )}
          </div>
          <div style={quiet}>
            Subcontracts and purchase orders with Intacct&apos;s vendors. Billed to Date is read from the books - this Project-Job&apos;s lines for the vendor - and opens them; Remaining and Retainage Held are worked out.
          </div>
          {commits.rows.length === 0 ? <div style={quiet}>No commitment yet. Add the signed subcontracts and purchase orders so Committed and the forecast are real.</div> : (
            <Table tableKey="construction-money-commitments" label="Commitments" cols={COMMIT_COLS}>
              {(w) => commits.rows.map((c) => {
                const drill = c.billed != null && c.billedAccounts.length > 0
                  ? () => setLines({ row: { key: `v:${c.vendorId}`, label: `${c.vendorName} Billed`, code: '', vendor: c.vendorId, amount: c.billed, accounts: c.billedAccounts } })
                  : null;
                return (
                  <tr key={c.id} data-commitment={c.number}>
                    <td style={cellStyle(w.width('number'))}>
                      {m.canMap ? <button type="button" className="acct-drill" onClick={() => setSheet(c.id)} title="Open this commitment">{c.number}</button> : c.number}
                    </td>
                    <td style={cellStyle(w.width('vendor'))} title={`${c.vendorName} (${c.vendorId})`}>{c.vendorName}</td>
                    <td style={cellStyle(w.width('title'))} title={c.title}>{c.title || c.kindLabel}{c.status === 'closed' ? ' (Closed)' : ''}</td>
                    <td className="acct-num" style={cellStyle(w.width('amount'))}><Amount value={c.amount} /></td>
                    <td className="acct-num" style={cellStyle(w.width('billed'))} title={c.sharedVendor ? 'Every line for this vendor on the job - it has more than one commitment here.' : undefined}>
                      {c.billed == null ? '-' : drill ? (
                        <button type="button" className="acct-drill" aria-label={`Ledger lines behind ${c.vendorName} billing`} title="See the ledger lines behind this amount" onClick={drill}>
                          <Amount value={c.billed} zero="dash" />
                        </button>
                      ) : <Amount value={c.billed} zero="dash" />}
                    </td>
                    <td className="acct-num" style={cellStyle(w.width('remaining'))} title="Worked out">{c.remaining == null ? '-' : <Amount value={c.remaining} zero="dash" />}</td>
                    <td className="acct-num" style={cellStyle(w.width('retainage'))} title="Worked out">{c.retainageHeld == null ? '-' : <Amount value={c.retainageHeld} zero="dash" />}</td>
                    <td style={cellStyle(w.width('waiver'))}>
                      {c.waiverMissing ? <StatusLabel size="sm" label="No Waiver" color={TONE.yellow} />
                        : c.lastWaiver ? `${WAIVER_KIND[c.lastWaiver.kind] || ''} through ${formatDate(c.lastWaiver.throughOn, c.lastWaiver.throughOn)}` : '-'}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
      )}

      {changes.rows.length > 0 && (
        <div style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 style={h3}>Changes</h3>
          <Table tableKey="construction-money-changes" label="Changes" cols={CHANGE_COLS}>
            {(w) => changes.rows.map((c) => (
              <tr key={c.id}>
                <td style={cellStyle(w.width('number'))}>{c.number || '-'}</td>
                <td style={cellStyle(w.width('title'))} title={c.title}>{c.title || '-'}</td>
                <td style={cellStyle(w.width('status'))}>
                  <StatusLabel size="sm" label={c.state === 'approved' ? 'Approved' : 'Pending'} color={c.state === 'approved' ? TONE.green : TONE.yellow} />
                </td>
                <td className="acct-num" style={cellStyle(w.width('amount'))}><Amount value={c.amount} /></td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      <div style={{ ...CARD, marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 style={h3}>Tagged to This Job</h3>
        <div style={quiet}>
          Purchase requests and reimbursements raised for this job in Nexus, reimbursements once their approver approved them. Only Requested, Not Yet Billed counts in the forecast; Approved, Posting Soon and Paid may already be in the books, so they are listed, never added.
        </div>
        {spend.reimbursements.length === 0 && spend.purchaseRequests.length === 0 && (
          <div style={quiet}>Nothing is tagged to this job yet. Pick the job on a purchase request or a reimbursement.</div>
        )}
        {spend.reimbursements.length > 0 && (
          <Table tableKey="construction-money-reimbursements" label="Reimbursements" cols={RB_COLS}>
            {(w) => spend.reimbursements.map((r) => (
              <tr key={r.id}>
                <td style={cellStyle(w.width('item'))} title={[r.item, r.vendor].filter(Boolean).join(' - ')}>{r.item}{r.vendor ? ` - ${r.vendor}` : ''}</td>
                <td style={cellStyle(w.width('by'))}>{r.requestedBy || '-'}</td>
                <td style={cellStyle(w.width('date'))}>{r.purchaseDate ? formatDate(r.purchaseDate, r.purchaseDate) : '-'}</td>
                <td style={cellStyle(w.width('stage'))}>
                  <StatusLabel size="sm" label={r.stage === 'paid' ? `Paid${r.paidOn ? ` ${formatDate(r.paidOn, r.paidOn)}` : ''}` : REQUEST_STAGE[r.stage] || REQUEST_STAGE.requested} color={STAGE_TONE[r.stage]} />
                </td>
                <td className="acct-num" style={cellStyle(w.width('amount'))}>
                  <Amount value={r.amount} />{r.currency !== (m.currency || 'USD') ? ` ${r.currency}` : ''}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {spend.purchaseRequests.length > 0 && (
          <Table tableKey="construction-money-requests" label="Purchase requests" cols={PR_COLS}>
            {(w) => spend.purchaseRequests.map((r) => (
              <tr key={r.id}>
                <td style={cellStyle(w.width('item'))} title={r.item}>{r.item}</td>
                <td className="acct-num" style={cellStyle(w.width('qty'))}>{r.quantity}</td>
                <td style={cellStyle(w.width('by'))}>{r.requestedBy || '-'}</td>
                <td style={cellStyle(w.width('date'))}>{r.createdAt ? formatDate(r.createdAt) : '-'}</td>
                <td style={cellStyle(w.width('stage'))}><StatusLabel size="sm" label={REQUEST_STAGE[r.stage]} color={STAGE_TONE[r.stage]} /></td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {lines && <ActualLines money={m} row={lines.row} onClose={() => setLines(null)} />}
      {(sheet === 'new' || openCommit) && (
        <Suspense fallback={null}>
          <CommitmentSheet project={project} commitment={openCommit} onClose={() => setSheet(null)} onSaved={reload} />
        </Suspense>
      )}
    </div>
  );
}
