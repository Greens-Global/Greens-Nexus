// Workday > Workplace Notices (Neil, Oct 21 2026: "a single click and access
// all of their work-related notices"). Each person sees their manual and
// policies (and acknowledges them), the labor law notices for where they
// work, and every notice that was given to them. The rules are the server's
// (backend/notices.py); this screen only shows them.
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle, FileText, MapPin } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { Chip, NoticePdfModal, areaLabel, day } from './lib';

const CARD = { background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, boxShadow: 'var(--wk-shadow)' };
const HD = { fontSize: 14, fontWeight: 700, color: 'var(--ink)' };
const ROW = { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--wk-line2)', flexWrap: 'wrap' };
const AREA_ORDER = (a) => (a === 'US' ? 0 : a === 'IN' ? 9 : a.includes(':') ? 2 : 1);
const REASON = { hire: 'Given at hire', annual: 'Yearly notice', separation: 'Given at separation', new_version: 'New version', manual: 'Sent by HR', acknowledge: 'You acknowledged it' };

export default function WorkplaceNotices({ toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [viewing, setViewing] = useState(null);
  const [signing, setSigning] = useState(null);
  const load = useCallback(() => {
    setErr('');
    api.myNotices().then(setData).catch(e => setErr(e?.message || 'Could not load your notices.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <SkeletonBlocks count={3} height={90} />;
  if (!data.context) {
    return <div style={{ ...CARD, fontSize: 13, color: 'var(--muted)' }}>Your People record is not set up yet, so there are no notices to show. Ask HR.</div>;
  }
  const open = (v, title) => setViewing({ id: v.id, title, lang: (v.langs || []).includes('es') && navigator.language?.startsWith('es') ? 'es' : 'en' });
  const owed = data.documents.filter(d => d.ack.required && !d.ack.done);
  const groups = {};
  data.posted.forEach(n => { (groups[n.area] = groups[n.area] || []).push(n); });
  const areas = Object.keys(groups).sort((a, b) => AREA_ORDER(a) - AREA_ORDER(b));
  const ctx = data.context;
  const where = ctx.country === 'IN' ? 'India' : ctx.state
    ? [ctx.cities.length ? ctx.cities.map(c => c.toLowerCase().replace(/\b\w/g, x => x.toUpperCase())).join(', ') : '', areaLabel(`US-${ctx.state}`)].filter(Boolean).join(', ')
    : '';

  return (
    <div>
      {owed.length > 0 && (
        <div style={{ ...CARD, borderColor: '#f59e0b', background: 'rgba(245,158,11,0.06)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <AlertTriangle size={16} style={{ color: '#b45309' }} /><span style={HD}>Needs Your Attention</span>
          </div>
          {owed.map(d => (
            <div key={d.id} style={ROW}>
              <span style={{ flex: '1 1 240px', fontSize: 13.5 }}>
                <b>{d.title}</b>{d.live && ` - ${d.live.label}`}
                <span style={{ display: 'block', fontSize: 12.5, color: d.ack.overdue ? '#b91c1c' : 'var(--muted)' }}>
                  {d.ack.reason === 'yearly' ? 'Yearly acknowledgment. ' : ''}{d.ack.overdue ? 'Overdue since' : 'Please acknowledge by'} {day(d.ack.due)}
                  {d.live?.summary && d.ack.reason !== 'first' ? ` - What changed: ${d.live.summary}` : ''}
                </span>
              </span>
              <button className="secondary-btn" onClick={() => open(d.live, d.title)} style={{ fontSize: 12.5 }}><FileText size={13} /> Read</button>
              <button className="primary-btn" onClick={() => setSigning(d)} style={{ fontSize: 12.5 }}>Acknowledge</button>
            </div>
          ))}
        </div>
      )}

      {ctx.country === 'US' && ctx.state === 'CA' && <EmergencyCard toastOk={toastOk} toastErr={toastErr} />}

      <div style={CARD}>
        <div style={{ ...HD, marginBottom: 4 }}>{ctx.country === 'IN' ? 'Code of Conduct And Policies' : 'Employee Manual And Policies'}</div>
        {!data.documents.length && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing here yet.</div>}
        {data.documents.map(d => (
          <div key={d.id} style={ROW}>
            {d.kind === 'closures' ? <CalendarDays size={15} style={{ color: 'var(--muted)' }} /> : <FileText size={15} style={{ color: 'var(--muted)' }} />}
            <span style={{ flex: '1 1 240px', fontSize: 13.5 }}>
              <b>{d.title}</b>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)' }}>
                {d.kind === 'closures' ? 'Days the office is closed and no work is requested.'
                  : !d.live ? 'Coming soon - HR is preparing this document.'
                  : `${d.live.label}, in effect since ${day(d.live.effectiveDate)}`}
              </span>
            </span>
            {d.ack.done && <Chip spec={{ label: `Acknowledged ${day(d.ack.ackedAt)}`, bg: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' }} />}
            {d.live && <button className="secondary-btn" onClick={() => open(d.live, d.title)} style={{ fontSize: 12.5 }}>Open</button>}
            {d.kind === 'closures' && <ClosureList />}
          </div>
        ))}
      </div>

      {ctx.country === 'US' && (
        <div style={CARD}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={HD}>Your Workplace Notices</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <MapPin size={12} />{where ? `You work in ${where}` : 'Your work state is not set yet - you see the federal notices. HR has been told.'}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>
            The required labor law notices for where you work. Paper copies are also posted at your work site.
          </div>
          {areas.map(a => (
            <div key={a} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{areaLabel(a)}</div>
              {groups[a].map(n => (
                <div key={n.id} style={{ ...ROW, padding: '8px 0' }}>
                  <span style={{ flex: '1 1 240px', fontSize: 13.5 }}>{n.title}
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 6 }}>{n.formCode}</span></span>
                  {n.live ? <button className="secondary-btn" onClick={() => open(n.live, n.title)} style={{ fontSize: 12 }}>Open</button>
                    : <span style={{ fontSize: 12, color: 'var(--muted)' }}>Posted at your site</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {data.received.length > 0 && (
        <div style={CARD}>
          <div style={{ ...HD, marginBottom: 4 }}>Given To You</div>
          {data.received.map(r => (
            <div key={r.id} style={{ ...ROW, padding: '8px 0' }}>
              <span style={{ flex: '1 1 240px', fontSize: 13.5 }}>{r.title}{r.versionLabel ? ` - ${r.versionLabel}` : ''}
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                  {REASON[r.reason] || 'Given to you'} {formatDateTime(r.sentAt)}{r.channel === 'email' ? ' by email' : ''}
                  {r.viewedAt ? ` - opened ${formatDateTime(r.viewedAt)}` : ''}
                </span></span>
              <button className="secondary-btn" onClick={() => open({ id: r.versionId, langs: [] }, r.title)} style={{ fontSize: 12 }}>Open</button>
            </div>
          ))}
        </div>
      )}

      {viewing && <NoticePdfModal versionId={viewing.id} lang={viewing.lang} title={viewing.title}
        onOpened={() => api.recordNoticeView(viewing.id).catch(() => {})} onClose={() => setViewing(null)} toastErr={toastErr} />}
      {signing && <AckModal doc={signing} name={data.name} onClose={() => setSigning(null)}
        onDone={() => { setSigning(null); toastOk?.('Acknowledged. Thank you.'); load(); }} toastErr={toastErr} />}
    </div>
  );
}

// California Labor Code 1555 (SB 294): name someone to be told if you are
// arrested or detained at work. Optional - the card stays folded once answered.
function EmergencyCard({ toastOk, toastErr }) {
  const [s, setS] = useState(null);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.myEmergencyContact().then(setS).catch(() => setS({ applies: false })); }, []);
  if (!s?.applies) return null;
  const open = !s.answered || edit;
  const form = f || { choice: s.choice || (s.profile.name ? 'profile' : 'other'), name: s.name, phone: s.phone, relationship: s.relationship,
    worksite: s.answered ? s.worksite : true, offsite: s.answered ? s.offsite : true };
  const set = (k, v) => setF({ ...form, [k]: v });
  const save = (body) => {
    setBusy(true);
    api.setMyEmergencyContact(body).then(r => { setS(r); setEdit(false); setF(null); toastOk?.('Saved.'); })
      .catch(e => toastErr?.(e?.message || 'Could not save it.')).finally(() => setBusy(false));
  };
  const summary = !s.answered ? '' : s.choice === 'decline' ? 'You chose not to name anyone.'
    : `${s.choice === 'profile' ? s.profile.name : s.name} will be told${s.worksite ? ' if you are arrested or detained at work' : ''}${s.worksite && s.offsite ? ' or' : ''}${s.offsite ? ' during work hours away from the work site' : ''}.`;
  return (
    <div style={{ ...CARD, ...(open && !s.answered ? { borderColor: '#f59e0b' } : {}) }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={HD}>Emergency Contact If You Are Arrested Or Detained At Work</span>
        <span style={{ flex: 1 }} />
        {s.answered && !edit && <button className="secondary-btn" onClick={() => setEdit(true)} style={{ fontSize: 12 }}>Change</button>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 8px' }}>
        California law lets you name someone Greens will contact if immigration or other authorities arrest or detain you. This is optional and you can change it at any time.
      </div>
      {!open ? <div style={{ fontSize: 13 }}>{summary} <span style={{ color: 'var(--muted)' }}>Saved {day(s.answeredAt)}.</span></div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          {s.profile.name && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="radio" name="sb294-choice" checked={form.choice === 'profile'} onChange={() => set('choice', 'profile')} />
              My emergency contact on my profile: {s.profile.name}{s.profile.phone ? ` (${s.profile.phone})` : ''}</label>
          )}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="radio" name="sb294-choice" checked={form.choice === 'other'} onChange={() => set('choice', 'other')} /> Someone else</label>
          {form.choice === 'other' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
              <input id="sb294-name" aria-label="Their name" className="form-input" placeholder="Their name" value={form.name} onChange={e => set('name', e.target.value)} />
              <input id="sb294-phone" aria-label="Their phone" className="form-input" placeholder="Phone" value={form.phone} onChange={e => set('phone', e.target.value)} />
              <input id="sb294-rel" aria-label="Relationship" className="form-input" placeholder="Relationship" value={form.relationship} onChange={e => set('relationship', e.target.value)} />
            </div>
          )}
          {form.choice !== 'decline' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4 }}>
              <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={form.worksite} onChange={e => set('worksite', e.target.checked)} /> Tell them if I am arrested or detained at my work site</label>
              <label style={{ display: 'flex', gap: 8 }}><input type="checkbox" checked={form.offsite} onChange={e => set('offsite', e.target.checked)} /> Tell them if it happens during work hours away from the work site (when Greens knows of it)</label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary-btn" disabled={busy || form.choice === 'decline'} onClick={() => save(form)} style={{ fontSize: 12.5 }}>Save</button>
            <button className="secondary-btn" disabled={busy} onClick={() => save({ choice: 'decline' })} style={{ fontSize: 12.5 }}>No Thanks</button>
            {edit && <button className="secondary-btn" onClick={() => { setEdit(false); setF(null); }} style={{ fontSize: 12.5 }}>Cancel</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function ClosureList() {
  const [days, setDays] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && days === null) api.myClosures().then(d => setDays(d.days || [])).catch(() => setDays([])); }, [open, days]);
  return (
    <div style={{ flexBasis: '100%' }}>
      <button className="secondary-btn" onClick={() => setOpen(o => !o)} style={{ fontSize: 12 }}>{open ? 'Hide Days' : 'Show Days'}</button>
      {open && (days === null ? <SkeletonBlocks count={1} height={40} />
        : !days.length ? <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>No closures on the calendar yet.</div>
        : <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>{days.map(x => <li key={x.date}>{day(x.date)} - {x.name}</li>)}</ul>)}
    </div>
  );
}

// "I received and read it": the typed full name, the exact version. Wording
// for counsel to confirm (plan: at will, not a contract).
function AckModal({ doc, name, onClose, onDone, toastErr }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const manual = doc.kind === 'manual' || doc.kind === 'addendum';
  const go = () => {
    setBusy(true);
    api.acknowledgeNotice(doc.id, { version_id: doc.live.id, typed_name: typed })
      .then(onDone).catch(e => toastErr?.(e?.message || 'Could not save it.')).finally(() => setBusy(false));
  };
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label={`Acknowledge ${doc.title}`} className="nx-popup"
        style={{ background: 'var(--card)', borderRadius: 16, width: 'min(60vw, 100%)', minWidth: 'min(420px, 100%)', minHeight: '60vh', maxHeight: '85vh', overflow: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>Acknowledge {doc.title}</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          I confirm that I have received and read <b>{doc.title}</b> ({doc.live.label}, in effect {day(doc.live.effectiveDate)}), and that I will follow it.
          {manual && ' I understand that it is not a contract of employment, that my employment is at will, and that Greens may change these policies.'}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ fontWeight: 700 }}>Type your full name to sign</span>
          <input id="notice-ack-name" className="form-input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoFocus />
        </label>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>We keep the date, time and the exact file you acknowledged.</div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={go} disabled={busy || typed.trim().length < 3}><CheckCircle size={14} /> Acknowledge</button>
        </div>
      </div>
    </div>
  );
}
