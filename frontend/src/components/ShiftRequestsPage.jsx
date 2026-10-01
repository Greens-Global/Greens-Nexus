// Shifts > Requests (Oct 2026): the manager's inbox and nothing else.
// Employees ask for a swap, an offer, an open shift or time off in Workday >
// Time Off (Charmi, 09/30: "the request management should be here, I don't
// think the new request should be here"). The data comes from the module
// (views/Shifts.jsx, useManagerInbox) so the tab badge and this page agree
// and nothing is fetched twice.
import ShiftRequestsInbox from './ShiftRequestsInbox';

export default function ShiftRequestsPage({ inbox, timeoff, loading, error, onRetry, onChanged, toastOk, toastErr }) {
  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
        Requests from your team. A swap or an offer reaches you once the teammate has accepted; time off comes straight to you.
      </div>
      <ShiftRequestsInbox inbox={inbox} timeoff={timeoff} loading={loading} error={error} onRetry={onRetry} onChanged={onChanged} toastOk={toastOk} toastErr={toastErr} />
    </div>
  );
}
