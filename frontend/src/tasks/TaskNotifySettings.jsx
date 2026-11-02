// Task Notification workflow - admin settings + delivery log (Jul 2026).
// Manager+ only (mirrors the backend's require_manager gate on these
// endpoints - this UI hides the controls, the backend is the real boundary).
// Same shape as tickets/TicketNotifySettings.jsx - kept as its own component
// (not a shared generic) since the field sets genuinely differ (due-date
// reminder cadence has no ticket equivalent; auto-close has no task one).
import { useEffect, useMemo, useState } from 'react';
import { LoadingState } from '../components/AsyncState';
import {
  Mail, RefreshCw, AlertTriangle, CheckCircle2, Clock, RotateCcw,
  MessageSquare, Paperclip, Ban, MinusCircle, Play,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useTasks } from './TasksContext';
import TaskDetailDrawer from './TaskDetailDrawer';
// Shared US date/time helpers - no ad-hoc toLocale* calls (CLAUDE.md).
import { formatDate, formatDateTime } from '../lib/datetime';
import { NX, FONT, btn, input as inputStyle, card } from './theme';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const field = { marginBottom: 14 };
const EVENT_LABELS = {
  created: 'Task created', assigned: 'Task assigned', due_soon: 'Due date reminder',
  overdue: 'Overdue reminder', completed: 'Task completed', commented: 'New comment',
  mentioned: 'Mentioned in a comment',
  follower_added: 'Added as collaborator', modified: 'Task details changed', deleted: 'Task deleted',
  recurring: 'Recurring task due',
  automation: 'Automation rule emails',
};
const STATUS_META = {
  sent: { color: NX.green, Icon: CheckCircle2 }, failed: { color: NX.red, Icon: AlertTriangle },
  pending: { color: NX.dim, Icon: Clock }, retrying: { color: NX.amber, Icon: RotateCcw },
};
// An inbound reply ends in one of four states - see TaskInboundEmail.status.
// "Ignored" and "Refused" are deliberately different words: ignored is a message
// that was never meant to be a comment (an out-of-office), refused is one that
// tried and was not allowed.
const INBOUND_META = {
  posted:   { color: NX.green, Icon: MessageSquare, label: 'Posted' },
  rejected: { color: NX.amber, Icon: Ban, label: 'Refused' },
  ignored:  { color: NX.dim, Icon: MinusCircle, label: 'Ignored' },
  failed:   { color: NX.red, Icon: AlertTriangle, label: 'Failed' },
};

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={onChange} title={on ? 'Enabled' : 'Disabled'} style={{
      position: 'relative', width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0,
    }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={field}>
      <label style={fieldLabel}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// The Settings save pattern (Oct 23 2026): the switches and the batching
// select save the moment they change, with a toast, and roll back when the
// save fails; the typed mail fields are a draft with one Save row under
// them, and Save sends only the keys that changed (the server merges -
// task_notify.save_settings).
const typedOf = (c) => ({
  fromMailbox: c.fromMailbox || '', cc: (c.defaultCc || []).join(', '), replyTo: c.replyTo || '', logoUrl: c.logoUrl || '',
  dueSoonDays: String(c.dueSoonDays ?? 0), overdueRepeatDays: String(c.overdueRepeatDays ?? 0), inboundMailbox: c.inboundMailbox || '',
});
const wholeDays = (v) => Math.max(0, Math.floor(Number(v) || 0));

// `toastOk` / `toastErr` (optional): the Settings shell's toasts; without
// them the panel says so on a line of its own.
export default function TaskNotifySettings({ toastOk, toastErr }) {
  const { myLevel } = useRole();
  const [tab, setTab] = useState('settings');
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { api.getTaskNotifySettings().then(setCfg).catch((e) => setErr(e.message || String(e))); }, []);

  const typedSaved = useMemo(() => (cfg ? typedOf(cfg) : null), [cfg]);
  const { draft, setDraft, patch: editDraft, dirty, reset } = useDraft(typedSaved);
  const say = (ok, text) => {
    const fn = ok ? toastOk : toastErr;
    if (fn) fn(text); else setNotice({ ok, text });
  };
  // A switch or a select: saved at once, rolled back on failure.
  const instant = async (patch, what) => {
    const prev = cfg;
    setCfg((c) => ({ ...c, ...patch, enabledEvents: { ...c.enabledEvents, ...(patch.enabledEvents || {}) } }));
    try {
      setCfg(await api.updateTaskNotifySettings(patch));
      say(true, `${what} saved.`);
    } catch (e) {
      setCfg(prev);
      say(false, e.message || `Could not save ${what.toLowerCase()}.`);
    }
  };

  const save = async () => {
    if (!dirty || saving) return false;
    const body = {};
    for (const k of ['fromMailbox', 'replyTo', 'logoUrl', 'inboundMailbox']) {
      if (draft[k] !== typedSaved[k]) body[k] = draft[k].trim();
    }
    if (draft.cc !== typedSaved.cc) body.defaultCc = draft.cc.split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of ['dueSoonDays', 'overdueRepeatDays']) {
      if (draft[k] !== typedSaved[k]) body[k] = wholeDays(draft[k]);
    }
    setSaving(true); setErr('');
    try {
      const next = await api.updateTaskNotifySettings(body);
      setCfg(next);
      setDraft(typedOf(next));
      say(true, 'Task notification settings saved.');
      return true;
    } catch (e) {
      setErr(e.message || String(e));
      return false;
    } finally { setSaving(false); }
  };
  useGroupDirty(dirty, save);

  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to view task notification settings.
      </div>
    );
  }
  if (!cfg || !draft) return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;

  const setEvent = (k, on) => instant({ enabledEvents: { [k]: on } }, EVENT_LABELS[k]);

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log'], ['replies', 'Replies']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}`,
          }}>{lab}</button>
        ))}
      </div>

      {tab === 'settings' ? (
        <>
          {notice && (
            <div role="status" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 12, color: notice.ok ? NX.green : NX.red }}>{notice.text}</div>
          )}
          {/* Two cards side by side on a wide screen: the switches (each saves
              when clicked) first, then the typed mail fields with the one Save
              row under them. Columns stretch to fill the available width
              (Pranshu, Sep 9). */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
            <div style={{ ...card, padding: 18 }}>
              <label style={fieldLabel}>Notification Types</label>
              {Object.entries(EVENT_LABELS).map(([k, lab]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
                  <span style={{ fontSize: 13.5 }}>{lab}</span>
                  <Toggle label={lab} on={!!cfg.enabledEvents?.[k]} onChange={() => setEvent(k, !cfg.enabledEvents?.[k])} />
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${NX.border2}`, marginTop: 10, paddingTop: 14 }}>
                {/* Batching (Neil, Sep 24): a person's task emails are held and
                    sent together once the oldest has waited this long, so five
                    assignments in a row arrive as one email. Backend:
                    task_notify.flush_batches. */}
                <Field label="Batch Task Emails" hint="Updates on someone's tasks are gathered and sent as one email once the first has waited this long. Mentions, deletions, urgent tasks and tasks due today or tomorrow always go out right away.">
                  <select aria-label="Batch Task Emails" value={cfg.batchWindowMinutes ?? 60} onChange={(e) => instant({ batchWindowMinutes: Number(e.target.value) }, 'Batching')}
                    style={{ ...inputStyle, width: 'auto', appearance: 'auto', cursor: 'pointer' }}>
                    <option value={0}>Off - send each email right away</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={120}>2 hours</option>
                  </select>
                </Field>
                {/* The two reminder numbers are the COMPANY DEFAULT: each
                    person can change their own in Email Settings (My Tasks).
                    This decides whether "Off" is one of their choices. */}
                <Field label="Let People Turn Off Overdue Reminders" hint="The reminder settings are everyone's default; each person can adjust their own in Tasks, Email Settings. When this is off, the least anyone can choose is once a week or only once.">
                  <Toggle label="Let People Turn Off Overdue Reminders" on={!!cfg.allowUserOverdueOff}
                    onChange={() => instant({ allowUserOverdueOff: !cfg.allowUserOverdueOff }, 'Overdue reminder choice')} />
                </Field>
                <InboundSwitch on={!!cfg.inboundEnabled} onChange={() => instant({ inboundEnabled: !cfg.inboundEnabled }, 'Email replies')} />
              </div>
            </div>

            <div style={{ ...card, padding: 18 }}>
              <Field label="Shared Mailbox (Sender)" hint="Leave blank to send from the default Nexus mailbox.">
                <input aria-label="Shared Mailbox (Sender)" value={draft.fromMailbox} onChange={(e) => editDraft({ fromMailbox: e.target.value })}
                  placeholder="tasks@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Default CC" hint="Comma-separated. Applied to every task notification.">
                <input aria-label="Default CC" value={draft.cc} onChange={(e) => editDraft({ cc: e.target.value })} placeholder="ops@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Reply-To Address">
                <input aria-label="Reply-To Address" value={draft.replyTo} onChange={(e) => editDraft({ replyTo: e.target.value })} placeholder="tasks@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Company Logo URL" hint="Shown in the email header. Blank uses the Greens Global wordmark.">
                <input aria-label="Company Logo URL" value={draft.logoUrl} onChange={(e) => editDraft({ logoUrl: e.target.value })} placeholder="https://…/logo.png" style={inputStyle} />
              </Field>
              <Field label="Due-Soon Reminder (Days Before Due Date)" hint="0 disables due-soon reminders entirely (overdue reminders are controlled separately below).">
                <input type="number" min={0} aria-label="Due-Soon Reminder (Days Before Due Date)" value={draft.dueSoonDays} onChange={(e) => editDraft({ dueSoonDays: e.target.value })}
                  style={{ ...inputStyle, width: 120 }} />
              </Field>
              <Field label="Overdue Re-Reminder Interval (Days)" hint="Once a task is overdue, remind again every N days until it's done or reassigned. 0 = remind only once, right when it first goes overdue.">
                <input type="number" min={0} aria-label="Overdue Re-Reminder Interval (Days)" value={draft.overdueRepeatDays} onChange={(e) => editDraft({ overdueRepeatDays: e.target.value })}
                  style={{ ...inputStyle, width: 120 }} />
              </Field>

              <InboundSection cfg={cfg} draft={draft} editDraft={editDraft} />

              {err && <div style={{ fontSize: 12.5, color: NX.red, margin: '14px 0 0' }}>{err}</div>}
              <SaveRow dirty={dirty} busy={saving} onSave={save} onDiscard={() => { reset(); setErr(''); }}
                note="Saves the mailbox, reminder and reply fields in this card. The switches save as you click them." />
            </div>
          </div>
        </>
      ) : tab === 'log' ? (
        <DeliveryLog />
      ) : (
        <RepliesLog replyTo={cfg.inboundMailbox || cfg.replyTo || ''} enabled={!!cfg.inboundEnabled} />
      )}
    </div>
  );
}

// Replying to a notification posts the reply as a comment on that task. Almost
// nothing here is configurable on purpose: every task email already carries the
// signed reply address, so there is no per-event or per-task opt-in to expose.
// The one real switch is whether we READ the mailbox, and that is a switch
// rather than something derived from "the mailbox happens to be readable"
// because draining it marks messages read and files them away - a visible
// takeover of a mailbox somebody may be watching. The switch saves when
// clicked (InboundSwitch); the mailbox to read is a typed field of the draft.
function InboundSwitch({ on, onChange }) {
  return (
    <div style={{ ...field, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Accept Replies by Email</div>
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
          When someone replies to a task notification, post their reply as a comment on that
          task, with any files they attached.
        </div>
      </div>
      <Toggle label="Accept Replies by Email" on={on} onChange={onChange} />
    </div>
  );
}

function InboundSection({ cfg, draft, editDraft }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [err, setErr] = useState('');
  const mailbox = cfg.inboundMailbox || cfg.replyTo || '';
  if (!cfg.inboundEnabled) return null;

  const runNow = async () => {
    setBusy(true); setErr(''); setResult('');
    try {
      const c = await api.drainTaskInbox();
      setResult(c.seen
        ? `Read ${c.seen} message${c.seen === 1 ? '' : 's'}: ${c.posted} posted, ${c.rejected} refused, ${c.ignored} ignored.`
        : 'Mailbox reached. Nothing new to read.');
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ ...field, borderTop: `1px solid ${NX.border2}`, paddingTop: 14 }}>
      <Field label="Mailbox to Read"
        hint={draft.inboundMailbox
          ? 'Overrides the reply-to address above.'
          : `Blank uses the reply-to address above${cfg.replyTo ? ` (${cfg.replyTo})` : ''}.`}>
        <input aria-label="Mailbox to Read" value={draft.inboundMailbox} onChange={(e) => editDraft({ inboundMailbox: e.target.value })}
          placeholder={cfg.replyTo || 'tasks@companydomain.com'} style={inputStyle} />
      </Field>

      {/* The reply-to people actually see is a signed sub-address, not this
          mailbox - worth showing, because it is the first thing that looks
          wrong to an admin reading a sent notification. */}
      {mailbox.includes('@') && (
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: -6, marginBottom: 14 }}>
          Notifications are sent with a per-task reply address like{' '}
          <code style={{ fontSize: 11, color: NX.dim }}>
            {mailbox.split('@')[0]}+a1b2…@{mailbox.split('@')[1]}
          </code>
          . The suffix is signed, so a reply reaches its own task and nothing else.
        </div>
      )}

      <div style={{
        background: NX.surface2, border: `1px solid ${NX.border2}`, borderRadius: 9,
        padding: '10px 12px', fontSize: 11.5, color: NX.dim, marginBottom: 12,
      }}>
        Needs the Mail.ReadWrite application permission on this mailbox. Replies from anyone
        outside the company, or from someone without commenter access to the project, are
        refused and listed under Replies.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...btn('outline'), opacity: busy ? 0.6 : 1 }} onClick={runNow} disabled={busy}>
          <Play size={13} /> {busy ? 'Checking…' : 'Check Mailbox Now'}
        </button>
        {result && <span style={{ fontSize: 12, color: NX.green }}>{result}</span>}
        {err && <span style={{ fontSize: 12, color: NX.red }}>{err}</span>}
      </div>
      <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
        Save first - this checks the mailbox using the settings already saved. The deployed
        API checks it every minute on its own.
      </div>
    </div>
  );
}

const LOG_LIMIT = 20;

function LogPager({ offset, setOffset, total, limit = LOG_LIMIT }) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  if (total <= limit) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 14 }}>
      <button
        disabled={offset === 0}
        onClick={() => setOffset(Math.max(0, offset - limit))}
        style={{ ...btn('ghost'), padding: '5px 14px', fontSize: 12, opacity: offset === 0 ? 0.4 : 1, cursor: offset === 0 ? 'default' : 'pointer' }}>
        ← Prev
      </button>
      <span style={{ fontSize: 12, color: NX.faint }}>Page {currentPage} of {totalPages}</span>
      <button
        disabled={offset + limit >= total}
        onClick={() => setOffset(offset + limit)}
        style={{ ...btn('ghost'), padding: '5px 14px', fontSize: 12, opacity: offset + limit >= total ? 0.4 : 1, cursor: offset + limit >= total ? 'default' : 'pointer' }}>
        Next →
      </button>
    </div>
  );
}

// What the mailbox handed us and what became of it. This is the answer to "I
// replied and nothing happened" - by the time anyone asks, the message itself
// has been marked read and filed, so these rows are the only evidence left.
function RepliesLog({ replyTo, enabled }) {
  const { taskById = {} } = useTasks() || {};
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  // The comment this row became lives on a task - opening it here beats making
  // the reader go hunt for a task they only know by the subject line.
  const [openId, setOpenId] = useState(null);

  const load = () => {
    setRows(null);
    api.getTaskInboundLog({ ...(status ? { status } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows, total }) => { setRows(rows); setTotal(total); })
      .catch((e) => { setErr(e.message || String(e)); setRows([]); setTotal(0); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status, offset]);

  return (
    <div>
      {!enabled && (
        <div style={{
          ...card, padding: 12, marginBottom: 12, fontSize: 12.5, color: NX.dim,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={14} style={{ color: NX.amber, flexShrink: 0 }} />
          Replies are not being read right now. Turn on "Accept replies by email" under Settings.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ ...inputStyle, appearance: 'auto', width: 'auto', cursor: 'pointer' }}>
          <option value="">All replies</option>
          <option value="posted">Posted as a comment</option>
          <option value="rejected">Refused</option>
          <option value="ignored">Ignored</option>
          <option value="failed">Failed</option>
        </select>
        <button style={btn('ghost')} onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      {rows === null ? (
        <LoadingState compact />
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>
          {status ? 'No replies in this state.'
            : `Nothing has been received yet${replyTo ? ` at ${replyTo}` : ''}.`}
        </div>
      ) : (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((r) => {
            const meta = INBOUND_META[r.status] || INBOUND_META.failed;
            // Only offer the jump when the task is actually loaded here - the
            // drawer renders nothing for a task the store doesn't have (one
            // since deleted, or outside this admin's visibility), and a click
            // that silently does nothing is worse than no click at all.
            const task = r.taskId ? taskById[r.taskId] : null;
            return (
              <div className={task ? 'nx-row-hover' : undefined} key={r.id} onClick={task ? () => setOpenId(r.taskId) : undefined}
                title={task ? `Open ${task.code || 'this task'}` : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                  borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5,
                  cursor: task ? 'pointer' : 'default',
                }}>
                <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, flexShrink: 0, width: 78, color: task ? NX.blue : NX.faint }}
                  title={task?.title}>
                  {task?.code || (r.taskId ? '-' : '')}
                </span>
                <span style={{ flexShrink: 0, width: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.from}>
                  {r.from || 'unknown sender'}
                </span>
                <span style={{ flex: 1, minWidth: 0, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.subject}>
                  {r.subject || '(no subject)'}
                </span>
                {r.attachmentCount > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: NX.faint, flexShrink: 0 }}
                    title={`${r.attachmentCount} file${r.attachmentCount === 1 ? '' : 's'}`}>
                    <Paperclip size={12} />{r.attachmentCount}
                  </span>
                )}
                <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: 62, textAlign: 'right' }}>{meta.label}</span>
                {/* The reason is the whole point of the row when it is not a
                    comment - and on a posted one it names a file that could not
                    be filed, so it is shown either way. */}
                <span style={{ color: NX.faint, flexShrink: 0, width: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.reason}>
                  {r.reason || ''}
                </span>
                <span style={{ color: NX.faint, flexShrink: 0 }} title={formatDateTime(r.receivedAt)}>
                  {formatDate(r.processedAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <LogPager offset={offset} setOffset={setOffset} total={total} />
      {/* Opens on Comments, because a comment is why this row exists. */}
      {openId && <TaskDetailDrawer taskId={openId} initialTab="comments" onClose={() => setOpenId(null)} />}
    </div>
  );
}


function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  const load = () => {
    setRows(null);
    api.getTaskNotifyLog({ ...(status ? { status } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows, total }) => { setRows(rows); setTotal(total); })
      .catch((e) => { setErr(e.message || String(e)); setRows([]); setTotal(0); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status, offset]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ ...inputStyle, appearance: 'auto', width: 'auto', cursor: 'pointer' }}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
          <option value="retrying">Retrying</option>
        </select>
        <button style={btn('ghost')} onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      {rows === null ? (
        <LoadingState compact />
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>No notification attempts yet.</div>
      ) : (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((r) => {
            const meta = STATUS_META[r.status] || STATUS_META.pending;
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5 }}>
                <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, flexShrink: 0, width: 78 }}>{r.taskCode}</span>
                <span style={{ color: NX.dim, flexShrink: 0, width: 100, textTransform: 'capitalize' }}>{r.eventType?.replace('_', ' ')}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.subject}>{r.recipient}</span>
                <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, textTransform: 'capitalize' }}>{r.status}</span>
                <span style={{ color: NX.faint, flexShrink: 0 }}>{r.attempts}x</span>
                {r.error && <span style={{ color: NX.red, flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>{r.error}</span>}
              </div>
            );
          })}
        </div>
      )}
      <LogPager offset={offset} setOffset={setOffset} total={total} />
    </div>
  );
}
