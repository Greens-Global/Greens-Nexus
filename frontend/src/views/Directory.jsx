// Contact Directory (Support > Contact Directory, Oct 2026).
//
// Before this, the Support tile pointed at a view id that no longer routed
// and everyone landed on the "Sub-Application" placeholder; the only people
// screen was HR > People, which needs the HR grant. Now anyone in the company
// can find anyone: one navigator on the left you flip between Departments and
// Reporting Line, one profile panel on the right that is the same whichever
// way you got there (Neil, 10/09: "one screen, two lenses").
//
// Data: GET /directory (routers/directory.py) - contact fields only, company
// wall applied server-side, with today's availability (time off, leave,
// holiday, clocked in / on break / out, scheduled shift) recomputed on every
// call. Availability is refreshed here every minute while the tab is visible.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Users, Network, Building2, MapPin, ChevronDown, ChevronRight, MessageSquare, Phone, Mail,
  Download, AlertTriangle, Star, X,
} from 'lucide-react';
import { api } from '../api';
import { NX, FONT } from '../tasks/theme';
import { useRole } from '../contexts/RoleContext';
import { useIsMobile } from '../lib/useIsMobile';
import { LoadingState, ErrorBanner } from '../components/AsyncState';
import { takePendingOpen } from '../lib/pendingOpen';
import { CONTACT_OPEN_KIND, CONTACT_EVENT } from '../lib/contactNav';
import { openPersonProfile } from '../lib/personNav';
import ProfilePanel, { Avatar, RoleBadge, AvailabilityChip } from '../directory/ProfilePanel';
import {
  searchPeople, groupByDepartment, buildTree, myTeam, isOffToday, teamsChat, teamsCall, mailto,
  csvOf, downloadText, readPins, writePins, byLastName,
} from '../directory/lib';

const REFRESH_MS = 60_000;
const LENS_KEY = 'nexus-directory-lens';
const QUICK = [
  ['all', 'Everyone'], ['team', 'My Team'], ['leads', 'Department Leads'], ['off', 'Off Today'], ['pinned', 'Pinned'],
];

function readLens() {
  try { return localStorage.getItem(LENS_KEY) === 'org' ? 'org' : 'dept'; } catch { return 'dept'; }
}

export default function Directory() {
  const { can, myGrantedModules, myEmail } = useRole();
  const mobile = useIsMobile('(max-width: 820px)');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [lens, setLens] = useState(readLens);
  const [company, setCompany] = useState('');
  const [office, setOffice] = useState('');
  const [quick, setQuick] = useState('all');
  // A jump from elsewhere (header search) left the email in pendingOpen
  // before this view mounted - read it as the starting selection.
  const [selected, setSelected] = useState(() => takePendingOpen(CONTACT_OPEN_KIND) || '');
  const [showing, setShowing] = useState(() => !!selected);   // phone: profile open over the list
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [pins, setPins] = useState(readPins);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);               // keyboard row in the list
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // ── load + keep availability fresh ─────────────────────────────────────
  const load = useCallback((quiet = false, reset = false) => {
    if (reset) setError('');
    return api.getContactDirectory()
      .then((d) => { setData(d); setError(''); })
      .catch((e) => { if (!quiet) setError(e?.message || 'Could not load the directory.'); });
  }, []);
  useEffect(() => { load(); }, [load]);   // eslint-disable-line react-hooks/set-state-in-effect -- the fetch resolves later; nothing is set synchronously
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // ── jumps from elsewhere (header search, hover cards) ──────────────────
  useEffect(() => {
    const onContact = (e) => { const em = (e.detail?.email || '').toLowerCase(); if (em) { setSelected(em); setShowing(true); } };
    window.addEventListener(CONTACT_EVENT, onContact);
    return () => window.removeEventListener(CONTACT_EVENT, onContact);
  }, []);

  // "/" focuses search from anywhere on the page, Escape clears it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { try { localStorage.setItem(LENS_KEY, lens); } catch { /* private mode */ } }, [lens]);

  // ── derived ────────────────────────────────────────────────────────────
  const people = useMemo(() => data?.people || [], [data]);
  const byEmail = useMemo(() => new Map(people.map((p) => [p.email, p])), [people]);
  const me = byEmail.get((myEmail || '').toLowerCase()) || null;
  const offices = useMemo(() => [...new Set(people.map((p) => p.location).filter(Boolean))].sort(), [people]);
  const companies = data?.companies || [];

  const filtered = useMemo(() => {
    let rows = people;
    if (company) rows = rows.filter((p) => p.company === company);
    if (office) rows = rows.filter((p) => p.location === office);
    if (quick === 'team') rows = myTeam(me, rows);
    else if (quick === 'leads') rows = rows.filter((p) => p.departmentRole);
    else if (quick === 'off') rows = rows.filter(isOffToday);
    else if (quick === 'pinned') rows = rows.filter((p) => pins.includes(p.email));
    return searchPeople(rows, query);
  }, [people, company, office, quick, me, pins, query]);

  const searching = query.trim().length > 0;
  const groups = useMemo(() => (lens === 'dept' || searching ? groupByDepartment(filtered) : []), [lens, searching, filtered]);
  const tree = useMemo(() => (lens === 'org' && !searching ? buildTree(filtered) : []), [lens, searching, filtered]);
  const pinnedRows = useMemo(() => (quick === 'pinned' || searching ? [] : filtered.filter((p) => pins.includes(p.email)).sort(byLastName)), [filtered, pins, quick, searching]);

  // The flat order rows appear in, for arrow keys.
  const flat = useMemo(() => {
    const out = [];
    pinnedRows.forEach((p) => out.push(p.email));
    if (lens === 'dept' || searching) {
      groups.forEach((g) => { if (!collapsed.has(g.name) || searching) g.people.forEach((p) => out.push(p.email)); });
    } else {
      const walk = (n) => { out.push(n.person.email); if (!collapsed.has(`org:${n.person.email}`)) n.children.forEach(walk); };
      tree.forEach(walk);
    }
    return out;
  }, [pinnedRows, lens, searching, groups, tree, collapsed]);

  const person = selected ? byEmail.get(selected) : null;
  // A pending jump to someone outside the viewer's wall: say so rather than
  // sit on an empty panel forever.
  const missing = !!(selected && data && !person);

  const select = useCallback((email) => {
    setSelected(email); setShowing(true);
    // On a phone the card replaces the list; land at its top, not wherever
    // the list had been scrolled to.
    if (window.matchMedia('(max-width: 820px)').matches) window.scrollTo({ top: 0 });
  }, []);
  const togglePin = (email) => setPins((prev) => {
    const next = prev.includes(email) ? prev.filter((x) => x !== email) : [...prev, email];
    writePins(next); return next;
  });
  const toggleGroup = (key) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const goDepartment = (name) => {
    setLens('dept'); setQuick('all'); setQuery(''); setShowing(false);
    setCollapsed((prev) => { const n = new Set(prev); n.delete(name); return n; });
  };

  const onListKey = (e) => {
    if (!flat.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = cursor < 0 ? flat.indexOf(selected) : cursor;
      const next = e.key === 'ArrowDown' ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1);
      setCursor(next);
      listRef.current?.querySelector(`[data-email="${CSS.escape(flat[next])}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && cursor >= 0) {
      e.preventDefault(); select(flat[cursor]);
    }
  };

  const canExport = can?.('manager');
  const canOpenPeople = !!(can?.('administrator') || myGrantedModules?.has('hr'));
  const canOpenTasks = !!(can?.('administrator') || myGrantedModules?.has('tasks'));
  const openTasks = (p) => {
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'home' } }));
    setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:tasks-person', { detail: { email: p.email, name: p.name } })), 0);
  };
  const gaps = data?.gaps;
  const gapCount = gaps ? Object.values(gaps).reduce((n, arr) => n + arr.length, 0) : 0;

  // ── render ─────────────────────────────────────────────────────────────
  const showList = !mobile || !showing;
  const showProfile = !mobile || showing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: FONT }}>
      <div className="view-header" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="view-title-group">
          <h2>Contact Directory</h2>
          <p>{data ? `${people.length} ${people.length === 1 ? 'person' : 'people'}${companies.length > 1 ? ` across ${companies.length} companies` : ''}` : 'Find and reach anyone in the company'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {gaps && gapCount > 0 && (
            <button type="button" onClick={() => setGapsOpen((v) => !v)} className="dir-tool" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: FONT,
              border: '1px solid rgba(217,119,6,0.35)', background: 'rgba(217,119,6,0.10)', color: '#b45309', fontSize: 12.5, fontWeight: 700,
            }}>
              <AlertTriangle size={14} /> {gapCount} to complete
            </button>
          )}
          {canExport && data && (
            <button type="button" onClick={() => downloadText(`contact-directory-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(filtered), 'text/csv')} className="dir-tool" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: FONT,
              border: `1px solid ${NX.border}`, background: NX.surface, color: NX.ink, fontSize: 12.5, fontWeight: 600,
            }} title={`Export the ${filtered.length} people shown as CSV`}>
              <Download size={14} /> Export
            </button>
          )}
        </div>
      </div>

      {gapsOpen && gaps && <GapsPanel gaps={gaps} byEmail={byEmail} onClose={() => setGapsOpen(false)} onOpen={canOpenPeople ? (em) => openPersonProfile(em) : select} />}

      {error && !data && <ErrorBanner message={error} onRetry={() => load(false, true)} />}

      {!data && !error ? <LoadingState label="Loading the directory…" /> : data && (
        <div className="dash-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'minmax(300px, 380px) minmax(0, 1fr)', minHeight: 560 }}>
            {showList && (
              <div style={{ borderRight: mobile ? 'none' : `1px solid ${NX.border}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: 12, borderBottom: `1px solid ${NX.border}`, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  <div style={{ position: 'relative' }}>
                    <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
                    <input ref={searchRef} type="search" className="form-input" value={query} onChange={(e) => { setQuery(e.target.value); setCursor(-1); }}
                      onKeyDown={onListKey} placeholder="Search name, title, department, office…" aria-label="Search people"
                      style={{ width: '100%', paddingLeft: 30, paddingRight: query ? 30 : 12, fontSize: mobile ? 16 : 13.5 }} />
                    {query && (
                      <button type="button" onClick={() => setQuery('')} aria-label="Clear search" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', color: NX.faint, cursor: 'pointer', padding: 4, display: 'flex' }}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 2, background: NX.border2, borderRadius: 9, padding: 2 }}>
                    {[['dept', 'Departments', Building2], ['org', 'Reporting Line', Network]].map(([k, lab, Icon]) => (
                      <button key={k} type="button" role="tab" aria-selected={lens === k} onClick={() => { setLens(k); setCursor(-1); }} style={{
                        flex: 1, border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 12.5, fontWeight: 700, padding: '6px 10px', borderRadius: 7,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
                        background: lens === k ? NX.surface : 'transparent', color: lens === k ? NX.ink : NX.dim, boxShadow: lens === k ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                      }}><Icon size={13} /> {lab}</button>
                    ))}
                  </div>
                  <div className="scroll-tabs" style={{ display: 'flex', gap: 6 }}>
                    {QUICK.filter(([k]) => k !== 'pinned' || pins.length).map(([k, lab]) => (
                      <button key={k} type="button" aria-pressed={quick === k} onClick={() => { setQuick(k); setCursor(-1); }} style={{
                        fontFamily: FONT, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', cursor: 'pointer',
                        border: `1px solid ${quick === k ? 'transparent' : NX.border}`, background: quick === k ? 'rgba(37,99,235,0.12)' : NX.surface, color: quick === k ? NX.blue : NX.dim,
                      }}>{k === 'pinned' ? <Star size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> : null}{lab}</button>
                    ))}
                  </div>
                  {(companies.length > 1 || offices.length > 1) && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {companies.length > 1 && (
                        <select className="form-input" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: '5px 8px' }}>
                          <option value="">All Companies</option>
                          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                      {offices.length > 1 && (
                        <select className="form-input" value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Office" style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: '5px 8px' }}>
                          <option value="">All Offices</option>
                          {offices.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>

                <div ref={listRef} onKeyDown={onListKey} tabIndex={-1} style={{ overflowY: 'auto', maxHeight: mobile ? 'none' : 'calc(100vh - 300px)', minHeight: 300, outline: 'none' }}>
                  {filtered.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--muted)' }}>
                      <Users size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
                      <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>No one matches</div>
                      <div style={{ fontSize: 13 }}>{searching ? 'Try fewer words, or a department or office name.' : 'Nothing to show for this filter.'}</div>
                    </div>
                  ) : (
                    <>
                      {pinnedRows.length > 0 && (
                        <GroupHead icon={Star} name="Pinned" count={pinnedRows.length} open onToggle={null} />
                      )}
                      {pinnedRows.map((p) => <PersonRow key={`pin-${p.email}`} p={p} me={myEmail} active={p.email === selected} focused={flat[cursor] === p.email} onSelect={select} mobile={mobile} />)}
                      {(lens === 'dept' || searching) ? groups.map((g) => {
                        const open = searching || !collapsed.has(g.name);
                        return (
                          <div key={g.name}>
                            <GroupHead name={g.name} count={g.people.length} open={open} onToggle={searching ? null : () => toggleGroup(g.name)} />
                            {open && g.people.map((p) => <PersonRow key={p.email} p={p} me={myEmail} active={p.email === selected} focused={flat[cursor] === p.email} onSelect={select} mobile={mobile} />)}
                          </div>
                        );
                      }) : tree.map((n) => <TreeNode key={n.person.email} node={n} me={myEmail} selected={selected} focused={flat[cursor]} collapsed={collapsed} onToggle={toggleGroup} onSelect={select} mobile={mobile} />)}
                    </>
                  )}
                </div>
              </div>
            )}

            {showProfile && (
              <div style={{ padding: mobile ? 16 : 22, minWidth: 0, overflowY: 'auto', maxHeight: mobile ? 'none' : 'calc(100vh - 200px)' }}>
                {/* Capped at a readable width: on a wide monitor the action bar
                    and the detail rows would otherwise stretch across the screen. */}
                <div style={{ maxWidth: 680 }}>
                {missing ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
                    <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Not in your directory</div>
                    <div style={{ fontSize: 13 }}>That person is not listed for you, or is no longer with the company.</div>
                  </div>
                ) : (
                  <ProfilePanel person={person} people={people} byEmail={byEmail} me={(myEmail || '').toLowerCase()} pinned={pins}
                    onPin={togglePin} onSelect={select} onBack={() => setShowing(false)} onDepartment={goDepartment} mobile={mobile}
                    canOpenPeople={canOpenPeople} onOpenPeople={(p) => openPersonProfile(p.email)}
                    canOpenTasks={canOpenTasks} onOpenTasks={openTasks} />
                )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupHead({ icon: Icon, name, count, open, onToggle }) {
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <button type="button" onClick={onToggle || undefined} disabled={!onToggle} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', border: 'none', borderBottom: `1px solid ${NX.border}`,
      background: NX.surface2, color: NX.ink, fontFamily: FONT, fontSize: 12, fontWeight: 800, letterSpacing: '.02em', cursor: onToggle ? 'pointer' : 'default',
      textAlign: 'left', position: 'sticky', top: 0, zIndex: 1,
    }}>
      {onToggle ? <Chev size={13} style={{ color: NX.faint }} /> : Icon ? <Icon size={12} style={{ color: '#d97706' }} /> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{ color: NX.faint, fontWeight: 600 }}>{count}</span>
    </button>
  );
}

function PersonRow({ p, me, active, focused, onSelect, depth = 0, mobile = false }) {
  // A phone row keeps Chat and Call (Teams first); Email and the rest are one
  // tap away on the card. Three buttons plus tree indentation left no room
  // for the name at 390px.
  const step = mobile ? 14 : 22;
  return (
    <div data-email={p.email} className={`dir-row${active ? ' is-active' : ''}${focused ? ' is-focused' : ''}`}
      role="button" tabIndex={0} onClick={() => onSelect(p.email)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.email); } }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', paddingLeft: 12 + depth * step, borderBottom: `1px solid ${NX.border}`, cursor: 'pointer', minWidth: 0, minHeight: 52 }}>
      <Avatar p={p} size={34} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.name}{p.email === (me || '').toLowerCase() && <span style={{ color: NX.faint, fontWeight: 500 }}> (you)</span>}<RoleBadge role={p.departmentRole} />
        </div>
        <div style={{ fontSize: 12, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* On a phone the line is too short for both: being off today is
              the thing that matters when you are about to call someone. */}
          {!(mobile && isOffToday(p)) && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.jobTitle || p.email}</span>}
          {p.availability && isOffToday(p) && <AvailabilityChip availability={p.availability} />}
        </div>
      </div>
      <div className="dir-row-actions" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <a href={teamsChat(p.email)} target="_blank" rel="noreferrer" title="Chat on Teams" aria-label={`Chat with ${p.name} on Teams`} onClick={(e) => e.stopPropagation()} className="dir-mini teams"><MessageSquare size={14} /></a>
        <a href={teamsCall(p.email)} target="_blank" rel="noreferrer" title="Call on Teams" aria-label={`Call ${p.name} on Teams`} onClick={(e) => e.stopPropagation()} className="dir-mini teams"><Phone size={14} /></a>
        {!mobile && <a href={mailto(p.email)} title="Email" aria-label={`Email ${p.name}`} onClick={(e) => e.stopPropagation()} className="dir-mini"><Mail size={14} /></a>}
      </div>
    </div>
  );
}

function TreeNode({ node, me, selected, focused, collapsed, onToggle, onSelect, mobile }) {
  const key = `org:${node.person.email}`;
  const open = !collapsed.has(key);
  const has = node.children.length > 0;
  const step = mobile ? 14 : 22;
  return (
    <div>
      <div style={{ position: 'relative' }}>
        {has && (
          <button type="button" onClick={() => onToggle(key)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} style={{
            position: 'absolute', left: 4 + node.depth * step, top: '50%', transform: 'translateY(-50%)', width: 16, height: 16, border: 'none',
            background: 'none', color: NX.faint, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
          }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        )}
        <PersonRow p={node.person} me={me} active={node.person.email === selected} focused={focused === node.person.email} onSelect={onSelect} depth={node.depth + (has || node.depth ? 0.6 : 0)} mobile={mobile} />
      </div>
      {has && open && node.children.map((c) => <TreeNode key={c.person.email} node={c} me={me} selected={selected} focused={focused} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} mobile={mobile} />)}
    </div>
  );
}

// HR's "what is still missing" list: each person links into their People
// profile (or their card, for someone who can see the gaps but not People).
const GAP_LABELS = {
  manager: 'No manager on record', department: 'No department', jobTitle: 'No job title', photo: 'No photo',
  officePhone: 'No phone number at all', departmentLead: 'Department without a lead',
};
function GapsPanel({ gaps, byEmail, onClose, onOpen }) {
  return (
    <div className="dash-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <AlertTriangle size={15} style={{ color: '#b45309' }} />
        <div style={{ fontWeight: 700, flex: 1 }}>Directory Completeness</div>
        <button type="button" onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: NX.faint, display: 'flex' }}><X size={16} /></button>
      </div>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 12 }}>
        The directory is only as good as these fields. Titles, departments, offices and phones sync both ways with Microsoft 365; photos come from Entra automatically once a person has one there.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {Object.entries(GAP_LABELS).map(([key, label]) => {
          const rows = gaps[key] || [];
          if (!rows.length) return null;
          return (
            <div key={key} style={{ border: `1px solid ${NX.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{label} <span style={{ color: NX.faint, fontWeight: 600 }}>{rows.length}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflowY: 'auto' }}>
                {rows.map((em) => key === 'departmentLead' ? (
                  <div key={em} style={{ fontSize: 12.5, color: NX.ink }}>{em}</div>
                ) : (
                  <button key={em} type="button" onClick={() => onOpen(em)} style={{ textAlign: 'left', border: 'none', background: 'none', padding: '2px 0', fontFamily: FONT, fontSize: 12.5, color: NX.primary, cursor: 'pointer' }}>
                    {byEmail.get(em)?.name || em}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!Object.keys(GAP_LABELS).some((k) => (gaps[k] || []).length) && <div style={{ fontSize: 13, color: NX.dim }}>Everything is filled in.</div>}
      <div style={{ fontSize: 12, color: NX.faint, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}><MapPin size={12} /> Department leads are set under Tickets, Manage, Service Desk.</div>
    </div>
  );
}
