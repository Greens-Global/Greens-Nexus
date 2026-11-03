import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardCheck, CheckCircle, CheckCheck, FileSignature, Undo2, ChevronRight, PenLine } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { Avatar, Modal } from '../tasks/components';
import { SignModal } from './ESign';
import { ForChip } from './DelegateApprovals';

// Timesheets to Review (Sep 29): the list at the top of People > Time of every
// timesheet submitted to YOU that you have not decided yet - who, which
// period, the hours as submitted, when, and their note - with Agree and Send
// Back right on the row and Review to open the full timecard. Nothing renders
// when nothing is waiting. Agree is disabled, with the reason, while it would
// be refused (the period is still running, or a missing punch is open) - the
// same check the server makes (timesheet_review.agree_blocker).
//
// Timesheets to Sign (Oct 16): the agreed timesheets waiting on YOUR
// signature (the manager's or HR's turn in Nexus Sign), signed right here -
// the same in-place signing screen the employee gets on their own timecard.
// Managers reach People and Documents only through an Access Group grant, so
// without one the signature bell and the email link both landed on Access
// Restricted and the manager could never sign.
//
// Refreshes on `nexus:timesheet-review-changed`, which the review panel on the
// timecard fires after any decision, so the two never disagree.
//
// Oct 16 (Neil): the manager reviews first, so the list also carries the
// closed periods of your people that nobody submitted (notSubmitted, no review
// id yet) - Approve works on them too; Send Back needs a submission to answer.
// Approve is the manager's "these hours are accurate" - no signature; it
// sends the timesheet straight to the employee to sign.
//
// Review All Clean (Neil, Oct 17, reworded Oct 21): the listed time sheets
// with nothing to look at - reviewFlag is '' (no agreeBlocker and no exception
// at all on the card; timesheet_review.review_flag, which the server checks
// again per item) - in one modal. A clean card still needs a review (Neil,
// Oct 21): the manager ticks each one they looked at and only the ticked ones
// are approved - no tick-all. Flagged rows stay for one-by-one review and say why.

const rowKey = (r) => r.id || `${r.employeeEmail}|${r.periodStart}`;
const BULK_MAX = 100;   // ticked per click; sent BULK_CHUNK per request (the server caps a call at 25)
const BULK_CHUNK = 10;   // per request - see approveReviewed
const isClean = (r) => !r.agreeBlocker && r.reviewFlag === '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const hm = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const ROLE_WORD = { manager: 'as the manager', hr: 'for HR', employee: 'as the employee' };

// `onCount` (optional) hears how many are waiting (to review plus to sign) -
// null when the list could not be loaded - for the Workday Time Sheet tab's
// count. `signOnly` (Workday, Oct 22): reviewing moved to People > Time only,
// so Workday lists just the time sheets waiting on my signature.
export default function TimesheetsToReview({ onOpen, toastOk, toastErr, onCount, signOnly = false }) {
  const [rows, setRows] = useState([]);
  const [toSign, setToSign] = useState([]);
  const [busyId, setBusyId] = useState('');
  // Compact rows (11/02/2026): the note and the fix-first text share one
  // truncated line; clicking it opens the full text. Which row is open:
  const [openKey, setOpenKey] = useState('');
  const [openList, setOpenList] = useState(false);   // the review list, collapsed by default (11/03/2026)
  const [backFor, setBackFor] = useState('');   // review id whose Send Back note is open
  const [note, setNote] = useState('');
  const [signing, setSigning] = useState(null);  // party id being signed in place
  // CA-rule staff: the signing screen itself shows the meal and rest break
  // statement and Report a Missed Break (Oct 18) - no question first.
  const startSign = (partyId) => setSigning(partyId);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());   // rowKeys the manager has looked over
  const openBulk = () => { setTicked(new Set()); setBulkOpen(true); };
  const toggleTicked = (k) => setTicked(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const load = useCallback(() => {
    api.timesheetReviewWaiting().then(r => {
      const list = !signOnly && Array.isArray(r?.reviews) ? r.reviews : [];
      const sign = Array.isArray(r?.toSign) ? r.toSign : [];
      setRows(list);
      setToSign(sign);
      onCount?.(list.length + sign.length);
    }).catch(() => onCount?.(null));
  }, [onCount, signOnly]);
  useEffect(() => {
    load();
    window.addEventListener('nexus:timesheet-review-changed', load);
    return () => window.removeEventListener('nexus:timesheet-review-changed', load);
  }, [load]);

  async function run(r, call, done) {
    setBusyId(rowKey(r));
    try {
      await call();
      toastOk?.(done);
      setBackFor(''); setNote('');
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
    } catch (e) { toastErr?.(e?.message || 'Could not save that.'); }
    setBusyId('');
  }

  const clean = rows.filter(isClean);
  const flagged = rows.filter(r => !isClean(r));
  const picked = clean.filter(r => ticked.has(rowKey(r)));
  const going = picked.slice(0, BULK_MAX);

  async function approveReviewed() {
    setBulkBusy(true);
    try {
      // Sent BULK_CHUNK at a time: each approval builds the PDF and sends the
      // signing email inside the request, so one call for 100 could run past
      // Azure's ~230s request limit. The server caps a call at 25 too.
      const items = going.map(r => (r.id ? { id: r.id } : { email: r.employeeEmail, start: r.periodStart }));
      const out = { approved: 0, skipped: 0, failed: 0, results: [] };
      for (let i = 0; i < items.length; i += BULK_CHUNK) {
        const part = await api.timesheetReviewApproveBulk(items.slice(i, i + BULK_CHUNK), '');
        out.approved += part?.approved || 0; out.skipped += part?.skipped || 0; out.failed += part?.failed || 0;
        out.results.push(...(part?.results || []));
      }
      const parts = [`${plural(out?.approved || 0, 'time sheet', 'time sheets')} approved and sent to sign`];
      if (out?.skipped) parts.push(`${out.skipped} skipped`);
      if (out?.failed) parts.push(`${out.failed} failed`);
      const firstErr = (out?.results || []).find(x => x.status === 'failed')?.error;
      if (out?.failed) toastErr?.(`${parts.join(', ')}.${firstErr ? ` ${firstErr}` : ''}`);
      else toastOk?.(`${parts.join(', ')}.`);
      setBulkOpen(false);
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
    } catch (e) { toastErr?.(e?.message || 'Could not approve the time sheets.'); }
    setBulkBusy(false);
  }

  async function resign(s) {
    setBusyId(`resign-${s.id}`);
    try {
      const out = await api.timesheetReviewSign(s.id);
      if (out?.myPartyId) startSign(out.myPartyId);
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
    } catch (e) { toastErr?.(e?.message || 'Could not open the time sheet to sign.'); }
    setBusyId('');
  }

  const card = { marginBottom: 16, border: '1px solid var(--wk-line2)', background: 'var(--card)', borderRadius: 12, padding: '10px 16px', boxShadow: 'var(--wk-shadow)' };
  const signPortal = signing && createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'var(--bg, #f4f5f7)', display: 'flex', flexDirection: 'column' }}>
      <SignModal partyId={signing} onClose={() => setSigning(null)}
        onDone={() => { setSigning(null); window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed')); }}
        toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})} />
    </div>, document.body);

  if (!rows.length && !toSign.length) return null;
  return (
    <>
      {rows.length > 0 && (
        <div style={card}>
          {/* Collapsed by default (Visesh, 11/03/2026: the open list took half
              the screen) - an alert line with the count in red; expanding
              shows the list and Review All Clean. */}
          <button type="button" onClick={() => setOpenList(o => !o)} aria-expanded={openList}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none',
              cursor: 'pointer', padding: '2px 0', fontFamily: 'inherit', textAlign: 'left' }}>
            <ChevronRight size={14} style={{ color: 'var(--muted)', flexShrink: 0, transform: openList ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease-out' }} />
            <ClipboardCheck size={15} style={{ color: 'var(--wk-brand)' }} />
            <span style={{ fontWeight: 800, fontSize: 13.5, color: 'var(--ink)' }}>Time Sheets to Review</span>
            <span style={{ background: 'var(--wk-red, #dc2626)', color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 700, padding: '1px 7px', lineHeight: 1.4 }}>{rows.length}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>waiting on you{openList ? '' : ' - click to work the list'}</span>
          </button>
          {openList && (<>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
            {!clean.length ? (
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                Nothing to review in one pass - every time sheet here needs a closer look first.
              </span>
            ) : <span />}
            <button type="button" className="secondary-btn" disabled={!clean.length || bulkBusy}
              title={clean.length ? 'Look over every time sheet with nothing flagged, then approve the ones you have reviewed'
                : 'Every time sheet here needs a closer look first - the note on each one says why.'}
              onClick={openBulk}
              style={{ marginLeft: 'auto', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: clean.length ? 1 : 0.55 }}>
              <CheckCheck size={13} /> Review All Clean ({clean.length})
            </button>
          </div>
          {/* Compact (11/02/2026): one line per person - photo, name, period ·
              hours · status - with the note / fix-first text as one truncated
              line underneath that opens on click. The list keeps its height
              whatever the team size: past ~6 rows it scrolls inside the card,
              so the tabs below stay in reach. */}
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 330, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {rows.map(r => {
              const k = rowKey(r);
              const warn = r.agreeBlocker || r.reviewFlag;
              const open = openKey === k;
              return (
              <div key={k} data-review={r.employeeEmail} className={r.id ? 'nx-needs-you' : undefined} style={{ borderTop: '1px solid var(--line)', padding: '7px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {/* Whose time sheet, at a glance: their photo (initials when
                      there is none) in front of the name (Neil, Oct 19 2026). */}
                  <div style={{ flex: 1, minWidth: 240, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar email={r.employeeEmail} name={r.name} size={26} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</span>
                      {r.resubmitted && <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309' }}>Resubmitted</span>}
                      {r.forEmail && <ForChip name={r.forName} email={r.forEmail} />}
                      <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {formatDate(r.periodStart)} - {formatDate(r.periodEnd)} · {hm(r.workedMin)} · {r.notSubmitted ? 'not submitted - period closed' : `submitted ${formatDate(r.submittedAt)}`}
                      </span>
                    </div>
                    {(warn || r.note) && (
                      <button type="button" onClick={() => setOpenKey(open ? '' : k)} aria-expanded={open}
                        title={open ? 'Show less' : (warn || `"${r.note}"`)}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 5, width: '100%', background: 'none', border: 'none', padding: 0, marginTop: 1, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                        <ChevronRight size={11} style={{ flex: 'none', marginTop: 3, color: warn ? '#b45309' : 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease-out' }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.45, ...(open ? {} : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}>
                          {r.note && <span>"{r.note}"</span>}
                          {r.note && warn ? ' · ' : ''}
                          {r.agreeBlocker && <span style={{ color: '#b45309' }}>{r.agreeBlocker}</span>}
                          {/* Approve works, but Review All Clean leaves it: an exception to look at. */}
                          {!r.agreeBlocker && r.reviewFlag && <span style={{ color: '#b45309' }}>{r.reviewFlag}</span>}
                        </span>
                      </button>
                    )}
                    </div>
                  </div>
                  {/* Review opens the full timecard in People > Time - offered only
                      where the caller can open it (no onOpen = no button, Oct 1). */}
                  {onOpen && (
                    <button type="button" className="secondary-btn" onClick={() => onOpen(r)}
                      style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}>Review <ChevronRight size={13} /></button>
                  )}
                  {!r.notSubmitted && (
                    <button type="button" className="secondary-btn" disabled={busyId === rowKey(r)}
                      onClick={() => { setBackFor(backFor === r.id ? '' : r.id); setNote(''); }}
                      style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Undo2 size={13} /> Send Back</button>
                  )}
                  <button type="button" className="primary-btn" disabled={busyId === rowKey(r) || bulkBusy || !!r.agreeBlocker}
                    title={r.agreeBlocker || 'These hours are accurate - it goes to the employee to sign'}
                    onClick={() => run(r, () => (r.notSubmitted
                      ? api.timesheetReviewApprovePeriod(r.employeeEmail, r.periodStart, '')
                      : api.timesheetReviewApprove(r.id, '')), `Approved - sent to ${r.name} to sign.`)}
                    style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: r.agreeBlocker ? 0.55 : 1 }}>
                    <CheckCircle size={13} /> Approve
                  </button>
                </div>
                {!r.notSubmitted && backFor === r.id && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input className="form-input" value={note} onChange={e => setNote(e.target.value)} maxLength={1000} autoFocus
                      placeholder="What needs changing?" aria-label={`What needs changing for ${r.name}`} style={{ flex: 1, fontSize: 12.5 }} />
                    <button type="button" className="primary-btn" disabled={!note.trim() || busyId === r.id}
                      onClick={() => run(r, () => api.timesheetReviewSendBack(r.id, note.trim()), `Sent back to ${r.name}.`)}
                      style={{ fontSize: 12.5 }}>Send</button>
                  </div>
                )}
              </div>
            );})}
          </div>
          </>)}
        </div>
      )}
      {toSign.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <PenLine size={15} style={{ color: 'var(--wk-brand)' }} />
            <span style={{ fontWeight: 800, fontSize: 13.5 }}>Time Sheets to Sign</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{toSign.length} waiting on your signature</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {toSign.map(s => (
              <div key={s.partyId || `resign-${s.id}`} data-sign={s.employeeEmail} className="nx-needs-you" style={{ borderTop: '1px solid var(--line)', padding: '7px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240, display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  <Avatar email={s.employeeEmail} name={s.name} size={26} />
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{s.role === 'employee' ? 'Your Time Sheet' : s.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={s.needsResign ? 'HR changed your time sheet - sign the updated one' : undefined}>
                    {formatDate(s.periodStart)} - {formatDate(s.periodEnd)}
                    {s.agreedBy ? ` · agreed by ${s.agreedBy}${s.agreedAt ? ` on ${formatDate(s.agreedAt)}` : ''}` : ''}
                    {` · you sign ${ROLE_WORD[s.role] || ''}`.replace(/ $/, '')}
                    {s.needsResign ? ' · HR changed your time sheet - sign the updated one' : ''}
                  </span>
                </div>
                {/* needsResign (Oct 17): HR changed it while it was out for signature -
                    the click sends the fresh envelope, then opens it. */}
                <button type="button" className="primary-btn" disabled={busyId === `resign-${s.id}`}
                  onClick={() => (s.needsResign ? resign(s) : startSign(s.partyId))}
                  style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <FileSignature size={13} /> {s.needsResign ? 'Sign Updated Time Sheet' : s.role === 'employee' ? 'Sign & Submit' : 'Review & Sign'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {bulkOpen && (
        <Modal title="Review All Clean" onClose={() => setBulkOpen(false)}
          footer={<>
            <button type="button" className="secondary-btn" disabled={bulkBusy} onClick={() => setBulkOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" disabled={bulkBusy || !going.length} onClick={approveReviewed}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <CheckCircle size={13} /> {bulkBusy ? 'Approving...' : `Approve Reviewed (${going.length})`}
            </button>
          </>}>
          <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              Tick each time sheet once you have looked it over. Only the ticked ones are approved and sent to the employee to sign.
              {picked.length > going.length && ` The first ${BULK_MAX} go now - run it again for the other ${picked.length - going.length}.`}
            </div>
            <div data-bulk="going" style={{ display: 'flex', flexDirection: 'column' }}>
              {clean.map(r => (
                <div key={rowKey(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--line)', padding: '8px 0' }}>
                  <Avatar email={r.employeeEmail} name={r.name} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {formatDate(r.periodStart)} - {formatDate(r.periodEnd)} · {hm(r.workedMin)} · {r.notSubmitted ? 'not submitted - period closed' : `submitted ${formatDate(r.submittedAt)}`}
                    </div>
                    {r.note && <div style={{ fontSize: 12, marginTop: 2 }}>"{r.note}"</div>}
                  </div>
                  {onOpen && (
                    <button type="button" className="secondary-btn" onClick={() => { setBulkOpen(false); onOpen(r); }}
                      style={{ fontSize: 12.5 }}>Open</button>
                  )}
                  <input type="checkbox" aria-label={`Reviewed - ${r.name}`} checked={ticked.has(rowKey(r))} disabled={bulkBusy}
                    onChange={() => toggleTicked(rowKey(r))} style={{ width: 18, height: 18, cursor: 'pointer' }} />
                </div>
              ))}
            </div>
            {flagged.length > 0 && (
              <>
                <div>{plural(flagged.length, 'time sheet stays', 'time sheets stay')} here for one-by-one review:</div>
                <ul data-bulk="skipped" style={{ margin: 0, paddingLeft: 18 }}>
                  {flagged.map(r => (
                    <li key={rowKey(r)} style={{ fontSize: 12.5 }}>
                      <strong>{r.name}</strong> - {formatDate(r.periodStart)} - {formatDate(r.periodEnd)}
                      <div style={{ fontSize: 11.5, color: '#b45309' }}>{r.agreeBlocker || r.reviewFlag || 'Needs a look first.'}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Modal>
      )}
      {signPortal}
    </>
  );
}
