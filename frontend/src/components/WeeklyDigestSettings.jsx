// Weekly Digest - admin settings (Sep 28 2026). Separate from the Daily
// Briefing (backend weekly_digest.py): one email per person per week listing
// their overdue tasks with due dates and an Extend Due Date button, plus
// "Still to Do" - the Daily Briefing's Action Required items (Sep 29). Neil's
// default is every Monday, 2 hours before the person's shift, and it is meant
// to just work - these settings exist to test it and switch it on, not for
// every employee to tune. Same Global-Admin bar, off/test/live modes and
// "confirm before going live" speed bump as DailyBriefingSettings.jsx.
import { useEffect, useState } from 'react';
import { CalendarDays, Save, Send, AlertTriangle, ShieldAlert, RefreshCw, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';
import { formatDate, formatTime } from '../lib/datetime';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };

const MODES = [
  { key: 'off', label: 'Off', hint: 'Scans and logs on the send day, but never sends mail.' },
  { key: 'test', label: 'Test', hint: 'Builds every employee’s real digest, but sends each one to the test recipients below.' },
  { key: 'live', label: 'Live', hint: 'Sends each employee their own digest, to their own inbox.' },
];
// ISO weekday numbers, as stored by the backend (1 = Monday .. 7 = Sunday).
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Same bounds as the backend (daily_briefing.validate_timing).
const LEAD_MIN = 30;
const LEAD_MAX = 360;
const SLOTS = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
let ZONES = [];
try { ZONES = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: current zone only */ }
const withCurrent = (list, v) => (v && !list.includes(v) ? [v, ...list] : list);

export default function WeeklyDigestSettings() {
  const { can } = useRole();
  const [tab, setTab] = useState('settings');   // settings | log
  const [cfg, setCfg] = useState(null);
  const [savedMode, setSavedMode] = useState(null);
  const [recipientsInput, setRecipientsInput] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getWeeklyDigestConfig()
      .then((c) => { setCfg(c); setSavedMode(c.mode); setRecipientsInput((c.test_recipients || []).join(', ')); })
      .catch((e) => setErr(e.message || String(e)));
  }, []);

  if (!can('administrator')) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>
        Global-Admin access is required to view Weekly Digest settings.
      </div>
    );
  }
  if (!cfg) return <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err || 'Loading…'}</div>;

  // Only an actual switch INTO live needs the tick - re-saving while already
  // live must not ask again (same rule as the daily settings).
  const goingLive = cfg.mode === 'live';
  const switchingToLive = goingLive && savedMode !== 'live' && !confirmLive;
  const lead = Number(cfg.leadMinutes ?? 120);

  const save = async () => {
    if (switchingToLive) return;
    if (!Number.isInteger(lead) || lead < LEAD_MIN || lead > LEAD_MAX) {
      setErr(`Minutes before shift must be a whole number from ${LEAD_MIN} to ${LEAD_MAX}.`);
      return;
    }
    setSaving(true); setErr(''); setSaved(false);
    try {
      const next = await api.updateWeeklyDigestConfig({
        mode: cfg.mode,
        test_recipients: recipientsInput.split(',').map((s) => s.trim()).filter(Boolean),
        sendDay: Number(cfg.sendDay) || 1,
        leadMinutes: lead,
        includeNoShift: cfg.includeNoShift !== false,
        defaultSendTime: cfg.defaultSendTime || '08:00',
        defaultTimeZone: cfg.defaultTimeZone || 'America/Los_Angeles',
      });
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <CalendarDays size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Weekly Digest</div>
      </div>
      <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 14 }}>
        One email a week listing each employee's overdue tasks with their due dates, and a button to extend each
        one, plus everything else still waiting on them (approvals, time off to decide, time card, items, tickets,
        documents to sign). Managers also see which of their reports have overdue work. Separate from the Daily Briefing.
      </div>
      <div className="scroll-tabs" style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['log', 'Delivery Log']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}`,
          }}>{lab}</button>
        ))}
      </div>

      {tab === 'log' ? <DigestDeliveryLog /> : (
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
              <input type="radio" name="weekly-digest-mode" checked={cfg.mode === m.key}
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
          <label style={fieldLabel} htmlFor="weekly-digest-recipients">Test Recipients</label>
          <input id="weekly-digest-recipients" value={recipientsInput} onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="you@company.com, another@company.com" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Comma-separated. Each employee's digest is built from their own tasks and sent here instead, with a
            "[TEST -&gt; original]" subject prefix.
          </div>
        </div>
      )}

      <div style={{ marginBottom: 16, fontSize: 13 }}>
        <label style={fieldLabel}>Timing</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          Every
          <select aria-label="Send day" value={cfg.sendDay || 1}
            onChange={(e) => setCfg((c) => ({ ...c, sendDay: Number(e.target.value) }))} style={{ ...inputStyle, width: 'auto' }}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
          <input type="number" min={LEAD_MIN} max={LEAD_MAX} step={5} aria-label="Minutes before shift start"
            value={cfg.leadMinutes ?? 120} onChange={(e) => setCfg((c) => ({ ...c, leadMinutes: e.target.value }))}
            style={{ ...inputStyle, width: 80 }} />
          minutes before the person's shift starts
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.includeNoShift !== false}
              onChange={(e) => setCfg((c) => ({ ...c, includeNoShift: e.target.checked }))} />
            No shift that day: send at
          </label>
          <select aria-label="Fallback send time" disabled={cfg.includeNoShift === false} value={cfg.defaultSendTime || '08:00'}
            onChange={(e) => setCfg((c) => ({ ...c, defaultSendTime: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
            {withCurrent(SLOTS, cfg.defaultSendTime).map((t) => <option key={t} value={t}>{formatTime(`2000-01-01T${t}:00`)}</option>)}
          </select>
          <select aria-label="Default time zone" disabled={cfg.includeNoShift === false} value={cfg.defaultTimeZone || 'America/Los_Angeles'}
            onChange={(e) => setCfg((c) => ({ ...c, defaultTimeZone: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
            {withCurrent(ZONES, cfg.defaultTimeZone || 'America/Los_Angeles').map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
          The default is Monday, 120 minutes before each shift, in the shift's own time zone. People with no shift
          that day get it at the time above in their shift time zone, else the one picked here.
        </div>
      </div>

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
              Everyone with an overdue task or other work waiting gets their digest on the next send day. Check Test mode with a few real
              people first.
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

      <SendTestDigest testRecipients={cfg.test_recipients || []} />
      </>
      )}
    </div>
  );
}

// Send Test Digest (Sep 28): build any employee's real digest right now and
// mail it to the test recipients (else the admin), in any mode and on any day,
// without logging - so testing never stands in for their real weekly send.
// A copy for someone else carries no act-as-them links (Extend, Comment...);
// send your OWN digest to try Extend Due Date.
function SendTestDigest({ testRecipients }) {
  const [people, setPeople] = useState([]);
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { ok, text }

  useEffect(() => {
    let alive = true;
    // Curated Nexus People list (CLAUDE.md), never M365/GAL-derived.
    api.getPeopleDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email }))
        .filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const send = async () => {
    const email = who.trim();
    if (!email) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.sendTestWeeklyDigest(email);
      const where = (r.recipients || []).join(', ');
      if (!r.sent) setResult({ ok: true, text: `${r.employeeEmail} has nothing overdue or waiting right now, so there is nothing to send.` });
      else setResult({ ok: true, text: `Sent ${r.employeeEmail}'s digest (${r.overdueCount} overdue${r.pendingCount ? `, ${r.pendingCount} still to do` : ''}${r.teamCount ? `, ${r.teamCount} team` : ''}) to ${where}.` });
    } catch (e) { setResult({ ok: false, text: e.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${NX.border}` }}>
      <label style={fieldLabel} htmlFor="weekly-digest-test-who">Send Test Digest</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input id="weekly-digest-test-who" list="weekly-digest-people" value={who} onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Employee email" style={{ ...inputStyle, width: 280, maxWidth: '100%' }} />
        <datalist id="weekly-digest-people">
          {people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
        </datalist>
        <button style={{ ...btn('outline'), opacity: busy || !who.trim() ? 0.6 : 1 }} onClick={send} disabled={busy || !who.trim()}>
          <Send size={14} /> {busy ? 'Sending…' : 'Send Test'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
        Builds this person's real digest now and sends it to {testRecipients.length ? testRecipients.join(', ') : 'you'}, whatever
        the mode or day. Nothing is logged and nobody else is emailed. Only a test of your own digest includes Extend Due Date and
        the other task buttons, since those act as the person.
      </div>
      {result && (
        <div role="status" style={{ fontSize: 12.5, marginTop: 8, fontWeight: 600, color: result.ok ? NX.green : NX.red }}>
          {result.text}
        </div>
      )}
    </div>
  );
}

// A blank sentAt means one of three things; mode and the counts tell them apart.
function statusOf(row) {
  if (row.sentAt) return { label: 'Sent', color: NX.green, Icon: CheckCircle2 };
  if (row.mode === 'off') return { label: 'Off (scan only)', color: NX.faint, Icon: MinusCircle };
  // The log counts overdue work only; a digest with only "Still to Do" items
  // that went out shows as Sent above.
  if (!((row.overdueCount || 0) + (row.teamCount || 0))) return { label: 'Nothing to send', color: NX.faint, Icon: MinusCircle };
  return { label: 'Send failed', color: NX.red, Icon: XCircle };
}

const LOG_LIMIT = 25;

function DigestDeliveryLog() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [emailFilter, setEmailFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [resendingId, setResendingId] = useState('');
  // Bumped to re-fetch (Refresh, Enter in the filter, after a resend). The
  // filter is read when a fetch starts, not on every keystroke.
  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let live = true;
    api.getWeeklyDigestLog({ ...(emailFilter ? { employee_email: emailFilter.trim() } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows: r, total: t }) => { if (live) { setRows(r); setTotal(t); } })
      .catch((e) => { if (live) { setErr(e.message || String(e)); setRows([]); setTotal(0); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, reloadKey]);

  const resend = async (row) => {
    const ok = await dialog.confirm(
      `Send ${row.employeeEmail}'s weekly digest right now?` +
      (row.sentAt ? ' This week already went out, so they will get a second email.' : '') +
      ' It does not wait for the send day or their shift, and does not change anyone else\'s schedule.',
      { title: 'Force Resend', confirmText: 'Send Now' },
    );
    if (!ok) return;
    setResendingId(row.id); setNote(''); setErr('');
    try {
      const res = await api.forceResendWeeklyDigest(row.id);
      if (res.sentNow) setNote(`Sent ${row.employeeEmail}'s weekly digest.`);
      else if (res.mode === 'off') setNote('Cleared, but Mode is Off - nothing was sent. Switch to Test or Live first.');
      else if (!res.hadContent) setNote(`${row.employeeEmail} has nothing overdue or waiting right now - no email needed.`);
      else setErr('Cleared, but the send did not go through.');
      load();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setResendingId(''); }
  };

  const currentPage = Math.floor(offset / LOG_LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(total / LOG_LIMIT));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={emailFilter} onChange={(e) => setEmailFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setOffset(0); load(); } }}
          placeholder="Filter by employee email…" style={{ ...inputStyle, width: 260, maxWidth: '100%' }} />
        <button style={btn('ghost')} onClick={() => { setOffset(0); load(); }} title="Refresh" aria-label="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
        {note && <span role="status" style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>{note}</span>}
      </div>
      {rows === null ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>No weekly scans logged yet.</div>
      ) : (
        <>
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {rows.map((r) => {
              const meta = statusOf(r);
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5, flexWrap: 'wrap' }}>
                  <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.employeeEmail}>{r.employeeEmail}</span>
                  <span style={{ color: NX.dim, flexShrink: 0 }} title="Week starting">{formatDate(r.weekStart)}</span>
                  <span style={{ color: NX.faint, flexShrink: 0, width: 50, textTransform: 'capitalize' }}>{r.mode}</span>
                  <span style={{ color: NX.faint, flexShrink: 0 }}>
                    {r.overdueCount} overdue{r.teamCount ? ` / ${r.teamCount} team` : ''}
                  </span>
                  <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: 120 }}>{meta.label}</span>
                  <button onClick={() => resend(r)} disabled={resendingId === r.id}
                    title="Sends this employee's weekly digest right now"
                    style={{ ...btn('ghost'), flexShrink: 0, fontSize: 11.5, padding: '4px 8px', opacity: resendingId === r.id ? 0.5 : 1 }}>
                    {resendingId === r.id ? 'Sending…' : 'Force Resend'}
                  </button>
                </div>
              );
            })}
          </div>
          {total > LOG_LIMIT && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 14 }}>
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LOG_LIMIT))}
                style={{ ...btn('ghost'), opacity: offset === 0 ? 0.4 : 1 }}>← Prev</button>
              <span style={{ fontSize: 12, color: NX.faint }}>Page {currentPage} of {totalPages}</span>
              <button disabled={offset + LOG_LIMIT >= total} onClick={() => setOffset(offset + LOG_LIMIT)}
                style={{ ...btn('ghost'), opacity: offset + LOG_LIMIT >= total ? 0.4 : 1 }}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
