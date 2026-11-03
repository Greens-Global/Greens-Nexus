// Items phase 4 - the one place the scan module lives on the Items screen.
//
// Mount <ItemScanHost /> once inside the Items view. It answers:
//   - the "item/<id>" sub (an item's own link, a QR tag, openItemById):
//     opens the item - from the screen's own list, else the server - or the
//     calm "no access" state when the server walls it off;
//   - openItemScanner(): the camera scanner (lazy chunk);
//   - printItemTags(items): the print-ready tag sheet (lazy chunk).
// The item's primary actions reuse the existing Items flows and calls
// (one-item cart, Return, Confirm Receipt, Hand Over, Details); actions that
// live on a list screen (an assignment's accept / return, a request to
// review) take the person to that screen.
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Spinner } from '../../components/AsyncState';
import { useInventory } from '../../contexts/InventoryContext';
import { useAssignments } from '../../components/Assignments';
import { CartDrawer } from '../ui/CartDrawer';
import { ReturnModal } from '../checkout/ReturnModal';
import { ReceiptConfirmModal } from '../checkout/ReceiptConfirmModal';
import { AllocateModal } from '../checkout/AllocateModal';
import { ItemDetailsPanel } from '../manage/ItemDetailsPanel';
import { ItemQuickSheet } from './ItemQuickSheet';
import { itemActionsFor } from './itemActions';
import { parseItemSub } from './itemLink';
import { ITEM_SCAN_EVENT, ITEM_TAGS_EVENT, openItemById, openItemScanner } from './events';
import { cameraSupport } from './camera';

const ScannerSheet = lazy(() => import('./ScannerSheet'));
const TagSheet = lazy(() => import('./TagSheet'));

// While a lazy sheet's chunk arrives: a quiet layer, never nothing.
function Opening({ label }) {
  return (
    <div role="status" aria-label={label} style={{ position: 'fixed', inset: 0, zIndex: 4300, background: 'rgba(17,24,39,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: 'var(--card)', color: 'var(--ink)', fontSize: 13.5, fontWeight: 600, boxShadow: 'var(--shadow-lg)' }}>
        <Spinner size="inline" /> {label}
      </span>
    </div>
  );
}

// A lazy sheet that cannot load (a deploy swapped the chunks) says so and
// closes - it never takes the Items screen down with it.
class SheetBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* reported by the message below; nothing to retry here */ }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alertdialog" aria-label="Could not open" style={{ position: 'fixed', inset: 0, zIndex: 4300, background: 'rgba(17,24,39,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div className="nx-popup nx-center" style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 14, padding: 20, maxWidth: 420, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>This Could Not Open</div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>Nexus may have just been updated. Reload the page and try again.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={this.props.onClose}>Close</button>
            <button type="button" className="primary-btn" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}

const go = (sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub } }));

/**
 * props:
 *   activeSub, onSubChange  - the Items view's own (App.jsx)
 *   userEmail, userName     - who is acting (the shell's identity)
 *   isManager               - Item Management editor+ (Details, Print Tag, Hand Over)
 *   toast(message, kind)    - the screen's toast
 *   renderItem?({ item, view, close, runAction }) - draw a found item yourself
 *                             (the redesign's record sheet); the loading and
 *                             no-access states stay the host's
 */
export function ItemScanHost({ activeSub, onSubChange, userEmail = '', userName = '', isManager = false, toast, renderItem }) {
  const { items = [], itemsLoading, checkouts = [], submitCartCheckouts, allocateItem, initiateHandover, confirmReceipt, returnItem, refreshItems, refreshCheckouts } = useInventory() || {};
  const { assignments } = useAssignments();
  const say = useCallback((m, kind) => toast?.(m, kind), [toast]);

  // ── the item a link names ──────────────────────────────────────────────
  const linkId = parseItemSub(activeSub);
  // Where Close goes: the sub before the item opened (kept as the sub moves).
  const [backSub, setBackSub] = useState(() => (parseItemSub(activeSub) ? null : activeSub || null));
  const [seenSub, setSeenSub] = useState(activeSub);
  if (seenSub !== activeSub) {
    setSeenSub(activeSub);
    if (!parseItemSub(activeSub)) setBackSub(activeSub || null);
  }
  // The server's answer for an item the screen's list does not hold, keyed
  // by id - a different id reads as still loading until its answer lands.
  const [fetched, setFetched] = useState(null);   // { id, status: 'found'|'denied'|'error', item }
  const [handed, setHanded] = useState(null);     // the item the scanner just found (skips a second lookup)
  const local = linkId ? (items.find((i) => i.id === linkId) || (handed?.id === linkId ? handed : null)) : null;
  const listPending = itemsLoading && !items.length;

  useEffect(() => {
    if (!linkId || local || listPending) return undefined;
    let live = true;
    api.getItemByCode(linkId)
      .then((it) => { if (live) setFetched(it?.id ? { id: linkId, status: 'found', item: it } : { id: linkId, status: 'denied' }); })
      .catch((e) => { if (live) setFetched({ id: linkId, status: e?.status === 404 ? 'denied' : 'error' }); });
    return () => { live = false; };
  }, [linkId, !!local, listPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = local || (fetched?.id === linkId && fetched.status === 'found' ? fetched.item : null);
  const status = !linkId ? null : item ? 'found' : (fetched?.id === linkId ? fetched.status : 'loading');
  const view = useMemo(() => (item ? itemActionsFor({ item, checkouts, assignments, userEmail, isManager }) : null),
    [item, checkouts, assignments, userEmail, isManager]);

  const closeItem = useCallback(() => {
    setHanded(null);
    if (onSubChange) onSubChange(backSub); else go(backSub);
  }, [onSubChange, backSub]);

  // ── scanner and tag sheet ──────────────────────────────────────────────
  const [scanOpen, setScanOpen] = useState(false);
  const [tagItems, setTagItems] = useState(null);
  useEffect(() => {
    const onScan = () => setScanOpen(true);
    const onTags = (e) => setTagItems(e.detail?.items || null);
    window.addEventListener(ITEM_SCAN_EVENT, onScan);
    window.addEventListener(ITEM_TAGS_EVENT, onTags);
    return () => { window.removeEventListener(ITEM_SCAN_EVENT, onScan); window.removeEventListener(ITEM_TAGS_EVENT, onTags); };
  }, []);
  const onFound = useCallback((it) => {
    setScanOpen(false);
    setHanded(it);
    openItemById(it.id);
  }, []);

  // ── the item's actions (the existing flows) ────────────────────────────
  const [acting, setActing] = useState(null);     // { kind, item, checkout }
  const [customFields, setCustomFields] = useState([]);
  const finish = useCallback(() => { setActing(null); closeItem(); }, [closeItem]);
  const runAction = useCallback((key) => {
    if (!item || !view) return;
    const co = view.checkout;
    switch (key) {
      case 'borrow': setActing({ kind: 'borrow', item, cart: [{ id: `scan-${item.id}`, item, days: 1 }] }); break;
      case 'return': setActing({ kind: 'return', item, checkout: co }); break;
      case 'confirm-receipt': setActing({ kind: 'receipt', item, checkout: co }); break;
      case 'hand-over': setActing({ kind: 'handover', item, checkout: co }); break;
      case 'details':
        api.getItemCustomFields().then(setCustomFields).catch(() => {});
        setActing({ kind: 'details', item });
        break;
      case 'print-tag': setTagItems([item]); break;
      case 'review-request': go('checkouts'); break;
      case 'accept-assignment':
      case 'return-assignment': go('permanent'); break;
      default: break;
    }
  }, [item, view]);

  const photoOptional = acting?.item?.pictureRequired === false;
  async function submitBorrow({ reason, approverEmail, approverName, forName = '', forEmail = '' }) {
    const cart = acting.cart;
    setActing((a) => ({ ...a, busy: true }));
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail, forName, forEmail, approverEmail, approverName });
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      setActing((a) => ({ ...a, busy: false }));
      say(failed.reason?.message || `Could not ask for ${acting.item.name}.`, 'error');
      return;
    }
    say(`Asked to borrow ${acting.item.name} - you will hear when it is approved.`);
    setActing(null);
    go('active-checkouts');
  }

  const actingUi = acting && (
    <>
      {acting.kind === 'borrow' && (
        <CartDrawer open cart={acting.cart} items={items} showApprover submitting={!!acting.busy}
          onClose={finish} onRemove={finish} onDaysChange={(id, days) => setActing((a) => ({ ...a, cart: a.cart.map((c) => (c.id === id ? { ...c, days } : c)) }))}
          onSubmit={submitBorrow} />
      )}
      {acting.kind === 'return' && acting.checkout && (
        <ReturnModal checkout={acting.checkout} photoOptional={photoOptional} onClose={finish}
          onSubmit={(data) => returnItem(acting.checkout.id, data)
            .then(() => { say(`Return confirmed - ${acting.item.name}`); finish(); })
            .catch((err) => say(err?.message || 'Could not confirm the return - please try again.', 'error'))} />
      )}
      {acting.kind === 'receipt' && acting.checkout && (
        <ReceiptConfirmModal checkouts={[acting.checkout]} photoOptional={photoOptional} onClose={finish}
          onConfirm={async ({ photoMap }) => {
            const p = photoMap?.[acting.checkout.id] || {};
            try { await confirmReceipt(acting.checkout.id, userName, p.url || '', p.name || ''); }
            catch (e) { throw new Error(e?.message || `Could not confirm receipt for ${acting.item.name}.`, { cause: e }); }
            say(`Confirmed - ${acting.item.name} is with you.`);
            finish();
          }} />
      )}
      {acting.kind === 'handover' && acting.checkout && (
        <AllocateModal checkout={acting.checkout} photoOptional={photoOptional} onClose={finish}
          onConfirm={({ photoBy, batch, photoMap }) => {
            const co = acting.checkout;
            const p = photoBy === 'employee'
              ? initiateHandover(co.id, userName)
              : allocateItem(co.id, userName, photoMap?.[co.id]?.url || '', photoMap?.[co.id]?.name || '', { handoverPhotoBy: 'allocator', handoverBatch: batch });
            return p.then(() => {
              say(photoBy === 'employee' ? `${co.requestedBy} has been asked to confirm receipt.` : `Handed over to ${co.requestedBy}.`);
              refreshItems?.(); refreshCheckouts?.();
              finish();
            });
          }} />
      )}
      {acting.kind === 'details' && (
        <ItemDetailsPanel item={acting.item} customFields={customFields} canEdit={isManager}
          onClose={finish} onSaved={refreshItems} toast={toast} />
      )}
    </>
  );

  const scanAnother = cameraSupport() === 'ok' ? () => { closeItem(); openItemScanner(); } : null;

  return (
    <>
      {status && !acting && (status === 'found' && renderItem
        ? renderItem({ item, view, close: closeItem, runAction })
        : <ItemQuickSheet status={status} item={item} view={view} onAction={runAction} onClose={closeItem} onScanAnother={scanAnother} />)}
      {actingUi}
      {scanOpen && (
        <SheetBoundary onClose={() => setScanOpen(false)}>
          <Suspense fallback={<Opening label="Opening the scanner..." />}>
            <ScannerSheet items={items} onFound={onFound} onClose={() => setScanOpen(false)} />
          </Suspense>
        </SheetBoundary>
      )}
      {tagItems && (
        <SheetBoundary onClose={() => setTagItems(null)}>
          <Suspense fallback={<Opening label="Getting the tags ready..." />}>
            <TagSheet items={tagItems} onClose={() => setTagItems(null)} />
          </Suspense>
        </SheetBoundary>
      )}
    </>
  );
}
