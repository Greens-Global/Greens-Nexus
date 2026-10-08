import { ChevronDown, Plus } from 'lucide-react';
import { PopoverPanel, usePopover } from './reportControls';

// "+ Add" with a menu (Charmi, 10/07: "rename to + Add like everywhere
// else"): the Loans tab's green button and menu, as one component for MRI and
// MRE. `items`: [{ key, label, hint?, Icon?, onPick }]. It sits last on the
// toolbar: filters ... Customize, Export, (Sync Now), + Add.
export default function AddMenu({ items, ariaLabel = 'Add', align = 'right' }) {
  const [open, setOpen, ref] = usePopover();
  const item = { display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, background: 'none', padding: '7px 8px', font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="primary-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
        <Plus size={14} /> Add <ChevronDown size={13} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align={align} role="menu" aria-label={ariaLabel}
        style={{ width: 300, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 6 }}>
        {items.map(({ key, label, hint, Icon, onPick }) => (
          <button key={key} type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onPick(); }}>
            {Icon ? <Icon size={14} style={{ color: 'var(--text-muted)', marginTop: 2, flexShrink: 0 }} /> : null}
            <span>
              <span style={{ display: 'block', fontWeight: 600 }}>{label}</span>
              {hint && <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</span>}
            </span>
          </button>
        ))}
      </PopoverPanel>
    </div>
  );
}
