// Ticket Notification workflow - admin settings + delivery log (Jul 2026).
// Manager+ only (mirrors the backend's require_manager gate on these
// endpoints - this UI hides the controls, the backend is the real boundary).
//
// One save pattern (Settings, Oct 23 2026): the switches and the default
// department pickers save the moment they change (and go back with the
// reason when refused); the typed fields - mailboxes, addresses, logo,
// auto-close days - are a draft with one Save row at the foot, which sends
// only the fields that changed.
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import { LoadingState } from '../components/AsyncState';
import { TicketSelect } from './TicketAtoms';
import SavedCheck from '../components/SavedCheck';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';
import { dialog } from '../ui/dialog';
import TicketInboundLog, { TicketInboundSettings } from './TicketInboundEmail';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const field = { marginBottom: 14 };
const EVENT_LABELS = {
  created: 'Ticket created', assigned: 'Ticket assigned', updated: 'Replies to the requester',
  resolved: 'Ticket resolved', reopened: 'Ticket reopened', approval_required: 'Approval required',
  overdue_reminder: 'Due and overdue reminders (Teams from the manager, and the bell)',
  sla_breach: 'SLA breach alerts (the bell, to the assignee and the department lead)',
  weekly_report: 'Weekly ticket report (Monday morning email to desk supervisors; each can opt out on Reports)',
};
const STATUS_META = {
  sent: { color: NX.green, Icon: CheckCircle2 }, failed: { color: NX.red, Icon: AlertTriangle },
  pending: { color: NX.dim, Icon: Clock }, retrying: { color: NX.amber, Icon: RotateCcw },
};

// The typed fields - the draft half of the panel - as the server holds them.
const TYPED = ['fromMailbox', 'ticketAdminEmail', 'defaultCc', 'replyTo', 'logoUrl', 'autoCloseDays', 'inboundMailbox'];
function typedOf(c) {
  if (!c) return null;
  return {
    fromMailbox: c.fromMailbox || '', ticketAdminEmail: c.ticketAdminEmail || '',
    defaultCc: (c.defaultCc || []).join(', '), replyTo: c.replyTo || '', logoUrl: c.logoUrl || '',
    autoCloseDays: String(c.autoCloseDays ?? 0), inboundMailbox: c.inboundMailbox || '',
  };
}
// A typed field as the server takes it.
function wire(k, v) {
  if (k === 'defaultCc') return String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (k === 'autoCloseDays') return Math.max(0, Math.round(Number(v)) || 0);
  return String(v || '').trim();
}

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={onChange} disabled={disabled}
      title={on ? 'Enabled' : 'Disabled'} style={{
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

export default function TicketNotifySettings() {
  const { myLevel, isGlobalAdmin } = useRole();
  // The sending mailbox, Default CC and reply-to apply to every company
  // (Neil, 11/02/2026): a Super Administrator's to change - the server
  // refuses a change from anyone else.
  const locked = !isGlobalAdmin;
  const [tab, setTab] = useState('settings');   // settings | log | inbound
  const [cfg, setCfg] = useState(null);          // what the server holds
  const [saving, setSaving] = useState(false);
  const [instantBusy, setInstantBusy] = useState(false);
  const [saved, setSaved] = useState(false);      // a switch / picker just saved
  const [err, setErr] = useState('');

  const load = () => api.getTicketNotifySettings().then(setCfg).catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  // The typed fields are a draft; a switch saved beside them never wipes one
  // half typed (rebase).
  const savedTyped = useMemo(() => typedOf(cfg), [cfg]);
  const { draft, patch, dirty, reset } = useDraft(savedTyped, { rebase: true });

  const save = async () => {
    if (!dirty || saving) return false;
    // Only what changed: agentEmails (the Routing tab's) and every switch stay
    // as the server has them.
    const body = {};
    // The mail plumbing is a Super Administrator's alone (11/02/2026): never sent by anyone else.
    for (const k of TYPED) if (draft[k] !== savedTyped[k] && !(locked && ['fromMailbox', 'defaultCc', 'replyTo'].includes(k))) body[k] = wire(k, draft[k]);
    setSaving(true); setErr('');
    try {
      setCfg(await api.updateTicketNotifySettings(body));
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
        Manager access or above is required to view ticket notification settings.
      </div>
    );
  }
  if (!cfg) return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;

  const set = (k, v) => patch({ [k]: v });
  // A switch or picker: shown at once, saved at once (only its own key), put
  // back with the reason when the server refuses it.
  const instant = async (body, shown) => {
    const before = cfg;
    setCfg((c) => shown(c));
    setInstantBusy(true); setErr(''); setSaved(false);
    try {
      setCfg(await api.updateTicketNotifySettings(body));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setCfg(before);
      setErr(`Could not save that change: ${e.message || String(e)}`);
    } finally { setInstantBusy(false); }
  };
  const setEvent = (k, v) => instant({ enabledEvents: { [k]: v } }, (c) => ({ ...c, enabledEvents: { ...c.enabledEvents, [k]: v } }));
  const setNow = (k, v) => instant({ [k]: v }, (c) => ({ ...c, [k]: v }));
  // Email to Ticket's switch saves on click too; turning it on needs the
  // mailbox it reads, so it asks for one when none is saved yet and saves both.
  const setInbound = async (k, v) => {
    if (k === 'inboundMailbox') { patch({ inboundMailbox: v }); return; }
    if (k !== 'inboundEnabled') { setNow(k, v); return; }
    if (!v || (cfg.inboundMailbox || '').trim()) { setNow('inboundEnabled', !!v); return; }
    const mailbox = await dialog.prompt('Enter the support mailbox Email to Ticket reads. It must be its own mailbox, never the Tasks reply mailbox.', {
      title: 'Turn On Email to Ticket', confirmText: 'Turn On', placeholder: 'support@companydomain.com',
      defaultValue: draft.inboundMailbox || '', required: true,
    });
    if (!mailbox || !mailbox.trim()) return;
    const mb = mailbox.trim().toLowerCase();
    instant({ inboundEnabled: true, inboundMailbox: mb }, (c) => ({ ...c, inboundEnabled: true, inboundMailbox: mb }));
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log'], ['inbound', 'Inbound Email']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}`,
          }}>{lab}</button>
        ))}
      </div>

      {tab === 'settings' ? (
        <>
          {/* Two cards side by side on a wide screen rather than one long
              single-column stack (Pranshu, Aug 27) - mail settings and
              notification-type toggles are two independent groups of
              controls, not one flow that reads top-to-bottom. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 480px) minmax(320px, 420px)', gap: 16, alignItems: 'start' }}>
            <div style={{ ...card, padding: 18 }}>
              {locked && (
                <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 12 }}>
                  The sending mailbox, Default CC and reply-to address apply to every company - only a Super Administrator can change them.
                </div>
              )}
              <Field label="Shared Mailbox (Sender)" hint="Leave blank to send from the default Nexus mailbox.">
                <input value={draft.fromMailbox} onChange={(e) => set('fromMailbox', e.target.value)} readOnly={locked}
                  placeholder="support@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Ticket Administrator" hint="Last resort, emailed only when no agent is available to notify.">
                <input value={draft.ticketAdminEmail} onChange={(e) => set('ticketAdminEmail', e.target.value)}
                  placeholder="ticket-admin@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Default CC" hint="Comma-separated. Applied to every ticket notification.">
                <input value={draft.defaultCc} onChange={(e) => set('defaultCc', e.target.value)} readOnly={locked} placeholder="ops@companydomain.com, qa@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Reply-To Address" hint={cfg.inboundEnabled ? 'While Email to Ticket is on, ticket emails reply to the support mailbox below instead.' : undefined}>
                <input value={draft.replyTo} onChange={(e) => set('replyTo', e.target.value)} readOnly={locked} placeholder="support@companydomain.com" style={inputStyle} />
              </Field>
              <Field label="Company Logo URL" hint="Shown in the email header. Blank uses the default Nexus branding.">
                <input value={draft.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" style={inputStyle} />
              </Field>
              <Field label="Auto-Close Period (Days)" hint="A Resolved ticket auto-closes after this many days if nobody reopens it. 0 = never.">
                <input type="number" min={0} value={draft.autoCloseDays} onChange={(e) => set('autoCloseDays', e.target.value)}
                  style={{ ...inputStyle, width: 120 }} />
              </Field>
              <TicketInboundSettings cfg={{ ...cfg, inboundMailbox: draft.inboundMailbox }} set={setInbound} />
            </div>

            <div style={{ ...card, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ ...fieldLabel, flex: 1 }}>Notification Types</label>
                <SavedCheck show={saved} />
              </div>
              <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 4 }}>Each switch saves as you flip it.</div>
              {Object.entries(EVENT_LABELS).map(([k, lab]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
                  <span style={{ fontSize: 13.5 }}>{lab}</span>
                  <Toggle on={!!cfg.enabledEvents?.[k]} label={lab} disabled={instantBusy} onChange={() => setEvent(k, !cfg.enabledEvents?.[k])} />
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: `1px solid ${NX.border2}`, marginTop: 4 }}>
                <span style={{ fontSize: 13.5 }}>Comments trigger an email and Teams message</span>
                <Toggle on={!!cfg.commentsTrigger} label="Comments trigger an email and Teams message" disabled={instantBusy} onChange={() => setNow('commentsTrigger', !cfg.commentsTrigger)} />
              </div>
              {/* Requesters are emailed and messaged on Teams only when their
                  ticket is assigned, gets a reply, or is resolved/closed (Neil,
                  Oct 1 2026) - attachments no longer email anyone, so their
                  toggle is gone (the setting key stays, unused). */}
              <div style={{ fontSize: 11.5, color: NX.faint, paddingTop: 6 }}>
                Requesters get an email and a Teams message only when their ticket is assigned, gets a reply, or is resolved or closed. Their own changes never message them.
              </div>
            </div>
          </div>

          {err && <div role="alert" style={{ fontSize: 12.5, color: NX.red, margin: '14px 0 0' }}>{err}</div>}
          <SaveRow dirty={dirty} busy={saving} onSave={save} onDiscard={reset}
            note="Saves the mailboxes, addresses, logo and auto-close days. Switches and department pickers save as you change them." />
        </>
      ) : tab === 'log' ? (
        <DeliveryLog />
      ) : (
        <TicketInboundLog enabled={!!cfg.inboundEnabled} mailbox={cfg.inboundMailbox || ''} />
      )}
    </div>
  );
}

const LOG_LIMIT = 20;

function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');

  const load = () => {
    setRows(null);
    api.getTicketNotifyLog({ ...(status ? { status } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows: r, total: t }) => { setRows(r); setTotal(t); })
      .catch((e) => { setErr(e.message || String(e)); setRows([]); setTotal(0); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status, offset]);

  const currentPage = Math.floor(offset / LOG_LIMIT) + 1;
  const totalPages = Math.ceil(total / LOG_LIMIT);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <TicketSelect value={status} onChange={(v) => { setOffset(0); setStatus(v); }} style={{ width: 'auto', minWidth: 150 }}
          options={[['', 'All statuses'], ['sent', 'Sent'], ['failed', 'Failed'], ['pending', 'Pending'], ['retrying', 'Retrying']]} />
        <button style={btn('ghost')} onClick={load} title="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      {rows === null ? (
        <LoadingState compact />
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>No notification attempts yet.</div>
      ) : (
        <>
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {rows.map((r) => {
              const meta = STATUS_META[r.status] || STATUS_META.pending;
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5 }}>
                  <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, flexShrink: 0, width: 78 }}>{r.ticketCode}</span>
                  <span style={{ color: NX.dim, flexShrink: 0, width: 90, textTransform: 'capitalize' }}>{r.eventType}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.subject}>{r.recipient}</span>
                  <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, textTransform: 'capitalize' }}>{r.status}</span>
                  <span style={{ color: NX.faint, flexShrink: 0 }}>{r.attempts}x</span>
                  {r.error && <span style={{ color: NX.red, flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>{r.error}</span>}
                </div>
              );
            })}
          </div>
          {total > LOG_LIMIT && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 14 }}>
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LOG_LIMIT))}
                style={{ ...btn('ghost'), opacity: offset === 0 ? 0.4 : 1, cursor: offset === 0 ? 'default' : 'pointer' }}>
                ← Prev
              </button>
              <span style={{ fontSize: 12, color: NX.faint }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                disabled={offset + LOG_LIMIT >= total}
                onClick={() => setOffset(offset + LOG_LIMIT)}
                style={{ ...btn('ghost'), opacity: offset + LOG_LIMIT >= total ? 0.4 : 1, cursor: offset + LOG_LIMIT >= total ? 'default' : 'pointer' }}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
