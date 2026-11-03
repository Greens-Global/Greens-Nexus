// Item Management - The catalog tile grid.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useMemo, memo } from 'react';
import { Package, Plus, CheckCircle, X, ZoomIn } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { TYPE_META, STATUS_META } from '../model/status';
import { cleanField } from '../model/fields';
import { checkoutDueInfo } from '../model/due';
import { useIsMobile } from '../ui/hooks';
import { ImageLightbox } from '../ui/ImageLightbox';
import { TypeBadge } from '../ui/badges';

// ── Item Photo Grid (shared by employee + manager catalog) ────────────────────
export const ItemPhotoGrid = memo(function ItemPhotoGrid({ items, checkouts, itemsLoading, itemsError, refreshItems, onAddToCart, onRemoveFromCart, inCart, emptyLabel }) {
  const [lightbox, setLightbox] = useState(null);
  const isMobile = useIsMobile(); // phones get the minimal (amazon-style) tiles

  // Items with active requests: combine server-reported flag (works for all
  // users, not just managers) with the local checkouts list.
  const pendingCheckoutIds = useMemo(() => new Set(
    (checkouts || []).filter(c => ['pending','approved','pending_receipt'].includes(c.status)).map(c => c.itemId)
  ), [checkouts]);

  // Available items first, then unavailable, alpha within each group
  const sorted = useMemo(() => [...items].sort((a, b) => {
    const aAvail = a.status === 'available' ? 0 : 1;
    const bAvail = b.status === 'available' ? 0 : 1;
    if (aAvail !== bAvail) return aAvail - bAvail;
    return a.name.localeCompare(b.name);
  }), [items]);

  if (itemsError) return <ErrorBanner message="Could not load items right now." onRetry={refreshItems} />;
  if (itemsLoading && !items.length) return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:14 }}>
      {Array.from({ length: 6 }).map((_, i) => <SkeletonBlocks key={i} count={1} height={200} borderRadius={12} />)}
    </div>
  );
  if (!items.length) return (
    <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
      <Package size={36} style={{ opacity:.2, display:'block', margin:'0 auto 12px' }} />
      {emptyLabel || 'No items available right now.'}
    </div>
  );

  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:14 }}>
        {/* Render cap: the catalog can hold thousands of items (1,680+ on prod);
            drawing every card at once freezes the browse screen. Cap the cards;
            search/filter reaches the rest. */}
        {sorted.slice(0, 200).map(item => {
          const tm = TYPE_META[item.itemType] || TYPE_META.Other;
          const alreadyInCart = inCart?.has(item.id);
          const isAvailable = item.status === 'available';
          // hasPending: item has a request in flight - block Add to Cart for everyone.
          // item.hasActiveRequest comes from the server and is visible to all users,
          // even employees who can't see other users' checkouts.
          const hasPending  = isAvailable && (pendingCheckoutIds.has(item.id) || !!item.hasActiveRequest);
          const canAdd = onAddToCart && isAvailable && !hasPending && item.ownershipType === 'transient';

          // Show who has the item and when it becomes available.
          // Use local checkouts list if visible (managers), fall back to server fields.
          let checkedOutBy = null, daysLeft = null;
          if (!isAvailable || hasPending) {
            const co = checkouts?.find(c => c.itemId === item.id && ['approved','pending_receipt','allocated'].includes(c.status));
            checkedOutBy = co?.requestedBy ?? item.activeRequestedBy ?? null;
            const dueSrc = co
              ? checkoutDueInfo(co).due
              : item.activeDueDate ? new Date(item.activeDueDate) : null;
            if (dueSrc) {
              const diff = Math.ceil((dueSrc - Date.now()) / 86400000);
              daysLeft = diff > 0 ? diff : 0;
            }
          }

          // Phones: minimal tiles - photo floating on the background with a
          // small + on the image, one quiet info line, no card chrome or
          // colored chips (Visesh: amazon-app minimal, not high-school cards)
          if (isMobile) {
            return (
              <div key={item.id} style={{ display:'flex', flexDirection:'column' }}>
                <div onClick={() => item.photoUrl && setLightbox({ src: item.photoUrl, alt: item.name })}
                  style={{ position:'relative', aspectRatio:'1', borderRadius:12, overflow:'hidden', background: item.photoUrl ? 'var(--mist)' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center', opacity: (isAvailable && !hasPending) ? 1 : 0.6 }}>
                  {item.photoUrl
                    ? <img src={item.photoUrl} alt={item.name} loading="lazy" decoding="async" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    : <tm.Icon size={34} color={tm.color} />}
                  {canAdd && (
                    <button onClick={e => { e.stopPropagation(); alreadyInCart ? onRemoveFromCart?.(item.id) : onAddToCart(item); }}
                      aria-label={alreadyInCart ? 'Remove from cart' : 'Add to cart'}
                      style={{ position:'absolute', right:8, bottom:8, width:34, height:34, borderRadius:'50%', border:'none', background: alreadyInCart ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 2px 10px rgba(0,0,0,0.25)', cursor:'pointer' }}>
                      {alreadyInCart ? <X size={16} /> : <Plus size={16} />}
                    </button>
                  )}
                  {(hasPending || !isAvailable) && (
                    <div style={{ position:'absolute', left:0, right:0, bottom:0, background:'rgba(15,23,42,0.62)', color:'#fff', fontSize:10.5, fontWeight:600, textAlign:'center', padding:'4px 6px' }}>
                      {hasPending ? 'Under review' : item.status === 'checked_out' ? `In use${checkedOutBy ? ` · ${checkedOutBy}` : ''}` : STATUS_META[item.status]?.label || 'Unavailable'}
                    </div>
                  )}
                </div>
                <div style={{ padding:'7px 2px 0' }}>
                  <div style={{ fontSize:13, fontWeight:600, lineHeight:1.3, color:'var(--ink)', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{item.name}</div>
                  <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {[item.make, item.model, item.location].filter(Boolean).join(' · ') || item.itemType}
                  </div>
                  {!isAvailable && daysLeft != null && (
                    <div style={{ fontSize:11, color:'var(--muted)', marginTop:1 }}>{daysLeft === 0 ? 'back today' : `back in ${daysLeft}d`}</div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={item.id}
              style={{ border:'1px solid var(--line)', borderRadius:12, overflow:'hidden', background:'var(--card)', display:'flex', flexDirection:'column', transition:'box-shadow 0.15s', boxShadow:'var(--shadow-sm)' }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow-md)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = 'var(--shadow-sm)'}>
              {/* Photo - only this part fades when unavailable; status info below stays full-colour */}
              <div onClick={() => item.photoUrl && isAvailable && !hasPending && setLightbox({ src: item.photoUrl, alt: item.name })}
                style={{ height:160, background: item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, cursor: item.photoUrl && isAvailable && !hasPending ? 'zoom-in' : 'default', position:'relative', overflow:'hidden', opacity: (isAvailable && !hasPending) ? 1 : 0.55 }}>
                {item.photoUrl
                  ? <img src={item.photoUrl} alt={item.name} loading="lazy" decoding="async" style={{ width:'100%', height:'100%', objectFit:'cover', filter: (isAvailable && !hasPending) ? 'none' : 'grayscale(60%)' }} />
                  : <tm.Icon size={40} color={tm.color} />}
                {item.photoUrl && isAvailable && !hasPending && (
                  <div style={{ position:'absolute', top:6, right:6, background:'rgba(0,0,0,0.45)', borderRadius:6, padding:'2px 5px', display:'flex', alignItems:'center', gap:3 }}>
                    <ZoomIn size={11} color="#fff" />
                  </div>
                )}
                {alreadyInCart && (
                  <div style={{ position:'absolute', top:6, left:6, background:'hsl(var(--color-green))', borderRadius:6, padding:'2px 7px', display:'flex', alignItems:'center', gap:3 }}>
                    <CheckCircle size={10} color="#fff" />
                    <span style={{ fontSize:10, color:'#fff', fontWeight:700 }}>In cart</span>
                  </div>
                )}
                {hasPending && (
                  <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.18)', display:'flex', alignItems:'flex-end', justifyContent:'center', padding:'0 0 8px' }}>
                    <span style={{ background:'rgba(220,120,0,0.85)', color:'#fff', fontSize:10.5, fontWeight:700, borderRadius:6, padding:'2px 8px' }}>
                      Pending request
                    </span>
                  </div>
                )}
                {!isAvailable && (
                  <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.15)', display:'flex', alignItems:'flex-end', justifyContent:'center', padding:'0 0 8px' }}>
                    <span style={{ background:'rgba(0,0,0,0.65)', color:'#fff', fontSize:10.5, fontWeight:700, borderRadius:6, padding:'2px 8px' }}>
                      {STATUS_META[item.status]?.label || item.status}
                    </span>
                  </div>
                )}
              </div>
              {/* Info - one calm meta line; the full spec lives behind the photo/
                  details affordances rather than stacked on the card face. */}
              <div style={{ padding:'10px 12px', flex:1, display:'flex', flexDirection:'column', gap:5 }}>
                <div style={{ fontWeight:700, fontSize:13, lineHeight:1.3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={item.name}>{item.name}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                  <TypeBadge type={item.itemType} />
                </div>
                {(item.make || item.model || item.location) && (
                  <div style={{ fontSize:11.5, color:'var(--muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}
                    title={[cleanField(item.make), cleanField(item.model), cleanField(item.location)].filter(Boolean).join(' · ')}>
                    {[[cleanField(item.make), cleanField(item.model)].filter(Boolean).join(' '), cleanField(item.location)].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
              {/* Action */}
              <div style={{ padding:'0 12px 12px' }}>
                {canAdd ? (
                  <button onClick={() => alreadyInCart ? onRemoveFromCart?.(item.id) : onAddToCart(item)}
                    className={alreadyInCart ? 'secondary-btn' : 'primary-btn'}
                    style={{ width:'100%', fontSize:12.5, padding:'7px 0', display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                    {alreadyInCart ? <><X size={12} /> Remove from cart</> : <><Plus size={12} /> Add to cart</>}
                  </button>
                ) : hasPending ? (
                  <div style={{ textAlign:'center', fontSize:11.5, color:'hsl(var(--color-orange))', fontWeight:600 }}>Under review</div>
                ) : !isAvailable ? (
                  <div style={{ textAlign:'center', fontSize:11, lineHeight:1.5 }}>
                    {item.status === 'checked_out' ? (
                      <>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 9px', borderRadius:20, fontSize:10.5, fontWeight:800, background:'hsla(var(--color-orange),0.14)', color:'hsl(var(--color-orange))' }}>
                          In use
                        </span>
                        {checkedOutBy && (
                          <span style={{ display:'block', fontSize:11, fontWeight:600, color:'var(--ink)', marginTop:3 }}>{checkedOutBy}</span>
                        )}
                        {daysLeft != null && (
                          <span style={{ display:'block', fontSize:10.5, fontWeight:500, color:'var(--muted)' }}>
                            {daysLeft === 0 ? 'due back today' : `available in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}
                          </span>
                        )}
                      </>
                    ) : item.status === 'permanently_assigned' ? (
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 9px', borderRadius:20, fontSize:10.5, fontWeight:800, background:'hsla(var(--color-blue),0.14)', color:'hsl(var(--color-blue))' }}>
                        Permanently assigned
                      </span>
                    ) : item.status === 'retired' ? (
                      <span style={{ fontWeight:600, color:'var(--muted)' }}>Retired</span>
                    ) : (
                      <span style={{ fontWeight:600, color:'var(--muted)' }}>Unavailable</span>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {sorted.length > 200 && (
        <div style={{ padding:'10px 4px', fontSize:12, color:'var(--muted)', textAlign:'center' }}>
          Showing 200 of {sorted.length} items - search or filter to narrow down.
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
});
