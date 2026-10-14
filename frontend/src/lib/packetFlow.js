// HR packets built from Documents (Oct 14): the signing order the packet editor
// proposes as documents are added. The server re-checks everything.

// The same defaults the server uses when a signer key first appears
// (hr_packet_docs.default_role) - HR can change any of them.
export function defaultRoleFor(key, printsSignatory = false) {
  const k = String(key || '').toLowerCase();
  if (['employee', 'candidate', 'new_hire', 'person', 'recipient'].includes(k)) return 'employee';
  if (['signatory', 'authorized_signatory'].includes(k)) return 'signatory';
  if (['company', 'company_representative', 'employer'].includes(k)) return printsSignatory ? 'signatory' : 'hr';
  if (['manager', 'supervisor'].includes(k)) return 'manager';
  if (['hr', 'it', 'payroll', 'equipment', 'finance'].includes(k)) return k;
  return 'hr';
}
export const keyLabel = (k) => String(k || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** The signing order after documents change: every signer key a document's
 *  signature blocks name gets a step (default role), and The Person stays
 *  last on a hiring packet or separation package. */
export function flowFor(flow, docs, event) {
  const keys = [];
  docs.forEach(d => (d.signs || []).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
  const out = [...flow];
  keys.forEach(k => {
    if (out.some(s => s.key === k)) return;
    const prints = docs.some(d => d.printsSignatory && (d.signs || []).includes(k));
    out.push({ key: k, role: defaultRoleFor(k, prints), action: 'sign' });
  });
  if (event !== 'promotion') {
    const i = out.findIndex(s => s.role === 'employee');
    if (i >= 0 && i !== out.length - 1) { const [p] = out.splice(i, 1); out.push(p); }
  }
  return out;
}
