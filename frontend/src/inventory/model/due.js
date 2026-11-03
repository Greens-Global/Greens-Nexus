// Item Management - Checkout due dates and the overdue count.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { formatDate } from '../../lib/datetime';

// ── In-Use Summary - replaces the full workflow tracker once an item is with the
//    employee: all they need is how long they have left, plus Extend / Return. ──
export function checkoutDueInfo(checkout) {
  // The checkout period starts when the item physically changes hands -
  // approval delay must not eat into the employee's days.
  const start = checkout.allocatedAt || checkout.handedOverAt || checkout.createdAt;
  const due = new Date(start);
  due.setDate(due.getDate() + (checkout.days || 1));
  const msLeft   = due - Date.now();
  const daysLeft = Math.ceil(msLeft / 86400000);
  return { due, daysLeft };
}

// Neil: show the actual date, not just days - "you have it for 4 days,
// until 06-14-2026".
export function fmtDueDate(co) {
  const d = checkoutDueInfo(co).due;
  return formatDate(d);
}
