// Item Management - Borrow (Items redesign, Neil 11/02/2026).
//
// The catalog of what people can actually borrow (model/borrow.js): search,
// ONE type control listing only the borrowable types that have items, a
// location control when there is more than one, and the tiles - items in the
// first screen on a phone. The cart is the one sticky bar at the foot
// (CartBar) and never covers a tile: the list reserves its height.
import { memo, useDeferredValue, useMemo, useState } from 'react';
import { Search, X, Plus, Check, MapPin } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import { formatDate } from '../../lib/datetime';
import { borrowableItems, borrowTypeOptions, filterBorrow, isFreeToBorrow } from '../model/borrow';
import { useTypeSettings } from '../model/useTypeSettings';
import { cleanField } from '../model/fields';
import { todayISO } from '../model/due';
import { addToCart, removeFromCart, useItemCart } from '../cart/useItemCart';
import { NoPhoto } from '../ui/photos';
import { itemsToast } from '../ui/Toast';
import { CartBar } from './CartBar';

const CAP = 120;   // tiles drawn at once; search and the filters reach the rest

const Tile = memo(function Tile({ item, free, inCart, liveCo, onOpen }) {
  const back = item.activeDueDay || (liveCo?.dueDate) || '';
  const late = !!back && back < todayISO();
  const state = free ? null
    : item.status === 'checked_out'
      ? (late ? { label: 'Overdue', color: 'var(--wk-red)', note: `Was due ${formatDate(back)}` }
        : { label: 'In Use', color: 'var(--wk-live)', note: back ? `Back ${formatDate(back)}` : '' })
    : item.opStatus === 'in_repair' ? { label: 'In Repair', color: '#64748b', note: '' }
    : { label: 'Requested', color: '#64748b', note: '' };
  const meta = [[cleanField(item.make), cleanField(item.model)].filter(Boolean).join(' '), cleanField(item.location)].filter(Boolean).join(' · ');
  return (
    <div className={`it-tile${free ? '' : ' is-out'}`}>
      <button type="button" className="it-tile-photo" onClick={() => onOpen(item.id)} aria-label={`Open ${item.name}`}>
        {item.photoUrl
          ? <img src={item.photoUrl} alt="" loading="lazy" decoding="async" />
          : <NoPhoto size={96} radius={0} label style={{ width: '100%', height: '100%', border: 'none' }} />}
      </button>
      <div className="it-tile-body">
        <button type="button" className="it-tile-name" onClick={() => onOpen(item.id)} title={item.name}>{item.name}</button>
        <div className="it-tile-meta" title={meta}>{meta || item.itemType}</div>
        <div className="it-tile-foot">
          {free ? (
            <button type="button" className={inCart ? 'secondary-btn it-btn-sm' : 'primary-btn it-btn-sm'} aria-pressed={inCart}
              onClick={() => inCart
                ? removeFromCart(item.id, { onError: m => itemsToast(m, 'error') })
                : addToCart(item, { onError: m => itemsToast(m, 'error') })}>
              {inCart ? <><Check size={13} /> In Cart</> : <><Plus size={13} /> Add</>}
            </button>
          ) : (
            <>
              <StatusLabel label={state.label} color={state.color} size="sm" />
              {state.note && <span className="it-tile-note">{state.note}</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export function BorrowTab({ items = [], checkouts = [], itemsLoading, itemsError, refreshItems, onOpenItem, onReviewCart }) {
  const { byName, loaded } = useTypeSettings();
  const { inCart, count } = useItemCart();
  const [q, setQ] = useState('');
  const [type, setType] = useState('All');
  const [location, setLocation] = useState('All');
  const [shown, setShown] = useState(CAP);
  const dq = useDeferredValue(q);

  const pool = useMemo(() => borrowableItems(items, byName), [items, byName]);
  const types = useMemo(() => borrowTypeOptions(pool), [pool]);
  const locations = useMemo(() => [...new Set(pool.map(i => (i.location || '').trim()).filter(Boolean))].sort(), [pool]);
  const liveCos = useMemo(() => {
    const m = new Map();
    for (const c of checkouts) if (['pending', 'approved', 'pending_receipt', 'allocated'].includes(c.status)) m.set(c.itemId, c);
    return m;
  }, [checkouts]);
  const liveIds = useMemo(() => new Set(liveCos.keys()), [liveCos]);
  const list = useMemo(() => filterBorrow(pool, { q: dq, type, location, liveItemIds: liveIds }), [pool, dq, type, location, liveIds]);
  const freeCount = useMemo(() => list.filter(i => isFreeToBorrow(i, liveIds)).length, [list, liveIds]);
  const filtered = !!(q || type !== 'All' || location !== 'All');

  const body = itemsError ? <ErrorBanner message="Could not load the items right now." onRetry={refreshItems} />
    : (itemsLoading || !loaded) && !pool.length ? (
      <div className="it-grid">{Array.from({ length: 8 }).map((_, i) => <SkeletonBlocks key={i} count={1} height={210} borderRadius={12} />)}</div>
    ) : list.length === 0 ? (
      <div className="it-empty">
        <div className="it-empty-title">{filtered ? 'Nothing matches' : 'Nothing to borrow yet'}</div>
        <div className="it-empty-sub">{filtered ? 'Try another word, or clear the filters.' : 'When an items admin adds items people can borrow, they show here.'}</div>
        {filtered && <button className="secondary-btn" style={{ marginTop: 12 }} onClick={() => { setQ(''); setType('All'); setLocation('All'); }}>Clear Filters</button>}
      </div>
    ) : (
      <>
        <div className="it-grid">
          {list.slice(0, shown).map(item => (
            <Tile key={item.id} item={item} free={isFreeToBorrow(item, liveIds)} inCart={inCart.has(item.id)}
              liveCo={liveCos.get(item.id)} onOpen={onOpenItem} />
          ))}
        </div>
        {list.length > shown && (
          <button type="button" className="it-more" onClick={() => setShown(n => n + CAP)}>Show {Math.min(CAP, list.length - shown)} More</button>
        )}
      </>
    );

  return (
    <div className={`it-borrow${count ? ' has-cart' : ''}`}>
      <div className="it-toolbar">
        <div className="search-bar it-search">
          <Search size={14} style={{ flexShrink: 0 }} />
          <input placeholder="Search by name, make, model or serial…" value={q} onChange={e => { setQ(e.target.value); setShown(CAP); }} aria-label="Search items to borrow" />
          {q && <button className="search-clear" onClick={() => setQ('')} aria-label="Clear search"><X size={13} /></button>}
        </div>
        <select className="form-input it-select" value={type} onChange={e => { setType(e.target.value); setShown(CAP); }} aria-label="Type">
          <option value="All">All Types ({pool.length})</option>
          {types.map(t => <option key={t.type} value={t.type}>{t.type} ({t.count})</option>)}
        </select>
        {locations.length > 1 && (
          <label className="it-select-wrap">
            <MapPin size={13} aria-hidden="true" />
            <select className="form-input it-select" value={location} onChange={e => { setLocation(e.target.value); setShown(CAP); }} aria-label="Location">
              <option value="All">All Locations</option>
              {locations.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        )}
        <span className="it-toolbar-meta">{freeCount} free now · {list.length} shown</span>
      </div>
      {body}
      <CartBar onReview={onReviewCart} />
    </div>
  );
}
