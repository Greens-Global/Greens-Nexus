// Screen 2 of Set Up Hiring (Oct 23): one company (or All Companies, the
// shared rows), in three sections - Hiring, Promotion, Offboarding (round 2).
// Things To Finish, About This Company, the grid (the section's columns per
// kind of person and place: Offer Letter / Hiring Packet / Job Description,
// Promotion Letter / New Role's Job Description, or Separation Package),
// Job Descriptions per role, and Advanced. Everything comes from
// GET /hr/hiring-setup/company - the same resolver a real hire uses, so the
// grid never says something the send would not do.
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { api } from '../../api';
import { usePeopleDirectory } from '../../lib/queries';
import { LoadingState, ErrorBanner } from '../AsyncState';
import PersonSearchSelect from '../PersonSearchSelect';
import AnchoredMenu from '../AnchoredMenu';
import ChooseWhatTheyGet from './ChooseWhatTheyGet';
import RoleDutiesModal, { PlaceSelect } from './RoleDutiesModal';

const CHIP = { ready: ['hsla(var(--color-green),0.14)', 'hsl(var(--color-green))'], left: ['rgba(245,158,11,0.16)', '#92400e'], notStarted: ['var(--mist)', 'var(--muted)'] };
export function StatusChip({ status, chip }) {
  const [bg, fg] = CHIP[status] || CHIP.notStarted;
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>{chip}</span>;
}
const TONE = {
  same: { border: '1px solid var(--line)', background: 'var(--card)', src: 'var(--muted)' },
  own: { border: '1px solid hsla(var(--color-blue),0.45)', background: 'hsla(var(--color-blue),0.08)', src: 'hsl(var(--color-blue))' },
  missing: { border: '1px solid rgba(217,119,6,0.6)', background: 'rgba(245,158,11,0.08)', src: '#b45309' },
};
const tone = (t) => TONE[t] || TONE.same;
const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 };
const h2 = { margin: 0, fontSize: 16, fontWeight: 800 };
const cap = { fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', padding: '0 4px' };
const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', textDecoration: 'underline' };
const go = (detail) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail }));

// Per-section wording (round 2 contract, 4.3). A focus without a section takes it from its column.
const SECTION = {
  hiring: { heading: 'Set Up Hiring', grid: 'What Each Hire Gets', kind: 'Kind Of Hire', main: 'offer', done: 'Everything is set. You can make an offer.',
    blocked: 'a hire here would be blocked', who: 'that kind of hire', another: 'Hiring in another state or country?' },
  promotion: { heading: 'Set Up Promotions', grid: 'What Each Promotion Gets', kind: 'Kind Of Person', main: 'letter', done: 'Everything is set. You can promote with a letter.',
    blocked: 'Promote is off there - Change Role Now still works', who: 'those people', handles: 'Handles Promotions', another: 'People in another state or country?' },
  offboarding: { heading: 'Set Up Offboarding', grid: 'What Each Offboarding Gets', kind: 'Kind Of Person', main: 'package', done: 'Everything is set. Offboarding sends the separation package.',
    blocked: 'offboarding there runs without documents', who: 'those people', handles: 'Handles Offboarding', another: 'People in another state or country?' },
};
const HIRING_COLUMNS = [{ key: 'offer', label: 'Offer Letter' }, { key: 'packet', label: 'Hiring Packet' }, { key: 'jd', label: 'Job Description' }];
const sectionOf = (f) => f?.section || (f?.column === 'letter' ? 'promotion' : f?.column === 'package' ? 'offboarding' : 'hiring');

function Cell({ c, onClick, extra }) {
  const t = tone(c?.tone);
  return (
    <button type="button" onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: t.border, background: t.background, borderRadius: 12,
      padding: '12px 14px', fontFamily: 'Inter,sans-serif', color: c?.tone === 'missing' ? '#92400e' : 'var(--ink)', minHeight: 72 }}>
      <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{c?.name}</span>
      <span style={{ display: 'block', fontSize: 12, color: t.src, fontWeight: c?.tone === 'same' ? 400 : 700, marginTop: 4 }}>{c?.sourceLabel}</span>
      {extra}
    </button>
  );
}

// One About line's editor: a place, a person (the curated People list) or text.
function AboutEdit({ item, entityId, onSaved, onCancel, toastErr }) {
  const { data: people = [] } = usePeopleDirectory();
  const [f, setF] = useState(() => ({ country: item.country || '', region: item.region || '', email: item.email || '',
    signatory: item.key === 'signsForCompany' ? item.value || '' : '', legal: item.legalName || '', address: item.address || '' }));
  const [busy, setBusy] = useState(false);
  const person = people.find(p => p.email === f.email);
  // Save waits for one of them; a box left empty keeps what is on file.
  const nothing = item.key === 'legalAndAddress' && !f.legal.trim() && !f.address.trim();
  async function save() {
    const body = item.key === 'worksIn' ? { country: f.country, region: f.region }
      : item.key === 'handlesHiring' ? { hr_contact_email: f.email }
        : item.key === 'signsForCompany' ? { signatory_email: f.email, signatory: f.signatory }
          : { ...(f.legal.trim() ? { legal_name: f.legal.trim() } : {}), ...(f.address.trim() ? { physical_address: f.address.trim() } : {}) };
    setBusy(true);
    try { await api.updateEntity(entityId, body); onSaved(); }
    catch (e) { toastErr?.(e?.message || 'Could not save.'); setBusy(false); }
  }
  const pickPerson = (email) => {
    const p = people.find(x => x.email === email);
    setF(x => ({ ...x, email, ...(item.key === 'signsForCompany' && p ? { signatory: [p.name, p.title].filter(Boolean).join(', ') } : {}) }));
  };
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      {item.key === 'worksIn' && <PlaceSelect country={f.country} region={f.region} onChange={(c, r) => setF(x => ({ ...x, country: c, region: r }))} />}
      {(item.key === 'handlesHiring' || item.key === 'signsForCompany') && (
        <>
          <PersonSearchSelect groups={[{ label: '', people }]} onPick={pickPerson} placeholder={person ? person.name : 'Search people...'} />
          {item.key === 'signsForCompany' && (
            <input className="form-input" aria-label="Name And Title" value={f.signatory} onChange={e => setF(x => ({ ...x, signatory: e.target.value }))} placeholder="Name, Title" />
          )}
        </>
      )}
      {item.key === 'legalAndAddress' && (
        <>
          <input className="form-input" aria-label="Legal Name" value={f.legal} onChange={e => setF(x => ({ ...x, legal: e.target.value }))} placeholder="e.g. Greens Global, LLC" />
          <input className="form-input" aria-label="Address" value={f.address} onChange={e => setF(x => ({ ...x, address: e.target.value }))} placeholder="Street, City, State ZIP" />
        </>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="primary-btn" disabled={busy || nothing} onClick={save} style={{ fontSize: 12.5 }}>Save</button>
        <button type="button" className="secondary-btn" onClick={onCancel} style={{ fontSize: 12.5 }}>Cancel</button>
      </div>
    </div>
  );
}

function RowMenu({ row, view, onHired, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const who = row.workerType === 'contractor' ? 'Contractors' : 'Employees';
  const items = [
    ...(!view.entity.shared ? [[row.notHired ? `We Hire ${who} Here` : `We Don't Hire ${who} Here`, () => onHired(row.workerType, row.notHired)]] : []),
    ...(row.removable ? [['Remove This Place', () => onRemove(row)]] : []),
  ];
  if (!items.length || view.entity.canEdit === false) return null;
  return (
    <>
      <button ref={ref} type="button" aria-label={`More for ${row.kind}`} onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, width: 30, height: 30, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)' }}>
        <MoreHorizontal size={15} />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)} align="end" minWidth={220}
        style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 4 }}>
        {items.map(([label, fn]) => (
          <button key={label} role="menuitem" type="button" onClick={() => { setOpen(false); fn(); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'Inter,sans-serif', color: 'var(--ink)' }}>{label}</button>
        ))}
      </AnchoredMenu>
    </>
  );
}

export default function HiringSetupCompany({ entityId = '', onBack, onAdvanced, focus = null, onFocusUsed, refreshKey = 0, toastOk, toastErr }) {
  const [view, setView] = useState(null);
  const [err, setErr] = useState('');
  const [roleId, setRoleId] = useState('');
  const [section, setSection] = useState(() => sectionOf(focus));
  const [popup, setPopup] = useState(null);           // { a: {rowKey, column} } | { b: {roleId, rowKey} }
  const [editing, setEditing] = useState('');         // About key being edited
  const [placing, setPlacing] = useState(null);       // { country, region } while adding a place
  const focusDone = useRef(false);
  const jdRef = useRef(null);
  const aboutRef = useRef(null);
  const reqRef = useRef(0);

  // Only the newest request lands: a slower answer for a section (or role) left behind is dropped.
  const load = () => {
    const seq = ++reqRef.current;
    return api.getHiringSetupCompany(entityId, roleId, section)
      .then(v => { if (seq !== reqRef.current) return v; setView(v); setErr(''); return v; })
      .catch(e => { if (seq === reqRef.current) setErr(e?.message || 'Could not load the hiring setup.'); });
  };
  // A Set It Up target can name a place the grid does not list yet (the person's own country): offer to add it.
  function openA(v, rowKey, column) {
    if (v.rows.some(r => r.key === rowKey)) { setPopup({ a: { rowKey, column } }); return; }
    const [, country = '', region = ''] = String(rowKey || '').split(':');
    const note = 'That place is not in the grid yet - add it, then click its box to set it up.';
    if (country && v.entity.canEdit !== false) setPlacing({ country, region, note });
    else toastErr?.(note);
  }
  useEffect(() => { load(); }, [entityId, roleId, section, refreshKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!view || focusDone.current || !focus) return;
    focusDone.current = true;
    onFocusUsed?.();
    if (focus.roleId) setPopup({ b: { roleId: focus.roleId, rowKey: '' } });
    else if (focus.rowKey) openA(view, focus.rowKey, focus.column || SECTION[sectionOf(focus)].main);
  }, [view, focus]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !view) return <ErrorBanner message={err} onRetry={load} />;
  if (!view) return <LoadingState label="Loading the hiring setup" />;
  const shared = !!view.entity.shared;
  const canEdit = view.entity.canEdit !== false;
  const notStarted = view.status === 'notStarted';
  const title = shared ? 'All Companies (Shared)' : view.entity.name;
  // Render from what the server answered, so a refetch in flight never mixes two sections.
  const sec = SECTION[view.section] ? view.section : 'hiring';
  const S = SECTION[sec];
  const columns = view.columns || HIRING_COLUMNS;
  const pick = (key) => { if (key !== section) { setPopup(null); setSection(key); } };

  function act(it) {
    const t = it.target || {};
    if (it.action === 'setUp') openA(view, t.rowKey, t.column || S.main);
    else if (it.action === 'addDuties') setPopup({ b: { roleId: t.roleId, rowKey: '' } });
    else if (it.action === 'editAbout') { setEditing(t.field); aboutRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); }
    else if (it.action === 'navigate') go(t);
    else if (it.action === 'advanced') onAdvanced?.(t.settingId);
  }
  async function setHired(workerType, hired) {
    try { await api.setPacketHired(view.entity.id, workerType, hired); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save.'); }
  }
  async function removePlace(row) {
    try { await api.hiringSetupPlace(view.entity.id, row.country, row.region, true); load(); toastOk?.('Place removed.'); }
    catch (e) { toastErr?.(e?.message || 'Could not remove it.'); }
  }
  async function addPlace() {
    try { await api.hiringSetupPlace(view.entity.id, placing.country, placing.region); setPlacing(null); load(); toastOk?.('Place added - it starts with the shared documents.'); }
    catch (e) { toastErr?.(e?.message || 'Could not add it.'); }
  }
  // A popup whose column the shown rows lack (another section's view) is not drawn.
  const aRow = popup?.a && view.rows.find(r => r.key === popup.a.rowKey && r[popup.a.column]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <button type="button" onClick={onBack} style={{ ...linkBtn, alignSelf: 'flex-start', textDecoration: 'none', color: 'var(--muted)', fontSize: 12.5 }}>&lt; Hiring Setup</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{S.heading} - {title}</h1>
          <StatusChip status={view.status} chip={view.chip} />
        </div>
        {!shared && !notStarted && sec === 'hiring' && <button type="button" className="primary-btn" onClick={() => go({ view: 'hr', sub: 'hr-hiring' })}>Make An Offer</button>}
      </div>
      {view.sections?.length > 0 && (
        <div role="tablist" aria-label="Section" className="scroll-tabs" style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 10, background: 'var(--mist)', alignSelf: 'flex-start', maxWidth: '100%' }}>
          {view.sections.map(x => (
            <button key={x.key} type="button" role="tab" aria-selected={sec === x.key} onClick={() => pick(x.key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', minHeight: 36, borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--ink)', background: sec === x.key ? 'var(--card)' : 'transparent',
                boxShadow: sec === x.key ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
              {x.label} <StatusChip status={x.status} chip={x.chip} />
            </button>
          ))}
        </div>
      )}
      {shared && (
        <div role="status" style={{ borderRadius: 12, padding: '10px 14px', fontSize: 13, background: 'hsla(var(--color-blue),0.08)', border: '1px solid hsla(var(--color-blue),0.3)' }}>
          {canEdit ? 'You are changing what every company uses unless it has its own.'
            : 'Only HR with access to every company can change the shared documents - this is what every company uses unless it has its own.'}
        </div>
      )}
      {notStarted && (
        <section style={{ ...card, background: 'rgba(245,158,11,0.07)', borderColor: 'rgba(217,119,6,0.45)', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: '1 1 360px', fontSize: 13.5, color: '#92400e', fontWeight: 600 }}>Pick where this company&apos;s people work to start.</span>
          <button type="button" className="secondary-btn" style={{ borderColor: '#d97706', color: '#92400e', fontWeight: 700 }}
            onClick={() => { setEditing('worksIn'); aboutRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); }}>Pick Where They Work</button>
        </section>
      )}

      {view.items.length > 0 ? (
        <section style={{ ...card, background: 'rgba(245,158,11,0.07)', borderColor: 'rgba(217,119,6,0.45)', gap: 10 }}>
          <h2 style={{ ...h2, fontSize: 15, color: '#92400e' }}>Things To Finish</h2>
          {view.items.map(it => (
            <div key={it.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: '1 1 360px', fontSize: 13.5 }}>{it.text}</span>
              {it.action !== 'none' && it.button && (
                <button type="button" className="secondary-btn" onClick={() => act(it)} style={{ borderColor: '#d97706', color: '#92400e', fontWeight: 700 }}>{it.action === 'editAbout' && it.target?.field === 'handlesHiring' && S.handles ? `Pick Who ${S.handles}` : it.button}</button>
              )}
            </div>
          ))}
        </section>
      ) : !notStarted && (
        <div role="status" style={{ fontSize: 13.5, color: 'hsl(var(--color-green))', fontWeight: 600 }}>{S.done}</div>
      )}

      {!shared && view.about.length > 0 && (
        <section ref={aboutRef} style={card}>
          <h2 style={h2}>About This Company</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            {view.about.map(a => ({ ...a, label: a.key === 'handlesHiring' && S.handles ? S.handles : a.label })).map(a => (   // the API names it for hiring in every section
              <div key={a.key} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ ...cap, padding: 0 }}>{a.label}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4, color: a.empty ? 'var(--muted)' : 'var(--ink)' }}>{a.value || 'Not set'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                  {a.hint} {editing !== a.key && <button type="button" style={linkBtn} onClick={() => setEditing(a.key)} aria-label={`Edit ${a.label}`}>Edit</button>}
                </div>
                {editing === a.key && (
                  <AboutEdit item={a} entityId={view.entity.id} toastErr={toastErr} onCancel={() => setEditing('')}
                    onSaved={() => { setEditing(''); toastOk?.('Saved.'); load(); }} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!(notStarted && view.rows.length === 0) && <section style={{ ...card, gap: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 style={h2}>{S.grid}</h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>Every box starts as the shared version. Click one to keep it or make a different one just for {shared ? S.who : 'this company'}.</p>
          </div>
          {view.roles.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>Show For Role:</span>
              {[{ id: '', name: 'All Roles' }, ...view.roles].map(r => (
                <button key={r.id || 'all'} type="button" aria-pressed={roleId === r.id} onClick={() => setRoleId(r.id)}
                  style={{ minHeight: 32, padding: '0 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                    border: `1px solid ${roleId === r.id ? 'var(--ink)' : 'var(--line)'}`, background: roleId === r.id ? 'var(--ink)' : 'var(--card)', color: roleId === r.id ? 'var(--card)' : 'var(--ink)' }}>{r.name}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div role="table" aria-label={S.grid} style={{ minWidth: 210 + 190 * columns.length, display: 'grid', gridTemplateColumns: `210px repeat(${columns.length}, minmax(0, 1fr))`, gap: 10 }}>
            <div style={cap}>{S.kind}</div>
            {columns.map(c => <div key={c.key} style={cap}>{c.label}</div>)}
            {view.rows.map(r => [
              <div key={`${r.key}-k`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px', opacity: r.notHired ? 0.6 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{r.kind}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{r.sub}</div>
                </div>
                <RowMenu row={r} view={view} onHired={setHired} onRemove={removePlace} />
              </div>,
              ...(r.notHired ? [
                <div key={`${r.key}-n`} style={{ gridColumn: `span ${columns.length}`, display: 'flex', alignItems: 'center', fontSize: 13, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 12, padding: '12px 14px' }}>
                  {view.entity.name} does not hire {r.workerType === 'contractor' ? 'contractors' : 'employees'} - nothing to set up.
                </div>,
              ] : columns.map(col => {
                const c = r[col.key];
                if (col.key === 'jd') {
                  return (
                    <Cell key={`${r.key}-jd`} c={c}
                      onClick={() => (roleId ? setPopup({ b: { roleId, rowKey: r.key } }) : jdRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))}
                      extra={c?.placementLabel ? <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{c.placementLabel}</span> : null} />
                  );
                }
                return (
                  <Cell key={`${r.key}-${col.key}`} c={c} onClick={() => setPopup({ a: { rowKey: r.key, column: col.key } })}
                    extra={<>
                      {roleId && (c?.documents || []).filter(d => d.roleDoc).map(d => (
                        <span key={d.id} style={{ display: 'block', fontSize: 12, marginTop: 4 }}>+ {d.name}{d.replacesName ? ` (Replaces ${d.replacesName})` : ''}</span>
                      ))}
                      {col.key === 'letter' && c?.settingId && (c.countersign
                        ? <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Countersigned By {c.countersign}</span>
                        : <span style={{ display: 'block', fontSize: 12, color: '#b45309', fontWeight: 700, marginTop: 4 }}>Nobody countersigns yet</span>)}
                    </>} />
                );
              })),
            ])}
          </div>
        </div>
        {sec === 'offboarding' && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>One separation package per row - the same for every reason they leave.</div>}
        {!canEdit ? null : placing ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: '0 1 280px' }}><PlaceSelect label="New Place" country={placing.country} region={placing.region} onChange={(c, rg) => setPlacing({ country: c, region: rg })} /></div>
            <button type="button" className="primary-btn" disabled={!placing.country} onClick={addPlace}>Add</button>
            <button type="button" className="secondary-btn" onClick={() => setPlacing(null)}>Cancel</button>
            {placing.note && <span role="status" style={{ flexBasis: '100%', fontSize: 12.5, color: '#b45309', fontWeight: 600 }}>{placing.note}</span>}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <button type="button" className="secondary-btn" onClick={() => setPlacing({ country: '', region: '' })} style={{ borderStyle: 'dashed', fontWeight: 700 }}>+ Add A Place</button>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{S.another} Add it and it starts with the same documents.</span>
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--muted)' }}>
          <span><b style={{ color: 'var(--ink)' }}>Same As ...</b> uses the shared one</span>
          <span><b style={{ color: 'hsl(var(--color-blue))' }}>Only Here</b> {shared ? "this place's own" : "this company's own"}</span>
          <span><b style={{ color: '#b45309' }}>Nothing Yet</b> {S.blocked}</span>
        </div>
      </section>}

      {view.jobDescriptions && <section ref={jdRef} style={card}>
        <div>
          <h2 style={h2}>Job Descriptions</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>Write each role&apos;s duties once. Give contractors, part-time staff or another place a different version only if they need one.</p>
        </div>
        {view.jobDescriptions.rows.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No roles yet - add them in Settings &gt; People &amp; Access, with the company picked, &gt; Roles.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <div role="table" aria-label="Job Descriptions" style={{ minWidth: 620, display: 'grid', gridTemplateColumns: `220px repeat(${view.jobDescriptions.columns.length}, minmax(0, 1fr))`, gap: 8 }}>
              <div style={cap}>Role</div>
              {view.jobDescriptions.columns.map(c => <div key={c.key} style={cap}>{c.label}</div>)}
              {view.jobDescriptions.rows.map(j => [
                <div key={`${j.roleId}-n`} style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {j.name}
                  {j.shared && <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'var(--mist)', color: 'var(--muted)' }}>Shared Role</span>}
                </div>,
                ...view.jobDescriptions.columns.map(c => {
                  const x = j.cells[c.key] || { label: 'Standard', tone: 'same' };
                  const t = tone(x.tone);
                  return (
                    <button key={`${j.roleId}-${c.key}`} type="button" onClick={() => setPopup({ b: { roleId: j.roleId, rowKey: c.key } })}
                      style={{ textAlign: 'left', cursor: 'pointer', minHeight: 40, padding: '0 12px', borderRadius: 9, fontSize: 13, fontWeight: 700, fontFamily: 'Inter,sans-serif',
                        border: t.border, background: t.background, color: x.tone === 'same' ? 'var(--muted)' : t.src }}>{x.label}</button>
                  );
                }),
              ])}
            </div>
          </div>
        )}
      </section>}

      <details style={{ ...card, display: 'block', padding: '14px 20px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>Advanced</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
          {(view.advanced || []).map(a => <div key={a.label}>{a.label} - <i>{a.value}</i></div>)}
        </div>
        <button type="button" style={{ ...linkBtn, marginTop: 12, color: 'var(--muted)' }} onClick={() => onAdvanced?.()}>Advanced: All Packets And Signing Orders</button>
      </details>

      {aRow && (
        <ChooseWhatTheyGet view={view} row={aRow} column={popup.a.column} roleId={roleId} toastErr={toastErr} toastOk={toastOk}
          onClose={() => setPopup(null)} onChanged={load} />
      )}
      {popup?.b && (
        <RoleDutiesModal roleId={popup.b.roleId} entityId={view.entity.id} canEdit={canEdit} rowKey={popup.b.rowKey} companyName={shared ? '' : view.entity.name}
          toastErr={toastErr} onClose={() => { setPopup(null); load(); }} />
      )}
    </div>
  );
}
