// Popup B of Set Up Hiring (Oct 23): a role's Job Description. One Standard
// text for everyone, plus a version only for the hires who need it (by Hired
// As, Works In and, for a shared role, Company). The server picks the version
// a hire gets (hiring_setup.resolve_duties) - this screen only edits the text.
// Text saves 800 ms after typing stops.
import { useEffect, useRef, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { Spinner } from '../AsyncState';
import { COUNTRIES } from '../../lib/countries';
import { US_STATE_NAMES, placeName } from '../../lib/usStates';
import { importDocumentFile } from '../../lib/docBuilderImport';
import WordTemplateWizard from '../WordTemplateWizard';

const cap = { fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' };
const HIRED_AS = [['', 'Anyone'], ['employee', 'Employees'], ['full_time', 'Full-Time Employees'], ['part_time', 'Part-Time Employees'], ['contractor', 'Contractors']];
const COUNTRY_NAMES = Object.fromEntries(COUNTRIES.map(c => [c.code, c.name]));

/** "Employees In California" - the grid's words for a row key (employee:US:CA). */
export function kindOf(rowKey) {
  const [wt, country = '', region = ''] = (rowKey || '').split(':');
  if (!wt) return '';
  return `${wt === 'contractor' ? 'Contractors' : 'Employees'} In ${placeName(country, region, COUNTRY_NAMES) || 'Anywhere'}`;
}

/** One box for a place: a country, or a US state ("US:CA"). '' = Anywhere when `anywhere`. */
export function PlaceSelect({ country, region, onChange, anywhere = false, label = 'Works In', id }) {
  const value = country ? `${country}:${country === 'US' ? (region || '') : ''}` : '';
  return (
    <select id={id} aria-label={label} className="form-input" style={{ width: '100%' }} value={value}
      onChange={e => { const [c = '', r = ''] = e.target.value.split(':'); onChange(c, r); }}>
      <option value="">{anywhere ? 'Anywhere' : '- pick a place -'}</option>
      <optgroup label="United States">
        <option value="US:">United States (Every State)</option>
        {Object.entries(US_STATE_NAMES).map(([k, n]) => <option key={k} value={`US:${k}`}>{n}</option>)}
      </optgroup>
      <optgroup label="Other Countries">
        {COUNTRIES.filter(c => c.code !== 'US').map(c => <option key={c.code} value={`${c.code}:`}>{c.name}</option>)}
      </optgroup>
    </select>
  );
}

// Word (or text) file -> plain lines. No variables: the duties box is text.
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const lines = [...doc.body.querySelectorAll('p, li, h1, h2, h3, h4, td')]
    .filter(n => !n.querySelector('p, li'))
    .map(n => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return (lines.length ? lines : [doc.body.textContent.trim()]).join('\n');
}

export default function RoleDutiesModal({ roleId, entityId = '', rowKey = '', companyName = '', canEdit = true, onClose, onChanged, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [vid, setVid] = useState('');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [adding, setAdding] = useState(null);           // { hired_as, country, region, entity_id } while making a version
  const [addErr, setAddErr] = useState('');
  const [wizard, setWizard] = useState(false);
  const timer = useRef(null);
  const pending = useRef(null);                          // { vid, text } not sent yet
  const inflight = useRef(Promise.resolve());            // saves run one after another, so an older text never lands last
  const [locked, setLocked] = useState({});              // vid -> why this HR cannot change it (a 403)
  const kind = kindOf(rowKey);
  const vidRef = useRef('');
  vidRef.current = vid;
  const dataRef = useRef(null);
  dataRef.current = data;

  const take = (d, pick) => {
    setData(d);
    const v = d.versions.find(x => x.id === pick)
      || (kind && d.versions.find(x => (x.usedBy || []).some(u => u === kind || u.endsWith(` ${kind}`))))
      || d.versions[0];
    if (v) { setVid(v.id); setText(v.text || ''); }
  };
  useEffect(() => {
    api.getRoleDuties(roleId, entityId).then(d => take(d)).catch(e => setErr(e?.message || 'Could not load the job description.'));
  }, [roleId, entityId]);   // eslint-disable-line react-hooks/exhaustive-deps

  function flush() {
    clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return inflight.current;
    pending.current = null;
    inflight.current = inflight.current.then(async () => {
      try {
        await api.updateRoleDuty(roleId, p.vid, p.text);
        setData(d => d && ({ ...d, versions: d.versions.map(v => (v.id === p.vid ? { ...v, text: p.text } : v)) }));
        setSaved('Saved');
        onChanged?.();
      } catch (e) {
        setSaved('');
        if (e?.status === 403) {
          // Not this HR's to change: stop saving it and show the stored text again.
          setLocked(l => ({ ...l, [p.vid]: e.message }));
          const v = dataRef.current?.versions.find(x => x.id === p.vid);
          if (v && vidRef.current === p.vid) setText(v.text || '');
        } else toastErr?.(e?.message || 'Could not save the duties.');
      }
    });
    return inflight.current;
  }
  useEffect(() => () => { flush(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const type = (t) => {
    setText(t); setSaved('Saving...');
    pending.current = { vid, text: t };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 800);
  };
  const pick = async (v) => { await flush(); setVid(v.id); setText(v.text || ''); setSaved(''); };

  async function addVersion() {
    setAddErr('');
    try {
      await flush();
      const d = await api.addRoleDuty(roleId, adding);
      take(d, d.versionId);
      setAdding(null);
      onChanged?.();
    } catch (e) { setAddErr(e?.message || 'Could not make the version.'); }
  }
  async function useStandard() {
    try {
      pending.current = null; clearTimeout(timer.current);
      take(await api.removeRoleDuty(roleId, vid), 'standard');
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not change it.'); }
  }
  async function fromFile(file) {
    if (!file) return;
    try { type(htmlToText((await importDocumentFile(file)).html)); }
    catch (e) { toastErr?.(e?.message || 'Could not read that file.'); }
  }
  async function setFormatted(templateId) {
    const others = (data.hiringDocs || []).filter(d => d.replaces !== '@jd').map(d => ({ templateId: d.templateId, replaces: d.replaces || '' }));
    try {
      const r = await api.setRoleHiringDocs(roleId, templateId ? [...others, { templateId, replaces: '@jd' }] : others);
      setData(d => ({ ...d, hiringDocs: r.hiringDocs || [],
        formattedJd: (r.hiringDocs || []).filter(x => x.replaces === '@jd').map(x => ({ templateId: x.templateId, name: x.name || x.templateName }))[0] || null }));
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not save the document.'); }
  }

  if (wizard) {
    return (
      <WordTemplateWizard purpose="jd" title={`Job Description - ${data?.role?.name || ''}`} context={{ roleNames: [data?.role?.name].filter(Boolean) }}
        onCreated={({ templateId }) => { setWizard(false); setFormatted(templateId); }}
        onClose={() => setWizard(false)} toastErr={toastErr} />
    );
  }
  const role = data?.role;
  const cur = data?.versions.find(v => v.id === vid);
  const extra = (data?.hiringDocs || []).filter(d => d.replaces !== '@jd');
  const lockedWhy = !canEdit ? 'Only HR with access to every company can change the shared job descriptions.' : locked[vid] || '';
  return (
    <Modal title={`Job Description - ${role?.name || ''}`} onClose={async () => { await flush(); onClose(); }}
      footer={<>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{lockedWhy ? 'Read only.' : saved || 'Changes save as you type.'}</span>
        <button type="button" className="primary-btn" onClick={async () => { await flush(); onClose(); }}>Close</button>
      </>}>
      {err ? <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13 }}>{err}</div>
        : !data ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size="section" /></div> : (
          <>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              {role.shared ? 'Shared Role' : "This Company's Role"} - one version for everyone. Add a different one only for the hires who need it.
              {kind && cur && <div style={{ marginTop: 4, color: 'var(--ink)' }}>Showing what {kind} get - using: {cur.label}</div>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, flex: 1, minHeight: 0 }}>
              <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={cap}>Versions</div>
                {data.versions.map(v => (
                  <button key={v.id} type="button" onClick={() => pick(v)} aria-pressed={v.id === vid}
                    style={{ textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '10px 12px', fontFamily: 'Inter,sans-serif', color: 'var(--ink)', background: 'var(--card)',
                      border: v.id === vid ? '2px solid var(--ink)' : '1px solid var(--line)' }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{v.label}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{v.who}</span>
                  </button>
                ))}
                {canEdit && <button type="button" className="secondary-btn" onClick={() => { setAddErr(''); setAdding(a => (a ? null : { hired_as: 'contractor', country: '', region: '', entity_id: '' })); }}
                  style={{ borderStyle: 'dashed', textAlign: 'left', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Make A Different One For...</button>}
                {adding && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Hired As
                      <select className="form-input" style={{ width: '100%', marginTop: 4 }} value={adding.hired_as} onChange={e => setAdding(a => ({ ...a, hired_as: e.target.value }))}>
                        {HIRED_AS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </label>
                    <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Works In
                      <div style={{ marginTop: 4 }}><PlaceSelect anywhere country={adding.country} region={adding.region} onChange={(c, r) => setAdding(a => ({ ...a, country: c, region: r }))} /></div>
                    </label>
                    {role.shared && entityId && (
                      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Company
                        <select className="form-input" style={{ width: '100%', marginTop: 4 }} value={adding.entity_id} onChange={e => setAdding(a => ({ ...a, entity_id: e.target.value }))}>
                          <option value="">All Companies</option>
                          <option value={entityId}>{companyName || 'This Company'} Only</option>
                        </select>
                      </label>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>It starts as a copy of the version these hires get today.</span>
                    {addErr && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))' }}>{addErr}</div>}
                    <button type="button" className="primary-btn" onClick={addVersion}>Make It</button>
                  </div>
                )}
              </div>
              <div style={{ flex: '999 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={`duties-${roleId}`} style={cap}>Duties - {cur?.label}</label>
                {lockedWhy && <div role="status" style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))' }}>{lockedWhy}</div>}
                <div className="nx-fill">
                  <textarea id={`duties-${roleId}`} className="form-input" value={text} onChange={e => type(e.target.value)} readOnly={!!lockedWhy}
                    placeholder="Type this role's duties, one per line." style={{ width: '100%', minHeight: 220, fontFamily: 'inherit', lineHeight: 1.55 }} />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                  <span style={{ flex: 1 }}>Used By: {(cur?.usedBy || []).join(', ') || 'No kind of hire here right now'}</span>
                  {!lockedWhy && (
                    <label className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5 }}>
                      <Upload size={13} /> Fill From A Word File
                      <input type="file" accept=".docx,.txt" hidden onChange={e => { fromFile(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  )}
                  {canEdit && vid !== 'standard' && <button type="button" className="secondary-btn" onClick={useStandard} style={{ fontSize: 12.5 }}>Use The Standard Instead</button>}
                </div>
                <details style={{ fontSize: 13, color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--ink)' }}>Keep The Word File&apos;s Own Layout</summary>
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    {data.formattedJd ? (
                      <>
                        <span><b style={{ color: 'var(--ink)' }}>{data.formattedJd.name}</b> - Use Instead Of: Job Description</span>
                        {canEdit && <button type="button" className="secondary-btn" onClick={() => setFormatted('')} style={{ fontSize: 12 }}>Remove</button>}
                      </>
                    ) : (
                      <>
                        <span>For a job description whose tables and bold must stay as they are. It goes out instead of the typed duties.</span>
                        {canEdit && <button type="button" className="secondary-btn" onClick={() => setWizard(true)} style={{ fontSize: 12 }}>Add A Formatted Job Description</button>}
                      </>
                    )}
                  </div>
                </details>
                <details style={{ fontSize: 13, color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--ink)' }}>Extra Documents For This Role</summary>
                  <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                    {extra.length ? extra.map(d => (
                      <div key={d.templateId}>{d.name || d.templateName} - <b>{d.replaces ? `Replaces: ${d.replacesName || 'A Packet Document'}` : 'Adds To The Packet'}</b></div>
                    )) : <div>None.</div>}
                    <div>Added to the hiring packet only, never the offer letter. Change them in Company Settings &gt; Roles &gt; Hiring Documents.</div>
                  </div>
                </details>
              </div>
            </div>
          </>
        )}
    </Modal>
  );
}
