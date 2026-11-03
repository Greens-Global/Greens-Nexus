// Item Management - Type, status and operational-status badges.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { TYPE_META, STATUS_META, OP_STATUS_META } from '../model/status';

export function TypeBadge({ type }) {
  const m = TYPE_META[type] || TYPE_META.Other;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'11px', fontWeight:600, background:m.bg, color:m.color, whiteSpace:'nowrap' }}>
      <m.Icon size={10} /> {type}
    </span>
  );
}

export function StatusBadge({ status, item }) {
  const m = STATUS_META[status] || { label: status, bg:'var(--mist)', fg:'var(--muted)' };
  // location_assigned shows the actual site ("Assigned · GSE") when we have the row
  const label = status === 'location_assigned' && item?.location ? `Assigned · ${item.location}` : m.label;
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'11px', fontWeight:600, background:m.bg, color:m.fg, whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}

// Operational status pill (Neil's status column). '' renders as a muted dash.
export function OpStatusBadge({ value }) {
  if (!value) return <span style={{ fontSize:11, color:'var(--muted)' }}>-</span>;
  const m = OP_STATUS_META[value] || { label: value, bg:'var(--mist)', fg:'var(--muted)' };
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:20, fontSize:'11px', fontWeight:600, background:m.bg, color:m.fg, whiteSpace:'nowrap' }}>
      {m.label}
    </span>
  );
}
