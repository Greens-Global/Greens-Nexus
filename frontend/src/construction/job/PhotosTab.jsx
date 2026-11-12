// The Job's photo timeline (Neil, 11/03/2026, plan phase 3 "Photos That Stay
// With the Job"). Every photo the job has - the daily logs' (with their
// privacy: another person's draft never shows), the timeline's own, punch Done
// photos and attached Mark Ups - newest first, grouped by the jobsite's day,
// each with who took it, when and where. Filters: a tag, words in the spot or
// caption, one daily log. Pick two photos to make a Before and After pair
// (shown side by side here, in the photo report and the weekly report); Mark
// Up any photo (lib/markup.js - the ONE markup path; the board's "Attach to"
// brings the drawing back here as a new photo beside the original); pick
// photos and pairs for a Photo Report PDF. Add Photos works with no signal:
// the photos wait on the phone and the outbox sends them.
import { useMemo, useRef, useState } from 'react';
import { Camera, Columns2, FileDown, PenLine, X, Search, Tag, MapPin } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import SyncState from '../../components/offline/SyncState';
import { formatDate, formatDateTime, formatTimeIn } from '../../lib/datetime';
import { useIsMobile } from '../../lib/useIsMobile';
import { CARD, TONE } from '../ui';
import Empty from '../Empty';
import { useLoad } from '../lib/job';
import { validate } from '../lib/upload';
import { addJobPhoto, loadTimeline } from '../constructionOffline';

const quiet = { fontSize: 13, color: 'var(--text-secondary)' };
const btn = { padding: '7px 12px', fontSize: 13, minHeight: 36 };

function Thumb({ p, picked, onPick, onOpen, pairRole }) {
  return (
    <div data-photo={p.id} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', background: 'var(--mist, #eef1f5)',
      border: `2px solid ${picked ? 'var(--wk-brand, #2b45e1)' : 'transparent'}`, aspectRatio: '1 / 1' }}>
      <button type="button" onClick={() => onOpen(p)} aria-label={`Open the photo from ${formatDateTime(p.takenAt, '')}`}
        style={{ display: 'block', width: '100%', height: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
        <img src={p.thumbnailUrl || p.url} alt={p.caption || p.locationText || 'Job photo'} loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </button>
      <label style={{ position: 'absolute', top: 6, left: 6, background: 'rgba(255,255,255,.92)', borderRadius: 6, padding: '2px 6px',
        display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={picked} onChange={() => onPick(p.id)} aria-label="Pick this photo" />
        {pairRole && <span style={{ fontWeight: 700 }}>{pairRole}</span>}
      </label>
      {(p.tags || []).includes('markup') && (
        <span style={{ position: 'absolute', bottom: 6, left: 6 }}><StatusLabel size="sm" label="Mark Up" color={TONE.blue} /></span>
      )}
    </div>
  );
}

function PhotoSheet({ photo, project, canEdit, onClose, onSaved }) {
  const [tags, setTags] = useState((photo.tags || []).join(', '));
  const [where, setWhere] = useState(photo.locationText || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    setBusy('save'); setError('');
    try {
      await api.updateMediaMeta(photo.id, { tags: tags.split(',').map((t) => t.trim()).filter(Boolean), location_text: where });
      onSaved();
    } catch (e) { setError(e.message || 'Could not save that.'); }
    setBusy('');
  };
  const markUp = async () => {
    setBusy('markup'); setError('');
    try {
      const { openMarkup } = await import('../../lib/markup');
      await openMarkup({
        imageUrl: photo.url, mimeType: photo.mimeType || 'image/jpeg', name: photo.caption || 'Job photo',
        source: { kind: 'construction_media', id: photo.id, label: `${project.name} photo`,
          url: `/construction/project:${project.id}:photos` },
      });
    } catch (e) { setError(e.message || 'Could not open Mark Up.'); setBusy(''); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content nx-popup" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>Photo</h3>
            <div style={quiet}>
              {[photo.uploadedByName || '', formatDateTime(photo.takenAt, ''), photo.logDate ? `Daily log ${formatDate(photo.logDate, photo.logDate)}` : 'Job photo'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="secondary-btn" onClick={onClose} aria-label="Close" style={{ padding: 8 }}><X size={16} /></button>
        </div>
        {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
        <div className="nx-fill" style={{ minHeight: 200, display: 'flex', justifyContent: 'center', background: 'var(--mist, #eef1f5)', borderRadius: 10, overflow: 'hidden' }}>
          <img src={photo.url} alt={photo.caption || 'Job photo'} style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} />
        </div>
        {canEdit && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <label className="form-label">Tags
              <input className="form-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="before, slab, north wall" />
            </label>
            <label className="form-label">Where
              <input className="form-input" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="e.g. Grid C-4" />
            </label>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={markUp} disabled={!!busy}><PenLine size={14} />{busy === 'markup' ? 'Opening…' : 'Mark Up'}</button>
          {canEdit && <button className="primary-btn" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>
    </div>
  );
}

export default function PhotosTab({ project }) {
  const [savedAt, setSavedAt] = useState('');
  const { data, error, reload } = useLoad(() => { setSavedAt(''); return loadTimeline(project.id, { onCache: setSavedAt }); }, project.id);
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [logId, setLogId] = useState('');
  const [picked, setPicked] = useState([]);
  const [pickedPairs, setPickedPairs] = useState([]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [queued, setQueued] = useState([]);       // photos taken with no signal: { entryId, preview }
  const [addTag, setAddTag] = useState('');
  const [addWhere, setAddWhere] = useState('');
  const camRef = useRef(null);
  const isMobile = useIsMobile();

  const photos = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.photos || []).filter((p) => (!tag || (p.tags || []).includes(tag))
      && (!logId || p.dailyLogId === logId)
      && (!term || `${p.locationText || ''} ${p.caption || ''} ${p.description || ''}`.toLowerCase().includes(term)));
  }, [data, tag, q, logId]);
  const byId = useMemo(() => Object.fromEntries((data?.photos || []).map((p) => [p.id, p])), [data]);
  const days = useMemo(() => {
    const out = [];
    for (const p of photos) {
      const d = p.day || String(p.takenAt || '').slice(0, 10);
      if (!out.length || out[out.length - 1].day !== d) out.push({ day: d, photos: [] });
      out[out.length - 1].photos.push(p);
    }
    return out;
  }, [photos]);
  const pairs = (data?.pairs || []).filter((pr) => byId[pr.beforeId] && byId[pr.afterId]);
  const roleOf = (id) => (picked[0] === id ? 'Before' : picked[1] === id ? 'After' : '');
  const togglePick = (id) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const makePair = async () => {
    if (picked.length !== 2) return;
    const [a, b] = picked.map((id) => byId[id]);
    const [before, after] = String(a.takenAt) <= String(b.takenAt) ? [a, b] : [b, a];
    setBusy('pair'); setMsg('');
    try { await api.makePhotoPair(project.id, { before_media_id: before.id, after_media_id: after.id }); setPicked([]); reload(); }
    catch (e) { setMsg(e.message || 'Could not make the pair.'); }
    setBusy('');
  };
  const unpair = async (id) => {
    try { await api.removePhotoPair(id); reload(); } catch (e) { setMsg(e.message || 'Could not take the pair apart.'); }
  };
  const report = async () => {
    setBusy('report'); setMsg('');
    try {
      const { blob, filename } = await api.photoReportPdf(project.id, { media_ids: picked, pair_ids: pickedPairs, title: `${project.name} Photo Report` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg(e.message || 'Could not make the photo report.'); }
    setBusy('');
  };
  const addFiles = async (files) => {
    setMsg('');
    for (const f of Array.from(files || [])) {
      const why = validate(f);
      if (why) { setMsg(why); continue; }
      try {
        const out = await addJobPhoto(project, f, {
          tags: addTag.split(',').map((t) => t.trim()).filter(Boolean), location_text: addWhere.trim(),
        });
        if (out?.queued) setQueued((x) => [...x, { entryId: out.queued.id, preview: URL.createObjectURL(f) }]);
      } catch (e) { setMsg(e.message || 'Could not add that photo.'); }
    }
    reload();
  };

  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={2} height={160} borderRadius={12} />;
  const anyPicked = picked.length > 0 || pickedPairs.length > 0;

  return (
    <div>
      {savedAt && <div style={{ ...quiet, marginBottom: 10 }}>Opened from this phone (saved {formatDateTime(savedAt, '')}).</div>}
      {data.canAdd && (
        <section style={{ ...CARD, marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }} aria-label="Add Photos">
          <label className="form-label" style={{ flex: '1 1 160px', margin: 0 }}>Tags
            <input className="form-input" value={addTag} onChange={(e) => setAddTag(e.target.value)} placeholder="before, after, slab" />
          </label>
          <label className="form-label" style={{ flex: '1 1 160px', margin: 0 }}>Where
            <input className="form-input" value={addWhere} onChange={(e) => setAddWhere(e.target.value)} placeholder="e.g. North wall" />
          </label>
          <button className="primary-btn" onClick={() => camRef.current?.click()} style={{ minHeight: 40 }}><Camera size={16} />Add Photos</button>
          <input ref={camRef} type="file" accept="image/*" capture={isMobile ? 'environment' : undefined} multiple hidden
            onChange={(e) => { const fs = e.target.files; addFiles(fs); e.target.value = ''; }} />
          {queued.length > 0 && (
            <div style={{ width: '100%', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {queued.map((x) => (
                <div key={x.entryId} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                  <img src={x.preview} alt="Waiting to send" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
                  <SyncState id={x.entryId} />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-secondary)' }} aria-hidden="true" />
          <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Where or caption" aria-label="Search the photos"
            style={{ paddingLeft: 30, width: '100%' }} />
        </span>
        <select className="form-input" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag" style={{ width: 150 }}>
          <option value="">Every Tag</option>
          {(data.tags || []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="form-input" value={logId} onChange={(e) => setLogId(e.target.value)} aria-label="Daily log" style={{ width: 170 }}>
          <option value="">Every Daily Log</option>
          {(data.logs || []).map((l) => <option key={l.id} value={l.id}>{formatDate(l.logDate, l.logDate)}</option>)}
        </select>
      </div>

      {anyPicked && (
        <div role="toolbar" aria-label="Picked photos" style={{ ...CARD, marginBottom: 12, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          position: 'sticky', top: 8, zIndex: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {picked.length} photo{picked.length === 1 ? '' : 's'}{pickedPairs.length ? `, ${pickedPairs.length} pair${pickedPairs.length === 1 ? '' : 's'}` : ''} picked
          </span>
          <span style={{ flex: 1 }} />
          <button className="secondary-btn" style={btn} disabled={picked.length !== 2 || !!busy} onClick={makePair}
            title={picked.length !== 2 ? 'Pick exactly two photos - the earlier one is Before' : ''}><Columns2 size={14} />Make Before and After</button>
          <button className="primary-btn" style={btn} disabled={!!busy} onClick={report}><FileDown size={14} />{busy === 'report' ? 'Making…' : 'Photo Report'}</button>
          <button className="secondary-btn" style={btn} onClick={() => { setPicked([]); setPickedPairs([]); }}>Clear</button>
        </div>
      )}
      {msg && <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))', marginBottom: 10 }}>{msg}</div>}

      {pairs.length > 0 && (
        <section style={{ ...CARD, marginBottom: 14 }} aria-label="Before and After">
          <h3 style={{ fontSize: 15, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}><Columns2 size={16} />Before and After</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {pairs.map((pr) => {
              const b = byId[pr.beforeId], a = byId[pr.afterId];
              const on = pickedPairs.includes(pr.id);
              return (
                <div key={pr.id} data-pair={pr.id} style={{ border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, borderRadius: 10, padding: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {[['Before', b], ['After', a]].map(([w, p]) => (
                      <figure key={w} style={{ margin: 0 }}>
                        <img src={p.thumbnailUrl || p.url} alt={`${w}: ${p.locationText || 'job photo'}`} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 6, display: 'block' }} />
                        <figcaption style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}><b>{w}</b> · {formatDate(p.takenAt, '')}</figcaption>
                      </figure>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="checkbox" checked={on} onChange={() => setPickedPairs((x) => (on ? x.filter((y) => y !== pr.id) : [...x, pr.id]))} />
                      Pick
                    </label>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>{pr.caption || a.locationText || b.locationText || ''}</span>
                    <button type="button" className="secondary-btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => unpair(pr.id)}>Take Apart</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {days.length === 0 ? (
        <div style={CARD}><Empty icon={Camera} title="No photos yet" hint="Photos arrive with the daily logs, punch items marked Done, and Add Photos above." /></div>
      ) : days.map((d) => (
        <section key={d.day} style={{ ...CARD, marginBottom: 14 }} aria-label={formatDate(d.day, d.day)}>
          <h3 style={{ fontSize: 15, marginBottom: 10 }}>{formatDate(d.day, d.day)} <span style={quiet}>· {d.photos.length} photo{d.photos.length === 1 ? '' : 's'}</span></h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
            {d.photos.map((p) => (
              <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <Thumb p={p} picked={picked.includes(p.id)} onPick={togglePick} onOpen={setOpen} pairRole={roleOf(p.id)} />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatTimeIn(p.takenAt, data.timeZone, '')}{p.uploadedByName ? ` · ${p.uploadedByName}` : ''}
                </div>
                {(p.locationText || (p.tags || []).length > 0) && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {p.locationText && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><MapPin size={10} aria-hidden="true" />{p.locationText}</span>}
                    {(p.tags || []).filter((t) => t !== 'markup').slice(0, 2).map((t) => <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><Tag size={10} aria-hidden="true" />{t}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {open && (
        <PhotoSheet photo={open} project={project} canEdit={data.canAdd || data.canReview}
          onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />
      )}
    </div>
  );
}
