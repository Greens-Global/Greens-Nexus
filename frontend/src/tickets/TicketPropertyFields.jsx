// Every property-related ticket lands on the property and its unit (Neil,
// Ops review Oct 20 2026: "it should sit with the user AND the property").
// The pieces the ticket form and drawer show (the hooks are in
// ticketPropertyLink.js; backend/ticket_property_link.py is the server half):
//   * TicketPropertyIntake - Property + Unit on Create a Ticket, with "Looks
//     like ..." from the title and description;
//   * TicketPropertyDetail - Unit + View Property on the ticket drawer;
//   * SuggestPropertyLinks - the manager's backfill: proposals, one approval each.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { NX, btn, input as inputStyle } from '../tasks/theme';
import { Modal } from '../tasks/components';
import { label, field, requiredHint } from './ticketMeta';
import { TicketSelect } from './TicketAtoms';
import { PropertySelect } from './PropertySelect';
import { formatDate } from '../lib/datetime';
import { COMMON_AREA, NO_UNITS, usePropertySuggestion, usePropertyUnits, openProperty } from './ticketPropertyLink';

const hint = (text) => <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{text}</div>;
/** The Unit control: a Cubby store's units (searchable, plus Common Area),
 * else free text with the property's own units offered. */
function UnitInput({ value, onChange, units, invalid, style, listId }) {
  if (units.strict) {
    return (
      <TicketSelect value={value || ''} onChange={onChange} invalid={invalid} style={style}
        placeholder={units.loading ? 'Loading units…' : 'Select unit'} searchPlaceholder="Search units…"
        emptyText="No units at this property."
        options={[{ id: '', label: 'No Unit' }, { id: COMMON_AREA, label: COMMON_AREA }, ...units.units.map((u) => ({ id: u, label: u }))]} />
    );
  }
  return (<>
    <input aria-label="Unit" value={value || ''} onChange={(e) => onChange(e.target.value)} list={listId}
      placeholder="Unit, suite or Common Area" maxLength={60}
      style={{ ...inputStyle, ...(invalid ? { borderColor: NX.red } : null) }} />
    <datalist id={listId}>
      {[COMMON_AREA, ...units.units].map((u) => <option key={u} value={u} />)}
    </datalist>
  </>);
}

/**
 * Create a Ticket: Property (+ Unit once a property is picked).
 * `fixed` = raised from the property in Asset Management ({ id, name }).
 */
export function TicketPropertyIntake({ value, unit, onChange, onUnitChange, fixed = null, required = false,
  unitRequired = false, invalidProperty = false, invalidUnit = false, text = '', units = NO_UNITS, style }) {
  const suggestion = usePropertySuggestion(text, !value && !fixed);
  const req = <span style={{ color: NX.red }}>*</span>;
  return (<>
    <div style={field}>
      <label style={label}>Property {required && req}</label>
      {fixed ? (
        <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', background: NX.surface2, color: NX.ink }}>{fixed.name}</div>
      ) : (
        <PropertySelect value={value} onChange={onChange} invalid={invalidProperty} style={style} />
      )}
      {invalidProperty && <div style={requiredHint}>Required</div>}
      {suggestion && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, padding: '6px 10px', borderRadius: 8, background: NX.surface2, fontSize: 12.5, color: NX.ink }}>
          <span>Looks like <b>{suggestion.name}</b>{suggestion.unit ? <> - Unit <b>{suggestion.unit}</b></> : null}</span>
          <span style={{ color: NX.faint }}>({suggestion.reason})</span>
          <button type="button" style={{ ...btn('outline'), padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }}
            onClick={() => { onChange(suggestion.id); if (suggestion.unit) onUnitChange(suggestion.unit); }}>Use It</button>
        </div>
      )}
      {hint(fixed
        ? `Shows on ${fixed.name}'s Maintenance in Asset Management.`
        : required
          ? "Required for building and maintenance tickets - it shows on that property's Maintenance in Asset Management, and stays your ticket too."
          : 'Optional - pick it and the ticket shows on that property in Asset Management.')}
    </div>
    {(value || fixed) && (
      <div style={field}>
        <label style={label}>Unit {unitRequired && req}</label>
        <UnitInput value={unit} onChange={onUnitChange} units={units} invalid={invalidUnit} style={style} listId="ticket-intake-units" />
        {invalidUnit && <div style={requiredHint}>Required - pick the unit, or Common Area</div>}
        {hint(units.strict ? 'From the store\'s units in Cubby. Common Area for gates, lots, offices and halls.'
          : 'Optional - the unit, suite or room, or Common Area.')}
      </div>
    )}
  </>);
}


/** The ticket drawer: Unit (editable with the property) and View Property. */
export function TicketPropertyDetail({ v, canEdit = false, stage, style }) {
  const units = usePropertyUnits(v?.propertyAssetId || null);
  if (!v?.propertyAssetId) return null;
  const closed = ['resolved', 'closed'].includes(v.status);
  return (
    <div style={field}>
      <label style={label}>Unit</label>
      {canEdit && !closed ? (
        <UnitInput value={v.propertyUnit || ''} units={units} style={style} listId={`ticket-units-${v.id}`}
          onChange={(u) => { if (u !== (v.propertyUnit || '')) stage({ propertyUnit: u }); }} />
      ) : (
        <div style={{ fontSize: 13, color: NX.ink, minHeight: 34, display: 'flex', alignItems: 'center' }}>{v.propertyUnit || '-'}</div>
      )}
      <button type="button" onClick={() => openProperty(v.propertyAssetId)}
        style={{ border: 'none', background: 'none', padding: 0, marginTop: 6, cursor: 'pointer', color: NX.blue, fontSize: 12.5, fontWeight: 600 }}>
        View Property{v.propertyName ? ` - ${v.propertyName}` : ''} {'↗'}
      </button>
    </div>
  );
}

/** Suggest Property Links (managers): open tickets with no property whose
 * words point at one. Each proposal is approved - or dismissed - one at a
 * time; nothing is linked automatically. */
export function SuggestPropertyLinks({ onClose, onLinked }) {
  const [state, setState] = useState({ loading: true, error: '', items: [] });
  const [picked, setPicked] = useState({});        // ticketId -> propertyId (when not the top proposal)
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    api.getPropertyLinkSuggestions()
      .then((r) => { if (live) setState({ loading: false, error: '', items: r?.items || [] }); })
      .catch((e) => { if (live) setState({ loading: false, error: e?.message || 'Could not load suggestions.', items: [] }); });
    return () => { live = false; };
  }, []);
  const drop = (id) => setState((s) => ({ ...s, items: s.items.filter((i) => i.ticket.id !== id) }));
  const link = async (item) => {
    const pid = picked[item.ticket.id] || item.suggestions[0].id;
    const unit = pid === item.suggestions[0].id ? (item.suggestions[0].unit || '') : '';
    setBusy(item.ticket.id); setMsg('');
    try {
      await api.applyPropertyLinkSuggestion(item.ticket.id, { property_asset_id: pid, property_unit: unit });
      drop(item.ticket.id);
      onLinked?.(pid);
      window.dispatchEvent(new CustomEvent('nexus:tickets-changed', { detail: { propertyId: pid } }));
    } catch (e) { setMsg(e?.message || 'Could not link that ticket.'); }
    setBusy('');
  };
  const dismiss = async (item) => {
    setBusy(item.ticket.id); setMsg('');
    try { await api.dismissPropertyLinkSuggestion(item.ticket.id); drop(item.ticket.id); }
    catch (e) { setMsg(e?.message || 'Could not dismiss that suggestion.'); }
    setBusy('');
  };
  const rows = useMemo(() => state.items, [state.items]);
  return (
    <Modal title="Suggest Property Links" onClose={onClose} minHeight="60vh"
      footer={<button style={btn('outline')} onClick={onClose}>Close</button>}>
      <div style={{ fontSize: 13, color: NX.dim, marginBottom: 12 }}>
        Open tickets with no property whose title or description names one. Check each and click Link - nothing is linked until you do.
      </div>
      {msg && <div role="alert" style={{ ...requiredHint, marginBottom: 10 }}>{msg}</div>}
      {state.loading ? <div style={{ color: NX.faint, fontSize: 13 }}>Looking through open tickets…</div>
        : state.error ? <div role="alert" style={requiredHint}>{state.error}</div>
        : !rows.length ? <div style={{ color: NX.faint, fontSize: 13 }}>No suggestions - every open ticket that names a property is linked.</div>
        : rows.map((item) => {
          const top = item.suggestions[0];
          const pid = picked[item.ticket.id] || top.id;
          return (
            <div key={item.ticket.id} style={{ border: `1px solid ${NX.border2}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: NX.ink }}>{item.ticket.codeLabel} · {item.ticket.subject}</div>
                <div style={{ fontSize: 12, color: NX.faint }}>{[item.ticket.application, formatDate(item.ticket.createdAt)].filter(Boolean).join(' · ')}</div>
                <div style={{ fontSize: 12, color: NX.dim, marginTop: 2 }}>{pid === top.id ? `${top.reason}${top.unit ? ` - Unit ${top.unit}` : ''}` : ''}</div>
              </div>
              <div style={{ flex: '0 1 240px', minWidth: 180 }}>
                <TicketSelect value={pid} onChange={(v) => setPicked((p) => ({ ...p, [item.ticket.id]: v }))}
                  options={item.suggestions.map((s) => ({ id: s.id, label: s.name }))} />
              </div>
              <button style={btn('primary')} disabled={busy === item.ticket.id} onClick={() => link(item)}>Link</button>
              <button style={btn('outline')} disabled={busy === item.ticket.id} onClick={() => dismiss(item)}>Not a Property</button>
            </div>
          );
        })}
    </Modal>
  );
}

/** The toolbar button that opens it. */
export function SuggestPropertyLinksButton({ style }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)} style={style} title="Find open tickets that name a property but aren't linked to it">
      Suggest Property Links
    </button>
    {open && <SuggestPropertyLinks onClose={() => setOpen(false)} />}
  </>);
}
