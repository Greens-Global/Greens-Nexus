// Popup A of Set Up Hiring (Oct 23): one box of the grid - the offer letter or
// hiring packet one kind of hire gets. Use The Same (this level's own row is
// archived, so the level above applies - never deleted) or Make A Different
// One (a copy, a Word file, or a template already in Documents). An own
// packet's documents are ordered here, with the Job Description page placed
// among them (the "@jd" marker). Every change saves at once.
import { useEffect, useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown, Upload, FileText, Copy, Plus } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { dialog } from '../../ui/dialog';
import { setPendingOpen } from '../../lib/pendingOpen';
import { Spinner } from '../AsyncState';
import WordTemplateWizard from '../WordTemplateWizard';

const JD = '@jd';
const NOUN = { offer: ['Offer Letter', 'offer letter'], packet: ['Hiring Packet', 'hiring packet'] };

const box = (on) => ({ textAlign: 'left', cursor: 'pointer', width: '100%', borderRadius: 12, padding: '14px 16px', fontFamily: 'Inter,sans-serif', color: 'var(--ink)',
  border: on ? '2px solid var(--ink)' : '1px solid var(--line)', background: on ? 'var(--mist)' : 'var(--card)' });
const dot = (on) => ({ display: 'inline-block', flexShrink: 0, width: 16, height: 16, borderRadius: '50%', boxSizing: 'border-box', border: on ? '5px solid var(--ink)' : '2px solid var(--muted)' });
const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', textDecoration: 'underline' };
const iconBtn = { width: 28, height: 28, borderRadius: 7, border: '1px solid var(--line)', background: 'var(--card)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)' };

// "Pick One You Already Have": published Documents templates, each with where
// it is used today (built from GET /hr/packets - no endpoint of its own).
function PickTemplate({ column, exclude, onPick, onCancel }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    Promise.all([api.getPackets(), api.getEntities().catch(() => [])]).then(([p, ents]) => {
      const names = Object.fromEntries((ents || []).map(e => [e.id, e.name]));
      const used = {};
      (p.settings || []).forEach(s => (s.docTemplateIds || []).forEach(t => {
        const w = `${s.entityId ? (names[s.entityId] || 'A Company') : 'All Companies'}${s.place ? ` - ${s.place}` : ''}`;
        (used[t] = used[t] || new Set()).add(w);
      }));
      setList((p.docTemplates || []).filter(t => t.category !== 'job_description' && !exclude.includes(t.id))
        .map(t => ({ ...t, usedBy: [...(used[t.id] || [])] })));
    }).catch(() => setList([]));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (list || []).filter(t => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="form-input" style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Find a document..." aria-label="Find a document" />
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
      </div>
      {list === null ? <Spinner /> : shown.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No published {NOUN[column][1]} documents yet - upload a Word file instead.</div> : (
        <div style={{ display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
          {shown.map(t => (
            <button key={t.id} type="button" onClick={() => onPick(t.id)} style={{ ...box(false), padding: '8px 12px' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{t.name}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Used By: {t.usedBy.join(', ') || 'Nothing yet'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChooseWhatTheyGet({ view, row, column, onClose, onChanged, toastErr, toastOk }) {
  const cell = row[column];
  const event = column === 'offer' ? 'offer' : 'hire';
  const [Noun, noun] = NOUN[column];
  const shared = !!view.entity.shared;
  const company = view.entity.name;
  const own = cell.tone === 'own';
  const editable = own && !!cell.settingId && cell.engine === 'documents' && !row.jd?.roleId;
  const [choice, setChoice] = useState(own || !cell.fallback ? 'different' : 'same');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [also, setAlso] = useState([]);
  const [adding, setAdding] = useState(null);            // { how: 'pick' | 'upload', replace: tid | '' }
  const [drag, setDrag] = useState('');

  const keyOf = (r) => ({ worker_type: r.workerType, country: r.country, region: r.region });
  const others = view.rows.filter(r => r.key !== row.key && !r.notHired);
  const docs = cell.documents || [];
  const ids = docs.map(d => d.id);
  const affected = view.rows.flatMap(r => ['offer', 'packet']
    .filter(c => r[c]?.settingId && r[c].settingId === cell.settingId && !(r.key === row.key && c === column))
    .map(c => `${r.kind} - ${NOUN[c][0]}`));

  async function run(fn, done = 'Saved') {
    setErr(''); setBusy(true);
    try { await fn(); setSaved(done); await onChanged?.(); return true; }
    catch (e) { setErr(e?.message || 'Could not save.'); return false; }
    finally { setBusy(false); }
  }
  const makeOwn = (start, docIds = []) => run(() => api.hiringSetupMakeOwn({
    entity_id: view.entity.id, event, ...keyOf(row), start, doc_template_ids: docIds,
    also: also.map(k => keyOf(view.rows.find(r => r.key === k))),
  }));
  const setDocs = (next) => run(() => api.hiringSetupSetDocuments(cell.settingId, next));

  // A new document (uploaded or picked): into this packet, or the start of an own one.
  function addDoc(templateId, jdPlacement = '') {
    const add = [templateId, ...(event === 'hire' && jdPlacement === 'page' ? [JD] : [])];
    const replace = adding?.replace || '';
    setAdding(null);
    if (!editable) return makeOwn('templates', add);
    const base = add.includes(JD) ? ids.filter(t => t !== JD) : ids;
    return setDocs(replace ? base.flatMap(t => (t === replace ? add : [t])) : [...base, ...add]);
  }
  async function applySame() {
    if (own && !await dialog.confirm(`${shared ? 'This place' : company}'s own ${noun} will stop being used. It stays in Documents, and you can switch back.`,
      { title: 'Use The Same', confirmText: 'Use The Same' })) return;
    if (await run(() => api.hiringSetupUseSame(cell.settingId))) onClose();
  }
  async function editWording(d) {
    setErr('');
    try {
      const r = await api.hiringSetupOwnCopy(cell.settingId, d.id);
      if (r.copied) await onChanged?.();
      toastOk?.(r.copied ? `"${r.name}" is ${company}'s own copy - opening it in Documents.` : `Opening "${r.name || d.name}" in Documents.`);
      setPendingOpen('doc-template', r.templateId);
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-templates' } }));
    } catch (e) { setErr(e?.message || 'Could not open the wording.'); }
  }
  const move = (id, to) => {
    const rest = ids.filter(x => x !== id);
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
    setDocs(rest);
  };
  const dropOn = (target) => { if (drag && drag !== target) move(drag, ids.filter(x => x !== drag).indexOf(target)); setDrag(''); };

  if (adding?.how === 'upload') {
    return (
      <WordTemplateWizard purpose={event} title={`${Noun} - ${row.kind}`} context={view.uploadContext}
        onCreated={({ templateId, jdPlacement }) => addDoc(templateId, jdPlacement)}
        onClose={() => setAdding(null)} toastErr={toastErr} />
    );
  }

  const chooser = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" className="primary-btn" onClick={() => setAdding({ how: 'upload', replace: adding?.replace || '' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Upload size={13} /> Upload A Word File
      </button>
      <button type="button" className="secondary-btn" onClick={() => setAdding({ how: 'pick', replace: adding?.replace || '' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <FileText size={13} /> Pick One You Already Have
      </button>
    </div>
  );
  const docRow = (d, i) => d.marker ? (
    <div key={d.id} draggable onDragStart={() => setDrag(d.id)} onDragOver={e => e.preventDefault()} onDrop={() => dropOn(d.id)} data-testid="doc-row"
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, border: '1px dashed var(--line)', background: 'var(--mist)', color: 'var(--muted)' }}>
      <GripVertical size={14} style={{ cursor: 'grab', flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Job Description - Goes Here</span>
      <button type="button" style={iconBtn} aria-label="Move Up" onClick={() => move(d.id, i - 1)} disabled={i === 0}><ArrowUp size={13} /></button>
      <button type="button" style={iconBtn} aria-label="Move Down" onClick={() => move(d.id, i + 1)} disabled={i === docs.length - 1}><ArrowDown size={13} /></button>
      <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setDocs(ids.filter(t => t !== JD))}>Leave It Out</button>
    </div>
  ) : (
    <div key={d.id} draggable={editable} onDragStart={() => setDrag(d.id)} onDragOver={e => e.preventDefault()} onDrop={() => dropOn(d.id)} data-testid="doc-row"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)' }}>
      {editable && <GripVertical size={14} style={{ cursor: 'grab', flexShrink: 0, color: 'var(--muted)' }} />}
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{d.roleDoc ? `+ ${d.name}${d.replacesName ? ` (Replaces ${d.replacesName})` : ''}` : d.name}</div>
        {d.signedBy && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Signed By: {d.signedBy}</div>}
      </div>
      {editable && (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" style={iconBtn} aria-label="Move Up" onClick={() => move(d.id, i - 1)} disabled={i === 0}><ArrowUp size={13} /></button>
          <button type="button" style={iconBtn} aria-label="Move Down" onClick={() => move(d.id, i + 1)} disabled={i === docs.length - 1}><ArrowDown size={13} /></button>
          <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => editWording(d)}>Edit Wording</button>
          <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setAdding({ how: '', replace: d.id })}>Replace</button>
          <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => setDocs(ids.filter(t => t !== d.id))}>Remove</button>
        </span>
      )}
    </div>
  );

  return (
    <Modal title={`${Noun} - ${row.kind}`} onClose={onClose}
      footer={<>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{saved || 'Hires already in progress keep the documents they started with.'}</span>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => (choice === 'same' && own ? applySame() : onClose())}>Use This</button>
      </>}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)' }}>Pick one. You can switch back any time; hires already in progress keep what they started with.</p>
      {err && <div role="alert" style={{ marginBottom: 12, fontSize: 13, color: 'hsl(var(--color-orange))', background: 'hsla(var(--color-orange),0.1)', borderRadius: 10, padding: '8px 12px' }}>{err}</div>}
      <div className="nx-fill" style={{ gap: 12 }}>
        <button type="button" onClick={() => setChoice('same')} style={box(choice === 'same')} aria-pressed={choice === 'same'}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, fontWeight: 800 }}>
            <span style={dot(choice === 'same')} />{shared ? 'Use The Same As The Wider One' : 'Use The Same As All Companies'}
          </span>
          <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', margin: '6px 0 0 26px' }}>
            {cell.fallback ? `${cell.fallback.name} (${cell.fallback.sourceLabel})${cell.fallback.usedByText ? ` - ${cell.fallback.usedByText}` : ''}` : `Nothing shared for ${row.kind} yet`}
          </span>
          {choice === 'same' && own && affected.length > 0 && (
            <span style={{ display: 'block', fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 0 26px' }}>This also changes: {affected.join(', ')}</span>
          )}
        </button>
        {cell.archivedOwnId && !own && (
          <div style={{ marginLeft: 26 }}>
            <button type="button" style={linkBtn} disabled={busy} onClick={() => run(() => api.hiringSetupRestore(cell.archivedOwnId))}>
              Use {shared ? "This Place's" : `${company}'s`} Own Again
            </button>
          </div>
        )}
        <button type="button" onClick={() => setChoice('different')} style={box(choice === 'different')} aria-pressed={choice === 'different'}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, fontWeight: 800 }}>
            <span style={dot(choice === 'different')} />Make A Different One For {shared ? row.kind : `${company} - ${row.kind}`}
          </span>
          <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', margin: '6px 0 0 26px' }}>
            {own ? `In use: ${cell.name} (${cell.sourceLabel}).` : 'Only these hires get it. Everyone else keeps the shared one.'}
          </span>
        </button>
        {choice === 'different' && (
          <div style={{ marginLeft: 26, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {cell.engine === 'pdf' && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))' }}>This one is an old uploaded PDF and can&apos;t start by itself - upload a Word file to rebuild it.</div>}
            {!editable && !row.jd?.roleId && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button type="button" className="secondary-btn" disabled={busy} onClick={() => makeOwn('copy')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Copy size={13} /> Start From A Copy
                  </button>
                  {chooser}
                </div>
                {others.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Also Use It For</div>
                    {others.map(r => (
                      <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginBottom: 4 }}>
                        <input type="checkbox" checked={also.includes(r.key)}
                          onChange={e => setAlso(a => (e.target.checked ? [...a, r.key] : a.filter(k => k !== r.key)))} /> {r.kind}
                      </label>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Uploaded files are kept in Documents too, marked &quot;Used In Hiring&quot;.</div>
              </>
            )}
            {row.jd?.roleId && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Showing what one role gets. Pick All Roles above the grid to change the documents.</div>}
            {(editable || row.jd?.roleId) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Documents In This {Noun}</div>
                {docs.map(docRow)}
                {event === 'hire' && cell.placement === 'inside' && (
                  <div style={{ fontSize: 13, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line)', color: 'var(--muted)' }}>Job Description - {cell.placementLabel}</div>
                )}
                {editable && event === 'hire' && cell.placement !== 'inside' && !ids.includes(JD) && (
                  <div><button type="button" className="secondary-btn" onClick={() => setDocs([...ids, JD])} style={{ fontSize: 12.5 }}>+ Add The Job Description Page</button></div>
                )}
                {editable && (adding ? (adding.how === 'pick' ? null : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    {adding.replace && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Replace {docs.find(d => d.id === adding.replace)?.name} with:</span>}
                    {chooser}
                    <button type="button" className="secondary-btn" onClick={() => setAdding(null)}>Cancel</button>
                  </div>
                )) : (
                  <div><button type="button" className="secondary-btn" onClick={() => setAdding({ how: '', replace: '' })} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add A Document</button></div>
                ))}
              </div>
            )}
            {adding?.how === 'pick' && <PickTemplate column={column} exclude={ids} onPick={(t) => addDoc(t)} onCancel={() => setAdding(null)} />}
          </div>
        )}
      </div>
    </Modal>
  );
}
