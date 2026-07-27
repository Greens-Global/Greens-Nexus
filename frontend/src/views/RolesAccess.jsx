import { useState, useEffect, useMemo } from 'react';
import {
  Shield, Plus, X, Search, Loader2, Pencil, Trash2, UserPlus, Check, ChevronRight, LayoutGrid, Copy, MonitorOff, PlayCircle,
} from 'lucide-react';
import { api } from '../api';
import { useRole, MODULES, MODULE_LEVELS, ROLES } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { capabilityText } from '../lib/moduleCapabilities';
import GuidedTour from '../components/GuidedTour';

// ── Roles & Access — access is defined by Job Roles (a template = tier + module
// bundle, driven by job description) plus additive Groups on top. This screen
// manages the templates and the reference matrix; a person is assigned their
// role on their People card. Admin-only.
const LEVEL_ORDER = ['viewer', 'editor', 'full', 'owner'];
const GRANTABLE = MODULES.filter(m => !['admin', 'roles-access', 'hr_comp'].includes(m.id));
const TIERS = Object.keys(ROLES);

// ── shared bits (also reused by the People card Access section) ───────────────
export function LevelPill({ level, title }) {
  if (!level) return <span style={{ color: 'var(--muted)', opacity: 0.4 }}>—</span>;
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

// A level pill that also names the module it's for — so a row of grants reads
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

const TABS = [['matrix', 'Matrix', LayoutGrid], ['jobroles', 'Job roles', Shield], ['groups', 'Groups', UserPlus]];

export default function RolesAccess({ embedded = false }) {
  const { can } = useRole();
  const nameOf = useNameResolver();   // email → real name, never a raw email
  const [sub, setSub] = useState('matrix');
  const [jobRoles, setJobRoles] = useState(null);
  const [groups, setGroups] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [editGroup, setEditGroup] = useState(undefined);
  const [assignFor, setAssignFor] = useState(null);
  const [selId, setSelId] = useState(null);
  const [openGroup, setOpenGroup] = useState(null); // group id whose member list is expanded
  const [toast, setToast] = useState(null);
  const [tour, setTour] = useState(false);          // Simulate walkthrough open?

  const toastOk = m => { setToast({ m, kind: 'ok' }); setTimeout(() => setToast(null), 3500); };
  const toastErr = m => { setToast({ m, kind: 'error' }); setTimeout(() => setToast(null), 5000); };

  const loadRoles = () => api.getJobRoles().then(setJobRoles).catch(() => setJobRoles([]));
  const loadGroups = () => api.getGroups().then(gs => setGroups(gs.filter(g => !g.is_job_role))).catch(() => setGroups([]));
  useEffect(() => { loadRoles(); loadGroups(); }, []);

  const selected = (jobRoles || []).find(r => r.id === selId) || null;

  if (!can('administrator')) {
    return <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--muted)' }}>Roles & Access is available to administrators.</div>;
  }

  async function onDelete(r) {
    try { await api.deleteJobRole(r.id); toastOk(`Deleted “${r.name}”.`); if (selId === r.id) setSelId(null); loadRoles(); }
    catch (e) { toastErr(e?.message || 'Could not delete — reassign its people first.'); }
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
  async function removeGroupMember(g, email) {
    try { await api.removeGroupMember(g.id, email); toastOk(`Removed ${nameOf(email)} from “${g.name}”.`); loadGroups(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }

  // Simulate — the guided walkthrough. Clicks are shielded while it runs, so it
  // can point at the real buttons without any risk of changing live access.
  const tourSteps = [
    { target: 'tabs', title: 'One rule runs this whole screen',
      body: 'A person’s access = their job role + any extra groups. Nothing else. These three tabs are the whole system: the Matrix (see everything), Job roles (the baselines), and Groups (the extras).' },
    { target: 'matrix', before: () => setSub('matrix'), title: 'The matrix — the whole company at a glance',
      body: 'Each row is a job role, each column is a screen, and the pill says how much that role can do there. An empty dash means no access. Hover any pill for a plain-English description of what it allows.' },
    { target: 'person-check', before: () => setSub('matrix'), title: 'Check any person',
      body: 'Not sure what someone can actually do? Type their name here. You’ll get their full access list, and every line says where it came from — their job role or a specific group.' },
    { target: 'new-role', before: () => setSub('jobroles'), title: 'Job roles live here',
      body: 'A job role is a job title plus its access bundle. When someone is hired or changes jobs, you assign the role and all its access follows automatically. Click here to create one from scratch.' },
    { target: 'role-list', before: () => setSub('jobroles'), title: 'Pick a role to see inside it',
      body: 'Select any role to see its access bundle and the people who hold it. Editing the bundle updates everyone in the role at once — that’s the point.' },
    { target: 'duplicate', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'Same job, more power? Duplicate.',
      body: 'For a supervisor version of an existing role: press Duplicate, rename it (“Site Supervisor”), raise the tier and the module levels, save. The original role and its people are untouched.' },
    { target: 'assign', before: () => { setSub('jobroles'); if (!selId && (jobRoles || [])[0]) setSelId(jobRoles[0].id); }, title: 'Map people to the role',
      body: 'This assigns the role as someone’s primary job role — their baseline access and seniority tier come with it. You can also do this from the person’s card in People.' },
    { target: 'new-group', before: () => setSub('groups'), title: 'Groups — extra access on top',
      body: 'Same job but extra duties? Don’t touch their role — add them to a group. Groups only ever ADD access on top of the role, and removing someone from a group never affects their job-role baseline.' },
    { target: 'tabs', title: 'That’s the whole system',
      body: 'Access = job role + groups. Hire → assign role. Promotion → switch role (Duplicate if the role doesn’t exist yet). Extra duties → group. And when in doubt, check the person in the Matrix tab.' },
  ];

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {!embedded && (
        <div className="view-header" style={{ marginBottom: 18 }}>
          <div className="view-title-group">
            <h2>Roles &amp; Access</h2>
            <p>Job roles drive who can do what — assign them on each person's card. This is where the roles behind it live.</p>
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
        <button onClick={() => setTour(true)} title="A guided walkthrough of how to give out access — nothing is changed while it runs."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px solid var(--line)', borderRadius: 999, padding: '6px 14px', margin: '4px 4px 8px 0', fontFamily: 'Inter,sans-serif', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
          <PlayCircle size={15} /> Simulate
        </button>
      </div>

      {/* ── MATRIX ── */}
      {sub === 'matrix' && (
        <>
          <PersonAccessCheck nameOf={nameOf} />
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', margin: '18px 0 12px', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontWeight: 700 }}>Access level:</span>
            {LEVEL_ORDER.map(l => (
              <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={MODULE_LEVELS[l]?.description || ''}><LevelPill level={l} /></span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LevelPill level={null} /> No access</span>
            <span style={{ fontStyle: 'italic' }}>Hover any pill to see what it lets someone do.</span>
          </div>
          {!jobRoles ? <Spinner /> : jobRoles.length === 0 ? <Empty text="No job roles yet — create one in the Job roles tab." />
            : (
              <div data-tour="matrix" style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'auto', maxHeight: '72vh', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: 'max-content', minWidth: '100%' }}>
                  <thead>
                    <tr>
                      <th style={thCorner}>Job role</th>
                      {GRANTABLE.map(m => <th key={m.id} style={thCol} title={m.label}>{m.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {jobRoles.map(r => {
                      const byId = Object.fromEntries((r.allowed_modules || []).map(g => [g.id, g.level]));
                      return (
                        <tr key={r.id}>
                          <th style={thRow}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{r.name}</div>
                            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 7 }}><TierBadge tier={r.tier} /><span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.member_count} ppl</span></div>
                          </th>
                          {GRANTABLE.map(m => <td key={m.id} style={tdCell}><LevelPill level={byId[m.id]} title={byId[m.id] ? `${m.label} · ${MODULE_LEVELS[byId[m.id]]?.label}\n${capabilityText(m.id, byId[m.id], m.label)}` : ''} /></td>)}
                        </tr>
                      );
                    })}
                    {(groups || []).length > 0 && (
                      <>
                        <tr>
                          <th style={{ ...thRow, borderTop: '2px solid var(--line)', paddingTop: 14 }} >
                            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>Extra access groups</div>
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontWeight: 400 }}>Added on top of a job role</div>
                          </th>
                          {GRANTABLE.map(m => <td key={m.id} style={{ ...tdCell, borderTop: '2px solid var(--line)' }} />)}
                        </tr>
                        {groups.map(g => {
                          const byId = Object.fromEntries((g.allowed_modules || []).map(x => [x.id, x.level]));
                          return (
                            <tr key={g.id}>
                              <th style={thRow}>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>{g.name}</div>
                                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{(g.members || []).length} {(g.members || []).length === 1 ? 'person' : 'people'}</div>
                              </th>
                              {GRANTABLE.map(m => <td key={m.id} style={tdCell}><LevelPill level={byId[m.id]} title={byId[m.id] ? `${m.label} · ${MODULE_LEVELS[byId[m.id]]?.label}\n${capabilityText(m.id, byId[m.id], m.label)}` : ''} /></td>)}
                            </tr>
                          );
                        })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            )}
        </>
      )}

      {/* ── JOB ROLES ── */}
      {sub === 'jobroles' && (
        !jobRoles ? <Spinner /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 18 }} className="ra-grid">
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="primary-btn" data-tour="new-role" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditing(null)}><Plus size={15} /> New job role</button>
            </div>
            <div data-tour="role-list" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6, alignSelf: 'start' }}>
              {jobRoles.length === 0 ? <Empty text="No job roles yet." /> : jobRoles.map(r => (
                <button key={r.id} onClick={() => setSelId(r.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px', borderRadius: 10, border: 'none', width: '100%', textAlign: 'left', background: selId === r.id ? 'color-mix(in srgb, var(--ink) 8%, transparent)' : 'none', cursor: 'pointer' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{r.name}</div>
                    <div style={{ marginTop: 3 }}><TierBadge tier={r.tier} /></div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{(r.allowed_modules || []).length} mods · {r.member_count} ppl</span>
                </button>
              ))}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
              {!selected ? <div style={{ color: 'var(--muted)', padding: '40px 10px', textAlign: 'center', fontSize: 13.5 }}>Select a job role to view its bundle, or create a new one.</div> : (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ flex: 1 }}><h3 style={{ fontSize: 18, fontWeight: 800 }}>{selected.name}</h3></div>
                    {selected.monitoring_exempt && (
                      <span title="People in this role clock in without sharing a screen; no screenshots are captured."
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                          background: 'rgba(37,99,235,0.1)', color: 'hsl(var(--color-blue))' }}>
                        <MonitorOff size={12} /> Not monitored</span>
                    )}
                    <TierBadge tier={selected.tier} />
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditing(selected)} title="Edit role"><Pencil size={13} /></button>
                    <button className="secondary-btn" data-tour="duplicate" style={{ padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      onClick={() => setEditing({ ...selected, id: undefined, member_count: 0, members: [],
                        name: /\d+$/.test(selected.name) ? selected.name.replace(/(\d+)$/, m => String(+m + 1)) : `${selected.name} 2` })}
                      title="Duplicate this role into a new one (e.g. for a supervisor tier)"><Copy size={13} /> Duplicate</button>
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDelete(selected)} title="Delete role"><Trash2 size={13} /></button>
                  </div>
                  {selected.description && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '8px 0 0', maxWidth: '60ch' }}>{selected.description}</p>}
                  <div style={sectLabel}>Module bundle · {(selected.allowed_modules || []).length} screens</div>
                  <div>
                    {(selected.allowed_modules || []).length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>No modules granted.</div>
                      : (selected.allowed_modules || []).map(g => {
                        const mod = MODULES.find(m => m.id === g.id);
                        return <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                          <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{mod?.label || g.id}</span><LevelPill level={g.level} />
                        </div>;
                      })}
                  </div>
                  <div style={sectLabel}>People with this role · {selected.member_count}</div>
                  {(selected.members || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {selected.members.map(em => (
                        <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', borderRadius: 20, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
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
                    Editing the bundle applies to all {selected.member_count} people who hold this role. Access levels layer additively with any extra groups.
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
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
              {groups.length === 0 ? <Empty text="No additive groups yet. Create one to grant extra access on top of a job role." /> : groups.map(g => {
                const members = g.members || [];
                const open = openGroup === g.id;
                return (
                  <div key={g.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{g.name}</div>
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {(g.allowed_modules || []).map(m => <ModuleLevelPill key={m.id} moduleId={m.id} level={m.level} />)}
                          {(g.allowed_modules || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No modules</span>}
                        </div>
                      </div>
                      <button onClick={() => setOpenGroup(open ? null : g.id)} disabled={members.length === 0}
                        title={members.length ? (open ? 'Hide members' : 'Show members') : 'No members yet'}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: '4px 2px', cursor: members.length ? 'pointer' : 'default', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {members.length > 0 && <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />}
                        {members.length} {members.length === 1 ? 'member' : 'members'}
                      </button>
                      <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditGroup(g)} title="Edit group"><Pencil size={13} /></button>
                      <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDeleteGroup(g)} title="Delete group"><Trash2 size={13} /></button>
                    </div>
                    {open && members.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 12px 14px' }}>
                        {members.map(em => (
                          <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', borderRadius: 20, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600 }}>
                            {nameOf(em)}
                            <button onClick={() => removeGroupMember(g, em)} title="Remove from this group" aria-label={`Remove ${nameOf(em)}`}
                              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 }}
                              onMouseOver={e => { e.currentTarget.style.background = 'hsla(var(--color-red),0.14)'; e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                              onMouseOut={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--muted)'; }}>
                              <X size={13} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ padding: '12px', fontSize: 12, color: 'var(--muted)' }}>Groups are the additive layer — they only ever add access on top of a job role. Add people to a group from their card's Access tab.</div>
            </div>
          </>
        )
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
      <style>{`@media (max-width:820px){.ra-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

// ── person lookup — "what can this person do, and why?" ──────────────────────
// Lives on the Matrix tab. Backed by /jobroles/effective/{email}: every line of
// access carries its source, so the answer is always explainable.
function PersonAccessCheck({ nameOf }) {
  const [dir, setDir] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);   // email
  const [eff, setEff] = useState(null);         // effective-access payload
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getPeopleDirectory().then(setDir).catch(() => setDir([])); }, []);
  const people = useMemo(() => (dir || [])
    .map(p => ({ email: (p.email || p.workEmail || '').toLowerCase(), name: p.display_name || p.name || p.fullName || p.email || '' }))
    .filter(p => p.email), [dir]);
  const matches = q.trim()
    ? people.filter(p => p.name.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase())).slice(0, 8)
    : [];

  async function pick(p) {
    setQ(p.name); setOpen(false); setPicked(p.email); setBusy(true); setEff(null);
    try { setEff(await api.getEffectiveAccess(p.email)); }
    catch { setEff({ error: true }); }
    setBusy(false);
  }

  return (
    <div data-tour="person-check" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>Check a person's access</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>See exactly what someone can do, and where each permission comes from.</div>
      <div style={{ position: 'relative', maxWidth: 420 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); setPicked(null); setEff(null); }}
          placeholder="Type a name…" style={{ ...input, paddingLeft: 34 }} />
        {open && matches.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, marginTop: 4, boxShadow: 'var(--shadow-lg)', overflow: 'hidden' }}>
            {matches.map(p => (
              <button key={p.email} onClick={() => pick(p)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}
                onMouseOver={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--ink) 6%, transparent)'; }}
                onMouseOut={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>{p.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {busy && <Spinner />}
      {picked && eff && !busy && (
        eff.error ? <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12 }}>Could not load access for this person.</div> : (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{nameOf(eff.email)}</span>
              {eff.job_role
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 11px', borderRadius: 999, background: 'var(--ink)', color: 'var(--card)', fontSize: 11.5, fontWeight: 700 }}><Shield size={12} /> {eff.job_role.name}</span>
                : <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>No job role yet — assign one on their People card.</span>}
              {(eff.extra_groups || []).map(g => (
                <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 11px', borderRadius: 999, border: '1px dashed var(--line-strong,var(--line))', fontSize: 11.5, fontWeight: 600, color: 'var(--ink)' }}>+ {g.name}</span>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              {(eff.modules || []).length === 0
                ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No module access.</div>
                : eff.modules.map(m => {
                  const mod = MODULES.find(x => x.id === m.module);
                  return (
                    <div key={m.module} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 150 }}>{mod?.label || m.module}</span>
                      <LevelPill level={m.level} title={capabilityText(m.module, m.level, mod?.label)} />
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {m.manual ? <>extra, from group “{m.source}”</> : <>from job role “{m.source}”</>}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        )
      )}
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
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Accounting — Viewer" style={input} /></label>
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
  // Everyone already on this role, plus anyone added during this sitting — so the
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
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Sets this as their primary job role and their {ROLES[role.tier]?.label} tier. Extra groups they hold are kept. Pick as many people as you like — this stays open until you close it.</div>
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
const thCol = { position: 'sticky', top: 0, zIndex: 2, background: 'var(--card)', padding: '11px 10px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', borderBottom: '1.5px solid var(--line)', minWidth: 92, textAlign: 'center', verticalAlign: 'bottom' };
const thRow = { position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)', textAlign: 'left', padding: '10px 14px', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', minWidth: 190 };
const tdCell = { padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--line)' };
const sectLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '20px 0 10px' };
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' };
const input = { padding: '9px 11px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, fontFamily: 'Inter,sans-serif', width: '100%' };
