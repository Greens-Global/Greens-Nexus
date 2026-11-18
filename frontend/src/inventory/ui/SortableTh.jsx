// Item Management - Sortable column header.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { ArrowUpDown } from 'lucide-react';
import { nextSort } from '../model/sort';

export function SortableTh({ label, colKey, sort, onSort }) {
  const active = sort.key === colKey;
  return (
    <th onClick={() => onSort(s => nextSort(s, colKey))}
      style={{ textAlign:'left', padding:'9px 14px', fontWeight:700, color: active ? 'var(--ink)' : 'var(--muted)', fontSize:11, textTransform:'uppercase', letterSpacing:'.07em', whiteSpace:'nowrap', cursor:'pointer', userSelect:'none' }}>
      <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
        {label}
        <ArrowUpDown size={11} style={{ opacity: active ? 1 : 0.35, transform: active && sort.dir === 'desc' ? 'rotate(180deg)' : 'none', transition:'transform .15s' }} />
      </span>
    </th>
  );
}
