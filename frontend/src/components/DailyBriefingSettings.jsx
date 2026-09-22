// Daily Briefing - admin settings (Sep 2026). Global-Admin gated: this flag
// controls whether every employee in the company starts receiving a daily
// email, so it mirrors the backend's require_administrator bar (level 4),
// not the lower manager bar Ticket/Task notify settings use - see
// backend/routers/daily_briefing.py.
//
// Delivery Log tab added Sep 20 (Pranshu: mail kept not arriving with no way
// to tell WHY - the log's sent_at column is blank for three different
// reasons that look identical without the other columns: mode was off,
// there was nothing to report that scan, or the Graph send actually failed.
// See STATUS_OF below for how each row disambiguates them.
import { useEffect, useState } from 'react';
import { Mail, Save, AlertTriangle, ShieldAlert, RefreshCw, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

const MODES = [
  { key: 'off', label: 'Off', hint: 'Loop still scans and logs (for timing/dedupe visibility) but never sends mail.' },
  { key: 'test', label: 'Test', hint: 'Computes every employee’s real content, but every send is redirected to the test recipients below.' },
  { key: 'live', label: 'Live', hint: 'Sends each employee their own briefing, to their own inbox.' },
];

export default function DailyBriefingSettings() {
  const { can } = useRole();
  const [tab, setTab] = useState('settings');   // settings | log
  const [cfg, setCfg] = useState(null);
  const [savedMode, setSavedMode] = useState(null);   // mode as last persisted - distinguishes an
                                                       // actual off/test -> live transition from just
                                                       // re-saving while already live
  const [recipientsInput, setRecipientsInput] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.getDailyBriefingConfig()
    .then((c) => { setCfg(c); setSavedMode(c.mode); setRecipientsInput((c.test_recipients || []).join(', ')); })
    .catch((e) => setErr(e.message || String(e)));
  useEffect(() => { load(); }, []);

  if (!can('administrator')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Global-Admin access is required to view Daily Briefing settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  const goingLive = cfg.mode === 'live';
  // Switching TO live is the one change here that reaches every employee in
  // the company the moment it saves - everything else (off/test, editing the
  // test list) is reversible with no visible side effect to anyone but the
  // admin. The extra tick is a speed bump for that one transition, not a
  // permission check (the backend already gates the whole endpoint) - so it
  // only applies while actually switching FROM off/test INTO live. Once live
  // is already the saved mode, re-saving (e.g. just to refresh the page)
  // must not force the checkbox to be re-ticked every time - that read as
  // "the checkbox does nothing" (Pranshu, Sep 23).
  const switchingToLive = goingLive && savedMode !== 'live' && !confirmLive;

  const save = async () => {
    if (switchingToLive) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      const patch = {
        mode: cfg.mode,
        test_recipients: recipientsInput.split(',').map((s) => s.trim()).filter(Boolean),
      };
      const next = await api.updateDailyBriefingConfig(patch);
      setCfg(next);
      setSavedMode(next.mode);
      setRecipientsInput((next.test_recipients || []).join(', '));
      setConfirmLive(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Mail size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Daily Briefing</div>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}`,
          }}>{lab}</button>
        ))}
      </div>

      {tab === 'log' ? <DeliveryLog /> : (
      <>
      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel}>Mode</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODES.map((m) => (
            <label key={m.key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              border: `1px solid ${cfg.mode === m.key ? NX.blue : NX.border}`, borderRadius: 8,
              background: cfg.mode === m.key ? 'var(--wk-brand-tint)' : 'transparent', cursor: 'pointer',
            }}>
              <input type="radio" name="briefing-mode" checked={cfg.mode === m.key}
                onChange={() => { setCfg((c) => ({ ...c, mode: m.key })); setConfirmLive(false); }}
                style={{ marginTop: 3 }} />
              <span>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{m.label}</div>
                <div style={{ fontSize: 12, color: NX.faint, marginTop: 2 }}>{m.hint}</div>
              </span>
            </label>
          ))}
        </div>
      </div>

      {cfg.mode === 'test' && (
        <div style={{ marginBottom: 16 }}>
          <label style={fieldLabel}>Test recipients</label>
          <input value={recipientsInput} onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="you@company.com, another@company.com" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Comma-separated. Every employee's briefing computes on their own real data, but the send is
            redirected here instead of their own inbox, with a "[TEST -&gt; original]" subject prefix.
          </div>
        </div>
      )}

      {goingLive && (
        <div style={{
          display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 8, marginBottom: 16,
          background: 'hsla(var(--color-red), 0.08)', border: '1px solid hsla(var(--color-red), 0.35)',
        }}>
          <ShieldAlert size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-red))' }}>
              This sends a real email to every employee in the company
            </div>
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 3 }}>
              Each person gets their own briefing at their own shift trigger - no dry run once this saves.
              Confirm test mode has already been checked for a few real people before turning this on.
            </div>
            {savedMode !== 'live' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
                I understand this goes out to every employee company-wide.
              </label>
            )}
          </div>
        </div>
      )}

      {err && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.red, margin: '0 0 12px' }}>
        <AlertTriangle size={13} /> {err}
      </div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ ...btn('primary'), opacity: (saving || switchingToLive) ? 0.6 : 1 }}
          onClick={save} disabled={saving || switchingToLive}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved</span>}
      </div>
      </>
      )}
    </div>
  );
}

// One row per employee per calendar day the scan ran - not per mail sent, so
// "why didn't X get their briefing" is answerable even when nothing sent:
// off/nothing-to-report/send-failed all log a row, they just differ in
// sentAt + counts (see routers/daily_briefing.py get_log's docstring).
function statusOf(row) {
  if (row.sentAt) return { label: 'Sent', color: NX.green, Icon: CheckCircle2 };
  if (row.mode === 'off') return { label: 'Off (scan only)', color: NX.faint, Icon: MinusCircle };
  const hasContent = (row.redCount || 0) + (row.amberCount || 0) + (row.greenCount || 0) > 0;
  if (!hasContent) return { label: 'Nothing to report', color: NX.faint, Icon: MinusCircle };
  // mode is test/live, there WAS content, and yet nothing sent - the send
  // itself failed (Graph error, no recipients configured, etc).
  return { label: 'Send failed', color: NX.red, Icon: XCircle };
}

const LOG_LIMIT = 25;

function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [emailFilter, setEmailFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');
  const [resendingId, setResendingId] = useState('');

  const load = () => {
    setRows(null);
    api.getDailyBriefingLog({ ...(emailFilter ? { employee_email: emailFilter.trim() } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows: r, total: t }) => { setRows(r); setTotal(t); })
      .catch((e) => { setErr(e.message || String(e)); setRows([]); setTotal(0); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [offset]);

  const forceResend = async (row) => {
    const already = row.sentAt
      ? 'This day already sent successfully - this WILL send a second real email right now. '
      : '';
    if (!window.confirm(
      `${already}Send ${row.employeeEmail}'s ${row.briefingDate} briefing right now?\n\n` +
      `This sends immediately, regardless of their shift window - it does not wait for the next scan or for the ` +
      `window to be open. Nothing changes for any other employee or for the normal 15-minute scan schedule.`
    )) return;
    setResendingId(row.id);
    try {
      const result = await api.forceResendDailyBriefing(row.id);
      if (result.sentNow) {
        alert(`Sent - ${row.employeeEmail}'s briefing went out just now (mode: ${result.mode}).`);
      } else if (result.mode === 'off') {
        alert(`Cleared, but mode is currently Off - nothing was sent. Switch to Test or Live first.`);
      } else if (!result.hadContent) {
        alert(`Cleared, but there was nothing to report for ${row.employeeEmail} right now - no email needed.`);
      } else {
        alert(`Cleared, but the send did not go through - check the Delivery Log for details.`);
      }
      load();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setResendingId(''); }
  };

  const currentPage = Math.floor(offset / LOG_LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(total / LOG_LIMIT));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input value={emailFilter} onChange={(e) => setEmailFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setOffset(0); load(); } }}
          placeholder="Filter by employee email…" style={{ ...inputStyle, width: 260 }} />
        <button style={btn('ghost')} onClick={() => { setOffset(0); load(); }} title="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      {rows === null ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>No scan attempts logged yet.</div>
      ) : (
        <>
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {rows.map((r) => {
              const meta = statusOf(r);
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5 }}>
                  <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.employeeEmail}>{r.employeeEmail}</span>
                  <span style={{ color: NX.dim, flexShrink: 0, width: 90 }}>{r.briefingDate}</span>
                  <span style={{ color: NX.faint, flexShrink: 0, width: 50, textTransform: 'capitalize' }}>{r.mode}</span>
                  <span style={{ color: NX.faint, flexShrink: 0, width: 110 }}>{r.redCount}R / {r.amberCount}A / {r.greenCount}G</span>
                  <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: 130 }}>{meta.label}</span>
                  <button onClick={() => forceResend(r)} disabled={resendingId === r.id}
                    title="Sends this employee's briefing right now, regardless of their shift window"
                    style={{ ...btn('ghost'), flexShrink: 0, fontSize: 11.5, padding: '4px 8px', opacity: resendingId === r.id ? 0.5 : 1 }}>
                    {resendingId === r.id ? 'Sending…' : 'Force Resend'}
                  </button>
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
