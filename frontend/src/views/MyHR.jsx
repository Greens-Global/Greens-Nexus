import { useState, useEffect, useRef, useMemo } from 'react';
import {
  User, Phone, Mail, Heart, Briefcase, Building2, CalendarDays, MapPin, Network,
  FileText, Download, CalendarOff, Loader2, Pencil, Check, X, BadgeCheck,
  Clock, Banknote, MessageSquarePlus, Package, ArrowRight, Hourglass,
  HardDrive, Folder, FolderOpen, ChevronRight, ChevronLeft, Eye,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { formatDateLong, formatTime } from '../lib/datetime';
import EgnytePreview from '../egnyte/EgnytePreview';
import { canPreview } from '../egnyte/lib';

// My HR - employee self-service. Shows ONLY the signed-in person's own record:
// profile (with self-service contact edits), hours graph, equipment, sealed
// e-sign documents, paystubs, and an "Ask HR" request channel. The HR module
// remains the HR team's admin console; this screen is baseline.
//
// Rendered as the "Overview" tab of the merged My HR / Time Clock module
// (Visesh, Sep 3 - "anything to do with time and HR should be together").
// Time-off REQUESTING and its full history live on the Time Off tab
// (TimeClock.jsx) - one surface, not two; this screen only shows a summary
// with a link over. Punch/hours detail lives on the Clock and Time Sheet
// tabs the same way, hence "Full detail lives in Time Clock" below.
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

export function MyHROverview({ onOpenTimeOff }) {
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
  const [askForm, setAskForm] = useState({ type: 'document', message: '' });
  const [askFile, setAskFile] = useState(null);
  const askFileRef = useRef(null);
  const [askBusy, setAskBusy] = useState(false);

  // ── Card filters ──
  const [range, setRange] = useState('week');         // hours card + tile
  const [docQuery, setDocQuery] = useState('');
  const [openDocSections, setOpenDocSections] = useState({});   // { [sectionKey]: true } - collapsed by default, click a folder to list its files
  const [docPage, setDocPage] = useState({});                   // { [sectionKey]: pageNumber } - a folder with >10 files paginates
  const [previewFile, setPreviewFile] = useState(null);         // file object for the in-app viewer, or null
  const [stubQuery, setStubQuery] = useState('');
  // { rootFiles, folders: [{ name, files }] } - my own Egnyte person folder,
  // in the SAME folder shape as Egnyte (Neil/Visesh, Sep 10: "I want the
  // folder also same they are in Egnyte"), minus subfolders wired as hidden
  // (people.my-documents-excluded-subfolder-names, e.g. Confidential). null =
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
    api.myhrEgnyteDocs().then(d => setEgnyteDocs(d?.available ? { rootFiles: d.rootFiles || [], folders: d.folders || [] } : null)).catch(() => {});
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

  // My HR's own-folder-only endpoint, not the general-purpose /egnyte/file -
  // passed into EgnytePreview so View/Download stay behind the SAME
  // authorization check (own folder, hidden subfolders excluded) as the row's
  // regular download button.
  const myhrFetchPreview = async (path) => (await api.myhrEgnyteFilePreview(path)).blob;
  const myhrDownloadFile = async (path, name) => {
    const { blob } = await api.myhrEgnyteFile(path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const egnyteFileRow = (f) => ({
    key: 'g:' + f.path, kind: 'egnyte', title: f.name, file: f,
    meta: f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : 'File', sortKey: f.lastModified || '',
    busyKey: 'egn' + f.path, onDownload: () => downloadEgnyte(f),
  });

  // Sealed e-sign PDFs, newest first - always its own section. Kept separate
  // from the Egnyte groups below since it isn't part of the Egnyte tree.
  const esignRows = useMemo(() => docs.map(d => ({
    key: 'e:' + d.requestId, kind: 'esign', title: d.title,
    meta: `Completed ${fmtD(d.completedAt?.slice(0, 10))}`, sortKey: d.completedAt || '',
    busyKey: 'doc' + d.requestId, onDownload: () => download(d.requestId),
  })).sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || '')), [docs]);

  // One section per real Egnyte subfolder, in Egnyte's own order, plus a
  // trailing "Other files" section for anything sitting loose at the root of
  // the person folder - mirrors the actual Egnyte tree instead of a single
  // flattened list (Pranshu, Sep 10).
  const egnyteSections = useMemo(() => {
    if (!egnyteDocs) return [];
    const sections = (egnyteDocs.folders || [])
      .filter(g => (g.files || []).length)
      .map(g => ({ key: 'f:' + g.name, name: g.name, rows: g.files.map(egnyteFileRow) }));
    if ((egnyteDocs.rootFiles || []).length) {
      sections.push({ key: 'f:root', name: 'Other files', rows: egnyteDocs.rootFiles.map(egnyteFileRow) });
    }
    return sections;
  }, [egnyteDocs]);

  const docSections = useMemo(() => {
    const sections = [];
    if (esignRows.length) sections.push({ key: 'esign', name: 'Signed Documents', rows: esignRows });
    sections.push(...egnyteSections);
    return sections;
  }, [esignRows, egnyteSections]);
  const totalDocCount = docSections.reduce((n, s) => n + s.rows.length, 0);

  const DOCS_PAGE_SIZE = 10;

  const docFileRow = (d) => (
    <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      {d.kind === 'egnyte'
        ? <HardDrive size={15} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
        : <FileText size={15} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.meta}</div>
      </div>
      {d.kind === 'egnyte' && canPreview(d.file) && (
        <button className="secondary-btn" onClick={() => setPreviewFile(d.file)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
          <Eye size={12} /> View
        </button>
      )}
      <button className="secondary-btn" onClick={d.onDownload} disabled={!!busy[d.busyKey]}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
        {busy[d.busyKey] ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={12} />} {d.kind === 'egnyte' ? 'Download' : 'PDF'}
      </button>
    </div>
  );

  // A folder's rows for the CURRENT page - >10 files paginates instead of one
  // long scroll (Pranshu, Sep 10). Page resets implicitly whenever the
  // filtered row count shrinks below the stored page (e.g. a new search).
  const docPageFor = (s) => {
    const totalPages = Math.max(1, Math.ceil(s.rows.length / DOCS_PAGE_SIZE));
    const page = Math.min(docPage[s.key] || 1, totalPages);
    return { page, totalPages, rows: s.rows.slice((page - 1) * DOCS_PAGE_SIZE, page * DOCS_PAGE_SIZE) };
  };

  const DocPager = ({ sectionKey, page, totalPages }) => totalPages <= 1 ? null : (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '10px 0 4px' }}>
      <button type="button" className="secondary-btn" disabled={page <= 1}
        onClick={() => setDocPage(p => ({ ...p, [sectionKey]: page - 1 }))}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, padding: '4px 9px' }}>
        <ChevronLeft size={12} /> Prev
      </button>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Page {page} of {totalPages}</span>
      <button type="button" className="secondary-btn" disabled={page >= totalPages}
        onClick={() => setDocPage(p => ({ ...p, [sectionKey]: page + 1 }))}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, padding: '4px 9px' }}>
        Next <ChevronRight size={12} />
      </button>
    </div>
  );

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
            <Stat label="My documents" value={totalDocCount} hint="Signed & filed" color="purple" Icon={FileText} />
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
                {cardHead('My hours', 'Full detail lives on the Clock tab',
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
                        No hours in this range yet - punch in from the Clock tab and they chart here.
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
                {cardHead('My documents', 'Signed copies and files HR filed for you, by folder',
                  totalDocCount > 3 ? (
                    <input className="form-input" placeholder="Search…" value={docQuery} onChange={e => setDocQuery(e.target.value)}
                      style={{ fontSize: 12, padding: '5px 10px', height: 'auto', width: 130 }} />
                  ) : <FileText size={15} style={{ color: 'var(--muted)' }} />)}
                {totalDocCount === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>No documents yet.</div>
                ) : (() => {
                  const q = docQuery.trim().toLowerCase();
                  const searching = !!q;
                  const filtered = docSections
                    .map(s => ({ ...s, rows: searching ? s.rows.filter(d => (d.title || '').toLowerCase().includes(q)) : s.rows }))
                    .filter(s => s.rows.length);
                  if (!filtered.length) {
                    return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>No documents match your search.</div>;
                  }
                  // Single-section case (no Egnyte wiring, just e-sign docs): no folders to browse, list flat as before.
                  if (docSections.length <= 1) {
                    const { page, totalPages, rows } = docPageFor(filtered[0]);
                    return (
                      <>
                        {rows.map(d => docFileRow(d))}
                        <DocPager sectionKey={filtered[0].key} page={page} totalPages={totalPages} />
                      </>
                    );
                  }
                  return filtered.map(s => {
                    // While searching, every section with a match stays expanded so results are visible;
                    // otherwise it follows whatever the employee last clicked (collapsed by default).
                    const open = searching || !!openDocSections[s.key];
                    const { page, totalPages, rows } = docPageFor(s);
                    return (
                      <div key={s.key}>
                        <button type="button" onClick={() => setOpenDocSections(p => ({ ...p, [s.key]: !p[s.key] }))}
                          disabled={searching}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0', margin: 0,
                            border: 'none', background: 'none', cursor: searching ? 'default' : 'pointer', width: '100%', textAlign: 'left' }}>
                          <ChevronRight size={13} style={{ color: 'var(--muted)', flexShrink: 0,
                            transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                          {s.key === 'esign'
                            ? <FileText size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                            : open
                              ? <FolderOpen size={13} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
                              : <Folder size={13} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />}
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{s.name}</span>
                          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.rows.length}</span>
                        </button>
                        {open && (
                          <div style={{ paddingLeft: 19 }}>
                            {rows.map(d => docFileRow(d))}
                            <DocPager sectionKey={s.key} page={page} totalPages={totalPages} />
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
              {previewFile && (
                <EgnytePreview file={previewFile} onClose={() => setPreviewFile(null)}
                  fetchPreview={myhrFetchPreview} downloadFile={myhrDownloadFile} />
              )}

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

              {/* My leave: a summary only - requesting time off and its full
                  history live on the Time Off tab now (one surface, not two;
                  see the file-top note). */}
              <div className="dash-card">
                {cardHead('My leave', 'Time off, requested and tracked on the Time Off tab', <CalendarOff size={15} style={{ color: 'var(--muted)' }} />)}
                {leave.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0 14px' }}>No time-off requests yet.</div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, padding: '6px 0 14px' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}><strong style={{ color: 'var(--ink)', fontSize: 15 }}>{leaveDaysThisYear}d</strong> approved this year</span>
                    {leave.some(r => r.status === 'pending') && (
                      <span style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))', fontWeight: 600 }}>
                        {leave.filter(r => r.status === 'pending').length} pending
                      </span>
                    )}
                  </div>
                )}
                <button className="primary-btn" onClick={onOpenTimeOff} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 12px' }}>
                  Open Time Off <ArrowRight size={12} />
                </button>
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
