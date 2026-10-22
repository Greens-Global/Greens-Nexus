// Workplace Notices (Neil, Oct 21 2026) - shared bits for People > Notices
// (HR) and Workday > Workplace Notices (everyone). The rules live in
// backend/notices.py; the HR workflow in backend/routers/notices.py.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { Spinner } from '../components/AsyncState';

export const day = (d) => (d ? formatDate(`${String(d).slice(0, 10)}T12:00:00`) : '');

export const KIND_LABEL = {
  poster: 'Poster', handout: 'Handout', form: 'Filled Form', manual: 'Manual', addendum: 'Manual Addendum',
  policy: 'Policy', contractor_code: 'Code of Conduct', closures: 'Closure Calendar',
};
export const MODE_LABEL = { post: 'Post At Site', deliver: 'Give To Each Person', both: 'Post And Give', read: 'Read In Nexus' };
export const TRIGGER_LABEL = {
  always: 'Always', hire: 'At Hire', annual: 'Every Year', hire_annual: 'At Hire And Every Year',
  separation: 'At Separation', event: 'When Something Happens', election: 'Before Each Election', window: 'Seasonal',
};
export const STATE_CHIP = {
  current:           { label: 'Current', bg: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' },
  scheduled:         { label: 'Update Scheduled', bg: 'rgba(37,99,235,0.1)', color: '#2563eb' },
  awaiting_approval: { label: 'Awaiting Approval', bg: 'rgba(180,83,9,0.12)', color: '#b45309' },
  needs_file:        { label: 'Needs File', bg: 'rgba(220,38,38,0.08)', color: '#b91c1c' },
  review_due:        { label: 'Review Due', bg: 'rgba(180,83,9,0.12)', color: '#b45309' },
  source_changed:    { label: 'Source Changed', bg: 'rgba(220,38,38,0.08)', color: '#b91c1c' },
  retired:           { label: 'Retired', bg: 'var(--wk-hover)', color: 'var(--muted)' },
};
export const VERSION_CHIP = {
  draft:     { label: 'Draft', bg: 'var(--wk-hover)', color: 'var(--muted)' },
  in_review: { label: 'Awaiting Approval', bg: 'rgba(180,83,9,0.12)', color: '#b45309' },
  approved:  { label: 'Approved', bg: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' },
  rejected:  { label: 'Sent Back', bg: 'rgba(220,38,38,0.08)', color: '#b91c1c' },
  retired:   { label: 'Withdrawn', bg: 'var(--wk-hover)', color: 'var(--muted)' },
};

export function Chip({ spec, children }) {
  const s = spec || { bg: 'var(--wk-hover)', color: 'var(--muted)' };
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {children || s.label}
    </span>
  );
}

const STATE_NAMES = { CA: 'California', TX: 'Texas' };
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// "US-CA:SAN DIEGO" -> "City of San Diego"; "US-TX" -> "Texas"; "US" -> "Federal".
export function areaLabel(area) {
  const a = String(area || 'US').toUpperCase();
  if (a === 'US') return 'Federal';
  if (a === 'IN') return 'India';
  const m = a.match(/^US-([A-Z]{2})(?::(.+))?$/);
  if (!m) return a;
  if (m[2]) return `City of ${titleCase(m[2])}`;
  return STATE_NAMES[m[1]] || m[1];
}

// Who a notice is for, in words (the server's notices.applies).
export function appliesText(n) {
  const r = n?.applies || {};
  const bits = [];
  const types = r.workerTypes || ['employee'];
  bits.push(types.includes('contractor') && types.includes('employee') ? 'Everyone'
    : types.includes('contractor') ? 'Contractors' : 'Employees');
  bits.push(n.area === 'US' ? 'in the US' : n.area === 'IN' ? 'in India' : `working in ${areaLabel(n.area)}`);
  if (r.notStates?.length) bits.push(`outside ${r.notStates.map(s => STATE_NAMES[s] || s).join(', ')}`);
  if (r.minHeadcount) bits.push(`once there are ${r.minHeadcount}+ employees`);
  if (r.siteKinds?.length) bits.push(`at ${r.siteKinds.map(k => SITE_KIND_LABEL[k] || k).join(' / ')} sites`);
  if (r.hourlyOnly) bits.push('hourly staff only');
  if (r.settingIs?.eVerify) bits.push('while we use E-Verify');
  if (r.settingIs?.txWorkersComp) bits.push(r.settingIs.txWorkersComp === 'subscriber' ? 'while we carry Texas workers\' comp' : 'while we have no Texas workers\' comp');
  return bits.join(' ');
}

export const SITE_KIND_LABEL = { office: 'Office', jobsite: 'Construction Job Site', storage: 'Storage Store' };

// The PDF in a modal frame - fetched as a blob, because the endpoint needs
// the login (the same shape as ContractorInvoices' InvoicePdfModal).
export function NoticePdfModal({ versionId, lang = 'en', title, onClose, onOpened, toastErr }) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState('');
  useEffect(() => {
    let made = '';
    api.noticeFile(versionId, lang)
      .then(({ blob }) => { made = URL.createObjectURL(blob); setType(blob.type || ''); setUrl(made); onOpened?.(); })
      .catch(e => { toastErr?.(e?.message || 'Could not open the notice.'); onClose(); });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [versionId, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label={title} style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 'clamp(560px, 60vw, 1000px)', height: 'min(94dvh, 940px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 800, fontSize: 14 }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        {!url ? <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size="section" /></div>
          : type.startsWith('image/') ? <div style={{ flex: 1, overflow: 'auto', padding: 12 }}><img src={url} alt={title} style={{ maxWidth: '100%' }} /></div>
          : <iframe title={title} src={url} style={{ flex: 1, border: 'none', borderRadius: '0 0 16px 16px' }} />}
      </div>
    </div>
  );
}
