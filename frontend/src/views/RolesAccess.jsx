import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Shield, Plus, X, Search, Pencil, Trash2, UserPlus, Check, ChevronRight, ChevronDown,
  LayoutGrid, Copy, MonitorOff, TimerOff, PlayCircle, Users, User, MailPlus, ChevronLeft,
  Hash, MessageSquare, HelpCircle,
} from 'lucide-react';
import { ExternalBadge, inviteOutcomeToast } from './ExternalUsersPanel';
import AccessTab from '../people/AccessTab';
import AddPersonSheet from '../people/AddPersonSheet';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import HoldButton, { HOLD_MAJOR_MS } from '../ui/HoldButton';
import { usePeopleDirectory } from '../lib/queries';
import { matchPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { SkeletonBlocks, Spinner } from '../components/AsyncState';
import { useRole, MODULES, MODULE_LEVELS, ROLES, grantLevel } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { MODULE_CAPABILITIES, capabilityText, tierText } from '../lib/moduleCapabilities';
import GuidedTour from '../components/GuidedTour';
import { takePendingOpen } from '../lib/pendingOpen';
import { PersonSelect, Modal as SheetModal } from '../tasks/components';
import RoleHiringDocs from '../components/RoleHiringDocs';
import TeamsTargetPicker, { EMPTY_TEAMS_TARGET, teamsTargetLabel } from '../components/TeamsTargetPicker';
import { registerTour } from '../lib/tours';
import PageTrail from '../components/PageTrail';

// ── Roles & Access - people-first restructure (Jul 27) ───────────────────────
// One rule: a person's access = their ONE job role (baseline) + extra groups
// (additive). The screen leads with People (search a person, see and change
// their access, every line says where it came from), Job roles render as
// plain-English cards, and the full matrix lives in a tamed Audit tab with
// module families that expand on demand.
// Owner was retired (11/2026): the API reads a stored 'owner' as Full.
const LEVEL_ORDER = ['viewer', 'editor', 'full'];
// Not offered in a role's bundle: admin screens and the compensation reveal
// (its own toggle). Development left MODULES with the dead grant (11/2026).
const GRANTABLE = MODULES.filter(m => !['admin', 'roles-access', 'hr_comp'].includes(m.id));
const TIERS = Object.keys(ROLES);

// Starter bundle for a brand-new Employee-tier job role - prefills the editor
// so an admin isn't building the everyday baseline from a blank grid. Only
// seeds a NEW role's empty bundle (see RoleEditor); never overwrites an
// existing role's modules just because its tier is Employee.
const EMPLOYEE_DEFAULT_BUNDLE = {
  dashboard: 'editor', timeclock: 'editor', myhr: 'editor', tasks: 'editor', tickets: 'editor',
  documents: 'editor', 'external-links': 'viewer', inventory: 'viewer', support: 'viewer',
  sop: 'viewer',
  // No credvault here (Neil, Oct 14 2026): the Credential Vault opens company
  // passwords, so it is granted on purpose, never seeded onto a new role.
};

// Audit-tab module families - collapse 21 columns into 6 readable ones.
const FAMILIES = [
  // 'manager-dashboard' sits right after 'dashboard' - it's not its own row
  // in the bundle editor any more (see BundleEditor's Dashboard-row scope
  // dropdown), but it still gets its own audit column here for a clean review.
  { id: 'everyday', label: 'Everyday',      modules: ['dashboard', 'manager-dashboard', 'timeclock', 'myhr', 'tasks', 'tickets'] },
  { id: 'company',  label: 'Company',       modules: ['sop', 'hr', 'documents', 'external-links', 'support'] },
  { id: 'money',    label: 'Money',         modules: ['accounting', 'investor-relations'] },
  { id: 'field',    label: 'Field & assets', modules: ['inventory', 'property-asset', 'ops', 'operations'] },
  { id: 'growth',   label: 'Growth',        modules: ['marketing'] },
  { id: 'adminit',  label: 'Admin & IT',    modules: ['it', 'testing', 'credvault', 'admin-console'] },
].map(f => ({ ...f, modules: f.modules.filter(id => GRANTABLE.some(m => m.id === id)) }));

const moduleLabel = id => MODULES.find(m => m.id === id)?.label || id;
// A row's grants as { moduleId: level }; a stored legacy 'owner' reads as Full.
const bundleOf = allowed => Object.fromEntries((allowed || []).map(g => [g.id, grantLevel(g.level)]));
const PEOPLE_PAGE_SIZE = 10;

// Tiny face for chips and rows - falls back to an initial when there's no photo.
export function Avatar({ name, src, size = 20 }) {
  return src
    ? <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    : <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: Math.round(size * 0.42), fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>{(name || '?').trim()[0]?.toUpperCase() || '?'}</span>;
}

// ── shared bits (also reused by the People card Access section) ───────────────
export function LevelPill({ level: raw, title }) {
  if (!raw) return <span style={{ color: 'var(--muted)', opacity: 0.4 }}>-</span>;
  const level = grantLevel(raw);   // an old cached 'owner' row reads as Full
  const label = MODULE_LEVELS[level].label;
  const base = { display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap' };
  const styles = {
    viewer: { ...base, background: 'transparent', color: 'var(--muted)', boxShadow: 'inset 0 0 0 1.5px var(--line-strong,var(--line))' },
    editor: { ...base, background: 'color-mix(in srgb, var(--ink) 12%, transparent)', color: 'var(--ink)' },
    full:   { ...base, background: 'var(--ink)', color: 'var(--card)' },
  };
  return <span style={styles[level]} title={title || MODULE_LEVELS[level].description}>{label}</span>;
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

// "Runs: Accounting · Edits: Documents, Tasks · Views: Dashboard +2" - the
// plain-English one-liner that replaces a row of 20 pills on role cards.
const LEVEL_VERB = { full: 'Runs', editor: 'Edits', viewer: 'Views' };
function bundleSummary(allowed) {
  const byLevel = { full: [], editor: [], viewer: [] };
  (allowed || []).forEach(g => { byLevel[grantLevel(g.level)].push(moduleLabel(g.id)); });
  const parts = [];
  for (const lvl of ['full', 'editor', 'viewer']) {
    const list = byLevel[lvl];
    if (!list.length) continue;
    const shown = list.slice(0, 3).join(', ');
    parts.push(`${LEVEL_VERB[lvl]}: ${shown}${list.length > 3 ? ` +${list.length - 3}` : ''}`);
  }
  return parts.join('  ·  ') || 'No access yet';
}

// ── company roles ────────────────────────────────────────────────────────────
// A job role belongs to one company (company_id = an HrEntity id) or is shared
// across every company (company_id ''). Roles are managed per company in
// Company Settings (CompanyRoles.jsx); this screen stays the global Access view.
// A person may hold a shared role or one of their own company's roles - the
// server refuses another company's. Someone with no company (or an external,
// whose company is a synthetic ext: id) is offered what the server allows.
export function rolesForCompany(roles, companyId) {
  return (roles || []).filter(r => !r.company_id || !companyId || r.company_id === companyId);
}

// <option>s for a job-role <select>, grouped by company so two companies'
// "Site Supervisor" roles can't be mistaken for each other.
export function RoleOptions({ roles, companyName, label = r => r.name }) {
  const byCompany = new Map();
  (roles || []).forEach(r => {
    const k = r.company_id || '';
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(r);
  });
  const keys = [...byCompany.keys()].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : companyName(a).localeCompare(companyName(b)));
  return keys.map(k => (
    <optgroup key={k || 'shared'} label={k ? companyName(k) : 'Shared Across Companies'}>
      {byCompany.get(k).map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}
    </optgroup>
  ));
}

// Externals live INSIDE the People tab (Visesh, Aug 18) - no separate tab.
// Embedded in Settings (Global Settings > Access) the Roles tab becomes
// "Shared Roles": each company's own roles are managed in Company Settings, and
// the roles people at ANY company can hold are org-wide, so they are managed
// here (Pranshu, Sep 27 - they had no create/delete anywhere after the split).
const TABS = [['people', 'People', User], ['jobroles', 'Roles', Shield], ['groups', 'Groups', Users], ['audit', 'Audit', LayoutGrid]];
// The matrix tab reads "Matrix" in Settings (Oct 23) - "Audit" next to the
// Logs tab suggested an audit log, and it is the access matrix.
const EMBEDDED_TABS = [['people', 'People', User], ['groups', 'Groups', Users], ['jobroles', 'Shared Roles', Shield], ['audit', 'Matrix', LayoutGrid]];
// Company Settings' "Manage Shared Roles" link leaves this note so Access opens
// straight on the Shared Roles tab.
export const PENDING_ACCESS_TAB = 'access-tab';

export default function RolesAccess({ embedded = false }) {
  const { can, assignRole, myLevel } = useRole();
  const nameOf = useNameResolver();   // email → real name, never a raw email
  const [sub, setSub] = useState(() => (embedded && takePendingOpen(PENDING_ACCESS_TAB) === 'jobroles' ? 'jobroles' : 'people'));
  const [jobRoles, setJobRoles] = useState(null);
  const [groups, setGroups] = useState(null);
  const { data: dir } = usePeopleDirectory();
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [editGroup, setEditGroup] = useState(undefined);
  const [assignFor, setAssignFor] = useState(null);
  const [selId, setSelId] = useState(null);          // selected job role
  const [roleTab, setRoleTab] = useState('access');  // the selected role's section: 'access' | 'jd'
  const [person, setPerson] = useState(null);        // selected person email
  const [toast, setToast] = useState(null);
  const [tour, setTour] = useState(false);
  useEffect(() => registerTour('roles', 'Roles & Access', () => setTour(true)), []);   // the Help panel's Take the Tour (lib/tours.js)
  // "Open in Matrix" from an editor's Level Guide: the Matrix tab, this module picked and lit.
  const [guideJump, setGuideJump] = useState(null);
  const openGuideInMatrix = id => { setSub('audit'); setGuideJump({ id, n: Date.now() }); };
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
  // Companies by id, for labeling company roles everywhere on this screen.
  const [entities, setEntities] = useState([]);
  useEffect(() => {
    loadRoles(); loadGroups(); loadRoleMap(); loadExternals();
    api.getEntities().then(list => setEntities(list || [])).catch(() => setEntities([]));
  }, []);
  const companyName = id => entities.find(en => en.id === id)?.name || 'Another company';
  const tabs = embedded ? EMBEDDED_TABS : TABS;

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
  // Embedded, the roles tab lists shared roles only (company roles live in
  // Company Settings); a new role made here has no company, so it is shared.
  const listedRoles = useMemo(() => (embedded ? (jobRoles || []).filter(r => !r.company_id) : (jobRoles || [])), [embedded, jobRoles]);
  const rolesByDept = useMemo(() => {
    const g = {};
    listedRoles.forEach(r => { const d = (r.department || '').trim() || 'Other'; (g[d] = g[d] || []).push(r); });
    return Object.entries(g).sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [listedRoles]);

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
          Faces only; the full bundle is one click away.
          Embedded (Shared Roles, Pranshu, Sep 28): a plain count instead - a
          role people at any company can hold shouldn't list identities in a
          browsing list at a glance. Click into a role to see and manage who
          has it. */}
      <div style={{ marginTop: 8, minHeight: 24, display: 'flex', alignItems: 'center' }}>
        {embedded ? (
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>
            {r.member_count ? `${r.member_count} ${r.member_count === 1 ? 'person' : 'people'}` : 'Nobody yet'}
          </span>
        ) : (() => {
          const mem = (r.members || []).filter(inFilter);
          return mem.length ? (
            <span title={`${mem.length} ${mem.length === 1 ? 'person' : 'people'}${filterOn ? ` in this filter (${r.member_count} total)` : ''}: ${mem.map(e => nameOf(e)).join(', ')}`}
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
    return <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>{embedded ? 'Access' : 'Roles & Access'} is available to administrators.</div>;
  }

  async function onDelete(r) {
    if (!await dialog.confirm(`Delete role "${r.name}"?${r.member_count ? ` ${r.member_count} people have it - reassign them first or the delete will fail.` : ''}`, { title: 'Delete role', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteJobRole(r.id); toastOk(`Deleted "${r.name}".`); if (selId === r.id) setSelId(null); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not delete - reassign its people first.'); }
  }
  async function removeMember(email) {
    if (!selected) return;
    // Taking a role away needs the why, like any role change (Neil, Oct 22).
    const reason = await dialog.prompt(`Why is ${nameOf(email)} leaving "${selected.name}"? Kept in their role history.`,
      { title: 'Remove From Role', confirmText: 'Remove', required: true, multiline: true, danger: true });
    if (!reason) return;
    try { await api.unassignJobRole(selected.id, email, reason); toastOk(`Removed ${nameOf(email)} from “${selected.name}”.`); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }
  // Delete group is held on the card (Hold to confirm, Neil, Oct 30 2026):
  // one group, so no dialog; a refusal rewinds the button with the reason and
  // the list re-reads once the check has shown (onDone).
  async function onDeleteGroup(g) {
    try { await api.deleteGroup(g.id); toastOk(`Deleted "${g.name}".`); }
    catch (e) { throw new Error(e?.message || 'Could not delete group.', { cause: e }); }
  }

  const openDuplicate = r => setEditing({ ...r, id: undefined, member_count: 0, members: [],
    name: /\d+$/.test(r.name) ? r.name.replace(/(\d+)$/, m => String(+m + 1)) : `${r.name} 2` });

  // Simulate - the guided walkthrough. Clicks are shielded while it runs, so it
  // can point at the real buttons without any risk of changing live access.
  const allTourSteps = [
    { target: 'tabs', title: 'One rule runs this whole screen',
      body: embedded
        ? 'A person’s access = their job role + any extra groups. Nothing else. People is where you work day to day; Groups add extras; Matrix is the all-at-once view. Job roles are set up per company: pick the company in Applies To.'
        : 'A person’s access = their job role + any extra groups. Nothing else. People is where you work day to day; Job roles and Groups are the building blocks; Audit is the all-at-once view.' },
    { target: 'people-search', before: () => setSub('people'), title: 'Start with a person',
      body: 'Type any name. You’ll see who they are, their job role, their extra groups, and every screen they can touch - with the reason next to each line.' },
    { target: 'person-panel', before: () => { setSub('people'); if (!person && people[0]) setPerson(people[0].email); }, title: 'Change access right here',
      body: 'Switch their job role (baseline follows automatically), or add / remove extra groups. You never edit a person’s permissions directly - everything comes from a role or a group, so it’s always explainable.' },
    { target: 'role-cards', before: () => setSub('jobroles'), title: 'Job roles, in plain English',
      body: 'Each card is one job: “Runs: Accounting · Edits: Documents · Views: …”. Click a card for the full bundle and the people who hold it. Editing a role updates everyone in it at once.' },
    { target: 'duplicate', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'Same job, more power? Duplicate.',
      body: 'For a supervisor version of an existing role: Duplicate, rename it, raise the tier and levels, save. The original role and its people are untouched.' },
    { target: 'role-approver', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'One approver for the whole role',
      body: 'Pick who approves this role’s time sheets. Save as default - every NEW person mapped to the role reports to them automatically. “Apply to all members” backfills everyone already in the role in one click (ten people, two clicks). Individual People cards can still override.' },
    { target: 'new-group', before: () => setSub('groups'), title: 'Groups add extras on top',
      body: 'Same job but extra duties? Don’t touch the role - add the person to a group. Groups only ever ADD access, and removing one never affects the job-role baseline.' },
    { target: 'audit-matrix', before: () => setSub('audit'), title: 'The audit view - everything at once',
      body: 'Columns are grouped into six families - click a family name to expand its screens. Each row is a role; the band underneath is the extra groups. This is the screen for access reviews.' },
    { target: 'tabs', title: 'That’s the whole system',
      body: 'Hire → assign role. Promotion → switch role (Duplicate if it doesn’t exist yet). Extra duties → group. Question about anyone → type their name in People.' },
  ];
  // The role-card steps point at the Roles tab, which isn't here when embedded.
  const ROLE_TAB_TARGETS = ['role-cards', 'duplicate', 'role-approver'];
  const tourSteps = embedded ? allTourSteps.filter(s => !ROLE_TAB_TARGETS.includes(s.target)) : allTourSteps;

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {!embedded && (
        <div className="view-header" style={{ marginBottom: 18 }}>
          <div className="view-title-group">
            <PageTrail title="Roles & Access" />
            <h2>Roles &amp; Access</h2>
            <p>Access = job role + extra groups. Look up a person to see or change theirs.</p>
          </div>
        </div>
      )}

      {/* underline tabs (native) */}
      <div className="scroll-tabs" data-tour="tabs" style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--line)', paddingBottom: 1, alignItems: 'center' }}>
        {tabs.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setSub(key)}
            style={{ background: 'none', border: 'none', padding: '10px 16px', fontFamily: 'Inter,sans-serif', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', color: sub === key ? 'var(--ink)' : 'var(--muted)', position: 'relative', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            <Icon size={16} /> {label}
            {sub === key && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2.5, background: 'var(--ink)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {/* A filter over the people on these tabs, not a scope: People & Access
            is set for every company, so Settings' Applies To cannot narrow it. */}
        {companies.length > 0 && (
          <>
            <label htmlFor="ra-filter-company" style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', margin: '4px 0 8px', whiteSpace: 'nowrap' }}>Filter by Company</label>
            <select id="ra-filter-company" value={co} onChange={e => setCo(e.target.value)} aria-label="Filter every tab by company"
              title="Shows only this company's people on every tab"
              style={{ ...input, width: 'auto', maxWidth: 170, padding: '6px 9px', fontSize: 12.5, margin: '4px 0 8px' }}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={dept} onChange={e => setDept(e.target.value)} aria-label="Filter every tab by department"
              title="Shows only this department's people on every tab" disabled={!deptOptions.length}
              style={{ ...input, width: 'auto', maxWidth: 160, padding: '6px 9px', fontSize: 12.5, margin: '4px 0 8px', opacity: deptOptions.length ? 1 : 0.55 }}>
              <option value="">{deptOptions.length ? 'All Departments' : 'No Departments'}</option>
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
        <PeopleTab people={scopedPeople} membership={membership} entities={entities}
          person={person} setPerson={setPerson} nameOf={nameOf} photoOf={photoOf}
          onChanged={() => { loadRoles(); loadGroups(); }} onExternalsChanged={loadExternals}
          toastOk={toastOk} toastErr={toastErr} />
      )}

      {/* ── JOB ROLES ── */}
      {sub === 'jobroles' && (
        !jobRoles ? <ListSkeleton /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18 }} className="ra-grid">
            <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
              {embedded && (
                <p style={{ margin: 0, flex: 1, minWidth: 240, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  Roles people at any company can hold. Editing one changes it for everyone who has it. A company's own roles show with that company picked in Applies To.
                </p>
              )}
              <button className="primary-btn" data-tour="new-role" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditing(null)}><Plus size={15} /> {embedded ? 'New Shared Role' : 'New Job Role'}</button>
            </div>
            <div data-tour="role-cards" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignSelf: 'start' }}>
              {listedRoles.length === 0 ? <Empty text={embedded ? 'No shared roles yet.' : 'No job roles yet.'} /> : rolesByDept.map(([deptName, deptRoles]) => {
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
                    {selected.time_tracking_exempt && (
                      <span title="People in this role have no time clock and no time sheet."
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: 'rgba(37,99,235,0.1)', color: 'hsl(var(--color-blue))' }}>
                        <TimerOff size={12} /> No Time Tracking</span>
                    )}
                    <TierBadge tier={selected.tier} />
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditing(selected)} title="Edit role"><Pencil size={13} /></button>
                    <button className="secondary-btn" data-tour="duplicate" style={{ padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => openDuplicate(selected)}
                      title="Duplicate this role into a new one (e.g. for a supervisor tier)"><Copy size={13} /> Duplicate</button>
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDelete(selected)} title="Delete role"><Trash2 size={13} /></button>
                  </div>
                  {selected.description && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '8px 0 0', maxWidth: '60ch' }}>{selected.description}</p>}
                  {selected.teams?.id && !selected.bod_exempt && (
                    <div title="Where people in this role post their BOD, EOD and break messages"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, padding: '5px 11px', borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                      {selected.teams.type === 'channel' ? <Hash size={12} /> : <MessageSquare size={12} />} Day messages post to {teamsTargetLabel(selected.teams)}
                    </div>
                  )}
                  {/* One section at a time (Neil, 11/04/2026: "if you keep on scrolling down ... you'll miss it"). */}
                  {embedded && (
                    <div role="tablist" aria-label="Role sections" className="scroll-tabs"
                      style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', margin: '14px 0 0' }}>
                      {[['access', 'Access & People'], ['jd', 'Job Description / Documents']].map(([key, label]) => {
                        const on = roleTab === key;
                        return (
                          <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setRoleTab(key)}
                            style={{ ...roleTabBtn, color: on ? 'var(--wk-brand)' : 'var(--muted)', borderBottom: `2px solid ${on ? 'var(--wk-brand)' : 'transparent'}` }}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {embedded && roleTab === 'jd' ? (
                    <div role="tabpanel">
                      <RoleHiringDocs key={selected.id} role={selected} toastOk={toastOk} toastErr={toastErr}
                        onSaved={saved => setJobRoles(list => (list || []).map(x => (x.id === saved.id ? { ...x, ...saved } : x)))} />
                    </div>
                  ) : (<>
                  {['full', 'editor', 'viewer'].map(lvl => {
                    const mods = (selected.allowed_modules || []).filter(g => grantLevel(g.level) === lvl);
                    if (!mods.length) return null;
                    return (
                      <div key={lvl}>
                        <div style={sectLabel}>{{ full: 'Can run fully', editor: 'Can create and edit', viewer: 'Can view' }[lvl]}</div>
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
                  <div style={sectLabel}>Time Sheet approver (default manager)</div>
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
                  </>)}
                </>
              )}
            </div>
          </div>
        )
      )}

      {/* ── GROUPS ── */}
      {sub === 'groups' && (
        !groups ? <ListSkeleton /> : (
          <>
            <CompanyWallsPanel toastOk={toastOk} toastErr={toastErr} roleMap={roleMap} groups={groups} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="primary-btn" data-tour="new-group" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditGroup(null)}><Plus size={15} /> New group</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {groups.length === 0 ? <Empty text="No extra groups yet. Create one to grant extra access on top of a job role." /> : groups.map(g => (
                <div key={g.id} style={{ background: 'var(--card)', border: '1px dashed var(--line-strong,var(--line))', borderRadius: 14, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>+ {g.name}</span>
                    {g.is_global_admin
                      ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'hsla(230,50%,55%,0.14)', color: 'hsl(230,45%,50%)' }}>Super Administrators</span>
                      : g.company_id
                        ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))' }}>{companies.find(c => c.id === g.company_id)?.name || 'Company role'}</span>
                        : null}
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{(g.members || []).length} {(g.members || []).length === 1 ? 'person' : 'people'}</span>
                    <button className="secondary-btn" style={{ padding: '5px 9px' }} onClick={() => setEditGroup(g)} title="Edit group"><Pencil size={13} /></button>
                    <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete group ${g.name}`} onConfirm={() => onDeleteGroup(g)} onDone={() => loadGroups()}
                      fallbackMessage={`Delete group "${g.name}"?${g.member_count ? ` ${g.member_count} people are in it and will lose that access.` : ''}`} />
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
        <AuditMatrix jobRoles={jobRoles} groups={groups} companyName={companyName} guide={guideJump} />
      )}

      {editing !== undefined && <RoleEditor role={editing} jobRoles={jobRoles} onClose={() => setEditing(undefined)} onOpenGuide={openGuideInMatrix}
        onSaved={r => {
          setEditing(undefined); toastOk(`Saved “${r.name}”.`); setSelId(r.id);
          // Merge the server's response into local state IMMEDIATELY. The refetch
          // takes seconds on a slow link; reopening the editor before it landed
          // showed pre-save data (and re-saving that stale modal wrote the old
          // values back) - which read as "my changes are gone".
          setJobRoles(prev => { const arr = prev || []; return arr.some(x => x.id === r.id) ? arr.map(x => x.id === r.id ? r : x) : [...arr, r]; });
          loadRoles();
        }} onErr={toastErr} />}
      {editGroup !== undefined && <GroupEditor group={editGroup} jobRoles={jobRoles} onClose={() => setEditGroup(undefined)} onOpenGuide={openGuideInMatrix}
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
      <style>{`@media (max-width:900px){.ra-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

// ── PEOPLE tab - search a person, see and change their access ────────────────
// Settings > People & Access > People (Neil, 11/03/2026): the list finds a
// person, and the person opens in a sheet holding people/AccessTab.jsx - the
// SAME access editor as the record's Access tab (job role only through Change
// Role, extra groups, company limits, the tier override for a Super
// Administrator, the external lifecycle). Invite External opens Add Person.
function PeopleTab({ people, membership, entities = [], person, setPerson, nameOf, photoOf = {}, onChanged, onExternalsChanged, toastOk, toastErr }) {
  const [q, setQ] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const rec = useMemo(() => people.find(p => p.email === person) || null, [people, person]);
  const extRec = rec?.external || null;

  // Company/department scoping happens upstream (the universal selector in the
  // tab strip hands this tab already-scoped people); only search lives here.
  const filtered = useMemo(() => matchPeople(people, q), [people, q]);
  // Ten people a page (Pranshu, Sep 26) instead of a long scrolling list. A
  // search starts again at page one; the company/department filters above
  // can also shrink the list, so the page is clamped rather than trusted.
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PEOPLE_PAGE_SIZE));
  const pageIdx = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(pageIdx * PEOPLE_PAGE_SIZE, (pageIdx + 1) * PEOPLE_PAGE_SIZE);
  // Up / Down / Enter over the rows on screen (lib/listNav.js), once typed.
  const peopleNav = useListNav(pageRows, { open: !!q.trim(), query: `${q}|${pageIdx}`, onPick: (p) => setPerson(p.email) });

  const shownName = extRec?.name || rec?.name || (person ? nameOf(person) : '');
  return (
    <div className="ra-people">
      <div data-tour="people-search" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={q} onChange={e => { setQ(e.target.value); setPage(0); }} placeholder="Search anyone…"
            {...peopleNav.inputProps} onKeyDown={peopleNav.onKeyDown}
            style={{ ...input, paddingLeft: 34 }} />
        </div>
        <button className="secondary-btn" onClick={() => setInviteOpen(true)}
          title="Invite a partner-company person as a Microsoft guest - they appear here like anyone else"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
          <MailPlus size={14} /> Invite External User
        </button>
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
        {!people.length ? <ListSkeleton /> : filtered.length === 0 ? <Empty text="No matches." /> : pageRows.map((p, i) => {
          const mem = membership[p.email];
          const active = person === p.email;
          return (
            <button key={p.email} {...peopleNav.optionProps(i)} onClick={() => setPerson(p.email)}
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
        {filtered.length > PEOPLE_PAGE_SIZE && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 6px 2px', marginTop: 4, borderTop: '1px solid var(--line)' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {pageIdx * PEOPLE_PAGE_SIZE + 1}-{Math.min((pageIdx + 1) * PEOPLE_PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <button className="secondary-btn" onClick={() => setPage(pageIdx - 1)} disabled={pageIdx === 0}
                aria-label="Previous page" style={{ padding: '5px 9px', display: 'inline-flex', alignItems: 'center' }}>
                <ChevronLeft size={14} />
              </button>
              <button className="secondary-btn" onClick={() => setPage(pageIdx + 1)} disabled={pageIdx >= pageCount - 1}
                aria-label="Next page" style={{ padding: '5px 9px', display: 'inline-flex', alignItems: 'center' }}>
                <ChevronRight size={14} />
              </button>
            </span>
          </div>
        )}
      </div>

      {person && (
        <SheetModal title={`Access - ${shownName}`} onClose={() => setPerson(null)} zIndex={4000}
          footer={<button className="secondary-btn" onClick={() => setPerson(null)}>Close</button>}>
          <div data-tour="person-panel" style={{ fontFamily: 'Inter,sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Avatar name={shownName} src={photoOf[person]} size={34} />
              <div style={{ fontSize: 16, fontWeight: 800, flex: 1, minWidth: 0 }}>{shownName}</div>
              {extRec && <ExternalBadge />}
            </div>
            <AccessTab key={person} email={person} identityType={extRec ? 'external' : 'internal'}
              companyId={rec?.company || ''} external={extRec} showLifecycle showHistory nameOf={nameOf}
              toastOk={toastOk} toastErr={toastErr} onChanged={onChanged}
              onExternalChanged={() => { onExternalsChanged?.(); onChanged(); }}
              onRemoved={() => { setPerson(null); onExternalsChanged?.(); onChanged(); }} />
          </div>
        </SheetModal>
      )}

      {inviteOpen && (
        <AddPersonSheet initialKind="external" isAdmin canAddExternal entities={entities}
          onClose={() => setInviteOpen(false)} toastOk={toastOk} toastErr={toastErr}
          onSaved={() => onChanged()}
          onExternalSaved={(result) => {
            inviteOutcomeToast(result, toastOk, toastErr);
            onExternalsChanged?.();
            if (result?.email) setPerson(result.email);
          }} />
      )}
    </div>
  );
}

// ── Level Guide - what Viewer / Editor / Full unlock on one module, and what
// still needs a tier. Above the Matrix, and in the editors' "What does this
// unlock?" card. `lit` paints it yellow for a beat after a jump from a row.
export function LevelGuide({ moduleId, onPick, lit = false }) {
  const m = GRANTABLE.find(x => x.id === moduleId) || GRANTABLE[0];
  const tiers = tierText(m.id);
  const note = MODULE_CAPABILITIES[m.id]?.note;
  return (
    <div data-tour="level-guide">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>What Does This Unlock?</span>
        <select value={m.id} onChange={e => onPick(e.target.value)} aria-label="Module"
          style={{ ...input, width: 'auto', padding: '5px 8px', fontSize: 12 }}>
          {GRANTABLE.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', transition: 'background 1.2s, box-shadow 1.2s',
        background: lit ? 'var(--wk-warn-tint, #fff8dc)' : 'var(--card)', boxShadow: lit ? '0 0 0 2px #f5c518' : 'none' }}>
        {LEVEL_ORDER.map(l => (
          <div key={l} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 12, alignItems: 'start', padding: '6px 0', fontSize: 13, lineHeight: 1.45 }}>
            <span><LevelPill level={l} /></span>
            <span>{capabilityText(m.id, l, m.label)}</span>
          </div>
        ))}
        <div style={{ borderTop: '1px solid var(--line)', margin: '8px 0 10px' }} />
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          {tiers.map(t => <div key={t}>{t}</div>)}
          {note && <div style={{ marginTop: 6, fontStyle: 'italic' }}>{note}</div>}
        </div>
      </div>
    </div>
  );
}

// ── AUDIT tab - the matrix, tamed with module families ───────────────────────
function AuditMatrix({ jobRoles, groups, companyName, guide }) {
  const [open, setOpen] = useState(() => new Set());       // expanded family ids
  const [hoverCol, setHoverCol] = useState(null);          // family id or module id
  // The Level Guide above the table: the picked module, lit for ~4 s after a jump.
  const [picked, setPicked] = useState(guide?.id || GRANTABLE[0].id);
  const [lit, setLit] = useState(false);
  const guideRef = useRef(null);
  useEffect(() => {
    if (!guide) return undefined;
    setPicked(guide.id);
    const fam = FAMILIES.find(f => f.modules.includes(guide.id));
    if (fam) setOpen(s => new Set(s).add(fam.id));
    setLit(true);
    guideRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const t = setTimeout(() => setLit(false), 4000);
    return () => clearTimeout(t);
  }, [guide]);

  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!jobRoles || !groups) return <ListSkeleton />;
  if (jobRoles.length === 0) return <Empty text="No job roles yet - create them under Settings > People & Access with the company picked > Roles." />;

  // For a row's grants, the strongest level within a family (dot = mixed levels).
  const familyCell = (byId, fam) => {
    const lvls = fam.modules.map(id => byId[id]).filter(Boolean);
    if (!lvls.length) return { level: null, mixed: false };
    let top = lvls[0];
    for (const l of lvls) if ((MODULE_LEVELS[l]?.rank || 0) > (MODULE_LEVELS[top]?.rank || 0)) top = l;
    return { level: top, mixed: new Set(lvls).size > 1 || lvls.length < fam.modules.length };
  };

  const colHl = key => ({
    transition: 'background 1.2s',
    ...(lit && key === picked ? { background: 'var(--wk-warn-tint, #fff8dc)' }
      : hoverCol === key ? { background: 'color-mix(in srgb, var(--ink) 5%, transparent)' } : {}),
  });

  // Keyed by id: two companies can each have a role with the same name.
  const renderRow = (id, name, meta, byId, extra) => (
    <tr key={id} className="ra-audit-row">
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
      <div ref={guideRef} style={{ marginBottom: 16 }}>
        <LevelGuide moduleId={picked} onPick={setPicked} lit={lit} />
      </div>
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
              r.id, r.name,
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <TierBadge tier={r.tier} />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.member_count} ppl · {r.company_id ? companyName(r.company_id) : 'All companies'}</span>
              </div>,
              bundleOf(r.allowed_modules),
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
              g.id, g.name,
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{(g.members || []).length} {(g.members || []).length === 1 ? 'person' : 'people'}</div>,
              bundleOf(g.allowed_modules),
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
export function ApproverPicker({ role, people, nameOf, onSaved, toastOk, toastErr }) {
  const [val, setVal] = useState(role.default_manager_email || '');
  const [busy, setBusy] = useState('');
  useEffect(() => { setVal(role.default_manager_email || ''); }, [role.id, role.default_manager_email]);
  const pickable = useMemo(() => people.map(p => ({ email: p.email, name: p.name, external: !!p.external })), [people]);

  async function saveDefault(v) {
    setVal(v); setBusy('save');
    try {
      await api.updateJobRole(role.id, { default_manager_email: v });
      toastOk(v ? `Default approver saved - new people mapped to “${role.name}” will report to ${nameOf(v)}.` : 'Default approver cleared.');
      onSaved();
    } catch (e) { toastErr(e?.message || 'Could not save the approver.'); }
    setBusy('');
  }
  // Overwriting every member's manager is a major action: the dialog says
  // what is overwritten and its button is a held one (Hold to confirm, Neil,
  // Oct 30 2026) that waits for the server, staying open with the reason.
  async function applyAll() {
    if (!val) return;
    await dialog.confirm(`Set ${nameOf(val)} as manager/time sheet approver for all ${role.member_count} people in "${role.name}"? This overwrites their current manager; individual cards can be changed afterwards.`, {
      title: 'Set Approver For Whole Role', confirmText: 'Set For All', doneText: 'Set', hold: true, holdMs: HOLD_MAJOR_MS,
      onConfirm: async () => {
        setBusy('apply');
        try {
          const r = await api.applyJobRoleManager(role.id, val);
          toastOk(`${nameOf(val)} is now the approver for ${r.updated} ${r.updated === 1 ? 'person' : 'people'} in “${role.name}”.`);
          onSaved();
        } catch (e) { throw new Error(e?.message || 'Could not apply to members.', { cause: e }); }
        finally { setBusy(''); }
      },
    });
  }

  return (
    <div data-tour="role-approver">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 210 }}>
          <PersonSelect value={val || null} onChange={v => { if ((v || '') !== (val || '')) saveDefault(v || ''); }} disabled={busy === 'save'} people={pickable}
            placeholder="No Default Approver" noneLabel="No Default Approver" ariaLabel="Default approver"
            style={{ ...input, padding: '7px 10px', fontSize: 12.5, fontWeight: 400 }} />
        </div>
        <button className="secondary-btn" disabled={!val || !!busy || !role.member_count} onClick={applyAll}
          style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy === 'apply' && <Spinner size={13} />}
          Apply to all {role.member_count} {role.member_count === 1 ? 'member' : 'members'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5, maxWidth: '60ch' }}>
        Who approves this role's time sheets and punch fixes. New people mapped to the role inherit them automatically (if they don't already have a manager); Apply to all backfills everyone currently in it. A person's own card always wins.
      </div>
    </div>
  );
}

// ── bundle editor (shared by RoleEditor + GroupEditor) ───────────────────────
// One-click granting: each row is four level pills - clicking a pill grants the
// screen at that level (no separate checkbox step), clicking the active pill
// removes it. Bulk actions cover "everything except two screens" in four
// clicks: Check All -> set all checked to Full -> click off the two.
// Manager Dashboard is no longer its own row here (Aug 31) - it's now a tab
// inside Dashboard (Dashboard.jsx), so it's granted as a SCOPE on the
// Dashboard row instead of a disconnected line item an admin has to go
// hunting for. The underlying grant is still the plain 'manager-dashboard'
// module id in the bundle - nothing downstream (Dashboard.jsx's canManager
// check, the audit matrix, backend) needed to change for this.
const DASHBOARD_SCOPES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'manager',   label: 'Manager Dashboard' },
  { id: 'both',      label: 'Both' },
];
function dashboardScopeOf(bundle) {
  return bundle.dashboard && bundle['manager-dashboard'] ? 'both'
    : bundle['manager-dashboard'] ? 'manager' : 'dashboard';
}

function BundleEditor({ bundle, setBundle, inheritSources = [], listMaxHeight = 300, onOpenInMatrix }) {
  const [bulk, setBulk] = useState('');
  const [guideFor, setGuideFor] = useState(null);   // module id whose Level Guide card is open
  const [inheritFrom, setInheritFrom] = useState('');
  const grant = (id, level) => setBundle(b => {
    const n = { ...b };
    if (n[id] === level) delete n[id]; else n[id] = level;
    return n;
  });
  // Dashboard row: the level pills apply to whichever module id(s) the scope
  // dropdown currently targets, instead of always just 'dashboard'.
  const grantDashboard = (level) => setBundle(b => {
    const n = { ...b };
    const scope = dashboardScopeOf(n);
    const targets = scope === 'both' ? ['dashboard', 'manager-dashboard'] : scope === 'manager' ? ['manager-dashboard'] : ['dashboard'];
    const isActive = targets.every(id => n[id] === level);
    targets.forEach(id => { if (isActive) delete n[id]; else n[id] = level; });
    return n;
  });
  const setDashboardScope = (scope) => setBundle(b => {
    const n = { ...b };
    const level = n.dashboard || n['manager-dashboard'] || 'viewer';
    delete n.dashboard; delete n['manager-dashboard'];
    if (scope === 'dashboard' || scope === 'both') n.dashboard = level;
    if (scope === 'manager' || scope === 'both') n['manager-dashboard'] = level;
    return n;
  });
  // 'manager-dashboard' isn't rendered as its own row (folded into the
  // Dashboard row's scope dropdown above), so it's excluded from the visible
  // rows, the Check All bulk action, and the "N of M screens granted" count -
  // otherwise Check All would silently hand out Manager Dashboard to
  // everyone, which is exactly the accidental-over-grant this UI exists to
  // prevent.
  const visibleIds = GRANTABLE.filter(m => m.id !== 'manager-dashboard').map(m => m.id);
  const checkedCount = visibleIds.filter(id => bundle[id] || (id === 'dashboard' && bundle['manager-dashboard'])).length;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 8px' }}>
        <button type="button" className="secondary-btn" style={{ padding: '5px 10px', fontSize: 12 }}
          onClick={() => setBundle(b => {
            // Preserve an existing Manager Dashboard scope choice (it's not a
            // visible row, so it must be carried over explicitly or Check All
            // would silently drop it).
            const n = Object.fromEntries(visibleIds.map(id => [id, b[id] || 'viewer']));
            if (b['manager-dashboard']) n['manager-dashboard'] = b['manager-dashboard'];
            return n;
          })}>Check All</button>
        <button type="button" className="secondary-btn" style={{ padding: '5px 10px', fontSize: 12 }}
          onClick={() => setBundle({})}>Clear All</button>
        {inheritSources.length > 0 && (
          <select value={inheritFrom} aria-label="Inherit this bundle from an existing role"
            title="Start from another role's bundle, then tweak - replaces the current selection"
            onChange={e => {
              const src = inheritSources.find(r => r.id === e.target.value);
              setInheritFrom('');
              if (src) setBundle(bundleOf(src.allowed_modules));
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
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: listMaxHeight, overflow: 'auto' }}>
        {GRANTABLE.filter(m => m.id !== 'manager-dashboard').map(m => {
          const isDashboard = m.id === 'dashboard';
          const on = isDashboard ? (bundle.dashboard || bundle['manager-dashboard']) : bundle[m.id];
          const scope = isDashboard ? dashboardScopeOf(bundle) : null;
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--line)',
              background: on ? 'color-mix(in srgb, var(--ink) 5%, transparent)' : 'transparent' }}>
              <span aria-hidden style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: on ? 'var(--ink)' : 'transparent', color: 'var(--card)',
                border: on ? 'none' : '1.5px solid var(--line-strong,var(--line))' }}>
                {on && <Check size={12} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: on ? 700 : 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{m.label}</span>
                  <button type="button" onClick={() => setGuideFor(m.id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, color: 'var(--muted)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                    <HelpCircle size={12} /> What does this unlock?
                  </button>
                </div>
                {on && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>{capabilityText(m.id, on, m.label)}</div>}
                {on && tierText(m.id).length > 1 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>Still needs a tier: {tierText(m.id).slice(0, -1).join('; ')}</div>
                )}
              </div>
              {isDashboard && on && (
                <select value={scope} onChange={e => setDashboardScope(e.target.value)}
                  aria-label="Which dashboard screens this grants"
                  title="Manager Dashboard is a tab inside Dashboard now - choose whether this grant includes it"
                  style={{ ...input, width: 'auto', padding: '4px 8px', fontSize: 11.5, flexShrink: 0 }}>
                  {DASHBOARD_SCOPES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              )}
              {/* The selected level wears an "x" on its top-right corner (Neil,
                  10/06): one obvious click takes the screen away again. */}
              <div style={{ display: 'inline-flex', gap: 6, flexShrink: 0, paddingTop: 4 }} role="group" aria-label={`${m.label} level`}>
                {LEVEL_ORDER.map(l => {
                  const active = on === l;
                  const pick = () => isDashboard ? grantDashboard(l) : grant(m.id, l);
                  return (
                    <span key={l} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button type="button" onClick={pick} aria-pressed={active}
                        title={active ? `${m.label}: ${MODULE_LEVELS[l].label}` : capabilityText(m.id, l, m.label)}
                        style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter,sans-serif',
                          border: `1.5px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
                          background: active ? 'var(--ink)' : 'transparent',
                          color: active ? 'var(--card)' : 'var(--muted)', transition: 'background .12s, color .12s, border-color .12s' }}>
                        {MODULE_LEVELS[l].label}
                      </button>
                      {active && (
                        <button type="button" className="ra-chip-x" onClick={pick}
                          aria-label={`Remove ${m.label} access`} title={`Remove ${m.label}`}
                          style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', padding: 0,
                            display: 'grid', placeItems: 'center', cursor: 'pointer', lineHeight: 0,
                            background: 'var(--card)', color: 'var(--ink)', border: '1.5px solid var(--ink)',
                            boxShadow: '0 1px 3px rgba(17,24,39,0.18)' }}>
                          <X size={9} strokeWidth={3} />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7 }}>
        One click grants a screen at that level; the x on the selected level removes it. {checkedCount} of {visibleIds.length} screens granted.
      </div>
      {/* The Level Guide as a card over the editor, so the draft stays put;
          Open in Matrix closes the editor (asking about a dirty draft first). */}
      {guideFor && (
        <Modal title="Level Guide" onClose={() => setGuideFor(null)}>
          <LevelGuide moduleId={guideFor} onPick={setGuideFor} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            {onOpenInMatrix && <button type="button" className="secondary-btn" onClick={() => { const id = guideFor; setGuideFor(null); onOpenInMatrix(id); }}>Open in Matrix</button>}
            <button type="button" className="primary-btn" onClick={() => setGuideFor(null)}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── editor modal ─────────────────────────────────────────────────────────────
// `companyId` places a NEW role in that company (Company Settings > Roles);
// `departments` offers that company's departments instead of the ones other
// roles happen to use. An existing role's company is never changed from here.
// "Open in Matrix" from an editor's Level Guide closes the editor the usual way
// (a dirty draft still asks Save / Discard / Keep Editing) and jumps once it is
// gone. Gives the Modal its closeRef and wraps the editor's close / saved.
function useGuideJump(onClose, onSaved, onOpenGuide) {
  const closeRef = useRef(null);
  const afterClose = useRef(null);
  const thenJump = fn => (...a) => { fn(...a); afterClose.current?.(); afterClose.current = null; };
  return {
    closeRef, close: thenJump(onClose), finish: thenJump(onSaved),
    openInMatrix: onOpenGuide && (id => { afterClose.current = () => onOpenGuide(id); closeRef.current?.(); }),
  };
}

export function RoleEditor({ role, jobRoles = [], companyId = '', departments, onClose, onSaved, onErr, onOpenGuide }) {
  const { closeRef, close, finish, openInMatrix } = useGuideJump(onClose, onSaved, onOpenGuide);
  const [name, setName] = useState(role?.name || '');
  const [tier, setTier] = useState(role?.tier || 'employee');
  const [dept, setDept] = useState(role?.department || '');
  const [desc, setDesc] = useState(role?.description || '');
  const [bundle, setBundle] = useState(() => {
    const initial = bundleOf(role?.allowed_modules);
    // New role, still on the default Employee tier, nothing picked yet - seed
    // the everyday baseline instead of opening on a blank grid.
    if (!role?.id && !Object.keys(initial).length && (role?.tier || 'employee') === 'employee') {
      return { ...EMPLOYEE_DEFAULT_BUNDLE };
    }
    return initial;
  });
  const [monExempt, setMonExempt] = useState(!!role?.monitoring_exempt);
  const [bodExempt, setBodExempt] = useState(!!role?.bod_exempt);
  const [ttExempt, setTtExempt] = useState(!!role?.time_tracking_exempt);
  // Where this role's BOD / EOD / break messages post in Teams (Neil, 10/07).
  const [teams, setTeams] = useState(() => ({ ...EMPTY_TEAMS_TARGET, ...(role?.teams || {}) }));
  const [busy, setBusy] = useState(false);
  const deptOptions = departments || [...new Set((jobRoles || []).map(r => r.department).filter(Boolean))].sort();
  const initialBundle = useMemo(() => bundleOf(role?.allowed_modules), [role]);
  const dirty = name !== (role?.name || '') || tier !== (role?.tier || 'employee') || dept !== (role?.department || '')
    || desc !== (role?.description || '') || monExempt !== !!role?.monitoring_exempt
    || bodExempt !== !!role?.bod_exempt
    || ttExempt !== !!role?.time_tracking_exempt
    || (teams.id || '') !== (role?.teams?.id || '')
    || JSON.stringify(bundle) !== JSON.stringify(initialBundle);

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), tier, department: dept.trim(), description: desc.trim(), monitoring_exempt: monExempt, bod_exempt: bodExempt, time_tracking_exempt: ttExempt, allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })),
      teams: { type: teams.type, id: teams.id || '', name: teams.name || '', teamId: teams.teamId || '', teamName: teams.teamName || '' } };
    try {
      // A seed object with no id (from Duplicate) creates a new role rather than editing the original.
      const saved = role?.id ? await api.updateJobRole(role.id, body)
        : await api.createJobRole({ ...body, company_id: companyId || role?.company_id || '' });
      finish(saved);
    } catch (e) { onErr(e?.message || 'Could not save job role.'); setBusy(false); }
  }

  return (
    <Modal onClose={close} closeRef={closeRef} title={role?.id ? 'Edit Job Role' : 'New Job Role'} size="xl" isDirty={dirty} onSave={name.trim() ? save : undefined}>
      {/* Two columns on a wide screen (Neil, 10/06: "make the screen larger"):
          who the role is on the left, what it opens on the right with room to
          show every module at once. Wraps to one column on a narrow screen. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 300px', maxWidth: 420, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={fieldLabel}>Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Supervisor" style={input} /></label>
        <label style={fieldLabel}>Seniority tier
          <select value={tier} onChange={e => {
            const next = e.target.value;
            setTier(next);
            // Picking Employee always resets the bundle to the everyday
            // baseline - whatever was checked (including a manual "Check All")
            // is replaced, so switching to Employee reliably means "the
            // Employee defaults," not "whatever this role happened to have."
            if (next === 'employee') setBundle({ ...EMPLOYEE_DEFAULT_BUNDLE });
          }} style={input}>
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
        <div style={{ ...sectLabel, marginTop: 4, marginBottom: 0 }}>Time Clock</div>
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
        <button type="button" onClick={() => setBodExempt(v => !v)}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 11, textAlign: 'left', width: '100%', padding: '11px 13px',
            border: `1.5px solid ${bodExempt ? 'var(--ink)' : 'var(--line)'}`, borderRadius: 10,
            background: bodExempt ? 'var(--mist)' : 'transparent', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, display: 'grid', placeItems: 'center',
            border: `1.5px solid ${bodExempt ? 'var(--ink)' : 'var(--line-strong,rgba(0,0,0,0.2))'}`, background: bodExempt ? 'var(--ink)' : 'transparent', color: 'var(--card)' }}>
            {bodExempt && <Check size={13} />}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Skip day and break messages</span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
              People in this role are never asked for the beginning/end-of-day or break messages - punches go straight through. Use for field workers who cannot type these out.
            </span>
          </span>
        </button>
        <button type="button" aria-pressed={ttExempt} onClick={() => setTtExempt(v => !v)}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 11, textAlign: 'left', width: '100%', padding: '11px 13px',
            border: `1.5px solid ${ttExempt ? 'var(--ink)' : 'var(--line)'}`, borderRadius: 10,
            background: ttExempt ? 'var(--mist)' : 'transparent', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, display: 'grid', placeItems: 'center',
            border: `1.5px solid ${ttExempt ? 'var(--ink)' : 'var(--line-strong,rgba(0,0,0,0.2))'}`, background: ttExempt ? 'var(--ink)' : 'transparent', color: 'var(--card)' }}>
            {ttExempt && <Check size={13} />}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Exempt from time tracking</span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
              People in this role have no time clock and no time sheet. Use for salaried leadership who are not tracked.
            </span>
          </span>
        </button>
        {/* The role decides where its people's day messages go (Neil, 10/07:
            "it isn't even based on the person, it's based on a role") - set
            once here, and everyone given the role posts there from day one. */}
        <div style={{ ...sectLabel, marginTop: 10, marginBottom: 0 }}>Teams Messages</div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 3 }}>Where BOD, EOD and break messages post</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45, marginBottom: 10 }}>
            {bodExempt
              ? 'People in this role skip these messages (see above), so nothing posts.'
              : 'Everyone given this role posts here, ahead of any shift group setting. Leave empty to keep using the shift group.'}
          </div>
          {!bodExempt && <TeamsTargetPicker value={teams} onChange={setTeams} toastErr={onErr} audience="People in this role" />}
        </div>
      </div>
      <div style={{ flex: '2 1 480px', minWidth: 0 }}>
        <div style={{ ...sectLabel, marginTop: 0 }}>Module Bundle</div>
        <BundleEditor bundle={bundle} setBundle={setBundle} listMaxHeight="max(320px, calc(94vh - 260px))" onOpenInMatrix={openInMatrix}
          inheritSources={(jobRoles || []).filter(r => r.id !== role?.id)} />
      </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <button className="secondary-btn" onClick={close}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{busy && <Spinner size={14} />} Save Job Role</button>
      </div>
    </Modal>
  );
}

// ── group editor (additive groups: name + module bundle, no tier) ─────────────
// ── Company walls: the master arm switch (multi-company isolation) ────────────
// Tiers (Neil, 11/02/2026): only a Super Administrator (level 5) sets the
// walls, so the switch shows for them alone. An Administrator is confined to
// their companies whether the walls are on or off - the switch only changes
// Managers and below. Super Administrators = the owner tier PLUS members of a
// group flagged is_global_admin, counted once each.
function superAdminCount(roleMap = {}, groups = []) {
  const set = new Set();
  Object.entries(roleMap || {}).forEach(([em, r]) => { if (r?.role === 'owner') set.add(em.toLowerCase()); });
  (groups || []).filter(g => g.is_global_admin).forEach(g => (g.members || []).forEach(em => set.add(String(em).toLowerCase())));
  return set.size;
}

function CompanyWallsPanel({ toastOk, toastErr, roleMap, groups }) {
  const { myLevel } = useRole();
  const [state, setState] = useState(null);   // {on, globalAdminGroups, globalAdmins}
  const [busy, setBusy] = useState(false);
  const load = () => api.getCompanyWalls().then(setState).catch(() => setState(null));
  useEffect(() => { load(); }, []);
  if (state === null) return null;   // hidden for non-admins / when unavailable
  const canSet = (myLevel || 0) >= 5;
  const supers = superAdminCount(roleMap, groups);
  async function toggle() {
    const on = !state.on;
    const msg = on
      ? 'Turn the company walls ON? Every company becomes private for Managers and below - people, tasks and tickets only show within their own company. Administrators are confined to their companies either way; only Super Administrators see across.'
      : 'Turn the company walls OFF? Managers and below go back to seeing across all companies. Administrators stay confined to their own companies.';
    if (!await dialog.confirm(msg, { title: on ? 'Arm company walls' : 'Disarm company walls', confirmText: on ? 'Arm walls' : 'Disarm' })) return;
    setBusy(true);
    try { await api.setCompanyWalls(on); toastOk(on ? 'Company walls armed.' : 'Company walls disarmed.'); load(); }
    catch (e) { toastErr(e?.message || 'Could not change the walls.'); }
    setBusy(false);
  }
  return (
    <div style={{ border: `1px solid ${state.on ? 'hsl(var(--color-green))' : 'var(--line)'}`, background: state.on ? 'hsla(var(--color-green),0.05)' : 'var(--card)', borderRadius: 14, padding: '14px 18px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ fontWeight: 800, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={15} /> Company walls
          {state.on ? <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--color-green))' }}>ON</span>
            : <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>OFF</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {state.on ? 'Each company is private - Managers and below only see their own company.'
            : 'Off - Managers and below see across all companies.'}
          {' Administrators always stay inside their own companies.'}
          {` · ${supers} super administrator${supers === 1 ? '' : 's'}`}
          {!canSet && ' · only a Super Administrator changes the walls'}
        </div>
      </div>
      {canSet && (
        <button className={state.on ? 'secondary-btn' : 'primary-btn'} disabled={busy} onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy && <Spinner size={14} />}
          {state.on ? 'Disarm' : 'Arm walls'}
        </button>
      )}
    </div>
  );
}


function GroupEditor({ group, jobRoles = [], onClose, onSaved, onErr, onOpenGuide }) {
  const { closeRef, close, finish, openInMatrix } = useGuideJump(onClose, onSaved, onOpenGuide);
  const { myLevel } = useRole();
  const canFlag = (myLevel || 0) >= 5;   // only a Super Administrator flags a group (Tiers, Neil 11/02/2026)
  const [name, setName] = useState(group?.name || '');
  const [bundle, setBundle] = useState(() => bundleOf(group?.allowed_modules));
  const [companyId, setCompanyId] = useState(group?.company_id || '');
  const [globalAdmin, setGlobalAdmin] = useState(!!group?.is_global_admin);
  const [companies, setCompanies] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getEntities().then(list => setCompanies(list || [])).catch(() => setCompanies([])); }, []);
  const initialBundle = useMemo(() => bundleOf(group?.allowed_modules), [group]);
  const dirty = name !== (group?.name || '') || JSON.stringify(bundle) !== JSON.stringify(initialBundle)
    || companyId !== (group?.company_id || '') || globalAdmin !== !!group?.is_global_admin;

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })),
      company_id: globalAdmin ? '' : companyId, ...(canFlag ? { is_global_admin: globalAdmin } : {}) };
    try {
      const saved = group ? await api.updateGroup(group.id, body) : await api.createGroup(body);
      finish(saved);
    } catch (e) { onErr(e?.message || 'Could not save group.'); setBusy(false); }
  }

  return (
    <Modal onClose={close} closeRef={closeRef} title={group ? 'Edit group' : 'New group'} wide isDirty={dirty} onSave={name.trim() ? save : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={fieldLabel}>Name
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Accounting - Viewer" style={input} /></label>
        {/* Multi-company walls: bind this group to a company (a per-company role) or
            mark it the Super Administrators group (members see past every company wall). */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ ...fieldLabel, flex: 1, minWidth: 220, opacity: globalAdmin ? 0.5 : 1 }}>Company (per-company role)
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} disabled={globalAdmin} style={input}>
              <option value="">Org-wide (no company)</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          {canFlag && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, padding: '9px 0' }}>
              <input type="checkbox" checked={globalAdmin} onChange={e => setGlobalAdmin(e.target.checked)} />
              Super Administrators (sees every company)
            </label>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: -6 }}>
          {globalAdmin ? 'Members are unrestricted across all companies - the only role that sees past the walls.'
            : companyId ? 'Members are confined to this company once the walls are armed.'
            : 'Org-wide group - members are placed by their own company (or the Super Administrators group).'}
        </div>
        <div>
          <div style={{ ...sectLabel, marginTop: 4 }}>Modules this group grants</div>
          <BundleEditor bundle={bundle} setBundle={setBundle} inheritSources={jobRoles || []} onOpenInMatrix={openInMatrix} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="secondary-btn" onClick={close}>Cancel</button>
        <button className="primary-btn" disabled={busy} onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{busy && <Spinner size={14} />} Save group</button>
      </div>
    </Modal>
  );
}

// ── assign modal ─────────────────────────────────────────────────────────────
// A company role lists only that company's people, then anyone with no company
// set (the server allows them, and says so). Other companies' people aren't
// offered - the server would refuse them.
export function AssignModal({ role, onClose, onAssigned, onErr }) {
  const { data: dir } = usePeopleDirectory();
  const { canAccessModule, hrTeam } = useRole();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [warning, setWarning] = useState('');
  const roleCompany = role.company_id || '';
  // Someone who already holds ANOTHER job role is a role change (Neil, Oct 22):
  // HR, Administrators and Super Administrators only (the server's can_change_roles), with
  // one required reason for everyone picked. People with no role go straight on.
  const canSwap = !hrTeam && typeof canAccessModule === 'function' && canAccessModule('hr', 'administrator', 'editor');
  const [heldRole, setHeldRole] = useState({});   // email -> the other role they hold now
  const [swaps, setSwaps] = useState([]);         // picked people who hold another role
  const [reason, setReason] = useState('');
  useEffect(() => {
    api.getJobRoles().then(rs => {
      const m = {};
      (rs || []).forEach(r => { if (r.id !== role.id) (r.members || []).forEach(em => { m[(em || '').toLowerCase()] = r.name; }); });
      setHeldRole(m);
    }).catch(() => {});
  }, [role.id]);
  // Everyone already on this role, plus anyone added during this sitting - so the
  // dialog stays open and you can add several people in a row without reopening.
  const [added, setAdded] = useState(() => new Set((role.members || []).map(e => (e || '').toLowerCase())));
  const people = useMemo(() => {
    const all = (dir || []).map(p => ({ email: (p.email || p.workEmail || '').toLowerCase(), name: p.display_name || p.name || p.fullName || p.email || p.workEmail || '', company: p.company || '' })).filter(p => p.email);
    if (!roleCompany) return all;
    return [...all.filter(p => p.company === roleCompany), ...all.filter(p => !p.company)];
  }, [dir, roleCompany]);
  const filtered = matchPeople(people, q);
  const listed = filtered.slice(0, 60);
  const nav = useListNav(listed, { open: !!q.trim(), query: q, onPick: (p) => pick(p) });
  const addedThisSitting = [...added].filter(e => !(role.members || []).map(m => (m || '').toLowerCase()).includes(e)).length;

  async function send(p, why) {
    try {
      const res = await api.assignJobRole(role.id, p.email, why);
      setAdded(s => new Set(s).add(p.email)); setWarning(res?.warning || ''); onAssigned(p.name || p.email);
      return true;
    }
    catch (e) { onErr(e?.message || 'Could not assign.'); return false; }
  }
  async function pick(p) {
    if (added.has(p.email) || busy) return;
    if (heldRole[p.email]) {
      if (canSwap) setSwaps(s => s.some(x => x.email === p.email) ? s.filter(x => x.email !== p.email) : [...s, p]);
      return;
    }
    setBusy(p.email);
    await send(p);
    setBusy('');
  }
  async function assignSwaps() {
    if (!reason.trim() || busy) return;
    setBusy('swaps');
    const left = [];
    for (const p of swaps) if (!await send(p, reason.trim())) left.push(p);
    setSwaps(left);
    if (!left.length) setReason('');
    setBusy('');
  }

  return (
    <Modal onClose={onClose} title={`Assign to “${role.name}”`}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Sets this as their primary job role and their {ROLES[role.tier]?.label} tier. Extra groups they hold are kept. Pick as many people as you like - this stays open until you close it. Someone who already holds another role is a role change: pick them, write the reason, then click Assign.{roleCompany ? ' Only people at this role’s company are listed, plus anyone with no company set.' : ''}</div>
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…"
          {...nav.inputProps} onKeyDown={nav.onKeyDown}
          style={{ ...input, paddingLeft: 34 }} />
      </div>
      <div style={{ maxHeight: 340, overflow: 'auto' }}>
        {!dir ? <ListSkeleton /> : filtered.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>No matches.</div>
          : listed.map((p, i) => {
            const isAdded = added.has(p.email);
            const held = !isAdded && heldRole[p.email];
            const picked = swaps.some(x => x.email === p.email);
            return (
              <button key={p.email} {...nav.optionProps(i)} onClick={() => pick(p)} disabled={!!busy || isAdded || (held && !canSwap)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: isAdded ? 'hsla(var(--color-green),0.07)' : 'var(--card)', width: '100%', textAlign: 'left', marginBottom: 7, cursor: isAdded ? 'default' : 'pointer', opacity: (busy && !isAdded && busy !== p.email) ? 0.6 : 1 }}>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.email}{roleCompany && !p.company ? ' · No company set' : ''}</div>
                  {held && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Holds {held}{canSwap ? '' : ' - only HR, an Administrator or a Super Administrator can change their role'}</div>}</div>
                {busy === p.email ? <Spinner size={15} />
                  : picked ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--pine)' }}><Check size={14} /> Picked</span>
                  : isAdded ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-green))' }}><Check size={14} /> Added</span>
                  : <ChevronRight size={15} style={{ color: 'var(--muted)' }} />}
              </button>
            );
          })}
      </div>
      {swaps.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label htmlFor="assign-reason" style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>Reason For The Change *</label>
          <textarea id="assign-reason" className="form-input" rows={2} value={reason} onChange={e => setReason(e.target.value)}
            placeholder={`Why ${swaps.length === 1 ? swaps[0].name : `these ${swaps.length} people`} move to ${role.name}`}
            style={{ ...input, resize: 'vertical', fontFamily: 'Inter,sans-serif' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>Shown on their Role History. {swaps.length === 1 ? 'They already hold' : 'Each already holds'} another role - it changes now.</span>
            <button className="primary-btn" onClick={assignSwaps} disabled={!!busy || !reason.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'swaps' ? <Spinner size={14} /> : null} Assign {swaps.length}
            </button>
          </div>
        </div>
      )}
      {warning && (
        <div role="status" style={{ marginTop: 10, background: 'hsla(38,92%,50%,0.1)', border: '1px solid hsla(38,92%,50%,0.35)', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, color: 'var(--ink)' }}>{warning}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>{addedThisSitting > 0 ? `Added ${addedThisSitting} ${addedThisSitting === 1 ? 'person' : 'people'} this time.` : ''}</span>
        <button className="primary-btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// ── primitives ───────────────────────────────────────────────────────────────
// `isDirty` + `onSave`: closing via the backdrop, Escape, or the X button used
// to discard an in-progress edit with no warning - with isDirty set, those
// three confirm first. A form's own Cancel button still discards straight
// away, since that's a deliberate choice.
// Every size but xl is .nx-popup: 60% of the screen (CLAUDE.md popup rule).
// size="xl" (the job-role editor again, Neil, 10/06: "make the screen larger"):
// nearly the whole screen, details beside a tall module list.
// `closeRef` hands the caller requestClose (the Level Guide's Open in Matrix
// closes the editor the usual way); the top-most open Modal alone takes Escape.
const modalStack = [];
function Modal({ title, children, onClose, size, isDirty = false, onSave, closeRef }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [me] = useState(() => ({}));   // this Modal's token on modalStack
  const requestClose = () => { if (isDirty) setConfirming(true); else onClose(); };
  useEffect(() => { if (closeRef) closeRef.current = requestClose; });
  useEffect(() => { modalStack.push(me); return () => { modalStack.splice(modalStack.indexOf(me), 1); }; }, [me]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && modalStack[modalStack.length - 1] === me) requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isDirty, me]);
  const saveAndClose = async () => {
    if (!onSave) { setConfirming(false); onClose(); return; }
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); setConfirming(false); }
  };
  return (
    <div onClick={requestClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', zIndex: 1200, padding: 18 }}>
      <div onClick={e => e.stopPropagation()} className={size === 'xl' ? undefined : 'nx-popup'} style={{
        background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, boxShadow: 'var(--shadow-lg)',
        ...(size === 'xl' ? { width: 'min(1240px, 100%)', maxHeight: '94vh' } : null),
        overflow: 'auto', padding: size === 'xl' ? 24 : 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, fontWeight: 800, flex: 1 }}>{title}</h3>
          <button onClick={requestClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        {children}
      </div>
      {confirming && (
        <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', inset: 0, zIndex: 1300, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.25)' }}>
          <div className="nx-popup" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: 'var(--shadow-lg)', padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button className="secondary-btn" onClick={() => setConfirming(false)}>Keep Editing</button>
              <button className="secondary-btn" onClick={onClose}>Discard</button>
              {onSave && (
                <button className="primary-btn" onClick={saveAndClose} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// Content-area loading: skeleton placeholders (not a bare spinner) so the layout
// stays stable and it reads as "loading this list", the standardized pattern.
const ListSkeleton = () => <div style={{ padding: '8px 4px' }}><SkeletonBlocks count={5} height={54} /></div>;
const Empty = ({ text }) => <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{text}</div>;

const thCorner = { position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--card)', textAlign: 'left', padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderRight: '1px solid var(--line)', borderBottom: '1.5px solid var(--line)', minWidth: 190 };
const thCol = { position: 'sticky', top: 0, zIndex: 2, background: 'var(--card)', padding: '9px 10px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderBottom: '1.5px solid var(--line)', minWidth: 92, textAlign: 'center', verticalAlign: 'bottom' };
const thRow = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)', textAlign: 'left', padding: '10px 14px', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', minWidth: 190 };
const tdCell = { padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--line)' };
const roleTabBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', whiteSpace: 'nowrap', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, marginBottom: -1 };
const sectLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '20px 0 10px' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' };
const input = { padding: '9px 11px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter,sans-serif', width: '100%' };
