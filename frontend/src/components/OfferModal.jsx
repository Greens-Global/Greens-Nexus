// Make An Offer (Neil and Charmi, Oct 14; one screen since the Hiring Setup,
// Oct 23). Move To Offer opens this:
//
//   "You can't send an offer without answering these questions. Who has to
//   answer those? HR has to." ... "Pranshu is going to let you fill in
//   everything and the document will make itself."
//
// Left: Hired As (one pick - Full-Time / Part-Time Employee, Contractor or
// Intern - sets both worker_type and employment_type; never guessed: the same
// role can be either), the role, where they work, dates, supervisor, pay, and
// only what the documents print or ask HR. Right: What They Get, live from
// the server's resolver (offer/options whatTheyGet) - the offer letter, the
// hiring packet that follows, the role's duties for this kind of hire and
// who signs. A missing piece is amber with Set It Up / Add Duties (the Hiring
// Setup opens over the offer, the form keeps its values) and Send stays off
// until it is fixed. There is no Job Description pick: the server works out
// the duties from role + Hired As + place + company and freezes them.
// The verifier still checks the filled-in letter (PacketReview) before it
// goes; the candidate signs with no Nexus login.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { X, FileSignature, AlertTriangle, Info, Eye } from 'lucide-react';
import { api } from '../api';
import { currencyOptions } from '../asset/lib/currency';
import { usePeopleDirectory } from '../lib/queries';
import { Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { DateField } from '../tasks/components';
import { US_STATE_NAMES } from '../lib/usStates';
import { leadsFor } from './HiringSchedule';

// Lazy: HiringPacket imports REPORTS_TO from here, and the setup is only opened to fix something.
const PacketsModal = lazy(() => import('./HiringPacket').then(m => ({ default: m.PacketsModal })));
const SamplePreview = lazy(() => import('./DocumentsPacketEditor').then(m => ({ default: m.PreviewModal })));

const OTHER_ROLE = '__other__';
const HIRED_AS = [['full_time', 'Full-Time Employee'], ['part_time', 'Part-Time Employee'], ['contractor', 'Contractor'], ['intern', 'Intern']];
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const COUNTRY_NAMES = { US: 'United States', IN: 'India', CA: 'Canada', GB: 'United Kingdom', AE: 'United Arab Emirates', PH: 'Philippines', MX: 'Mexico', AU: 'Australia' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const SCHEDULE = ['work_schedule', 'work_hours', 'work_days'];
const FIX_LABEL = { setUp: 'Set It Up', addDuties: 'Add Duties' };

const lbl = { fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '0 0 6px' };
const hint = { fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.55 };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 };
export const REPORTS_TO = 'Reports To - the person this hire reports to day to day. They become the manager on the profile.';
const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-blue))', textDecoration: 'underline', fontFamily: 'Inter,sans-serif' };
const pill = (on) => ({ minHeight: 38, padding: '0 13px', borderRadius: 999, font: '700 13px Inter,sans-serif', cursor: 'pointer',
  border: `1px solid ${on ? 'var(--ink)' : 'var(--line)'}`, background: on ? 'var(--ink)' : 'var(--card)', color: on ? 'var(--card)' : 'var(--ink)' });

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginTop: 10 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{children}</span>
    </div>
  );
}

const isoDay = (d) => d.toISOString().slice(0, 10);

/** The What They Get lines (offer, promotion and offboarding options): a
 *  blocking line is amber, a fix opens the Hiring Setup on it. */
export function WhatTheyGetCard({ lines, blocked = '', onFix, notes = {} }) {
  return (
    <>
      {(lines || []).map(g => {
        const bad = !!g.blocks;
        const soft = !bad && g.tone === 'missing';
        return (
          <div key={g.key} data-line={g.key} style={{ background: bad ? '#fffbeb' : 'var(--card)', border: `1px solid ${bad ? '#f59e0b' : 'var(--line)'}`, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{g.label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, marginTop: 3, color: bad ? '#92400e' : 'var(--ink)' }}>{g.name}</div>
            {g.sourceLabel && <div style={{ fontSize: 12, marginTop: 2, fontWeight: g.tone === 'same' ? 400 : 700, color: bad ? '#b45309' : soft ? 'var(--muted)' : g.tone === 'own' ? '#1d4ed8' : 'var(--muted)' }}>{g.sourceLabel}</div>}
            {g.fix && FIX_LABEL[g.fix.action] && onFix && (
              <button type="button" onClick={() => onFix(g)}
                style={{ display: 'inline-flex', alignItems: 'center', minHeight: 34, marginTop: 8, padding: '0 12px', borderRadius: 8, background: '#fff', border: '1px solid #d97706', color: '#92400e', font: '700 12.5px Inter,sans-serif', cursor: 'pointer' }}>
                {FIX_LABEL[g.fix.action]}
              </button>
            )}
            {notes[g.key]}
          </div>
        );
      })}
      {blocked && (lines || []).some(g => g.blocks) && <div role="alert" style={{ fontSize: 12.5, color: '#b45309', fontWeight: 600 }}>{blocked}</div>}
    </>
  );
}

/** The documents' own HR Answers questions, as form fields - pay ones are
 *  locked for anyone without Pay & Benefits. */
export function HrQuestionFields({ questions, answers, setAnswers, canSeePay, idPrefix = 'of-q' }) {
  return (questions || []).map(q => {
    const locked = q.pay && !canSeePay;
    const id = `${idPrefix}-${q.token}`;
    return (
      <div key={q.token}>
        <label style={lbl} htmlFor={id}>{q.label}{q.required ? ' *' : ''}</label>
        {q.type === 'choice' && q.options?.length ? (
          <select id={id} className="form-input" style={{ width: '100%' }} disabled={locked} value={answers[q.token] || ''} onChange={e => setAnswers(a => ({ ...a, [q.token]: e.target.value }))}>
            <option value="">-</option>{q.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : q.type === 'date' ? (
          <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={answers[q.token] || ''} onChange={x => setAnswers(a => ({ ...a, [q.token]: x || '' }))} placeholder="MM/DD/YYYY" title={q.label} style={{ width: '100%' }} />
          </div>
        ) : (
          <input id={id} className="form-input" style={{ width: '100%' }} disabled={locked}
            value={answers[q.token] || ''} placeholder={locked ? 'Pay & Benefits enters it at review' : q.default || ''}
            onChange={e => setAnswers(a => ({ ...a, [q.token]: e.target.value }))} />
        )}
        {(q.help || q.pay) && <div style={hint}>{q.help}{q.pay ? `${q.help ? ' ' : ''}Pay - Pay & Benefits only.` : ''}</div>}
      </div>
    );
  });
}

/** Typed answers split into the merge (everyone) and pay_values (Pay & Benefits only). */
export function splitAnswers(questions, answers, canSeePay) {
  const pick = (qs) => Object.fromEntries(qs.map(q => [q.token, String(answers[q.token] || '').trim()]).filter(([, v]) => v));
  const pay = canSeePay ? pick((questions || []).filter(q => q.pay)) : {};
  return { merge: pick((questions || []).filter(q => !q.pay)), payValues: Object.keys(pay).length ? pay : null };
}

/** The questions still to answer before the letter can be made. */
export const unanswered = (questions, answers, canSeePay) =>
  (questions || []).filter(q => q.required && !(q.pay && !canSeePay) && !String(answers[q.token] || '').trim());

export default function OfferModal({ candidate: c, canSeePay, onClose, onStarted, onMoveWithout, toastErr, toastOk }) {
  const { data: people = [] } = usePeopleDirectory();
  const getsTitle = c.firstName ? `What ${c.firstName} Gets` : 'What They Get';
  const [tried, setTried] = useState(false);
  // Where they work picks the paperwork - country AND state (Neil, Oct 22).
  const [who, setWho] = useState({ hired_as: '', country: '', region: '' });
  const [placeOpen, setPlaceOpen] = useState(false);
  const [f, setF] = useState(() => {
    const start = (c.expectedStart || '').slice(0, 10);
    const week = isoDay(new Date(Date.now() + 7 * 86400000));
    return {
      role_id: c.roleId || (c.roleTitle ? OTHER_ROLE : ''), new_role_name: c.roleId ? '' : (c.roleTitle || ''),
      department: c.department || '', start_date: start,
      // A week is the usual window, or the start date if that comes first - still HR's call.
      offer_expires: start && start < week && start >= isoDay(new Date()) ? start : week,
      manager_email: '', work_location: '',
      offer_from: 'hr',          // Offer Comes From (Neil, Oct 22): Head of HR, or the department head
    };
  });
  const [person, setPerson] = useState({ first_name: c.firstName || '', last_name: c.lastName || '', address: '' });
  const [timing, setTiming] = useState({ work_start: '09:00', work_end: '17:00', work_days: ['mon', 'tue', 'wed', 'thu', 'fri'], timings_text: '' });
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [answers, setAnswers] = useState({});          // the documents' own HR Answers questions
  const [roles, setRoles] = useState({ roles: [], departments: [], leads: {} });
  const [opts, setOpts] = useState(null);              // which letter + packet, what they ask, what the hire gets
  const [chosenId, setChosenId] = useState('');         // HR picked another offer letter by hand
  const [loading, setLoading] = useState(false);
  const [optsErr, setOptsErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [fix, setFix] = useState(null);                 // the Hiring Setup opened over the offer
  const [reload, setReload] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [sample, setSample] = useState(null);           // the letter's document shown in-app (a popup can be blocked after awaits)
  const autoMgr = useRef('');                          // the supervisor Nexus filled in, not HR

  useEffect(() => {
    if (!c.company) return;
    api.hiringOptions(c.company).then(o => {
      setRoles({ roles: o.roles || [], departments: o.departments || [], leads: o.departmentLeads || {} });
      const r = (o.roles || []).find(x => x.id === c.roleId);
      const d = r ? r.defaultManagerEmail : leadsFor(o.departmentLeads, c.roleId ? '' : c.department)[0];
      autoMgr.current = d || '';
      if (d) setF(p => (p.manager_email ? p : { ...p, manager_email: d }));
    }).catch(() => {});
  }, [c.company, c.roleId]);

  const isOther = f.role_id === OTHER_ROLE;
  const roleId = isOther ? '' : f.role_id;
  const contractor = who.hired_as === 'contractor';
  const workerType = !who.hired_as ? '' : contractor ? 'contractor' : 'employee';
  // What they get - re-read whenever HR changes how they are hired, the role or where.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.offerOptions(c.id, { hired_as: who.hired_as, worker_type: workerType, country: who.country, region: who.region, role_id: roleId, packet_id: chosenId,
                             new_role: isOther ? '1' : '', department: isOther ? f.department : '' })
      .then(o => {
        if (!alive) return;
        setOpts(o); setOptsErr('');
        setWho(w => (w.country ? (w.region || w.country !== o.country ? w : { ...w, region: o.region || '' })
          : { ...w, country: o.country || '', region: o.region || '' }));
      })
      .catch(e => { if (alive) { setOpts(null); setOptsErr(e?.message || 'Could not find the offer letter.'); toastErr?.(e?.message || 'Could not find the offer letter.'); } })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [c.id, who.hired_as, who.country, who.region, roleId, chosenId, isOther, f.department, reload]);   // eslint-disable-line react-hooks/exhaustive-deps

  const letter = opts?.offerLetter || null;
  const packet = opts?.hiringPacket || null;
  const gets = who.hired_as ? (opts?.whatTheyGet || []) : [];
  const blocked = gets.some(g => g.blocks);
  const prints = new Set([...(letter?.prints || []), ...(packet?.prints || [])]);
  const questions = useMemo(() => {
    const seen = new Set();
    return [...(letter?.hrQuestions || []), ...(packet?.hrQuestions || [])].filter(q => !seen.has(q.token) && seen.add(q.token));
  }, [letter, packet]);
  const manager = people.find(p => p.email === f.manager_email);
  const from = opts?.offerFrom || {};
  // A role whose department has no head: back to Head of HR, never a refused send.
  useEffect(() => { if (opts && !opts.offerFrom?.department_head?.email) setF(p => (p.offer_from === 'hr' ? p : { ...p, offer_from: 'hr' })); }, [opts]);
  const countries = useMemo(() => [...new Set([opts?.companyCountry, 'US', 'IN', who.country].filter(Boolean))], [opts, who.country]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  // Supervisor = the role's default, else the department head (Neil, Oct 22). One Nexus
  // filled in follows a role or department change; one HR picked by hand is kept.
  const withMgr = (next, email) => {
    const keep = f.manager_email && f.manager_email !== autoMgr.current;
    autoMgr.current = email || '';
    return keep ? next : { ...next, manager_email: email || '' };
  };
  const pickRole = (id) => {
    const r = roles.roles.find(x => x.id === id);
    const department = r ? (r.department || f.department) : f.department;
    setF(withMgr({ ...f, role_id: id, department }, r ? r.defaultManagerEmail : id === OTHER_ROLE ? leadsFor(roles.leads, department)[0] : ''));
  };
  const pickDept = (d) => setF(withMgr({ ...f, department: d }, leadsFor(roles.leads, d)[0]));

  // What still needs doing - shown only once Send is pressed.
  const problems = [
    !who.hired_as && 'Choose how they are hired.',
    (!f.role_id || (isOther && (!f.new_role_name.trim() || !f.department))) && 'Pick the role.',
    who.country === 'US' && !who.region && 'Pick the state they work in.',
    // Never an offer with nothing after it (Neil, Oct 22): the hire would sign and then wait.
    who.hired_as && !loading && !blocked && opts?.missingPacket && 'Set up the hiring packet for this place first.',
    who.hired_as && !loading && !blocked && !letter && 'There is no offer letter for this hire yet - set one up, pick another under More Options, or move them to Offer without one.',
    (!person.first_name.trim() || !person.last_name.trim()) && 'Enter their legal first and last name.',
    !f.start_date && 'Pick the start date.',
    !f.offer_expires && 'Pick when the offer expires.',
    f.offer_expires && f.start_date && f.offer_expires > f.start_date && 'The offer has to expire on or before the start date.',
    ...unanswered(questions, answers, canSeePay).map(q => `Answer ${q.label}.`),
  ].filter(Boolean);

  async function send() {
    if (problems.length) { setTried(true); return; }
    setBusy(true);
    try {
      const { merge: plain, payValues } = splitAnswers(questions, answers, canSeePay);
      const ev = await api.startOffer(c.id, {
        inputs: { ...f, hired_as: who.hired_as, worker_type: workerType, employment_type: contractor ? 'contractor' : who.hired_as,
                  country: who.country, region: who.region, role_id: roleId, new_role_name: isOther ? f.new_role_name.trim() : '',
                  ...(SCHEDULE.some(k => prints.has(k)) ? timing : {}),
                  packet_id: chosenId, merge: plain },
        pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
        pay_values: payValues,
        details: { first_name: person.first_name.trim(), last_name: person.last_name.trim(), ...(prints.has('address') ? { address: person.address.trim() } : {}) },
      });
      onStarted(ev);
    } catch (e) { toastErr?.(e?.message || 'Could not make the offer.'); setBusy(false); }
  }

  // Preview Offer Letter (mockup screen 4): the letter's document as it prints, with a SAMPLE person -
  // not this candidate's letter (no endpoint renders that before the offer starts). A PDF-engine letter
  // has no document, so the button is off.
  const canPreview = (letter?.documents || []).length > 0;
  async function previewLetter() {
    setPreviewing(true);
    try {
      const { settings = [] } = await api.getPackets();
      const tid = (settings.find(x => x.id === letter.id)?.docTemplateIds || []).find(t => !String(t).startsWith('@'));
      if (!tid) throw new Error('This offer letter has no document to preview.');
      setSample({ templateId: tid, name: letter.name || 'Offer Letter', settingId: letter.id });
    } catch (e) { toastErr?.(e?.message || 'Could not render the preview.'); }
    setPreviewing(false);
  }

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  const place = who.region ? `${US_STATE_NAMES[who.region] || who.region}, ${COUNTRY_NAMES[who.country] || who.country}` : (COUNTRY_NAMES[who.country] || who.country);
  const showPlace = placeOpen || !who.country || (who.country === 'US' && !who.region);
  const fromDocs = prints.has('address') || prints.has('work_location') || SCHEDULE.some(k => prints.has(k)) || questions.length > 0;

  const form = (
    <div style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={lbl}>Hired As</div>
        <div role="radiogroup" aria-label="Hired As" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {HIRED_AS.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={who.hired_as === k} style={pill(who.hired_as === k)}
              onClick={() => setWho(w => ({ ...w, hired_as: k }))}>{l}</button>
          ))}
        </div>
      </div>
      <div style={grid}>
        <div><label style={lbl} htmlFor="of-role">Role</label>
          <select id="of-role" className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)}>
            <option value="">- pick the role -</option>
            {roles.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
            {/* the role they applied for shows even before (or without) the role list */}
            {roleId && !roles.roles.some(r => r.id === roleId) && <option value={roleId}>{c.roleTitle || 'The role they applied for'}</option>}
            <option value={OTHER_ROLE}>Other (a new role)</option>
          </select></div>
        {isOther && (
          <>
            <div><label style={lbl} htmlFor="of-newrole">New Role Name</label>
              <input id="of-newrole" className="form-input" style={{ width: '100%' }} value={f.new_role_name} onChange={e => set('new_role_name', e.target.value)} /></div>
            <div><label style={lbl} htmlFor="of-dept">Department</label>
              <select id="of-dept" className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => pickDept(e.target.value)}>
                <option value="">- pick a department -</option>
                {roles.departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select></div>
          </>
        )}
      </div>
      <div style={{ fontSize: 13.5 }}>
        Works In <b>{place || 'Not set'}</b>
        {!showPlace && <button type="button" style={{ ...linkBtn, marginLeft: 8 }} onClick={() => setPlaceOpen(true)}>Change</button>}
        {showPlace && (
          <div style={{ ...grid, marginTop: 8 }}>
            <div><label style={lbl} htmlFor="of-country">Country</label>
              <select id="of-country" className="form-input" style={{ width: '100%' }} value={who.country} onChange={e => setWho(w => ({ ...w, country: e.target.value, region: '' }))}>
                {countries.map(k => <option key={k} value={k}>{COUNTRY_NAMES[k] || k}</option>)}
              </select></div>
            {who.country === 'US' && (
              <div><label style={lbl} htmlFor="of-region">State</label>
                <select id="of-region" className="form-input" style={{ width: '100%' }} value={who.region} onChange={e => setWho(w => ({ ...w, region: e.target.value }))}>
                  <option value="">- pick the state -</option>
                  {Object.entries(US_STATE_NAMES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select></div>
            )}
          </div>
        )}
      </div>
      <div style={grid}>
        <div><label style={lbl} htmlFor="of-first">Legal First Name</label>
          <input id="of-first" className="form-input" style={{ width: '100%' }} value={person.first_name} onChange={e => setPerson(p => ({ ...p, first_name: e.target.value }))} /></div>
        <div><label style={lbl} htmlFor="of-last">Legal Last Name</label>
          <input id="of-last" className="form-input" style={{ width: '100%' }} value={person.last_name} onChange={e => setPerson(p => ({ ...p, last_name: e.target.value }))} /></div>
        <div><div style={lbl}>Start Date</div>
          <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.start_date} onChange={x => set('start_date', x || '')} placeholder="MM/DD/YYYY" title="Start date" style={{ width: '100%' }} />
          </div></div>
        <div><div style={lbl}>Offer Expires</div>
          <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.offer_expires} onChange={x => set('offer_expires', x || '')} placeholder="MM/DD/YYYY" title="Offer expires" style={{ width: '100%' }} />
          </div></div>
      </div>
      <div>
        <div style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6 }} title={REPORTS_TO}>
          Supervisor <Info size={13} aria-label={REPORTS_TO} style={{ color: 'var(--muted)', cursor: 'help' }} />
        </div>
        {manager ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{manager.name || manager.email}</span>
            <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => set('manager_email', '')}>Change</button>
          </div>
        ) : <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]} onPick={v => set('manager_email', v)} />}
        <div style={hint}>{REPORTS_TO}</div>
      </div>

      <div>
        <div style={lbl}>{contractor ? 'Fee' : 'Pay'}</div>
        {canSeePay ? (
          <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            <input id="of-pay" className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={pay.base} onChange={e => setPay(p => ({ ...p, base: e.target.value }))} placeholder="0.00" aria-label={contractor ? 'Fee' : 'Pay'} />
            <select className="form-input" style={{ width: '100%' }} value={pay.payBasis} onChange={e => setPay(p => ({ ...p, payBasis: e.target.value }))} aria-label="Paid">
              <option value="salary">{contractor ? 'Fixed Fee' : 'Salary'}</option><option value="hourly">Hourly</option>
            </select>
            {pay.payBasis === 'salary' && (
              <select className="form-input" style={{ width: '100%' }} value={pay.frequency} onChange={e => setPay(p => ({ ...p, frequency: e.target.value }))} aria-label="Every">
                {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
            <select className="form-input" style={{ width: '100%' }} value={pay.currency} onChange={e => setPay(p => ({ ...p, currency: e.target.value }))} aria-label="Currency">
              {currencyOptions().map(x => <option key={x.code} value={x.code}>{x.label}</option>)}
            </select>
          </div>
        ) : <div style={{ ...hint, marginTop: 0 }}>Pay is added by someone with Pay &amp; Benefits access.</div>}
      </div>

      {fromDocs && (
        <div>
          <div style={{ ...lbl, color: 'var(--ink)', fontSize: 13.5 }}>From Your Documents</div>
          <div style={grid}>
            {prints.has('address') && (
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-addr">Their Address</label>
                <input id="of-addr" className="form-input" style={{ width: '100%' }} value={person.address} onChange={e => setPerson(p => ({ ...p, address: e.target.value }))} /></div>
            )}
            {prints.has('work_location') && (
              <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-loc">Primary Work Location</label>
                <input id="of-loc" className="form-input" style={{ width: '100%' }} value={f.work_location} onChange={e => set('work_location', e.target.value)} placeholder="e.g. Irvine, CA - or Remote" /></div>
            )}
            <HrQuestionFields questions={questions} answers={answers} setAnswers={setAnswers} canSeePay={canSeePay} />
          </div>
          {SCHEDULE.some(k => prints.has(k)) && (
            <div style={{ marginTop: 12 }}>
              <div style={lbl}>Work Hours And Days</div>
              <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                <input type="time" className="form-input" style={{ width: '100%' }} value={timing.work_start} aria-label="From" onChange={e => setTiming(t => ({ ...t, work_start: e.target.value }))} />
                <input type="time" className="form-input" style={{ width: '100%' }} value={timing.work_end} aria-label="To" onChange={e => setTiming(t => ({ ...t, work_end: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {DAYS.map(([k, l]) => {
                  const on = timing.work_days.includes(k);
                  return <button key={k} type="button" aria-pressed={on} onClick={() => setTiming(t => ({ ...t, work_days: on ? t.work_days.filter(x => x !== k) : [...t.work_days, k] }))}
                    style={{ padding: '5px 12px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                      background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <details style={{ fontSize: 13 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>More Options</summary>
        <div style={{ ...grid, marginTop: 10 }}>
          <div><label style={lbl} htmlFor="of-from">Offer Comes From</label>
            <select id="of-from" className="form-input" style={{ width: '100%' }} value={f.offer_from} onChange={e => set('offer_from', e.target.value)}>
              <option value="hr">Head of HR{from.hr?.name ? ` - ${from.hr.name}` : ''}</option>
              <option value="department_head" disabled={!from.department_head?.email}>
                Department Head{from.department_head?.name ? ` - ${from.department_head.name}` : ' - none set up'}
              </option>
            </select>
            <div style={hint}>
              {!from.department_head?.email
                ? `${from.department ? `The ${from.department} department` : 'This department'} has no head set up (Company Settings > Departments), so the offer comes from HR.`
                : 'The letter closes with their name and the offer email comes from them. It still says who they report to.'}
            </div></div>
          {(opts?.choices || []).length > 0 && (
            <div><label style={lbl} htmlFor="of-letter">Send A Different Offer Letter</label>
              <select id="of-letter" className="form-input" style={{ width: '100%' }} value={chosenId} onChange={e => setChosenId(e.target.value)}>
                <option value="">The one Nexus picks for this hire</option>
                {opts.choices.map(x => <option key={x.id} value={x.id}>{x.name}{x.workerType !== 'any' ? ` - ${x.workerType === 'contractor' ? 'Contractors' : 'Employees'}` : ''}{x.country ? ` (${COUNTRY_NAMES[x.country] || x.country})` : ''}</option>)}
              </select></div>
          )}
        </div>
      </details>
      {tried && problems.map(x => <Warn key={x}>{x}</Warn>)}
    </div>
  );

  // No offer letter: the way on without one sits under the Offer Letter line, not after Signs.
  const moveWithout = who.hired_as && !loading && !letter && onMoveWithout && opts ? (
    <div style={{ ...hint, marginTop: 6 }}>
      Or <button type="button" onClick={() => onMoveWithout(c)} style={{ ...linkBtn, fontWeight: 400 }}>move them to Offer without one</button>.
    </div>
  ) : null;
  const panel = (
    <div aria-label={getsTitle} style={{ flex: '1 1 320px', minWidth: 0, background: 'var(--mist)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{getsTitle}</div>
      {!who.hired_as ? <div style={{ ...hint, marginTop: 0 }}>Pick how they are hired to see the offer letter, the hiring packet and the job description they get.</div>
        : loading && !gets.length ? <Spinner size={16} />
          : !opts && optsErr ? <div role="alert" style={{ fontSize: 13, color: '#b45309', fontWeight: 600 }}>{optsErr}</div>
          : <WhatTheyGetCard lines={gets.map(g => (g.key === 'signs' && !g.name ? { ...g, name: 'Nothing to sign yet' } : g))}
            notes={moveWithout ? { offer: moveWithout } : {}} onFix={g => setFix({ entityId: g.fix.target?.entityId || c.company, ...(g.fix.target || {}) })} />}
      {moveWithout && !gets.some(g => g.key === 'offer') && moveWithout}
    </div>
  );

  return (
    <div onClick={e => e.target === e.currentTarget && !busy && !fix && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label="Make An Offer" style={{ background: 'var(--card)', borderRadius: 18, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 85vh)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '18px 24px 12px', flexShrink: 0, borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileSignature size={18} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Make An Offer - {name}</div>
            {c.roleTitle && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{c.roleTitle}</div>}
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '18px 24px 22px', display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          {form}
          {panel}
        </div>

        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, fontSize: 12.5, color: '#b45309', fontWeight: 600 }}>{blocked ? (opts?.blocked || 'Fix the amber item before sending.') : ''}</span>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="secondary-btn" onClick={previewLetter} disabled={busy || previewing || !canPreview} title="The letter as it prints, filled in with a sample person"
            style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {previewing ? <Spinner size={14} /> : <Eye size={14} />} Preview Offer Letter
          </button>
          <button type="button" className="primary-btn" onClick={send} disabled={busy || blocked || (loading && !!who.hired_as)} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : <FileSignature size={14} />} Send Offer Letter
          </button>
        </div>
      </div>
      {sample && (
        <Suspense fallback={null}>
          <SamplePreview {...sample} companyId={c.company || ''} toastErr={toastErr || (() => {})} onClose={() => setSample(null)} />
        </Suspense>
      )}
      {fix && (
        <Suspense fallback={null}>
          <PacketsModal initialCompanyId={c.company} focus={fix} toastOk={toastOk || (() => {})} toastErr={toastErr || (() => {})}
            onClose={() => { setFix(null); setReload(n => n + 1); }} />
        </Suspense>
      )}
    </div>
  );
}
