// A packet built from the Documents module (Neil, Oct 14): "we add the
// documents on the document module, and then ... create packages, so it pulls
// from the document module and it pulls in the appropriate documents".
//
// Set up in four short steps (Pranshu, Oct 15: the one-page form was "very
// messy ... over populated"): 1 Who It's For, 2 Documents, 3 Who Signs,
// 4 Ready To Send. Each step asks only what it needs; the settings most
// packets never change (letterhead, pay visibility, the welcome note, the
// Egnyte folder) sit under More Options. Problems show when Continue is
// pressed, on the step they belong to - never before anything is typed.
//
//   Documents      - templates from Documents > Templates, in order. The packet
//                    stores which templates, never a copy: an edit published in
//                    Documents is the edit, for every packet that uses it.
//   Who Signs      - by ROLE, never by person ("HR has to do this, this
//                    person's manager has to do this"). The same roles People
//                    > Checklists uses, plus the company's Authorized Signatory;
//                    each step shows who holds that role today.
//   Checked By     - the role whose holder checks the filled-in documents
//                    before anything goes out for signature.
//   Signs Once     - a company step (HR, Authorized Signatory...) can sign
//                    the packet ONCE; that signature then goes on every packet
//                    until someone else holds the role (Pranshu, Oct 14).
//   Details Form   - what the new hire fills in on their link beyond name,
//                    phone, address and emergency contact: any country, any
//                    field, each a {{variable}} the templates print.
//
// The server (backend/hr_packet_docs.py) owns every rule; the problems it
// returns are shown as they are.
import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, FileText, ChevronUp, ChevronDown, CheckCircle, AlertTriangle, Eye, ExternalLink, PenTool, Heading, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { flowFor, keyLabel, formKey, readinessSummary } from '../lib/packetFlow';
import { Spinner } from './AsyncState';
import SignOnceModal from './SignOnceModal';
import PacketReadiness from './PacketReadiness';
import { formatDate } from '../lib/datetime';
import { US_STATE_NAMES, placeName } from '../lib/usStates';

// Roomy, plain: normal-case labels, one short hint only where it helps.
const lbl = { fontSize: 13, fontWeight: 600, color: 'var(--ink)', display: 'block', margin: '18px 0 6px' };
const hint = { fontSize: 12.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.55 };
const h2 = { fontSize: 17, fontWeight: 800, margin: '22px 0 4px', color: 'var(--ink)' };
const lead = { fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, margin: 0 };
const card = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', background: 'var(--card)' };
const iconBtn = { padding: '4px 6px', display: 'inline-flex', alignItems: 'center' };
const smallBtn = { fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 };

const Problem = ({ children }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, marginTop: 10 }}>
    <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /><span>{children}</span>
  </div>
);
const Chip = ({ tone = 'gray', children, title }) => (
  <span title={title} style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'gray' ? 'var(--mist)' : `hsla(var(--color-${tone}),0.12)`,
    color: tone === 'gray' ? 'var(--muted)' : `hsl(var(--color-${tone}))` }}>{children}</span>
);
// A section most people never open - closed by default, one line to open it.
const More = ({ title, children, open = false }) => (
  <details open={open} style={{ ...card, marginTop: 18, padding: '10px 14px' }}>
    <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--ink)', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
      <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> {title}
    </summary>
    <div style={{ marginTop: 4 }}>{children}</div>
  </details>
);

// Roles the company holds - only these can Sign Once (the server re-checks).
const ONCE_ROLES = (role) => !['employee', 'manager', 'sender'].includes(role);
const FIELD_TYPES = [['text', 'Text'], ['longtext', 'Long Text'], ['number', 'Number'], ['date', 'Date'], ['email', 'Email'],
  ['phone', 'Phone'], ['yesno', 'Yes / No'], ['choice', 'Dropdown']];
const COUNTRY_NAMES = { US: 'United States', IN: 'India', CA: 'Canada', GB: 'United Kingdom', AE: 'United Arab Emirates', PH: 'Philippines', MX: 'Mexico', AU: 'Australia' };

function PreviewModal({ templateId, name, companyId, flow, letterheadId, onClose, toastErr }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let made = '';
    api.renderPacketPreview({ template_id: templateId, entity_id: companyId || '', flow, letterhead_id: letterheadId || '' })
      .then(({ blob }) => { made = URL.createObjectURL(blob); setUrl(made); })
      .catch(e => { toastErr(e?.message || 'Could not render the preview.'); onClose(); });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [templateId]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', height: 'min(92dvh, 900px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14 }}>{name} - Preview With Sample Person</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>The published version, filled with a sample person. Anything Nexus would ask for shows in [brackets].</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {url ? <iframe title="Packet document preview" src={url} style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px' }} />
          : <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>}
      </div>
    </div>
  );
}

const STEPS = [['who', 'Who It\'s For'], ['docs', 'Documents'], ['signs', 'Who Signs'], ['ready', 'Ready To Send']];

/** The editor. `packet` is a saved documents row from /hr/packets (null for a
 *  new one, or a seed like {roleIds}); `catalog` is that same response. */
export function DocumentsPacketEditor({ packet, event, eventLabel, companyId, companyName, defaultSubfolder, catalog, onClose, onSaved, toastErr }) {
  const [p, setP] = useState(() => ({
    id: packet?.engine === 'documents' ? packet.id : '',
    // A Set Up from What Each Hire Gets arrives with its place - named from it.
    name: packet?.name || (packet?.country ? [placeName(packet.country, packet.region, COUNTRY_NAMES),
      { employee: 'Employee', contractor: 'Contractor' }[packet.workerType] || '', eventLabel].filter(Boolean).join(' ') : ''),
    nameTouched: !!packet?.name,       // a typed (or saved) name is never replaced by the suggestion
    roleIds: packet?.roleIds || [],
    // Who it is for (Oct 14): employees or contractors, and where they work -
    // "if it's an Indian contractor, it needs a different document" (Neil).
    // Place first (Neil, Oct 22): a hiring packet is a place's paperwork -
    // "California employee", "India contractor" - never left to "any".
    workerType: packet?.workerType || (packet?.id || !['offer', 'hire'].includes(event) ? 'any' : ''),
    country: packet?.country || '',
    region: packet?.region || '',
    docIds: packet?.docTemplateIds || [],
    // Building blocks (Oct 14): documents added only for a team or a role -
    // each team's own confidentiality agreement (Neil).
    extraDocs: (packet?.extraDocs || []).map(({ match, value, templateIds }) => ({ match, value, templateIds: templateIds || [] })),
    flow: packet?.flow?.map(({ key, role, action, once }) => ({ key, role, action, ...(once ? { once: true } : {}) })) || [],
    detailsForm: (packet?.detailsForm || []).map(f => ({ ...f, options: f.options || [] })),
    verifyRole: packet?.verifyRole || 'hr',
    letterheadId: packet?.letterheadId || '',
    payMode: packet?.payMode || '',
    emailMessage: packet?.emailMessage || '',
    egnyteSubfolder: packet?.egnyteSubfolder || '',
  }));
  // A saved packet opens on its checklist; a new one starts at the beginning.
  const [step, setStep] = useState(packet?.engine === 'documents' ? 'ready' : 'who');
  const [tried, setTried] = useState(false);          // Continue pressed on this step - show its problems
  const [companyRoles, setCompanyRoles] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [holders, setHolders] = useState(null);
  const [letterheads, setLetterheads] = useState([]);
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState([]);
  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState('');
  const [onceStatus, setOnceStatus] = useState(packet?.signOnce || []);
  const [signing, setSigning] = useState(null);
  // Ready To Send (Oct 14): the server's checklist for the saved packet.
  const [readiness, setReadiness] = useState(packet?.engine === 'documents' ? (packet.readiness || []) : []);
  const [formNote, setFormNote] = useState('');
  const refreshReady = () => {
    if (!p.id) return;
    api.packetReadiness(p.id).then(r => setReadiness(r.readiness || [])).catch(() => {});
    if (companyId) api.signOnceStatus(p.id, companyId).then(setOnceStatus).catch(() => {});
  };
  const set = (k, v) => { setP(x => ({ ...x, [k]: v })); setServerProblems([]); };
  // Who signs once for this company, and whether they have (with isMe).
  useEffect(() => {
    if (!p.id || !companyId) return;
    api.signOnceStatus(p.id, companyId).then(setOnceStatus).catch(() => {});
  }, [p.id, companyId]);

  useEffect(() => {
    api.hiringOptions(companyId || '').then(o => { setCompanyRoles(o.roles || []); setDepartments(o.departments || []); })
      .catch(() => setCompanyRoles([]));
  }, [companyId]);
  useEffect(() => { api.packetRoleHolders(companyId || '').then(setHolders).catch(() => setHolders({})); }, [companyId]);
  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);

  const templates = useMemo(() => catalog?.docTemplates || [], [catalog]);
  const byId = useMemo(() => Object.fromEntries(templates.map(t => [t.id, t])), [templates]);
  const docs = p.docIds.map(id => byId[id] || { id, name: 'A template that is no longer active', missing: true, signs: [] });
  const roleOpts = catalog?.flowRoles || [];
  const verifyOpts = catalog?.verifyRoles || [];
  const actionOpts = catalog?.actions || [];
  const who = event === 'offer' ? 'candidate' : event === 'hire' ? 'new hire' : event === 'promotion' ? 'employee' : 'person leaving';
  const today = (role) => {
    if (role === 'employee') return `the ${who}${['offer', 'hire'].includes(event) ? ' - no login needed' : ''}`;
    if (role === 'manager') return ['offer', 'hire'].includes(event) ? 'the supervisor on the offer' : 'their manager';
    if (role === 'sender') return 'whoever starts it';
    if (!holders) return '...';
    const h = holders[role];
    return h?.email ? `today: ${h.name}` : 'nobody holds this yet';
  };

  const setDocs = (ids) => {
    const nextDocs = ids.map(id => byId[id]).filter(Boolean);
    setP(x => ({ ...x, docIds: ids, flow: flowFor(x.flow, nextDocs, event) }));
    setServerProblems([]);
  };
  const move = (list, i, d) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return list; [n[i], n[j]] = [n[j], n[i]]; return n; };
  const setFlowStep = (i, patch) => set('flow', p.flow.map((s, j) => j === i ? { ...s, ...patch } : s));
  const addFlowStep = () => {
    let key = 'copy'; let n = 1;
    while (p.flow.some(s => s.key === key)) { n += 1; key = `copy_${n}`; }
    const at = p.flow.findIndex(s => s.role === 'employee');
    const row = { key, role: 'hr', action: 'copy' };
    set('flow', at >= 0 && event !== 'promotion' ? [...p.flow.slice(0, at), row, ...p.flow.slice(at)] : [...p.flow, row]);
  };

  // ── Details Form ──
  const formKeys = new Set(p.detailsForm.map(f => f.key || formKey(f.label)).filter(Boolean));
  const wanted = [];
  docs.forEach(d => (d.variables || []).forEach(v => {
    if (!formKeys.has(v.token) && !wanted.some(w => w.token === v.token)) wanted.push(v);
  }));
  const setField = (i, patch) => set('detailsForm', p.detailsForm.map((f, j) => j === i ? { ...f, ...patch } : f));
  // The checklist's "Add To Details Form": every variable nothing fills, in one go.
  const addVariables = (vars) => {
    const have = new Set(p.detailsForm.map(f => f.key || formKey(f.label)));
    const add = vars.filter(v => !have.has(v.token)).map(v => ({ key: v.token, label: v.label, required: true, sensitive: false, last4: false, options: [],
      type: ['date', 'email', 'number'].includes(v.type) ? v.type : 'text' }));
    if (add.length) set('detailsForm', [...p.detailsForm, ...add]);
    setFormNote(`Added ${add.length} field${add.length === 1 ? '' : 's'} to the form on the Documents step - click Save Packet to keep them.`);
  };
  const summary = readinessSummary(readiness);
  const addField = (f) => set('detailsForm', [...p.detailsForm, { label: '', type: 'text', required: false, sensitive: false, last4: false, options: [], ...f }]);

  // Quick checks per step; the server's full list arrives on Save.
  const problemsFor = {
    who: [
      !p.name.trim() && 'Give the packet a name.',
      event === 'hire' && !p.country && 'Pick where these hires work - hiring paperwork is different in each place.',
      ['offer', 'hire'].includes(event) && !p.workerType && 'Pick employees or contractors.',
    ],
    docs: [
      !p.docIds.length && 'Add at least one document.',
      ...docs.filter(d => !d.missing && !d.publishedVersion).map(d => `"${d.name}" is not published yet - open it in Documents and click Publish.`),
      ...p.detailsForm.map(f => !String(f.label || '').trim() && 'Every field on the form needs a label.'),
      ...p.extraDocs.map(r => (r.value || r.templateIds.length) && !r.value && 'Pick the team or role each added document is for.'),
      ...p.extraDocs.map(r => r.value && !r.templateIds.length && `Add a document for ${r.match === 'role' ? (companyRoles || []).find(x => x.id === r.value)?.name || 'the role' : r.value}, or remove that row.`),
    ],
    signs: [!p.flow.some(s => s.role === 'employee') && `One step must be The Person (the ${who}).`],
    ready: [],
  };
  const stepProblems = (k) => [...new Set(problemsFor[k].filter(Boolean))];
  const allLocal = STEPS.flatMap(([k]) => stepProblems(k));
  const stepIndex = STEPS.findIndex(([k]) => k === step);
  const shown = tried ? [...stepProblems(step), ...serverProblems] : serverProblems;

  const goTo = (k) => { setStep(k); setTried(false); setServerProblems([]); };
  const next = () => {
    if (stepProblems(step).length) { setTried(true); return; }
    goTo(STEPS[stepIndex + 1][0]);
  };
  async function save() {
    // Everything checked before saving - the first problem opens its step.
    const bad = STEPS.find(([k]) => stepProblems(k).length);
    if (bad) { setStep(bad[0]); setTried(true); return; }
    setBusy(true);
    try {
      const saved = await api.saveDocumentsPacket({
        id: p.id, entity_id: companyId || '', event, name: p.name.trim(), role_ids: p.roleIds,
        worker_type: p.workerType, country: p.country, region: p.country === 'US' ? p.region : '',
        extra_docs: p.extraDocs.filter(r => r.value || r.templateIds.length),
        doc_template_ids: p.docIds, flow: p.flow, verify_role: p.verifyRole, letterhead_id: p.letterheadId,
        pay_mode: p.payMode, email_message: p.emailMessage, egnyte_subfolder: p.egnyteSubfolder,
        details_form: event === 'hire' ? p.detailsForm.map(({ key, label, type, required, sensitive, last4, options, help }) => ({
          key: key || '', label, type, required: !!required, sensitive: !!sensitive, last4: !!last4, options: options || [], help: help || '',
        })) : [],
      });
      // Stay open on the checklist: what is still missing shows at once.
      setP(x => ({ ...x, id: saved.id }));
      setReadiness(saved.readiness || []);
      setStep('ready'); setTried(false);
      onSaved(saved);
    } catch (e) {
      setServerProblems([e?.message || 'Could not save the packet.']);
    }
    setBusy(false);
  }
  const openTemplate = (id) => {
    setPendingOpen('doc-template', id);
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-templates' } }));
  };
  const available = templates.filter(t => !p.docIds.includes(t.id));
  // What the documents ask by themselves (Oct 14): the person's questions go
  // on their form, HR's are asked when the offer is made.
  const asked = { person: [], hr: [] };
  docs.forEach(d => {
    (d.personQuestions || []).forEach(l => { if (!asked.person.includes(l)) asked.person.push(l); });
    (d.hrQuestions || []).forEach(l => { if (!asked.hr.includes(l)) asked.hr.push(l); });
  });
  const countries = [...new Set([...(catalog?.countries || ['US', 'IN']), p.country].filter(Boolean))];
  const verifyHolder = holders && holders[p.verifyRole];

  // ── the steps ──
  // The name says the place and the hire (Neil, Oct 22) until HR types one.
  const suggestedName = () => {
    const place = placeName(p.country, p.region, COUNTRY_NAMES);
    const who = { employee: 'Employee', contractor: 'Contractor' }[p.workerType] || '';
    return [place, who, eventLabel].filter(Boolean).join(' ');
  };
  const setPlace = (patch) => setP(x => {
    const next = { ...x, ...patch };
    if (!next.nameTouched) {
      const place = placeName(next.country, next.region, COUNTRY_NAMES);
      const who = { employee: 'Employee', contractor: 'Contractor' }[next.workerType] || '';
      if (place || who) next.name = [place, who, eventLabel].filter(Boolean).join(' ');
    }
    return next;
  });
  const placeEvent = ['offer', 'hire'].includes(event);
  const whoStep = (
    <>
      <h2 style={h2}>Who is this {eventLabel.toLowerCase()} for?</h2>
      <p style={lead}>
        {placeEvent
          ? `One ${eventLabel.toLowerCase()} per place and kind of hire - for example California employees, India contractors. Nexus sends it to every role hired there and fills in each person's own details.`
          : 'Nexus picks it by itself for each person from these answers.'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 18px' }}>
        <div>
          <label style={lbl} htmlFor="pk-country">Works In</label>
          <select id="pk-country" className="form-input" style={{ width: '100%' }} value={p.country}
            onChange={e => setPlace({ country: e.target.value, region: e.target.value === 'US' ? p.region : '' })}>
            <option value="">{event === 'hire' ? 'Pick a country' : 'Any Country'}</option>
            {countries.map(k => <option key={k} value={k}>{COUNTRY_NAMES[k] || k}</option>)}
          </select>
        </div>
        {p.country === 'US' && (
          <div>
            <label style={lbl} htmlFor="pk-region">State</label>
            <select id="pk-region" className="form-input" style={{ width: '100%' }} value={p.region} onChange={e => setPlace({ region: e.target.value })}>
              <option value="">Anywhere In The US</option>
              {Object.entries(US_STATE_NAMES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </select>
          </div>
        )}
        {placeEvent && (
          <div>
            <label style={lbl} htmlFor="pk-wt">Hired As</label>
            <select id="pk-wt" className="form-input" style={{ width: '100%' }} value={p.workerType} onChange={e => setPlace({ workerType: e.target.value })}>
              {!p.workerType && <option value="">Pick one</option>}
              <option value="employee">Employees</option>
              <option value="contractor">Contractors</option>
              <option value="any">Employees And Contractors</option>
            </select>
          </div>
        )}
      </div>
      {placeEvent && (
        <div style={hint}>
          {event === 'offer' ? "HR says employee or contractor when making the offer - a contractor's letter never says employment. "
            : 'Picked from what HR answered on the offer, once it is signed. '}
          A state picked here wins over &quot;Anywhere In The US&quot; for people who work in that state.
        </div>
      )}
      <label style={lbl} htmlFor="pk-name">Name</label>
      <input id="pk-name" className="form-input" style={{ width: '100%', fontSize: 14 }} value={p.name}
        onChange={e => setP(x => ({ ...x, name: e.target.value, nameTouched: true }))}
        placeholder={suggestedName() || `e.g. California Employee ${eventLabel}`} autoFocus={!p.id} />
      <details open={p.roleIds.length > 0} style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Only For One Role{p.roleIds.length ? ' (On)' : ' (Usually Off)'}</summary>
        <div style={{ ...hint, marginTop: 6 }}>
          Leave this off: the same {eventLabel.toLowerCase()} goes to every role hired in this place, and each person&apos;s role, job description and
          role documents are filled in for them. Turn it on only when one role truly needs different paperwork - it still applies only to the place above.
        </div>
        {companyRoles === null ? <Spinner size={14} /> : (
          <select id="pk-role" aria-label="Only for this role" className="form-input" style={{ width: '100%', marginTop: 6 }} value={p.roleIds[0] || ''} onChange={e => set('roleIds', e.target.value ? [e.target.value] : [])}>
            <option value="">Every role</option>
            <optgroup label={`${companyName || 'Company'} Roles`}>
              {companyRoles.filter(r => r.companyId).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
            </optgroup>
            <optgroup label="Shared Roles">
              {companyRoles.filter(r => !r.companyId).map(r => <option key={r.id} value={r.id}>{r.name}{r.department ? ` - ${r.department}` : ''}</option>)}
            </optgroup>
          </select>
        )}
      </details>
    </>
  );

  const docRow = (d, i) => (
    <div key={d.id} style={{ ...card, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--mist)', fontSize: 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
      <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
          {d.missing ? <Chip tone="red">Not Available</Chip>
            : !d.publishedVersion ? <Chip tone="orange" title="Open it in Documents and click Publish">Not Published</Chip>
              : <Chip tone="green">Published v{d.publishedVersion}</Chip>}
          {d.hasUnpublishedChanges && <Chip tone="orange" title="Someone is editing it - packets keep the published version until Publish Changes">Unpublished Changes</Chip>}
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {(d.signs || []).length ? `Signed by: ${d.signs.map(keyLabel).join(', ')}` : 'No signature spots'}
          </span>
        </div>
      </div>
      {!d.missing && d.publishedVersion > 0 && (
        <button type="button" className="secondary-btn" onClick={() => setPreview(d)} style={smallBtn} title="See it filled with a sample person"><Eye size={12} /> Preview</button>
      )}
      {!d.missing && (
        <button type="button" className="secondary-btn" onClick={() => openTemplate(d.id)} title="Change the wording in Documents" style={iconBtn} aria-label="Open in Documents"><ExternalLink size={13} /></button>
      )}
      <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => setDocs(move(p.docIds, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
      <button type="button" className="secondary-btn" disabled={i === docs.length - 1} onClick={() => setDocs(move(p.docIds, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
      <button type="button" className="secondary-btn" onClick={() => setDocs(p.docIds.filter(x => x !== d.id))} style={iconBtn} aria-label="Remove document"><Trash2 size={13} /></button>
    </div>
  );

  const docsStep = (
    <>
      <h2 style={h2}>Which documents go out?</h2>
      <p style={lead}>Each one is a template from Documents &gt; Templates, in this order. {event === 'offer' ? 'An offer is one document, signed by both sides.' : `The Job Description is added per ${who} when the offer is made.`}</p>
      <div style={{ marginTop: 16 }}>
        {docs.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12, padding: '18px 16px', textAlign: 'center' }}>
            No documents yet - pick one below.
          </div>
        )}
        {docs.map(docRow)}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <select className="form-input" style={{ flex: '1 1 260px' }} value={adding} onChange={e => setAdding(e.target.value)} aria-label="Pick a template to add">
          <option value="">{available.length ? 'Pick a template to add...' : 'Every active template is already in this packet'}</option>
          {available.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
        </select>
        <button type="button" className="primary-btn" disabled={!adding} onClick={() => { setDocs([...p.docIds, adding]); setAdding(''); }} style={smallBtn}><Plus size={13} /> Add Document</button>
      </div>

      {(asked.person.length > 0 || asked.hr.length > 0) && (
        <div style={{ ...card, marginTop: 18, background: 'var(--mist)', fontSize: 13, lineHeight: 1.6 }}>
          {asked.hr.length > 0 && <div><b>HR answers when making the offer:</b> {asked.hr.join(', ')}</div>}
          {asked.person.length > 0 && <div><b>The {who} is asked on their form:</b> {asked.person.join(', ')}</div>}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>These come from the templates themselves - nothing to set up here.</div>
        </div>
      )}

      {['offer', 'hire'].includes(event) && (
        <More title={`Documents for one team or role only${p.extraDocs.length ? ` (${p.extraDocs.length})` : ''}`} open={p.extraDocs.length > 0}>
          <div style={hint}>Like each team's own confidentiality agreement - added only for people in that team or role, so one packet covers everyone.</div>
          <datalist id="pk-departments">{departments.map(d => <option key={d} value={d} />)}</datalist>
          {p.extraDocs.map((r, i) => {
            const setRow = (patch) => set('extraDocs', p.extraDocs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            const left = templates.filter(t => !r.templateIds.includes(t.id));
            return (
              <div key={i} style={{ ...card, marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select className="form-input" style={{ width: 110 }} value={r.match} onChange={e => setRow({ match: e.target.value, value: '' })} aria-label="Team or role">
                    <option value="department">Team</option><option value="role">Role</option>
                  </select>
                  {r.match === 'role' ? (
                    <select className="form-input" style={{ flex: '1 1 220px' }} value={r.value} onChange={e => setRow({ value: e.target.value })} aria-label="Which role">
                      <option value="">- pick the role -</option>
                      {(companyRoles || []).map(x => <option key={x.id} value={x.id}>{x.name}{x.department ? ` - ${x.department}` : ''}</option>)}
                    </select>
                  ) : (
                    <input className="form-input" list="pk-departments" style={{ flex: '1 1 220px' }} value={r.value} placeholder="Team, e.g. Administration"
                      onChange={e => setRow({ value: e.target.value })} aria-label="Which team" />
                  )}
                  <button type="button" className="secondary-btn" onClick={() => set('extraDocs', p.extraDocs.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove row"><Trash2 size={13} /></button>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                  {r.templateIds.map(id => (
                    <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, border: '1px solid var(--line)', borderRadius: 999, padding: '4px 6px 4px 10px' }}>
                      <FileText size={12} style={{ color: 'var(--pine)' }} /> {byId[id]?.name || 'A template that is no longer active'}
                      <button type="button" onClick={() => setRow({ templateIds: r.templateIds.filter(x => x !== id) })} aria-label="Remove document"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2 }}><X size={11} /></button>
                    </span>
                  ))}
                  <select className="form-input" style={{ flex: '1 1 220px', maxWidth: 360 }} value="" aria-label="Add a document for this team or role"
                    onChange={e => e.target.value && setRow({ templateIds: [...r.templateIds, e.target.value] })}>
                    <option value="">{left.length ? 'Add a document...' : 'No more templates'}</option>
                    {left.map(t => <option key={t.id} value={t.id}>{t.name}{t.publishedVersion ? '' : ' (Not Published)'}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
          <button type="button" className="secondary-btn" onClick={() => set('extraDocs', [...p.extraDocs, { match: 'department', value: '', templateIds: [] }])}
            style={{ ...smallBtn, marginTop: 10 }}><Plus size={12} /> Add For A Team Or Role</button>
        </More>
      )}

      {event === 'hire' && (
        <More title={`Ask the new hire for more on their form${p.detailsForm.length ? ` (${p.detailsForm.length})` : ''}`} open={p.detailsForm.length > 0 || wanted.length > 0}>
          <div style={hint}>Name, phone, address and emergency contact are always asked, and so is anything the templates mark Ask The Person. Add fields here only for something else - each one is a variable the templates can print.</div>
          {wanted.length > 0 && (
            <div style={{ border: '1.5px dashed var(--line)', borderRadius: 12, padding: '10px 12px', marginTop: 10, fontSize: 13 }}>
              Your documents print these, and nothing fills them yet:
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {wanted.map(v => (
                  <button key={v.token} type="button" className="secondary-btn" onClick={() => addField({ key: v.token, label: v.label, type: ['date', 'email', 'number'].includes(v.type) ? v.type : 'text' })}
                    style={{ fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plus size={11} /> {v.label}</button>
                ))}
              </div>
            </div>
          )}
          {p.detailsForm.map((f, i) => f.type === 'heading' ? (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <Heading size={14} style={{ color: 'var(--muted)' }} />
              <input className="form-input" style={{ flex: 1, fontWeight: 700 }} value={f.label} placeholder="Section heading, e.g. Bank Details" onChange={e => setField(i, { label: e.target.value })} />
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('detailsForm', move(p.detailsForm, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === p.detailsForm.length - 1} onClick={() => set('detailsForm', move(p.detailsForm, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" onClick={() => set('detailsForm', p.detailsForm.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove heading"><Trash2 size={13} /></button>
            </div>
          ) : (
            <div key={i} style={{ ...card, marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="form-input" style={{ flex: '1 1 200px' }} value={f.label} placeholder="Label, e.g. PAN Number" onChange={e => setField(i, { label: e.target.value })} aria-label="Field label" />
                <select className="form-input" style={{ width: 140 }} value={f.type} onChange={e => setField(i, { type: e.target.value, ...(e.target.value === 'text' || e.target.value === 'number' ? {} : { last4: false }) })} aria-label="Field type">
                  {FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <code style={{ fontSize: 11.5, color: 'var(--muted)' }}>{`{{${f.key || formKey(f.label) || '...'}}}`}</code>
                <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('detailsForm', move(p.detailsForm, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
                <button type="button" className="secondary-btn" disabled={i === p.detailsForm.length - 1} onClick={() => set('detailsForm', move(p.detailsForm, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
                <button type="button" className="secondary-btn" onClick={() => set('detailsForm', p.detailsForm.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove field"><Trash2 size={13} /></button>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5 }}>
                {[['required', 'Required', 'They cannot send the form without it'],
                  ['sensitive', 'Private', 'Bank details, ID numbers: only people with Pay & Benefits access see it'],
                  ...(f.type === 'text' || f.type === 'number' ? [['last4', 'Keep Last 4 Only', 'Only the last 4 characters are kept and printed (XXXX 1234)']] : [])].map(([k, l, t]) => (
                  <label key={k} title={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!f[k]} onChange={e => setField(i, { [k]: e.target.checked })} style={{ accentColor: 'var(--pine)' }} /> {l}
                  </label>
                ))}
              </div>
              {f.type === 'choice' && (
                <input className="form-input" style={{ width: '100%', marginTop: 10 }} placeholder="Choices, separated by commas - e.g. Savings, Current"
                  value={(f.options || []).join(', ')} onChange={e => setField(i, { options: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} aria-label="Choices" />
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={() => addField({})} style={smallBtn}><Plus size={12} /> Add Field</button>
            <button type="button" className="secondary-btn" onClick={() => addField({ type: 'heading' })} style={smallBtn}><Heading size={12} /> Add Section Heading</button>
          </div>
        </More>
      )}
    </>
  );

  const signsStep = (
    <>
      <h2 style={h2}>Who signs, and who checks?</h2>
      <p style={lead}>Set by role, never by name - change who holds a role in People and every packet follows. {event !== 'promotion' && `The ${who} signs last.`}</p>
      <div style={{ marginTop: 16 }}>
        {p.flow.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Add a document first - each signature spot in it becomes a step here.</div>}
        {p.flow.map((s, i) => (
          <div key={s.key} style={{ ...card, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--mist)', fontSize: 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: '1 1 140px', minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }} title={`Signature spots for "${s.key}"`}>{keyLabel(s.key)}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{today(s.role)}</div>
            </div>
            <select className="form-input" style={{ width: 180 }} value={s.role} onChange={e => setFlowStep(i, { role: e.target.value })} aria-label="Role">
              {roleOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <select className="form-input" style={{ width: 130 }} value={s.action} onChange={e => setFlowStep(i, { action: e.target.value })} aria-label="Action">
              {actionOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {s.action === 'sign' && ONCE_ROLES(s.role) && (
              <label title="The company signs this packet once - that signature then goes on every packet by itself"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={!!s.once} onChange={e => setFlowStep(i, { once: e.target.checked || undefined })} style={{ accentColor: 'var(--pine)' }} />
                Signs Once
              </label>
            )}
            <span style={{ display: 'inline-flex', gap: 4 }}>
              <button type="button" className="secondary-btn" disabled={i === 0} onClick={() => set('flow', move(p.flow, i, -1))} style={iconBtn} aria-label="Move up"><ChevronUp size={13} /></button>
              <button type="button" className="secondary-btn" disabled={i === p.flow.length - 1} onClick={() => set('flow', move(p.flow, i, 1))} style={iconBtn} aria-label="Move down"><ChevronDown size={13} /></button>
              <button type="button" className="secondary-btn" onClick={() => set('flow', p.flow.filter((_, j) => j !== i))} style={iconBtn} aria-label="Remove step"><Trash2 size={13} /></button>
            </span>
          </div>
        ))}
        <button type="button" className="secondary-btn" onClick={addFlowStep} style={smallBtn}><Plus size={12} /> Add Someone Who Approves Or Gets A Copy</button>
      </div>

      {p.flow.some(s => s.once) && (
        <div style={{ marginTop: 18 }}>
          <label style={lbl}>Company Signature (Signs Once)</label>
          {!p.id || !companyId ? (
            <div style={hint}>{!p.id ? 'Save the packet, then the person who holds the role signs it once here.'
              : 'This packet is for every company - each company\'s signer signs once, the first time it is sent for them.'}</div>
          ) : onceStatus.map(s => (
            <div key={s.key} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <PenTool size={15} style={{ color: s.signed ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', flexShrink: 0 }} />
              <div style={{ flex: '1 1 240px', fontSize: 13 }}>
                <b>{s.roleLabel}</b> - {s.name || 'nobody holds this role yet'}
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {s.signed ? `Signed once on ${formatDate(s.adoptedAt)} - goes on every packet by itself.`
                    : s.previous ? `${s.previous.name} signed before, but ${s.name || 'someone else'} holds ${s.roleLabel} now - they sign once before the next packet can go.`
                      : 'Not signed yet - nothing can be sent until they sign once.'}
                </div>
              </div>
              {s.signed ? <Chip tone="green">Signed</Chip> : s.isMe
                ? <button type="button" className="primary-btn" onClick={() => setSigning(s)} style={smallBtn}><PenTool size={12} /> Sign Once</button>
                : <Chip tone="orange">Waiting For {s.name || s.roleLabel}</Chip>}
            </div>
          ))}
        </div>
      )}

      <label style={lbl} htmlFor="pk-verify">Checked By</label>
      <select id="pk-verify" className="form-input" style={{ width: '100%', maxWidth: 360 }} value={p.verifyRole} onChange={e => set('verifyRole', e.target.value)}>
        {verifyOpts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      <div style={hint}>Reads every filled-in document before anything goes out, and is the only one who can send it{verifyHolder?.email ? ` - today: ${verifyHolder.name}` : holders ? ' - nobody holds this role yet' : ''}.</div>

      <More title="More Options">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 18px' }}>
          <div>
            <label style={lbl} htmlFor="pk-lh">Letterhead</label>
            <select id="pk-lh" className="form-input" style={{ width: '100%' }} value={p.letterheadId} onChange={e => set('letterheadId', e.target.value)}>
              <option value="">Template's Own</option>
              {letterheads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <div style={hint}>For templates that need one.</div>
          </div>
          <div>
            <label style={lbl} htmlFor="pk-pay">Who Can Open These Documents</label>
            <select id="pk-pay" className="form-input" style={{ width: '100%' }} value={p.payMode} onChange={e => set('payMode', e.target.value)}>
              <option value="">{event === 'separation' ? 'Everyone, unless a document prints pay' : 'Pay & Benefits only (they show pay)'}</option>
              <option value="always">Pay &amp; Benefits only</option>
              <option value="auto">Everyone, unless a document prints pay</option>
            </select>
            <div style={hint}>Changing this needs Pay &amp; Benefits access.</div>
          </div>
          <div>
            <label style={lbl} htmlFor="pk-note">Note In The Email</label>
            <textarea id="pk-note" className="form-input" rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'Inter,sans-serif', fontSize: 13 }}
              placeholder="Welcome to the team! Please review and sign your documents."
              value={p.emailMessage} onChange={e => set('emailMessage', e.target.value)} />
          </div>
          <div>
            <label style={lbl} htmlFor="pk-folder">Egnyte Folder</label>
            <input id="pk-folder" className="form-input" style={{ width: '100%' }} value={p.egnyteSubfolder} onChange={e => set('egnyteSubfolder', e.target.value)} placeholder={defaultSubfolder || 'Hiring Documents'} />
            <div style={hint}>Inside the {who}'s own folder.</div>
          </div>
        </div>
      </More>
    </>
  );

  const readyStep = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
        <h2 style={{ ...h2, margin: 0 }}>Ready To Send?</h2>
        {summary && <Chip tone={summary.tone}>{summary.label}</Chip>}
      </div>
      <p style={{ ...lead, marginTop: 4 }}>Everything a {who} needs before this can go out. Anything not done has its fix right here.</p>
      <div style={{ marginTop: 14 }}>
        {readiness.length === 0 ? <Spinner size={16} /> : (
          <PacketReadiness checks={readiness} toastErr={toastErr}
            meEmails={onceStatus.filter(s => s.isMe).map(s => s.email)}
            onChanged={refreshReady}
            onSignOnce={(step) => setSigning(onceStatus.find(s => s.key === step) || { key: step, roleLabel: 'HR', name: '' })}
            onAddToForm={(vars) => { addVariables(vars); setStep('docs'); }} />
        )}
      </div>
      {formNote && <div style={{ ...hint, color: 'hsl(var(--color-orange))' }}>{formNote}</div>}
      <div style={{ ...card, marginTop: 18, background: 'var(--mist)', fontSize: 13, lineHeight: 1.6 }}>
        <b>When it is signed:</b>{' '}
        {event === 'offer' ? 'they are hired - their People record and onboarding checklist start - and their hiring packet goes out to them by itself.'
          : event === 'hire' ? 'their onboarding paperwork is complete and shows on their checklist.'
            : event === 'promotion' ? 'the new role, title and pay apply from the effective date.'
              : 'their offboarding checklist starts.'}
      </div>
    </>
  );

  const body = { who: whoStep, docs: docsStep, signs: signsStep, ready: readyStep }[step];
  const last = step === 'signs';

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 18, width: 'max(min(100%, 560px), 60vw)', maxWidth: '100%', minHeight: 'min(60vh, 90dvh)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '18px 28px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 17 }}>{p.id ? p.name || eventLabel : `New ${eventLabel}`}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{companyName}</div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
          {/* The step bar - every step is a button, so a saved packet can be changed from anywhere. */}
          <div role="tablist" aria-label="Setup steps" style={{ display: 'flex', gap: 4, marginTop: 16, borderBottom: '1px solid var(--line)', overflowX: 'auto' }} className="scroll-tabs">
            {STEPS.map(([k, label], i) => {
              const on = k === step;
              const done = p.id ? true : i < stepIndex;
              const locked = k === 'ready' && !p.id;
              return (
                <button key={k} type="button" role="tab" aria-selected={on} disabled={locked} onClick={() => !locked && goTo(k)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px 10px', border: 'none', borderBottom: `2px solid ${on ? 'var(--pine)' : 'transparent'}`, background: 'none',
                    cursor: locked ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 800 : 600, color: on ? 'var(--ink)' : locked ? 'var(--line)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                  <span style={{ width: 20, height: 20, borderRadius: 10, fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: on ? 'var(--pine)' : done ? 'hsla(var(--color-green),0.15)' : 'var(--mist)', color: on ? '#fff' : done ? 'hsl(var(--color-green))' : 'var(--muted)' }}>
                    {done && !on ? <Check size={11} /> : i + 1}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 28px 24px' }}>
          {body}
          {shown.map(x => <Problem key={x}>{x}</Problem>)}
        </div>

        <div style={{ padding: '14px 28px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {stepIndex > 0 && step !== 'ready' && (
            <button type="button" className="secondary-btn" onClick={() => goTo(STEPS[stepIndex - 1][0])} style={smallBtn}><ArrowLeft size={13} /> Back</button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>{step === 'ready' ? 'Done' : 'Cancel'}</button>
          {step === 'ready' ? (
            <button type="button" className="secondary-btn" onClick={() => goTo('who')} style={smallBtn}>Change Setup</button>
          ) : last || p.id ? (
            <button type="button" className="primary-btn" onClick={save} disabled={busy} style={smallBtn}
              title={allLocal.length ? allLocal[0] : ''}>
              {busy ? <Spinner size={13} /> : <CheckCircle size={13} />} Save Packet
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={next} style={smallBtn}>Continue <ArrowRight size={13} /></button>
          )}
        </div>
      </div>
      {signing && (
        <SignOnceModal packetId={p.id} entityId={companyId} step={signing} packetName={p.name} companyName={companyName}
          toastErr={toastErr} onClose={() => setSigning(null)} onDone={(status) => { setOnceStatus(status); setSigning(null); refreshReady(); }} />
      )}
      {preview && (
        <PreviewModal templateId={preview.id} name={preview.name} companyId={companyId} flow={p.flow}
          letterheadId={p.letterheadId} toastErr={toastErr} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
