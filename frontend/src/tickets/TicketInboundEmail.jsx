// Email to ticket (Oct 2026, backend/ticket_inbound.py) - the settings block
// inside Ticket Email Notifications, and the Inbound Email log beside the
// Delivery Log. Same shape as the Tasks "Accept replies by email" block and
// its Replies log (tasks/TaskNotifySettings.jsx).
//
// The switch is a switch, not something derived from "the mailbox happens to
// be readable": draining a mailbox marks its mail read and files it away, a
// visible takeover of a mailbox somebody may be watching.
import { useEffect, useState } from 'react';
import { RefreshCw, Play, AlertTriangle, Paperclip } from 'lucide-react';
import { api } from '../api';
import { NX, btn, input as inputStyle, card } from '../tasks/theme';
import { LoadingState } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { TicketSelect } from './TicketAtoms';
import { formatDateTime } from '../lib/datetime';
import { openNotificationTarget } from '../lib/openTarget';
import { ticketNo } from './ticketMeta';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

// What became of a message - TicketInboundEmail.outcome.
const OUTCOME_META = {
  comment: { label: 'Comment Added', color: NX.green },
  created: { label: 'Ticket Created', color: NX.blue },
  refused: { label: 'Refused', color: NX.amber },
  failed:  { label: 'Failed', color: NX.red },
};

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" onClick={onChange} aria-label={label} aria-pressed={on} title={on ? 'Enabled' : 'Disabled'} style={{
      position: 'relative', width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0,
    }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

// The settings half. `cfg` / `set` are TicketNotifySettings' own - this saves
// with that form's Save Settings.
export function TicketInboundSettings({ cfg, set }) {
  const [companies, setCompanies] = useState(null);
  const [depts, setDepts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [err, setErr] = useState('');
  const on = !!cfg.inboundEnabled;
  const mailbox = cfg.inboundMailbox || '';
  const defaults = cfg.inboundDefaultDepartment || {};

  useEffect(() => {
    if (!on || companies !== null) return;
    Promise.all([api.getTicketCompanies(), api.getTicketDepartments()])
      .then(([c, d]) => { setCompanies(c || []); setDepts((d || []).filter((x) => !x.removed)); })
      .catch((e) => { setCompanies([]); setErr(e.message || String(e)); });
  }, [on, companies]);

  const setDefault = (companyId, deptId) => {
    const next = { ...defaults };
    if (deptId) next[companyId] = deptId; else delete next[companyId];
    set('inboundDefaultDepartment', next);
  };

  const runNow = async () => {
    setBusy(true); setErr(''); setResult('');
    try {
      const c = await api.drainTicketInbox();
      setResult(c.seen
        ? `Read ${c.seen} message${c.seen === 1 ? '' : 's'}: ${c.created} new, ${c.comment} replies, ${c.refused} refused.`
        : 'Mailbox reached. Nothing new to read.');
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ borderTop: `1px solid ${NX.border2}`, paddingTop: 14, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Email to Ticket</div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>
            A new email to the support mailbox from someone on the Nexus People list becomes a ticket,
            and a reply to a ticket email becomes a comment on that ticket.
          </div>
        </div>
        <Toggle on={on} label="Email to Ticket" onChange={() => set('inboundEnabled', !on)} />
      </div>

      {on && (
        <div style={{ marginTop: 12 }}>
          <label style={fieldLabel}>Support Mailbox</label>
          <input value={mailbox} onChange={(e) => set('inboundMailbox', e.target.value)}
            placeholder="support@companydomain.com" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4, marginBottom: 12 }}>
            Its own mailbox - never the Tasks reply mailbox. Ticket emails are sent with a per-ticket reply
            address{mailbox.includes('@') ? <> like <code style={{ fontSize: 11, color: NX.dim }}>{mailbox.split('@')[0]}+t1a2b…@{mailbox.split('@')[1]}</code></> : ''},
            so a reply reaches its own ticket.
          </div>

          <label style={fieldLabel}>Default Department for New Tickets</label>
          <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 8 }}>
            Per company, from the sender&apos;s People record. A company with none set has its new emails refused.
          </div>
          {companies === null ? <LoadingState compact /> : companies.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 12 }}>No companies set up yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
              {companies.map((co) => (
                <div key={co.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, minWidth: 120, flex: '0 0 auto' }}>{co.name}</span>
                  <TicketSelect value={defaults[co.id] || ''} onChange={(v) => setDefault(co.id, v)}
                    style={{ flex: 1, minWidth: 180 }}
                    options={[['', 'None (refuse new emails)'],
                      ...depts.filter((d) => d.companyId === co.id).map((d) => [d.id, d.name])]} />
                </div>
              ))}
            </div>
          )}

          <div style={{
            background: NX.surface2, border: `1px solid ${NX.border2}`, borderRadius: 9,
            padding: '10px 12px', fontSize: 11.5, color: NX.dim, marginBottom: 12,
          }}>
            Needs the Mail.ReadWrite application permission on this mailbox. Mail from outside the company,
            guests, people who left, automated mail and replies from someone who cannot see the ticket are
            refused and listed under Inbound Email. Nobody is sent an automatic reply.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" style={{ ...btn('outline'), opacity: busy ? 0.6 : 1 }} onClick={runNow} disabled={busy}>
              <Play size={13} /> {busy ? 'Checking…' : 'Check Mailbox Now'}
            </button>
            {result && <span style={{ fontSize: 12, color: NX.green }}>{result}</span>}
            {err && <span style={{ fontSize: 12, color: NX.red }}>{err}</span>}
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
            Save first - this uses the saved settings. The deployed API checks the mailbox every minute on its own.
          </div>
        </div>
      )}
    </div>
  );
}

function openTicket(ticketId) {
  openNotificationTarget({ ticketId });
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
}

// The log half: the last 100 messages and what became of each. The answer to
// "I emailed support and nothing happened" - by then the message is read and
// filed, so these rows are the only evidence left.
export default function TicketInboundLog({ enabled = true, mailbox = '' }) {
  const [rows, setRows] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.getTicketInboundLog({ ...(outcome ? { outcome } : {}), limit: 100 })
      .then((r) => { if (live) { setErr(''); setRows(r?.rows || []); } })
      .catch((e) => { if (live) { setErr(e.message || String(e)); setRows([]); } });
    return () => { live = false; };
  }, [outcome, tick]);
  const load = () => { setRows(null); setTick((n) => n + 1); };
  const pick = (v) => { setRows(null); setOutcome(v); };

  return (
    <div>
      {!enabled && (
        <div style={{ ...card, padding: 12, marginBottom: 12, fontSize: 12.5, color: NX.dim, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={14} style={{ color: NX.amber, flexShrink: 0 }} />
          The support mailbox is not being read right now. Turn on Email to Ticket under Settings.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <TicketSelect value={outcome} onChange={pick} style={{ width: 'auto', minWidth: 170 }}
          options={[['', 'All messages'], ['created', 'Ticket Created'], ['comment', 'Comment Added'],
            ['refused', 'Refused'], ['failed', 'Failed']]} />
        <button type="button" style={btn('ghost')} onClick={load} title="Refresh" aria-label="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      {rows === null ? <LoadingState compact /> : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>
          {outcome ? 'No messages with this outcome.' : `Nothing has been received yet${mailbox ? ` at ${mailbox}` : ''}.`}
        </div>
      ) : (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((r) => {
            const meta = OUTCOME_META[r.outcome] || OUTCOME_META.failed;
            return (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', flexWrap: 'wrap',
                borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5,
              }}>
                <StatusLabel label={meta.label} color={meta.color} size="sm" />
                <span style={{ flexShrink: 0, width: 92 }}>
                  {r.ticketId ? (
                    <button type="button" onClick={() => openTicket(r.ticketId)} title="Open this ticket"
                      style={{ ...btn('ghost'), padding: 0, fontSize: 12.5, fontWeight: 700, color: NX.blue }}>
                      {ticketNo(r.ticketCode) || 'Open'}
                    </button>
                  ) : <span style={{ color: NX.faint }}>-</span>}
                </span>
                <span style={{ flexShrink: 0, width: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.from}>
                  {r.from || 'unknown sender'}
                </span>
                <span style={{ flex: 1, minWidth: 140, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.subject}>
                  {r.subject || '(no subject)'}
                </span>
                {r.attachmentCount > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: NX.faint, flexShrink: 0 }}
                    title={`${r.attachmentCount} file${r.attachmentCount === 1 ? '' : 's'}`}>
                    <Paperclip size={12} />{r.attachmentCount}
                  </span>
                )}
                {/* The reason is the point of a refused row - and on one that
                    went through it names a file that could not be filed. */}
                <span style={{ color: NX.faint, flexShrink: 0, width: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.reason}>
                  {r.reason || ''}
                </span>
                <span style={{ color: NX.faint, flexShrink: 0 }} title="Received">
                  {formatDateTime(r.receivedAt || r.processedAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
