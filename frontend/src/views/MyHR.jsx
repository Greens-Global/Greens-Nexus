import { useState, useEffect, useRef, useMemo } from 'react';
import {
  User, Phone, Mail, Heart, Briefcase, Building2, CalendarDays, MapPin, Network,
  FileText, Download, CalendarOff, Plus, Loader2, Pencil, Check, X, BadgeCheck,
  Clock, Banknote, MessageSquarePlus, Package, ArrowRight, TrendingUp, Hourglass,
  HardDrive,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { formatDateLong, formatTime } from '../lib/datetime';

// My HR - employee self-service. Shows ONLY the signed-in person's own record:
// profile (with self-service contact edits), hours graph, equipment, sealed
// e-sign documents, paystubs, leave, and an "Ask HR" request channel.
// The HR module remains the HR team's admin console; this screen is baseline.

const TIMEOFF_TYPES = [
  ['vacation', 'Vacation'], ['sick', 'Sick'], ['personal', 'Personal'],
  ['unpaid', 'Unpaid'], ['other', 'Other'],
];
const STATUS_META = {
  pending:   { label: 'Pending',   bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  approved:  { label: 'Approved',  bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
  rejected:  { label: 'Rejected',  bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))' },
  cancelled: { label: 'Cancelled', bg: 'var(--mist)',                    fg: 'var(--muted)' },
  open:      { label: 'Open',      bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))' },
  resolved:  { label: 'Resolved',  bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
};
const ASK_TYPES = [
  ['document', 'Update a document'], ['profile', 'Profile change'],
  ['question', 'Question for HR'], ['other', 'Something else'],
];

const fmtD = (iso) => formatDateLong(iso, '-');
const hm = (min) => `${Math.floor((min || 0) / 60)}h ${String((min || 0) % 60).padStart(2, '0')}m`;
const fmtT = (v) => !v ? '-' : (String(v).includes('T') ? formatTime(v, '-') : v);

// Hours range filter - start/end in local time, ISO date keys.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const HOUR_RANGES = [
  ['week',     'This week'],
  ['lastweek', 'Last week'],
  ['14d',      'Last 14 days'],
  ['month',    'This month'],
  ['30d',      'Last 30 days'],
];
function rangeBounds(range) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (range === 'week')     return { start: monday, end: today };
  if (range === 'lastweek') { const s = new Date(monday); s.setDate(monday.getDate() - 7); const e = new Date(monday); e.setDate(monday.getDate() - 1); return { start: s, end: e }; }
  if (range === 'month')    return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today };
  if (range === '30d')      { const s = new Date(today); s.setDate(today.getDate() - 29); return { start: s, end: today }; }
  const s = new Date(today); s.setDate(today.getDate() - 13); return { start: s, end: today };
}

function Row({ Icon, label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--muted)', width: 118, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: 'var(--ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}

// Stat tile - the shared dk-stat anatomy (tinted icon chip, big tabular
// numeral) so My HR reads like Home/People. `hero` = the one solid brand tile.
function Stat({ label, value, hint, color, Icon, hero }) {
  return (
    <div className={`dk-stat${hero ? ' dk-stat--hero' : ''}`} style={{ cursor: 'default' }}>
      <span className="dk-stat-top">
        <span className={`dk-chip dk-chip--${color}`}><Icon /></span>
      </span>
      <span className="dk-stat-num">{value}</span>
      <span className="dk-stat-label">{label}</span>
      <span className="dk-stat-sub">{hint}</span>
    </div>
  );
}

// Approved leave this year as a small kit donut (2px gaps, center total) with
// a per-type legend - real request data only; hidden when there's none.
const LEAVE_COLORS = { vacation: '#2b45e1', sick: '#dc7a18', personal: '#248f4b', unpaid: '#8a31c9', other: '#b8860b' };
function LeaveDonut({ leave }) {
  const yr = String(new Date().getFullYear());
  const daySpan = (r) => { const a = new Date(r.startDate || r.start_date), b = new Date(r.endDate || r.end_date); return isNaN(a) || isNaN(b) ? 0 : Math.round((b - a) / 86400000) + 1; };
  const byType = {};
  leave.filter(r => r.status === 'approved' && String(r.startDate || r.start_date || '').startsWith(yr))
    .forEach(r => { byType[r.type] = (byType[r.type] || 0) + daySpan(r); });
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  const R = 34, SW = 10, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '6px 0 12px', borderBottom: '1px solid var(--line)', marginBottom: 8 }}>
      <div style={{ position: 'relative', width: 88, height: 88, flexShrink: 0 }}>
        <svg width={88} height={88} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={44} cy={44} r={R} fill="none" stroke="var(--mist)" strokeWidth={SW} />
          {entries.map(([t, n]) => {
            const frac = n / total;
            const dash = Math.max(0.5, frac * C - 2.5);
            const off = -acc * C; acc += frac;
            return <circle key={t} cx={44} cy={44} r={R} fill="none" stroke={LEAVE_COLORS[t] || '#6b7280'} strokeWidth={SW}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={off} />;
          })}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{total}d</span>
          <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--muted)' }}>this year</span>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        {entries.map(([t, n]) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: LEAVE_COLORS[t] || '#6b7280', flexShrink: 0 }} />
            <span style={{ color: 'var(--muted)', fontWeight: 600, textTransform: 'capitalize' }}>{t}</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{n}d</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Worked-hours bar chart over any date range (same dependency-free SVG idiom
// as the dashboard's occupancy chart).
function HoursChart({ days, start, end }) {
  const ref = useRef(null);
  const [w, setW] = useState(420);
  const [hov, setHov] = useState(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => { const x = e.contentRect.width; if (x > 0) setW(Math.floor(x)); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  // Continuous day series across the selected range.
  const series = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = iso(d);
    series.push({ key, date: new Date(d), min: days?.[key]?.workedMin || 0 });
  }
  const n = series.length || 1;
  // Short ranges label every day by weekday; long ones label every k-th day of month.
  const labelEvery = n <= 9 ? 1 : Math.ceil(n / 10);
  const label = (s, i) => (i % labelEvery !== 0) ? '' : (n <= 9
    ? s.date.toLocaleDateString('en-US', { weekday: 'short' })
    : String(s.date.getDate()));
  const h = 150, padB = 20, padT = 26;
  const max = Math.max(60 * 8, ...series.map(s => s.min));
  const bw = Math.max(6, Math.min(34, (w - 20) / n - 6));
  const gap = (w - n * bw) / (n + 1);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {series.map((s, i) => {
          const x = gap + i * (bw + gap);
          const bh = Math.max(s.min > 0 ? 3 : 0, ((h - padB - padT) * s.min) / max);
          const y = h - padB - bh;
          const active = hov === i;
          return (
            <g key={s.key} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
              <rect x={x} y={padT} width={bw} height={h - padB - padT} fill="transparent" />
              <rect x={x} y={y} width={bw} height={bh} rx={Math.min(bw / 2, 99)}
                fill={active ? 'var(--wk-brand)' : '#b9c4f4'}
                style={{ transition: 'fill 0.15s' }} />
              <text x={x + bw / 2} y={h - 6} textAnchor="middle" fontSize="9.5" fontFamily="Inter,sans-serif"
                style={{ fill: active ? 'var(--ink)' : 'var(--muted)' }}>{label(s, i)}</text>
              {active && (
                <text x={Math.min(Math.max(x + bw / 2, 40), w - 40)} y={14} textAnchor="middle" fontSize="11" fontWeight="700"
                  fontFamily="Inter,sans-serif" style={{ fill: 'var(--ink)' }}>
                  {s.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {hm(s.min)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function MyHR() {
  const [profile, setProfile] = useState(null);
  const [profErr, setProfErr] = useState('');
  const [docs, setDocs] = useState([]);
  const [leave, setLeave] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [stubs, setStubs] = useState([]);
  const [assets, setAssets] = useState(null);
  const [asks, setAsks] = useState([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState({});
  const [loForm, setLoForm] = useState({ type: 'vacation', start_date: '', end_date: '', note: '' });
  const [loOpen, setLoOpen] = useState(false);
  const [loBusy, setLoBusy] = useState(false);
  const [askForm, setAskForm] = useState({ type: 'document', message: '' });
  const [askFile, setAskFile] = useState(null);
  const askFileRef = useRef(null);
  const [askBusy, setAskBusy] = useState(false);

  // ── Card filters ──
  const [range, setRange] = useState('week');         // hours card + tile
  const [leaveFilter, setLeaveFilter] = useState('all');
  const [docQuery, setDocQuery] = useState('');
  const [stubQuery, setStubQuery] = useState('');
  // Files HR filed in my wired Egnyte folder (people.my-documents). null =
  // not available (no wiring / no folder / Egnyte off) - the card hides.
  const [egnyteDocs, setEgnyteDocs] = useState(null);
  const [assetFilter, setAssetFilter] = useState('all');
  const [askFilter, setAskFilter] = useState('all');

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 4000); };

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(e => setProfErr(e?.message || 'Could not load your profile'));
    api.myHrDocs().then(setDocs).catch(() => {});
    api.timeOffMine().then(setLeave).catch(() => {});
    api.myPaystubs().then(setStubs).catch(() => {});
    api.myAssets().then(setAssets).catch(() => setAssets({ assignments: [], checkouts: [] }));
    api.myHrRequests().then(setAsks).catch(() => {});
    api.myhrEgnyteDocs().then(d => setEgnyteDocs(d?.available ? (d.files || []) : null)).catch(() => {});
  }, []);

  // Hours follow the selected range.
  const { start: rStart, end: rEnd } = rangeBounds(range);
  useEffect(() => {
    setSheet(null);
    const { start, end } = rangeBounds(range);
    api.timeMy(iso(start), iso(end)).then(setSheet).catch(() => setSheet({ days: {} }));
  }, [range]);

  const startEdit = () => {
    const em = profile?.personal?.emergency || {};
    setForm({
      personal_email: profile?.personalEmail || '', phone: profile?.phone || '',
      emergency_name: em.name || '', emergency_relationship: em.relationship || '', emergency_phone: em.phone || '',
    });
    setEditing(true);
  };
  const saveEdit = async () => {
    setSaving(true);
    try { setProfile(await api.myHrProfileSave(form)); setEditing(false); flash('Profile updated'); }
    catch (e) { flash(e?.message || 'Could not save', false); }
    finally { setSaving(false); }
  };
  const openUrl = (key, fn) => async (id) => {
    setBusy(p => ({ ...p, [key + id]: true }));
    try { const { url } = await fn(id); window.open(url, '_blank', 'noopener'); }
    catch (e) { flash(e?.message || 'Could not download', false); }
    finally { setBusy(p => ({ ...p, [key + id]: false })); }
  };
  const download = openUrl('doc', api.myHrDocDownload);
  const downloadStub = openUrl('stub', api.myPaystubDownload);
  // Egnyte files stream through /myhr (server checks the path is in MY wired
  // folder), so this saves the blob rather than opening a signed URL.
  const downloadEgnyte = async (f) => {
    setBusy(p => ({ ...p, ['egn' + f.path]: true }));
    try {
      const { blob } = await api.myhrEgnyteFile(f.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = f.name || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { flash(e?.message || 'Could not download', false); }
    finally { setBusy(p => ({ ...p, ['egn' + f.path]: false })); }
  };

  // Sealed e-sign PDFs and HR-filed Egnyte files, combined into one "My
  // documents" list, newest first (Neil: merge Egnyte docs into My documents
  // rather than a separate card).
  const combinedDocs = useMemo(() => {
    const esign = docs.map(d => ({
      key: 'e:' + d.requestId, kind: 'esign', title: d.title,
      meta: `Completed ${fmtD(d.completedAt?.slice(0, 10))}`, sortKey: d.completedAt || '',
      busyKey: 'doc' + d.requestId, onDownload: () => download(d.requestId),
    }));
    const filed = (egnyteDocs || []).map(f => ({
      key: 'g:' + f.path, kind: 'egnyte', title: f.name,
      meta: f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : 'File', sortKey: f.lastModified || '',
      busyKey: 'egn' + f.path, onDownload: () => downloadEgnyte(f),
    }));
    return [...esign, ...filed].sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || ''));
  }, [docs, egnyteDocs]);

  const submitLeave = async () => {
    if (!loForm.start_date || !loForm.end_date) return;
    setLoBusy(true);
    try {
      const created = await api.timeOffCreate(loForm);
      setLeave(l => [created, ...l]);
      setLoOpen(false);
      setLoForm({ type: 'vacation', start_date: '', end_date: '', note: '' });
      flash('Time-off request submitted');
    } catch (e) { flash(e?.message || 'Could not submit', false); }
    finally { setLoBusy(false); }
  };

  const submitAsk = async () => {
    if (!askForm.message.trim()) return;
    setAskBusy(true);
    try {
      let attachment = {};
      if (askFile) {
        const form = new FormData();
        form.append('file', askFile);
        attachment = await api.myHrRequestAttach(form);   // { path, name }
      }
      const created = await api.myHrRequestCreate({ ...askForm, attachment_path: attachment.path || '', attachment_name: attachment.name || '' });
      setAsks(a => [created, ...a]);
      setAskForm({ type: 'document', message: '' });
      setAskFile(null);
      if (askFileRef.current) askFileRef.current.value = '';
      flash('Sent to HR - you’ll hear back here');
    } catch (e) { flash(e?.message || 'Could not send', false); }
    finally { setAskBusy(false); }
  };

  const goInventory = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'checkouts' } }));

  // ── Derived stats ──
  const dayEntries = Object.entries(sheet?.days || {});
  const workedTotal = dayEntries.reduce((s, [, d]) => s + (d.workedMin || 0), 0);
  const daysWorked = dayEntries.filter(([, d]) => (d.workedMin || 0) > 0).length;
  const yr = new Date().getFullYear();
  const leaveDaysThisYear = leave.filter(r => r.status === 'approved' && String(r.startDate || r.start_date || '').startsWith(String(yr)))
    .reduce((s, r) => {
      const a = new Date(r.startDate || r.start_date), b = new Date(r.endDate || r.end_date);
      return s + (isNaN(a) || isNaN(b) ? 0 : Math.round((b - a) / 86400000) + 1);
    }, 0);
  const tenure = (() => {
    if (!profile?.startDate) return '-';
    const days = Math.max(0, Math.round((Date.now() - new Date(profile.startDate + 'T00:00:00')) / 86400000));
    if (days < 31) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30.44)}mo`;
    return `${(days / 365.25).toFixed(1)}y`;
  })();

  const em = profile?.personal?.emergency || {};
  const initials = profile ? `${(profile.firstName || ' ')[0]}${(profile.lastName || ' ')[0]}`.trim().toUpperCase() : '';
  const input = { width: '100%' };
  const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px' };
  const chip = (s) => { const m = STATUS_META[s] || STATUS_META.pending; return <span style={{ padding: '2px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, flexShrink: 0 }}>{m.label}</span>; };
  const cardHead = (title, sub, action) => (
    <div className="dash-card-head">
      <div>
        <div className="dash-card-title">{title}</div>
        {sub && <div className="dash-card-sub">{sub}</div>}
      </div>
      {action}
    </div>
  );

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out', fontFamily: 'var(--wk-font)' }}>
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <User size={19} />
          </span>
          <div className="view-title-group">
            <h2>My HR</h2>
            <p>Your profile, hours, documents and leave - only you see this</p>
          </div>
        </div>
      </div>

      {toast && (
        <div style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{toast.t}</div>
      )}

      {profErr ? (
        <div className="dash-card" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, padding: 40 }}>{profErr}</div>
      ) : !profile ? (
        <SkeletonBlocks count={3} height={110} />
      ) : (
        <>
          {/* ── Stat tiles ── (hours hidden for salaried/exempt people - Charmi, Aug 21) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 16 }}>
            {!sheet?.timeTrackingExempt && (
              <Stat hero label={`Hours · ${(HOUR_RANGES.find(([v]) => v === range)?.[1] || '').toLowerCase()}`} value={sheet ? hm(workedTotal) : '…'} hint={`${daysWorked} day${daysWorked === 1 ? '' : 's'} worked`} color="blue" Icon={Clock} />
            )}
            <Stat label="Leave this year" value={`${leaveDaysThisYear}d`} hint="Approved time off" color="green" Icon={CalendarOff} />
            <Stat label="My documents" value={combinedDocs.length} hint="Signed & filed" color="purple" Icon={FileText} />
            <Stat label="Time with us" value={tenure} hint={profile.startDate ? `Since ${fmtD(profile.startDate)}` : ''} color="orange" Icon={Hourglass} />
          </div>

          <div className="myhr-grid">

            {/* ── Left rail: profile + equipment ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="dash-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  {profile.photoUrl
                    ? <img src={profile.photoUrl} alt="" style={{ width: 54, height: 54, borderRadius: '50%', objectFit: 'cover' }} />
                    : <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, color: 'var(--muted)' }}>{initials || <User size={22} />}</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--ink)' }}>{profile.firstName} {profile.lastName}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{[profile.jobTitle, profile.department].filter(Boolean).join(' · ')}</div>
                  </div>
                  {profile.status === 'active' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))' }}>
                      <BadgeCheck size={12} /> Active
                    </span>
                  )}
                </div>
                <Row Icon={Briefcase} label="Employee code" value={profile.employeeCode} />
                <Row Icon={Mail} label="Work email" value={profile.workEmail} />
                <Row Icon={CalendarDays} label="Start date" value={fmtD(profile.startDate)} />
                <Row Icon={Network} label="Reports to" value={profile.manager} />
                <Row Icon={MapPin} label="Location" value={profile.location} />
                <Row Icon={Building2} label="Employment" value={(profile.employmentType || '').replace('_', ' ')} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 2px' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Contact & emergency</span>
                  {!editing && (
                    <button className="secondary-btn" onClick={startEdit} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
                      <Pencil size={12} /> Edit
                    </button>
                  )}
                </div>

                {!editing ? (
                  <div>
                    <Row Icon={Mail} label="Personal email" value={profile.personalEmail} />
                    <Row Icon={Phone} label="Phone" value={profile.phone} />
                    <Row Icon={Heart} label="Emergency" value={em.name ? [em.name, em.relationship && `(${em.relationship})`, em.phone].filter(Boolean).join(' · ') : ''} />
                    {!profile.personalEmail && !profile.phone && !em.name && (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Nothing here yet - add your contact details so HR can reach you.</div>
                    )}
                  </div>
                ) : (
                  <div>
                    <label style={lbl}>Personal email</label>
                    <input className="form-input" style={input} value={form.personal_email} onChange={e => setForm(f => ({ ...f, personal_email: e.target.value }))} />
                    <label style={lbl}>Phone</label>
                    <input className="form-input" style={input} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                    <label style={lbl}>Emergency contact name</label>
                    <input className="form-input" style={input} value={form.emergency_name} onChange={e => setForm(f => ({ ...f, emergency_name: e.target.value }))} />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={lbl}>Relationship</label>
                        <input className="form-input" style={input} value={form.emergency_relationship} onChange={e => setForm(f => ({ ...f, emergency_relationship: e.target.value }))} />
                      </div>
                      <div>
                        <label style={lbl}>Their phone</label>
                        <input className="form-input" style={input} value={form.emergency_phone} onChange={e => setForm(f => ({ ...f, emergency_phone: e.target.value }))} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                      <button className="secondary-btn" onClick={() => setEditing(false)} disabled={saving}><X size={13} /> Cancel</button>
                      <button className="primary-btn" onClick={saveEdit} disabled={saving}>
                        {saving ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Saving…</> : <><Check size={13} /> Save</>}
                      </button>
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
                      Name, job, department or bank changes go through HR - use "Ask HR" for those.
                    </p>
                  </div>
                )}
              </div>

              {/* ── My equipment ── */}
              <div className="dash-card">
                {cardHead('My equipment', 'Assigned to you or checked out',
                  assets && assets.assignments.length > 0 && assets.checkouts.length > 0 ? (
                    <select className="form-input" value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                      style={{ fontSize: 12, fontWeight: 600, padding: '5px 24px 5px 9px', height: 'auto' }}>
                      <option value="all">All</option>
                      <option value="assigned">Assigned</option>
                      <option value="checkouts">Checkouts</option>
                    </select>
                  ) : <Package size={15} style={{ color: 'var(--muted)' }} />)}
                {!assets ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>
                ) : assets.assignments.length + assets.checkouts.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>Nothing checked out to you right now.</div>
                ) : (
                  <div>
                    {(assetFilter === 'checkouts' ? [] : assets.assignments).map((a, i) => (
                      <div key={`a${i}`} onClick={goInventory} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
                        <Package size={14} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{a.item}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{a.since ? `since ${fmtD(a.since)}` : 'Permanent'}</span>
                      </div>
                    ))}
                    {(assetFilter === 'assigned' ? [] : assets.checkouts).map((c, i) => (
                      <div key={`c${i}`} onClick={goInventory} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
                        <Package size={14} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{c.item}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.due ? `due ${fmtD(c.due)}` : c.status.replace('_', ' ')}</span>
                      </div>
                    ))}
                    <button className="link-btn" onClick={goInventory}>Open Item Management <ArrowRight size={12} /></button>
                  </div>
                )}
              </div>
            </div>

            {/* ── Main grid: hours spans both columns, then paired rows whose
                cards stretch to equal heights (aligned edges by construction) ── */}
            <div className="myhr-main">
              {!sheet?.timeTrackingExempt && (
              <div className="dash-card myhr-span2">
                {cardHead('My hours', 'Full detail lives in Time Clock',
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}><strong style={{ color: 'var(--ink)' }}>{sheet ? hm(workedTotal) : '…'}</strong> total</span>
                    <select className="form-input" value={range} onChange={e => setRange(e.target.value)}
                      style={{ fontSize: 12, fontWeight: 600, padding: '5px 24px 5px 9px', height: 'auto' }}>
                      {HOUR_RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </span>)}
                {!sheet ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>
                ) : (
                  <>
                    {workedTotal === 0 ? (
                      <div style={{ height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '0 16px' }}>
                        No hours in this range yet - punch in from Time Clock and they chart here.
                      </div>
                    ) : (
                      <HoursChart days={sheet.days} start={rStart} end={rEnd} />
                    )}
                    {dayEntries.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {dayEntries.sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5).map(([date, d]) => (
                          <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', width: 100, flexShrink: 0 }}>
                              {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            </span>
                            <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
                              {fmtT(d.firstIn)} → {fmtT(d.lastOut)}{d.breakMin ? ` · ${hm(d.breakMin)} break` : ''}
                            </span>
                            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{hm(d.workedMin)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              )}

              <div className="dash-card">
                {cardHead('My documents', 'Signed copies and files HR filed for you',
                  combinedDocs.length > 3 ? (
                    <input className="form-input" placeholder="Search…" value={docQuery} onChange={e => setDocQuery(e.target.value)}
                      style={{ fontSize: 12, padding: '5px 10px', height: 'auto', width: 130 }} />
                  ) : <FileText size={15} style={{ color: 'var(--muted)' }} />)}
                {combinedDocs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>No documents yet.</div>
                ) : combinedDocs.filter(d => !docQuery || (d.title || '').toLowerCase().includes(docQuery.toLowerCase())).map(d => (
                  <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                    {d.kind === 'egnyte'
                      ? <HardDrive size={15} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
                      : <FileText size={15} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.meta}</div>
                    </div>
                    <button className="secondary-btn" onClick={d.onDownload} disabled={!!busy[d.busyKey]}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
                      {busy[d.busyKey] ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={12} />} {d.kind === 'egnyte' ? 'Download' : 'PDF'}
                    </button>
                  </div>
                ))}
              </div>

              <div className="dash-card">
                {cardHead('My paystubs', 'Uploaded by HR each pay period',
                  stubs.length > 3 ? (
                    <input className="form-input" placeholder="Search…" value={stubQuery} onChange={e => setStubQuery(e.target.value)}
                      style={{ fontSize: 12, padding: '5px 10px', height: 'auto', width: 130 }} />
                  ) : <Banknote size={15} style={{ color: 'var(--muted)' }} />)}
                {stubs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>No paystubs yet - they'll appear here when HR uploads them.</div>
                ) : stubs.filter(s => !stubQuery || (s.name || '').toLowerCase().includes(stubQuery.toLowerCase())).map(s => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                    <Banknote size={15} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Added {fmtD(s.createdAt?.slice(0, 10))}</div>
                    </div>
                    <button className="secondary-btn" onClick={() => downloadStub(s.id)} disabled={!!busy['stub' + s.id]}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
                      {busy['stub' + s.id] ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={12} />} PDF
                    </button>
                  </div>
                ))}
              </div>

              <div className="dash-card">
                {cardHead('My leave', 'Time-off requests and their status',
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <select className="form-input" value={leaveFilter} onChange={e => setLeaveFilter(e.target.value)}
                      style={{ fontSize: 12, fontWeight: 600, padding: '5px 24px 5px 9px', height: 'auto' }}>
                      <option value="all">All</option>
                      <option value="pending">Pending</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </select>
                    <button className="primary-btn" onClick={() => setLoOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 12px' }}>
                      <Plus size={13} /> Request time off
                    </button>
                  </span>)}

                {loOpen && (
                  <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 12, background: 'var(--mist)' }}>
                    <label style={lbl}>Type</label>
                    <select className="form-input" style={input} value={loForm.type} onChange={e => setLoForm(f => ({ ...f, type: e.target.value }))}>
                      {TIMEOFF_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={lbl}>From</label>
                        <input type="date" className="form-input" style={input} value={loForm.start_date} onChange={e => setLoForm(f => ({ ...f, start_date: e.target.value }))} />
                      </div>
                      <div>
                        <label style={lbl}>To</label>
                        <input type="date" className="form-input" style={input} value={loForm.end_date} onChange={e => setLoForm(f => ({ ...f, end_date: e.target.value }))} />
                      </div>
                    </div>
                    <label style={lbl}>Note (optional)</label>
                    <input className="form-input" style={input} value={loForm.note} placeholder="Anything your manager should know" onChange={e => setLoForm(f => ({ ...f, note: e.target.value }))} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                      <button className="secondary-btn" onClick={() => setLoOpen(false)} disabled={loBusy}>Cancel</button>
                      <button className="primary-btn" onClick={submitLeave} disabled={loBusy || !loForm.start_date || !loForm.end_date}>
                        {loBusy ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Submitting…</> : 'Submit'}
                      </button>
                    </div>
                  </div>
                )}

                {leave.length > 0 && <LeaveDonut leave={leave} />}
                {leave.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>No time-off requests yet.</div>
                ) : leave.filter(r => leaveFilter === 'all' || r.status === leaveFilter).map(r => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                    <CalendarOff size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                        {(TIMEOFF_TYPES.find(([v]) => v === r.type)?.[1]) || r.type} · {fmtD(r.startDate || r.start_date)} → {fmtD(r.endDate || r.end_date)}
                      </div>
                      {r.note && <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</div>}
                    </div>
                    {chip(r.status)}
                  </div>
                ))}
              </div>

              {/* ── Ask HR ── */}
              <div className="dash-card">
                {cardHead('Ask HR', 'Request a document update, profile change or anything else', <MessageSquarePlus size={15} style={{ color: 'var(--muted)' }} />)}
                <label style={lbl}>What do you need?</label>
                <select className="form-input" style={input} value={askForm.type} onChange={e => setAskForm(f => ({ ...f, type: e.target.value }))}>
                  {ASK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <label style={lbl}>Details</label>
                <textarea className="form-input" rows={3} style={{ ...input, resize: 'vertical' }} value={askForm.message}
                  placeholder='e.g. "My visa was renewed - please update my right-to-work document."'
                  onChange={e => setAskForm(f => ({ ...f, message: e.target.value }))} />
                {/* Optional attachment - the new/updated document itself */}
                <input ref={askFileRef} type="file" style={{ display: 'none' }}
                  onChange={e => setAskFile(e.target.files?.[0] || null)} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="secondary-btn" onClick={() => askFileRef.current?.click()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}>
                    <FileText size={13} /> {askFile ? 'Change file' : 'Attach the document'}
                  </button>
                  {askFile && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink)', background: 'var(--mist)', borderRadius: 8, padding: '4px 10px', maxWidth: 220 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{askFile.name}</span>
                      <X size={12} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { setAskFile(null); if (askFileRef.current) askFileRef.current.value = ''; }} />
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <button className="primary-btn" onClick={submitAsk} disabled={askBusy || !askForm.message.trim()}>
                    {askBusy ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Sending…</> : 'Send to HR'}
                  </button>
                </div>

                {asks.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>My requests</span>
                      <select className="form-input" value={askFilter} onChange={e => setAskFilter(e.target.value)}
                        style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 22px 3px 8px', height: 'auto' }}>
                        <option value="all">All</option>
                        <option value="open">Open</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </div>
                    {asks.filter(a => askFilter === 'all' || a.status === askFilter).map(a => (
                      <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
                            {(ASK_TYPES.find(([v]) => v === a.type)?.[1]) || a.type} · {fmtD(a.createdAt?.slice(0, 10))}
                          </span>
                          {chip(a.status)}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{a.message}</div>
                        {a.attachmentName && (
                          <div style={{ fontSize: 11.5, color: 'hsl(var(--color-blue))', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <FileText size={11} /> {a.attachmentName}
                          </div>
                        )}
                        {a.response && (
                          <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 5, padding: '7px 10px', background: 'var(--mist)', borderRadius: 8 }}>
                            <strong>HR:</strong> {a.response}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
