// The people a company's default assignee may be (Oct 2026): its active
// ticket desk agents, as the server judges them (GET /task-tickets/desk-agents
// -> ticket_auto_assign.desk_agent_for). The Default Assignee pickers list
// only these, so nobody can be picked that a save would refuse.
import { useEffect, useState } from 'react';
import { api } from '../api';

/** { [companyId]: [{ email, name }] } for the given companies, filled in as
 *  each answers. A company whose call fails offers nobody. */
export function useDeskAgents(companyIds) {
  const key = [...new Set((companyIds || []).filter(Boolean))].sort().join('|');
  const [byCompany, setByCompany] = useState({});
  useEffect(() => {
    let alive = true;
    for (const id of key ? key.split('|') : []) {
      Promise.resolve()
        .then(() => api.getTicketDeskAgents(id))
        .then((rows) => { if (alive) setByCompany((m) => ({ ...m, [id]: Array.isArray(rows) ? rows : [] })); })
        .catch(() => { if (alive) setByCompany((m) => ({ ...m, [id]: [] })); });
    }
    return () => { alive = false; };
  }, [key]);
  return byCompany;
}

/** A picker's options: the company's agents, plus whoever is set now when
 *  they are no longer one (shown as such, so the stale choice is visible and
 *  can be cleared rather than looking empty). */
export function agentOptions(agents, current, people = []) {
  const list = (agents || []).map((a) => ({ email: a.email, name: a.name || a.email }));
  const cur = (current || '').toLowerCase();
  if (cur && !list.some((p) => p.email === cur)) {
    const known = (people || []).find((p) => p.email === cur);
    list.push({ email: cur, name: `${known?.name || cur} (not on the desk)` });
  }
  return list;
}
