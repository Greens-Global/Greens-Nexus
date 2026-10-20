// Tickets <-> equipment (Oct 2026). backend/routers/ticket_items.py is the
// server half and decides who may link what (the picker only ever offers what
// the server returns):
//   * TicketEquipmentIntake - the Equipment field on Create a Ticket; the
//     requester's own items (assigned or checked out) come first;
//   * TicketEquipment - the drawer's Equipment: chips (name, serial or asset
//     tag, who has it), Add Equipment, and per item its Other Tickets for
//     This Item (only tickets the viewer may open).
// Items themselves belong to the Inventory module - nothing here edits one.
import { useEffect, useRef, useState } from 'react';
import { Laptop, Plus, Search, X } from 'lucide-react';
import { api } from '../api';
import { NX, btn, chip, input as inputStyle } from '../tasks/theme';
import { label, field, ticketNoShort, TICKET_STATUS_META } from './ticketMeta';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { dialog as appDialog } from '../ui/dialog';

const hint = (text) => <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{text}</div>;

/** "GG-00012" or the asset tag - whichever the item has, serial first. */
function itemTag(item) {
  return item?.serialNumber || item?.assetTag || '';
}

function itemSub(item) {
  const who = item.assignedToName || item.assignedToEmail || (item.heldBy && item.heldBy !== item.assignedToEmail ? item.heldBy : '');
  return [itemTag(item), item.makeModel, who ? `With ${who}` : ''].filter(Boolean).join(' · ');
}

/** The picker's choices, re-fetched (debounced) as the search changes. */
function useItemOptions(params, open) {
  // `forKey` = the search the answer belongs to; a different one = loading.
  const [state, setState] = useState({ forKey: null, items: [], error: '' });
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const h = setTimeout(() => {
      Promise.resolve().then(() => api.getTicketItemOptions(JSON.parse(key)))
        .then((r) => { if (live) setState({ forKey: key, items: Array.isArray(r?.items) ? r.items : [], error: '' }); })
        .catch((e) => { if (live) setState({ forKey: key, items: [], error: e?.message || 'Could not load equipment' }); });
    }, 200);
    return () => { live = false; clearTimeout(h); };
  }, [key, open]);
  return { loading: state.forKey !== key, items: state.items, error: state.forKey === key ? state.error : '' };
}

/** Search box + results. `onPick(item)`; `takenIds` are left out. */
export function EquipmentPicker({ params, takenIds = [], onPick, onClose, busy = false }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const { loading, items, error } = useItemOptions({ ...params, q }, true);
  const shown = items.filter((i) => !takenIds.includes(i.id));
  return (
    <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, background: NX.surface, padding: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={14} style={{ color: NX.faint, flexShrink: 0 }} />
        <input ref={inputRef} aria-label="Search equipment" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, serial number or person…"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}
          style={{ ...inputStyle, flex: 1 }} />
        <button type="button" onClick={onClose} style={btn('ghost')}>Done</button>
      </div>
      <div role="listbox" aria-label="Equipment" style={{ maxHeight: 240, overflowY: 'auto', marginTop: 6 }}>
        {loading && items.length === 0 && <SkeletonBlocks count={3} height={34} />}
        {error && <div style={{ fontSize: 12.5, color: NX.red, padding: 8 }}>{error}</div>}
        {!loading && !error && shown.length === 0 && (
          <div style={{ fontSize: 12.5, color: NX.faint, padding: 8 }}>
            {q ? 'No equipment matches that search.' : 'No equipment you can link. Equipment assigned to you or checked out by you shows here.'}
          </div>
        )}
        {shown.map((i) => (
          <button key={i.id} type="button" role="option" aria-selected="false" disabled={busy} onClick={() => onPick(i)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px',
              border: 'none', borderRadius: 8, background: 'transparent', cursor: busy ? 'default' : 'pointer', color: NX.ink, font: 'inherit' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <Laptop size={14} style={{ color: NX.faint, flexShrink: 0 }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{itemSub(i)}</span>
            </span>
            {i.mine && <span style={{ ...chip(NX.blue, 'rgba(37,99,235,0.12)'), fontSize: 11, padding: '1px 7px', flexShrink: 0 }}>Yours</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One linked item as a chip. */
function ItemChip({ item, onRemove }) {
  const gone = item.removed || item.deleted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '4px 8px 4px 10px',
      borderRadius: 999, border: `1px solid ${NX.border2}`, background: NX.surface2, fontSize: 12.5, color: NX.ink }}>
      <Laptop size={13} style={{ color: NX.faint, flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={itemSub(item) || item.name}>
        <b style={{ fontWeight: 600 }}>{item.name}</b>
        {itemTag(item) && <span style={{ color: NX.dim }}> · {itemTag(item)}</span>}
        {(item.assignedToName || item.assignedToEmail) && <span style={{ color: NX.faint }}> · {item.assignedToName || item.assignedToEmail}</span>}
      </span>
      {gone && <span style={{ ...chip(NX.faint, NX.border2), fontSize: 10.5, padding: '0 6px' }}>{item.removed ? 'Removed' : 'Deleted'}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${item.name}`} title="Remove"
          style={{ ...btn('ghost'), padding: 2, color: NX.faint }}><X size={12} /></button>
      )}
    </span>
  );
}

/**
 * Create a Ticket: Equipment. `value` is the picked items (objects - the
 * form submits their ids as item_ids). `requester` / `companyId` are the
 * form's, so the suggestions follow whoever the ticket is for.
 */
export function TicketEquipmentIntake({ value = [], onChange, requester = '', companyId = '' }) {
  const [open, setOpen] = useState(false);
  const picked = Array.isArray(value) ? value : [];
  return (
    <div style={field}>
      <label style={label}>Equipment</label>
      {picked.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {picked.map((i) => <ItemChip key={i.id} item={i} onRemove={() => onChange(picked.filter((x) => x.id !== i.id))} />)}
        </div>
      )}
      {open ? (
        <EquipmentPicker params={{ requester: requester || '', company_id: companyId || '' }} takenIds={picked.map((i) => i.id)}
          onPick={(i) => onChange([...picked, i])} onClose={() => setOpen(false)} />
      ) : (
        <button type="button" onClick={() => setOpen(true)} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}>
          <Plus size={13} /> Add Equipment
        </button>
      )}
      {hint('Optional - the laptop, phone or tool this is about. Yours are listed first.')}
    </div>
  );
}

function openTicket(id) {
  window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } }));
}

/** An item's other tickets, collapsed to a count until opened. */
function OtherTickets({ item }) {
  const [open, setOpen] = useState(false);
  const n = item.otherCount || 0;
  if (!n) return <div style={{ fontSize: 12, color: NX.faint, marginLeft: 4 }}>No other tickets for this item.</div>;
  return (
    <div style={{ marginLeft: 4 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        style={{ ...btn('ghost'), padding: '2px 4px', fontSize: 12, color: NX.primary }}>
        Other Tickets for This Item ({n})
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {(item.otherTickets || []).map((x) => {
            const m = TICKET_STATUS_META[x.status] || { label: x.status || 'Open', color: NX.dim };
            return (
              <button key={x.id} type="button" onClick={() => openTicket(x.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', border: 'none', borderRadius: 6,
                  background: 'transparent', cursor: 'pointer', textAlign: 'left', font: 'inherit', fontSize: 12.5, color: NX.ink }}>
                <span style={{ color: NX.dim, flexShrink: 0 }}>{ticketNoShort(x.code)}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.subject}</span>
                <StatusLabel size="sm" label={m.label} color={m.color} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The drawer's Equipment section for an existing ticket. */
export function TicketEquipment({ ticketId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // Through a promise so even a missing endpoint lands in the catch - this
    // section must never take the drawer down with it.
    Promise.resolve().then(() => api.getTicketItems(ticketId))
      .then((r) => { if (live) { setData(r); setError(''); } })
      .catch((e) => { if (live) { setError(e?.message || 'Could not load equipment'); setData(null); } });
    return () => { live = false; };
  }, [ticketId, attempt]);
  const retry = () => { setError(''); setAttempt((n) => n + 1); };

  const act = async (fn, what) => {
    if (busy) return;
    setBusy(true);
    try { setData(await fn()); } catch (e) { appDialog.alert(`Could not ${what}: ${e?.message || e}`); }
    setBusy(false);
  };

  if (error) {
    return (
      <div style={{ fontSize: 12.5, color: NX.faint }}>
        {error}. <button type="button" onClick={retry} style={{ ...btn('ghost'), padding: '0 4px', fontSize: 12.5, color: NX.primary }}>Try Again</button>
      </div>
    );
  }
  if (data === null) return <SkeletonBlocks count={1} height={30} />;
  const items = Array.isArray(data.items) ? data.items : [];
  return (
    <div>
      {items.length === 0 && !data.canLink && <span style={{ fontSize: 12.5, color: NX.faint }}>No equipment linked.</span>}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
          {items.map((i) => (
            <div key={i.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
              <ItemChip item={i} onRemove={i.canUnlink ? () => act(() => api.unlinkTicketItem(ticketId, i.id), 'remove the equipment') : null} />
              <OtherTickets item={i} />
            </div>
          ))}
        </div>
      )}
      {data.canLink && (adding ? (
        <EquipmentPicker params={{ ticket_id: ticketId }} takenIds={items.map((i) => i.id)} busy={busy}
          onPick={(i) => act(() => api.linkTicketItems(ticketId, [i.id]), 'link the equipment')} onClose={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} style={{ ...btn('outline'), borderStyle: 'dashed', fontSize: 12 }}>
          {busy ? <Spinner size={12} /> : <Plus size={13} />} Add Equipment
        </button>
      ))}
    </div>
  );
}
