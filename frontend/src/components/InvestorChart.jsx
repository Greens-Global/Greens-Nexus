// Investor Chart (Neil, Aug 11): investors do not report to anyone - they are
// MANAGED BY a relationship owner (Neil, RJK, ...). Drawn with the SAME visual
// grammar as the org chart: dotted canvas, pan + zoom, owner card on top,
// connector rails down to the investor cards, drag a card onto an owner to
// reassign. It reads the SAME book of business as the Investor Relations
// module (ir_investors.relationship_owner_email) - no second list, no schema.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, Loader2, Plus, X } from 'lucide-react';
import { api } from '../api';

const HUES = ['215 70% 46%', '150 55% 38%', '265 55% 52%', '20 75% 48%', '340 60% 48%', '190 70% 38%'];
const hueFor = (s) => HUES[(s || '').split('').reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length];

const nameOf = (employees, email) => {
  const em = (email || '').toLowerCase();
  if (!em) return '';
  const p = (employees || []).find(e => (e.workEmail || '').toLowerCase() === em);
  if (p) return [p.firstName, p.lastName].filter(Boolean).join(' ');
  return em.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const initialsOf = (name) => (name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

function InitialsAvatar({ name, size = 38 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `hsla(${hueFor(name)},0.15)`, color: `hsl(${hueFor(name)})`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.34, fontWeight: 800 }}>
      {initialsOf(name)}
    </span>
  );
}

// One investor card - drag source and (via data-owner on owner cards) never a
// drop target itself: an investor cannot manage an investor.
function InvestorCard({ v, dragging, onPointerDown }) {
  const name = v.displayName || v.display_name || '(unnamed)';
  return (
    <div
      data-invcard="1"
      onPointerDown={ev => onPointerDown(ev, v)}
      style={{
        width: 200, padding: '10px 13px', display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--card)', border: '1.5px solid var(--line)', borderRadius: 14,
        boxShadow: 'var(--shadow-sm)', cursor: 'grab', opacity: dragging ? 0.4 : 1,
        touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      }}>
      <InitialsAvatar name={name} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[(v.entityType || v.entity_type || '').replace(/_/g, ' '), v.status].filter(Boolean).join(' · ') || 'Investor'}
        </div>
      </div>
    </div>
  );
}

export default function InvestorChart({ employees = [], toastOk, toastErr }) {
  const [investors, setInvestors] = useState(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [adding, setAdding] = useState(null);   // {name, email, owner} | null
  const [addBusy, setAddBusy] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 24 });
  const [draggingId, setDraggingId] = useState(null);
  const [overOwner, setOverOwner] = useState(null);   // owner email | '__none__' | null
  const [ghost, setGhost] = useState(null);           // {name, x, y}
  const dragRef = useRef(null);

  const load = useCallback(() => {
    setError('');
    api.getIrInvestors()
      .then(rows => setInvestors(rows || []))
      .catch(e => {
        if (e?.status === 403) setDenied(true);
        else setError(e?.message || 'Could not load the investor book.');
        setInvestors([]);
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const ownerOptions = useMemo(() => (
    (employees || [])
      .filter(e => e.status !== 'offboarded' && e.workEmail)
      .map(e => ({ email: e.workEmail.toLowerCase(), name: [e.firstName, e.lastName].filter(Boolean).join(' ') || e.workEmail }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ), [employees]);

  const { owners, unassigned } = useMemo(() => {
    const by = new Map();
    for (const v of investors || []) {
      const key = (v.relationshipOwnerEmail || v.relationship_owner_email || '').toLowerCase();
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(v);
    }
    for (const arr of by.values()) arr.sort((a, b) => (a.displayName || a.display_name || '').localeCompare(b.displayName || b.display_name || ''));
    const un = by.get('') || [];
    by.delete('');
    return { owners: [...by.entries()].sort((a, b) => b[1].length - a[1].length), unassigned: un };
  }, [investors]);

  const reassign = async (inv, ownerEmail) => {
    const cur = (inv.relationshipOwnerEmail || inv.relationship_owner_email || '').toLowerCase();
    if (cur === (ownerEmail || '')) return;
    try {
      await api.updateIrInvestor(inv.id, { relationshipOwnerEmail: ownerEmail });
      setInvestors(list => list.map(v => (v.id === inv.id
        ? { ...v, relationshipOwnerEmail: ownerEmail, relationship_owner_email: ownerEmail }
        : v)));
      toastOk?.(ownerEmail
        ? `${inv.displayName || inv.display_name} is now managed by ${nameOf(employees, ownerEmail)}.`
        : `${inv.displayName || inv.display_name} is now unassigned.`);
    } catch (e) { toastErr?.(e?.message || 'Could not change the relationship owner.'); }
  };

  // Pointer drag, same recipe as the org chart: threshold to distinguish a tap,
  // elementFromPoint through the zoom transform, floating name ghost.
  const onCardPointerDown = (ev, inv) => {
    if (ev.button != null && ev.button > 0) return;
    const start = { x: ev.clientX, y: ev.clientY };
    dragRef.current = { inv, start, dragging: false, target: null };
    const move = (m) => {
      const st = dragRef.current; if (!st) return;
      if (!st.dragging) {
        if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
        st.dragging = true; setDraggingId(st.inv.id);
      }
      const el = document.elementFromPoint(m.clientX, m.clientY);
      const unassign = el && el.closest ? el.closest('[data-unassign]') : null;
      const ownerEl = el && el.closest ? el.closest('[data-owner]') : null;
      st.target = unassign ? '__none__' : (ownerEl ? ownerEl.getAttribute('data-owner') : null);
      setOverOwner(st.target);
      setGhost({ name: st.inv.displayName || st.inv.display_name, x: m.clientX, y: m.clientY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const st = dragRef.current; dragRef.current = null;
      setGhost(null); setDraggingId(null); setOverOwner(null);
      if (st && st.dragging && st.target) reassign(st.inv, st.target === '__none__' ? '' : st.target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startPan = (ev) => {
    if (ev.target.closest && (ev.target.closest('[data-invcard]') || ev.target.closest('[data-owner]'))) return;
    const sx = ev.clientX - pan.x, sy = ev.clientY - pan.y;
    const move = (m) => setPan({ x: m.clientX - sx, y: m.clientY - sy });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const zoomBy = (f) => setZoom(z => Math.max(0.3, Math.min(1.6, +(z * f).toFixed(3))));

  const saveAdd = async () => {
    if (addBusy) return;
    if (!adding.name.trim()) { toastErr?.('Give the investor a name.'); return; }
    setAddBusy(true);
    try {
      await api.createIrInvestor({
        displayName: adding.name.trim(), email: adding.email.trim(),
        relationshipOwnerEmail: adding.owner,
      });
      toastOk?.(`${adding.name.trim()} added to the investor book.`);
      setAdding(null);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not add the investor.'); }
    setAddBusy(false);
  };

  if (denied) return (
    <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 14 }}>
      <Briefcase size={30} style={{ opacity: .3, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Needs Investor Relations access</div>
      <div style={{ fontSize: 13 }}>The investor chart reads the Investor Relations book - ask for the IR grant to see it.</div>
    </div>
  );

  if (investors === null) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '46px 0', color: 'var(--muted)', fontSize: 13 }}>
      <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading the investor book…
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {investors.length} investor{investors.length === 1 ? '' : 's'} · drag a card onto an owner to change who manages them · same book as Investor Relations
        </span>
        <span style={{ flex: 1 }} />
        <button className="primary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px' }}
          onClick={() => setAdding({ name: '', email: '', owner: '' })}>
          <Plus size={13} /> Add Investor
        </button>
      </div>

      {error && <div style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {/* Detach zone appears only mid-drag */}
      {draggingId && (
        <div data-unassign="1"
          style={{ marginBottom: 10, border: `2px dashed ${overOwner === '__none__' ? 'hsl(var(--color-red))' : 'var(--line)'}`, borderRadius: 12, padding: '10px 16px', textAlign: 'center', fontSize: 12, fontWeight: 700,
            color: overOwner === '__none__' ? 'hsl(var(--color-red))' : 'var(--muted)',
            background: overOwner === '__none__' ? 'hsla(var(--color-red),0.06)' : 'transparent' }}>
          Drag here to remove their relationship owner
        </div>
      )}

      {/* The chart canvas - identical grammar to the org chart. */}
      <div onPointerDown={startPan}
        style={{ position: 'relative', height: 'max(440px, calc(100vh - 420px))', overflow: 'hidden',
          borderRadius: 16, border: `1px solid ${draggingId ? 'hsl(var(--color-green))' : 'var(--line)'}`, cursor: 'grab', touchAction: 'none',
          background: 'var(--card)',
          backgroundImage: 'radial-gradient(circle, var(--line) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        {owners.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No investors are assigned to an owner yet - drag one up from the strip below.
          </div>
        ) : (
          <div style={{ position: 'absolute', left: 0, top: 0,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0',
            display: 'flex', alignItems: 'flex-start', gap: 56, padding: 4, width: 'max-content' }}>
            {owners.map(([ownerEmail, list]) => {
              const ownerName = nameOf(employees, ownerEmail);
              const ownerEmp = (employees || []).find(e => (e.workEmail || '').toLowerCase() === ownerEmail);
              const isTarget = overOwner === ownerEmail && draggingId;
              return (
                <div key={ownerEmail} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  {/* Owner card - drop target */}
                  <div data-owner={ownerEmail}
                    style={{ width: 224, padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 11,
                      background: isTarget ? 'hsla(var(--color-green),0.08)' : 'var(--mist)',
                      border: `1.5px solid ${isTarget ? 'hsl(var(--color-green))' : 'var(--line)'}`,
                      borderRadius: 14, boxShadow: 'var(--shadow-sm)', userSelect: 'none' }}>
                    {ownerEmp?.photoUrl
                      ? <img src={ownerEmp.photoUrl} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                      : <InitialsAvatar name={ownerName} size={40} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ownerName}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Relationship owner · {list.length} investor{list.length === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                  {/* stub → sibling rail → child stubs, org-chart style */}
                  <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                    {list.map((v, i) => (
                      <div key={v.id} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 10px' }}>
                        {list.length > 1 && (
                          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', height: 2 }}>
                            <div style={{ flex: 1, background: i === 0 ? 'transparent' : 'var(--line)' }} />
                            <div style={{ flex: 1, background: i === list.length - 1 ? 'transparent' : 'var(--line)' }} />
                          </div>
                        )}
                        <div style={{ width: 2, height: 18, background: 'var(--line)' }} />
                        <InvestorCard v={v} dragging={draggingId === v.id} onPointerDown={onCardPointerDown} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Zoom controls */}
        <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 6, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: 5, boxShadow: 'var(--shadow-md)' }}>
          {[['−', () => zoomBy(1 / 1.25)], [`${Math.round(zoom * 100)}%`, () => { setZoom(1); setPan({ x: 40, y: 24 }); }], ['+', () => zoomBy(1.25)]].map(([label, fn], i) => (
            <button key={i} onClick={fn} title={i === 1 ? 'Reset view' : ''}
              style={{ minWidth: 34, height: 30, borderRadius: 8, border: 'none', background: i === 1 ? 'var(--mist)' : 'transparent',
                fontSize: i === 1 ? 11 : 16, fontWeight: 700, color: 'var(--ink)', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
              {label}
            </button>
          ))}
        </div>
        <span style={{ position: 'absolute', left: 14, bottom: 14, fontSize: 10.5, color: 'var(--muted)', pointerEvents: 'none' }}>
          Drag the canvas to move around · drag an investor onto an owner to re-assign
        </span>
      </div>

      {/* Unassigned strip - same pattern as the org chart's "no reporting line" */}
      {unassigned.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'hsl(var(--color-orange))', textTransform: 'uppercase', marginBottom: 8 }}>
            No relationship owner yet - drag onto an owner card above
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {unassigned.map(v => (
              <InvestorCard key={v.id} v={v} dragging={draggingId === v.id} onPointerDown={onCardPointerDown} />
            ))}
          </div>
        </div>
      )}

      {/* Floating drag ghost */}
      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x + 14, top: ghost.y + 8, zIndex: 2000, pointerEvents: 'none',
          background: 'var(--ink)', color: 'var(--card)', fontSize: 12, fontWeight: 700, padding: '5px 11px', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' }}>
          {ghost.name}
          <span style={{ opacity: 0.7, fontWeight: 500 }}>{overOwner === '__none__' ? ' → unassign' : overOwner ? ' → drop to re-assign' : ''}</span>
        </div>
      )}

      {adding && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setAdding(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="wkc-chip"><Briefcase size={14} /></span>
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add Investor</h3>
              <button onClick={() => setAdding(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Name</label>
                <input className="form-input" autoFocus placeholder="e.g. Malay Shah" value={adding.name}
                  onChange={e => setAdding(p => ({ ...p, name: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Email (optional)</label>
                <input className="form-input" placeholder="name@example.com" value={adding.email}
                  onChange={e => setAdding(p => ({ ...p, email: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Managed by</label>
                <select className="form-input" value={adding.owner} onChange={e => setAdding(p => ({ ...p, owner: e.target.value }))} style={{ width: '100%' }}>
                  <option value="">Nobody yet</option>
                  {ownerOptions.map(o => <option key={o.email} value={o.email}>{o.name}</option>)}
                </select></div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setAdding(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveAdd} disabled={addBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {addBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={13} />} Add Investor
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
