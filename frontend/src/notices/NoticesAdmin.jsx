// People > Notices (Neil, Oct 21 2026): the library of labor law notices and
// the Employee Manual, and the two-person approval of every new version.
// One section at a time: Library, Review Queue, Location Unknown, Settings,
// Activity. A notice opens in a 60vw popup with its versions.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, ExternalLink, FileText, FolderOpen, MapPin, Plus, Search, Upload } from 'lucide-react';
import { api, saveBlob } from '../api';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import EgnyteBrowser from '../components/EgnyteBrowser';
import { DateField, Modal } from '../tasks/components';
import { filesFromPaste } from '../tasks/lib';
import SitePosters from './SitePosters';
import {
  Chip, KIND_LABEL, MODE_LABEL, NoticePdfModal, SITE_KIND_LABEL, STATE_CHIP, TRIGGER_LABEL, VERSION_CHIP,
  appliesText, areaLabel, day,
} from './lib';

const CARD = { background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, boxShadow: 'var(--wk-shadow)' };
const HD = { fontSize: 14, fontWeight: 700, color: 'var(--ink)' };
const LBL = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' };
const SECTIONS = [
  { key: 'library', label: 'Library' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'queue', label: 'Review Queue' },
  { key: 'unplaced', label: 'Location Unknown' },
  { key: 'sites', label: 'Sites' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'review', label: 'Annual Review' },
  { key: 'settings', label: 'Settings' },
  { key: 'activity', label: 'Activity' },
];
const AREA_ORDER = (a) => (a === 'US' ? 0 : a === 'IN' ? 9 : a.includes(':') ? 2 : 1);

export default function NoticesAdmin({ toastOk, toastErr }) {
  const [section, setSection] = useState('library');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState('');
  const load = useCallback(() => {
    setErr('');
    api.noticesLibrary().then(setData).catch(e => setErr(e?.message || 'Could not load the notices.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) return <ErrorBanner message={err} onRetry={load} />;
  if (!data) return <SkeletonBlocks count={3} height={90} />;
  const queueCount = data.queue.length;

  return (
    <div>
      <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {SECTIONS.map(s => {
          const n = s.key === 'queue' ? queueCount : s.key === 'unplaced' ? data.unplaced.length : 0;
          return (
            <button key={s.key} role="tab" aria-selected={section === s.key} onClick={() => setSection(s.key)}
              className={section === s.key ? 'primary-btn' : 'secondary-btn'} style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
              {s.label}{n > 0 && <span style={{ marginLeft: 6, fontWeight: 800 }}>{n}</span>}
            </button>
          );
        })}
      </div>
      {section === 'library' && <Library data={data} onOpen={setOpenId} onCreated={(id) => { load(); setOpenId(id); }} toastErr={toastErr} />}
      {section === 'queue' && <Queue data={data} onOpen={setOpenId} />}
      {section === 'coverage' && <Coverage toastErr={toastErr} />}
      {section === 'unplaced' && <Unplaced data={data} onSaved={load} toastOk={toastOk} toastErr={toastErr} />}
      {section === 'settings' && <Settings data={data} onSaved={load} toastOk={toastOk} toastErr={toastErr} />}
      {section === 'activity' && <Activity />}
      {section === 'sites' && <Sites toastOk={toastOk} toastErr={toastErr} />}
      {section === 'calendar' && <CalendarView onOpen={setOpenId} />}
      {section === 'review' && <AnnualReview onOpen={setOpenId} toastOk={toastOk} toastErr={toastErr} />}
      {openId && <NoticeDetail id={openId} canApprove={data.canApprove} onClose={() => { setOpenId(''); load(); }} onChanged={load}
        toastOk={toastOk} toastErr={toastErr} />}
    </div>
  );
}

// ── Library ─────────────────────────────────────────────────────────────────

function Library({ data, onOpen, onCreated, toastErr }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const counts = useMemo(() => {
    const c = {};
    data.notices.forEach(n => { c[n.state] = (c[n.state] || 0) + 1; });
    return c;
  }, [data]);
  const shown = data.notices.filter(n => (filter === 'all' ? n.state !== 'retired' : n.state === filter)
    && (!q || `${n.title} ${n.formCode} ${n.agency}`.toLowerCase().includes(q.toLowerCase())));
  const groups = {};
  shown.forEach(n => { (groups[n.area] = groups[n.area] || []).push(n); });
  const areas = Object.keys(groups).sort((a, b) => AREA_ORDER(a) - AREA_ORDER(b) || a.localeCompare(b));

  return (
    <div>
      <div style={{ ...CARD, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--muted)' }} />
          <input className="form-input" aria-label="Search notices" placeholder="Search notices" value={q} onChange={e => setQ(e.target.value)}
            style={{ paddingLeft: 30, width: '100%' }} />
        </div>
        {['all', 'needs_file', 'source_changed', 'awaiting_approval', 'scheduled', 'review_due', 'current', 'retired'].map(k => (
          <button key={k} onClick={() => setFilter(k)} className={filter === k ? 'primary-btn' : 'secondary-btn'} style={{ fontSize: 12 }}>
            {k === 'all' ? 'All' : STATE_CHIP[k].label}{k !== 'all' && counts[k] ? ` ${counts[k]}` : ''}
          </button>
        ))}
        <button className="secondary-btn" onClick={() => setAdding(true)} style={{ fontSize: 12 }}><Plus size={13} /> Add Notice</button>
      </div>
      {!shown.length && <div style={{ ...CARD, fontSize: 13, color: 'var(--muted)' }}>No notices match.</div>}
      {areas.map(a => (
        <div key={a} style={CARD}>
          <div style={{ ...HD, marginBottom: 8 }}>{areaLabel(a)}</div>
          {groups[a].map(n => (
            <button key={n.id} onClick={() => onOpen(n.id)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '9px 6px', border: 'none', borderTop: '1px solid var(--wk-line2)', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--ink)' }}>
              <FileText size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
                  {[n.formCode, KIND_LABEL[n.kind], MODE_LABEL[n.mode]].filter(Boolean).join(' - ')}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                  {n.live ? `${n.live.label}, in effect since ${day(n.live.effectiveDate)}` : 'No approved file yet'}
                  {n.scheduled ? ` - next: ${n.scheduled.label} on ${day(n.scheduled.effectiveDate)}` : ''}
                </span>
              </span>
              <Chip spec={STATE_CHIP[n.state]} />
            </button>
          ))}
        </div>
      ))}
      {adding && <AddNotice onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); onCreated(id); }} toastErr={toastErr} />}
    </div>
  );
}

const BLANK = { title: '', form_code: '', agency: '', kind: 'poster', area: 'US', mode: 'post', trigger: 'always', annual_due: '',
  window: [], applies: { workerTypes: ['employee'] }, requires_ack: false, languages: ['en'], source_url: '', notes: '', review_every_months: 12 };

function toBody(n) {
  return { title: n.title, form_code: n.formCode, agency: n.agency, kind: n.kind, area: n.area, mode: n.mode, trigger: n.trigger,
    annual_due: n.annualDue, window: n.window, applies: n.applies, requires_ack: n.requiresAck, languages: n.languages,
    source_url: n.sourceUrl, notes: n.notes, review_every_months: n.reviewEvery || 12 };
}

function NoticeFields({ form, setForm }) {
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const rule = form.applies || {};
  const setRule = (k, v) => setForm(f => ({ ...f, applies: { ...(f.applies || {}), [k]: v } }));
  const [stateCode, city] = String(form.area || 'US').split(':');
  const row = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Title</span>
        <input id="notice-title" className="form-input" value={form.title} onChange={e => set('title', e.target.value)} /></label>
      <div style={row}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Form Number</span>
          <input id="notice-form" className="form-input" value={form.form_code} onChange={e => set('form_code', e.target.value)} placeholder="e.g. DWC 7" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Agency</span>
          <input id="notice-agency" className="form-input" value={form.agency} onChange={e => set('agency', e.target.value)} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Kind</span>
          <select id="notice-kind" className="form-input" value={form.kind} onChange={e => set('kind', e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
      </div>
      <div style={row}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Where</span>
          <select id="notice-area" className="form-input" value={stateCode} onChange={e => set('area', e.target.value)}>
            <option value="US">Federal (all US)</option>
            <option value="US-CA">California</option>
            <option value="US-TX">Texas</option>
            <option value="IN">India</option>
            {!['US', 'US-CA', 'US-TX', 'IN'].includes(stateCode) && <option value={stateCode}>{stateCode}</option>}
          </select></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>City (Optional)</span>
          <input id="notice-city" className="form-input" value={city || ''} disabled={!stateCode.startsWith('US-')}
            onChange={e => set('area', e.target.value.trim() ? `${stateCode}:${e.target.value.toUpperCase()}` : stateCode)} placeholder="e.g. San Diego" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>How</span>
          <select id="notice-mode" className="form-input" value={form.mode} onChange={e => set('mode', e.target.value)}>
            {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>When</span>
          <select id="notice-trigger" className="form-input" value={form.trigger} onChange={e => set('trigger', e.target.value)}>
            {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
      </div>
      {(form.trigger === 'annual' || form.trigger === 'hire_annual') && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 220 }}><span style={LBL}>Yearly Due (MM-DD)</span>
          <input id="notice-annual" className="form-input" value={form.annual_due} onChange={e => set('annual_due', e.target.value)} placeholder="02-01" /></label>
      )}
      <div style={row}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>For</span>
          <select id="notice-workers" className="form-input" value={(rule.workerTypes || ['employee']).join(',')} onChange={e => setRule('workerTypes', e.target.value.split(','))}>
            <option value="employee">Employees</option>
            <option value="contractor">Contractors</option>
            <option value="contractor,employee">Everyone</option>
          </select></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Only From Headcount</span>
          <input id="notice-headcount" className="form-input" type="number" min="0" value={rule.minHeadcount || ''} onChange={e => setRule('minHeadcount', Number(e.target.value) || 0)} placeholder="Any" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Review Every (Months)</span>
          <input id="notice-review" className="form-input" type="number" min="1" max="36" value={form.review_every_months} onChange={e => set('review_every_months', Number(e.target.value) || 12)} /></label>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
        {Object.entries(SITE_KIND_LABEL).map(([k, v]) => (
          <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={(rule.siteKinds || []).includes(k)}
              onChange={e => setRule('siteKinds', e.target.checked ? [...(rule.siteKinds || []), k] : (rule.siteKinds || []).filter(x => x !== k))} />
            Only at {v} sites</label>
        ))}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!rule.hourlyOnly} onChange={e => setRule('hourlyOnly', e.target.checked)} /> Hourly Staff Only</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!form.requires_ack} onChange={e => set('requires_ack', e.target.checked)} /> Each Person Acknowledges It</label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Official Source (Watched Every Night)</span>
        <input id="notice-source" className="form-input" value={form.source_url} onChange={e => set('source_url', e.target.value)} placeholder="https://www.dir.ca.gov/..." /></label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Notes</span>
        <textarea id="notice-notes" className="form-input" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} /></label>
    </div>
  );
}

function AddNotice({ onClose, onCreated, toastErr }) {
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    api.createNotice(form).then(n => onCreated(n.id)).catch(e => toastErr?.(e?.message || 'Could not add it.')).finally(() => setBusy(false));
  };
  return (
    <Modal title="Add Notice" onClose={onClose} isDirty={!!form.title}
      footer={<><button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={save} disabled={busy || !form.title.trim()}>Add Notice</button></>}>
      <NoticeFields form={form} setForm={setForm} />
    </Modal>
  );
}

// ── One notice ──────────────────────────────────────────────────────────────

function NoticeDetail({ id, canApprove, onClose, onChanged, toastOk, toastErr }) {
  const [n, setN] = useState(null);
  const [editing, setEditing] = useState(null);
  const [newVer, setNewVer] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.noticeDetail(id).then(setN).catch(e => { toastErr?.(e?.message || 'Could not open it.'); onClose(); }), [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  // Busy until the notice is re-read (a stale Approve could be clicked again), and the queue and counts behind refresh too.
  const run = (p, ok) => { setBusy(true); return p.then(() => { if (ok) toastOk?.(ok); onChanged?.(); return load(); }).catch(e => toastErr?.(e?.message || 'That did not work.')).finally(() => setBusy(false)); };

  if (!n) return <Modal title="Notice" onClose={onClose}><SkeletonBlocks count={2} height={80} /></Modal>;
  const ackKind = ['manual', 'addendum', 'policy', 'contractor_code'].includes(n.kind);

  const saveDetails = () => run(api.updateNotice(n.id, editing), 'Saved.').then(() => setEditing(null));
  const retire = async () => {
    const reason = await dialog.prompt(n.status === 'active' ? 'Why does this notice no longer apply?' : 'Why is it back?', { required: true });
    if (reason) run(api.retireNotice(n.id, reason), n.status === 'active' ? 'Retired.' : 'Restored.');
  };
  const prepare = () => run(api.createNoticeVersion(n.id, newVer), 'Draft ready - add the file.').then(() => setNewVer(null));

  return (
    <Modal title={n.title} onClose={onClose}
      footer={<><button className="secondary-btn" onClick={retire} disabled={busy}>{n.status === 'active' ? 'Retire Notice' : 'Restore Notice'}</button>
        {n.live && n.kind !== 'form' && <button className="secondary-btn" onClick={() => setSending(true)} disabled={busy}>Send To People</button>}
        <button className="secondary-btn" onClick={() => download(api.exportNoticeRecord(n.id), `workplace-notice-${n.id}.csv`, toastErr)} disabled={busy}>Export Record</button>
        <span style={{ flex: 1 }} /><button className="primary-btn" onClick={onClose}>Done</button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip spec={STATE_CHIP[n.state]} />
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{[n.formCode, n.agency, areaLabel(n.area), KIND_LABEL[n.kind], MODE_LABEL[n.mode], TRIGGER_LABEL[n.trigger]].filter(Boolean).join(' - ')}</span>
        </div>
        <div style={{ fontSize: 13 }}><b>For:</b> {appliesText(n)}.{n.requiresAck && ' Each person acknowledges it.'}</div>
        {n.notes && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{n.notes}</div>}
        {n.sourceUrl && (
          <div style={{ fontSize: 12.5 }}>
            <a href={n.sourceUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>Official Source <ExternalLink size={12} /></a>
            {n.source?.lastCheckedAt && <span style={{ color: 'var(--muted)' }}> - checked {formatDateTime(n.source.lastCheckedAt)}</span>}
            {n.source?.lastError && <span style={{ color: '#b91c1c' }}> - last check failed: {n.source.lastError}</span>}
            {n.source && <button className="secondary-btn" disabled={busy} onClick={() => run(api.checkNoticeSource(n.id).then(r => toastOk?.(CHECK_RESULT[r.result] || 'Checked.')))} style={{ fontSize: 11.5, marginLeft: 8 }}>Check Now</button>}
          </div>
        )}

        {editing ? (
          <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: 14 }}>
            <NoticeFields form={editing} setForm={setEditing} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="primary-btn" onClick={saveDetails} disabled={busy}>Save Details</button>
              <button className="secondary-btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div><button className="secondary-btn" onClick={() => setEditing(toBody(n))} style={{ fontSize: 12.5 }}>Edit Details</button></div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={HD}>Versions</span><span style={{ flex: 1 }} />
          {!newVer && <button className="primary-btn" onClick={() => setNewVer({ label: '', effective_date: '', major: true, summary: n.versions.length ? '' : 'First version', agency_revision: '' })} style={{ fontSize: 12.5 }}><Plus size={13} /> Prepare New Version</button>}
        </div>
        {newVer && (
          <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: 14 }}>
            <VersionFields form={newVer} setForm={setNewVer} ackKind={ackKind} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="primary-btn" onClick={prepare} disabled={busy}>Create Draft</button>
              <button className="secondary-btn" onClick={() => setNewVer(null)}>Cancel</button>
            </div>
          </div>
        )}
        {!n.versions.length && !newVer && <div style={{ fontSize: 13, color: 'var(--muted)' }}>No versions yet. Prepare the first one and add its file.</div>}
        {n.versions.map(v => (
          <VersionCard key={v.id} v={v} notice={n} canApprove={canApprove} ackKind={ackKind} busy={busy} run={run}
            onView={(lang) => setViewing({ id: v.id, lang, title: `${n.title} - ${v.label}` })} />
        ))}

        <details>
          <summary style={{ ...HD, cursor: 'pointer' }}>History</summary>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {n.events.map((e, i) => (
              <div key={i} style={{ fontSize: 12.5, color: 'var(--muted)' }}>{formatDateTime(e.at)} - {e.actor} - {EVENT_LABEL[e.action] || e.action}</div>
            ))}
          </div>
        </details>
      </div>
      {viewing && <NoticePdfModal versionId={viewing.id} lang={viewing.lang} title={viewing.title} onClose={() => setViewing(null)} toastErr={toastErr} />}
      {sending && <SendModal notice={n} onClose={() => setSending(false)} onSent={(k) => { setSending(false); toastOk?.(`Sent to ${k} ${k === 1 ? 'person' : 'people'}.`); load(); }} toastErr={toastErr} />}
    </Modal>
  );
}

// Give the live version to chosen people - an event (an injury, a leave, an
// inspection) or someone who needs a copy. Each gets an email with the file.
function SendModal({ notice, onClose, onSent, toastErr }) {
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getPeopleDirectory().then(r => setPeople(Array.isArray(r) ? r : (r?.people || []))).catch(() => setPeople([])); }, []);
  const rows = (people || []).filter(p => p.email && (!q || `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()))).slice(0, 60);
  const toggle = (e) => setPicked(x => (x.includes(e) ? x.filter(y => y !== e) : [...x, e]));
  const go = () => {
    setBusy(true);
    api.sendNotice(notice.id, { emails: picked, note }).then(r => onSent(r.sent))
      .catch(e => toastErr?.(e?.message || 'Could not send it.')).finally(() => setBusy(false));
  };
  return (
    <Modal title={`Send ${notice.title}`} onClose={onClose} isDirty={picked.length > 0}
      footer={<><button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={go} disabled={busy || !picked.length}>Send To {picked.length || ''} {picked.length === 1 ? 'Person' : 'People'}</button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Each person gets an email with {notice.live?.label} attached, and it shows under Given To You in their Workday.</div>
        <input aria-label="Search people" className="form-input" placeholder="Search people" value={q} onChange={e => setQ(e.target.value)} />
        {!people ? <SkeletonBlocks count={2} height={40} /> : (
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--wk-line2)', borderRadius: 10 }}>
            {rows.map(p => (
              <label key={p.email} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderTop: '1px solid var(--wk-line2)', fontSize: 13 }}>
                <input type="checkbox" checked={picked.includes(p.email.toLowerCase())} onChange={() => toggle(p.email.toLowerCase())} />
                <span style={{ flex: 1 }}>{p.name || p.email}</span><span style={{ color: 'var(--muted)', fontSize: 12 }}>{p.email}</span>
              </label>
            ))}
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Message (Optional)</span>
          <textarea id="notice-send-note" className="form-input" rows={2} value={note} onChange={e => setNote(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

const CHECK_RESULT = {
  same: 'No change since the last check.', baseline: 'Fingerprint saved - future changes will show here.',
  drafted: 'The official file is waiting for approval below.', changed: 'The official page changed - check it.',
  moved: "Next year's file was found and is waiting for approval.", failed: 'The link did not answer - see the error.',
};

const EVENT_LABEL = {
  notice_created: 'Added the notice', notice_changed: 'Changed the details', notice_retired: 'Retired the notice', notice_restored: 'Restored the notice',
  version_created: 'Prepared a version', version_edited: 'Edited a draft', file_added: 'Added a file', file_removed: 'Removed a file',
  version_submitted: 'Sent for approval', version_approved: 'Approved', version_sent_back: 'Sent back', version_withdrawn: 'Withdrew a version',
  watcher_changed: 'The official source changed', watcher_draft: 'Drafted the new official file', settings_saved: 'Changed settings', person_placed: 'Placed a person',
  watcher_moved: "Found next year's official file", version_date_set: 'Set the effective date while approving', checked_now: 'Checked the source',
  version_announced: 'Announced to everyone it applies to', acknowledged: 'Acknowledged', delivered: 'Delivered to people',
  review_opened: 'Opened the Annual Notice Review', review_signed: 'Signed the Annual Notice Review', emergency_contact_set: 'Answered the emergency contact question',
};

function VersionFields({ form, setForm, ackKind }) {
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Label</span>
          <input id="ver-label" className="form-input" value={form.label} onChange={e => set('label', e.target.value)} placeholder="e.g. 2027" /></label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Takes Effect</span>
          <DateField value={form.effective_date} onChange={v => set('effective_date', v || '')} placeholder="Pick a date" /></div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Agency Revision</span>
          <input id="ver-rev" className="form-input" value={form.agency_revision} onChange={e => set('agency_revision', e.target.value)} placeholder="e.g. Rev. 04/2024" /></label>
      </div>
      {ackKind && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={!!form.major} onChange={e => set('major', e.target.checked)} />
          Major change - everyone acknowledges it again (leave off for a small fix such as a phone number)</label>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>What Changed</span>
        <textarea id="ver-summary" className="form-input" rows={2} value={form.summary} onChange={e => set('summary', e.target.value)} placeholder="In plain words - shown to employees" /></label>
    </div>
  );
}

function VersionCard({ v, notice, canApprove, ackKind, busy, run, onView }) {
  const [edit, setEdit] = useState(null);
  const [lang, setLang] = useState('en');
  const [approveDate, setApproveDate] = useState(v.effectiveDate || '');
  const [egnyte, setEgnyte] = useState(false);
  const editable = v.status === 'draft' || v.status === 'rejected';
  const upload = (file, source = '') => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('lang', lang);
    form.append('source', source);
    run(api.uploadNoticeFile(v.id, form), 'File added.');
  };
  const onPaste = (e) => { const f = filesFromPaste(e)[0]; if (f && editable) { e.preventDefault(); upload(f); } };
  const sendBack = async () => {
    const note = await dialog.prompt('What needs to change?', { required: true });
    if (note) run(api.reviewNoticeVersion(v.id, { decision: 'send_back', note }), 'Sent back.');
  };
  const withdraw = async () => {
    const reason = await dialog.prompt('Why withdraw this version?', { required: true });
    if (reason) run(api.withdrawNoticeVersion(v.id, reason), 'Withdrawn.');
  };
  const future = v.status === 'approved' && v.effectiveDate > new Date().toISOString().slice(0, 10);
  const isLive = notice.live?.id === v.id;

  return (
    <div onPaste={onPaste} style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '12px 14px', background: isLive ? 'hsla(var(--color-green),0.04)' : 'var(--card)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{v.label}</span>
        <Chip spec={isLive ? { label: 'Live', bg: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))' } : future ? STATE_CHIP.scheduled : VERSION_CHIP[v.status]} />
        {ackKind && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v.major ? 'Major' : 'Minor'}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v.effectiveDate ? `Takes effect ${day(v.effectiveDate)}` : 'No date yet'}</span>
      </div>
      {v.summary && <div style={{ fontSize: 13, marginTop: 6 }}>{v.summary}</div>}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        Prepared by {v.preparedBy || 'the watcher'}{v.preparedAt ? ` on ${formatDateTime(v.preparedAt)}` : ''}
        {v.approvedBy && ` - approved by ${v.approvedBy} on ${formatDateTime(v.approvedAt)}`}
        {v.agencyRevision && ` - agency revision ${v.agencyRevision}`}
      </div>
      {v.reviewNote && <div style={{ fontSize: 12.5, marginTop: 4, color: v.status === 'rejected' ? '#b91c1c' : 'var(--muted)' }}>Note: {v.reviewNote}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {v.files.map(f => (
          <button key={f.lang} className="secondary-btn" onClick={() => onView(f.lang)} style={{ fontSize: 12 }} title={`Fingerprint ${f.sha256.slice(0, 12)}`}>
            <FileText size={12} /> {f.name} ({f.lang.toUpperCase()})
          </button>
        ))}
        {!v.files.length && notice.kind !== 'closures' && <span style={{ fontSize: 12.5, color: '#b91c1c' }}>No file yet.</span>}
      </div>

      {editable && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {edit ? (
            <>
              <VersionFields form={edit} setForm={setEdit} ackKind={ackKind} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="primary-btn" disabled={busy} onClick={() => run(api.updateNoticeVersion(v.id, edit), 'Saved.').then(() => setEdit(null))}>Save</button>
                <button className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select aria-label="File language" className="form-input" value={lang} onChange={e => setLang(e.target.value)} style={{ width: 120 }}>
                <option value="en">English</option><option value="es">Spanish</option>
              </select>
              <label className="secondary-btn" style={{ fontSize: 12, cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <Upload size={12} /> Upload File
                <input type="file" accept="application/pdf,image/png,image/jpeg" hidden onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              <button className="secondary-btn" onClick={() => setEgnyte(true)} style={{ fontSize: 12 }}><FolderOpen size={12} /> From Egnyte</button>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>or press Ctrl+V to paste an image</span>
              <span style={{ flex: 1 }} />
              <button className="secondary-btn" onClick={() => setEdit({ label: v.label, effective_date: v.effectiveDate, major: v.major, summary: v.summary, agency_revision: v.agencyRevision })} style={{ fontSize: 12 }}>Edit</button>
              <button className="primary-btn" disabled={busy} onClick={() => run(api.submitNoticeVersion(v.id), 'Sent for approval.')} style={{ fontSize: 12 }}>Send For Approval</button>
            </div>
          )}
        </div>
      )}
      {v.status === 'in_review' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {canApprove ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Takes effect</span>
              <DateField value={approveDate} onChange={d => setApproveDate(d || '')} placeholder="Pick a date" />
              <button className="primary-btn" disabled={busy} onClick={() => run(api.reviewNoticeVersion(v.id, approveDate && approveDate !== v.effectiveDate ? { decision: 'approve', effective_date: approveDate } : { decision: 'approve' }), 'Approved.')} style={{ fontSize: 12 }}><CheckCircle size={12} /> Approve</button>
              <button className="secondary-btn" disabled={busy} onClick={sendBack} style={{ fontSize: 12 }}>Send Back</button>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Open the file and compare it with the live version first. You cannot approve a version you worked on.</span>
            </>
          ) : <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Waiting for a notice approver.</span>}
        </div>
      )}
      {future && <div style={{ marginTop: 8 }}><button className="secondary-btn" onClick={withdraw} disabled={busy} style={{ fontSize: 12 }}>Withdraw</button></div>}
      {egnyte && <EgnyteBrowser onClose={() => setEgnyte(false)} onPick={(file) => { setEgnyte(false); upload(file, 'egnyte'); }} />}
    </div>
  );
}

// ── Review queue ────────────────────────────────────────────────────────────

function Queue({ data, onOpen }) {
  const titles = Object.fromEntries(data.notices.map(n => [n.id, n.title]));
  if (!data.queue.length) return <div style={{ ...CARD, fontSize: 13, color: 'var(--muted)' }}>Nothing is waiting for approval.</div>;
  return (
    <div style={CARD}>
      <div style={{ ...HD, marginBottom: 4 }}>Waiting For Approval</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>
        {data.canApprove ? 'Open each one, compare the new file with the live one, then approve or send it back.' : 'A notice approver approves these.'}
      </div>
      {data.queue.map(v => (
        <button key={v.id} onClick={() => onOpen(v.noticeId)}
          style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'center', padding: '9px 6px', border: 'none', borderTop: '1px solid var(--wk-line2)', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--ink)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>{titles[v.noticeId]} - {v.label}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>Takes effect {day(v.effectiveDate)} - prepared by {v.preparedBy || 'the watcher'} - {v.summary}</span>
          </span>
          <Chip spec={VERSION_CHIP.in_review} />
        </button>
      ))}
    </div>
  );
}

// ── Location unknown ────────────────────────────────────────────────────────

function Unplaced({ data, onSaved, toastOk, toastErr }) {
  const [rows, setRows] = useState({});
  if (!data.unplaced.length) {
    return <div style={{ ...CARD, fontSize: 13, color: 'var(--muted)' }}>Every US employee is placed in a state.</div>;
  }
  const save = (email) => {
    const r = rows[email] || {};
    api.placeNoticePerson(email, { notice_state: r.state || '', notice_city: r.city || '', language: '' })
      .then(() => { toastOk?.('Placed.'); onSaved(); }).catch(e => toastErr?.(e?.message || 'Could not save.'));
  };
  return (
    <div style={CARD}>
      <div style={{ ...HD, marginBottom: 4 }}>Location Unknown</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        These people get the federal notices only, because Nexus cannot tell which state they work in. Give them a work site in People, or set where they work here (a remote worker: the state they live in).
      </div>
      {data.unplaced.map(p => (
        <div key={p.email} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--wk-line2)' }}>
          <MapPin size={14} style={{ color: 'var(--muted)' }} />
          <span style={{ flex: '1 1 200px', fontSize: 13.5, fontWeight: 600 }}>{p.name}<span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>{p.label}</span></span>
          <input aria-label={`State for ${p.name}`} className="form-input" placeholder="State (CA)" maxLength={2} style={{ width: 90 }}
            value={rows[p.email]?.state || ''} onChange={e => setRows(r => ({ ...r, [p.email]: { ...r[p.email], state: e.target.value.toUpperCase() } }))} />
          <input aria-label={`City for ${p.name}`} className="form-input" placeholder="City (optional)" style={{ width: 150 }}
            value={rows[p.email]?.city || ''} onChange={e => setRows(r => ({ ...r, [p.email]: { ...r[p.email], city: e.target.value } }))} />
          <button className="primary-btn" onClick={() => save(p.email)} disabled={!(rows[p.email]?.state || '').match(/^[A-Z]{2}$/)} style={{ fontSize: 12 }}>Save</button>
        </div>
      ))}
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function Settings({ data, onSaved, toastOk, toastErr }) {
  const [s, setS] = useState(data.settings);
  const [approvers, setApprovers] = useState((data.settings.approvers || []).join(', '));
  const [elections, setElections] = useState((data.settings.elections || []).join(', '));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setS(x => ({ ...x, [k]: v }));
  const save = () => {
    setBusy(true);
    const body = {
      countCompaniesTogether: s.countCompaniesTogether, yearlyAck: s.yearlyAck, yearlyAckDueDays: Number(s.yearlyAckDueDays) || 31,
      ackDueDays: Number(s.ackDueDays) || 14, eVerify: s.eVerify, txWorkersComp: s.txWorkersComp, watcherOn: s.watcherOn,
      elections: elections.split(',').map(x => x.trim()).filter(Boolean),
    };
    const named = approvers.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (named.join(',') !== (data.settings.approvers || []).join(',')) body.approvers = named;
    api.saveNoticeSettings(body).then(() => { toastOk?.('Settings saved.'); onSaved(); })
      .catch(e => toastErr?.(e?.message || 'Could not save.')).finally(() => setBusy(false));
  };
  const check = (k, label, hint) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
      <input type="checkbox" checked={!!s[k]} onChange={e => set(k, e.target.checked)} style={{ marginTop: 3 }} />
      <span><b>{label}</b><span style={{ display: 'block', color: 'var(--muted)', fontSize: 12.5 }}>{hint}</span></span>
    </label>
  );
  return (
    <div style={{ ...CARD, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Notice Approvers</span>
        <input id="notice-approvers" className="form-input" value={approvers} onChange={e => setApprovers(e.target.value)} placeholder="Work emails, comma separated" disabled={!data.canApprove} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Empty means HR approves: each company's HR contact, administrators and Full HR. Now: {data.approvers.map(a => a.name).join(', ') || 'nobody set'}.
          {!data.canApprove && ' Only an approver can change this.'}
        </span></label>
      {check('countCompaniesTogether', 'Count Every US Company Together', 'Headcount limits (5+, 15+, 50+) use Greens, MCD and Oversite together.')}
      {check('yearlyAck', 'Acknowledge The Manual Every January', 'Everyone acknowledges the manual and addenda again each January, even when nothing changed.')}
      {check('eVerify', 'We Use E-Verify', 'Shows the E-Verify and Right to Work posters.')}
      {check('watcherOn', 'Watch The Official Sources Every Night', 'A changed official file becomes a draft in the Review Queue.')}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Days To Acknowledge</span>
          <input id="notice-ackdays" className="form-input" type="number" min="1" max="90" value={s.ackDueDays} onChange={e => set('ackDueDays', e.target.value)} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>January Round Due In (Days)</span>
          <input id="notice-yeardays" className="form-input" type="number" min="1" max="90" value={s.yearlyAckDueDays} onChange={e => set('yearlyAckDueDays', e.target.value)} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>Texas Workers' Comp</span>
          <select id="notice-txwc" className="form-input" value={s.txWorkersComp} onChange={e => set('txWorkersComp', e.target.value)}>
            <option value="subscriber">We carry it (Notice 6)</option><option value="non_subscriber">We do not (Notice 5)</option>
          </select></label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={LBL}>California Statewide Elections</span>
        <input id="notice-elections" className="form-input" value={elections} onChange={e => setElections(e.target.value)} placeholder="2026-11-03, 2028-03-05" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Dates as YYYY-MM-DD. Time Off to Vote shows from 10 days before each one.</span></label>
      <div><button className="primary-btn" onClick={save} disabled={busy}>Save Settings</button></div>
    </div>
  );
}

// ── Coverage (who still owes what) and the audit record ─────────────────────

function download(p, name, toastErr) {
  return p.then(({ blob, filename }) => saveBlob(blob, filename || name)).catch(e => toastErr?.(e?.message || 'Could not export.'));
}

function Coverage({ toastErr }) {
  const [data, setData] = useState(null);
  const [only, setOnly] = useState('open');
  useEffect(() => { api.noticeCoverage().then(setData).catch(e => { toastErr?.(e?.message || 'Could not load coverage.'); setData({ people: [], totals: {} }); }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <SkeletonBlocks count={3} height={60} />;
  const t = data.totals || {};
  const open = (p) => p.owed.length || p.notGiven.length || p.emergency === 'open' || (p.country === 'US' && p.workerType === 'employee' && !p.state);
  const rows = data.people.filter(p => only === 'all' || open(p));
  const tile = (n, label, warn) => (
    <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: warn && n ? '#b91c1c' : 'var(--ink)' }}>{n ?? 0}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
    </div>
  );
  return (
    <div>
      <div style={{ ...CARD, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {tile(t.allDone, `of ${t.people || 0} people are complete`)}
        {tile(t.owing, 'still owe an acknowledgment', false)}
        {tile(t.overdue, 'are overdue', true)}
        {tile(t.notGiven, 'new hires missing at-hire notices', true)}
        {tile(t.unplaced, 'cannot be placed in a state', true)}
        {tile(t.emergencyOpen, 'have not answered the emergency contact question')}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="secondary-btn" onClick={() => download(api.exportNoticesAll(), 'workplace-notices-record.csv', toastErr)} style={{ fontSize: 12 }}>Export Every Delivery</button>
          <button className="secondary-btn" onClick={() => download(api.exportNoticeVersions(), 'workplace-notice-versions.csv', toastErr)} style={{ fontSize: 12 }}>Export Every Version</button>
        </div>
      </div>
      <div style={CARD}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={HD}>People</span><span style={{ flex: 1 }} />
          <button className={only === 'open' ? 'primary-btn' : 'secondary-btn'} onClick={() => setOnly('open')} style={{ fontSize: 12 }}>Needs Something</button>
          <button className={only === 'all' ? 'primary-btn' : 'secondary-btn'} onClick={() => setOnly('all')} style={{ fontSize: 12 }}>Everyone</button>
        </div>
        {!rows.length && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Everyone is complete.</div>}
        {rows.map(p => (
          <div key={p.email} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 0', borderTop: '1px solid var(--wk-line2)', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 260px', fontSize: 13 }}>
              <b>{p.name}</b> <span style={{ color: 'var(--muted)', fontSize: 12 }}>{p.country === 'IN' ? 'India' : p.state ? areaLabel(`US-${p.state}`) : 'Location unknown'}</span>
              <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)' }}>
                {p.owed.map(o => `${o.title} ${o.overdue ? 'overdue since' : 'due'} ${day(o.due)}`).join('; ')}
                {p.notGiven.length > 0 && `${p.owed.length ? ' - ' : ''}Not given: ${p.notGiven.join(', ')}`}
                {p.emergency === 'open' && `${p.owed.length || p.notGiven.length ? ' - ' : ''}Emergency contact question open`}
                {!p.owed.length && !p.notGiven.length && p.emergency !== 'open' && (p.state || p.country === 'IN') && 'Complete'}
              </span>
            </span>
            <button className="secondary-btn" onClick={() => download(api.exportNoticePerson(p.email), `workplace-notices-${p.email.split('@')[0]}.csv`, toastErr)} style={{ fontSize: 12 }}>Export Record</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Sites (paper posters) ───────────────────────────────────────────────────

function Sites({ toastOk, toastErr }) {
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [openId, setOpenId] = useState('');
  const load = useCallback(() => { api.noticeSites().then(r => setRows(r.sites || [])).catch(e => { toastErr?.(e?.message || 'Could not load the sites.'); setRows([]); }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); api.getPeopleDirectory().then(r => setPeople(Array.isArray(r) ? r : [])).catch(() => {}); }, [load]);
  if (!rows) return <SkeletonBlocks count={3} height={60} />;
  const save = (s, patchBody) => api.setNoticeSite(s.id, { kind: s.kind, city: s.city, lead_email: s.lead, ...patchBody })
    .then(() => { toastOk?.('Saved.'); load(); }).catch(e => toastErr?.(e?.message || 'Could not save.'));
  return (
    <div>
      <div style={{ ...CARD, fontSize: 12.5, color: 'var(--muted)' }}>
        Every Location Library site with the paper posters it needs. Set each site&apos;s kind (wage orders and job-site notices follow it) and its lead, who confirms each new poster with a photo. The online copies add to the paper posters; they do not replace them.
      </div>
      <datalist id="notice-site-people">{people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}</datalist>
      {rows.map(s => (
        <div key={s.id} style={CARD}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 220px' }}><span style={HD}>{s.name}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{s.address || 'No address'}{s.state ? '' : ' - no state found'}</span></span>
            <select aria-label={`Kind of ${s.name}`} className="form-input" value={s.kind} onChange={e => save(s, { kind: e.target.value })} style={{ width: 190 }}>
              <option value="">Kind Not Set (All Apply)</option>
              {Object.entries(SITE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input aria-label={`Lead of ${s.name}`} className="form-input" list="notice-site-people" defaultValue={s.lead} placeholder="Site lead email"
              onBlur={e => e.target.value.trim().toLowerCase() !== s.lead && save(s, { lead_email: e.target.value.trim() })} style={{ width: 220 }} />
            <input aria-label={`City limits of ${s.name}`} className="form-input" defaultValue={s.city} placeholder="City limits"
              title="The city whose limits the site is in, when it differs from the mailing address"
              onBlur={e => e.target.value.trim().toUpperCase() !== s.city && save(s, { city: e.target.value.trim() })} style={{ width: 150 }} />
            <Chip spec={s.missing ? STATE_CHIP.needs_file : STATE_CHIP.current}>{s.missing ? `${s.missing} Not Confirmed` : 'All Posted'}</Chip>
            <button className="secondary-btn" onClick={() => setOpenId(openId === s.id ? '' : s.id)} style={{ fontSize: 12 }}>{openId === s.id ? 'Hide Posters' : 'Posters'}</button>
          </div>
          {openId === s.id && <div style={{ marginTop: 10 }}><SitePosters site={s} onChanged={load} toastOk={toastOk} toastErr={toastErr} /></div>}
        </div>
      ))}
      {!rows.length && <div style={{ ...CARD, fontSize: 13, color: 'var(--muted)' }}>No sites in the Location Library yet.</div>}
    </div>
  );
}

// ── Calendar ────────────────────────────────────────────────────────────────

function CalendarView({ onOpen }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); api.noticeCalendar(year).then(r => setRows(r.items || [])).catch(() => setRows([])); }, [year]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span style={HD}>Compliance Calendar</span><span style={{ flex: 1 }} />
        <button className="secondary-btn" onClick={() => setYear(y => y - 1)} style={{ fontSize: 12 }}>{year - 1}</button>
        <span style={{ fontWeight: 700 }}>{year}</span>
        <button className="secondary-btn" onClick={() => setYear(y => y + 1)} style={{ fontSize: 12 }}>{year + 1}</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>Approvers hear about each date 30 and 7 days ahead.</div>
      {!rows ? <SkeletonBlocks count={2} height={50} /> : rows.map(it => (
        <div key={it.key} style={{ display: 'flex', gap: 12, padding: '9px 0', borderTop: '1px solid var(--wk-line2)', opacity: it.date < today ? 0.55 : 1 }}>
          <span style={{ width: 92, flexShrink: 0, fontWeight: 700, fontSize: 13 }}>{day(it.date)}</span>
          <span style={{ flex: 1, fontSize: 13 }}><b>{it.title}</b><span style={{ display: 'block', color: 'var(--muted)', fontSize: 12.5 }}>{it.detail}</span></span>
          {it.noticeId && <button className="secondary-btn" onClick={() => onOpen(it.noticeId)} style={{ fontSize: 12, alignSelf: 'center' }}>Open</button>}
        </div>
      ))}
    </div>
  );
}

// ── Annual Notice Review (December: every notice for the coming year) ───────

function AnnualReview({ onOpen, toastOk, toastErr }) {
  const now = new Date();
  const [year, setYear] = useState(String(now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear()));
  const [r, setR] = useState(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setR(null); api.noticeReview(year).then(setR).catch(e => toastErr?.(e?.message || 'Could not load the review.')); }, [year]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const act = (p, ok) => { setBusy(true); p.then(x => { setR(x); toastOk?.(ok); }).catch(e => toastErr?.(e?.message || 'That did not work.')).finally(() => setBusy(false)); };
  if (!r) return <SkeletonBlocks count={2} height={80} />;
  const open = r.items.filter(i => ['needs_file', 'awaiting_approval', 'source_changed'].includes(i.state));
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={HD}>Annual Notice Review for {year}</span>
        <Chip spec={r.status === 'signed' ? STATE_CHIP.current : r.status === 'open' ? STATE_CHIP.awaiting_approval : STATE_CHIP.retired}>
          {r.status === 'signed' ? 'Signed' : r.status === 'open' ? 'Open' : 'Not Open Yet'}</Chip>
        <span style={{ flex: 1 }} />
        <button className="secondary-btn" onClick={() => setYear(String(Number(year) - 1))} style={{ fontSize: 12 }}>{Number(year) - 1}</button>
        <button className="secondary-btn" onClick={() => setYear(String(Number(year) + 1))} style={{ fontSize: 12 }}>{Number(year) + 1}</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        Each December an approver checks every notice for the coming year and signs here. The signed review keeps exactly what it covered.
      </div>
      {r.status === 'signed' && <div style={{ fontSize: 13, marginBottom: 10 }}>Signed by <b>{r.signedBy}</b> ({r.typedName}) on {formatDateTime(r.signedAt)}.{r.note && ` Note: ${r.note}`}</div>}
      {r.items.map(i => (
        <button key={i.id} onClick={() => onOpen(i.id)}
          style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'center', padding: '7px 4px', border: 'none', borderTop: '1px solid var(--wk-line2)', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--ink)' }}>
          <span style={{ flex: 1, fontSize: 13 }}>{i.title}<span style={{ color: 'var(--muted)', fontSize: 12 }}> - {areaLabel(i.area)}</span></span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i.versionOnJan1 ? `On 01/01: ${i.versionOnJan1}` : 'Nothing approved for 01/01'}</span>
          <Chip spec={STATE_CHIP[i.state]} />
        </button>
      ))}
      {r.status === 'not_open' && <button className="primary-btn" disabled={busy} onClick={() => act(api.openNoticeReview(year), 'Review opened.')} style={{ marginTop: 12 }}>Open The {year} Review</button>}
      {r.status === 'open' && (r.canSign ? (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
          {open.length > 0 && <div style={{ fontSize: 12.5, color: '#b45309' }}>{open.length} notices still need a file or an approval. Sign anyway only with a note saying why.</div>}
          <textarea id="review-note" className="form-input" rows={2} placeholder="Note (required while notices are open)" value={note} onChange={e => setNote(e.target.value)} />
          <input id="review-name" className="form-input" placeholder="Type your full name to sign" value={typed} onChange={e => setTyped(e.target.value)} />
          <div><button className="primary-btn" disabled={busy || typed.trim().length < 3} onClick={() => act(api.signNoticeReview(year, { typed_name: typed, note }), 'Review signed.')}>Sign The {year} Review</button></div>
        </div>
      ) : <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>A notice approver signs the review.</div>)}
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function Activity() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.noticeEvents().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <SkeletonBlocks count={2} height={60} />;
  return (
    <div style={CARD}>
      <div style={{ ...HD, marginBottom: 8 }}>Activity</div>
      {!rows.length && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing yet.</div>}
      {rows.map((e, i) => (
        <div key={i} style={{ fontSize: 12.5, padding: '6px 0', borderTop: i ? '1px solid var(--wk-line2)' : 'none' }}>
          <span style={{ color: 'var(--muted)' }}>{formatDateTime(e.at)}</span> - <b>{e.actor}</b> - {EVENT_LABEL[e.action] || e.action}{e.notice ? `: ${e.notice}` : ''}
        </div>
      ))}
    </div>
  );
}
