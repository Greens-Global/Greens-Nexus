import { useEffect } from 'react';
import { ListChecks } from 'lucide-react';
import SidePanel from './SidePanel';
import { formatDate } from '../../lib/datetime';
import { frequencyLabel, stepMonths } from './recurringShared';

// The completeness check on MRE, MRI and PFS (10/25, Neil: "Need some sort of
// a completeness and data quality check added to MRE MRI and PFS as these
// are items that must be maintained 100%"; built as recommended 10/27). Read
// only: a count in each screen's control bar, and a click opens the gaps in
// the right-side panel (SidePanel) - a click on a gap jumps to its line. No
// emails, no notifications, nothing saved. The gaps follow the entity and the
// period picked on the screen.
//
//   MRE   a month that is over and reads Missed while the line has no note;
//         a line with no expected amount, or no frequency (Custom without its
//         number of months).
//   MRI   a month that is over and reads Unpaid with no note on it; a source
//         with no amount, or no frequency (Custom without its months).
//   PFS   a figure kept by hand that was not updated in the 90 days before
//         the statement date (a ledger figure is read live, never stale).

export const PFS_STALE_DAYS = 90;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthText = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const noFrequency = (line) => line?.frequency === 'custom' && stepMonths(line) === 1 && Number(line.frequencyMonths) !== 1;

/** MRE: one group per line with gaps, in the months [from, to] of the grid shown. */
export function mreGaps(rows, [from, to] = [0, 11]) {
  const out = [];
  (rows || []).forEach((r) => {
    const l = r.line;
    if (!l || l.status === 'ended') return;
    const items = [];
    if (!(Number(l.expectedAmount) > 0)) items.push({ key: 'amount', text: 'No expected amount' });
    if (!l.frequency || noFrequency(l)) items.push({ key: 'frequency', text: 'No frequency' });
    if (!(l.notes || '').trim()) {
      (r.months || []).slice(from, to + 1).forEach((c) => {
        if (c?.status === 'missed') items.push({ key: `missed-${c.month}`, text: `${monthText(c.month)} Missed, no note` });
      });
    }
    if (items.length) out.push({ id: l.id, title: l.vendorName || l.vendorId, subtitle: `${l.vendorId} · ${l.entityName || l.entityCode} · ${frequencyLabel(l)}`, items });
  });
  return out;
}

/** MRI: one group per active source with gaps, in the months [from, to] shown. */
export function mriGaps(rows, [from, to] = [0, 11]) {
  const out = [];
  (rows || []).forEach((r) => {
    if (r.kind === 'account' || !r.lease) return;
    const l = r.lease;
    if ((l.status || 'active') !== 'active') return;
    const items = [];
    if (!(l.rates || []).some((x) => (Number(x.rent) || 0) + (Number(x.cam) || 0) + (Number(x.other) || 0) > 0)) items.push({ key: 'amount', text: 'No amount' });
    if (noFrequency(l)) items.push({ key: 'frequency', text: 'No frequency' });
    (r.months || []).slice(from, to + 1).forEach((c) => {
      if (c?.status === 'unpaid' && !(c.note || '').trim()) items.push({ key: `unpaid-${c.month}`, text: `${monthText(c.month)} Unpaid, no note` });
    });
    if (items.length) out.push({ id: l.id, title: l.propertyName || l.tenantName || 'Unnamed source', subtitle: [l.tenantName || r.customer?.name || l.customerId, l.entityCode].filter(Boolean).join(' · '), items });
  });
  return out;
}

const dayNumber = (isoDay) => Math.floor(Date.UTC(Number(isoDay.slice(0, 4)), Number(isoDay.slice(5, 7)) - 1, Number(isoDay.slice(8, 10))) / 86_400_000);

/** PFS: one group per line kept by hand whose figure is older than `days` before the statement date. */
export function pfsGaps(lines, asOf, sectionLabel = {}, days = PFS_STALE_DAYS) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}/.test(asOf || '')) return out;
  (lines || []).forEach((l) => {
    if (l.source === 'ledger') return;
    const taken = (l.manualAsOf || l.updatedAt || '').slice(0, 10);
    let text = '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(taken)) text = 'No date for the figure';
    else {
      const age = dayNumber(asOf.slice(0, 10)) - dayNumber(taken);
      if (age > days) text = `Not updated in ${age} days (figure from ${formatDate(taken)})`;
    }
    if (text) out.push({ id: l.id, section: l.section, title: l.label || 'Unnamed line', subtitle: [sectionLabel[l.section] || l.section, l.institution].filter(Boolean).join(' · '), items: [{ key: 'stale', text }] });
  });
  return out;
}

/** How many gaps there are (each item is one). */
export const gapCount = (groups) => (groups || []).reduce((s, g) => s + g.items.length, 0);

/** Scrolls a row into view and outlines it for a moment. False when it is not on the page. */
export function flashRow(selector) {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(selector);
  if (!el) return false;
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  el.classList.add('acct-row-flash');
  setTimeout(() => el.classList.remove('acct-row-flash'), 2400);
  return true;
}

/** `[data-row-id="..."]` (or another attribute) for an id. */
export const rowSelector = (id, attr = 'data-row-id') => `[${attr}="${String(id).replace(/["\\]/g, '\\$&')}"]`;

/**
 * A paged table's jump to a row: turns to the row's page, then scrolls to it
 * and outlines it. `focus` is { id, n } (n changes on every click, so the
 * same row can be jumped to twice); onMissing(id) when the row is not in
 * `rows` (hidden by the table's own filters).
 */
export function useJumpToRow(focus, rows, idOf, paged, pageSize, onMissing = null) {
  useEffect(() => {
    if (!focus) return undefined;
    const at = (rows || []).findIndex((r) => idOf(r) === focus.id);
    if (at < 0) { onMissing?.(focus.id); return undefined; }
    const want = Math.floor(Number(pageSize) || 0) > 0 ? Math.floor(at / Math.floor(Number(pageSize))) + 1 : 1;
    if (want !== paged.page) { paged.setPage(want); return undefined; }
    const raf = requestAnimationFrame(() => flashRow(rowSelector(focus.id)));
    return () => cancelAnimationFrame(raf);
  }, [focus, paged.page]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The control bar's count. */
export function CompletenessButton({ count, onClick, open = false }) {
  const clean = !count;
  return (
    <button type="button" className="secondary-btn" onClick={onClick} aria-pressed={open} aria-label={`Completeness: ${clean ? 'nothing missing' : `${count} ${count === 1 ? 'gap' : 'gaps'}`}`}
      title={clean ? 'Completeness: nothing missing in what is shown' : `Completeness: ${count} ${count === 1 ? 'gap' : 'gaps'} - click for the list`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px', whiteSpace: 'nowrap' }}>
      <ListChecks size={14} /> <span className="acct-bar-label">Completeness</span>
      <span data-testid="completeness-count" style={{ fontSize: '0.7rem', fontWeight: 700, borderRadius: 999, padding: '0 7px', lineHeight: '18px',
        color: clean ? 'var(--ok-fg, #15803d)' : 'var(--bad-fg, #dc2626)', background: clean ? 'rgba(21,128,61,0.10)' : 'rgba(220,38,38,0.10)' }}>{count}</span>
    </button>
  );
}

/** The gaps in the right-side panel; a click on a line or one of its gaps calls onPick(group). */
export function CompletenessPanel({ caption, rule, groups, onPick, onClose, note = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const n = gapCount(groups);
  return (
    <SidePanel label="Completeness" title="Completeness" caption={`${caption} · ${n ? `${n} ${n === 1 ? 'gap' : 'gaps'} on ${groups.length} ${groups.length === 1 ? 'line' : 'lines'}` : 'nothing missing'}`} onClose={onClose}>
      <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{rule}</p>
      {note && <div role="status" style={{ fontSize: '0.78rem', color: '#92400e' }}>{note}</div>}
      {!groups.length ? (
        <div style={{ fontSize: '0.86rem', color: 'var(--ok-fg, #15803d)', fontWeight: 600 }}>Nothing missing for the entity and period picked.</div>
      ) : (
        <ul aria-label="Gaps" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {groups.map((g) => (
            <li key={g.id}>
              <button type="button" onClick={() => onPick(g)} aria-label={`Go to ${g.title}: ${g.items.map((i) => i.text).join('; ')}`}
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg-card)', display: 'grid', gap: 4 }}>
                <span style={{ fontWeight: 700, fontSize: '0.84rem', color: 'var(--text-primary)' }}>{g.title}</span>
                {g.subtitle && <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{g.subtitle}</span>}
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {g.items.map((i) => (
                    <span key={i.key} style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--bad-fg, #dc2626)', background: 'rgba(220,38,38,0.08)', borderRadius: 999, padding: '1px 8px' }}>{i.text}</span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}
