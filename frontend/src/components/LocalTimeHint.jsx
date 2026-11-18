// One quiet line when it is not a good hour for someone (11/13/2026):
// "It is 9:40 PM for Priya" under an assignee field, before work is handed
// to a colleague on the other side of the world. The rule is lib/localTime.js
// (their working hours, else 9:00 PM to 7:00 AM on their clock); inside
// their hours, for yourself, and for anyone whose zone nothing says, it
// renders nothing at all.
//
//   emails   who to look up in the Nexus People list (/myhr/directory, the
//            list every picker already loads - one cached read)
//   rows     people already in hand ({ email, name | firstName, timeZone,
//            workStart, workEnd } - a Contact Directory row); skips the lookup
//   me       the viewer's email - never a line about yourself
//   brief    no clock in the line, for a place that shows it beside it
//
// Muted label text, no icon. Never orange (orange means "live") and never a
// warning color: it is a courtesy, not a problem.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { FS } from '../lib/typeScale';
import { afterHoursLine } from '../lib/localTime';

const EMPTY = [];

/** email -> directory row, from the people pickers' own list. */
function useDirectoryRows(wanted) {
  const [byEmail, setByEmail] = useState(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    Promise.resolve().then(() => api.getPeopleDirectory())
      .then((rows) => {
        if (!live) return;
        const map = new Map();
        for (const r of Array.isArray(rows) ? rows : []) if (r?.email) map.set(String(r.email).toLowerCase(), r);
        setByEmail(map);
      })
      .catch(() => { /* no list, no line */ });
    return () => { live = false; };
  }, [wanted]);
  return byEmail;
}

export default function LocalTimeHint({ emails, rows, me = '', brief = false, now, style }) {
  const list = useMemo(() => (Array.isArray(emails) ? emails : emails ? [emails] : EMPTY), [emails]);
  const byEmail = useDirectoryRows(!rows && list.length > 0);
  // The line is about the clock: look again every half minute.
  const [, tick] = useState(0);
  useEffect(() => {
    if (now) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [now]);
  const people = rows || (byEmail ? list.map((e) => byEmail.get(String(e || '').toLowerCase())).filter(Boolean) : EMPTY);
  const line = afterHoursLine(people, { me, now: now || new Date(), brief });
  if (!line) return null;
  return (
    <div data-local-time-hint="" style={{ fontSize: FS.label, color: 'var(--muted)', lineHeight: 1.4, marginTop: 4, ...style }}>
      {line}
    </div>
  );
}
