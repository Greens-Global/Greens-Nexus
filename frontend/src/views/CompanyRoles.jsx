import { useState, useEffect, useMemo } from 'react';
import { Plus, Pencil, Trash2, UserPlus, X, Copy, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { usePeopleDirectory } from '../lib/queries';
import { useNameResolver } from '../lib/useNameResolver';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { RoleEditor, AssignModal, ApproverPicker, TierBadge, ModuleLevelPill, Avatar } from './RolesAccess';

// ── Company Settings > [company] > Roles ─────────────────────────────────────
// Job roles are given company by company (Neil, Sep 2026); who can reach what
// stays in Global Settings > Access. This tab lists the company's own roles,
// grouped by the company's departments, and the shared roles that apply in
// every company. A shared role only moves here when everyone holding it works
// here - otherwise it is duplicated, so nobody's access changes by surprise.
// The editor, assign picker and approver picker are the ones Access uses.

export default function CompanyRoles({ entity, toastOk, toastErr }) {
  const [roles, setRoles] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [selId, setSelId] = useState(null);
  const [editing, setEditing] = useState(undefined);   // undefined = closed, object = edit / new seed
  const [editingShared, setEditingShared] = useState(null);   // a shared role open in the editor
  const [assignFor, setAssignFor] = useState(null);
  const { data: dir } = usePeopleDirectory();
  const nameOf = useNameResolver();

  const load = () => {
    setLoadErr(false);
    return api.getCompanyJobRoles(entity.id).then(setRoles).catch(() => setLoadErr(true));
  };
  useEffect(() => {
    setRoles(null); setSelId(null); load();
    api.getCompanyDepartments(entity.id)
      .then(list => setDepartments((list || []).map(d => d.name).filter(Boolean)))
      .catch(() => setDepartments([]));
  }, [entity.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const people = useMemo(() => (dir || []).map(p => ({
    email: (p.email || p.workEmail || '').toLowerCase(),
    name: p.display_name || p.name || p.fullName || p.email || '',
    company: p.company || '',
    photo: p.photoUrl || p.photo_url || '',
  })).filter(p => p.email), [dir]);
  const personByEmail = useMemo(() => Object.fromEntries(people.map(p => [p.email, p])), [people]);
  const companyPeople = useMemo(() => people.filter(p => p.company === entity.id), [people, entity.id]);

  const own = useMemo(() => (roles || []).filter(r => r.company_id === entity.id), [roles, entity.id]);
  const shared = useMemo(() => (roles || []).filter(r => !r.company_id), [roles]);
  const selected = own.find(r => r.id === selId) || null;

  // The company's departments in their own order, then any other department a
  // role names, then roles with none under "Other". Empty departments are skipped.
  const byDept = useMemo(() => {
    const groups = new Map();
    const labelOf = new Map(departments.map(d => [d.toLowerCase(), d]));
    departments.forEach(d => groups.set(d, []));
    own.forEach(r => {
      const raw = (r.department || '').trim();
      const d = raw ? (labelOf.get(raw.toLowerCase()) || raw) : 'Other';
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(r);
    });
    const entries = [...groups.entries()].filter(([, list]) => list.length);
    return [...entries.filter(([d]) => d !== 'Other'), ...entries.filter(([d]) => d === 'Other')];
  }, [own, departments]);

  // Why a shared role can't move here, or '' when it can. Members missing from
  // the directory count as outside - moving is only offered when it's certain.
  function moveBlocker(r) {
    if (!dir) return 'Loading people…';
    const outside = (r.members || []).filter(em => personByEmail[em]?.company !== entity.id);
    if (!outside.length) return '';
    return `${outside.length} of ${r.member_count} ${r.member_count === 1 ? 'person' : 'people'} in this role ${outside.length === 1 ? "doesn't" : "don't"} work at ${entity.name}. Only a role whose people all work here can move. Duplicate it instead.`;
  }

  async function moveHere(r) {
    if (moveBlocker(r)) return;
    if (!await dialog.confirm(`Move "${r.name}" to ${entity.name}? It will only be offered to people at ${entity.name} from now on. The ${r.member_count} ${r.member_count === 1 ? 'person' : 'people'} in it keep the role.`,
      { title: 'Move Role', confirmText: 'Move Role' })) return;
    try { await api.updateJobRole(r.id, { company_id: entity.id }); toastOk(`“${r.name}” now belongs to ${entity.name}.`); setSelId(r.id); load(); }
    catch (e) { toastErr(e?.message || 'Could not move the role.'); }
  }
  const duplicateHere = r => setEditing({
    name: r.name, tier: r.tier, department: r.department, description: r.description,
    allowed_modules: r.allowed_modules, monitoring_exempt: r.monitoring_exempt, bod_exempt: r.bod_exempt,
  });

  async function onDelete(r) {
    if (!await dialog.confirm(`Delete role "${r.name}"?${r.member_count ? ` ${r.member_count} people have it - reassign them first or the delete will fail.` : ''}`,
      { title: 'Delete Role', confirmText: 'Delete', danger: true })) return;
    try { await api.deleteJobRole(r.id); toastOk(`Deleted “${r.name}”.`); if (selId === r.id) setSelId(null); load(); }
    catch (e) { toastErr(e?.message || 'Could not delete - reassign its people first.'); }
  }
  async function removeMember(email) {
    if (!selected) return;
    try { await api.unassignJobRole(selected.id, email); toastOk(`Removed ${nameOf(email)} from “${selected.name}”.`); load(); }
    catch (e) { toastErr(e?.message || 'Could not remove.'); }
  }

  if (loadErr) return <div style={{ padding: '16px 4px' }}><ErrorBanner message="Couldn't load roles right now." onRetry={load} /></div>;
  if (!roles) return <div style={{ padding: '16px 4px' }}><SkeletonBlocks count={4} height={54} /></div>;

  return (
    <div style={{ padding: '16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Roles at {entity.name}</h4>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
            Only people at {entity.name} can hold these roles. What each role can reach is set in its bundle; extra groups are managed in Global Settings under Access.
          </p>
        </div>
        <button className="primary-btn" onClick={() => setEditing({})} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Plus size={15} /> New Role
        </button>
      </div>

      <div className="cr-grid" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'start' }}>
          {own.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 6px' }}>
              No roles for {entity.name} yet. Create one, or bring in a shared role below.
            </div>
          ) : byDept.map(([dept, list]) => (
            <div key={dept}>
              <div style={deptLabel}>{dept}<span style={countPill}>{list.length}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {list.map(r => (
                  <button key={r.id} onClick={() => setSelId(r.id)}
                    style={{ ...roleCard, borderColor: selId === r.id ? 'var(--ink)' : 'var(--line)' }}>
                    <span style={{ fontWeight: 800, fontSize: 13.5, flex: 1, minWidth: 0 }}>{r.name}</span>
                    <TierBadge tier={r.tier} />
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{r.member_count}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 18, alignSelf: 'start' }}>
          {!selected ? (
            <div style={{ color: 'var(--muted)', padding: '32px 10px', textAlign: 'center', fontSize: 13 }}>Pick a role to see its bundle and people.</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 17, fontWeight: 800, flex: 1, minWidth: 140, margin: 0 }}>{selected.name}</h3>
                <TierBadge tier={selected.tier} />
                <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditing(selected)} title="Edit role" aria-label="Edit role"><Pencil size={13} /></button>
                <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => onDelete(selected)} title="Delete role" aria-label="Delete role"><Trash2 size={13} /></button>
              </div>
              {selected.description && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '8px 0 0' }}>{selected.description}</p>}

              <div style={sectLabel}>What this role can reach</div>
              {(selected.allowed_modules || []).length === 0
                ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>No modules granted yet - edit the role to build its bundle.</div>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {selected.allowed_modules.map(g => <ModuleLevelPill key={g.id} moduleId={g.id} level={g.level} />)}
                  </div>}

              <div style={sectLabel}>Timesheet approver (default manager)</div>
              <ApproverPicker role={selected} people={companyPeople} nameOf={nameOf}
                onSaved={load} toastOk={toastOk} toastErr={toastErr} />

              <div style={sectLabel}>People with this role · {selected.member_count}</div>
              {(selected.members || []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {selected.members.map(em => (
                    <div key={em} style={memberRow}>
                      <Avatar name={nameOf(em)} src={personByEmail[em]?.photo} size={24} />
                      <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(em)}</span>
                      <button onClick={() => removeMember(em)} title="Remove from this role" aria-label={`Remove ${nameOf(em)}`} style={iconBtn}><X size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={() => setAssignFor(selected)}>
                <UserPlus size={14} /> Assign a Person
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 28 }}>
        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Shared Across Companies</h4>
        <p style={{ margin: '4px 0 12px', fontSize: 12.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          These roles apply in every company, and people from any company can hold them. Editing one changes it everywhere. Move one here when everyone in it works at {entity.name}, or duplicate it to give {entity.name} its own version.
        </p>
        {shared.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>No shared roles.</div>
        ) : (
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            {shared.map((r, i) => {
              const blocker = moveBlocker(r);
              return (
                <div key={r.id} data-testid={`shared-role-${r.id}`}
                  style={{ padding: '11px 14px', borderTop: i ? '1px solid var(--line)' : 'none', background: 'var(--card)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 140 }}>{r.name}</span>
                    <TierBadge tier={r.tier} />
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>{r.member_count} {r.member_count === 1 ? 'person' : 'people'}</span>
                    <button className="secondary-btn" style={{ padding: '6px 10px' }} onClick={() => setEditingShared(r)}
                      title="Edit this shared role (applies in every company)" aria-label={`Edit ${r.name}`}><Pencil size={13} /></button>
                    {/* The wrapper carries the tooltip: a disabled button gets no hover events. */}
                    <span title={blocker || `Only people at ${entity.name} will be offered this role.`}>
                      <button className="secondary-btn" disabled={!!blocker} onClick={() => moveHere(r)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', fontSize: 12, opacity: blocker ? 0.55 : 1 }}>
                        <ArrowRight size={13} /> Move to This Company
                      </button>
                    </span>
                    <button className="secondary-btn" onClick={() => duplicateHere(r)}
                      title={`Create a ${entity.name} role with the same bundle, tier and description, and no people`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', fontSize: 12 }}>
                      <Copy size={13} /> Duplicate for This Company
                    </button>
                  </div>
                  {blocker && dir && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 5 }}>{blocker}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing !== undefined && (
        <RoleEditor role={editing} jobRoles={own} companyId={entity.id} departments={departments}
          onClose={() => setEditing(undefined)} onErr={toastErr}
          onSaved={r => { setEditing(undefined); toastOk(`Saved “${r.name}”.`); setSelId(r.id); load(); }} />
      )}
      {/* A shared role keeps company_id '' on save (RoleEditor only sets a
          company when creating), and its departments come from the other
          shared roles, not this company's list. */}
      {editingShared && (
        <RoleEditor role={editingShared} jobRoles={shared}
          onClose={() => setEditingShared(null)} onErr={toastErr}
          onSaved={r => { setEditingShared(null); toastOk(`Saved “${r.name}”. It applies in every company.`); load(); }} />
      )}
      {assignFor && (
        <AssignModal role={assignFor} onClose={() => setAssignFor(null)} onErr={toastErr}
          onAssigned={n => { toastOk(`Assigned ${n} to “${assignFor.name}”.`); load(); }} />
      )}
      <style>{`@media (max-width:900px){.cr-grid{grid-template-columns:1fr !important}}`}</style>
    </div>
  );
}

const deptLabel = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)', margin: '0 0 7px 2px' };
const countPill = { fontSize: 10.5, fontWeight: 700, background: 'var(--mist)', borderRadius: 999, padding: '1px 7px', letterSpacing: 0 };
const roleCard = { display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left', width: '100%', background: 'var(--card)', border: '1.5px solid var(--line)', borderRadius: 12, padding: '10px 13px', cursor: 'pointer', fontFamily: 'Inter,sans-serif', color: 'var(--ink)' };
const sectLabel = { fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', margin: '18px 0 9px' };
const memberRow = { display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)' };
const iconBtn = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'grid', placeItems: 'center', width: 18, height: 18, borderRadius: '50%', padding: 0 };
