// The Job page's shape (Neil, 11/03/2026, plan phase 2 "The Job, Connected").
// One record, two sizes: a Work Order shows Overview, Tasks (its steps and
// punch list), Field and Closeout; a Project shows every tab. The tab is in
// the URL (/construction/project:<id>:<tab>, lib/navigation.js). Pure, so the
// page and the tests read one rule. Money (phase 4) shows on either size,
// only when the server says the caller may see it (`{ money: true }`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { TONE } from '../ui';

export const JOB_TYPE = {
  work_order: { label: 'Work Order', color: TONE.slate },
  project: { label: 'Project', color: TONE.blue },
};

const ALL = [
  { key: 'overview', label: 'Overview' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'punch', label: 'Punch List' },
  { key: 'field', label: 'Field' },
  { key: 'photos', label: 'Photos' },
  { key: 'rfis', label: 'RFIs And Submittals' },
  { key: 'changes', label: 'Changes' },
  { key: 'closeout', label: 'Closeout' },
];

// Field and Closeout (11/03/2026, phase 3): Photos (the timeline) and Changes
// (field tickets and change orders) on both sizes - a work order's extra work
// is signed on site too.
const WORK_ORDER = ['overview', 'punch', 'field', 'photos', 'changes', 'closeout'];
const MONEY = { key: 'money', label: 'Money' };

// Money sits before Closeout: managers with Accounting access only.
const withMoney = (tabs, money) => {
  if (!money) return tabs;
  const at = tabs.findIndex((t) => t.key === 'closeout');
  return at < 0 ? [...tabs, MONEY] : [...tabs.slice(0, at), MONEY, ...tabs.slice(at)];
};

export function jobTabs(jobType, { money = false } = {}) {
  if (jobType === 'work_order') {
    return withMoney(ALL.filter((t) => WORK_ORDER.includes(t.key))
      .map((t) => (t.key === 'punch' ? { ...t, label: 'Tasks' } : t)), money);
  }
  return withMoney(ALL, money);
}

// A tab the job does not have (a work order opened on Schedule) lands on Overview.
export function tabFor(jobType, tab, opts = {}) {
  return jobTabs(jobType, opts).some((t) => t.key === tab) ? tab : 'overview';
}

// A punch item's state: Open, Done (the crew's step), Verified (a reviewer's).
export const PUNCH_STATE = {
  open: { label: 'Open', color: TONE.slate },
  done: { label: 'Done', color: TONE.blue },
  verified: { label: 'Verified', color: TONE.green },
};

export function punchState(task, verifiedStatusId) {
  if (verifiedStatusId && task.status === verifiedStatusId) return 'verified';
  return task.completed ? 'done' : 'open';
}

// The schedule's read model, split for the tabs: punch items, the rest
// (a work order's steps), milestones and the look-ahead, in date order.
export function splitSchedule(view) {
  const tasks = view?.tasks || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const punchId = view?.punchSectionId || '';
  return {
    punch: tasks.filter((t) => punchId && t.sectionId === punchId),
    steps: tasks.filter((t) => !(punchId && t.sectionId === punchId) && !t.isMilestone),
    milestones: (view?.milestoneIds || []).map((id) => byId.get(id)).filter(Boolean),
    lookAhead: (view?.lookAheadIds || []).map((id) => byId.get(id)).filter(Boolean),
  };
}

// Every assignee on a list of tasks, for the per-person filter.
export function assigneesOf(tasks) {
  const out = new Map();
  for (const t of tasks || []) {
    for (const em of t.assigneeIds || []) {
      if (em && !out.has(em)) out.set(em, (t.assigneeNames || {})[em] || em);
    }
  }
  return [...out.entries()].map(([email, name]) => ({ email, name })).sort((a, b) => a.name.localeCompare(b.name));
}

// One loader with the house shape: { data, error, reload }. `key` names what
// is loaded (a job id): a new key loads again, and an answer for an old key or
// one that lands after the component left is dropped. Reload keeps the rows on
// screen while it reads (no flash of a skeleton over a list being read).
export function useLoad(fn, key) {
  const [state, setState] = useState({ data: null, error: '', key: null });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => fnRef.current())
      .then((data) => { if (live) setState({ data, error: '', key }); })
      .catch((e) => { if (live) setState({ data: null, error: e?.message || 'Could not load this.', key }); });
    return () => { live = false; };
  }, [key, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mine = state.key === key;
  return { data: mine ? state.data : null, error: mine ? state.error : '', reload };
}

// A phone-made id for a field write the offline outbox may resend.
export function clientId(prefix = 'cx') {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rnd}`;
}
