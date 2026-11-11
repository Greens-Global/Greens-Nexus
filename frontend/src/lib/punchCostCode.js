// The cost code that goes with a punch-in (Construction Round Three item 3,
// Neil, 11/11/2026). The Time Clock page's picker (construction/
// PunchCostCode.jsx) sets the current pick while it is on screen and clears
// it when it leaves; punchDurable sends it with an IN punch (and parks it
// with a punch that could not be sent). The server keeps it only when the
// punch is stamped to that job and the code is on the job's list
// (construction_labor.check_cost_code), so a stale pick is dropped, never a
// refused punch. The "last code" is remembered per person and per job in
// this browser - keyed by the person's email, so a shared PC never hands one
// person's code to the next.
const KEY = 'nexus:punchCostCodes';
let current = null;   // { jobId, code } | null

export function setPunchCostCode(pick) {
  current = pick && pick.jobId && pick.code ? { jobId: pick.jobId, code: pick.code } : null;
}

/** The body fields for an IN punch: {} when nothing is picked. */
export function punchCostCodeFields(kind) {
  return kind === 'in' && current ? { cost_code: current.code, cost_code_job: current.jobId } : {};
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function rememberedCode(email, jobId) {
  const who = String(email || '').toLowerCase();
  return (who && jobId && readAll()[who]?.[jobId]) || '';
}

export function rememberCode(email, jobId, code) {
  const who = String(email || '').toLowerCase();
  if (!who || !jobId) return;
  const all = readAll();
  all[who] = { ...(all[who] || {}), [jobId]: code || '' };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked - the pick still goes with this punch */ }
}
