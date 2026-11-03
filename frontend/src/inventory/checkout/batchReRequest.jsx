// Item Management - Re-request several past checkouts as one new order.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).

// Shared by both views' My Checkouts panels: re-submit a set of past checkouts
// as ONE fresh order (same days as before, new reason/approver). Mirrors
// handleSubmitCart's success/failure reporting.
export async function runBatchReRequest(cos, { reason, approverEmail, approverName, days }, { submitCartCheckouts, userName, userEmail, toast }) {
  const pseudoCart = cos.map(c => ({
    id: c.id, days: (days && days[c.id]) || c.days || 1,
    item: { id: c.itemId, name: c.itemName, itemType: c.itemType, department: c.department },
  }));
  const results = await submitCartCheckouts(pseudoCart, { reason, raisedBy: userName, raisedByEmail: userEmail, approverEmail, approverName });
  const okCount = results.filter(r => r.status === 'fulfilled').length;
  const failed  = cos.filter((_, i) => results[i].status === 'rejected');
  if (okCount > 0) {
    toast(`${okCount} item${okCount !== 1 ? 's' : ''} requested again.`);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'active-checkouts' } }));
  }
  if (failed.length > 0) {
    const allConflict = results.filter(r => r.status === 'rejected').every(r => r.reason?.message?.includes('active checkout'));
    toast(
      <div>
        <div style={{ fontWeight:700, marginBottom:5 }}>
          {failed.length} item{failed.length !== 1 ? 's' : ''} couldn't be requested
        </div>
        <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
          {failed.map((c, i) => <li key={i} style={{ fontSize:12 }}>{c.itemName}</li>)}
        </ul>
        {allConflict && <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:5 }}>Each already has an active checkout request.</div>}
      </div>,
      'error'
    );
  }
  if (okCount === 0) throw new Error('Nothing was submitted - each item already has an active request.');
}
