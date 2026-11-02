// Job openings (Neil, Oct 27 2026) - People > Hiring > Openings. An approved
// headcount request becomes a Draft opening; HR writes the public job
// description, sets where the job is, and opens it - an Open opening is on
// the company's careers page (/careers/<company>) with schema.org JobPosting
// data search engines read. Candidates link to an opening; the last seat
// hired marks it Filled.
//
// Job boards: Nexus does not post to LinkedIn or Indeed (LinkedIn's posting
// API is closed to new partners; Indeed takes direct posts only from approved
// partners). Post On LinkedIn copies a ready posting and opens LinkedIn's own
// job form; Sponsor On Indeed opens Indeed's employer site. The boards come
// from the server (hiring_openings.BOARDS) - the seam for a real API later.
//
// Pay: the range and the public pay toggle (off by default) are Pay &
// Benefits only - the server refuses anyone else.
//
// Headcount Requests are off per company until Settings turns them on (Neil,
// Oct 30 2026). For a company with them off HR starts an opening by hand
// (New Opening, `directCompanies` from GET /hiring/headcount/meta); where
// they are on, an opening still comes only from an approved request.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, Copy, ExternalLink, Share2, Megaphone, Save, Plus } from 'lucide-react';
import { api } from '../../api';
import { Modal, DateField, PersonSelect } from '../../tasks/components';
import { StatusLabel } from '../StatusLabel';
import { SkeletonBlocks, ErrorBanner, Spinner } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { currencyOptions } from '../../asset/lib/currency';
import { usePeopleDirectory } from '../../lib/queries';
import JobDescription from './JobDescription';

const OPENING_STATUS = {
  draft: { label: 'Draft', color: '#64748b' },
  open: { label: 'Open', color: '#16a34a' },
  paused: { label: 'Paused', color: '#d97706' },
  filled: { label: 'Filled', color: '#2563eb' },
  closed: { label: 'Closed', color: '#6b7280' },
};
// The moves HR makes by hand (routers/hiring._MOVES).
const MOVES = {
  draft: [['open', 'Open On Careers Page']], open: [['paused', 'Pause'], ['closed', 'Close']],
  paused: [['open', 'Reopen'], ['closed', 'Close']], filled: [['open', 'Reopen']], closed: [['open', 'Reopen']],
};
const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' };
const hint = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export default function JobOpenings({ toastOk, toastErr, canSeePay = false, onFilterPipeline, directCompanies = [], onCreated }) {
  const [rows, setRows] = useState(null);
  const [links, setLinks] = useState([]);
  const [loadErr, setLoadErr] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [show, setShow] = useState('active');
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    setLoadErr(false);
    api.listOpenings().then(setRows).catch(() => setLoadErr(true));
    api.careersLinks().then(setLinks).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (rows || []).filter(o => (show === 'active' ? ['draft', 'open', 'paused'].includes(o.status) : true)), [rows, show]);
  const open = rows?.find(o => o.id === openId) || null;

  if (loadErr) return <ErrorBanner message="Couldn't load job openings right now." onRetry={load} />;
  if (rows === null) return <SkeletonBlocks count={3} height={64} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 4 }}>
          {[['active', 'Active'], ['all', 'All']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={show === k} onClick={() => setShow(k)}
              className={show === k ? 'primary-btn' : 'secondary-btn'} style={{ fontSize: 12.5, padding: '5px 12px' }}>{label}</button>
          ))}
        </div>
        {directCompanies.length > 0
          ? <button type="button" className="primary-btn" onClick={() => setStarting(true)}
            style={{ marginLeft: 'auto', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={14} /> New Opening</button>
          : <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>New openings come from approved headcount requests.</span>}
      </div>

      {shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <Briefcase size={30} style={{ opacity: .25, display: 'block', margin: '0 auto 10px' }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>No job openings yet.</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>{directCompanies.length > 0 ? 'Start one with New Opening.' : 'An approved headcount request becomes a Draft opening here.'}</div>
        </div>
      ) : (
        <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(o => (
            <div key={o.id} role="listitem" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setOpenId(o.id)} style={{ flex: '1 1 260px', minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{o.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {[o.companyName, o.department, o.locationLine, o.employmentLabel].filter(Boolean).join(' · ')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {o.counts.hired || 0} of {o.seats} hired · {o.counts.total || 0} candidate{o.counts.total === 1 ? '' : 's'}
                  {o.status === 'open' && o.validThrough ? ` · on the careers page until ${formatDate(o.validThrough)}` : ''}
                </div>
              </button>
              {onFilterPipeline && o.counts.total > 0 && (
                <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => onFilterPipeline(o.id)}>View Candidates</button>
              )}
              <StatusLabel label={OPENING_STATUS[o.status]?.label || o.status} color={OPENING_STATUS[o.status]?.color} />
            </div>
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div style={{ marginTop: 18, border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px' }}>
          <div style={{ ...FL, marginBottom: 6 }}>Careers Pages</div>
          {links.map(l => (
            <div key={l.companyId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap', fontSize: 12.5 }}>
              <b style={{ minWidth: 140 }}>{l.name}</b>
              <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: 'hsl(var(--color-blue))', wordBreak: 'break-all' }}>{l.url}</a>
              <button className="secondary-btn" style={{ fontSize: 11.5, padding: '2px 8px' }}
                onClick={async () => (await copyText(l.url) ? toastOk?.('Careers page link copied.') : toastErr?.('Could not copy - select the link instead.'))}>Copy Link</button>
            </div>
          ))}
          <div style={hint}>Link these from each company&apos;s website. Open openings show there by themselves.</div>
        </div>
      )}

      {starting && <NewOpening companies={directCompanies} toastErr={toastErr} onClose={() => setStarting(false)}
        onCreated={(o) => { setStarting(false); setRows(prev => [o, ...(prev || [])]); setOpenId(o.id); onCreated?.(); toastOk?.('Draft opening started - add the description and where the job is, then open it.'); }} />}
      {open && <OpeningEditor o={open} canSeePay={canSeePay} onClose={() => setOpenId(null)} toastOk={toastOk} toastErr={toastErr}
        onSaved={u => setRows(prev => prev.map(x => (x.id === u.id ? u : x)))} />}
    </div>
  );
}

function formOf(o) {
  return { title: o.title, description: o.description, department: o.department, employment_type: o.employmentType,
    seats: o.seats, location: o.location, street: o.street, city: o.city, region: o.region, postal_code: o.postalCode,
    country: o.country, remote: o.remote, valid_through: o.validThrough, hiring_owner_email: o.hiringOwnerEmail,
    pay_min: o.payMin ?? '', pay_max: o.payMax ?? '', pay_currency: o.payCurrency || 'USD', pay_period: o.payPeriod || 'year' };
}

export function OpeningEditor({ o, canSeePay, onClose, onSaved, toastOk, toastErr }) {
  const [f, setF] = useState(() => formOf(o));
  const [base, setBase] = useState(() => JSON.stringify(formOf(o)));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const { data: people = [] } = usePeopleDirectory();
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const dirty = JSON.stringify(f) !== base;
  const pickRows = useMemo(() => people.filter(p => p.email).map(p => ({ email: p.email.toLowerCase(), name: p.name || p.email })), [people]);

  function body() {
    const out = { title: f.title.trim(), description: f.description, department: f.department, employment_type: f.employment_type,
      seats: Number(f.seats) || 1, location: f.location, street: f.street, city: f.city, region: f.region, postal_code: f.postal_code,
      country: (f.country || '').toUpperCase(), remote: !!f.remote, valid_through: f.valid_through || '', hiring_owner_email: f.hiring_owner_email || '' };
    if (canSeePay) {
      Object.assign(out, { pay_min: f.pay_min === '' ? null : Number(f.pay_min), pay_max: f.pay_max === '' ? null : Number(f.pay_max),
        pay_currency: f.pay_currency, pay_period: f.pay_period });
    }
    return out;
  }
  async function save(extra = {}, done = 'Opening saved.') {
    if (busy) return null;
    setBusy(true);
    try {
      const u = await api.updateOpening(o.id, { ...(dirty || !Object.keys(extra).length ? body() : {}), ...extra });
      onSaved(u); setF(formOf(u)); setBase(JSON.stringify(formOf(u))); toastOk?.(done);
      setBusy(false);
      return u;
    } catch (e) { toastErr?.(e?.message || 'Could not save the opening.'); setBusy(false); return null; }
  }
  const move = (to, label) => save({ status: to }, to === 'open' ? 'Open - it is on the careers page now.' : `${label} - done.`);
  const togglePay = () => save({ show_pay: !o.showPay }, o.showPay ? 'Pay hidden from the careers page.' : 'Pay shown on the careers page.');

  async function postOn(board) {
    try {
      const p = await api.openingPosting(o.id);
      const b = (p.boards || []).find(x => x.id === board);
      if (!b) return;
      if (b.mode === 'copy') {
        const ok = await copyText(p.text);
        if (ok) toastOk?.(`Posting copied - paste it into ${b.name}'s job form.${p.listed ? '' : ' Open the opening first so the apply link works.'}`);
        else toastErr?.('Could not copy the posting.');
      }
      window.open(b.url, '_blank', 'noopener,noreferrer');
    } catch (e) { toastErr?.(e?.message || 'Could not prepare the posting.'); }
  }

  const footer = (
    <>
      {(MOVES[o.status] || []).map(([to, label]) => (
        <button key={to} className={to === 'open' ? 'primary-btn' : 'secondary-btn'} disabled={busy} onClick={() => move(to, label)}>{label}</button>
      ))}
      <button className="primary-btn" disabled={busy || !dirty || !f.title.trim()} onClick={() => save()} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {busy ? <Spinner size={14} /> : <Save size={14} />} Save Changes
      </button>
    </>
  );
  const field = (label, key, props = {}) => (
    <div><label style={FL} htmlFor={`op-${key}`}>{label}</label>
      <input id={`op-${key}`} className="form-input" style={{ width: '100%' }} value={f[key] ?? ''} onChange={e => set(key, e.target.value)} {...props} /></div>
  );
  return (
    <Modal title={o.title || 'Job Opening'} onClose={onClose} footer={footer} isDirty={dirty} onSave={() => save()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <StatusLabel label={OPENING_STATUS[o.status]?.label || o.status} color={OPENING_STATUS[o.status]?.color} />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {o.companyName}{o.headcountCode ? ` · from ${o.headcountCode}` : ''} · {o.counts.hired || 0} of {o.seats} hired
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center' }} onClick={() => postOn('linkedin')}><Share2 size={13} /> Post On LinkedIn</button>
          <button className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center' }} onClick={() => postOn('indeed')}><Megaphone size={13} /> Sponsor On Indeed</button>
          {o.careersUrl && <button className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center' }}
            onClick={async () => (await copyText(o.careersUrl) ? toastOk?.('Link copied.') : toastErr?.('Could not copy the link.'))}><Copy size={13} /> Copy Link</button>}
          {o.careersUrl && o.listed && <a className="secondary-btn" href={o.careersUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, display: 'inline-flex', gap: 5, alignItems: 'center', textDecoration: 'none' }}><ExternalLink size={13} /> View On Careers Page</a>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
        {field('Title *', 'title')}
        {field('Department', 'department')}
        <div><label style={FL} htmlFor="op-type">Employment Type</label>
          <select id="op-type" className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
            <option value="full_time">Full-Time</option><option value="part_time">Part-Time</option><option value="contractor">Contractor</option>
            <option value="intern">Intern</option><option value="temporary">Temporary</option>
          </select></div>
        {field('Seats', 'seats', { type: 'number', min: 1, max: 100 })}
        {field('Location (As Shown)', 'location', { placeholder: 'e.g. Austin, TX' })}
        {field('Street', 'street')}
        {field('City', 'city')}
        {field('State / Region', 'region')}
        {field('ZIP / Postal Code', 'postal_code')}
        {field('Country (2 Letters)', 'country', { maxLength: 2, placeholder: 'US' })}
        <div><label style={FL}>Open Until</label>
          <div className="form-input" style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <DateField value={f.valid_through} onChange={x => set('valid_through', x || '')} placeholder="MM/DD/YYYY" title="Open Until" style={{ width: '100%' }} />
          </div>
          <div style={hint}>Blank: 60 days from when it opens.</div></div>
        <div><label style={FL}>Hiring Owner</label>
          <PersonSelect value={(f.hiring_owner_email || '').toLowerCase() || null} onChange={v => set('hiring_owner_email', v || '')}
            people={pickRows} placeholder="Not set" noneLabel="Not Set" ariaLabel="Hiring Owner" />
          <div style={hint}>Gets one bell for new careers-page applicants.</div></div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, alignSelf: 'end', paddingBottom: 8 }}>
          <input type="checkbox" checked={!!f.remote} onChange={e => set('remote', e.target.checked)} /> Remote Job
        </label>
      </div>

      <div style={{ marginTop: 14, border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px' }}>
        <div style={{ ...FL, marginBottom: 6 }}>Pay</div>
        {canSeePay ? (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input aria-label="Pay Minimum" type="number" min={0} className="form-input" style={{ flex: '1 1 110px' }} value={f.pay_min} onChange={e => set('pay_min', e.target.value)} placeholder="Minimum" />
              <span style={{ color: 'var(--muted)' }}>-</span>
              <input aria-label="Pay Maximum" type="number" min={0} className="form-input" style={{ flex: '1 1 110px' }} value={f.pay_max} onChange={e => set('pay_max', e.target.value)} placeholder="Maximum" />
              <select aria-label="Pay Currency" className="form-input" style={{ flex: '0 0 100px' }} value={f.pay_currency} onChange={e => set('pay_currency', e.target.value)}>
                {currencyOptions().slice(0, 12).map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
              <select aria-label="Pay Period" className="form-input" style={{ flex: '0 0 120px' }} value={f.pay_period} onChange={e => set('pay_period', e.target.value)}>
                <option value="year">Per Year</option><option value="month">Per Month</option><option value="hour">Per Hour</option>
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8 }}>
              <input type="checkbox" checked={!!o.showPay} disabled={busy || dirty} onChange={togglePay} />
              Show The Pay Range On The Careers Page
            </label>
            <div style={hint}>Off by default. Pay transparency laws may require it where the job is. {dirty ? 'Save your changes first.' : ''}</div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {o.showPay && o.payText ? `Shown on the careers page: ${o.payText}.` : 'Pay is visible to Pay & Benefits only.'}
          </div>
        )}
      </div>

      <div className="nx-fill" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <label style={{ ...FL, marginBottom: 0 }} htmlFor="op-desc">Job Description (Public)</label>
          <button type="button" className="secondary-btn" style={{ marginLeft: 'auto', fontSize: 11.5, padding: '2px 10px' }} onClick={() => setPreview(p => !p)}>{preview ? 'Edit' : 'Preview'}</button>
        </div>
        {preview
          ? <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', overflowY: 'auto', flex: 1 }}><JobDescription text={f.description} /></div>
          : <textarea id="op-desc" className="form-input" value={f.description} onChange={e => set('description', e.target.value)}
            placeholder={'What the job is, what they will do, what they bring.\n\nA blank line starts a new paragraph.\n- Lines starting with a dash\n- become a bulleted list'}
            style={{ width: '100%', fontFamily: 'Inter,sans-serif', fontSize: 13, lineHeight: 1.55 }} />}
      </div>
    </Modal>
  );
}

// Start a Draft opening by hand - only for a company with Headcount Requests
// off (the server refuses the rest). The editor opens on it right after.
function NewOpening({ companies, onClose, onCreated, toastErr }) {
  const [f, setF] = useState({ company: companies[0]?.id || '', title: '', department: '', employment_type: 'full_time', seats: 1 });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const dirty = !!(f.title.trim() || f.department.trim());
  const create = async () => {
    if (!f.title.trim()) { toastErr?.('Give the opening a job title.'); return; }
    setBusy(true);
    try { onCreated(await api.createOpening({ ...f, title: f.title.trim(), seats: Number(f.seats) || 1 })); }
    catch (e) { toastErr?.(e?.message || 'Could not start the opening.'); setBusy(false); }
  };
  const footer = (<>
    <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
    <button type="button" className="primary-btn" disabled={busy || !f.title.trim()} onClick={create}>{busy ? 'Starting…' : 'Start Opening'}</button>
  </>);
  return (
    <Modal title="New Opening" onClose={onClose} footer={footer} isDirty={dirty} onSave={create}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12, alignContent: 'start' }}>
        {companies.length > 1 && (
          <div><label style={FL} htmlFor="new-op-company">Company</label>
            <select id="new-op-company" className="form-input" style={{ width: '100%' }} value={f.company} onChange={e => set('company', e.target.value)}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
        )}
        <div><label style={FL} htmlFor="new-op-title">Job Title *</label>
          <input id="new-op-title" className="form-input" style={{ width: '100%' }} value={f.title} maxLength={200} autoFocus
            onChange={e => set('title', e.target.value)} placeholder="e.g. Site Supervisor" /></div>
        <div><label style={FL} htmlFor="new-op-dept">Department</label>
          <input id="new-op-dept" className="form-input" style={{ width: '100%' }} value={f.department} maxLength={120} onChange={e => set('department', e.target.value)} /></div>
        <div><label style={FL} htmlFor="new-op-type">Employment Type</label>
          <select id="new-op-type" className="form-input" style={{ width: '100%' }} value={f.employment_type} onChange={e => set('employment_type', e.target.value)}>
            <option value="full_time">Full-Time</option><option value="part_time">Part-Time</option><option value="contractor">Contractor</option>
            <option value="intern">Intern</option><option value="temporary">Temporary</option>
          </select></div>
        <div><label style={FL} htmlFor="new-op-seats">Seats</label>
          <input id="new-op-seats" type="number" min={1} max={100} className="form-input" style={{ width: '100%' }} value={f.seats} onChange={e => set('seats', e.target.value)} /></div>
      </div>
      <div style={{ ...hint, marginTop: 12 }}>It starts as a Draft. Add the description, pay and where the job is in the opening, then open it on the careers page.</div>
    </Modal>
  );
}
