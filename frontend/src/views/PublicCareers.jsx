// The public careers page (Neil, Oct 27 2026) - /careers/<company> lists a
// company's Open job openings, /careers/<company>/<opening> shows one with
// the apply form. No Nexus login: it renders OUTSIDE the sign-in gate like
// /intake/{token} (App.jsx, main.jsx's PUBLIC_PATH).
//
// Search engines: the Cloudflare Pages Function at functions/careers/
// puts the server-made title, description and schema.org JobPosting JSON-LD
// into the page before it is sent, so a crawler that runs no JavaScript
// reads it too. Where that Function is not in front (local dev), this page
// adds the same JSON-LD itself - only when the page has none yet.
//
// The form sends the resume to the API, which checks it is really a PDF or
// Word file and keeps it in a private bucket. The hidden "website" field is
// a honeypot: people never see it, bots fill it in.
import { useEffect, useRef, useState } from 'react';
import { MapPin, Briefcase, CalendarDays, CheckCircle, Upload, ArrowLeft, DollarSign } from 'lucide-react';
import { fetchCareersCompany, fetchCareersOpening, submitCareersApplication } from '../api';
import { formatDate } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';
import JobDescription from '../components/hiring/JobDescription';

const ink = 'var(--ink, #111827)';
const muted = 'var(--muted, #6b7280)';
const line = 'var(--line, #e5e7eb)';
const brand = '#15803d';
const lbl = { fontSize: 12.5, fontWeight: 700, color: muted, display: 'block', margin: '14px 0 5px' };
const input = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line, #d1d5db)', borderRadius: 10, padding: '11px 12px', fontSize: 16, fontFamily: 'Inter,sans-serif', background: 'var(--card, #fff)', color: ink };
const MAX_MB = 10;
const RESUME_RE = /\.(pdf|docx?)$/i;

function Shell({ company, children }) {
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #f8fafc)', fontFamily: 'Inter,sans-serif', color: ink }}>
      <header style={{ background: 'var(--card, #fff)', borderBottom: `4px solid ${brand}` }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {company?.logoUrl
            ? <img src={company.logoUrl} alt={company.name} style={{ height: 34, maxWidth: 200, objectFit: 'contain' }} />
            : <span style={{ fontSize: 18, fontWeight: 800 }}>{company?.name || 'Careers'}</span>}
          <span style={{ marginLeft: 'auto', fontSize: 13, color: muted, fontWeight: 600 }}>Careers</span>
        </div>
      </header>
      <main style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 60px' }}>{children}</main>
    </div>
  );
}

function Facts({ o }) {
  const chip = (Icon, text) => text && (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: muted }}><Icon size={14} /> {text}</span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
      {chip(MapPin, o.location)}
      {chip(Briefcase, [o.employmentLabel, o.department].filter(Boolean).join(' · '))}
      {chip(CalendarDays, o.postedAt ? `Posted ${formatDate(o.postedAt)}` : '')}
      {chip(DollarSign, o.pay)}
    </div>
  );
}

export default function PublicCareers({ slug, openingId }) {
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPage(null); setError('');
    (openingId ? fetchCareersOpening(slug, openingId) : fetchCareersCompany(slug))
      .then(setPage)
      .catch(e => setError(e.message || 'We could not load this page.'));
  }, [slug, openingId]);

  useEffect(() => {
    if (!page) return undefined;
    document.title = page.opening ? `${page.opening.title} - ${page.company.name}` : `Careers at ${page.company.name}`;
    if (!page.jsonLd || document.querySelector('script[type="application/ld+json"]')) return undefined;
    const tag = document.createElement('script');
    tag.type = 'application/ld+json';
    tag.textContent = JSON.stringify(page.jsonLd);
    document.head.appendChild(tag);
    return () => tag.remove();
  }, [page]);

  if (error) {
    return (
      <Shell company={null}>
        <div style={{ textAlign: 'center', padding: '60px 10px' }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{error}</div>
          {openingId && <a href={`/careers/${encodeURIComponent(slug)}`} style={{ display: 'inline-block', marginTop: 14, color: brand, fontWeight: 600 }}>See All Open Positions</a>}
        </div>
      </Shell>
    );
  }
  if (!page) return <Shell company={null}><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size="section" /></div></Shell>;

  if (!page.opening) {
    const { company, openings } = page;
    return (
      <Shell company={company}>
        <h1 style={{ fontSize: 28, margin: '6px 0 4px', fontWeight: 800 }}>Open Positions At {company.name}</h1>
        <p style={{ color: muted, margin: '0 0 20px' }}>
          {openings.length ? `${openings.length} open position${openings.length === 1 ? '' : 's'}.` : 'There are no open positions right now - check back soon.'}
          {company.website && <> Learn more at <a href={company.website} target="_blank" rel="noopener noreferrer" style={{ color: brand }}>{company.website.replace(/^https?:\/\//, '')}</a>.</>}
        </p>
        <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {openings.map(o => (
            <a key={o.id} role="listitem" href={`/careers/${encodeURIComponent(company.slug)}/${encodeURIComponent(o.id)}`}
              style={{ display: 'block', background: 'var(--card, #fff)', border: `1px solid ${line}`, borderRadius: 14, padding: '16px 18px', textDecoration: 'none', color: ink }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{o.title}</div>
              <Facts o={o} />
            </a>
          ))}
        </div>
      </Shell>
    );
  }

  const { company, opening } = page;
  return (
    <Shell company={company}>
      <a href={`/careers/${encodeURIComponent(company.slug)}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: muted, fontSize: 13, textDecoration: 'none', fontWeight: 600 }}>
        <ArrowLeft size={14} /> All Open Positions
      </a>
      <h1 style={{ fontSize: 28, margin: '12px 0 2px', fontWeight: 800 }}>{opening.title}</h1>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{company.name}</div>
      <Facts o={opening} />
      <div style={{ background: 'var(--card, #fff)', border: `1px solid ${line}`, borderRadius: 14, padding: '20px 22px', marginTop: 18 }}>
        <JobDescription text={opening.description} />
        {opening.validThrough && <div style={{ fontSize: 13, color: muted }}>Applications close {formatDate(opening.validThrough)}.</div>}
      </div>
      <ApplyForm opening={opening} company={company} consentText={page.consent} />
    </Shell>
  );
}

export function ApplyForm({ opening, company, consentText }) {
  const [v, setV] = useState({ first_name: '', last_name: '', email: '', phone: '', location: '', linkedin_url: '', website: '' });
  const [file, setFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const fileRef = useRef(null);
  const set = (k) => (e) => setV(p => ({ ...p, [k]: e.target.value }));

  function pick(f) {
    setProblem('');
    if (!f) return;
    if (!RESUME_RE.test(f.name)) { setProblem('Your resume needs to be a PDF or Word file (.pdf, .doc, .docx).'); return; }
    if (f.size > MAX_MB * 1024 * 1024) { setProblem(`Your resume is over ${MAX_MB} MB.`); return; }
    setFile(f);
  }
  const missing = [!v.first_name.trim() && 'First Name', !v.last_name.trim() && 'Last Name', !v.email.trim() && 'Email',
    !v.phone.trim() && 'Phone', !v.location.trim() && 'Location', !file && 'Resume', !consent && 'Your agreement'].filter(Boolean);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (missing.length) { setProblem(`Please fill in: ${missing.join(', ')}.`); return; }
    setBusy(true); setProblem('');
    const form = new FormData();
    Object.entries(v).forEach(([k, val]) => form.append(k, val.trim()));
    form.append('consent', 'true');
    form.append('resume', file);
    try { const out = await submitCareersApplication(opening.id, form); setDone(out?.message || 'Thank you - your application is in.'); }
    catch (err) { setProblem(err.message || 'We could not send your application - please try again.'); }
    setBusy(false);
  }

  if (done) {
    return (
      <div id="apply" role="status" style={{ background: 'var(--card, #fff)', border: `1px solid ${line}`, borderRadius: 14, padding: '28px 22px', marginTop: 18, textAlign: 'center' }}>
        <CheckCircle size={34} style={{ color: brand }} />
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 8 }}>Thank You</div>
        <p style={{ color: muted, margin: '6px 0 0' }}>{done} A confirmation is on its way to your email.</p>
      </div>
    );
  }
  const text = (label, key, props = {}) => (
    <div><label style={lbl} htmlFor={`ap-${key}`}>{label}</label>
      <input id={`ap-${key}`} name={key} style={input} value={v[key]} onChange={set(key)} {...props} /></div>
  );
  return (
    <form id="apply" onSubmit={submit} noValidate style={{ background: 'var(--card, #fff)', border: `1px solid ${line}`, borderRadius: 14, padding: '20px 22px', marginTop: 18 }}>
      <h2 style={{ fontSize: 20, margin: 0, fontWeight: 800 }}>Apply For This Job</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0 14px' }}>
        {text('First Name *', 'first_name', { autoComplete: 'given-name', maxLength: 80 })}
        {text('Last Name *', 'last_name', { autoComplete: 'family-name', maxLength: 80 })}
        {text('Email *', 'email', { type: 'email', autoComplete: 'email', maxLength: 200 })}
        {text('Phone *', 'phone', { type: 'tel', autoComplete: 'tel', maxLength: 40 })}
        {text('Location *', 'location', { autoComplete: 'address-level2', placeholder: 'City, State', maxLength: 120 })}
        {text('LinkedIn Profile (Optional)', 'linkedin_url', { type: 'url', placeholder: 'https://www.linkedin.com/in/...', maxLength: 300 })}
      </div>
      {/* The honeypot: hidden from people and screen readers; a bot fills it. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
        <label htmlFor="ap-website">Website</label>
        <input id="ap-website" name="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={set('website')} />
      </div>
      <label style={lbl}>Resume *</label>
      <div role="button" tabIndex={0} onClick={() => fileRef.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
        style={{ border: `1.5px dashed ${file ? brand : 'var(--line, #d1d5db)'}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        {file ? <CheckCircle size={18} style={{ color: brand }} /> : <Upload size={18} style={{ color: muted }} />}
        <span style={{ fontSize: 14 }}>{file ? file.name : `Choose your resume - PDF or Word, up to ${MAX_MB} MB`}</span>
      </div>
      <input ref={fileRef} type="file" accept=".pdf,.doc,.docx" aria-label="Resume" style={{ display: 'none' }} onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, fontSize: 13.5, lineHeight: 1.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 3, accentColor: brand }} />
        <span>{consentText || `I agree that ${company.name} may keep my application to consider me for this job.`} *</span>
      </label>
      {problem && <div role="alert" style={{ marginTop: 12, color: '#b91c1c', fontSize: 13.5, fontWeight: 600 }}>{problem}</div>}
      <button type="submit" disabled={busy} style={{ marginTop: 18, width: '100%', padding: '13px 18px', borderRadius: 10, border: 'none', background: brand, color: '#fff', fontSize: 16, fontWeight: 700, cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: busy ? 0.75 : 1 }}>
        {busy && <Spinner size={16} color="#fff" />} Send Application
      </button>
    </form>
  );
}
