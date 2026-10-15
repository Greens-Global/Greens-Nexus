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
// more than a feed line needs: where it is now is the news.
const duePhrase = (detail) => {
  const d = detail || '';
  const to = d.match(/ to (\d{2}\/\d{2}\/\d{4})/)?.[1];
  if (/^removed the due date/.test(d)) return 'removed the due date';
  if (/^set the due date/.test(d) && to) return `set the due date to ${to}`;
  if (to) return `moved the due date to ${to}`;
  return d || 'changed the due date';
};

/** One update as phrases, [{ text, forYou }], in the order the server ranked
 *  them (what is asked of me first). */
export function updatePhrases(u, statusMeta) {
  const parts = Array.isArray(u.parts) ? u.parts : null;
  if (!parts || !parts.length) {
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
      case 'due': out.push({ text: duePhrase(p.detail) }); break;
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
