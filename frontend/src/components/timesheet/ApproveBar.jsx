// Review & Approve within reach (Neil, 11/04/2026): the button lives in the
// review panel at the foot of the Time Sheet, under the pay cards. While that
// panel is off screen this bar holds at the bottom of the card with the same
// decision: why it cannot be approved yet (the server's own words), Send
// Back (takes you to the panel's note), Review & Approve, and Approve and
// Next, which opens the next person still waiting for review.
import { useEffect, useState } from 'react';
import { CheckCircle, Undo2, ChevronRight } from 'lucide-react';
import { approveCallFor } from '../TimesheetReviewPanel';

export default function ApproveBar({ review, anchor, empName, next, panelRef, onChanged, toastOk, toastErr }) {
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const el = panelRef?.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setHidden(false); return undefined; }
    const io = new IntersectionObserver(([e]) => setHidden(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [panelRef, review?.status]);
  const r = review;
  const can = r && (r.canApprove || r.canAgree);
  if (!can || hidden) return null;
  const blocked = r.agreeBlocker || '';
  const approve = async (thenNext) => {
    setBusy(true);
    try {
      await approveCallFor(r, anchor, '');
      toastOk?.(`Approved - ${empName || 'the employee'} is asked to sign.`);
      window.dispatchEvent(new CustomEvent('nexus:timesheet-review-changed'));
      if (thenNext && next) next.go(); else onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not approve.'); }
    finally { setBusy(false); }
  };
  const toPanel = () => {
    const el = panelRef?.current;
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el?.querySelector('textarea')?.focus(), 350);
  };
  return (
    <div className="ts-approve-bar" role="region" aria-label="Review and approve">
      <span className={`ts-ab-text${blocked ? ' is-blocked' : ''}`}>
        {blocked || `Hours look right? Approve them and ${empName || 'the employee'} is asked to sign.`}
      </span>
      {r.canSendBack && (
        <button type="button" className="secondary-btn" onClick={toPanel} disabled={busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}><Undo2 size={13} /> Send Back</button>
      )}
      <button type="button" className="secondary-btn" disabled={busy || !!blocked} onClick={() => approve(false)}
        title={blocked || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
        <CheckCircle size={13} /> Review &amp; Approve
      </button>
      {next && (
        <button type="button" className="primary-btn" disabled={busy || !!blocked} onClick={() => approve(true)}
          title={blocked || `Approve, then open ${next.name}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          Approve and Next <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
