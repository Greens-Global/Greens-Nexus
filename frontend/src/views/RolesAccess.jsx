import { useState, useEffect, useMemo } from 'react';
import {
  Shield, Plus, X, Search, Loader2, Pencil, Trash2, UserPlus, Check, ChevronRight, LayoutGrid,
} from 'lucide-react';
import { api } from '../api';
import { useRole, MODULES, MODULE_LEVELS, ROLES } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { capabilityText } from '../lib/moduleCapabilities';

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
  const [toast, setToast] = useState(null);

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
      <div className="scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--line)', paddingBottom: 1 }}>
        {TABS.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setSub(key)}
            style={{ background: 'none', border: 'none', padding: '10px 16px', fontFamily: 'Inter,sans-serif', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', color: sub === key ? 'var(--ink)' : 'var(--muted)', position: 'relative', display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            <Icon size={16} /> {label}
            {sub === key && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2.5, background: 'var(--ink)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      {/* ── MATRIX ── */}
      {sub === 'matrix' && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontWeight: 700 }}>Access level:</span>
            {LEVEL_ORDER.map(l => <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LevelPill level={l} /></span>)}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><LevelPill level={null} /> No access</span>
          </div>
          {!jobRoles ? <Spinner /> : jobRoles.length === 0 ? <Empty text="No job roles yet — create one in the Job roles tab." />
            : (
              <div style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'auto', maxHeight: '72vh', background: 'var(--card)', boxShadow: 'var(--shadow-sm)' }}>
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
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditing(null)}><Plus size={15} /> New job role</button>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6, alignSelf: 'start' }}>
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
                    <TierBadge tier={selected.tier} />
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditing(selected)}><Pencil size={13} /></button>
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDelete(selected)}><Trash2 size={13} /></button>
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
                  <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setAssignFor(selected)}>
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
              <button className="primary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setEditGroup(null)}><Plus size={15} /> New group</button>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 6 }}>
              {groups.length === 0 ? <Empty text="No additive groups yet. Create one to grant extra access on top of a job role." /> : groups.map(g => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{g.name}</div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(g.allowed_modules || []).map(m => <span key={m.id} style={{ fontSize: 11 }}><LevelPill level={m.level} /></span>)}
                      {(g.allowed_modules || []).length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>No modules</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{(g.members || []).length} members</span>
                  <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditGroup(g)} title="Edit group"><Pencil size={13} /></button>
                  <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDeleteGroup(g)} title="Delete group"><Trash2 size={13} /></button>
                </div>
              ))}
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
        onDone={n => { setAssignFor(null); toastOk(`Assigned ${n} to “${assignFor.name}”.`); loadRoles(); }} onErr={toastErr} />}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>{toast.m}</div>
      )}
      <style>{`@media (max-width:820px){.ra-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

// ── editor modal ─────────────────────────────────────────────────────────────
function RoleEditor({ role, onClose, onSaved, onErr }) {
  const [name, setName] = useState(role?.name || '');
  const [tier, setTier] = useState(role?.tier || 'employee');
  const [desc, setDesc] = useState(role?.description || '');
  const [bundle, setBundle] = useState(() => Object.fromEntries((role?.allowed_modules || []).map(g => [g.id, g.level])));
  const [busy, setBusy] = useState(false);

  const toggle = id => setBundle(b => { const n = { ...b }; if (n[id]) delete n[id]; else n[id] = 'viewer'; return n; });
  const setLvl = (id, level) => setBundle(b => ({ ...b, [id]: level }));

  async function save() {
    if (!name.trim()) return onErr('Name is required.');
    setBusy(true);
    const body = { name: name.trim(), tier, description: desc.trim(), allowed_modules: Object.entries(bundle).map(([id, level]) => ({ id, level })) };
    try {
      const saved = role ? await api.updateJobRole(role.id, body) : await api.createJobRole(body);
      onSaved(saved);
    } catch (e) { onErr(e?.message || 'Could not save job role.'); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={role ? 'Edit job role' : 'New job role'} wide>
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
function AssignModal({ role, onClose, onDone, onErr }) {
  const [dir, setDir] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { api.getRolesDirectory().then(setDir).catch(() => setDir([])); }, []);

  const people = useMemo(() => (dir || []).map(p => ({ email: (p.email || p.workEmail || '').toLowerCase(), name: p.display_name || p.name || p.fullName || p.email || p.workEmail || '' })).filter(p => p.email), [dir]);
  const filtered = people.filter(p => !q.trim() || p.name.toLowerCase().includes(q.toLowerCase()) || p.email.includes(q.toLowerCase()));

  async function assign(p) {
    setBusy(p.email);
    try { await api.assignJobRole(role.id, p.email); onDone(p.name || p.email); }
    catch (e) { onErr(e?.message || 'Could not assign.'); setBusy(''); }
  }

  return (
    <Modal onClose={onClose} title={`Assign to “${role.name}”`}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>Sets this as their primary job role and their {ROLES[role.tier]?.label} tier. Extra groups they hold are kept.</div>
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" style={{ ...input, paddingLeft: 34 }} />
      </div>
      <div style={{ maxHeight: 340, overflow: 'auto' }}>
        {!dir ? <Spinner /> : filtered.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>No matches.</div>
          : filtered.slice(0, 60).map(p => (
            <button key={p.email} onClick={() => assign(p)} disabled={!!busy}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)', width: '100%', textAlign: 'left', marginBottom: 7, cursor: 'pointer' }}>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{p.email}</div></div>
              {busy === p.email ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <ChevronRight size={15} style={{ color: 'var(--muted)' }} />}
            </button>
          ))}
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
