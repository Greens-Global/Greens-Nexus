// Item Management - The Edit / Photos tabs of the batch modals.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { Pencil, Image } from 'lucide-react';

// Shared Fields/Photos toggle that sits at the top of the unified Batch modal
// (Neil: one batch feature, two tabs). The active tab is just a render; clicking
// the other swaps which face shows via onTab - both operate on the same scope.
export function BatchTabs({ tab, onTab }) {
  const Tab = ({ k, label, Icon }) => (
    <button onClick={() => k !== tab && onTab(k)}
      style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 14px', borderRadius:8,
        border:'1px solid', borderColor: tab === k ? 'var(--pine)' : 'var(--line)', cursor:'pointer',
        fontFamily:'Inter,sans-serif', fontSize:13, fontWeight:700,
        background: tab === k ? 'var(--pine)' : 'transparent', color: tab === k ? '#fff' : 'var(--muted)' }}>
      <Icon size={13} /> {label}
    </button>
  );
  return (
    <div style={{ display:'flex', gap:8 }}>
      <Tab k="fields" label="Fields" Icon={Pencil} />
      <Tab k="photos" label="Photos" Icon={Image} />
    </div>
  );
}
