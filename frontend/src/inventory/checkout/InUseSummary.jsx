// Item Management - Days left on an item that is with the employee.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { Clock } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { formatDateLong } from '../../lib/datetime';
import { checkoutDueInfo } from '../model/due';

export function InUseSummary({ checkout }) {
  const { due, daysLeft } = checkoutDueInfo(checkout);
  const totalDays = checkout.days || 1;
  const elapsed   = Math.min(1, Math.max(0, (totalDays - daysLeft) / totalDays));
  const overdue   = daysLeft < 0;
  const dueToday  = daysLeft === 0;
  const color     = overdue ? 'var(--color-red)' : dueToday || daysLeft <= 1 ? 'var(--color-orange)' : 'var(--color-green)';
  const fmtDue    = formatDateLong(due);

  return (
    <div style={{ margin:'10px 0 4px', background:`hsla(${color},0.06)`, border:`1px solid hsla(${color},0.25)`, borderRadius:10, padding:'10px 14px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Clock size={15} color={`hsl(${color})`} />
          <span style={{ fontSize:14, fontWeight:800, color:`hsl(${color})` }}>
            {overdue ? `Overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''}`
              : dueToday ? 'Due back today'
              : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`}
          </span>
        </div>
        <span style={{ fontSize:11.5, color:'var(--muted)' }}>Due {fmtDue} · {totalDays}-day checkout</span>
      </div>
      <div style={{ height:5, borderRadius:3, background:'var(--line)', marginTop:8, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${Math.round((overdue ? 1 : elapsed) * 100)}%`, background:`hsl(${color})`, borderRadius:3, transition:'width 0.3s' }} />
      </div>
      {checkout.extensionStatus === 'pending' && (
        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:8, fontSize:12, fontWeight:600, color:'hsl(var(--color-blue))' }}>
          <Spinner size={12} />
          Extension requested: +{checkout.extensionDays} day{checkout.extensionDays !== 1 ? 's' : ''} - awaiting manager approval
        </div>
      )}
    </div>
  );
}
