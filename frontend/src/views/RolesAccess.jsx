import { useState, useEffect, useMemo } from 'react';
import {
  Shield, Plus, X, Search, Loader2, Pencil, Trash2, UserPlus, Check, ChevronRight, ChevronDown,
  LayoutGrid, Copy, MonitorOff, PlayCircle, Users, User,
} from 'lucide-react';
import { api } from '../api';
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
  { id: 'everyday', label: 'Everyday',      modules: ['dashboard', 'timeclock', 'myhr', 'tasks'] },
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

const TABS = [['people', 'People', User], ['jobroles', 'Job roles', Shield], ['groups', 'Groups', Users], ['audit', 'Audit', LayoutGrid]];

export default function RolesAccess({ embedded = false }) {
  const { can } = useRole();
  const nameOf = useNameResolver();   // email → real name, never a raw email
  const [sub, setSub] = useState('people');
  const [jobRoles, setJobRoles] = useState(null);
  const [groups, setGroups] = useState(null);
  const [dir, setDir] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [editGroup, setEditGroup] = useState(undefined);
  const [assignFor, setAssignFor] = useState(null);
  const [selId, setSelId] = useState(null);          // selected job role
  const [person, setPerson] = useState(null);        // selected person email
  const [toast, setToast] = useState(null);
  const [tour, setTour] = useState(false);

  const toastOk = m => { setToast({ m, kind: 'ok' }); setTimeout(() => setToast(null), 3500); };
  const toastErr = m => { setToast({ m, kind: 'error' }); setTimeout(() => setToast(null), 5000); };

  const loadRoles = () => api.getJobRoles().then(setJobRoles).catch(() => setJobRoles([]));
  const loadGroups = () => api.getGroups().then(gs => setGroups(gs.filter(g => !g.is_job_role))).catch(() => setGroups([]));
  useEffect(() => {
    loadRoles(); loadGroups();
    api.getPeopleDirectory().then(setDir).catch(() => setDir([]));
  }, []);

  const people = useMemo(() => (dir || [])
    .map(p => ({
      email: (p.email || p.workEmail || '').toLowerCase(),
      name: p.display_name || p.name || p.fullName || p.email || p.workEmail || '',
      title: p.job_title || p.jobTitle || p.title || '',
      company: p.company || '',
      companyName: p.companyName || '',
      dept: p.department || '',
      photo: p.photoUrl || p.photo_url || '',
    }))
    .filter(p => p.email)
    .sort((a, b) => a.name.localeCompare(b.name)), [dir]);

  // email → photo, for the member chips (role + group members arrive as emails).
  const photoOf = useMemo(() => Object.fromEntries(people.map(p => [p.email, p.photo])), [people]);

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

  if (!can('administrator')) {
    return <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>Roles & Access is available to administrators.</div>;
  }

  async function onDelete(r) {
    try { await api.deleteJobRole(r.id); toastOk(`Deleted “${r.name}”.`); if (selId === r.id) setSelId(null); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not delete - reassign its people first.'); }
  }
  async function removeMember(email) {
    if (!selected) return;
    try { await api.unassignJobRole(selected.id, email); toastOk(`Removed ${nameOf(email)} from “${selected.name}”.`); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }
  async function onDeleteGroup(g) {
    try { await api.deleteGroup(g.id); toastOk(`Deleted “${g.name}”.`); loadGroups(); }
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
        <button onClick={() => setTour(true)} title="A guided walkthrough of how to give out access - nothing is changed while it runs."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 14px', margin: '4px 4px 8px 0', fontFamily: 'Inter,sans-serif', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
          <PlayCircle size={15} /> Simulate
        </button>
      </div>

      {/* ── PEOPLE (default) ── */}
      {sub === 'people' && (
        <PeopleTab people={people} membership={membership} jobRoles={jobRoles} groups={groups}
          person={person} setPerson={setPerson} nameOf={nameOf} photoOf={photoOf}
          onChanged={() => { loadRoles(); loadGroups(); }} toastOk={toastOk} toastErr={toastErr} />
      )}

      {/* ── JOB ROLES ── */}
      {sub === 'jobroles' && (
        !jobRoles ? <Spinner /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 18 }} className="ra-grid">
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary-btn" data-tour="new-role" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditing(null)}><Plus size={15} /> New job role</button>
            </div>
            <div data-tour="role-cards" style={{ display: 'flex', flexDirection: 'column', gap: 10, alignSelf: 'start' }}>
              {jobRoles.length === 0 ? <Empty text="No job roles yet." /> : jobRoles.map(r => (
                <button key={r.id} onClick={() => setSelId(r.id)}
                  style={{ textAlign: 'left', background: 'var(--card)', border: `1.5px solid ${selId === r.id ? 'var(--ink)' : 'var(--line)'}`, borderRadius: 14, padding: '13px 15px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', boxShadow: selId === r.id ? 'var(--shadow-sm)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>{r.name}</span>
                    <TierBadge tier={r.tier} />
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{r.member_count} {r.member_count === 1 ? 'person' : 'people'}</span>
                  </div>
                  <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>{bundleSummary(r.allowed_modules)}</div>
                </button>
              ))}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, alignSelf: 'start' }}>
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
                  <div style={sectLabel}>People with this role · {selected.member_count}</div>
                  {(selected.members || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {selected.members.map(em => (
                        <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 6px 4px 5px', borderRadius: 20, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                          <Avatar name={nameOf(em)} src={photoOf[em]} size={22} />
                          {nameOf(em)}
                          <button onClick={() => removeMember(em)} title="Remove from this role" aria-label={`Remove ${nameOf(em)}`}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 }}
                            onMouseOver={e => { e.currentTarget.style.background = 'hsla(var(--color-red),0.14)'; e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                            onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                            <X size={13} />
                          </button>
                        </span>
                      ))}
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
                  {(g.members || []).length > 0 && (
                    <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(g.members || []).slice(0, 6).map(em => (
                        <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 4px', borderRadius: 20, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 600 }}>
                          <Avatar name={nameOf(em)} src={photoOf[em]} size={18} />{nameOf(em)}
                        </span>
                      ))}
                      {(g.members || []).length > 6 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>+{(g.members || []).length - 6} more</span>}
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

      {editing !== undefined && <RoleEditor role={editing} onClose={() => setEditing(undefined)}
        onSaved={r => { setEditing(undefined); toastOk(`Saved “${r.name}”.`); setSelId(r.id); loadRoles(); }} onErr={toastErr} />}
      {editGroup !== undefined && <GroupEditor group={editGroup} onClose={() => setEditGroup(undefined)}
        onSaved={g => { setEditGroup(undefined); toastOk(`Saved “${g.name}”.`); loadGroups(); }} onErr={toastErr} />}
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
function PeopleTab({ people, membership, jobRoles, groups, person, setPerson, nameOf, photoOf = {}, onChanged, toastOk, toastErr }) {
  const [q, setQ] = useState('');
  const [co, setCo] = useState('');       // company (entity id) filter
  const [dept, setDept] = useState('');   // department (name) filter
  const [eff, setEff] = useState(null);
  const [busy, setBusy] = useState(false);

  // Companies present in the directory - the filter only offers real choices.
  const companies = useMemo(() => {
    const seen = new Map();
    people.forEach(p => { if (p.company && !seen.has(p.company)) seen.set(p.company, p.companyName || p.company); });
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [people]);

  // Departments cascade from the company: pick a company and only ITS
  // departments appear (a company without Estimating never shows Estimating).
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

  // A department picked under one company may not exist under the next.
  useEffect(() => {
    if (dept && !deptOptions.some(d => d.toLowerCase() === dept.toLowerCase())) setDept('');
  }, [deptOptions, dept]);

  const filtered = useMemo(() => people.filter(p =>
    (!co || p.company === co)
    && (!dept || p.dept.trim().toLowerCase() === dept.toLowerCase())
    && (!q.trim() || p.name.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase()))), [people, q, co, dept]);

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
    if (!window.confirm(`Change ${nameOf(person)}'s job role to “${r.name}”? Their baseline access and tier will follow the new role.`)) return;
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
    if (!window.confirm(`Remove ${nameOf(person)} from “${g.name}”? They lose that extra access; their job-role baseline is untouched.`)) return;
    try { await api.removeGroupMember(g.id, person); toastOk(`Removed ${nameOf(person)} from “${g.name}”.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }

  const memberGroupIds = new Set((eff?.extra_groups || []).map(g => g.id));
  const addableGroups = (groups || []).filter(g => !memberGroupIds.has(g.id));

  return (
    <div className="ra-people" style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 18 }}>
      {/* left: search + people list */}
      <div style={{ alignSelf: 'start' }}>
        {companies.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <select value={co} onChange={e => setCo(e.target.value)} aria-label="Filter by company"
              style={{ ...input, flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12.5 }}>
              <option value="">All companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={dept} onChange={e => setDept(e.target.value)} aria-label="Filter by department"
              disabled={!deptOptions.length}
              style={{ ...input, flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12.5, opacity: deptOptions.length ? 1 : 0.55 }}>
              <option value="">{deptOptions.length ? 'All departments' : 'No departments'}</option>
              {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
        <div data-tour="people-search" style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search anyone…" style={{ ...input, paddingLeft: 34 }} />
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
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</div>
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
      <div data-tour="person-panel" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 20, alignSelf: 'start', minHeight: 220 }}>
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
              <Avatar name={nameOf(eff.email)} src={photoOf[eff.email]} size={34} />
              <h3 style={{ fontSize: 17, fontWeight: 800, flex: 1, minWidth: 140 }}>{nameOf(eff.email)}</h3>
              <TierBadge tier={eff.tier} />
            </div>

            <div style={sectLabel}>Job role - the baseline</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {eff.job_role
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 13px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontSize: 12.5, fontWeight: 700 }}><Shield size={13} /> {eff.job_role.name}</span>
                : <span style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>No job role yet</span>}
              <select value="" onChange={e => e.target.value && changeRole(e.target.value)} style={{ ...input, width: 'auto', padding: '6px 10px', fontSize: 12.5 }}>
                <option value="">{eff.job_role ? 'Change role…' : 'Assign a role…'}</option>
                {(jobRoles || []).filter(r => r.id !== eff.job_role?.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>

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
    if (!window.confirm(`Set ${nameOf(val)} as manager/timesheet approver for all ${role.member_count} people in “${role.name}”? This overwrites their current manager; individual cards can be changed afterwards.`)) return;
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

// ── editor modal ─────────────────────────────────────────────────────────────
function RoleEditor({ role, onClose, onSaved, onErr }) {
  const [name, setName] = useState(role?.name || '');
  const [tier, setTier] = useState(role?.tier || 'employee');
  const [desc, setDesc] = useState(role?.description || '');
  const [bundle, setBundle] = useState(() => Object.fromEntries((role?.allowed_modules || []).map(g => [g.id, g.level])));
  const [monExempt, setMonExempt] = useState(!!role?.monitoring_exempt);
  const [busy, setBusy] = useState(false);

  const toggle = id => setBundle(b => { const n = { ...b }; if (n[id]) delete n[id]; else n[id] = 'viewer'; return n; });
  const setLvl = (id, level) => setBundle(b => ({ ...b, [id]: level }));

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), tier, description: desc.trim(), monitoring_exempt: monExempt, allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })) };
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
        <label style={fieldLabel}>Description
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Plain-language: what this role does" style={{ ...input, resize: 'vertical' }} /></label>
        <div>
          <div style={{ ...sectLabel, marginTop: 4 }}>Module bundle</div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 300, overflow: 'auto' }}>
            {GRANTABLE.map(m => {
              const on = bundle[m.id];
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--line)' }}>
                  <button onClick={() => toggle(m.id)} style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${on ? 'var(--ink)' : 'var(--line-strong,rgba(0,0,0,0.2))'}`, background: on ? 'var(--ink)' : 'transparent', color: 'var(--card)', cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}>{on && <Check size={13} />}</button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: on ? 600 : 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{m.label}</div>
                    {on && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{capabilityText(m.id, bundle[m.id], m.label)}</div>}
                  </div>
                  {on && (
                    <select value={bundle[m.id]} onChange={e => setLvl(m.id, e.target.value)} title={capabilityText(m.id, bundle[m.id], m.label)} style={{ ...input, padding: '5px 8px', fontSize: 12, width: 'auto', flexShrink: 0 }}>
                      {LEVEL_ORDER.map(l => <option key={l} value={l}>{MODULE_LEVELS[l].label}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
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
function GroupEditor({ group, onClose, onSaved, onErr }) {
  const [name, setName] = useState(group?.name || '');
  const [bundle, setBundle] = useState(() => Object.fromEntries((group?.allowed_modules || []).map(g => [g.id, g.level])));
  const [busy, setBusy] = useState(false);
  const toggle = id => setBundle(b => { const n = { ...b }; if (n[id]) delete n[id]; else n[id] = 'viewer'; return n; });
  const setLvl = (id, level) => setBundle(b => ({ ...b, [id]: level }));

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
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 300, overflow: 'auto' }}>
            {GRANTABLE.map(m => {
              const on = bundle[m.id];
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--line)' }}>
                  <button onClick={() => toggle(m.id)} style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${on ? 'var(--ink)' : 'var(--line-strong,rgba(0,0,0,0.2))'}`, background: on ? 'var(--ink)' : 'transparent', color: 'var(--card)', cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1 }}>{on && <Check size={13} />}</button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: on ? 600 : 500, color: on ? 'var(--ink)' : 'var(--muted)' }}>{m.label}</div>
                    {on && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{capabilityText(m.id, bundle[m.id], m.label)}</div>}
                  </div>
                  {on && (
                    <select value={bundle[m.id]} onChange={e => setLvl(m.id, e.target.value)} title={capabilityText(m.id, bundle[m.id], m.label)} style={{ ...input, padding: '5px 8px', fontSize: 12, width: 'auto', flexShrink: 0 }}>
                      {LEVEL_ORDER.map(l => <option key={l} value={l}>{MODULE_LEVELS[l].label}</option>)}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
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
  const [dir, setDir] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  // Everyone already on this role, plus anyone added during this sitting - so the
  // dialog stays open and you can add several people in a row without reopening.
  const [added, setAdded] = useState(() => new Set((role.members || []).map(e => (e || '').toLowerCase())));
  useEffect(() => { api.getPeopleDirectory().then(setDir).catch(() => setDir([])); }, []);

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
const Spinner = () => <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>;
const Empty = ({ text }) => <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{text}</div>;

const thCorner = { position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--card)', textAlign: 'left', padding: '11px 14px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderRight: '1px solid var(--line)', borderBottom: '1.5px solid var(--line)', minWidth: 190 };
const thCol = { position: 'sticky', top: 0, zIndex: 2, background: 'var(--card)', padding: '9px 10px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderBottom: '1.5px solid var(--line)', minWidth: 92, textAlign: 'center', verticalAlign: 'bottom' };
const thRow = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)', textAlign: 'left', padding: '10px 14px', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', minWidth: 190 };
const tdCell = { padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--line)' };
const sectLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '20px 0 10px' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' };
const input = { padding: '9px 11px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter,sans-serif', width: '100%' };
