// Workforce Scorecard - admin settings (Neil, 10/10). Backend
// workforce_scorecard.py: one email per manager per week holding each hourly
// person's punched hours against their expected hours (published shift >
// preset > country standard: US 8h, India 9h). Same Global-Admin bar,
// off/test/live modes and "confirm before going live" speed bump as
// WeeklyDigestSettings.jsx. Who receives it is NOT configured here: it is the
// 'workforce-scorecard' grant on a job role or access group (Roles & Access):
// Viewer = direct reports (Neil, 10/10: the default), Editor = whole
// reporting line, Full = company - plus the company-wide recipients below.
import { useEffect, useState } from 'react';
import { LoadingState } from './AsyncState';
import { Trophy, Save, Send, ShieldAlert, RefreshCw, CheckCircle2, XCircle, MinusCircle, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { useRole } from '../contexts/RoleContext';
import { NX, FONT, btn, input as inputStyle } from '../tasks/theme';
import { formatDate, formatTime } from '../lib/datetime';

const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const hint = { fontSize: 11.5, color: NX.faint, marginTop: 4 };
const MODES = [
  { key: 'off', label: 'Off', hint: 'Builds and logs each manager’s scorecard on the send day, but never sends mail.' },
  { key: 'test', label: 'Test', hint: 'Builds every manager’s real scorecard, but sends each one to the test recipients below.' },
  { key: 'live', label: 'Live', hint: 'Sends each manager their own scorecard, to their own inbox.' },
];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SLOTS = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
let ZONES = [];
try { ZONES = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: current zone only */ }
const withCurrent = (list, v) => (v && !list.includes(v) ? [v, ...list] : list);
const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function WorkforceScorecardSettings() {
  const { can } = useRole();
  const [tab, setTab] = useState('settings');   // settings | recipients | log
  const [cfg, setCfg] = useState(null);
  const [savedMode, setSavedMode] = useState(null);
  const [lists, setLists] = useState({ test: '', company: '', working: '' });
  const [confirmLive, setConfirmLive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const adopt = (c) => {
    setCfg(c); setSavedMode(c.mode);
    setLists({ test: (c.test_recipients || []).join(', '), company: (c.companyRecipients || []).join(', '),
      working: (c.workingTimeOffTypes || []).join(', ') });
  };
  useEffect(() => { api.getWorkforceScorecardConfig().then(adopt).catch((e) => setErr(e.message || String(e))); }, []);

  if (!can('administrator')) {
    return <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13.5 }}>Global-Admin access is required to view Workforce Scorecard settings.</div>;
  }
  if (!cfg) return err ? <div style={{ padding: 24, fontSize: 13, color: NX.faint }}>{err}</div> : <LoadingState />;

  const goingLive = cfg.mode === 'live';
  const switchingToLive = goingLive && savedMode !== 'live' && !confirmLive;
  const std = cfg.standards || {};
  const setStd = (code, patch) => setCfg((c) => ({ ...c, standards: { ...c.standards, [code]: { ...(c.standards?.[code] || { hours: 8, days: [1, 2, 3, 4, 5] }), ...patch } } }));

  const save = async () => {
    if (switchingToLive) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      const standards = {};
      Object.entries(std).forEach(([k, v]) => { standards[k] = { hours: Number(v.hours), days: (v.days || []).map(Number) }; });
      const next = await api.updateWorkforceScorecardConfig({
        mode: cfg.mode, test_recipients: splitList(lists.test), companyRecipients: splitList(lists.company),
        workingTimeOffTypes: splitList(lists.working),
        sendDay: Number(cfg.sendDay) || 1, sendTime: cfg.sendTime || '08:00', defaultTimeZone: cfg.defaultTimeZone || 'America/Los_Angeles',
        weekStart: cfg.weekStart || 'monday', payTypes: cfg.payTypes?.length ? cfg.payTypes : ['hourly'], standards,
        shortToleranceMin: Number(cfg.shortToleranceMin), onTrackPct: Number(cfg.onTrackPct), belowPct: Number(cfg.belowPct),
      });
      adopt(next); setConfirmLive(false); setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Trophy size={18} style={{ color: NX.dim }} />
        <div style={{ fontSize: 18, fontWeight: 700 }}>Workforce Scorecard</div>
      </div>
      <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 14 }}>
        A weekly email to managers scoring each hourly person's punched hours against their expected hours - who worked,
        who was short, who was absent - for the last full week. Who receives it is decided by the Workforce Scorecard grant in
        Roles &amp; Access (Viewer = their direct reports, Editor = their whole reporting line, Full = the whole company); the settings here decide when and how.
      </div>
      <div className="scroll-tabs" style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: `1px solid ${NX.border}` }}>
        {[['settings', 'Settings'], ['recipients', 'Recipients'], ['log', 'Delivery Log']].map(([k, lab]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btn('ghost'), fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 0,
            color: tab === k ? NX.blue : NX.dim, borderBottom: `2px solid ${tab === k ? NX.blue : 'transparent'}` }}>{lab}</button>
        ))}
      </div>

      {tab === 'log' && <DeliveryLog />}
      {tab === 'recipients' && <Recipients />}
      {tab === 'settings' && (
      <>
      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel}>Mode</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODES.map((m) => (
            <label key={m.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              border: `1px solid ${cfg.mode === m.key ? NX.blue : NX.border}`, borderRadius: 8,
              background: cfg.mode === m.key ? 'var(--wk-brand-tint)' : 'transparent', cursor: 'pointer' }}>
              <input type="radio" name="workforce-scorecard-mode" checked={cfg.mode === m.key}
                onChange={() => { setCfg((c) => ({ ...c, mode: m.key })); setConfirmLive(false); }} style={{ marginTop: 3 }} />
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
          <label style={fieldLabel} htmlFor="wsc-test-recipients">Test Recipients</label>
          <input id="wsc-test-recipients" value={lists.test} onChange={(e) => setLists((l) => ({ ...l, test: e.target.value }))}
            placeholder="you@company.com, another@company.com" style={inputStyle} />
          <div style={hint}>Comma-separated. Each manager's scorecard is built from their own team and sent here instead, with a "[TEST -&gt; manager]" subject prefix.</div>
        </div>
      )}

      <div style={{ marginBottom: 16, fontSize: 13 }}>
        <label style={fieldLabel}>Timing</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          Every
          <select aria-label="Send day" value={cfg.sendDay || 1} onChange={(e) => setCfg((c) => ({ ...c, sendDay: Number(e.target.value) }))} style={{ ...inputStyle, width: 'auto' }}>
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </select>
          at
          <select aria-label="Send time" value={cfg.sendTime || '08:00'} onChange={(e) => setCfg((c) => ({ ...c, sendTime: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
            {withCurrent(SLOTS, cfg.sendTime).map((t) => <option key={t} value={t}>{formatTime(`2000-01-01T${t}:00`)}</option>)}
          </select>
          in each manager's own time zone, else
          <select aria-label="Default time zone" value={cfg.defaultTimeZone || 'America/Los_Angeles'} onChange={(e) => setCfg((c) => ({ ...c, defaultTimeZone: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
            {withCurrent(ZONES, cfg.defaultTimeZone || 'America/Los_Angeles').map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          The scored week starts on
          <select aria-label="Week start" value={cfg.weekStart || 'monday'} onChange={(e) => setCfg((c) => ({ ...c, weekStart: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
            <option value="monday">Monday</option><option value="sunday">Sunday</option>
          </select>
        </div>
        <div style={hint}>Each send covers the last week that has fully ended. A manager's zone is their shift preset's; the default applies to anyone without one. Pick the LATEST zone your people work in as the default (California for a US-India company): the email also waits until the week is over there, so nobody's last day is still in progress when it is scored.</div>
      </div>

      <div style={{ marginBottom: 16, fontSize: 13 }}>
        <label style={fieldLabel}>Who Is Scored</label>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {[['hourly', 'Hourly staff'], ['fixed', 'Salaried staff who punch (fixed pay)']].map(([k, lab]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={(cfg.payTypes || []).includes(k)}
                onChange={(e) => setCfg((c) => ({ ...c, payTypes: e.target.checked ? [...new Set([...(c.payTypes || []), k])] : (c.payTypes || []).filter((p) => p !== k) }))} />
              {lab}
            </label>
          ))}
        </div>
        <div style={hint}>Active internal staff only. People in a role flagged exempt from time tracking are never scored.</div>
      </div>

      <div style={{ marginBottom: 16, fontSize: 13 }}>
        <label style={fieldLabel}>Standard Day (when nobody scheduled the person)</label>
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {Object.keys(std).sort((a, b) => (a === 'default') - (b === 'default') || a.localeCompare(b)).map((code) => (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${NX.border2}`, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, width: 70 }}>{code === 'default' ? 'Other' : code}</span>
              <input type="number" min={0.5} max={16} step={0.5} aria-label={`${code} hours`} value={std[code].hours}
                onChange={(e) => setStd(code, { hours: e.target.value })} style={{ ...inputStyle, width: 70 }} /> hours on
              <div style={{ display: 'flex', gap: 4 }}>
                {DAYS.map((d, i) => {
                  const on = (std[code].days || []).includes(i + 1);
                  return (
                    <button key={d} type="button" aria-pressed={on} title={d} onClick={() => setStd(code, { days: on ? std[code].days.filter((x) => x !== i + 1) : [...std[code].days, i + 1].sort() })}
                      style={{ ...btn('ghost'), width: 30, padding: 0, justifyContent: 'center', fontSize: 11.5, fontWeight: 700,
                        border: `1px solid ${on ? NX.blue : NX.border}`, color: on ? NX.blue : NX.faint, background: on ? 'var(--wk-brand-tint)' : 'transparent' }}>
                      {d.slice(0, 2)}
                    </button>
                  );
                })}
              </div>
              {!['US', 'IN', 'default'].includes(code) && (
                <button type="button" style={btn('ghost')} aria-label={`Remove ${code}`} onClick={() => setCfg((c) => { const s = { ...c.standards }; delete s[code]; return { ...c, standards: s }; })}><Trash2 size={13} /></button>
              )}
            </div>
          ))}
          <AddCountry existing={Object.keys(std)} onAdd={(code) => setStd(code, { hours: 8, days: [1, 2, 3, 4, 5] })} />
        </div>
        <div style={hint}>By country - the person's own, else their company's. Applies to full-time staff with no published shift and no shift preset; part-time, contractors and interns without a shift show as No Schedule instead.</div>
      </div>

      <div style={{ marginBottom: 16, fontSize: 13 }}>
        <label style={fieldLabel}>Scoring</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          On Track from
          <input type="number" min={1} max={100} aria-label="On Track threshold" value={cfg.onTrackPct} onChange={(e) => setCfg((c) => ({ ...c, onTrackPct: e.target.value }))} style={{ ...inputStyle, width: 70 }} />%,
          Below Expected from
          <input type="number" min={0} max={100} aria-label="Below Expected threshold" value={cfg.belowPct} onChange={(e) => setCfg((c) => ({ ...c, belowPct: e.target.value }))} style={{ ...inputStyle, width: 70 }} />%
          (under that is Well Below). A day within
          <input type="number" min={0} max={120} aria-label="Short tolerance minutes" value={cfg.shortToleranceMin} onChange={(e) => setCfg((c) => ({ ...c, shortToleranceMin: e.target.value }))} style={{ ...inputStyle, width: 70 }} />
          minutes of its target counts as full.
        </div>
        <div style={hint}>Score = hours covered (worked plus Sick / PTO punches) divided by hours expected over the week's scored days, capped at 100.</div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel} htmlFor="wsc-working-types">Time-Off Types That Still Count As Working</label>
        <input id="wsc-working-types" value={lists.working} onChange={(e) => setLists((l) => ({ ...l, working: e.target.value }))} placeholder="Work From Home" style={inputStyle} />
        <div style={hint}>Comma-separated, exactly as the time-off type reads. Every other approved request excuses the day.</div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={fieldLabel} htmlFor="wsc-company-recipients">Company-Wide Recipients</label>
        <input id="wsc-company-recipients" value={lists.company} onChange={(e) => setLists((l) => ({ ...l, company: e.target.value }))} placeholder="ceo@company.com" style={inputStyle} />
        <div style={hint}>Always get the whole-company scorecard, whatever their grant or reporting line. Everyone else is decided by the Workforce Scorecard grant.</div>
      </div>

      {goingLive && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 8, marginBottom: 16,
          background: 'hsla(var(--color-red), 0.08)', border: '1px solid hsla(var(--color-red), 0.35)' }}>
          <ShieldAlert size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-red))' }}>This sends a real email to every manager holding the grant</div>
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 3 }}>Check the Recipients tab, and Test mode with a few real managers first.</div>
            {savedMode !== 'live' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} />
                I understand this goes out to every recipient listed.
              </label>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button style={{ ...btn('primary'), opacity: saving || switchingToLive ? 0.6 : 1 }} disabled={saving || switchingToLive} onClick={save}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span role="status" style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>Saved.</span>}
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
      </div>
      <TestSend testRecipients={cfg.test_recipients || []} />
      </>
      )}
    </div>
  );
}

function AddCountry({ existing, onAdd }) {
  const [code, setCode] = useState('');
  const v = code.trim().toUpperCase();
  const ok = /^[A-Z]{2}$/.test(v) && !existing.includes(v);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 12.5 }}>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Country code, e.g. GB" aria-label="New country code" maxLength={2} style={{ ...inputStyle, width: 170 }} />
      <button type="button" style={{ ...btn('ghost'), opacity: ok ? 1 : 0.5 }} disabled={!ok} onClick={() => { onAdd(v); setCode(''); }}><Plus size={13} /> Add Country</button>
    </div>
  );
}

function TestSend({ testRecipients }) {
  const [who, setWho] = useState('');
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const send = async () => {
    const email = who.trim();
    if (!email) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.sendTestWorkforceScorecard(email);
      if (!r.sent) setResult({ ok: true, text: `${r.managerEmail} has nobody on their scorecard for the week of ${formatDate(r.weekStart)}, so there is nothing to send.` });
      else setResult({ ok: true, text: `Sent ${r.managerEmail}'s scorecard for the week of ${formatDate(r.weekStart)} (${r.peopleCount} people, ${r.absentCount} absent, ${r.belowCount} below) to ${(r.recipients || []).join(', ')}.` });
    } catch (e) { setResult({ ok: false, text: e.message || String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${NX.border}` }}>
      <label style={fieldLabel} htmlFor="wsc-test-who">Send Test Scorecard</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input id="wsc-test-who" list="wsc-people" value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Manager email" style={{ ...inputStyle, width: 280, maxWidth: '100%' }} />
        <datalist id="wsc-people">{people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}</datalist>
        <button style={{ ...btn('outline'), opacity: busy || !who.trim() ? 0.6 : 1 }} onClick={send} disabled={busy || !who.trim()}>
          <Send size={14} /> {busy ? 'Sending…' : 'Send Test'}
        </button>
      </div>
      <div style={hint}>
        Builds this manager's real scorecard for the last full week and sends it to {testRecipients.length ? testRecipients.join(', ') : 'you'}, whatever
        the mode or day. The manager must already hold the grant. Nothing is logged and nobody else is emailed.
      </div>
      {result && <div role="status" style={{ fontSize: 12.5, marginTop: 8, fontWeight: 600, color: result.ok ? NX.green : NX.red }}>{result.text}</div>}
    </div>
  );
}

function Recipients() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.getWorkforceScorecardRecipients().then((r) => setRows(r.rows || [])).catch((e) => { setErr(e.message || String(e)); setRows([]); }); }, []);
  if (rows === null) return <LoadingState compact />;
  return (
    <div>
      <div style={{ fontSize: 12.5, color: NX.faint, marginBottom: 10 }}>
        Who the next send goes to, and what each one covers. Change it by granting or removing Workforce Scorecard on a job role or access group, or with the company-wide list in Settings.
      </div>
      {err && <div style={{ fontSize: 12.5, color: NX.red, marginBottom: 8 }}>{err}</div>}
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>Nobody holds the Workforce Scorecard grant yet.</div>
      ) : (
        <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
          {rows.map((r) => (
            <div key={r.email} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, minWidth: 140 }}>{r.name}</span>
              <span style={{ flex: 1, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
              <span style={{ color: r.scope === 'all' ? NX.blue : NX.dim, fontWeight: 600 }}>
                {r.scope === 'all' ? 'Whole company'
                  : `${r.scope === 'line' ? 'Whole reporting line' : 'Direct reports'} (${r.peopleInScope} ${r.peopleInScope === 1 ? 'person' : 'people'})`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusOf(row) {
  if (row.sentAt) return { label: 'Sent', color: NX.green, Icon: CheckCircle2 };
  if (row.mode === 'off') return { label: 'Off (Scan Only)', color: NX.faint, Icon: MinusCircle };
  if (!row.peopleCount) return { label: 'Nobody to Score', color: NX.faint, Icon: MinusCircle };
  return { label: 'Send Failed', color: NX.red, Icon: XCircle };
}

const LOG_LIMIT = 25;
const SCOPE_WORD = { direct: 'direct reports', line: 'reporting line', all: 'company' };

function DeliveryLog() {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [emailFilter, setEmailFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [resendingId, setResendingId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let live = true;
    api.getWorkforceScorecardLog({ ...(emailFilter ? { manager_email: emailFilter.trim() } : {}), limit: LOG_LIMIT, offset })
      .then(({ rows: r, total: t }) => { if (live) { setRows(r); setTotal(t); } })
      .catch((e) => { if (live) { setErr(e.message || String(e)); setRows([]); setTotal(0); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, reloadKey]);

  const resend = async (row) => {
    const ok = await dialog.confirm(
      `Send ${row.managerEmail}'s scorecard for the week of ${formatDate(row.weekStart)} right now?` +
      (row.sentAt ? ' It already went out, so they will get a second email.' : '') + ' Nobody else is affected.',
      { title: 'Force Resend', confirmText: 'Send Now' },
    );
    if (!ok) return;
    setResendingId(row.id); setNote(''); setErr('');
    try {
      const res = await api.forceResendWorkforceScorecard(row.id);
      if (res.sentNow) setNote(`Sent ${row.managerEmail}'s scorecard.`);
      else if (res.reason) setNote(res.reason);
      else if (res.mode === 'off') setNote('Cleared, but Mode is Off - nothing was sent. Switch to Test or Live first.');
      else if (!res.hadContent) setNote(`${row.managerEmail} has nobody on their scorecard - no email needed.`);
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
        <input value={emailFilter} onChange={(e) => setEmailFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setOffset(0); load(); } }}
          placeholder="Filter by manager email…" style={{ ...inputStyle, width: 260, maxWidth: '100%' }} />
        <button style={btn('ghost')} onClick={() => { setOffset(0); load(); }} title="Refresh" aria-label="Refresh"><RefreshCw size={14} /></button>
        {err && <span style={{ fontSize: 12.5, color: NX.red }}>{err}</span>}
        {note && <span role="status" style={{ fontSize: 12.5, color: NX.green, fontWeight: 600 }}>{note}</span>}
      </div>
      {rows === null ? <LoadingState compact /> : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: NX.faint, padding: 16, textAlign: 'center' }}>No scorecard sends logged yet.</div>
      ) : (
        <>
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflow: 'hidden' }}>
            {rows.map((r) => {
              const meta = statusOf(r);
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5, flexWrap: 'wrap' }}>
                  <meta.Icon size={14} style={{ color: meta.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.managerEmail}>{r.managerEmail}</span>
                  <span style={{ color: NX.dim, flexShrink: 0 }} title="Week starting">{formatDate(r.weekStart)}</span>
                  <span style={{ color: NX.faint, flexShrink: 0, width: 50, textTransform: 'capitalize' }}>{r.mode}</span>
                  <span style={{ color: NX.faint, flexShrink: 0 }}>{SCOPE_WORD[r.scope] || 'direct reports'} - {r.peopleCount} people, {r.absentCount} absent, {r.belowCount} below</span>
                  <span style={{ color: meta.color, fontWeight: 600, flexShrink: 0, width: 120 }}>{meta.label}</span>
                  <button onClick={() => resend(r)} disabled={resendingId === r.id} title="Sends this manager's scorecard right now"
                    style={{ ...btn('ghost'), flexShrink: 0, fontSize: 11.5, padding: '4px 8px', opacity: resendingId === r.id ? 0.5 : 1 }}>
                    {resendingId === r.id ? 'Sending…' : 'Force Resend'}
                  </button>
                </div>
              );
            })}
          </div>
          {total > LOG_LIMIT && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 14 }}>
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LOG_LIMIT))} style={{ ...btn('ghost'), opacity: offset === 0 ? 0.4 : 1 }}>← Prev</button>
              <span style={{ fontSize: 12, color: NX.faint }}>Page {currentPage} of {totalPages}</span>
              <button disabled={offset + LOG_LIMIT >= total} onClick={() => setOffset(offset + LOG_LIMIT)} style={{ ...btn('ghost'), opacity: offset + LOG_LIMIT >= total ? 0.4 : 1 }}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
