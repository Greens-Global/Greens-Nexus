// Item Management - Inventory > Who Has What: by person and by location.
// Items redesign (Neil, 11/02/2026): an item opens its record; the board is
// built once per load with Map lookups (it scanned every holder per item and
// every item per checkout, which crawled on a catalog of thousands).
import { useState, useMemo, memo } from 'react';
import { Search, X, MapPin, ZoomIn, ChevronRight, Users, User } from 'lucide-react';
import { useNameResolver } from '../../lib/useNameResolver';
import { TYPE_META, MANAGER_CHECKOUT_STATUS_META } from '../model/status';
import { checkoutWord } from '../model/words';
import { checkoutDueInfo } from '../model/due';
import { fmtMoney } from '../model/format';
import { useEscapeKey } from '../ui/hooks';
import { ImageLightbox } from '../ui/ImageLightbox';
import { TypeBadge, OpStatusBadge } from '../ui/badges';
import { HighlightMatch } from '../ui/HighlightMatch';

// Neil: clicking an item under a person shows that item's details and picture
// as a card - acting on it still routes through Checkouts / Assignments.
function WhwItemDetailCard({ item, checkout, holderName, onClose, onAct, actLabel }) {
  useEscapeKey(onClose);
  const tm = TYPE_META[item?.itemType || checkout?.itemType] || TYPE_META.Other;
  const name  = item?.name || checkout?.itemName || 'Item';
  const photo = item?.photoUrl || checkout?.checkoutPhotoUrl || null;
  const due   = checkout ? checkoutDueInfo(checkout) : null;
  const inUse = checkout?.status === 'allocated';
  const rows = [
    ['Held by', holderName],
    ['Type', [item?.itemType || checkout?.itemType, item?.department || checkout?.department].filter(Boolean).join(' · ') || '-'],
    item && (item.make || item.model) ? ['Make / Model', [item.make, item.model].filter(Boolean).join(' ')] : null,
    checkout
      ? ['Status', inUse
          ? (due.daysLeft < 0 ? `In use - overdue ${Math.abs(due.daysLeft)}d` : due.daysLeft === 0 ? 'In use - due today' : `In use - ${due.daysLeft}d left`)
          : (MANAGER_CHECKOUT_STATUS_META[checkout.status]?.label || checkout.status)]
      : ['Status', 'Permanently assigned'],
    checkout?.reason ? ['Reason', checkout.reason] : null,
    Number(item?.assetValue) > 0 ? ['Asset value', fmtMoney(Number(item.assetValue))] : null,
  ].filter(Boolean);
  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:4300, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, width:'100%', maxWidth:380, overflow:'hidden', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}>
        {/* Full photo, never cropped - the box grows to the image's own ratio */}
        <div style={{ background:'var(--mist)', display:'flex', alignItems:'center', justifyContent:'center', minHeight:120 }}>
          {photo
            ? <img src={photo} alt={name} style={{ width:'100%', maxHeight:'45vh', objectFit:'contain', display:'block' }} />
            : <tm.Icon size={44} color={tm.color} style={{ margin:'38px 0' }} />}
        </div>
        <div style={{ padding:'16px 18px' }}>
          <div style={{ fontWeight:800, fontSize:15, letterSpacing:'-.01em' }}>{name}</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:12 }}>
            {rows.map(([label, value]) => (
              <div key={label} style={{ display:'flex', gap:10, fontSize:13 }}>
                <span style={{ width:92, flexShrink:0, fontSize:11, fontWeight:800, letterSpacing:'.06em', color:'var(--muted)', textTransform:'uppercase', paddingTop:2 }}>{label}</span>
                <span style={{ color:'var(--ink)', fontWeight:600, minWidth:0 }}>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:16, justifyContent:'flex-end' }}>
            <button className="secondary-btn" style={{ fontSize:13 }} onClick={onClose}>Close</button>
            {onAct && <button className="primary-btn" style={{ fontSize:13 }} onClick={onAct}>{actLabel} →</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Who Has It Tab ────────────────────────────────────────────────────────────
// Per-person view of every allocation: searchable, split into permanent
// assignments and transient checkouts - Neil's "permanent vs transient" ask.
export const WhoHasItTab = memo(function WhoHasItTab({ items, checkouts, onOpenCheckouts, onOpenItem }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('person'); // 'person' | 'location' (Neil: split Who Has What)
  const [photoPreview, setPhotoPreview] = useState(null);
  const [detail, setDetail] = useState(null);
  const nameOf = useNameResolver(); // never show a raw email as the holder label (P4 names)
  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  // The record replaces the old detail card when the screen can open it.
  const show = (d) => (onOpenItem ? onOpenItem(d.item?.id || d.checkout?.itemId) : setDetail(d));

  // Transient: live checkouts grouped by holder
  const holders = useMemo(() => {
    const map = new Map(); // key → { name, transient: [], permanent: [], declared: [] }
    const byName = new Map(); // lower-case display name → holder (one lookup, not a scan)
    const add = (key, name) => { const h = { name, transient: [], permanent: [], declared: [] }; map.set(key, h); byName.set(name.toLowerCase(), h); return h; };
    for (const c of checkouts) {
      if (!['approved','pending_receipt','allocated'].includes(c.status) || !c.requestedBy) continue;
      const key = (c.requestedByEmail || c.requestedBy).toLowerCase();
      (map.get(key) || add(key, nameOf(c.requestedByEmail, c.requestedBy))).transient.push(c);
    }
    // Permanent: only items tagged to a REAL person via the assignment flow.
    // No defaultOwner fallback - that's a department label, not a holder, and
    // it filed unassigned items under whoever added them (Sai's Oneplus bug).
    for (const i of items) {
      if (i.ownershipType !== 'permanent' && i.status !== 'permanently_assigned') continue;
      // A person holder is required here. Location is just where the item lives now
      // (independent of the holder), so a person-held item that also sits at a place
      // still belongs under that person - no location-based exclusion.
      const email = (i.assignedToEmail || '').toLowerCase();
      const owner = (i.assignedToName || '').trim();
      if (!email && !owner) continue;
      const key = email || `perm-${owner.toLowerCase()}`;
      if (!map.has(key)) {
        // Resolve through People so a stale stored name ("Neil") still shows
        // the full directory name ("Neil Kadakia").
        const display = nameOf(email, owner);
        const existing = byName.get(display.toLowerCase()) || byName.get(owner.toLowerCase());
        if (existing) { existing.permanent.push(i); continue; }
        add(key, display);
      }
      map.get(key).permanent.push(i);
    }
    // Declared statuses (lost/retired) tied to a person - show under that person as
    // Person → Status → Item, so accountability is visible on the same board.
    for (const i of items) {
      if (!i.opStatus) continue;
      const email = (i.opStatusPersonEmail || '').toLowerCase();
      const owner = (i.opStatusPersonName  || '').trim();
      if (!email && !owner) continue;
      const key = email || `decl-${owner.toLowerCase()}`;
      if (!map.has(key)) {
        const display = nameOf(email, owner);
        const existing = byName.get(display.toLowerCase()) || byName.get(owner.toLowerCase());
        if (existing) { existing.declared.push(i); continue; }
        add(key, display);
      }
      map.get(key).declared.push(i);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [checkouts, items, nameOf]);

  const filtered = useMemo(() => holders.filter(h =>
    !search ||
    h.name.toLowerCase().includes(search.toLowerCase()) ||
    h.transient.some(c => c.itemName.toLowerCase().includes(search.toLowerCase())) ||
    h.permanent.some(i => i.name.toLowerCase().includes(search.toLowerCase())) ||
    h.declared.some(i => i.name.toLowerCase().includes(search.toLowerCase()))
  ), [holders, search]);

  const initials = name => name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  // Neil: "this person's holding $6,000 worth of items" - total value in hand
  const holderValue = h =>
    h.transient.reduce((s, c) => s + (Number(itemById.get(c.itemId)?.assetValue) || 0), 0) +
    h.permanent.reduce((s, i) => s + (Number(i.assetValue) || 0), 0);

  // By-location view - everything physically AT a place (Neil: "search GSE, see
  // everything that's there"). Groups every item by its location field.
  const places = useMemo(() => {
    const map = new Map();
    for (const i of items) {
      const loc = (i.location || '').trim() || '- No location set -';
      if (!map.has(loc)) map.set(loc, { location: loc, items: [], value: 0 });
      const g = map.get(loc);
      g.items.push(i);
      g.value += Number(i.assetValue) || 0;
    }
    return [...map.values()].sort((a, b) => a.location.localeCompare(b.location));
  }, [items]);
  const filteredPlaces = useMemo(() => places.filter(p =>
    !search || p.location.toLowerCase().includes(search.toLowerCase()) ||
    p.items.some(i => (i.name || '').toLowerCase().includes(search.toLowerCase()))
  ), [places, search]);
  const holderOf = (i) => {
    if (i.assignedToName || i.assignedToEmail) return nameOf(i.assignedToEmail, i.assignedToName);
    const co = checkouts.find(c => c.itemId === i.id && ['approved','pending_receipt','allocated'].includes(c.status));
    return co ? co.requestedBy : '';
  };

  return (
    <div>
      <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:20, flexWrap:'wrap' }}>
        <div className="search-bar" style={{ flex:1, minWidth:220, maxWidth:420, marginBottom:0 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder={view === 'person' ? 'Search by person or item…' : 'Search by location or item…'} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
          {search && <button className="search-clear" onClick={() => setSearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
        </div>
        {/* By Person / By Location (Neil: search GSE → see everything there) */}
        <div style={{ display:'inline-flex', border:'1px solid var(--line)', borderRadius:9, overflow:'hidden', flexShrink:0 }}>
          {[['person', 'By person', User], ['location', 'By location', MapPin]].map(([k, label, Icon]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', fontSize:13, fontWeight:700, border:'none', cursor:'pointer', fontFamily:'Inter,sans-serif', background: view === k ? 'var(--pine)' : 'var(--card)', color: view === k ? '#fff' : 'var(--muted)' }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'location' ? (
        filteredPlaces.length === 0 ? (
          <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
            <MapPin size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
            {search ? 'No location or item matches your search.' : 'No items yet.'}
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(330px,1fr))', gap:14 }}>
            {filteredPlaces.map(p => (
              <div key={p.location} style={{ border:'1px solid var(--line)', borderRadius:12, background:'var(--card)', boxShadow:'var(--shadow-sm)', overflow:'hidden' }}>
                <div style={{ display:'flex', alignItems:'center', gap:11, padding:'13px 16px', borderBottom:'1px solid var(--line)', background:'var(--mist)' }}>
                  <div style={{ width:34, height:34, borderRadius:9, background:'hsla(var(--color-green),0.14)', color:'hsl(var(--color-green))', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><MapPin size={17} /></div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={p.location} query={search} /></div>
                    <div style={{ fontSize:12, color:'var(--muted)' }}>{p.items.length} item{p.items.length !== 1 ? 's' : ''}{p.value > 0 && <> · <strong style={{ color:'var(--ink)' }}>{fmtMoney(p.value)}</strong></>}</div>
                  </div>
                </div>
                <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:6, maxHeight:340, overflowY:'auto' }}>
                  {p.items.map(i => {
                    const who = holderOf(i);
                    return (
                      <div key={i.id} onClick={() => show({ item: i, holderName: who })} title="View item details"
                        style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                        <TypeBadge type={i.itemType} />
                        {who && <span style={{ fontSize:11, color:'var(--muted)', flexShrink:0, maxWidth:90, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{who}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Users size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {search ? 'Nobody matches your search.' : 'No items are currently allocated to anyone.'}
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(330px,1fr))', gap:14 }}>
          {filtered.map(h => (
            <div key={h.name} style={{ border:'1px solid var(--line)', borderRadius:12, background:'var(--card)', boxShadow:'var(--shadow-sm)', overflow:'hidden' }}>
              {/* Person header - click-through to their orders & actions */}
              <div onClick={() => onOpenCheckouts?.({ q: h.name, segment: h.transient.length ? 'checkouts' : 'assignments' })}
                title={`Open ${h.name}'s checkouts - approve, hand over, force return`}
                style={{ display:'flex', alignItems:'center', gap:11, padding:'13px 16px', borderBottom:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', transition:'background .12s' }}
                onMouseEnter={e => e.currentTarget.style.background = 'hsla(var(--color-blue),0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--mist)'}>
                <div style={{ width:34, height:34, borderRadius:'50%', background:'hsla(var(--color-blue),0.14)', color:'hsl(var(--color-blue))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:800, flexShrink:0 }}>
                  {initials(h.name)}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={h.name} query={search} /></div>
                  <div style={{ fontSize:12, color:'var(--muted)' }}>
                    {h.transient.length > 0 && `${h.transient.length} checked out`}
                    {h.transient.length > 0 && h.permanent.length > 0 && ' · '}
                    {h.permanent.length > 0 && `${h.permanent.length} permanent`}
                    {h.declared.length > 0 && ((h.transient.length > 0 || h.permanent.length > 0) ? ' · ' : '')}
                    {h.declared.length > 0 && `${h.declared.length} declared`}
                    {holderValue(h) > 0 && <> · <strong style={{ color:'var(--ink)' }}>{fmtMoney(holderValue(h))}</strong> in hand</>}
                  </div>
                </div>
                <ChevronRight size={15} style={{ color:'var(--muted)', flexShrink:0 }} />
              </div>

              <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:12 }}>
                {/* Transient */}
                {h.transient.length > 0 && (
                  <div>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:7 }}>Checked Out (Temporary)</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.transient.map(c => {
                        const { daysLeft } = checkoutDueInfo(c);
                        const inUse = c.status === 'allocated';
                        const itemPhoto = itemById.get(c.itemId)?.photoUrl || c.checkoutPhotoUrl;
                        return (
                          // Row click → item detail card (photo + facts); the
                          // card's action button deep-links into Checkouts
                          <div key={c.id} onClick={() => show({
                              item: itemById.get(c.itemId) || null,
                              checkout: c, holderName: h.name,
                              act: () => { setDetail(null); onOpenCheckouts?.({ q: c.itemName }); },
                              actLabel: 'Open in Checkouts',
                            })}
                            title="View item details"
                            style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background: inUse ? (daysLeft < 0 ? 'var(--wk-red)' : 'var(--wk-live)') : '#64748b' }} />
                            <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={c.itemName} query={search} /></span>
                            <span style={{ fontSize:12, color: inUse && daysLeft < 0 ? 'var(--bad-fg)' : 'var(--muted)', flexShrink:0, fontWeight: inUse && daysLeft < 0 ? 600 : 400 }}>
                              {inUse
                                ? (daysLeft < 0 ? `Overdue ${Math.abs(daysLeft)}d` : daysLeft === 0 ? 'Due today' : `${daysLeft}d left`)
                                : checkoutWord(c).label}
                            </span>
                            {itemPhoto && (
                              <button onClick={e => { e.stopPropagation(); setPhotoPreview(itemPhoto); }}
                                title="See the exact item"
                                style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                                <ZoomIn size={12} />
                              </button>
                            )}
                            <ChevronRight size={12} style={{ color:'var(--muted)', flexShrink:0, opacity:.6 }} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Permanent */}
                {h.permanent.length > 0 && (
                  <div>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:7 }}>Permanently Assigned</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.permanent.map(i => (
                        // Row click → item detail card; its action button opens
                        // Assignments (force recover / reassign live there)
                        <div key={i.id} onClick={() => show({
                            item: i, holderName: h.name,
                            act: () => { setDetail(null); onOpenCheckouts?.({ segment: 'assignments' }); },
                            actLabel: 'Open in Assignments',
                          })}
                          title="View item details"
                          style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background:'hsl(var(--color-blue))' }} />
                          <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                          <span style={{ fontSize:11, color:'var(--muted)', flexShrink:0 }}>{[i.make, i.model].filter(Boolean).join(' ') || i.itemType}</span>
                          {i.photoUrl && (
                            <button onClick={e => { e.stopPropagation(); setPhotoPreview(i.photoUrl); }}
                              title="See the exact item"
                              style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                          <ChevronRight size={12} style={{ color:'var(--muted)', flexShrink:0, opacity:.6 }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Declared (lost / retired) - Person → Status → Item */}
                {h.declared.length > 0 && (
                  <div>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--muted)', marginBottom:7 }}>Declared</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.declared.map(i => (
                        <div key={i.id} onClick={() => show({ item: i, holderName: h.name })}
                          title="View item details"
                          style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <OpStatusBadge value={i.opStatus} />
                          <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                          {i.photoUrl && (
                            <button onClick={e => { e.stopPropagation(); setPhotoPreview(i.photoUrl); }}
                              title="See the exact item"
                              style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <WhwItemDetailCard
          item={detail.item} checkout={detail.checkout} holderName={detail.holderName}
          onAct={detail.act} actLabel={detail.actLabel}
          onClose={() => setDetail(null)}
        />
      )}
      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
    </div>
  );
});
