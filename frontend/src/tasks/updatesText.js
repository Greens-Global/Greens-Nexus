// The words of the Tasks Home Updates card (HomeUpdates.jsx): an update's
// `parts` from GET /tasks/activity/mine as phrases, and its age. Apart from
// the card so the component file only exports the component (fast refresh)
// and the wording can be tested on its own.
import { fmtDate } from './lib';

// "5m ago" / "3h ago" / "2d ago"; a week or older reads as the date.
export const ago = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60e3) return 'Just now';
  const m = Math.floor(ms / 60e3); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return fmtDate(new Date(iso));   // the local date, not the UTC one
};

// A row from a server that predates `parts` (an API still deploying while the
// page is new): its own sentence, by type.
const VERBS = {
  commented: 'commented', created: 'created this task', completed: 'completed this task',
  task_completed: 'completed this task', status_changed: 'changed the status', assignee_changed: 'reassigned this task',
  attached: 'attached a file', attachment_removed: 'removed a file', checklist_done: 'checked off a checklist item',
  time_logged: 'logged time', comment_resolved: 'resolved a comment', comment_assigned: 'assigned a comment',
  restored: 'restored this task', deleted: 'moved this task to Trash', closed_missed: 'closed this task as missed',
};

const statusPhrase = (detail, statusMeta) => {
  const key = (detail || '').match(/^changed status to (\S+)$/)?.[1];
  if (!key) return detail || 'changed the status';
  return `changed the status to ${statusMeta?.[key]?.label || key.replace(/_/g, ' ')}`;
};

// "changed the due date from 10/20/2026 to 10/22/2026 - extension #2" says
// more than a feed line needs: where it is now is the news. A date pushed
// LATER is a slip, and a repeat slip says so (Neil, Oct 21 2026); a date
// pulled in is routine.
const usDate = /(\d{2})\/(\d{2})\/(\d{4})/;
const sortable = (us) => { const m = (us || '').match(usDate); return m ? `${m[3]}${m[1]}${m[2]}` : ''; };
const ORD = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
export function duePhrase(detail) {
  const d = detail || '';
  const from = d.match(/ from (\d{2}\/\d{2}\/\d{4})/)?.[1];
  const to = d.match(/ to (\d{2}\/\d{2}\/\d{4})/)?.[1];
  if (/^removed the due date/.test(d)) return { text: 'removed the due date' };
  if (/^set the due date/.test(d) && to) return { text: `set the due date to ${to}` };
  if (from && to && sortable(to) > sortable(from)) {
    const n = Number(d.match(/extension #(\d+)/)?.[1] || 0);
    return { text: `pushed the due date to ${to}${n >= 2 ? ` for the ${ORD(n)} time` : ''}`, slip: true };
  }
  if (from && to) return { text: `moved the due date up to ${to}` };
  if (to) return { text: `moved the due date to ${to}` };
  return { text: d || 'changed the due date' };
}

// The date a request or proposal asks for: the last date in its detail.
const askedDate = (detail) => (detail || '').match(/ to (\d{2}\/\d{2}\/\d{4})/)?.[1] || '';

/** One update as phrases, [{ text, forYou }], in the order the server ranked
 *  them (what is asked of me first). */
export function updatePhrases(u, statusMeta) {
  const parts = Array.isArray(u.parts) ? u.parts : null;
  if (!parts || !parts.length) {
    if (u.relation === 'mentioned') return [{ text: 'mentioned you', forYou: true }];
    const d = u.detail || '';
    if (/^changed status to /.test(d)) return [{ text: statusPhrase(d, statusMeta) }];
    return [{ text: d || VERBS[u.type] || 'updated this task' }];
  }
  const has = new Set(parts.map((p) => p.kind));
  const out = [];
  for (const p of parts) {
    const n = p.count || 1;
    switch (p.kind) {
      case 'assigned_you': out.push({ text: 'assigned you this task', forYou: true }); break;
      case 'mentioned_you': out.push({ text: 'mentioned you in a comment', forYou: true }); break;
      case 'comment_for_you': out.push({ text: 'asked you to act on a comment', forYou: true }); break;
      case 'completed': out.push({ text: 'completed this task' }); break;
      case 'restored': out.push({ text: 'restored this task' }); break;
      case 'status': out.push({ text: statusPhrase(p.detail, statusMeta) }); break;
      case 'due': out.push(duePhrase(p.detail)); break;
      case 'unblocked': {
        // My task's title heads the row; the blocker is named here.
        const left = Number(p.left || 0);
        const what = p.detail || 'a task blocking this one';
        out.push({ text: left > 0 ? `finished ${what} (${left} more blocker${left === 1 ? '' : 's'} to go)`
          : `finished ${what}, so this can start`, forYou: true });
        break;
      }
      case 'extension_ask': {
        const to = askedDate(p.detail);
        out.push({ text: to ? `asked you to approve an extension to ${to}` : 'asked you to approve an extension', forYou: true });
        break;
      }
      case 'date_ask': {
        const to = askedDate(p.detail);
        out.push({ text: to ? `proposed a new due date of ${to}` : 'proposed a new due date', forYou: true });
        break;
      }
      case 'date_request': {
        const to = askedDate(p.detail);
        out.push({ text: to ? `asked to move the due date to ${to}` : 'asked to move the due date' });
        break;
      }
      case 'assignees': out.push({ text: 'changed who it is assigned to' }); break;
      // A mention or a comment handed to me already says a comment was left.
      case 'commented':
        if (!has.has('mentioned_you') && !has.has('comment_for_you')) out.push({ text: n > 1 ? `left ${n} comments` : 'commented' });
        break;
      case 'resolved': out.push({ text: n > 1 ? `resolved ${n} comments` : 'resolved a comment' }); break;
      case 'attached': out.push({ text: n > 1 ? `attached ${n} files` : 'attached a file' }); break;
      case 'checklist': out.push({ text: n > 1 ? `checked off ${n} checklist items` : (p.detail || 'checked off a checklist item') }); break;
      default: break;
    }
  }
  return out.length ? out : [{ text: 'updated this task' }];
}

// An ask that has been dealt with (`ask` is how: "Replied", "Resolved"...).
export const isAnswered = (u) => !!u.ask && u.ask !== 'open';
// Still needs me: an open ask, or a task of mine that was just unblocked.
export const needsMe = (u) => !!u.forYou && !isAnswered(u);

/** "Visesh", "Visesh and Sagar", "Visesh and 2 others". */
export function actorsLabel(ids, nameOf) {
  const names = ids.map((id) => nameOf(id) || id || 'Someone');
  if (names.length <= 1) return names[0] || 'Someone';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** Several people's updates to one task on one day are one row (Neil, Oct 21
 *  2026: three people commenting made three rows). Asks and unblocks stay
 *  their own rows - each is answered on its own. `dayOf` is the section key;
 *  rows come newest first and stay in that order. */
export function foldByTask(rows, dayOf) {
  const out = [];
  const open = new Map();   // `${day}|${taskId}` -> the folded row
  for (const u of rows) {
    if (u.forYou || u.type === 'unblocked' || !u.taskId || !Array.isArray(u.parts)) { out.push(u); continue; }
    const key = `${dayOf(u.at)}|${u.taskId}`;
    const f = open.get(key);
    if (!f) {
      const row = { ...u, actors: [u.actorId], parts: u.parts.map((p) => ({ ...p })) };
      open.set(key, row);
      out.push(row);
      continue;
    }
    if (!f.actors.includes(u.actorId)) f.actors.push(u.actorId);
    for (const p of u.parts) {
      const have = f.parts.find((q) => q.kind === p.kind);
      if (have) have.count = (have.count || 1) + (p.count || 1);
      else f.parts.push({ ...p });
    }
    if (f.parts.some((p) => p.kind === 'completed')) f.parts = f.parts.filter((p) => p.kind !== 'status');
    if (!f.preview && u.preview) f.preview = u.preview;
  }
  return out;
}
