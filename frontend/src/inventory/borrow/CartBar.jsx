// Item Management - the ONE cart bar (Items redesign, Neil 11/02/2026).
// Sticky at the foot of Borrow (above the phone's bottom bar), only while the
// cart has something in it. The page reserves its height, so it never covers
// a tile or a button.
import { ShoppingCart, ChevronRight } from 'lucide-react';
import { useItemCart } from '../cart/useItemCart';

export function CartBar({ onReview }) {
  const { cart, count } = useItemCart();
  if (!count) return null;
  const names = cart.slice(0, 3).map(c => c.item.name).join(', ') + (count > 3 ? ` and ${count - 3} more` : '');
  return (
    <div className="it-cartbar" role="region" aria-label="Cart">
      <span className="it-cartbar-ico"><ShoppingCart size={16} /></span>
      <span className="it-cartbar-text">
        <strong>{count} item{count === 1 ? '' : 's'} in your cart</strong>
        <span>{names}</span>
      </span>
      <button type="button" className="primary-btn" onClick={onReview} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        Review and Request <ChevronRight size={15} />
      </button>
    </div>
  );
}
