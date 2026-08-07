// Ticket Notification workflow - admin settings + delivery log (Jul 2026).
// Manager+ only (mirrors the backend's require_manager gate on these
// endpoints - this UI hides the controls, the backend is the real boundary).
import { useEffect, useState } from 'react';
import { Mail, RefreshCw, Save, AlertTriangle, CheckCircle2, Clock, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle, card } from '../tasks/theme';
import { SkeletonBlocks } from '../components/AsyncState';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const field = { marginBottom: 14 };
const EVENT_LABELS = {
  created: 'Ticket created', assigned: 'Ticket assigned', updated: 'Ticket updates',
  resolved: 'Ticket resolved', reopened: 'Ticket reopened', approval_required: 'Approval required',
};
const STATUS_META = {
  sent: { color: NX.green, Icon: CheckCircle2 }, failed: { color: NX.red, Icon: AlertTriangle },
  pending: { color: NX.dim, Icon: Clock }, retrying: { color: NX.amber, Icon: RotateCcw },
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

export default function TicketNotifySettings() {
  const { myLevel } = useRole();
  const [tab, setTab] = useState('settings');   // settings | log
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [ccInput, setCcInput] = useState('');

  const load = () => api.getTicketNotifySettings().then((c) => { setCfg(c); setCcInput((c.defaultCc || []).join(', ')); }).catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  if (myLevel < 3) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Manager access or above is required to view ticket notification settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setEvent = (k, v) => setCfg((c) => ({ ...c, enabledEvents: { ...c.enabledEvents, [k]: v } }));

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      // agentEmails is owned by the Service Desk panel above and deliberately
      // dropped here: this form holds a whole copy of the config, so saving it
      // back would revert a roster changed since this copy was loaded.
      const { agentEmails: _desk, ...rest } = cfg;
      const patch = { ...rest, defaultCc: ccInput.split(',').map((s) => s.trim()).filter(Boolean) };
      const next = await api.updateTicketNotifySettings(patch);
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
        <div style={{ fontSize: 18, fontWeight: 700 }}>Ticket Email Notifications</div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log']].map(([k, lab]) => (
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
              placeholder="support@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Ticket Administrator" hint="Last resort, emailed only when no agent is available to notify.">
            <input value={cfg.ticketAdminEmail || ''} onChange={(e) => set('ticketAdminEmail', e.target.value)}
              placeholder="ticket-admin@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Default CC" hint="Comma-separated. Applied to every ticket notification.">
            <input value={ccInput} onChange={(e) => setCcInput(e.target.value)} placeholder="ops@companydomain.com, qa@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Reply-to address">
            <input value={cfg.replyTo || ''} onChange={(e) => set('replyTo', e.target.value)} placeholder="support@companydomain.com" style={inputStyle} />
          </Field>
          <Field label="Company logo URL" hint="Shown in the email header. Blank uses the default Nexus branding.">
            <input value={cfg.logoUrl || ''} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" style={inputStyle} />
          </Field>
          <Field label="Auto-close period (days)" hint="A Resolved ticket auto-closes after this many days if nobody reopens it. 0 = never.">
            <input type="number" min={0} value={cfg.autoCloseDays ?? 0} onChange={(e) => set('autoCloseDays', Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 120 }} />
          </Field>

          <div style={{ ...field, borderTop: `1px solid ${NX.border2}`, paddingTop: 14 }}>
            <label style={fieldLabel}>Notification types</label>
            {Object.entries(EVENT_LABELS).map(([k, lab]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
                <span style={{ fontSize: 13.5 }}>{lab}</span>
                <Toggle on={!!cfg.enabledEvents?.[k]} onChange={() => setEvent(k, !cfg.enabledEvents?.[k])} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
              <span style={{ fontSize: 13.5 }}>Comments trigger an email</span>
              <Toggle on={!!cfg.commentsTrigger} onChange={() => set('commentsTrigger', !cfg.commentsTrigger)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
              <span style={{ fontSize: 13.5 }}>Attachments trigger an email</span>
              <Toggle on={!!cfg.attachmentsTrigger} onChange={() => set('attachmentsTrigger', !cfg.attachmentsTrigger)} />
            </div>
          </div>

          {err && <div style={{ fontSize: 12.5, color: NX.red, marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button style={{ ...btn('primary'), opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
            </button>
            {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
          </div>
        </div>
      ) : (
        <DeliveryLog />
      )}
    </div>
  );
}

function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');

  const load = () => {
    setRows(null);
    api.getTicketNotifyLog(status ? { status } : {}).then(setRows).catch((e) => { setErr(e.message || String(e)); setRows([]); });
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
      )}
    </div>
  );
}
