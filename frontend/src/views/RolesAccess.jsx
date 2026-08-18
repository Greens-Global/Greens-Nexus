import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Shield, Plus, X, Search, Loader2, Pencil, Trash2, UserPlus, Check, ChevronRight, ChevronDown,
  LayoutGrid, Copy, MonitorOff, PlayCircle, Users, User, TrendingUp, MailPlus,
} from 'lucide-react';
import { InviteExternalModal, ExternalPersonSection, ExternalBadge, inviteOutcomeToast } from './ExternalUsersPanel';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { usePeopleDirectory } from '../lib/queries';
import { SkeletonBlocks } from '../components/AsyncState';
import { useRole, MODULES, MODULE_LEVELS, ROLES } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { capabilityText } from '../lib/moduleCapabilities';
import GuidedTour from '../components/GuidedTour';

// ── Roles & Access - people-first restructure (Jul 27) ───────────────────────
// One rule: a person's access = their ONE job role (baseline) + extra groups
// (additive). The screen leads with People (search a person, see and change
// their access, every line says where it came from), Job roles render as
// plain-English cards, and the full matrix lives in a tamed Audit tab with
// module families that expand on demand.
const LEVEL_ORDER = ['viewer', 'editor', 'full', 'owner'];
const GRANTABLE = MODULES.filter(m => !['admin', 'roles-access', 'hr_comp'].includes(m.id));
const TIERS = Object.keys(ROLES);

// Audit-tab module families - collapse 21 columns into 6 readable ones.
const FAMILIES = [
  { id: 'everyday', label: 'Everyday',      modules: ['dashboard', 'timeclock', 'myhr', 'tasks', 'tickets'] },
  { id: 'company',  label: 'Company',       modules: ['sop', 'hr', 'documents', 'external-links', 'support'] },
  { id: 'money',    label: 'Money',         modules: ['accounting', 'investor-relations'] },
  { id: 'field',    label: 'Field & assets', modules: ['inventory', 'property-asset', 'ops', 'operations'] },
  { id: 'growth',   label: 'Growth',        modules: ['marketing', 'development'] },
  { id: 'adminit',  label: 'Admin & IT',    modules: ['it', 'manager-dashboard', 'testing', 'credvault'] },
].map(f => ({ ...f, modules: f.modules.filter(id => GRANTABLE.some(m => m.id === id)) }));

const moduleLabel = id => MODULES.find(m => m.id === id)?.label || id;

// Tiny face for chips and rows - falls back to an initial when there's no photo.
export function Avatar({ name, src, size = 20 }) {
  return src
    ? <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    : <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: Math.round(size * 0.42), fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{(name || '?').trim()[0]?.toUpperCase() || '?'}</span>;
}

// ── shared bits (also reused by the People card Access section) ───────────────
export function LevelPill({ level, title }) {
  if (!level) return <span style={{ color: 'var(--muted)', opacity: 0.4 }}>-</span>;
  const label = MODULE_LEVELS[level]?.label || level;
  const base = { display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap' };
  const styles = {
    viewer: { ...base, background: 'transparent', color: 'var(--muted)', boxShadow: 'inset 0 0 0 1.5px var(--line-strong,var(--line))' },
    editor: { ...base, background: 'color-mix(in srgb, var(--ink) 12%, transparent)', color: 'var(--ink)' },
    full:   { ...base, background: 'var(--ink)', color: 'var(--card)' },
    owner:  { ...base, background: 'var(--ink)', color: 'var(--card)', boxShadow: 'inset 0 0 0 1.5px color-mix(in srgb, var(--card) 45%, transparent)' },
  };
  return <span style={styles[level] || styles.viewer} title={title || MODULE_LEVELS[level]?.description || ''}>{label}</span>;
}

// A level pill that also names the module it's for - so a row of grants reads
// "People · Viewer  Assets · Full" instead of a context-less "Viewer Full".
export function ModuleLevelPill({ moduleId, level }) {
  const mod = MODULES.find(m => m.id === moduleId);
  const label = mod?.label || moduleId;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 5px 3px 11px', borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}
      title={capabilityText(moduleId, level, label)}>
      {label}<LevelPill level={level} />
    </span>
  );
}

export function TierBadge({ tier }) {
  const r = ROLES[tier] || ROLES.employee;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, background: r.bg, color: r.color, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{r.label}
    </span>
  );
}

// "Owns: Accounting · Edits: Documents, Tasks · Views: Dashboard +2" - the
// plain-English one-liner that replaces a row of 20 pills on role cards.
const LEVEL_VERB = { owner: 'Owns', full: 'Runs', editor: 'Edits', viewer: 'Views' };
function bundleSummary(allowed) {
  const byLevel = { owner: [], full: [], editor: [], viewer: [] };
  (allowed || []).forEach(g => { (byLevel[g.level] || byLevel.viewer).push(moduleLabel(g.id)); });
  const parts = [];
  for (const lvl of ['owner', 'full', 'editor', 'viewer']) {
    const list = byLevel[lvl];
    if (!list.length) continue;
    const shown = list.slice(0, 3).join(', ');
    parts.push(`${LEVEL_VERB[lvl]}: ${shown}${list.length > 3 ? ` +${list.length - 3}` : ''}`);
  }
  return parts.join('  ·  ') || 'No access yet';
}

// Externals live INSIDE the People tab (Visesh, Aug 18) - no separate tab.
const TABS = [['people', 'People', User], ['jobroles', 'Roles', Shield], ['groups', 'Groups', Users], ['audit', 'Audit', LayoutGrid]];

export default function RolesAccess({ embedded = false }) {
  const { can, assignRole, myLevel } = useRole();
  const nameOf = useNameResolver();   // email → real name, never a raw email
  const [sub, setSub] = useState('people');
  const [jobRoles, setJobRoles] = useState(null);
  const [groups, setGroups] = useState(null);
  const { data: dir } = usePeopleDirectory();
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [editGroup, setEditGroup] = useState(undefined);
  const [assignFor, setAssignFor] = useState(null);
  const [selId, setSelId] = useState(null);          // selected job role
  const [person, setPerson] = useState(null);        // selected person email
  const [toast, setToast] = useState(null);
  const [tour, setTour] = useState(false);
  const [collapsedDepts, setCollapsedDepts] = useState(() => new Set());   // department sections closed
  const toggleDept = d => setCollapsedDepts(s => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const [dragRole, setDragRole] = useState(null);   // job-role id being dragged
  const [dropDept, setDropDept] = useState(null);   // department the drag is hovering over

  // Drag a role card onto a department to reclassify it. Optimistic + persisted.
  async function moveRoleToDept(roleId, deptName) {
    const r = (jobRoles || []).find(x => x.id === roleId);
    if (!r) return;
    const newDept = deptName === 'Other' ? '' : deptName;
    if ((r.department || '') === newDept) return;
    setJobRoles(prev => (prev || []).map(x => x.id === roleId ? { ...x, department: newDept } : x));
    try { await api.updateJobRole(roleId, { department: newDept }); toastOk(`Moved “${r.name}” to ${deptName}.`); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not move role.'); loadRoles(); }
  }

  const toastOk = m => { setToast({ m, kind: 'ok' }); setTimeout(() => setToast(null), 3500); };
  const toastErr = m => { setToast({ m, kind: 'error' }); setTimeout(() => setToast(null), 5000); };

  const loadRoles = () => api.getJobRoles().then(setJobRoles).catch(() => setJobRoles([]));
  const loadGroups = () => api.getGroups().then(gs => setGroups(gs.filter(g => !g.is_job_role))).catch(() => setGroups([]));
  // External (B2B guest) users - excluded from the people directory by design,
  // so the People tab pulls them from the admin endpoint and merges them in
  // (Visesh, Aug 18: externals belong in the People tab, granted through the
  // same roles/groups machinery as everyone else).
  const [externals, setExternals] = useState([]);
  const loadExternals = () => api.getExternalUsers().then(setExternals).catch(() => setExternals([]));
  // email -> { role, pinned }: each member's actual tier + whether it's a
  // per-person override, so a role's member list can show and change tiers.
  const [roleMap, setRoleMap] = useState({});
  const loadRoleMap = () => api.getAllRoles().then(rows => {
    const m = {}; (rows || []).forEach(r => { m[(r.email || '').toLowerCase()] = { role: r.role, pinned: !!r.tier_pinned }; });
    setRoleMap(m);
  }).catch(() => {});
  useEffect(() => {
    loadRoles(); loadGroups(); loadRoleMap(); loadExternals();
  }, []);

  // Which tiers this admin may grant (mirrors the backend: owner gives any, others
  // only strictly below their own level).
  const canAssignTier = t => can('owner') || (ROLES[t]?.level ?? 1) < myLevel;
  async function setMemberTier(email, tier) {
    if (!tier || !selected) return;
    if (!await dialog.confirm(`Set ${nameOf(email)}'s tier to "${ROLES[tier].label}" - just for this person? It overrides the "${selected.name}" role tier and won't change when the role's tier is edited.`, { title: 'Override tier', confirmText: 'Set tier' })) return;
    try { await assignRole(email, tier, nameOf(email)); toastOk(`${nameOf(email)} is now ${ROLES[tier].label}.`); loadRoleMap(); }
    catch (e) { toastErr(e?.message || 'Could not set tier.'); }
  }
  async function resetMemberTier(email) {
    if (!selected) return;
    if (!await dialog.confirm(`Reset ${nameOf(email)} to follow the "${selected.name}" tier again?`, { title: 'Reset tier', confirmText: 'Reset' })) return;
    try { await api.assignJobRole(selected.id, email); toastOk(`${nameOf(email)} follows the role tier again.`); loadRoleMap(); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not reset.'); }
  }

  const people = useMemo(() => {
    const staff = (dir || []).map(p => ({
      email: (p.email || p.workEmail || '').toLowerCase(),
      name: p.display_name || p.name || p.fullName || p.email || p.workEmail || '',
      title: p.job_title || p.jobTitle || p.title || '',
      company: p.company || '',
      companyName: p.companyName || '',
      dept: p.department || '',
      photo: p.photoUrl || p.photo_url || '',
    }));
    // Externals merge in with an External department (so the department filter
    // gains an "External" option) and their partner company as the company
    // (synthetic ext: id keeps them out of the HrEntity id space).
    const ext = (externals || []).map(x => ({
      email: (x.email || '').toLowerCase(),
      name: x.name || x.email || '',
      title: x.company ? `External - ${x.company}` : 'External user',
      company: x.company ? `ext:${x.company.toLowerCase()}` : '',
      companyName: x.company || '',
      dept: 'External',
      photo: '',
      external: x,
    }));
    return [...staff, ...ext].filter(p => p.email).sort((a, b) => a.name.localeCompare(b.name));
  }, [dir, externals]);

  // email → photo, for the member chips (role + group members arrive as emails).
  const photoOf = useMemo(() => Object.fromEntries(people.map(p => [p.email, p.photo])), [people]);

  // ── Universal company/department filter (lives in the tab strip) ────────────
  // One selector scopes the whole screen: the People list, role member chips
  // and face stacks, and group chips all narrow to the chosen company/department.
  const [co, setCo] = useState('');
  const [dept, setDept] = useState('');
  const companies = useMemo(() => {
    const seen = new Map();
    const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
    people.forEach(p => {
      if (!p.company || seen.has(p.company)) return;
      const label = p.companyName || (uuidish.test(p.company) ? '' : p.company);
      if (label) seen.set(p.company, label);
    });
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [people]);
  // Departments cascade from the company: a company without Estimating never
  // offers Estimating. Options come from what is actually in use.
  const deptOptions = useMemo(() => {
    const seen = new Map();
    people.forEach(p => {
      if (!p.dept) return;
      if (co && p.company !== co) return;
      const k = p.dept.trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, p.dept.trim());
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [people, co]);
  useEffect(() => {
    if (dept && !deptOptions.some(d => d.toLowerCase() === dept.toLowerCase())) setDept('');
  }, [deptOptions, dept]);

  const emailMeta = useMemo(() => Object.fromEntries(people.map(p => [p.email, p])), [people]);
  const filterOn = !!(co || dept);
  const inFilter = em => {
    if (!filterOn) return true;
    const p = emailMeta[(em || '').toLowerCase()];
    if (!p) return false;
    if (co && p.company !== co) return false;
    if (dept && p.dept.trim().toLowerCase() !== dept.toLowerCase()) return false;
    return true;
  };
  const scopedPeople = useMemo(() => filterOn ? people.filter(p => inFilter(p.email)) : people,
    [people, co, dept]); // eslint-disable-line react-hooks/exhaustive-deps

  // email → { role, groups } from the membership lists we already have - lets
  // person cards show chips without one API call per person.
  const membership = useMemo(() => {
    const m = {};
    (jobRoles || []).forEach(r => (r.members || []).forEach(em => {
      const k = (em || '').toLowerCase();
      m[k] = m[k] || { role: null, groups: [] }; m[k].role = r;
    }));
    (groups || []).forEach(g => (g.members || []).forEach(em => {
      const k = (em || '').toLowerCase();
      m[k] = m[k] || { role: null, groups: [] }; m[k].groups.push(g);
    }));
    return m;
  }, [jobRoles, groups]);

  const selected = (jobRoles || []).find(r => r.id === selId) || null;

  // Group the role list by department (roles with none fall under "Other", shown
  // last). Departments sort alphabetically so the list reads like an org chart.
  const rolesByDept = useMemo(() => {
    const g = {};
    (jobRoles || []).forEach(r => { const d = (r.department || '').trim() || 'Other'; (g[d] = g[d] || []).push(r); });
    return Object.entries(g).sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [jobRoles]);

  const roleCard = r => (
    <button key={r.id} onClick={() => setSelId(r.id)}
      draggable
      onDragStart={e => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move'; setDragRole(r.id); }}
      onDragEnd={() => { setDragRole(null); setDropDept(null); }}
      title="Drag onto a department to move it there"
      style={{ textAlign: 'left', background: 'var(--card)', border: `1.5px solid ${selId === r.id ? 'var(--ink)' : 'var(--line)'}`, borderRadius: 14, padding: '13px 15px', cursor: dragRole === r.id ? 'grabbing' : 'grab', fontFamily: 'Inter,sans-serif', boxShadow: selId === r.id ? 'var(--shadow-sm)' : 'none', opacity: dragRole === r.id ? 0.5 : 1, transition: 'border-color .18s ease, box-shadow .18s ease, opacity .18s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>{r.name}</span>
        <TierBadge tier={r.tier} />
      </div>
      {/* Neil (Aug 1): no bundle summary on the card - the people ARE the summary.
          Faces only; the full bundle is one click away. */}
      <div style={{ marginTop: 8, minHeight: 24, display: 'flex', alignItems: 'center' }}>
        {(() => {
          const mem = (r.members || []).filter(inFilter);
          return mem.length ? (
            <span title={`${mem.length} ${mem.length === 1 ? 'person' : 'people'}${filterOn ? ` in this filter (${r.member_count} total)` : ''}: ${mem.map(nameOf).join(', ')}`}
              style={{ display: 'inline-flex', alignItems: 'center' }}>
              {mem.slice(0, 8).map((em, i) => (
                <span key={em} style={{ marginLeft: i ? -7 : 0, display: 'inline-flex', borderRadius: '50%', border: '2px solid var(--card)' }}>
                  <Avatar name={nameOf(em)} src={photoOf[em]} size={24} />
                </span>
              ))}
              {mem.length > 8 && <span style={{ marginLeft: 5, fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>+{mem.length - 8}</span>}
            </span>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>{filterOn && r.member_count ? 'None in this filter' : 'Nobody yet'}</span>
          );
        })()}
      </div>
    </button>
  );

  // Picking a role deep in a 30+ card list leaves the detail panel (and its
  // Assign/Edit actions) off-screen above - bring it into view on selection.
  const rolePanelRef = useRef(null);
  useEffect(() => {
    if (selId && rolePanelRef.current) rolePanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selId]);

  if (!can('administrator')) {
    return <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>Roles & Access is available to administrators.</div>;
  }

  async function onDelete(r) {
    if (!await dialog.confirm(`Delete role "${r.name}"?${r.member_count ? ` ${r.member_count} people have it - reassign them first or the delete will fail.` : ''}`, { title: 'Delete role', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteJobRole(r.id); toastOk(`Deleted "${r.name}".`); if (selId === r.id) setSelId(null); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not delete - reassign its people first.'); }
  }
  async function removeMember(email) {
    if (!selected) return;
    try { await api.unassignJobRole(selected.id, email); toastOk(`Removed ${nameOf(email)} from “${selected.name}”.`); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }
  async function onDeleteGroup(g) {
    if (!await dialog.confirm(`Delete group "${g.name}"?${g.member_count ? ` ${g.member_count} people are in it and will lose that access.` : ''}`, { title: 'Delete group', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteGroup(g.id); toastOk(`Deleted "${g.name}".`); loadGroups(); }
    catch (e) { toastErr(e?.message || 'Could not delete group.'); }
  }

  const openDuplicate = r => setEditing({ ...r, id: undefined, member_count: 0, members: [],
    name: /\d+$/.test(r.name) ? r.name.replace(/(\d+)$/, m => String(+m + 1)) : `${r.name} 2` });

  // Simulate - the guided walkthrough. Clicks are shielded while it runs, so it
  // can point at the real buttons without any risk of changing live access.
  const tourSteps = [
    { target: 'tabs', title: 'One rule runs this whole screen',
      body: 'A person’s access = their job role + any extra groups. Nothing else. People is where you work day to day; Job roles and Groups are the building blocks; Audit is the all-at-once view.' },
    { target: 'people-search', before: () => setSub('people'), title: 'Start with a person',
      body: 'Type any name. You’ll see who they are, their job role, their extra groups, and every screen they can touch - with the reason next to each line.' },
    { target: 'person-panel', before: () => { setSub('people'); if (!person && people[0]) setPerson(people[0].email); }, title: 'Change access right here',
      body: 'Switch their job role (baseline follows automatically), or add / remove extra groups. You never edit a person’s permissions directly - everything comes from a role or a group, so it’s always explainable.' },
    { target: 'role-cards', before: () => setSub('jobroles'), title: 'Job roles, in plain English',
      body: 'Each card is one job: “Runs: Accounting · Edits: Documents · Views: …”. Click a card for the full bundle and the people who hold it. Editing a role updates everyone in it at once.' },
    { target: 'duplicate', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'Same job, more power? Duplicate.',
      body: 'For a supervisor version of an existing role: Duplicate, rename it, raise the tier and levels, save. The original role and its people are untouched.' },
    { target: 'role-approver', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'One approver for the whole role',
      body: 'Pick who approves this role’s timesheets. Save as default - every NEW person mapped to the role reports to them automatically. “Apply to all members” backfills everyone already in the role in one click (ten people, two clicks). Individual People cards can still override.' },
    { target: 'new-group', before: () => setSub('groups'), title: 'Groups add extras on top',
      body: 'Same job but extra duties? Don’t touch the role - add the person to a group. Groups only ever ADD access, and removing one never affects the job-role baseline.' },
    { target: 'audit-matrix', before: () => setSub('audit'), title: 'The audit view - everything at once',
      body: 'Columns are grouped into six families - click a family name to expand its screens. Each row is a role; the band underneath is the extra groups. This is the screen for access reviews.' },
    { target: 'tabs', title: 'That’s the whole system',
      body: 'Hire → assign role. Promotion → switch role (Duplicate if it doesn’t exist yet). Extra duties → group. Question about anyone → type their name in People.' },
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {!embedded && (
        <div className="view-header" style={{ marginBottom: 18 }}>
          <div className="view-title-group">
            <h2>Roles &amp; Access</h2>
            <p>Access = job role + extra groups. Look up a person to see or change theirs.</p>
          </div>
        </div>
      )}

      {/* underline tabs (native) */}
      <div className="scroll-tabs" data-tour="tabs" style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--line)', paddingBottom: 1, alignItems: 'center' }}>
        {TABS.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setSub(key)}
            style={{ background: 'none', border: 'none', padding: '10px 16px', fontFamily: 'Inter,sans-serif', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', color: sub === key ? 'var(--ink)' : 'var(--muted)', position: 'relative', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            <Icon size={16} /> {label}
            {sub === key && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2.5, background: 'var(--ink)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {companies.length > 0 && (
          <>
            <select value={co} onChange={e => setCo(e.target.value)} aria-label="Filter every tab by company"
              title="Scopes every tab to this company's people"
              style={{ ...input, width: 'auto', maxWidth: 170, padding: '6px 9px', fontSize: 12.5, margin: '4px 0 8px' }}>
              <option value="">All companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={dept} onChange={e => setDept(e.target.value)} aria-label="Filter every tab by department"
              title="Scopes every tab to this department's people" disabled={!deptOptions.length}
              style={{ ...input, width: 'auto', maxWidth: 160, padding: '6px 9px', fontSize: 12.5, margin: '4px 0 8px', opacity: deptOptions.length ? 1 : 0.55 }}>
              <option value="">{deptOptions.length ? 'All departments' : 'No departments'}</option>
              {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </>
        )}
        <button onClick={() => setTour(true)} title="A guided walkthrough of how to give out access - nothing is changed while it runs."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 14px', margin: '4px 4px 8px 0', fontFamily: 'Inter,sans-serif', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
          <PlayCircle size={15} /> Simulate
        </button>
      </div>

      {/* ── PEOPLE (default) ── */}
      {sub === 'people' && (
        <PeopleTab people={scopedPeople} membership={membership} jobRoles={jobRoles} groups={groups}
          person={person} setPerson={setPerson} nameOf={nameOf} photoOf={photoOf}
          onChanged={() => { loadRoles(); loadGroups(); }} onExternalsChanged={loadExternals}
          toastOk={toastOk} toastErr={toastErr} />
      )}

      {/* ── JOB ROLES ── */}
      {sub === 'jobroles' && (
        !jobRoles ? <Spinner /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18 }} className="ra-grid">
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary-btn" data-tour="new-role" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditing(null)}><Plus size={15} /> New job role</button>
            </div>
            <div data-tour="role-cards" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignSelf: 'start' }}>
              {jobRoles.length === 0 ? <Empty text="No job roles yet." /> : rolesByDept.map(([deptName, deptRoles]) => {
                const open = !collapsedDepts.has(deptName);
                const isDropTarget = dragRole && dropDept === deptName;
                return (
                  <div key={deptName}
                    // The whole department block is a drop target, so a role can be
                    // dropped on the header even while the section is collapsed.
                    onDragOver={dragRole ? (e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropDept !== deptName) setDropDept(deptName); }) : undefined}
                    onDragLeave={dragRole ? (e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropDept(d => (d === deptName ? null : d)); }) : undefined}
                    onDrop={dragRole ? (e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); setDropDept(null); setDragRole(null); moveRoleToDept(id, deptName); }) : undefined}
                    style={{ borderRadius: 12, outline: isDropTarget ? '2px dashed hsl(var(--color-green))' : '2px dashed transparent', outlineOffset: 2, background: isDropTarget ? 'hsla(var(--color-green),0.06)' : 'transparent', transition: 'background .18s ease' }}>
                    {/* Department header - click to smoothly expand/collapse its roles. */}
                    <button onClick={() => toggleDept(deptName)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 8px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', borderRadius: 8 }}
                      onMouseOver={e => { e.currentTarget.style.background = 'var(--mist)'; }}
                      onMouseOut={e => { e.currentTarget.style.background = 'none'; }}>
                      <ChevronRight size={15} style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .25s ease', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: isDropTarget ? 'hsl(var(--color-green))' : 'var(--muted)' }}>{deptName}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--mist)', borderRadius: 999, padding: '1px 8px' }}>{isDropTarget ? 'Drop here' : deptRoles.length}</span>
                    </button>
                    {/* grid-template-rows 0fr↔1fr = smooth height without layout thrash. */}
                    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transition: 'grid-template-rows .28s ease, opacity .2s ease' }}>
                      <div style={{ overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, paddingLeft: 6 }}>
                        {deptRoles.map(roleCard)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div ref={rolePanelRef} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, alignSelf: 'start', scrollMarginTop: 12 }}>
              {!selected ? <div style={{ color: 'var(--muted)', padding: '40px 10px', textAlign: 'center', fontSize: 13.5 }}>Pick a job role to see its full bundle, or create a new one.</div> : (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 140 }}><h3 style={{ fontSize: 18, fontWeight: 800 }}>{selected.name}</h3></div>
                    {selected.monitoring_exempt && (
                      <span title="People in this role clock in without sharing a screen; no screenshots are captured."
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: 'rgba(37,99,235,0.1)', color: 'hsl(var(--color-blue))' }}>
                        <MonitorOff size={12} /> Not monitored</span>
                    )}
                    <TierBadge tier={selected.tier} />
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditing(selected)} title="Edit role"><Pencil size={13} /></button>
                    <button className="secondary-btn" data-tour="duplicate" style={{ padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => openDuplicate(selected)}
                      title="Duplicate this role into a new one (e.g. for a supervisor tier)"><Copy size={13} /> Duplicate</button>
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDelete(selected)} title="Delete role"><Trash2 size={13} /></button>
                  </div>
                  {selected.description && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '8px 0 0', maxWidth: '60ch' }}>{selected.description}</p>}
                  {['owner', 'full', 'editor', 'viewer'].map(lvl => {
                    const mods = (selected.allowed_modules || []).filter(g => g.level === lvl);
                    if (!mods.length) return null;
                    return (
                      <div key={lvl}>
                        <div style={sectLabel}>{{ owner: 'Owns (full + manage access)', full: 'Can run fully', editor: 'Can create and edit', viewer: 'Can view' }[lvl]}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                          {mods.map(g => (
                            <span key={g.id} title={capabilityText(g.id, g.level, moduleLabel(g.id))}
                              style={{ padding: '5px 12px', borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                              {moduleLabel(g.id)}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {(selected.allowed_modules || []).length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 16 }}>No modules granted yet - press Edit to build the bundle.</div>}
                  <div style={sectLabel}>Timesheet approver (default manager)</div>
                  <ApproverPicker role={selected} people={people} nameOf={nameOf}
                    onSaved={loadRoles} toastOk={toastOk} toastErr={toastErr} />
                  <div style={sectLabel}>People with this role · {filterOn
                    ? `${(selected.members || []).filter(inFilter).length} of ${selected.member_count}`
                    : selected.member_count}</div>
                  {(selected.members || []).filter(inFilter).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      {selected.members.filter(inFilter).map(em => {
                        const info = roleMap[em] || {};
                        return (
                          <div key={em} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', flexWrap: 'wrap' }}>
                            <Avatar name={nameOf(em)} src={photoOf[em]} size={24} />
                            <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(em)}</span>
                            {info.role && <TierBadge tier={info.role} />}
                            {info.pinned && (
                              <span title="Tier set for this person directly - a role-tier change won't move them."
                                style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: 'hsl(var(--color-purple))', background: 'hsla(var(--color-purple),0.12)', padding: '2px 7px', borderRadius: 6 }}>
                                Override
                              </span>
                            )}
                            <select value="" onChange={e => setMemberTier(em, e.target.value)} title="Give this person a different tier"
                              style={{ ...input, width: 'auto', padding: '4px 8px', fontSize: 12 }}>
                              <option value="">Tier…</option>
                              {TIERS.filter(canAssignTier).map(t => <option key={t} value={t}>{ROLES[t].label}</option>)}
                            </select>
                            {info.pinned && (
                              <button className="secondary-btn" onClick={() => resetMemberTier(em)} title="Follow the role tier again" style={{ padding: '4px 9px', fontSize: 11.5 }}>Reset</button>
                            )}
                            <button onClick={() => removeMember(em)} title="Remove from this role" aria-label={`Remove ${nameOf(em)}`}
                              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 }}
                              onMouseOver={e => { e.currentTarget.style.background = 'hsla(var(--color-red),0.14)'; e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                              onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                              <X size={13} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button className="secondary-btn" data-tour="assign" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setAssignFor(selected)}>
                    <UserPlus size={14} /> Assign a person
                  </button>
                  <div style={{ marginTop: 14, background: 'hsla(var(--color-blue),0.08)', border: '1px solid hsla(var(--color-blue),0.2)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: 'var(--ink)' }}>
                    Editing the bundle applies to all {selected.member_count} people who hold this role. Extra groups layer on top.
                  </div>
                </>
              )}
            </div>
          </div>
        )
      )}

      {/* ── GROUPS ── */}
      {sub === 'groups' && (
        !groups ? <Spinner /> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="primary-btn" data-tour="new-group" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditGroup(null)}><Plus size={15} /> New group</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {groups.length === 0 ? <Empty text="No extra groups yet. Create one to grant extra access on top of a job role." /> : groups.map(g => (
                <div key={g.id} style={{ background: 'var(--card)', border: '1px dashed var(--line-strong,var(--line))', borderRadius: 14, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>+ {g.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{(g.members || []).length} {(g.members || []).length === 1 ? 'person' : 'people'}</span>
                    <button className="secondary-btn" style={{ padding: '5px 9px' }} onClick={() => setEditGroup(g)} title="Edit group"><Pencil size={13} /></button>
                    <button className="secondary-btn" style={{ padding: '5px 9px' }} onClick={() => onDeleteGroup(g)} title="Delete group"><Trash2 size={13} /></button>
                  </div>
                  <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>{bundleSummary(g.allowed_modules)}</div>
                  {(g.members || []).filter(inFilter).length > 0 && (
                    <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(g.members || []).filter(inFilter).slice(0, 6).map(em => (
                        <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 4px', borderRadius: 20, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 600 }}>
                          <Avatar name={nameOf(em)} src={photoOf[em]} size={18} />{nameOf(em)}
                        </span>
                      ))}
                      {(g.members || []).filter(inFilter).length > 6 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>+{(g.members || []).filter(inFilter).length - 6} more</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 2px', fontSize: 12, color: 'var(--muted)' }}>Groups only ever add access on top of a job role. Add or remove people from the People tab.</div>
          </>
        )
      )}

      {/* ── AUDIT (tamed matrix) ── */}
      {sub === 'audit' && (
        <AuditMatrix jobRoles={jobRoles} groups={groups} />
      )}

      {editing !== undefined && <RoleEditor role={editing} jobRoles={jobRoles} onClose={() => setEditing(undefined)}
        onSaved={r => {
          setEditing(undefined); toastOk(`Saved “${r.name}”.`); setSelId(r.id);
          // Merge the server's response into local state IMMEDIATELY. The refetch
          // takes seconds on a slow link; reopening the editor before it landed
          // showed pre-save data (and re-saving that stale modal wrote the old
          // values back) - which read as "my changes are gone".
          setJobRoles(prev => { const arr = prev || []; return arr.some(x => x.id === r.id) ? arr.map(x => x.id === r.id ? r : x) : [...arr, r]; });
          loadRoles();
        }} onErr={toastErr} />}
      {editGroup !== undefined && <GroupEditor group={editGroup} jobRoles={jobRoles} onClose={() => setEditGroup(undefined)}
        onSaved={g => {
          setEditGroup(undefined); toastOk(`Saved “${g.name}”.`);
          setGroups(prev => { const arr = prev || []; return arr.some(x => x.id === g.id) ? arr.map(x => x.id === g.id ? g : x) : [...arr, g]; });
          loadGroups();
        }} onErr={toastErr} />}
      {assignFor && <AssignModal role={assignFor} onClose={() => setAssignFor(null)}
        onAssigned={n => { toastOk(`Assigned ${n} to “${assignFor.name}”.`); loadRoles(); }} onErr={toastErr} />}
      {tour && <GuidedTour steps={tourSteps} onClose={() => setTour(false)} />}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>{toast.m}</div>
      )}
      <style>{`@media (max-width:900px){.ra-grid{grid-template-columns:1fr !important}.ra-people{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

// ── PEOPLE tab - search a person, see and change their access ────────────────
function PeopleTab({ people, membership, jobRoles, groups, person, setPerson, nameOf, photoOf = {}, onChanged, onExternalsChanged, toastOk, toastErr }) {
  const { assignRole, myLevel, can } = useRole();
  const [q, setQ] = useState('');
  const [co, setCo] = useState('');       // company (entity id) filter
  const [dept, setDept] = useState('');   // department (name) filter
  const [eff, setEff] = useState(null);
  const [busy, setBusy] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  // External (B2B guest) support: the selected person's external record (if
  // any) drives the extra panel section; the invite modal enrolls a new one.
  const [inviteOpen, setInviteOpen] = useState(false);
  const extRec = useMemo(() => people.find(p => p.email === person)?.external || null, [people, person]);
  // Which tiers this admin may hand out (mirrors the backend guard: owners give
  // any, others only strictly below their own level).
  const canAssignTier = t => can('owner') || (ROLES[t]?.level ?? 1) < myLevel;
  useEffect(() => { setPromoteOpen(false); }, [person]);

  // Same courtesy as the role panel: picking a person deep in the list brings
  // their panel (role picker, groups) into view instead of leaving it above.
  const panelRef = useRef(null);
  useEffect(() => {
    if (person && panelRef.current) panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [person]);

  // Company/department scoping happens upstream (the universal selector in the
  // tab strip hands this tab already-scoped people); only search lives here.
  const filtered = useMemo(() => people.filter(p =>
    !q.trim() || p.name.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase())), [people, q]);

  useEffect(() => {
    if (!person) { setEff(null); return; }
    let dead = false;
    setBusy(true); setEff(null);
    api.getEffectiveAccess(person)
      .then(d => { if (!dead) setEff(d); })
      .catch(() => { if (!dead) setEff({ error: true }); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [person]);

  const refresh = () => { onChanged(); if (person) api.getEffectiveAccess(person).then(setEff).catch(() => {}); };

  async function changeRole(roleId) {
    const r = (jobRoles || []).find(x => x.id === roleId);
    if (!r || !person) return;
    if (!await dialog.confirm(`Change ${nameOf(person)}'s job role to "${r.name}"? Their baseline access and tier will follow the new role.`, { title: 'Change job role', confirmText: 'Change role' })) return;
    try { await api.assignJobRole(r.id, person); toastOk(`${nameOf(person)} is now “${r.name}”.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not change role.'); }
  }
  async function addToGroup(gid) {
    const g = (groups || []).find(x => x.id === gid);
    if (!g || !person) return;
    try { await api.addGroupMembers(g.id, [person]); toastOk(`Added ${nameOf(person)} to “${g.name}”.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not add to group.'); }
  }
  async function removeFromGroup(g) {
    if (!await dialog.confirm(`Remove ${nameOf(person)} from "${g.name}"? They lose that extra access; their job-role baseline is untouched.`, { title: 'Remove from group', confirmText: 'Remove', danger: true })) return;
    try { await api.removeGroupMember(g.id, person); toastOk(`Removed ${nameOf(person)} from “${g.name}”.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }
  // Per-person tier OVERRIDE: sets this individual's seniority tier directly and
  // pins it, so two people in the SAME job role can hold different tiers and a
  // later job-role tier edit won't re-stamp this person.
  async function setTierOverride(tier) {
    if (!person || !tier) return;
    if (!await dialog.confirm(`Set ${nameOf(person)}'s tier to "${ROLES[tier].label}" - just for this person? It overrides their job role's tier and won't change when the role's tier is edited.`, { title: 'Override tier', confirmText: 'Set tier' })) return;
    try { await assignRole(person, tier, nameOf(person)); toastOk(`${nameOf(person)} is now ${ROLES[tier].label}.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not set tier.'); }
  }
  async function resetTier() {
    if (!person || !eff?.job_role) return;
    if (!await dialog.confirm(`Reset ${nameOf(person)} to follow their "${eff.job_role.name}" tier again?`, { title: 'Reset tier', confirmText: 'Reset' })) return;
    try { await api.assignJobRole(eff.job_role.id, person); toastOk('Now follows the job-role tier.'); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not reset.'); }
  }

  const memberGroupIds = new Set((eff?.extra_groups || []).map(g => g.id));
  const addableGroups = (groups || []).filter(g => !memberGroupIds.has(g.id));

  return (
    <div className="ra-people" style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 18 }}>
      {/* left: search + people list */}
      <div style={{ alignSelf: 'start' }}>
        <div data-tour="people-search" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search anyone…" style={{ ...input, paddingLeft: 34 }} />
          </div>
          <button className="secondary-btn" onClick={() => setInviteOpen(true)}
            title="Invite a partner-company person as a Microsoft guest - they appear here like anyone else"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
            <MailPlus size={14} /> Invite External User
          </button>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6, maxHeight: '64vh', overflow: 'auto' }}>
          {!people.length ? <Spinner /> : filtered.length === 0 ? <Empty text="No matches." /> : filtered.slice(0, 120).map(p => {
            const mem = membership[p.email];
            const active = person === p.email;
            return (
              <button key={p.email} onClick={() => setPerson(p.email)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 11px', borderRadius: 10, border: 'none', width: '100%', textAlign: 'left', background: active ? 'color-mix(in srgb, var(--ink) 8%, transparent)' : 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                <Avatar name={p.name} src={p.photo} size={28} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {p.external && <ExternalBadge />}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {mem?.role ? mem.role.name : (p.title || 'No job role yet')}
                    {mem?.groups?.length ? `  ·  +${mem.groups.length} ${mem.groups.length === 1 ? 'group' : 'groups'}` : ''}
                  </div>
                </div>
                <ChevronRight size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              </button>
            );
          })}
        </div>
      </div>

      {/* right: person detail */}
      <div ref={panelRef} data-tour="person-panel" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, alignSelf: 'start', minHeight: 220, scrollMarginTop: 12 }}>
        {!person ? (
          <div style={{ padding: '48px 16px', textAlign: 'center' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', margin: '0 auto 12px' }}>
              <User size={20} style={{ color: 'var(--muted)' }} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Pick a person</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: '32ch', margin: '4px auto 0', lineHeight: 1.5 }}>
              See exactly what they can do - and change their role or groups right here.
            </div>
          </div>
        ) : busy || !eff ? <Spinner /> : eff.error ? (
          <div style={{ color: 'var(--muted)', padding: '40px 10px', textAlign: 'center', fontSize: 13.5 }}>Could not load access for this person.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Avatar name={extRec?.name || nameOf(eff.email)} src={photoOf[eff.email]} size={34} />
              <h3 style={{ fontSize: 17, fontWeight: 800, flex: 1, minWidth: 140 }}>{extRec?.name || nameOf(eff.email)}</h3>
              {/* Externals are badged "External", never a tier name (Visesh, Aug 18). */}
              {extRec ? <ExternalBadge /> : <TierBadge tier={eff.tier} />}
            </div>

            {/* External guest: invite state + lifecycle actions. Everything
                below (job role, tier, groups) is the same for everyone. */}
            {extRec && (
              <ExternalPersonSection ext={extRec} toastOk={toastOk} toastErr={toastErr}
                onChanged={() => { onExternalsChanged?.(); refresh(); }}
                onRemoved={() => { setPerson(null); onExternalsChanged?.(); onChanged(); }} />
            )}

            <div style={sectLabel}>Job role - the baseline</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {eff.job_role
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 13px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontSize: 12.5, fontWeight: 700 }}><Shield size={13} /> {eff.job_role.name}</span>
                : <span style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>No job role yet</span>}
              <select value="" onChange={e => e.target.value && changeRole(e.target.value)} style={{ ...input, width: 'auto', padding: '6px 10px', fontSize: 12.5 }}>
                <option value="">{eff.job_role ? 'Change role…' : 'Assign a role…'}</option>
                {(jobRoles || []).filter(r => r.id !== eff.job_role?.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="secondary-btn" onClick={() => setPromoteOpen(true)} disabled={!(jobRoles || []).length}
                title="Pick the new role and see exactly what changes before committing"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12.5 }}>
                <TrendingUp size={13} /> Promote…
              </button>
            </div>
            {promoteOpen && (
              <PromoteModal person={person} eff={eff} nameOf={nameOf}
                jobRoles={(jobRoles || []).filter(r => r.id !== eff.job_role?.id)}
                onClose={() => setPromoteOpen(false)} onErr={toastErr}
                onDone={r => { setPromoteOpen(false); toastOk(`${nameOf(person)} is now “${r.name}”.`); refresh(); }} />
            )}

            {/* Seniority tier is meaningless for externals: the server hard-caps
                them at employee level regardless, so offering the override
                selector would just mislead. The External section above already
                labels what they are. */}
            {!extRec && (<>
            <div style={sectLabel}>Seniority tier</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <TierBadge tier={eff.tier} />
              {eff.tier_pinned && (
                <span title="Set for this person directly - a job-role tier change won't move them."
                  style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: 'hsl(var(--color-purple))', background: 'hsla(var(--color-purple),0.12)', padding: '2px 7px', borderRadius: 6 }}>
                  Override
                </span>
              )}
              <select value="" onChange={e => setTierOverride(e.target.value)} style={{ ...input, width: 'auto', padding: '6px 10px', fontSize: 12.5 }}>
                <option value="">{eff.tier_pinned ? 'Change this person’s tier…' : 'Override tier for this person…'}</option>
                {TIERS.filter(canAssignTier).map(t => <option key={t} value={t}>{ROLES[t].label}</option>)}
              </select>
              {eff.tier_pinned && eff.job_role && (
                <button className="secondary-btn" onClick={resetTier} style={{ padding: '6px 12px', fontSize: 12.5 }}>Reset to role tier</button>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              {eff.tier_pinned
                ? 'Set directly for this person - editing the job role’s tier won’t change them.'
                : 'Follows their job role. Override it here to give this person a different tier while keeping them in the same role.'}
            </div>
            </>)}

            <div style={sectLabel}>Extra groups - added on top</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {(eff.extra_groups || []).map(g => (
                <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 12px', borderRadius: 999, border: '1px dashed var(--line-strong,var(--line))', fontSize: 12, fontWeight: 600 }}>
                  + {g.name}
                  <button onClick={() => removeFromGroup(g)} title={`Remove from ${g.name}`} aria-label={`Remove from ${g.name}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 17, height: 17, borderRadius: '50%', padding: 0 }}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              {(eff.extra_groups || []).length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>None</span>}
              {addableGroups.length > 0 && (
                <select value="" onChange={e => e.target.value && addToGroup(e.target.value)} style={{ ...input, width: 'auto', padding: '6px 10px', fontSize: 12.5 }}>
                  <option value="">+ Add to group…</option>
                  {addableGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
            </div>

            <div style={sectLabel}>What they can do</div>
            {(eff.modules || []).length === 0
              ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nothing yet - assign a job role to give them their baseline.</div>
              : eff.modules.map(m => (
                <div key={m.module} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ fontWeight: 600, fontSize: 13, minWidth: 150 }}>{moduleLabel(m.module)}</span>
                  <LevelPill level={m.level} title={capabilityText(m.module, m.level, moduleLabel(m.module))} />
                  <span style={{ flex: 1 }} />
                  {/* Provenance reuses the dashed "+ group" language from the chips
                      above, so baseline (quiet, from the role) vs extra (dashed
                      add-on) reads at a glance - the whole point of this screen. */}
                  {m.manual
                    ? <span title={`Extra access from the “${m.source}” group`}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: 'var(--ink)', border: '1px dashed var(--line-strong,var(--line))', borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>+ {m.source}</span>
                    : <span title={`From their job role, “${m.source}”`} style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>from {m.source}</span>}
                </div>
              ))}
          </>
        )}
      </div>

      {inviteOpen && (
        <InviteExternalModal initial={null}
          onClose={() => setInviteOpen(false)}
          onSaved={(result) => {
            setInviteOpen(false);
            inviteOutcomeToast(result, toastOk, toastErr);
            onExternalsChanged?.();
            if (result?.email) setPerson(result.email);
          }} />
      )}
    </div>
  );
}

// ── AUDIT tab - the matrix, tamed with module families ───────────────────────
function AuditMatrix({ jobRoles, groups }) {
  const [open, setOpen] = useState(() => new Set());       // expanded family ids
  const [hoverCol, setHoverCol] = useState(null);          // family id or module id

  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!jobRoles || !groups) return <Spinner />;
  if (jobRoles.length === 0) return <Empty text="No job roles yet - create one in the Job roles tab." />;

  // For a row's grants, the strongest level within a family (dot = mixed levels).
  const familyCell = (byId, fam) => {
    const lvls = fam.modules.map(id => byId[id]).filter(Boolean);
    if (!lvls.length) return { level: null, mixed: false };
    let top = lvls[0];
    for (const l of lvls) if ((MODULE_LEVELS[l]?.rank || 0) > (MODULE_LEVELS[top]?.rank || 0)) top = l;
    return { level: top, mixed: new Set(lvls).size > 1 || lvls.length < fam.modules.length };
  };

  const colHl = key => hoverCol === key ? { background: 'color-mix(in srgb, var(--ink) 5%, transparent)' } : {};

  const renderRow = (name, meta, byId, extra) => (
    <tr key={name} className="ra-audit-row">
      <th style={{ ...thRow, ...(extra ? { borderLeft: '3px dashed var(--line-strong,var(--line))' } : {}) }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{extra ? `+ ${name}` : name}</div>
        {meta}
      </th>
      {FAMILIES.map(fam => open.has(fam.id)
        ? fam.modules.map(id => (
          <td key={id} style={{ ...tdCell, ...colHl(id) }} onMouseEnter={() => setHoverCol(id)} onMouseLeave={() => setHoverCol(null)}>
            <LevelPill level={byId[id]} title={byId[id] ? `${moduleLabel(id)} · ${MODULE_LEVELS[byId[id]]?.label}\n${capabilityText(id, byId[id], moduleLabel(id))}` : ''} />
          </td>
        ))
        : (() => {
          const c = familyCell(byId, fam);
          return (
            <td key={fam.id} style={{ ...tdCell, ...colHl(fam.id) }} onMouseEnter={() => setHoverCol(fam.id)} onMouseLeave={() => setHoverCol(null)}
              title={c.level ? `${fam.label}: strongest is ${MODULE_LEVELS[c.level]?.label}${c.mixed ? ' (mixed - expand to see each screen)' : ''}` : `${fam.label}: no access`}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <LevelPill level={c.level} />
                {c.mixed && c.level && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--muted)' }} />}
              </span>
            </td>
          );
        })()
      )}
    </tr>
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px', fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ fontWeight: 700 }}>Access level:</span>
        {LEVEL_ORDER.map(l => <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={MODULE_LEVELS[l]?.description || ''}><LevelPill level={l} /></span>)}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LevelPill level={null} /> No access</span>
        <span style={{ fontStyle: 'italic' }}>Click a column family to expand its screens. A dot means mixed levels inside.</span>
      </div>
      <div data-tour="audit-matrix" style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'auto', maxHeight: '72vh', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={thCorner}>Job role</th>
              {FAMILIES.map(fam => (
                <th key={fam.id} colSpan={open.has(fam.id) ? fam.modules.length : 1}
                  style={{ ...thCol, cursor: 'pointer', userSelect: 'none', ...colHl(fam.id) }}
                  onClick={() => toggle(fam.id)}
                  title={open.has(fam.id) ? 'Collapse' : `Expand: ${fam.modules.map(moduleLabel).join(', ')}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {open.has(fam.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {fam.label}
                    {!open.has(fam.id) && <span style={{ fontWeight: 400 }}>({fam.modules.length})</span>}
                  </span>
                </th>
              ))}
            </tr>
            <tr>
              <th style={{ ...thCorner, top: 34, fontWeight: 400, fontSize: 10.5 }}>{jobRoles.length} roles · {groups.length} groups</th>
              {FAMILIES.map(fam => open.has(fam.id)
                ? fam.modules.map(id => (
                  <th key={id} style={{ ...thCol, top: 34, ...colHl(id) }} onMouseEnter={() => setHoverCol(id)} onMouseLeave={() => setHoverCol(null)}>{moduleLabel(id)}</th>
                ))
                : <th key={fam.id} style={{ ...thCol, top: 34, fontWeight: 400, color: 'var(--muted)', ...colHl(fam.id) }}>strongest</th>
              )}
            </tr>
          </thead>
          <tbody>
            {jobRoles.map(r => renderRow(
              r.name,
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 7 }}><TierBadge tier={r.tier} /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.member_count} ppl</span></div>,
              Object.fromEntries((r.allowed_modules || []).map(g => [g.id, g.level])),
              false,
            ))}
            {groups.length > 0 && (
              <tr>
                <th style={{ ...thRow, borderTop: '2px solid var(--line)', paddingTop: 14 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Extra access groups</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontWeight: 400 }}>Added on top of a job role</div>
                </th>
                {FAMILIES.map(fam => (open.has(fam.id) ? fam.modules : [fam.id]).map(k => <td key={k} style={{ ...tdCell, borderTop: '2px solid var(--line)' }} />))}
              </tr>
            )}
            {groups.map(g => renderRow(
              g.name,
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{(g.members || []).length} {(g.members || []).length === 1 ? 'person' : 'people'}</div>,
              Object.fromEntries((g.allowed_modules || []).map(x => [x.id, x.level])),
              true,
            ))}
          </tbody>
        </table>
      </div>
      <style>{`.ra-audit-row:hover td, .ra-audit-row:hover th { background: color-mix(in srgb, var(--ink) 4%, transparent); }`}</style>
    </>
  );
}

// ── role approver - the "ten people, two clicks" control ─────────────────────
// Default manager on the role: new members with no manager inherit it; "Apply to
// all" backfills current members. Per-person Manager (People card) stays the
// source of truth - this is a bulk tool, not a second truth.
function ApproverPicker({ role, people, nameOf, onSaved, toastOk, toastErr }) {
  const [val, setVal] = useState(role.default_manager_email || '');
  const [busy, setBusy] = useState('');
  useEffect(() => { setVal(role.default_manager_email || ''); }, [role.id, role.default_manager_email]);

  async function saveDefault(v) {
    setVal(v); setBusy('save');
    try {
      await api.updateJobRole(role.id, { default_manager_email: v });
      toastOk(v ? `Default approver saved - new people mapped to “${role.name}” will report to ${nameOf(v)}.` : 'Default approver cleared.');
      onSaved();
    } catch (e) { toastErr(e?.message || 'Could not save the approver.'); }
    setBusy('');
  }
  async function applyAll() {
    if (!val) return;
    if (!await dialog.confirm(`Set ${nameOf(val)} as manager/timesheet approver for all ${role.member_count} people in "${role.name}"? This overwrites their current manager; individual cards can be changed afterwards.`, { title: 'Set approver for whole role', confirmText: 'Set for all' })) return;
    setBusy('apply');
    try {
      const r = await api.applyJobRoleManager(role.id, val);
      toastOk(`${nameOf(val)} is now the approver for ${r.updated} ${r.updated === 1 ? 'person' : 'people'} in “${role.name}”.`);
      onSaved();
    } catch (e) { toastErr(e?.message || 'Could not apply to members.'); }
    setBusy('');
  }

  return (
    <div data-tour="role-approver">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select value={val} onChange={e => saveDefault(e.target.value)} disabled={busy === 'save'}
          style={{ ...input, width: 'auto', minWidth: 210, padding: '7px 10px', fontSize: 12.5 }}>
          <option value="">No default approver</option>
          {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
        </select>
        <button className="secondary-btn" disabled={!val || !!busy || !role.member_count} onClick={applyAll}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy === 'apply' && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
          Apply to all {role.member_count} {role.member_count === 1 ? 'member' : 'members'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5, maxWidth: '60ch' }}>
        Who approves this role's timesheets and punch fixes. New people mapped to the role inherit them automatically (if they don't already have a manager); Apply to all backfills everyone currently in it. A person's own card always wins.
      </div>
    </div>
  );
}

// ── bundle editor (shared by RoleEditor + GroupEditor) ───────────────────────
// One-click granting: each row is four level pills - clicking a pill grants the
// screen at that level (no separate checkbox step), clicking the active pill
// removes it. Bulk actions cover "everything except two screens" in four
// clicks: Check All -> set all checked to Full -> click off the two.
function BundleEditor({ bundle, setBundle, inheritSources = [] }) {
  const [bulk, setBulk] = useState('');
  const [inheritFrom, setInheritFrom] = useState('');
  const grant = (id, level) => setBundle(b => {
    const n = { ...b };
    if (n[id] === level) delete n[id]; else n[id] = level;
    return n;
  });
  const checkedCount = Object.keys(bundle).length;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 8px' }}>
        <button type="button" className="secondary-btn" style={{ padding: '5px 10px', fontSize: 12 }}
          onClick={() => setBundle(b => Object.fromEntries(GRANTABLE.map(m => [m.id, b[m.id] || 'viewer'])))}>Check All</button>
        <button type="button" className="secondary-btn" style={{ padding: '5px 10px', fontSize: 12 }}
          onClick={() => setBundle({})}>Clear All</button>
        {inheritSources.length > 0 && (
          <select value={inheritFrom} aria-label="Inherit this bundle from an existing role"
            title="Start from another role's bundle, then tweak - replaces the current selection"
            onChange={e => {
              const src = inheritSources.find(r => r.id === e.target.value);
              setInheritFrom('');
              if (src) setBundle(Object.fromEntries((src.allowed_modules || []).map(g => [g.id, g.level])));
            }}
            style={{ ...input, width: 'auto', padding: '5px 8px', fontSize: 12 }}>
            <option value="">Inherit from role…</option>
            {inheritSources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <span style={{ flex: 1 }} />
        <select value={bulk} onChange={e => { const l = e.target.value; setBulk(''); if (l) setBundle(b => Object.fromEntries(Object.keys(b).map(id => [id, l]))); }}
          disabled={!checkedCount} aria-label="Set every checked screen to one level"
          style={{ ...input, width: 'auto', padding: '5px 8px', fontSize: 12, opacity: checkedCount ? 1 : 0.5 }}>
          <option value="">Set all checked to…</option>
          {LEVEL_ORDER.map(l => <option key={l} value={l}>{MODULE_LEVELS[l].label}</option>)}
        </select>
      </div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 300, overflow: 'auto' }}>
        {GRANTABLE.map(m => {
          const on = bundle[m.id];
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--line)',
              background: on ? 'color-mix(in srgb, var(--ink) 5%, transparent)' : 'transparent' }}>
              <span aria-hidden style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: on ? 'var(--ink)' : 'transparent', color: 'var(--card)',
                border: on ? 'none' : '1.5px solid var(--line-strong,var(--line))' }}>
                {on && <Check size={12} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: on ? 700 : 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{m.label}</div>
                {on && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{capabilityText(m.id, on, m.label)}</div>}
              </div>
              <div style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }} role="group" aria-label={`${m.label} level`}>
                {LEVEL_ORDER.map(l => {
                  const active = on === l;
                  return (
                    <button key={l} type="button" onClick={() => grant(m.id, l)}
                      title={active ? `Click to remove ${m.label}` : capabilityText(m.id, l, m.label)}
                      style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                        border: `1.5px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
                        background: active ? 'var(--ink)' : 'transparent',
                        color: active ? 'var(--card)' : 'var(--muted)' }}>
                      {MODULE_LEVELS[l].label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7 }}>
        One click grants a screen at that level; click the active level again to remove it. {checkedCount} of {GRANTABLE.length} screens granted.
      </div>
    </div>
  );
}

// ── promotion flow ───────────────────────────────────────────────────────────
// Mechanically a promotion IS a role switch - this modal adds what the dropdown
// can't: tier before/after and every screen gained, raised or lost, so whoever
// promotes can see exactly what changes before committing. Title, tier and the
// default approver all follow the new role via the existing assign endpoint.
function PromoteModal({ person, eff, jobRoles, nameOf, onClose, onDone, onErr }) {
  const [toId, setToId] = useState('');
  const [busy, setBusy] = useState(false);
  const cur = eff?.job_role || null;
  const target = (jobRoles || []).find(r => r.id === toId) || null;
  const diff = useMemo(() => {
    if (!target) return null;
    const a = Object.fromEntries((cur?.allowed_modules || []).map(g => [g.id, g.level]));
    const b = Object.fromEntries((target.allowed_modules || []).map(g => [g.id, g.level]));
    const rank = l => MODULE_LEVELS[l]?.rank || 0;
    const gained = [], raised = [], lowered = [], lost = [];
    Object.keys(b).forEach(id => {
      if (!a[id]) gained.push({ id, to: b[id] });
      else if (rank(b[id]) > rank(a[id])) raised.push({ id, from: a[id], to: b[id] });
      else if (rank(b[id]) < rank(a[id])) lowered.push({ id, from: a[id], to: b[id] });
    });
    Object.keys(a).forEach(id => { if (!b[id]) lost.push({ id, from: a[id] }); });
    return { gained, raised, lowered, lost };
  }, [cur, target]);

  async function promote() {
    if (!target || busy) return;
    setBusy(true);
    try { await api.assignJobRole(target.id, person); onDone(target); }
    catch (e) { onErr(e?.message || 'Could not change the role.'); setBusy(false); }
  }

  const chipRow = (label, items, render) => items.length > 0 && (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{items.map(render)}</div>
    </div>
  );
  const pill = (key, text, kind) => (
    <span key={key} style={{ padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: kind === 'plus' ? 'var(--ink)' : 'var(--paper)',
      color: kind === 'plus' ? 'var(--card)' : kind === 'minus' ? 'var(--muted)' : 'var(--ink)',
      border: '1px solid var(--line)', textDecoration: kind === 'minus' ? 'line-through' : 'none' }}>{text}</span>
  );

  return (
    <Modal onClose={onClose} title={`Promote ${nameOf(person)}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{cur ? cur.name : 'No role yet'}</span>
          {cur && <TierBadge tier={cur.tier} />}
          <ChevronRight size={15} style={{ color: 'var(--muted)' }} />
          <select value={toId} onChange={e => setToId(e.target.value)} autoFocus
            style={{ ...input, width: 'auto', minWidth: 200, padding: '7px 10px', fontSize: 13 }}>
            <option value="">Promote to…</option>
            {(jobRoles || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {target && <TierBadge tier={target.tier} />}
        </div>
        {target && diff && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '4px 14px 14px', maxHeight: 300, overflow: 'auto' }}>
            {chipRow('Gains', diff.gained, x => pill(x.id, `${moduleLabel(x.id)} · ${MODULE_LEVELS[x.to]?.label}`, 'plus'))}
            {chipRow('Level goes up', diff.raised, x => pill(x.id, `${moduleLabel(x.id)} · ${MODULE_LEVELS[x.from]?.label} → ${MODULE_LEVELS[x.to]?.label}`, 'plus'))}
            {chipRow('Level goes down', diff.lowered, x => pill(x.id, `${moduleLabel(x.id)} · ${MODULE_LEVELS[x.from]?.label} → ${MODULE_LEVELS[x.to]?.label}`))}
            {chipRow('Loses', diff.lost, x => pill(x.id, moduleLabel(x.id), 'minus'))}
            {!diff.gained.length && !diff.raised.length && !diff.lowered.length && !diff.lost.length && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Same screens and levels - only the title{cur && target.tier !== cur.tier ? ' and tier' : ''} change.</div>
            )}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          Their job title, seniority tier and baseline access follow the new role. Extra groups stay. If the new role has a default approver and they have no manager, they inherit it.
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={!target || busy} onClick={promote}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: (!target || busy) ? 0.6 : 1 }}>
          {busy ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <TrendingUp size={14} />} Promote
        </button>
      </div>
    </Modal>
  );
}

// ── editor modal ─────────────────────────────────────────────────────────────
function RoleEditor({ role, jobRoles = [], onClose, onSaved, onErr }) {
  const [name, setName] = useState(role?.name || '');
  const [tier, setTier] = useState(role?.tier || 'employee');
  const [dept, setDept] = useState(role?.department || '');
  const [desc, setDesc] = useState(role?.description || '');
  const [bundle, setBundle] = useState(() => Object.fromEntries((role?.allowed_modules || []).map(g => [g.id, g.level])));
  const [monExempt, setMonExempt] = useState(!!role?.monitoring_exempt);
  const [busy, setBusy] = useState(false);
  const deptOptions = [...new Set((jobRoles || []).map(r => r.department).filter(Boolean))].sort();

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), tier, department: dept.trim(), description: desc.trim(), monitoring_exempt: monExempt, allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })) };
    try {
      // A seed object with no id (from Duplicate) creates a new role rather than editing the original.
      const saved = role?.id ? await api.updateJobRole(role.id, body) : await api.createJobRole(body);
      onSaved(saved);
    } catch (e) { onErr(e?.message || 'Could not save job role.'); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={role?.id ? 'Edit job role' : 'New job role'} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={fieldLabel}>Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Supervisor" style={input} /></label>
        <label style={fieldLabel}>Seniority tier
          <select value={tier} onChange={e => setTier(e.target.value)} style={input}>
            {TIERS.map(t => <option key={t} value={t}>{ROLES[t].label}</option>)}
          </select>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 400 }}>{ROLES[tier]?.description}</span>
        </label>
        <label style={fieldLabel}>Department
          <input value={dept} onChange={e => setDept(e.target.value)} placeholder="e.g. Accounting" list="jr-dept-options" style={input} />
          <datalist id="jr-dept-options">{deptOptions.map(d => <option key={d} value={d} />)}</datalist>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 400 }}>Groups this role under a department in the list. Leave blank for “Other”.</span>
        </label>
        <label style={fieldLabel}>Description
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Plain-language: what this role does" style={{ ...input, resize: 'vertical' }} /></label>
        <div>
          <div style={{ ...sectLabel, marginTop: 4 }}>Module bundle</div>
          <BundleEditor bundle={bundle} setBundle={setBundle} inheritSources={(jobRoles || []).filter(r => r.id !== role?.id)} />
        </div>
        <div style={{ ...sectLabel, marginTop: 4 }}>Time-clock monitoring</div>
        <button type="button" onClick={() => setMonExempt(v => !v)}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 11, textAlign: 'left', width: '100%', padding: '11px 13px',
            border: `1.5px solid ${monExempt ? 'var(--ink)' : 'var(--line)'}`, borderRadius: 10,
            background: monExempt ? 'var(--mist)' : 'transparent', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, display: 'grid', placeItems: 'center',
            border: `1.5px solid ${monExempt ? 'var(--ink)' : 'var(--line-strong,rgba(0,0,0,0.2))'}`, background: monExempt ? 'var(--ink)' : 'transparent', color: 'var(--card)' }}>
            {monExempt && <Check size={13} />}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Exempt from screen-share monitoring</span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
              People in this role clock in without sharing a screen, and no screenshots are captured for them. Everyone else must share a screen to clock in. Use for leadership.
            </span>
          </span>
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />} Save job role</button>
      </div>
    </Modal>
  );
}

// ── group editor (additive groups: name + module bundle, no tier) ─────────────
function GroupEditor({ group, jobRoles = [], onClose, onSaved, onErr }) {
  const [name, setName] = useState(group?.name || '');
  const [bundle, setBundle] = useState(() => Object.fromEntries((group?.allowed_modules || []).map(g => [g.id, g.level])));
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })) };
    try {
      const saved = group ? await api.updateGroup(group.id, body) : await api.createGroup(body);
      onSaved(saved);
    } catch (e) { onErr(e?.message || 'Could not save group.'); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={group ? 'Edit group' : 'New group'} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={fieldLabel}>Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Accounting - Viewer" style={input} /></label>
        <div>
          <div style={{ ...sectLabel, marginTop: 4 }}>Modules this group grants</div>
          <BundleEditor bundle={bundle} setBundle={setBundle} inheritSources={jobRoles || []} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />} Save group</button>
      </div>
    </Modal>
  );
}

// ── assign modal ─────────────────────────────────────────────────────────────
function AssignModal({ role, onClose, onAssigned, onErr }) {
  const { data: dir } = usePeopleDirectory();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  // Everyone already on this role, plus anyone added during this sitting - so the
  // dialog stays open and you can add several people in a row without reopening.
  const [added, setAdded] = useState(() => new Set((role.members || []).map(e => (e || '').toLowerCase())));
  const people = useMemo(() => (dir || []).map(p => ({ email: (p.email || p.workEmail || '').toLowerCase(), name: p.display_name || p.name || p.fullName || p.email || p.workEmail || '' })).filter(p => p.email), [dir]);
  const filtered = people.filter(p => !q.trim() || p.name.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase()));
  const addedThisSitting = [...added].filter(e => !(role.members || []).map(m => (m || '').toLowerCase()).includes(e)).length;

  async function assign(p) {
    if (added.has(p.email) || busy) return;
    setBusy(p.email);
    try { await api.assignJobRole(role.id, p.email); setAdded(s => new Set(s).add(p.email)); onAssigned(p.name || p.email); }
    catch (e) { onErr(e?.message || 'Could not assign.'); }
    setBusy('');
  }

  return (
    <Modal onClose={onClose} title={`Assign to “${role.name}”`}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Sets this as their primary job role and their {ROLES[role.tier]?.label} tier. Extra groups they hold are kept. Pick as many people as you like - this stays open until you close it.</div>
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" style={{ ...input, paddingLeft: 34 }} />
      </div>
      <div style={{ maxHeight: 340, overflow: 'auto' }}>
        {!dir ? <Spinner /> : filtered.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>No matches.</div>
          : filtered.slice(0, 60).map(p => {
            const isAdded = added.has(p.email);
            return (
              <button key={p.email} onClick={() => assign(p)} disabled={!!busy || isAdded}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: isAdded ? 'hsla(var(--color-green),0.07)' : 'var(--card)', width: '100%', textAlign: 'left', marginBottom: 7, cursor: isAdded ? 'default' : 'pointer', opacity: (busy && !isAdded && busy !== p.email) ? 0.6 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.email}</div></div>
                {busy === p.email ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                  : isAdded ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}><Check size={14} /> Added</span>
                  : <ChevronRight size={15} style={{ color: 'var(--muted)' }} />}
              </button>
            );
          })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>{addedThisSitting > 0 ? `Added ${addedThisSitting} ${addedThisSitting === 1 ? 'person' : 'people'} this time.` : ''}</span>
        <button className="primary-btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// ── primitives ───────────────────────────────────────────────────────────────
function Modal({ title, children, onClose, wide }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', zIndex: 1200, padding: 18 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--shadow-lg)', width: `min(${wide ? 560 : 440}px, 100%)`, maxHeight: '86vh', overflow: 'auto', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, flex: 1 }}>{title}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
// Content-area loading: skeleton placeholders (not a bare spinner) so the layout
// stays stable and it reads as "loading this list", the standardized pattern.
const Spinner = () => <div style={{ padding: '8px 4px' }}><SkeletonBlocks count={5} height={54} /></div>;
const Empty = ({ text }) => <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{text}</div>;

const thCorner = { position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--card)', textAlign: 'left', padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderRight: '1px solid var(--line)', borderBottom: '1.5px solid var(--line)', minWidth: 190 };
const thCol = { position: 'sticky', top: 0, zIndex: 2, background: 'var(--card)', padding: '9px 10px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderBottom: '1.5px solid var(--line)', minWidth: 92, textAlign: 'center', verticalAlign: 'bottom' };
const thRow = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)', textAlign: 'left', padding: '10px 14px', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', minWidth: 190 };
const tdCell = { padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--line)' };
const sectLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '20px 0 10px' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' };
const input = { padding: '9px 11px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter,sans-serif', width: '100%' };
