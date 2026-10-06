// What the signed-in person may do on the service desk (Oct 2026).
//
// The server decides - GET /task-tickets/my-access returns the caller's desk
// role (requester / agent / supervisor, see backend/ticket_roles.py) and its
// named capabilities. Screens read those instead of re-deriving them from
// module grants (`canAccessModule('tickets' | 'tasks')`), because which grants
// count depends on the company's Desk Access setting (legacy / explicit),
// which the browser does not know. The backend re-checks every action; this
// only decides what to show.
import { useEffect, useState } from 'react';
import { api } from '../api';

// Shown while loading and on any failure: nothing extra. A control that
// appears a beat late beats one that flashes for someone who may not use it.
export const NO_DESK_ACCESS = Object.freeze({
  role: 'requester', deskAccess: 'legacy', onDesk: false, canAct: false,
  canWorkQueue: false, canReadInternal: false, canAssign: false, canDelete: false, canManageDesk: false,
});

export function useTicketAccess() {
  const [access, setAccess] = useState(NO_DESK_ACCESS);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.getMyTicketAccess())
      .then((r) => { if (alive && r) setAccess({ ...NO_DESK_ACCESS, ...r }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return access;
}
