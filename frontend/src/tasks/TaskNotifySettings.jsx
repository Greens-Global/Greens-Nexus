// Task Notification workflow - admin settings + delivery log (Jul 2026).
// Manager+ only (mirrors the backend's require_manager gate on these
// endpoints - this UI hides the controls, the backend is the real boundary).
// Same shape as tickets/TicketNotifySettings.jsx - kept as its own component
// (not a shared generic) since the field sets genuinely differ (due-date
// reminder cadence has no ticket equivalent; auto-close has no task one).
import { useEffect, useState } from 'react';
import {
  Mail, RefreshCw, Save, AlertTriangle, CheckCircle2, Clock, RotateCcw,
  MessageSquare, Paperclip, Ban, MinusCircle, Play,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useTasks } from './TasksContext';
import TaskDetailDrawer from './TaskDetailDrawer';
import { NX, FONT, btn, input as inputStyle, card } from './theme';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const field = { marginBottom: 14 };
const EVENT_LABELS = {
  created: 'Task created', assigned: 'Task assigned', due_soon: 'Due date reminder',
  overdue: 'Overdue reminder', completed: 'Task completed', commented: 'New comment',
  mentioned: 'Mentioned in a comment',
  follower_added: 'Added as collaborator', modified: 'Task details changed', deleted: 'Task deleted',
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

function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={onChange} title={on ? 'Enabled' : 'Disabled'} style={{
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

export default function TaskNotifySettings() {
  const { myLevel } = useRole();
  const [tab, setTab] = useState('settings');
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [ccInput, setCcInput] = useState('');

  const load = () => api.getTaskNotifySettings().then((c) => { setCfg(c); setCcInput((c.defaultCc || []).join(', ')); }).catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to view task notification settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setEvent = (k, v) => setCfg((c) => ({ ...c, enabledEvents: { ...c.enabledEvents, [k]: v } }));

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      const patch = { ...cfg, defaultCc: ccInput.split(',').map((s) => s.trim()).filter(Boolean) };
      const next = await api.updateTaskNotifySettings(patch);
      setCfg(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Mail size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Task Email Notifications</div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log'], ['replies', 'Replies']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}`,
          }}>{lab}</button>
        ))}
      </div>

      {tab === 'settings' ? (
        <div style={{ ...card, padding: 18 }}>
          <Field label="Shared mailbox (sender)" hint="Blank falls back to the NEXUS_FROM_EMAIL env var.">
            <input value={cfg.fromMailbox || ''} onChange={(e) => set('fromMailbox', e.target.value)}
              placeholder="tasks@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Default CC" hint="Comma-separated. Applied to every task notification.">
            <input value={ccInput} onChange={(e) => setCcInput(e.target.value)} placeholder="ops@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Reply-to address">
            <input value={cfg.replyTo || ''} onChange={(e) => set('replyTo', e.target.value)} placeholder="tasks@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Company logo URL" hint="Shown in the email header. Blank uses the default Nexus branding.">
            <input value={cfg.logoUrl || ''} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" style={inputStyle} />
          </Field>
          <Field label="Due-soon reminder (days before due date)" hint="0 disables due-soon reminders entirely (overdue reminders are controlled separately below).">
            <input type="number" min={0} value={cfg.dueSoonDays ?? 0} onChange={(e) => set('dueSoonDays', Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 120 }} />
          </Field>
          <Field label="Overdue re-reminder interval (days)" hint="Once a task is overdue, remind again every N days until it's done or reassigned. 0 = remind only once, right when it first goes overdue.">
            <input type="number" min={0} value={cfg.overdueRepeatDays ?? 0} onChange={(e) => set('overdueRepeatDays', Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 120 }} />
          </Field>

          <InboundSection cfg={cfg} set={set} />

          <div style={{ ...field, borderTop: `1px solid ${NX.border2}`, paddingTop: 14 }}>
            <label style={fieldLabel}>Notification types</label>
            {Object.entries(EVENT_LABELS).map(([k, lab]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
                <span style={{ fontSize: 13.5 }}>{lab}</span>
                <Toggle on={!!cfg.enabledEvents?.[k]} onChange={() => setEvent(k, !cfg.enabledEvents?.[k])} />
              </div>
            ))}
          </div>

          {err && <div style={{ fontSize: 12.5, color: NX.red, marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button style={{ ...btn('primary'), opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
            </button>
            {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
          </div>
        </div>
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
// takeover of a mailbox somebody may be watching.
function InboundSection({ cfg, set }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [err, setErr] = useState('');
  const mailbox = cfg.inboundMailbox || cfg.replyTo || '';

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Accept replies by email</div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
            When someone replies to a task notification, post their reply as a comment on that
            task, with any files they attached.
          </div>
        </div>
        <Toggle on={!!cfg.inboundEnabled} onChange={() => set('inboundEnabled', !cfg.inboundEnabled)} />
      </div>

      {cfg.inboundEnabled && (
        <div style={{ marginTop: 12 }}>
          <Field label="Mailbox to read"
            hint={cfg.inboundMailbox
              ? 'Overrides the reply-to address above.'
              : `Blank uses the reply-to address above${cfg.replyTo ? ` (${cfg.replyTo})` : ''}.`}>
            <input value={cfg.inboundMailbox || ''} onChange={(e) => set('inboundMailbox', e.target.value)}
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
      )}
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
  // The comment this row became lives on a task - opening it here beats making
  // the reader go hunt for a task they only know by the subject line.
  const [openId, setOpenId] = useState(null);

  const load = () => {
    setRows(null);
    api.getTaskInboundLog(status ? { status } : {}).then(setRows).catch((e) => { setErr(e.message || String(e)); setRows([]); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);

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
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...inputStyle, appearance: 'auto', width: 'auto', cursor: 'pointer' }}>
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
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>Loading…</div>
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
              <div key={r.id} onClick={task ? () => setOpenId(r.taskId) : undefined}
                title={task ? `Open ${task.code || 'this task'}` : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                  borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5,
                  cursor: task ? 'pointer' : 'default',
                }}
                onMouseEnter={(e) => { if (task) e.currentTarget.style.background = NX.hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 700, flexShrink: 0, width: 78, color: task ? NX.blue : NX.faint }}
                  title={task?.title}>
                  {task?.code || (r.taskId ? '—' : '')}
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
                <span style={{ color: NX.faint, flexShrink: 0 }}>{fmtWhen(r.processedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
      {/* Opens on Comments, because a comment is why this row exists. */}
      {openId && <TaskDetailDrawer taskId={openId} initialTab="comments" onClose={() => setOpenId(null)} />}
    </div>
  );
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');

  const load = () => {
    setRows(null);
    api.getTaskNotifyLog(status ? { status } : {}).then(setRows).catch((e) => { setErr(e.message || String(e)); setRows([]); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...inputStyle, appearance: 'auto', width: 'auto', cursor: 'pointer' }}>
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
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>Loading…</div>
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
    </div>
  );
}
