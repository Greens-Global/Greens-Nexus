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
// "PAN Number" -> pan_number: the {{variable}} a Details Form field fills
// (the server's hr_packet_docs.form_key).
export const formKey = (label) => {
  const k = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60).replace(/_+$/, '');
  return !k || /^[a-z]/.test(k) ? k : `f_${k}`;
};
/** "Ready To Send" / "2 To Fix" / "1 Warning" - the packet list's chip. */
export function readinessSummary(checks) {
  const list = checks || [];
  const blocks = list.filter(c => !c.ok && c.severity === 'block').length;
  const warns = list.filter(c => !c.ok && c.severity === 'warn').length;
  if (!list.length) return null;
  if (blocks) return { tone: 'red', label: `${blocks} To Fix` };
  if (warns) return { tone: 'orange', label: `${warns} Warning${warns === 1 ? '' : 's'}` };
  return { tone: 'green', label: 'Ready To Send' };
}
export const keyLabel = (k) => String(k || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** The signing order after documents change: every signer key a document's
 *  signature blocks name gets a step (default role), and The Person signs
 *  FIRST - the company never signs before them (Neil, Oct 22 2026). Nobody
 *  signs an offer letter but The Person, so an offer gets no company signer.
 *  The server applies the same order to every packet (hr_packet_docs.signing_flow). */
export function flowFor(flow, docs, event) {
  const keys = [];
  docs.forEach(d => (d.signs || []).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
  let out = [...flow];
  keys.forEach(k => {
    if (out.some(s => s.key === k)) return;
    const prints = docs.some(d => d.printsSignatory && (d.signs || []).includes(k));
    out.push({ key: k, role: defaultRoleFor(k, prints), action: 'sign' });
  });
  if (event === 'offer') out = out.filter(s => s.role === 'employee' || s.action !== 'sign');
  const i = out.findIndex(s => s.role === 'employee');
  if (i > 0) { const [p] = out.splice(i, 1); out.unshift(p); }
  return out;
}
