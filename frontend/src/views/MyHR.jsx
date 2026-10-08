import { useState, useEffect, useRef, useMemo } from 'react';
import {
  User, Phone, Mail, Heart, Building2, CalendarDays, MapPin, Network,
  FileText, Download, CalendarOff, Pencil, Check, X, BadgeCheck,
  Clock, Banknote, MessageSquarePlus, Package, ArrowRight, Hourglass,
  HardDrive, Folder, FolderOpen, ChevronRight, ChevronLeft, Eye,
} from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner, LoadingState } from '../components/AsyncState';
import { formatDate, formatDateLong } from '../lib/datetime';
import { approvedLeaveDays, fmtDays, tenureLabel, openShiftMinutes } from '../lib/workdayStats';
import { reasonLook } from '../lib/timeOffReasons';
import { timeOffLabel } from '../components/shiftScheduleLib';
import EgnytePreview from '../egnyte/EgnytePreview';
import { canPreview } from '../egnyte/lib';
import { MyChecklistSteps } from '../components/HrChecklists';

// My HR - employee self-service. Shows ONLY the signed-in person's own record:
// profile (with self-service contact edits), hours graph, equipment, sealed
// e-sign documents, paystubs, and an "Ask HR" request channel. The HR module
// remains the HR team's admin console; this screen is baseline.
//
// Rendered as the "Overview" tab of Workday (TimeClock.jsx). Since Oct 2
// (Neil, Oct 1: "is there a need for the clock to be its own screen? ...
// it should be a widget and it should have the entire time clock in it")
// the Time Clock is the first thing on this page - TimeClock.jsx owns the
// punch state and hands the widget in as `clock` (a function of the first
// name, for its greeting). The hours - today, this week, the pay period -
// sit in that widget; the Hours tile and the My Hours chart below cover any
// range you pick. Time-off
// REQUESTING and its full history live on the Time Off tab; this screen shows
// what is coming up with a link over. Paystubs are a folder inside My
// Documents (Neil, Oct 1: "keep everything in my documents").
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

// Same labels as the HR module's EMP_TYPES (HR.jsx) - not imported, that
// chunk is far too big to pull into My HR. Raw "full_time" read "full time".
const EMP_TYPE_LABEL = { full_time: 'Full-Time', part_time: 'Part-Time', contractor: 'Contractor', intern: 'Intern' };

const fmtD = (iso) => formatDateLong(iso, '-');
const hm = (min) => `${Math.floor((min || 0) / 60)}h ${String((min || 0) % 60).padStart(2, '0')}m`;

// Hours range filter - start/end in local time, ISO date keys.
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      <span style={{ fontSize: 13.5, color: 'var(--ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={typeof value === 'string' ? value : undefined}>{value}</span>
    </div>
  );
}

// Stat tile - the shared dk-stat anatomy (tinted icon chip, big tabular
// numeral) so My HR reads like Home/People. `hero` = the one solid brand tile.
// Stat tile - the shared dk-stat anatomy (tinted icon chip, big tabular
// numeral) so My HR reads like Home/People. `hero` = the one solid brand tile.
// With onClick it opens what it counts (the Time Sheet, Time Off, documents).
function Stat({ label, value, hint, color, Icon, hero, title, onClick }) {
  const cls = `dk-stat wd-stat${hero ? ' dk-stat--hero' : ''}`;
  const body = (
    <>
      <span className={`dk-chip dk-chip--${color}`}><Icon /></span>
      <span className="wd-stat-text">
        <span className="dk-stat-num">{value}</span>
        <span className="dk-stat-label">{label}</span>
        <span className="dk-stat-sub">{hint}</span>
      </span>
      {onClick && <ArrowRight size={16} className="dk-stat-arrow" aria-hidden="true" />}
    </>
  );
  return onClick
    ? <button type="button" className={cls} title={title} onClick={onClick}>{body}</button>
    : <div className={cls} style={{ cursor: 'default' }} title={title}>{body}</div>;
}

export function MyHROverview({ onOpenTimeOff, onOpenTimeSheet, clock = null }) {
  const [profile, setProfile] = useState(null);
  const [profErr, setProfErr] = useState('');
  const [docs, setDocs] = useState(null);     // null = loading, false = failed
  const [leave, setLeave] = useState(null);   // null = loading, false = failed
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
  const [docQuery, setDocQuery] = useState('');
  const [openDocSections, setOpenDocSections] = useState({});   // { [sectionKey]: true } - collapsed by default, click a folder to list its files
  const [docPage, setDocPage] = useState({});                   // { [sectionKey]: pageNumber } - a folder with >10 files paginates
  const [previewFile, setPreviewFile] = useState(null);         // file object for the in-app viewer, or null
  // { rootFiles, folders: [{ name, files }] } - my own Egnyte person folder,
  // in the SAME folder shape as Egnyte (Neil/Visesh, Sep 10: "I want the
  // folder also same they are in Egnyte"), minus subfolders wired as hidden
  // (people.my-documents-excluded-subfolder-names, e.g. Confidential). null =
  // not available (no wiring / no folder / Egnyte off) - the card hides.
  const [egnyteDocs, setEgnyteDocs] = useState(null);
  const [assetFilter, setAssetFilter] = useState('all');
  const [askFilter, setAskFilter] = useState('all');
  const [askOpen, setAskOpen] = useState(false);
  const [sheet, setSheet] = useState(null);
  // The Hours tile counts this week; the clock card above switches between
  // Today / This Week / Pay Period.
  const range = 'week';       // the Ask HR form opens on New Request

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 4000); };

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(e => setProfErr(e?.message || 'Could not load your profile'));
    api.myHrDocs().then(d => setDocs(Array.isArray(d) ? d : [])).catch(() => setDocs(false));
    api.timeOffMine().then(l => setLeave(Array.isArray(l) ? l : [])).catch(() => setLeave(false));
    api.myPaystubs().then(r => setStubs(Array.isArray(r) ? r : [])).catch(() => {});
    // Normalized: Overview now carries the Time Clock, so a malformed answer
    // here must never take the punch buttons down with it.
    api.myAssets().then(a => setAssets({ assignments: a?.assignments || [], checkouts: a?.checkouts || [] }))
      .catch(() => setAssets({ assignments: [], checkouts: [] }));
    api.myHrRequests().then(r => setAsks(Array.isArray(r) ? r : [])).catch(() => {});
    api.myhrEgnyteDocs().then(d => setEgnyteDocs(d?.available ? { rootFiles: d.rootFiles || [], folders: d.folders || [] } : null)).catch(() => {});
  }, []);

  // Hours follow the selected range.
  const { start: rStart, end: rEnd } = rangeBounds(range);
  useEffect(() => {
    setSheet(null);
    const { start, end } = rangeBounds(range);
    api.timeMy(iso(start), iso(end)).then(setSheet).catch(() => setSheet({ days: {} }));
  }, []);

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
  const esignRows = useMemo(() => (docs || []).map(d => ({
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

  // Paystubs HR uploads (Neil, Oct 1: no separate My Paystubs card - "keep
  // everything in my documents"), newest first, as their own folder.
  const stubRows = useMemo(() => (stubs || []).map(s => ({
    key: 's:' + s.id, kind: 'stub', title: s.name,
    meta: `Added ${fmtD(s.createdAt?.slice(0, 10))}`, sortKey: s.createdAt || '',
    busyKey: 'stub' + s.id, onDownload: () => downloadStub(s.id),
  })).sort((a, b) => (b.sortKey || '').localeCompare(a.sortKey || '')), [stubs]);

  const docSections = useMemo(() => {
    const sections = [];
    if (esignRows.length) sections.push({ key: 'esign', name: 'Signed Documents', rows: esignRows });
    if (stubRows.length) sections.push({ key: 'stubs', name: 'Paystubs', rows: stubRows });
    sections.push(...egnyteSections);
    return sections;
  }, [esignRows, stubRows, egnyteSections]);
  const totalDocCount = docSections.reduce((n, s) => n + s.rows.length, 0);

  const DOCS_PAGE_SIZE = 10;

  const docFileRow = (d) => (
    <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      {d.kind === 'egnyte'
        ? <HardDrive size={15} style={{ color: 'hsl(var(--color-purple))', flexShrink: 0 }} />
        : d.kind === 'stub'
          ? <Banknote size={15} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
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
        {busy[d.busyKey] ? <Spinner size={12} /> : <Download size={12} />} {d.kind === 'egnyte' ? 'Download' : 'PDF'}
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
      setAskOpen(false);
      flash('Sent to HR - you’ll hear back here');
    } catch (e) { flash(e?.message || 'Could not send', false); }
    finally { setAskBusy(false); }
  };

  const goMyShifts = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'shifts', sub: 'mine' } }));
  const goInventory = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'checkouts' } }));

  // ── Derived stats ──
  const dayEntries = Object.entries(sheet?.days || {});
  const workedTotal = dayEntries.reduce((s, [, d]) => s + (d.workedMin || 0), 0);
  const daysWorked = dayEntries.filter(([, d]) => (d.workedMin || 0) > 0).length;
  // A shift still open right now is not in workedMin until its clock-out
  // lands - add it live, or the tile reads 0h all day mid-shift. Only for
  // ranges that end today ("Last week" is closed history).
  const rangeEndsToday = iso(rEnd) === iso(new Date());
  const openMin = sheet && rangeEndsToday ? openShiftMinutes(sheet.days) : 0;
  const hoursTotal = workedTotal + openMin;
  const todayKey = iso(new Date());
  const daysWorkedLive = daysWorked + (openMin > 0 && !((sheet?.days?.[todayKey]?.workedMin || 0) > 0) ? 1 : 0);
  // Leave = approved WORKING days (Mon-Fri) inside this calendar year, a
  // partial day as its share of 8 hours (lib/workdayStats.js). The old count
  // added calendar days incl. weekends and whole days for 2-hour requests.
  const yr = new Date().getFullYear();
  const leaveDaysThisYear = Array.isArray(leave) ? approvedLeaveDays(leave, yr) : null;
  const leaveLabel = leave === null ? '…' : leaveDaysThisYear == null ? '-' : `${fmtDays(leaveDaysThisYear)}d`;
  const tenure = tenureLabel(profile?.startDate) || '-';

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

  // What is coming up: pending or approved requests that have not ended yet,
  // soonest first - the Time Off card's list (the full history is the tab).
  const upcoming = Array.isArray(leave)
    ? leave.filter(r => (r.status === 'pending' || r.status === 'approved') && (r.endDate || '') >= todayKey)
      .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
    : [];
  const pendingCount = Array.isArray(leave) ? leave.filter(r => r.status === 'pending').length : 0;
  const toLabel = (t) => timeOffLabel(t) || 'Time Off';
  const dayOf = (d) => formatDate(d + 'T12:00:00');
  const spanLabel = (r) => r.startDate === r.endDate ? dayOf(r.startDate) : `${dayOf(r.startDate)} - ${dayOf(r.endDate)}`;
  const clockParts = typeof clock === 'function' ? clock(profile?.firstName || '') : null;
  // undefined = no clock handed in (no shift data at all); null = loading.
  const shiftInfo = clockParts ? clockParts.shift : undefined;
  // Time-tracking exempt: Workday hands in what it already knows (the
  // remembered answer, then /time/status), so the Hours tile never shows for
  // a salaried person while /time/me is still on its way (Neil, 10/08).
  const hoursExempt = clockParts?.exempt ?? !!sheet?.timeTrackingExempt;

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out', fontFamily: 'var(--wk-font)' }}>
      {toast && (
        <div style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{toast.t}</div>
      )}

      {/* Top of the page, in reading order (Oct 2): the greeting, the summary
          tiles, then the clock card. The clock never waits on the HR profile -
          only the tiles do, and they hold their place with a skeleton. */}
      {clockParts?.intro}
      {profile ? (
        <>
          {/* ── Stat tiles ── each opens what it counts. Hours hidden for
              salaried/exempt people (Charmi, Aug 21). */}
          <div className="wd-statgrid">
            {/* Hours this week beside today's shift - the two things someone
                opening Workday wants first (Oct 2). Exempt people have no hours
                tile, so their shift gets a tile of its own. */}
            {!hoursExempt ? (
              /* Two targets in one tile (Oct 2): the hours open the Time
                 Sheet, today's shift opens Shifts > My Shifts. */
              <div className="dk-stat dk-stat--hero wd-stat wd-hero" style={{ cursor: 'default' }}>
                <button type="button" className="wd-hero-part" onClick={onOpenTimeSheet} disabled={!onOpenTimeSheet}
                  title={`Your punched hours from ${formatDate(rStart)} to ${formatDate(rEnd)}, after breaks${openMin ? ', including the shift you are on now' : ''}. Opens your Time Sheet.`}>
                  <span className="dk-chip dk-chip--blue"><Clock /></span>
                  <span className="wd-stat-text">
                    <span className="dk-stat-num">{sheet ? hm(hoursTotal) : '…'}</span>
                    <span className="dk-stat-label">Hours · This Week</span>
                    <span className="dk-stat-sub">{`${formatDate(rStart)} - ${formatDate(rEnd)} · ${daysWorkedLive} day${daysWorkedLive === 1 ? '' : 's'} worked`}</span>
                  </span>
                </button>
                {shiftInfo !== undefined && (
                  <button type="button" className="wd-hero-part wd-hero-shift" onClick={goMyShifts} title="Open My Shifts">
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="wd-hero-shift-l"><CalendarDays size={12} /> Today&apos;s Shift</span>
                      <span className="wd-hero-shift-v" style={{ display: 'block' }}>{shiftInfo === null ? '…' : shiftInfo.time || 'No Shift Today'}</span>
                      <span className="wd-hero-shift-s" style={{ display: 'block' }}>{shiftInfo === null ? '' : shiftInfo.time ? (shiftInfo.label || 'Scheduled in Shifts') : 'Nothing on your schedule'}</span>
                    </span>
                    <ArrowRight size={16} className="dk-stat-arrow" aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : shiftInfo !== undefined && (
              <Stat label="Today's Shift" value={shiftInfo === null ? '…' : shiftInfo.time || 'None'}
                hint={shiftInfo?.time ? (shiftInfo.label || 'Scheduled in Shifts') : 'Nothing on your schedule'}
                color="blue" Icon={CalendarDays} onClick={goMyShifts} />
            )}
            <Stat label="Time Off This Year" value={leaveLabel}
              hint={pendingCount ? `Approved working days · ${pendingCount} pending` : `Approved working days in ${yr}`}
              title={`Approved time off in ${yr}, counted in working days (Mon-Fri). A partial day counts as its share of an 8-hour day. Opens Time Off.`}
              color="green" Icon={CalendarOff} onClick={onOpenTimeOff} />
            <Stat label="Time With Us" value={tenure}
              hint={tenure !== '-' ? `Since ${formatDate(profile.startDate)}` : 'No start date on your HR record'}
              title="Counted from the start date on your HR record. If it is wrong, ask HR to correct it."
              color="orange" Icon={Hourglass} />
          </div>
        </>
      ) : !profErr && <SkeletonBlocks count={1} height={74} />}
      {clockParts ? clockParts.card : clock}
      {/* Onboarding / offboarding steps this person owns - a manager, IT or the
          new hire ticks them here. Renders nothing when there are none. */}
      <MyChecklistSteps />

      {profErr ? (
        <div className="dash-card" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, padding: 40 }}>{profErr}</div>
      ) : !profile ? (
        <SkeletonBlocks count={3} height={110} />
      ) : (
        <>
          <div className="myhr-grid">

            {/* ── Left rail: profile + equipment ── (minWidth 0: a long work
                email must ellipsize, not widen the column past a phone) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
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
                {/* No employee code here (Neil, Oct 1): it is only used for
                    Intacct reporting, so it stays in People for HR and
                    accounting and means nothing to the employee. */}
                <Row Icon={Mail} label="Work email" value={profile.workEmail} />
                <Row Icon={CalendarDays} label="Start date" value={fmtD(profile.startDate)} />
                <Row Icon={Network} label="Reports to" value={profile.manager} />
                <Row Icon={MapPin} label="Location" value={profile.location} />
                <Row Icon={Building2} label="Employment" value={EMP_TYPE_LABEL[profile.employmentType] || (profile.employmentType || '').replace(/_/g, ' ')} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 2px' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Contact & Emergency</span>
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
                        {saving ? <><Spinner size={13} /> Saving…</> : <><Check size={13} /> Save</>}
                      </button>
                    </div>
                    <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
                      Name, job, department or bank changes go through HR - use "Ask HR" for those.
                    </p>
                  </div>
                )}
              </div>

              {/* ── My Equipment ── */}
              <div className="dash-card">
                {cardHead('My Equipment', 'Assigned to you or checked out',
                  assets && assets.assignments.length > 0 && assets.checkouts.length > 0 ? (
                    <select className="form-input" value={assetFilter} onChange={e => setAssetFilter(e.target.value)} aria-label="Filter my equipment"
                      style={{ fontSize: 12, fontWeight: 600, padding: '5px 24px 5px 9px', height: 'auto' }}>
                      <option value="all">All</option>
                      <option value="assigned">Assigned</option>
                      <option value="checkouts">Checkouts</option>
                    </select>
                  ) : <Package size={15} style={{ color: 'var(--muted)' }} />)}
                {!assets ? (
                  <LoadingState compact />
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

            {/* ── Main grid: documents beside time off, then Ask HR ── */}
            <div className="myhr-main">
              <div className="dash-card">
                {cardHead('My Documents', 'Signed copies, files HR filed for you and your paystubs',
                  totalDocCount > 3 ? (
                    <input className="form-input" placeholder="Search…" aria-label="Search my documents" value={docQuery} onChange={e => setDocQuery(e.target.value)}
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
                  // ONE section and no Egnyte folder data (not wired/connected, or
                  // nothing filed there yet) - nothing to browse by folder: list
                  // flat. NOT the same as "exactly one Egnyte folder" - an employee
                  // whose real Egnyte folder isn't broken into subfolders still
                  // gets ONE labeled, collapsible section rather than being
                  // silently flattened (Pranshu, Sep 11: dev's test tenant has 5
                  // subfolders, prod's real one had 1).
                  if (egnyteSections.length === 0 && filtered.length === 1) {
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
                          disabled={searching} aria-expanded={open}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0', margin: 0,
                            border: 'none', background: 'none', cursor: searching ? 'default' : 'pointer', width: '100%', textAlign: 'left' }}>
                          <ChevronRight size={13} style={{ color: 'var(--muted)', flexShrink: 0,
                            transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                          {s.key === 'esign'
                            ? <FileText size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                            : s.key === 'stubs'
                              ? <Banknote size={13} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
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

              {/* Time Off: what is coming up. Requesting and the full history
                  live on the Time Off tab (one surface, not two). */}
              <div className="dash-card" style={{ display: 'flex', flexDirection: 'column' }}>
                {cardHead('Time Off', 'Coming up - pending and approved',
                  pendingCount > 0
                    ? <span style={{ padding: '2px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: STATUS_META.pending.bg, color: STATUS_META.pending.fg }}>{pendingCount} Pending</span>
                    : <CalendarOff size={15} style={{ color: 'var(--muted)' }} />)}
                {leave === null ? (
                  <LoadingState compact />
                ) : leave === false ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>Could not load your time off.</div>
                ) : upcoming.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '14px 0', textAlign: 'center' }}>Nothing coming up.</div>
                ) : (
                  <div>
                    {upcoming.slice(0, 4).map(r => {
                      const { Icon: TIcon, color } = reasonLook(r.type, toLabel(r.type));
                      return (
                        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                          <span style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--mist)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <TIcon size={14} color={color} />
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{toLabel(r.type)}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{spanLabel(r)}</div>
                          </div>
                          {chip(r.status)}
                        </div>
                      );
                    })}
                    {upcoming.length > 4 && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', paddingTop: 8 }}>+{upcoming.length - 4} more on the Time Off tab</div>
                    )}
                  </div>
                )}
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="primary-btn" onClick={onOpenTimeOff} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 12px' }}>
                    <CalendarDays size={13} /> Request Time Off
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}><strong style={{ color: 'var(--ink)' }}>{leaveLabel}</strong> approved in {yr}</span>
                </div>
              </div>

              {/* ── Ask HR ── the requests already sent; New Request opens the
                  form in place (a full form on an overview read as heavy). */}
              <div className="dash-card myhr-span2">
                {cardHead('Ask HR', 'A document update, a profile change or anything else',
                  !askOpen && (
                    <button className="primary-btn" onClick={() => setAskOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}>
                      <MessageSquarePlus size={13} /> New Request
                    </button>
                  ))}
                <div style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
                  {askOpen && (
                  <div>
                    <label style={{ ...lbl, marginTop: 0 }}>What do you need?</label>
                    <select className="form-input" style={input} value={askForm.type} onChange={e => setAskForm(f => ({ ...f, type: e.target.value }))}>
                      {ASK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <label style={lbl}>Details</label>
                    <textarea className="form-input" rows={3} style={{ ...input, resize: 'vertical' }} value={askForm.message} autoFocus
                      placeholder='e.g. "My visa was renewed - please update my right-to-work document."'
                      onChange={e => setAskForm(f => ({ ...f, message: e.target.value }))} />
                    {/* Optional attachment - the new/updated document itself */}
                    <input ref={askFileRef} type="file" style={{ display: 'none' }}
                      onChange={e => setAskFile(e.target.files?.[0] || null)} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="secondary-btn" onClick={() => askFileRef.current?.click()}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '6px 12px' }}>
                        <FileText size={13} /> {askFile ? 'Change File' : 'Attach Document'}
                      </button>
                      {askFile && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink)', background: 'var(--mist)', borderRadius: 8, padding: '4px 10px', maxWidth: 220 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{askFile.name}</span>
                          <X size={12} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { setAskFile(null); if (askFileRef.current) askFileRef.current.value = ''; }} />
                        </span>
                      )}
                      <div style={{ flex: 1 }} />
                      <button className="secondary-btn" onClick={() => setAskOpen(false)} disabled={askBusy}>Cancel</button>
                      <button className="primary-btn" onClick={submitAsk} disabled={askBusy || !askForm.message.trim()}>
                        {askBusy ? <><Spinner size={13} /> Sending…</> : 'Send to HR'}
                      </button>
                    </div>
                  </div>
                  )}

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>My Requests</span>
                      {asks.length > 0 && (
                        <select className="form-input" value={askFilter} onChange={e => setAskFilter(e.target.value)} aria-label="Filter my requests"
                          style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 22px 3px 8px', height: 'auto' }}>
                          <option value="all">All</option>
                          <option value="open">Open</option>
                          <option value="resolved">Resolved</option>
                        </select>
                      )}
                    </div>
                    {asks.length === 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0 4px' }}>Nothing sent yet - HR answers here.</div>
                    )}
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
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
