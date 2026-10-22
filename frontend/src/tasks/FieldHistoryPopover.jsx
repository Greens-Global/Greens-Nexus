// Field history in the task drawer (Neil, Oct 22 2026): a small clock icon
// beside a field's label opens the changes made to that field - who, when
// (MM/DD/YYYY h:mm AM/PM) and From -> To in words a person reads. A compact
// popover on desktop, the full-screen sheet on a phone. Read-only, so a
// viewer sees it too: the trigger is not a form control, and FieldsLock lets
// it through (data-history-trigger).
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ArrowRight, History } from 'lucide-react';
import { api } from '../api';
import { Avatar, Modal, useIsMobile } from './components';
import { NX, btn } from './theme';
import { fmtDateTime } from './lib';
import { StatusLabel } from '../components/StatusLabel';
import AnchoredMenu from '../components/AnchoredMenu';
import { Spinner } from '../components/AsyncState';
import { historyValueParts } from './fieldHistory';
import { FieldHistoryContext, useHistoryCtx } from './fieldHistoryContext';

const PAGE = 20;

/** One side of a change: soft labels for colored values, plain words for the
 *  rest, a faint "Empty" for nothing. */
export function HistoryValue({ entry, side, ctx }) {
  const parts = historyValueParts(entry, side, ctx);
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0 }}>
      {parts.map((p, i) => (p.empty
        ? <span key={i} style={{ color: NX.faint, fontStyle: 'italic' }}>{p.text}</span>
        : p.color
          ? <StatusLabel key={i} size="sm" label={p.text} color={p.color} />
          : <span key={i} style={{ color: NX.ink, overflowWrap: 'anywhere' }}>{p.text}{i < parts.length - 1 ? ',' : ''}</span>))}
    </span>
  );
}

/** "From -> To" for one change. */
export function HistoryChange({ entry, ctx }) {
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <HistoryValue entry={entry} side="from" ctx={ctx} />
      <ArrowRight size={12} aria-label="to" style={{ color: NX.faint, flexShrink: 0 }} />
      <HistoryValue entry={entry} side="to" ctx={ctx} />
    </span>
  );
}

/** The changes to one field (or a comma-joined few), newest first, a page at a time. */
export function FieldHistoryList({ taskId, field, nameOf }) {
  const ctx = useHistoryCtx(nameOf);
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Mounted fresh each time the popover opens, so the first page needs no reset.
  useEffect(() => {
    let alive = true;
    api.getTaskHistory(taskId, { field, limit: PAGE })
      .then((r) => { if (alive) { setItems(r?.items || []); setMore(!!r?.more); } })
      .catch(() => { if (alive) { setItems([]); setError('History could not be loaded.'); } });
    return () => { alive = false; };
  }, [taskId, field]);
  const loadMore = () => {
    setLoadingMore(true);
    api.getTaskHistory(taskId, { field, limit: PAGE, offset: items.length })
      .then((r) => { setItems((cur) => [...cur, ...(r?.items || [])]); setMore(!!r?.more); })
      .catch(() => setError('More history could not be loaded.'))
      .finally(() => setLoadingMore(false));
  };
  if (items === null) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 18 }}><Spinner size={16} /></div>;
  }
  return (
    <div data-testid="field-history-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {error && <div role="alert" style={{ fontSize: 12, color: NX.red, padding: '6px 8px' }}>{error}</div>}
      {!error && items.length === 0 && (
        <div style={{ fontSize: 12.5, color: NX.faint, padding: '14px 8px', textAlign: 'center' }}>No changes recorded yet.</div>
      )}
      {items.map((e) => {
        const who = e.actorId ? (nameOf(e.actorId) || e.actorId) : 'Someone';
        return (
          <div key={e.id} style={{ display: 'flex', gap: 9, padding: '8px', borderRadius: 8 }}>
            <Avatar email={e.actorId || ''} name={who} size={22} card={false} />
            <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '0 6px', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, color: NX.ink }}>{who}</span>
                <span style={{ color: NX.faint, fontSize: 11 }}>{fmtDateTime(e.at)}</span>
              </div>
              <HistoryChange entry={e} ctx={ctx} />
            </div>
          </div>
        );
      })}
      {more && (
        <button type="button" onClick={loadMore} disabled={loadingMore}
          style={{ ...btn('ghost'), alignSelf: 'center', fontSize: 12, padding: '5px 10px', marginTop: 4 }}>
          {loadingMore ? 'Loading…' : 'Show More'}
        </button>
      )}
    </div>
  );
}

/** The clock icon beside a field's label. `field` as for the list; `label`
 *  names the field in the popover's heading. Renders nothing outside a
 *  drawer (no FieldHistoryContext). */
export function FieldHistoryButton({ field, label, nameOf }) {
  const hist = useContext(FieldHistoryContext);
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  // Focus moves into the popover when it opens (its heading, so a screen
  // reader announces it) and back to the clock when it closes from inside -
  // a click elsewhere keeps the focus where it landed.
  const panelRef = useRef(null);
  const focusPanel = useCallback((el) => {
    panelRef.current = el;
    if (el) el.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => {
    const inside = isMobile || !!panelRef.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) ref.current?.focus();
  }, [isMobile]);
  if (!hist?.taskId || !field) return null;
  const name = typeof label === 'string' ? label : 'Field';
  const who = nameOf || hist.nameOf || ((e) => e);
  const toggle = (e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); };
  return (
    <>
      {/* A span, not a <button>: a read-only drawer wraps its fields in a
          disabled fieldset, which would switch a button off. */}
      <span ref={ref} role="button" tabIndex={0} data-history-trigger="" className="nx-hist-btn"
        aria-label={`${name} History`} title={`${name} History`} aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); }}>
        <History size={12} />
      </span>
      {open && (isMobile ? (
        <Modal title={`${name} History`} onClose={close}>
          <div className="nx-fill"><FieldHistoryList taskId={hist.taskId} field={field} nameOf={who} /></div>
        </Modal>
      ) : (
        <AnchoredMenu anchorRef={ref} open={open} onClose={close} role="dialog"
          aria-label={`${name} History`}
          style={{ width: 340, maxWidth: 'calc(100vw - 16px)', background: NX.surface, border: `1px solid ${NX.border}`,
            borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 6 }}>
          <div ref={focusPanel} tabIndex={-1}
            style={{ fontSize: 12.5, fontWeight: 700, color: NX.ink, padding: '4px 8px 6px' }}>{name} History</div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <FieldHistoryList taskId={hist.taskId} field={field} nameOf={who} />
          </div>
        </AnchoredMenu>
      ))}
    </>
  );
}
