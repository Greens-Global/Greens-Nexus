// Make An Offer (Neil and Charmi, Oct 14). Move To Offer opens this:
//
//   "You can't send an offer without answering these questions. Who has to
//   answer those? HR has to." ... "Pranshu is going to let you fill in
//   everything and the document will make itself."
//
// HR answers once: who they are hiring (employee or contractor - the same role
// can be either, so it is never guessed) and where they work, the role, start,
// pay, and whatever the chosen letter itself asks of HR. Nexus picks the ONE
// offer letter for that kind of hire and fills it; the verifier checks it
// (PacketReview) and Verify And Send emails it - the candidate signs with no
// Nexus login. When both sides have signed they are hired, and the hiring
// packet that follows (shown here, so HR answers its questions now too)
// starts by itself.
import { useEffect, useMemo, useState } from 'react';
import { X, FileSignature, AlertTriangle, CheckCircle, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { currencyOptions } from '../asset/lib/currency';
import { usePeopleDirectory } from '../lib/queries';
import { Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';

const OTHER_ROLE = '__other__';
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const COUNTRY_NAMES = { US: 'United States', IN: 'India', CA: 'Canada', GB: 'United Kingdom', AE: 'United Arab Emirates', PH: 'Philippines', MX: 'Mexico', AU: 'Australia' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const SCHEDULE = ['work_schedule', 'work_hours', 'work_days'];

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '12px 0 4px', textTransform: 'uppercase', letterSpacing: '.04em' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 };
const sectionHead = { fontSize: 13.5, fontWeight: 800, margin: '18px 0 2px', display: 'flex', alignItems: 'center', gap: 8 };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' };
const stepDot = (on, done) => ({ width: 22, height: 22, borderRadius: 11, fontSize: 11.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: done ? 'hsl(var(--color-green))' : on ? 'var(--pine)' : 'var(--mist)', color: done || on ? '#fff' : 'var(--muted)' });

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 8 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{children}</span>
    </div>
  );
}

function Choice({ on, onClick, title, sub, label }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label || title} onClick={onClick}
      style={{ flex: '1 1 180px', textAlign: 'left', border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, borderRadius: 12, padding: '10px 14px', cursor: 'pointer',
        background: on ? 'hsla(var(--color-green),0.06)' : 'var(--card)', fontFamily: 'Inter,sans-serif', color: 'var(--ink)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </button>
  );
}

export default function OfferModal({ candidate: c, canSeePay, onClose, onStarted, onMoveWithout, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  const first = c.firstName || 'They';
  const [who, setWho] = useState({ worker_type: '', employment_type: 'full_time', country: '' });
  const [f, setF] = useState(() => ({
    role_id: c.roleId || (c.roleTitle ? OTHER_ROLE : ''), new_role_name: c.roleId ? '' : (c.roleTitle || ''),
    department: c.department || '', start_date: (c.expectedStart || '').slice(0, 10),
    // A week is the usual window - still HR's call.
    offer_expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    manager_email: '', work_location: '',
  }));
  const [person, setPerson] = useState({ first_name: c.firstName || '', last_name: c.lastName || '', address: '' });
  const [timing, setTiming] = useState({ work_start: '09:00', work_end: '17:00', work_days: ['mon', 'tue', 'wed', 'thu', 'fri'], timings_text: '' });
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [answers, setAnswers] = useState({});          // the documents' own HR Answers questions
  const [jdId, setJdId] = useState('');
  const [jds, setJds] = useState([]);
  const [roles, setRoles] = useState({ roles: [], departments: [] });
  const [opts, setOpts] = useState(null);              // which letter + packet, and what they ask
  const [chosenId, setChosenId] = useState('');         // HR picked another offer letter by hand
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!c.company) return;
    api.hiringOptions(c.company).then(o => {
      setRoles({ roles: o.roles || [], departments: o.departments || [] });
      const r = (o.roles || []).find(x => x.id === c.roleId);
      if (r?.defaultManagerEmail) setF(p => (p.manager_email ? p : { ...p, manager_email: r.defaultManagerEmail }));
    }).catch(() => {});
    api.getDocTemplates({ category: 'job_description', status: 'active' }).then(r => setJds(r || [])).catch(() => setJds([]));
  }, [c.company, c.roleId]);

  const isOther = f.role_id === OTHER_ROLE;
  const roleId = isOther ? '' : f.role_id;
  // Which letter - re-read whenever HR changes who they are hiring or where.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.offerOptions(c.id, { worker_type: who.worker_type, country: who.country, role_id: roleId, packet_id: chosenId,
                             new_role: isOther ? '1' : '', department: isOther ? f.department : '' })
      .then(o => { if (!alive) return; setOpts(o); setWho(w => (w.country ? w : { ...w, country: o.country || '' })); })
      .catch(e => { if (alive) { setOpts(null); toastErr?.(e?.message || 'Could not find the offer letter.'); } })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [c.id, who.worker_type, who.country, roleId, chosenId, isOther, f.department]);

  const letter = opts?.offerLetter || null;
  const packet = opts?.hiringPacket || null;
  const prints = new Set([...(letter?.prints || []), ...(packet?.prints || [])]);
  const questions = useMemo(() => {
    const seen = new Set();
    return [...(letter?.hrQuestions || []), ...(packet?.hrQuestions || [])].filter(q => !seen.has(q.token) && seen.add(q.token));
  }, [letter, packet]);
  const role = roles.roles.find(r => r.id === f.role_id);
  const manager = people.find(p => p.email === f.manager_email);
  const contractor = who.worker_type === 'contractor';
  const countries = useMemo(() => [...new Set([opts?.companyCountry, 'US', 'IN', who.country].filter(Boolean))], [opts, who.country]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const pickRole = (id) => {
    const r = roles.roles.find(x => x.id === id);
    setF(p => ({ ...p, role_id: id, department: r ? (r.department || p.department) : p.department,
                 manager_email: p.manager_email || r?.defaultManagerEmail || '' }));
  };

  const missing = [];
  if (!who.worker_type) missing.push('who you are hiring');
  if (!letter) missing.push('an offer letter for this hire');
  if (!f.role_id || (isOther && (!f.new_role_name.trim() || !f.department))) missing.push('the role');
  if (!f.start_date) missing.push('the start date');
  if (!f.offer_expires) missing.push('when the offer expires');
  if (!person.first_name.trim() || !person.last_name.trim()) missing.push('their legal name');
  questions.filter(q => q.required && !(q.pay && !canSeePay) && !String(answers[q.token] || '').trim()).forEach(q => missing.push(q.label));

  async function create() {
    setBusy(true);
    try {
      const plain = Object.fromEntries(questions.filter(q => !q.pay).map(q => [q.token, String(answers[q.token] || '').trim()]).filter(([, v]) => v));
      const payQs = canSeePay ? Object.fromEntries(questions.filter(q => q.pay).map(q => [q.token, String(answers[q.token] || '').trim()]).filter(([, v]) => v)) : {};
      const ev = await api.startOffer(c.id, {
        inputs: { ...f, ...who, role_id: roleId, new_role_name: isOther ? f.new_role_name.trim() : '',
                  ...(prints.has('work_schedule') || prints.has('work_hours') || prints.has('work_days') ? timing : {}),
                  jd_template_id: packet ? jdId : '', packet_id: chosenId, merge: plain },
        pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
        pay_values: Object.keys(payQs).length ? payQs : null,
        details: { first_name: person.first_name.trim(), last_name: person.last_name.trim(), ...(prints.has('address') ? { address: person.address.trim() } : {}) },
      });
      onStarted(ev);
    } catch (e) { toastErr?.(e?.message || 'Could not make the offer.'); setBusy(false); }
  }

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  const step = !who.worker_type ? 1 : 2;
  return (
    <div onClick={e => e.target === e.currentTarget && !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label="Make An Offer" style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', maxHeight: 'min(94dvh, 900px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <FileSignature size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>Make An Offer - {name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>Answer once - Nexus picks the right offer letter and fills it in. Nothing goes to {first} until it is verified.</div>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '10px 22px', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 700, flexWrap: 'wrap', flexShrink: 0 }}>
          {[['Who You Are Hiring', 1], ['The Offer', 2], ['Check And Send', 3]].map(([l, n], i) => (
            <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: step === n ? 'var(--ink)' : 'var(--muted)' }}>
              {i > 0 && <ArrowRight size={12} style={{ color: 'var(--muted)', marginRight: 4 }} />}
              <span style={stepDot(step === n, step > n)}>{step > n ? <CheckCircle size={12} /> : n}</span>{l}
            </span>
          ))}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 22px 18px' }}>
          <div style={sectionHead}>1. Who Are You Hiring?</div>
          <div style={hint}>The same role can be an employee or a contractor - it decides which offer letter goes, and a contractor's letter never says employment.</div>
          <div role="radiogroup" aria-label="Hired as" style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <Choice on={who.worker_type === 'employee'} onClick={() => setWho(w => ({ ...w, worker_type: 'employee', employment_type: w.employment_type === 'contractor' ? 'full_time' : w.employment_type }))}
              title="Employee" sub="On payroll - Full-Time, Part-Time or Intern" />
            <Choice on={contractor} onClick={() => setWho(w => ({ ...w, worker_type: 'contractor', employment_type: 'contractor' }))}
              title="Contractor" sub="An independent contractor - paid a fee" />
          </div>
          <div style={grid}>
            {who.worker_type === 'employee' && (
              <div><label style={lbl} htmlFor="of-et">Employment Type</label>
                <select id="of-et" className="form-input" style={{ width: '100%' }} value={who.employment_type} onChange={e => setWho(w => ({ ...w, employment_type: e.target.value }))}>
                  <option value="full_time">Full-Time</option><option value="part_time">Part-Time</option><option value="intern">Intern</option>
                </select></div>
            )}
            <div><label style={lbl} htmlFor="of-country">Works In</label>
              <select id="of-country" className="form-input" style={{ width: '100%' }} value={who.country} onChange={e => setWho(w => ({ ...w, country: e.target.value }))}>
                {countries.map(k => <option key={k} value={k}>{COUNTRY_NAMES[k] || k}</option>)}
              </select></div>
            <div><label style={lbl} htmlFor="of-role">Role *</label>
              <select id="of-role" className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)}>
                <option value="">- pick the role -</option>
                {roles.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
                <option value={OTHER_ROLE}>Other (a new role)</option>
              </select></div>
            {isOther && (
              <>
                <div><label style={lbl} htmlFor="of-newrole">New Role Name *</label>
                  <input id="of-newrole" className="form-input" style={{ width: '100%' }} value={f.new_role_name} onChange={e => set('new_role_name', e.target.value)} /></div>
                <div><label style={lbl} htmlFor="of-dept">Department *</label>
                  <select id="of-dept" className="form-input" style={{ width: '100%' }} value={f.department} onChange={e => set('department', e.target.value)}>
                    <option value="">- pick a department -</option>
                    {roles.departments.map(d => <option key={d} value={d}>{d}</option>)}
                  </select></div>
              </>
            )}
            {!isOther && role && <div><label style={lbl}>Department</label><div className="form-input" style={{ width: '100%', background: 'var(--mist)' }}>{role.department || 'The role has no department'}</div></div>}
          </div>

          {who.worker_type && (
            <div style={{ marginTop: 14, border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', background: 'var(--mist)' }}>
              {loading ? <Spinner size={16} /> : letter ? (
                <>
                  <div style={{ fontSize: 12.5 }}><CheckCircle size={13} style={{ verticalAlign: 'middle', color: 'hsl(var(--color-green))', marginRight: 6 }} />
                    <b>Offer letter:</b> {letter.name}{letter.documents?.length > 1 ? ` (${letter.documents.length} documents)` : ''}</div>
                  <div style={{ fontSize: 12.5, marginTop: 4 }}>
                    {packet ? <><b>Then:</b> {packet.name} - sent to {first} by itself once they sign the offer{packet.personQuestions?.length ? `; their form asks ${packet.personQuestions.length} question${packet.personQuestions.length === 1 ? '' : 's'} from the documents` : ''}.</>
                      : <span style={{ color: 'hsl(var(--color-orange))' }}>No hiring packet is set up for this hire yet - they are still hired when they sign; start the packet from their card once it is set up.</span>}
                  </div>
                  {(letter.problems || []).map(p => <Warn key={p}>{p}</Warn>)}
                </>
              ) : (
                <>
                  <Warn>{opts?.missing || 'No offer letter matches this hire.'}</Warn>
                  {onMoveWithout && opts && (
                    <div style={{ ...hint, marginTop: 8 }}>
                      {(opts.choices || []).length ? 'Pick one of the company\'s other letters below, set one up, or ' : 'This company has no offer letters yet. '}
                      <button type="button" onClick={() => onMoveWithout(c)}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, color: 'hsl(var(--color-blue))', textDecoration: 'underline', fontFamily: 'Inter,sans-serif' }}>
                        move them to Offer without one
                      </button> - the hiring packet can then be sent the old way.
                    </div>
                  )}
                </>
              )}
              {(opts?.choices || []).length > 1 || (!letter && (opts?.choices || []).length > 0) ? (
                <div style={{ marginTop: 8 }}>
                  <label style={{ ...lbl, marginTop: 4 }} htmlFor="of-letter">Use A Different Offer Letter</label>
                  <select id="of-letter" className="form-input" style={{ width: '100%' }} value={chosenId} onChange={e => setChosenId(e.target.value)}>
                    <option value="">The one Nexus picks for this hire</option>
                    {opts.choices.map(x => <option key={x.id} value={x.id}>{x.name}{x.workerType !== 'any' ? ` - ${x.workerType === 'contractor' ? 'Contractors' : 'Employees'}` : ''}{x.country ? ` (${COUNTRY_NAMES[x.country] || x.country})` : ''}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          )}

          {letter && (
            <>
              <div style={sectionHead}>2. The Offer</div>
              <div style={grid}>
                <div><label style={lbl} htmlFor="of-first">Legal First Name *</label>
                  <input id="of-first" className="form-input" style={{ width: '100%' }} value={person.first_name} onChange={e => setPerson(p => ({ ...p, first_name: e.target.value }))} /></div>
                <div><label style={lbl} htmlFor="of-last">Legal Last Name *</label>
                  <input id="of-last" className="form-input" style={{ width: '100%' }} value={person.last_name} onChange={e => setPerson(p => ({ ...p, last_name: e.target.value }))} /></div>
                <div><label style={lbl} htmlFor="of-start">Start Date *</label>
                  <input id="of-start" type="date" className="form-input" style={{ width: '100%' }} value={f.start_date} onChange={e => set('start_date', e.target.value)} /></div>
                <div><label style={lbl} htmlFor="of-exp">Offer Expires *</label>
                  <input id="of-exp" type="date" className="form-input" style={{ width: '100%' }} value={f.offer_expires} max={f.start_date || undefined} onChange={e => set('offer_expires', e.target.value)}
                    title="They can sign through this day; after it the link stops working." /></div>
                {prints.has('address') && (
                  <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-addr">Their Address (Printed On The Letter)</label>
                    <input id="of-addr" className="form-input" style={{ width: '100%' }} value={person.address} onChange={e => setPerson(p => ({ ...p, address: e.target.value }))} /></div>
                )}
                {prints.has('work_location') && (
                  <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-loc">Primary Work Location</label>
                    <input id="of-loc" className="form-input" style={{ width: '100%' }} value={f.work_location} onChange={e => set('work_location', e.target.value)} placeholder="e.g. Irvine, CA - or Remote" /></div>
                )}
                <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Supervisor</label>
                  {manager ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{manager.name || manager.email}</span>
                      <button type="button" className="secondary-btn" style={{ fontSize: 11.5, padding: '3px 10px' }} onClick={() => set('manager_email', '')}>Change</button>
                    </div>
                  ) : <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]} onPick={v => set('manager_email', v)} />}
                </div>
              </div>

              {canSeePay ? (
                <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                  <div><label style={lbl} htmlFor="of-pay">{contractor ? 'Fee' : 'Pay'}</label>
                    <input id="of-pay" className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={pay.base} onChange={e => setPay(p => ({ ...p, base: e.target.value }))} placeholder="0.00" /></div>
                  <div><label style={lbl} htmlFor="of-basis">Paid</label>
                    <select id="of-basis" className="form-input" style={{ width: '100%' }} value={pay.payBasis} onChange={e => setPay(p => ({ ...p, payBasis: e.target.value }))}>
                      <option value="salary">{contractor ? 'Fixed Fee' : 'Salary'}</option><option value="hourly">Hourly</option>
                    </select></div>
                  {pay.payBasis === 'salary' && (
                    <div><label style={lbl} htmlFor="of-freq">Frequency</label>
                      <select id="of-freq" className="form-input" style={{ width: '100%' }} value={pay.frequency} onChange={e => setPay(p => ({ ...p, frequency: e.target.value }))}>
                        {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select></div>
                  )}
                  <div><label style={lbl} htmlFor="of-cur">Currency</label>
                    <select id="of-cur" className="form-input" style={{ width: '100%' }} value={pay.currency} onChange={e => setPay(p => ({ ...p, currency: e.target.value }))}>
                      {currencyOptions().map(x => <option key={x.code} value={x.code}>{x.label}</option>)}
                    </select></div>
                  <div style={{ gridColumn: '1 / -1', ...hint }}>Printed in the offer letter, and set as their pay from the start date once they sign.</div>
                </div>
              ) : <div style={hint}>Pay &amp; Benefits access is needed to enter pay - whoever verifies the offer adds it at review.</div>}

              {SCHEDULE.some(k => prints.has(k)) && (
                <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                  <div><label style={lbl} htmlFor="of-from">Starts At</label>
                    <input id="of-from" type="time" className="form-input" style={{ width: '100%' }} value={timing.work_start} onChange={e => setTiming(t => ({ ...t, work_start: e.target.value }))} /></div>
                  <div><label style={lbl} htmlFor="of-to">Ends At</label>
                    <input id="of-to" type="time" className="form-input" style={{ width: '100%' }} value={timing.work_end} onChange={e => setTiming(t => ({ ...t, work_end: e.target.value }))} /></div>
                  <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Work Days</label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {DAYS.map(([k, l]) => {
                        const on = timing.work_days.includes(k);
                        return <button key={k} type="button" aria-pressed={on} onClick={() => setTiming(t => ({ ...t, work_days: on ? t.work_days.filter(x => x !== k) : [...t.work_days, k] }))}
                          style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                            background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
                      })}
                    </div></div>
                </div>
              )}

              {packet && (
                <div><label style={lbl} htmlFor="of-jd">Job Description (Goes In The Hiring Packet)</label>
                  <select id="of-jd" className="form-input" style={{ width: '100%' }} value={jdId} onChange={e => setJdId(e.target.value)}>
                    <option value="">None</option>
                    {jds.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
                  </select></div>
              )}

              {questions.length > 0 && (
                <>
                  <div style={sectionHead}>Questions From The Documents</div>
                  <div style={hint}>Only HR knows these and they change per hire - asked once here, printed wherever the documents need them.</div>
                  <div style={grid}>
                    {questions.map(q => {
                      const locked = q.pay && !canSeePay;
                      const id = `of-q-${q.token}`;
                      return (
                        <div key={q.token}>
                          <label style={lbl} htmlFor={id}>{q.label}{q.required ? ' *' : ''}</label>
                          {q.type === 'choice' && q.options?.length ? (
                            <select id={id} className="form-input" style={{ width: '100%' }} disabled={locked} value={answers[q.token] || ''} onChange={e => setAnswers(a => ({ ...a, [q.token]: e.target.value }))}>
                              <option value="">-</option>{q.options.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input id={id} className="form-input" style={{ width: '100%' }} disabled={locked} type={q.type === 'date' ? 'date' : 'text'}
                              value={answers[q.token] || ''} placeholder={locked ? 'Pay & Benefits enters it at review' : q.default || ''}
                              onChange={e => setAnswers(a => ({ ...a, [q.token]: e.target.value }))} />
                          )}
                          <div style={hint}>{q.help || q.templateName}{q.pay ? ' - pay, Pay & Benefits only' : ''}</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--muted)', minWidth: 200 }}>
            {missing.length ? `Still needed: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '...' : ''}.` : `Next: you check the filled-in letter, then Verify And Send emails it to ${c.email || first} - no login needed to sign.`}
          </span>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary-btn" onClick={create} disabled={busy || missing.length > 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Spinner size={14} /> : <FileSignature size={14} />} Create Offer Letter
          </button>
        </div>
      </div>
    </div>
  );
}
