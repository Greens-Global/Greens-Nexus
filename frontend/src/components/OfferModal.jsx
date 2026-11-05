// Make An Offer (Neil and Charmi, Oct 14). Move To Offer opens this:
//
//   "You can't send an offer without answering these questions. Who has to
//   answer those? HR has to." ... "Pranshu is going to let you fill in
//   everything and the document will make itself."
//
// Three short steps (Pranshu, Oct 15: "simple, better, spacious"):
//   1 Who You Are Hiring - employee or contractor (the same role can be
//     either, so it is never guessed), where they work, the role. Nexus shows
//     the ONE offer letter that fits and the hiring packet that follows it.
//   2 The Offer - their legal name, start, pay, and only what the letter and
//     the packet print (address, work location, hours).
//   3 Questions - whatever the documents mark HR Answers At Offer, then
//     Create Offer Letter. The verifier checks it (PacketReview) and Verify And
//     Send emails it; the candidate signs with no Nexus login. Both signed =
//     hired, and the hiring packet starts by itself.
// Problems show only when Continue is pressed, on the step they belong to.
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, FileSignature, AlertTriangle, CheckCircle, ArrowRight, ArrowLeft, Check, Info, RefreshCw, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { currencyOptions } from '../asset/lib/currency';
import { useEntities, usePeopleDirectory } from '../lib/queries';
import { Spinner } from './AsyncState';
import PersonSearchSelect from './PersonSearchSelect';
import { DateField } from '../tasks/components';
import { worksInLabel } from '../lib/usStates';
import WorksInSelect from './WorksInSelect';
import { leadsFor } from './HiringSchedule';

const OTHER_ROLE = '__other__';
const FREQUENCIES = [['annual', 'Per Year'], ['monthly', 'Per Month'], ['semimonthly', 'Twice A Month'], ['biweekly', 'Every Two Weeks'], ['weekly', 'Per Week']];
const COUNTRY_NAMES = { US: 'United States', IN: 'India', CA: 'Canada', GB: 'United Kingdom', AE: 'United Arab Emirates', PH: 'Philippines', MX: 'Mexico', AU: 'Australia' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
// Preview before Create (Neil, 11/04/2026): the letter and job description as they will go, with Back to fix.
const STEPS = [['who', 'Who You Are Hiring'], ['offer', 'The Offer'], ['questions', 'Questions'], ['preview', 'Preview']];
// What follows the letter, in the role's order (Pranshu, 11/04/2026): "offer letter, NDA then Job description".
const offerAfter = (role, jdFile) => {
  const order = role?.offerDocs?.length ? role.offerDocs : [{ kind: 'jd' }];
  return order.map(d => (d.kind === 'jd' ? (jdFile ? `the job description (${jdFile})` : 'the job description') : d.name || 'a role document'))
    .join(', then ');
};
// A template opens in Documents in its own browser tab, so this offer keeps everything typed.
const openTemplate = (id) => window.open(`/documents/documents-templates?template=${encodeURIComponent(id)}`, '_blank', 'noopener');

const lbl = { fontSize: 13, fontWeight: 600, color: 'var(--ink)', display: 'block', margin: '18px 0 6px' };
const hint = { fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.55 };
const h2 = { fontSize: 17, fontWeight: 800, margin: '22px 0 4px', color: 'var(--ink)' };
const lead = { fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, margin: 0 };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 18px' };
const card = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' };
export const REPORTS_TO = 'Reports To - the person this hire reports to day to day. They become the manager on the profile.';
const smallBtn = { fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 };

function Warn({ children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginTop: 10 }}>
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{children}</span>
    </div>
  );
}

const WORK_LOCATIONS = { remote: { text: 'Remote' }, hybrid: { text: 'Hybrid' } };   // company and other are resolved in the form

function Choice({ on, onClick, title, sub, label }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label || title} onClick={onClick}
      style={{ flex: '1 1 200px', textAlign: 'left', border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, borderRadius: 14, padding: '14px 16px', cursor: 'pointer',
        background: on ? 'hsla(var(--color-green),0.06)' : 'var(--card)', fontFamily: 'Inter,sans-serif', color: 'var(--ink)' }}>
      <div style={{ fontSize: 14.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 16, height: 16, borderRadius: 8, border: `1.5px solid ${on ? 'var(--pine)' : 'var(--line)'}`, background: on ? 'var(--pine)' : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {on && <Check size={10} color="#fff" />}
        </span>
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, marginLeft: 24 }}>{sub}</div>
    </button>
  );
}

export default function OfferModal({ candidate: c, canSeePay, onClose, onStarted, onMoveWithout, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  // Work Location (Pranshu, 11/05/2026): the company's location, Remote, Hybrid or typed -
  // printed in the letter and shown in the candidate's emails instead of the company address.
  const { data: entities } = useEntities();
  const companyAddr = ((entities || []).find(e => e.id === c.company)?.physicalAddress || '').trim();
  const [loc, setLoc] = useState({ kind: 'company', other: '' });
  const workLocation = WORK_LOCATIONS[loc.kind]?.text ?? (loc.kind === 'other' ? loc.other.trim() : companyAddr);
  const first = c.firstName || 'They';
  const [step, setStep] = useState('who');
  const [tried, setTried] = useState(false);
  // Where they work picks the paperwork - country AND state (Neil, Oct 22).
  // Works In defaults to United States - CA (Neil, 11/04/2026).
  const [who, setWho] = useState({ worker_type: '', employment_type: 'full_time', country: 'US', region: 'CA' });
  const [f, setF] = useState(() => ({
    role_id: c.roleId || (c.roleTitle ? OTHER_ROLE : ''), new_role_name: c.roleId ? '' : (c.roleTitle || ''),
    department: c.department || '', start_date: (c.expectedStart || '').slice(0, 10),
    // A week is the usual window - still HR's call.
    offer_expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    manager_email: '', work_location: '',
    offer_from: 'hr',          // Offer Comes From (Neil, Oct 22): Head of HR, or the department head
  }));
  const [person, setPerson] = useState({ first_name: c.firstName || '', last_name: c.lastName || '', address: '' });
  const [timing, setTiming] = useState({ work_start: '09:00', work_end: '17:00', work_days: ['mon', 'tue', 'wed', 'thu', 'fri'], timings_text: '' });
  const [pay, setPay] = useState({ base: '', payBasis: 'salary', frequency: 'annual', currency: 'USD' });
  const [answers, setAnswers] = useState({});          // the documents' own HR Answers questions
  const [jdId, setJdId] = useState('');
  const [jds, setJds] = useState([]);
  const [newDuties, setNewDuties] = useState('');       // "Other": the new role's duties, typed here
  const [roles, setRoles] = useState({ roles: [], departments: [], leads: {} });
  const [opts, setOpts] = useState(null);              // which letter + packet, and what they ask
  const [chosenId, setChosenId] = useState('');         // HR picked another offer letter by hand
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState(null);           // the preview: {loading} | {url, unfilled} | {error}
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
    // One Job Description document serves every role (Oct 22): picked for HR when it is the only one.
    api.getDocTemplates({ category: 'job_description', status: 'active' }).then(r => {
      const list = Array.isArray(r) ? r : [];
      setJds(list);
      if (list.length === 1) setJdId(id => id || list[0].id);
    }).catch(() => setJds([]));
  }, [c.company, c.roleId]);

  const isOther = f.role_id === OTHER_ROLE;
  const roleId = isOther ? '' : f.role_id;
  // The job description goes out after the offer letter (Neil, 11/03/2026): the
  // role's own file when it has one, else its duties printed by the Job Description document.
  const pickedRole = roles.roles.find(r => r.id === roleId);
  const jdFile = pickedRole?.jdFile || '';
  // A role whose job description lives in Documents brings that template, live (11/04/2026).
  const roleJd = !jdFile && pickedRole?.jdTemplateId ? pickedRole.jdTemplateId : '';
  useEffect(() => { if (roleJd) setJdId(roleJd); }, [roleJd]);
  const noDuties = isOther ? !newDuties.trim() : !!pickedRole && !pickedRole.hasDuties && !roleJd;
  // Which letter - re-read whenever HR changes who they are hiring or where.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.offerOptions(c.id, { worker_type: who.worker_type, country: who.country, region: who.region, role_id: roleId, packet_id: chosenId,
                             new_role: isOther ? '1' : '', department: isOther ? f.department : '' })
      .then(o => {
        if (!alive) return;
        setOpts(o);
        setWho(w => (w.country ? (w.region || w.country !== o.country ? w : { ...w, region: o.region || '' })
          : { ...w, country: o.country || '', region: o.region || '' }));
      })
      .catch(e => { if (alive) { setOpts(null); toastErr?.(e?.message || 'Could not find the offer letter.'); } })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [c.id, who.worker_type, who.country, who.region, roleId, chosenId, isOther, f.department]);

  const letter = opts?.offerLetter || null;
  const packet = opts?.hiringPacket || null;
  const prints = new Set([...(letter?.prints || []), ...(packet?.prints || [])]);
  const questions = useMemo(() => {
    const seen = new Set();
    return [...(letter?.hrQuestions || []), ...(packet?.hrQuestions || [])].filter(q => !seen.has(q.token) && seen.add(q.token));
  }, [letter, packet]);
  const manager = people.find(p => p.email === f.manager_email);
  const from = opts?.offerFrom || {};
  // A role whose department has no head: back to Head of HR, never a refused send.
  useEffect(() => { if (opts && !opts.offerFrom?.department_head?.email) setF(p => (p.offer_from === 'hr' ? p : { ...p, offer_from: 'hr' })); }, [opts]);
  const contractor = who.worker_type === 'contractor';
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

  // What each step still needs - shown only once Continue is pressed there.
  const problemsFor = {
    who: [
      !who.worker_type && 'Choose Employee or Contractor.',
      // Never an offer with nothing after it (Neil, Oct 22): the hire would sign and then wait.
      who.worker_type && !loading && opts?.missingPacket && 'Set up the hiring packet for this place first - see below.',
      (!f.role_id || (isOther && (!f.new_role_name.trim() || !f.department))) && 'Pick the role.',
      who.worker_type && !loading && !letter && 'There is no offer letter for this hire yet - set one up, pick another above, or move them to Offer without one.',
    ],
    offer: [
      (!person.first_name.trim() || !person.last_name.trim()) && 'Enter their legal first and last name.',
      !f.start_date && 'Pick the start date.',
      !f.offer_expires && 'Pick when the offer expires.',
      loc.kind === 'other' && !loc.other.trim() && 'Type the work location.',
      loc.kind === 'company' && !companyAddr && entities && 'The company has no address on file - pick Remote, Hybrid or Other, or add it under Settings > Companies.',
      f.offer_expires && f.start_date && f.offer_expires > f.start_date && 'The offer has to expire on or before the start date.',
      !jdFile && !jdId && 'Pick the Job Description document.',
      !jdFile && noDuties && (isOther ? 'Type the new role\'s duties.' : `${pickedRole?.name || 'This role'} has no job description yet - add it under Settings > People & Access > Roles.`),
    ],
    questions: questions.filter(q => q.required && !(q.pay && !canSeePay) && !String(answers[q.token] || '').trim()).map(q => `Answer ${q.label}.`),
    preview: [],
  };
  const stepProblems = (k) => problemsFor[k].filter(Boolean);
  const stepIndex = STEPS.findIndex(([k]) => k === step);
  const goTo = (k) => { setStep(k); setTried(false); };
  const next = () => {
    if (stepProblems(step).length) { setTried(true); return; }
    const to = STEPS[stepIndex + 1][0];
    goTo(to);
    if (to === 'preview') loadPreview();
  };

  // What Preview and Create both send - the preview is the letter Create makes.
  const offerBody = () => {
    const plain = Object.fromEntries(questions.filter(q => !q.pay).map(q => [q.token, String(answers[q.token] || '').trim()]).filter(([, v]) => v));
    const payQs = canSeePay ? Object.fromEntries(questions.filter(q => q.pay).map(q => [q.token, String(answers[q.token] || '').trim()]).filter(([, v]) => v)) : {};
    return {
      inputs: { ...f, ...who, work_location: workLocation, role_id: roleId, new_role_name: isOther ? f.new_role_name.trim() : '',
                ...timing,
                jd_template_id: jdFile ? '' : jdId, new_role_duties: isOther ? newDuties.trim() : '',
                packet_id: chosenId, merge: plain },
      pay: canSeePay && String(pay.base).trim() ? { ...pay, base: Number(pay.base) } : null,
      pay_values: Object.keys(payQs).length ? payQs : null,
      details: { first_name: person.first_name.trim(), last_name: person.last_name.trim(), ...(prints.has('address') ? { address: person.address.trim() } : {}) },
    };
  };

  async function loadPreview() {
    setPv({ loading: true });
    try {
      const out = await api.previewOffer(c.id, offerBody());
      const bytes = Uint8Array.from(atob(out.pdf || ''), ch => ch.charCodeAt(0));
      setPv({ url: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), unfilled: out.unfilled || [] });
    } catch (e) { setPv({ error: e?.message || 'Could not build the preview.' }); }
  }
  // Each preview's file is let go when the next one replaces it, or on close.
  useEffect(() => () => { if (pv?.url) URL.revokeObjectURL(pv.url); }, [pv]);

  async function create() {
    const bad = STEPS.find(([k]) => stepProblems(k).length);
    if (bad) { setStep(bad[0]); setTried(true); return; }
    setBusy(true);
    try {
      const ev = await api.startOffer(c.id, offerBody());
      onStarted(ev);
    } catch (e) { toastErr?.(e?.message || 'Could not make the offer.'); setBusy(false); }
  }

  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  const shown = tried ? stepProblems(step) : [];

  // ── step 1: who ──
  const whoStep = (
    <>
      <h2 style={h2}>Who are you hiring?</h2>
      <p style={lead}>This decides which offer letter goes. A contractor's letter never says employment.</p>
      <div role="radiogroup" aria-label="Hired as" style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <Choice on={who.worker_type === 'employee'} onClick={() => setWho(w => ({ ...w, worker_type: 'employee', employment_type: w.employment_type === 'contractor' ? 'full_time' : w.employment_type }))}
          title="Employee" sub="On payroll - full-time, part-time or intern" />
        <Choice on={contractor} onClick={() => setWho(w => ({ ...w, worker_type: 'contractor', employment_type: 'contractor' }))}
          title="Contractor" sub="Independent - paid a fee" />
      </div>
      <div style={grid}>
        {who.worker_type === 'employee' && (
          <div><label style={lbl} htmlFor="of-et">Employment Type</label>
            <select id="of-et" className="form-input" style={{ width: '100%' }} value={who.employment_type} onChange={e => setWho(w => ({ ...w, employment_type: e.target.value }))}>
              <option value="full_time">Full-Time</option><option value="part_time">Part-Time</option><option value="intern">Intern</option>
            </select></div>
        )}
        <div><label style={lbl} htmlFor="of-country">Works In</label>
          <WorksInSelect id="of-country" country={who.country} region={who.region} countryNames={COUNTRY_NAMES}
            onChange={place => setWho(w => ({ ...w, ...place }))} /></div>
        <div><label style={lbl} htmlFor="of-role">Role</label>
          <select id="of-role" className="form-input" style={{ width: '100%' }} value={f.role_id} onChange={e => pickRole(e.target.value)}>
            <option value="">- pick the role -</option>
            {roles.roles.map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
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

      {who.worker_type && (
        <div style={{ ...card, marginTop: 22, background: 'var(--mist)', fontSize: 13, lineHeight: 1.6 }}>
          {loading ? <Spinner size={16} /> : letter ? (
            <>
              <div><CheckCircle size={14} style={{ verticalAlign: 'middle', color: 'hsl(var(--color-green))', marginRight: 6 }} /><b>Offer letter:</b> {letter.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                After the letter: {offerAfter(pickedRole, jdFile)}, with a box {first} ticks to say they read the job description.
              </div>
              <div style={{ marginTop: 4 }}>
                {packet ? <>
                  <b>Then:</b> {packet.name}, sent to {first} by itself once they sign the offer.
                  {(packet.documents || []).length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>It holds: {packet.documents.join(', ')}.</div>
                  )}
                </>
                  : <Warn>{opts?.missingPacket || 'No hiring packet is set up for this hire yet.'}</Warn>}
              </div>
              {(letter.problems || []).map(p => <Warn key={p}>{p}</Warn>)}
            </>
          ) : (
            <>
              <Warn>{opts?.missing || 'No offer letter fits this hire.'}</Warn>
              {onMoveWithout && opts && (
                <div style={{ ...hint, marginTop: 8 }}>
                  {(opts.choices || []).length ? 'Pick another letter below, set one up, or ' : 'This company has no offer letters yet. '}
                  <button type="button" onClick={() => onMoveWithout(c)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, color: 'hsl(var(--color-blue))', textDecoration: 'underline', fontFamily: 'Inter,sans-serif' }}>
                    move them to Offer without one
                  </button>.
                </div>
              )}
            </>
          )}
          {((opts?.choices || []).length > 1 || (!letter && (opts?.choices || []).length > 0)) && (
            <div style={{ marginTop: 12 }}>
              <label style={{ ...lbl, margin: '0 0 6px' }} htmlFor="of-letter">Use A Different Offer Letter</label>
              <select id="of-letter" className="form-input" style={{ width: '100%' }} value={chosenId} onChange={e => setChosenId(e.target.value)}>
                <option value="">The one Nexus picks for this hire</option>
                {opts.choices.map(x => <option key={x.id} value={x.id}>{x.name}{x.workerType !== 'any' ? ` - ${x.workerType === 'contractor' ? 'Contractors' : 'Employees'}` : ''}{x.country ? ` (${worksInLabel(x.country, x.region, COUNTRY_NAMES)})` : ''}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
    </>
  );

  // ── step 2: the offer ──
  const offerStep = (
    <>
      <h2 style={h2}>The offer</h2>
      <p style={lead}>Printed in the letter. Only what {letter?.name || 'the letter'} and the hiring packet need is asked.</p>
      <div style={grid}>
        <div><label style={lbl} htmlFor="of-first">Legal First Name</label>
          <input id="of-first" className="form-input" style={{ width: '100%' }} value={person.first_name} onChange={e => setPerson(p => ({ ...p, first_name: e.target.value }))} /></div>
        <div><label style={lbl} htmlFor="of-last">Legal Last Name</label>
          <input id="of-last" className="form-input" style={{ width: '100%' }} value={person.last_name} onChange={e => setPerson(p => ({ ...p, last_name: e.target.value }))} /></div>
        <div><label style={lbl}>Start Date</label>
          <div id="of-start" className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.start_date} onChange={x => set('start_date', x || '')} placeholder="MM/DD/YYYY" title="Start date" style={{ width: '100%' }} />
          </div></div>
        <div><label style={lbl}>Offer Expires</label>
          <div id="of-exp" className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.offer_expires} onChange={x => set('offer_expires', x || '')} placeholder="MM/DD/YYYY" title="Offer expires" style={{ width: '100%' }} />
          </div>
          <div style={hint}>They can sign through this day.</div></div>
        {prints.has('address') && (
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-addr">Their Address</label>
            <input id="of-addr" className="form-input" style={{ width: '100%' }} value={person.address} onChange={e => setPerson(p => ({ ...p, address: e.target.value }))} /></div>
        )}
        <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-loc">Work Location</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select id="of-loc" className="form-input" style={{ flex: '0 1 220px' }} value={loc.kind} onChange={e => setLoc(l => ({ ...l, kind: e.target.value }))}>
              <option value="company">Company Location</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="other">Other</option>
            </select>
            {loc.kind === 'other' && (
              <input aria-label="Work location" className="form-input" style={{ flex: '1 1 220px' }} value={loc.other} autoFocus
                onChange={e => setLoc(l => ({ ...l, other: e.target.value }))} placeholder="e.g. Fresno, CA job site" />
            )}
          </div>
          <div style={hint}>{loc.kind === 'company' ? (companyAddr || 'No address on file for this company.') : 'Printed in the letter and shown in their emails.'}</div></div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6 }} title={REPORTS_TO}>
            Supervisor <Info size={13} aria-label={REPORTS_TO} style={{ color: 'var(--muted)', cursor: 'help' }} />
          </label>
          {manager ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{manager.name || manager.email}</span>
              <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => set('manager_email', '')}>Change</button>
            </div>
          ) : <PersonSearchSelect placeholder="Type a name or email" groups={[{ label: 'Nexus People', people }]} onPick={v => set('manager_email', v)} />}
          <div style={hint}>{REPORTS_TO}</div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}><label style={lbl} htmlFor="of-from">Offer Comes From</label>
          <select id="of-from" className="form-input" style={{ width: '100%' }} value={f.offer_from} onChange={e => set('offer_from', e.target.value)}>
            <option value="hr">Head of HR{from.hr?.name ? ` - ${from.hr.name}` : ''}</option>
            <option value="department_head" disabled={!from.department_head?.email}>
              Department Head{from.department_head?.name ? ` - ${from.department_head.name}` : ' - none set up'}
            </option>
          </select>
          <div style={hint}>
            {!from.department_head?.email
              ? `${from.department ? `The ${from.department} department` : 'This department'} has no head set up (Settings > Companies > Departments), so the offer comes from HR.`
              : 'The letter closes with their name and the offer email comes from them. It still says who they report to.'}
          </div>
        </div>
      </div>

      <label style={{ ...lbl, marginTop: 26 }}>{contractor ? 'Fee' : 'Pay'}</label>
      {canSeePay ? (
        <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-pay">Amount</label>
            <input id="of-pay" className="form-input" type="number" min="0" step="0.01" style={{ width: '100%' }} value={pay.base} onChange={e => setPay(p => ({ ...p, base: e.target.value }))} placeholder="0.00" aria-label={contractor ? 'Fee' : 'Pay'} /></div>
          <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-basis">Paid</label>
            <select id="of-basis" className="form-input" style={{ width: '100%' }} value={pay.payBasis} onChange={e => setPay(p => ({ ...p, payBasis: e.target.value }))}>
              <option value="salary">{contractor ? 'Fixed Fee' : 'Salary'}</option><option value="hourly">Hourly</option>
            </select></div>
          {pay.payBasis === 'salary' && (
            <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-freq">Every</label>
              <select id="of-freq" className="form-input" style={{ width: '100%' }} value={pay.frequency} onChange={e => setPay(p => ({ ...p, frequency: e.target.value }))}>
                {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></div>
          )}
          <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-cur">Currency</label>
            <select id="of-cur" className="form-input" style={{ width: '100%' }} value={pay.currency} onChange={e => setPay(p => ({ ...p, currency: e.target.value }))}>
              {currencyOptions().map(x => <option key={x.code} value={x.code}>{x.label}</option>)}
            </select></div>
        </div>
      ) : <div style={hint}>Pay &amp; Benefits access is needed to enter pay - whoever checks the offer adds it before sending.</div>}

      {/* Always asked (Neil, 11/04/2026: "I didn't see that as an option") - it shows under Check What Is Printed. */}
      <>
          <label style={{ ...lbl, marginTop: 26 }}>Timings</label>
          <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-from">From</label>
              <input id="of-from" type="time" className="form-input" style={{ width: '100%' }} value={timing.work_start} onChange={e => setTiming(t => ({ ...t, work_start: e.target.value }))} /></div>
            <div><label style={{ ...hint, marginTop: 0, marginBottom: 4, display: 'block' }} htmlFor="of-to">To</label>
              <input id="of-to" type="time" className="form-input" style={{ width: '100%' }} value={timing.work_end} onChange={e => setTiming(t => ({ ...t, work_end: e.target.value }))} /></div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {DAYS.map(([k, l]) => {
              const on = timing.work_days.includes(k);
              return <button key={k} type="button" aria-pressed={on} onClick={() => setTiming(t => ({ ...t, work_days: on ? t.work_days.filter(x => x !== k) : [...t.work_days, k] }))}
                style={{ padding: '5px 12px', borderRadius: 999, border: '1px solid var(--line)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                  background: on ? 'var(--pine)' : 'var(--card)', color: on ? '#fff' : 'var(--ink)' }}>{l}</button>;
            })}
          </div>
          <label style={{ ...hint, marginTop: 10, marginBottom: 4, display: 'block' }} htmlFor="of-timings">Or Describe The Timings</label>
          <input id="of-timings" className="form-input" style={{ width: '100%' }} value={timing.timings_text}
            onChange={e => setTiming(t => ({ ...t, timings_text: e.target.value }))} placeholder="e.g. Rotating shifts, 40 hours a week" />
      </>

      {jdFile ? (
        <div><div style={{ ...lbl, marginTop: 26 }}>Job Description</div>
          <div style={{ fontSize: 13.5 }}>{jdFile}</div>
          <div style={hint}>{pickedRole.name}&apos;s own file - sent after the offer letter exactly as uploaded, with a box {first} ticks to say they read it.</div></div>
      ) : (
        <div><label style={{ ...lbl, marginTop: 26 }} htmlFor="of-jd">Job Description</label>
          <select id="of-jd" className="form-input" style={{ width: '100%', maxWidth: 420 }} value={jdId} onChange={e => setJdId(e.target.value)} disabled={!!roleJd}>
            <option value="">- pick the document -</option>
            {jds.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
          </select>
          <div style={hint}>{roleJd
            ? <>{pickedRole.name}&apos;s job description from Documents - its published wording goes after the offer letter, with a box {first} ticks to say they read it.</>
            : <>Prints the role&apos;s duties after the offer letter, with a box {first} ticks to say they read it.</>}</div>
          {isOther && (
            <>
              <label style={{ ...lbl, marginTop: 14 }} htmlFor="of-duties">Duties For {f.new_role_name.trim() || 'The New Role'}</label>
              <textarea id="of-duties" className="form-input" rows={5} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                value={newDuties} onChange={e => setNewDuties(e.target.value)} placeholder="Duties, responsibilities, requirements." />
              <div style={hint}>Saved on the new role too, so the next offer for it has them.</div>
            </>
          )}
          {!isOther && pickedRole && !pickedRole.hasDuties && !roleJd && (
            <Warn>{pickedRole.name} has no job description yet - type its duties or upload a file under Settings &gt; People &amp; Access &gt; Roles.</Warn>
          )}</div>
      )}
    </>
  );

  // ── step 3: questions ──
  const questionsStep = (
    <>
      <h2 style={h2}>{questions.length ? 'A few questions from the documents' : 'Ready to create the letter'}</h2>
      <p style={lead}>{questions.length ? 'Only HR knows these and they change per hire. Asked once here, printed wherever the documents need them.'
        : 'Nothing else is asked for this hire.'}</p>
      {questions.length > 0 && (
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
                {(q.help || q.pay) && <div style={hint}>{q.help}{q.pay ? `${q.help ? ' ' : ''}Pay - Pay & Benefits only.` : ''}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ ...card, marginTop: 26, background: 'var(--mist)', fontSize: 13, lineHeight: 1.65 }}>
        <b>What happens next</b>
        <div style={{ marginTop: 4 }}>1. You check the filled-in letter, then Verify And Send.</div>
        <div>2. {first} gets an email and signs - no login needed. Nobody signs an offer for the company.</div>
        <div>3. Signed: {first} is hired{packet ? `, and ${packet.name} goes out to them by itself` : ''}.</div>
      </div>
    </>
  );

  // ── step 4: preview ──
  const letterTpl = (letter?.templateIds || [])[0] || '';
  const previewStep = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <h2 style={h2}>Check the offer before it is made</h2>
      <p style={lead}>The offer letter and the job description exactly as {first} will get them. Nothing is saved yet - go Back to change an answer,
        or open a document in Documents to change its wording, then Refresh.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" className="secondary-btn" onClick={loadPreview} disabled={!!pv?.loading} style={smallBtn}>
          {pv?.loading ? <Spinner size={13} /> : <RefreshCw size={13} />} Refresh
        </button>
        {letterTpl && <button type="button" className="secondary-btn" onClick={() => openTemplate(letterTpl)} style={smallBtn}><ExternalLink size={13} /> Edit Offer Letter In Documents</button>}
        {!jdFile && jdId && <button type="button" className="secondary-btn" onClick={() => openTemplate(jdId)} style={smallBtn}><ExternalLink size={13} /> Edit Job Description In Documents</button>}
      </div>
      {jdFile && <div style={hint}>The job description is {pickedRole?.name || 'the role'}&apos;s own file - change it under Settings &gt; People &amp; Access &gt; Roles &gt; Job Description.</div>}
      {pv?.unfilled?.length > 0 && <Warn>These print blank: {pv.unfilled.join(', ')}. Go Back and fill them, or fix the template.</Warn>}
      {pv?.error && <Warn>{pv.error}</Warn>}
      <div className="nx-fill" style={{ flex: 1, minHeight: 420, marginTop: 12, border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', display: 'flex' }}>
        {pv?.url ? <iframe title="Offer letter preview" src={pv.url} style={{ flex: 1, border: 'none' }} />
          : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pv?.loading ? <Spinner size="section" /> : null}</div>}
      </div>
    </div>
  );

  const body = { who: whoStep, offer: offerStep, questions: questionsStep, preview: previewStep }[step];
  const last = step === 'preview';

  return (
    <div onClick={e => e.target === e.currentTarget && !busy && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label="Make An Offer" style={{ background: 'var(--card)', borderRadius: 18, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '18px 28px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileSignature size={18} style={{ color: 'var(--pine)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 17 }}>Make An Offer</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{name}{c.roleTitle ? ` · ${c.roleTitle}` : ''}</div>
            </div>
            <button onClick={onClose} disabled={busy} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
          <div role="tablist" aria-label="Offer steps" className="scroll-tabs" style={{ display: 'flex', gap: 4, marginTop: 16, borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
            {STEPS.map(([k, label], i) => {
              const on = k === step;
              const done = i < stepIndex;
              return (
                <button key={k} type="button" role="tab" aria-selected={on} disabled={i > stepIndex} onClick={() => i < stepIndex && goTo(k)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px 10px', border: 'none', borderBottom: `2px solid ${on ? 'var(--pine)' : 'transparent'}`, background: 'none',
                    cursor: i < stepIndex ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 800 : 600, color: on ? 'var(--ink)' : done ? 'var(--muted)' : 'var(--line)', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 20, height: 20, borderRadius: 10, fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: on ? 'var(--pine)' : done ? 'hsla(var(--color-green),0.15)' : 'var(--mist)', color: on ? '#fff' : done ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                    {done ? <Check size={11} /> : i + 1}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 28px 24px' }}>
          {body}
          {shown.map(x => <Warn key={x}>{x}</Warn>)}
        </div>

        <div style={{ padding: '14px 28px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {stepIndex > 0 && <button type="button" className="secondary-btn" onClick={() => goTo(STEPS[stepIndex - 1][0])} disabled={busy} style={smallBtn}><ArrowLeft size={13} /> Back</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {last ? (
            <button type="button" className="primary-btn" onClick={create} disabled={busy} style={smallBtn}>
              {busy ? <Spinner size={14} /> : <FileSignature size={14} />} Create Offer Letter
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={next} disabled={loading && step === 'who'} style={smallBtn}>Continue <ArrowRight size={13} /></button>
          )}
        </div>
      </div>
    </div>
  );
}
