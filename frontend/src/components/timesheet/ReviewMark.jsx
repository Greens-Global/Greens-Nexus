// Where each person's Time Sheet is in review, beside their name in the team
// list (Neil, 11/04/2026), so a manager sees who is done: a filled check when
// it is signed, an outline check when approved and waiting for the
// signature, a return arrow when it went back to the employee, a dot when it
// is waiting for review, a lock while HR corrects it. Nothing while not
// reviewed. The words are the tooltip and the screen reader's.
import { CheckCircle2, CircleCheck, Undo2, Lock, CircleDot } from 'lucide-react';

export const REVIEW_MARK = {
  completed: { cls: 'is-signed', Icon: CheckCircle2, text: 'Signed', fill: true },
  approved: { cls: 'is-approved', Icon: CircleCheck, text: 'Approved - Waiting for Signature' },
  signing: { cls: 'is-approved', Icon: CircleCheck, text: 'Approved - Waiting for Signature' },
  with_employee: { cls: 'is-back', Icon: Undo2, text: 'Sent Back' },
  with_manager: { cls: 'is-waiting', Icon: CircleDot, text: 'Waiting for Review' },
  correcting: { cls: 'is-lock', Icon: Lock, text: 'HR Correcting' },
};

/** Nothing for the approver to do right now: approved, signed, being
 *  corrected by HR, or back with the employee (Approve and Next skips them). */
export const reviewDone = (status) => ['approved', 'signing', 'completed', 'correcting', 'with_employee'].includes(status || '');

export default function ReviewMark({ status }) {
  const m = REVIEW_MARK[status];
  if (!m) return <span className="ts-rmark" title="Not Reviewed Yet" aria-hidden="true" />;
  const { Icon } = m;
  return (
    <span className={`ts-rmark ${m.cls}`} title={m.text} role="img" aria-label={m.text}>
      <Icon size={14} strokeWidth={2.2} {...(m.fill ? { fill: 'currentColor', color: 'var(--card)', style: { color: 'hsl(var(--color-green))' } } : {})} />
    </span>
  );
}
