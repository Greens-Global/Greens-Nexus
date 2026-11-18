// A person's Access - the ONE access editor (Neil, 11/03/2026). The record's
// Access tab in People and Settings > People & Access (which opens this same
// component in a sheet for the picked person) both draw it, so the two can
// never drift apart:
//   - Job Role: shown here, changed ONLY through Change Role (RoleChangeModal
//     in components/HrPersonActions.jsx - a reason is always kept; People
//     passes onChangeRole so the promotion choice is offered too).
//   - Tier: follows the job role; a per-person override is a Super
//     Administrator's alone (Tiers, Neil 11/02/2026 - the server's
//     /roles/assign guard is the same rule).
//   - Extra Groups: added on top; removing one is held on its row (Hold to
//     confirm, Neil Oct 30 2026) with Undo.
//   - People Admin Companies (internal people) and Company Access (external
//     and guest people), the access-scope rows.
//   - The external lifecycle box (invite state, Release, Resend, Deactivate,
//     Remove) for an external or guest, when `showLifecycle`.
//   - What They Can Do: the effective access, read only.
import { useEffect, useState } from 'react';
import { Shield, Plus, X } from 'lucide-react';
import { api } from '../api';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import HoldButton from '../ui/HoldButton';
import { dialog } from '../ui/dialog';
import { useRole, MODULES, MODULE_LEVELS, ROLES } from '../contexts/RoleContext';
import { capabilityText } from '../lib/moduleCapabilities';
import { RoleChangeModal } from '../components/HrPersonActions';
import { RoleChangeRequestCard, RoleHistory } from '../components/RoleChangeRequests';
import { ExternalPersonSection } from '../views/ExternalUsersPanel';
import { LevelPill, TierBadge, rolesForCompany } from '../views/RolesAccess';

const TIERS = Object.keys(ROLES);
const head = { fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '22px 0 8px', display: 'flex', alignItems: 'center', gap: 8 };
const sub = { fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 };
const rowLine = { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' };
const select = { padding: '7px 10px', fontSize: 13, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontFamily: 'Inter,sans-serif' };

export default function AccessTab({
  email, identityType = 'internal', companyId = '', employee = null, external = null,
  showLifecycle = false, showHistory = false, nameOf = (em) => em,
  onChanged, onChangeRole, onExternalChanged, onRemoved, toastOk, toastErr,
}) {
  const { assignRole, can, myLevel } = useRole();
  // Tier override: Super Administrators only (Neil, 11/02/2026).
  const superAdmin = (typeof can === 'function' && can('owner')) || (myLevel || 0) >= 5;
  const isExternal = ['guest', 'external'].includes(identityType || 'internal');
  // Keyed by email so a new person never shows the last one's access.
  const [loaded, setLoaded] = useState({ email: null, v: null });
  const data = loaded.email === email ? loaded.v : null;
  const setData = (v) => setLoaded({ email, v });
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [entities, setEntities] = useState([]);
  const [scopes, setScopes] = useState([]);
  const [addCo, setAddCo] = useState('');
  const [addHrCo, setAddHrCo] = useState('');
  const [roleOpen, setRoleOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [fetchedExt, setFetchedExt] = useState({ email: null, v: null });
  const ext = fetchedExt.email === email ? fetchedExt.v : external;
  const setExt = (v) => setFetchedExt({ email, v });
  const who = nameOf(email) || email;

  // A failed read is an error with Retry (11/11/2026) - never a made-up
  // Employee tier with "No job role yet" and Set Job Role offered over it.
  const [loadErr, setLoadErr] = useState({ email: null, v: '' });
  const loadError = loadErr.email === email ? loadErr.v : '';
  const load = () => api.getEffectiveAccess(email)
    .then((v) => { setLoadErr({ email, v: '' }); setData(v); })
    .catch((e) => setLoadErr({ email, v: e?.message || 'Could not load access.' }));
  const loadScopes = () => api.getAccessScopes(email).then((s) => setScopes(Array.isArray(s) ? s : [])).catch(() => setScopes([]));
  const loadExt = () => api.getExternalUsers()
    .then((rows) => setExt((rows || []).find((r) => (r.email || '').toLowerCase() === (email || '').toLowerCase()) || null))
    .catch(() => setExt(null));
  useEffect(() => {
    if (!email) return;
    load(); loadScopes();
    if (showLifecycle && isExternal && !external) loadExt();
  }, [email]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.getJobRoles().then((r) => setRoles(Array.isArray(r) ? r : [])).catch(() => {});
    api.getGroups().then((gs) => setGroups((Array.isArray(gs) ? gs : []).filter((g) => !g.is_job_role))).catch(() => {});
    api.getEntities().then((e) => setEntities(Array.isArray(e) ? e : [])).catch(() => {});
  }, []);

  if (!email) return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 4px' }}>This person has no work email yet - provision their account first to manage access.</div>;
  if (!data && loadError) return <ErrorBanner message={loadError} onRetry={() => { setLoadErr({ email, v: '' }); load(); }} />;
  if (!data) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="inline" /></div>;

  const refresh = () => { load(); onChanged?.(); };
  const entityName = (id) => entities.find((en) => en.id === id)?.name || id;
  const companyScopes = scopes.filter((s) => s.scopeType === 'entity' && s.moduleId !== 'hr');
  const hrScopes = scopes.filter((s) => s.scopeType === 'entity' && s.moduleId === 'hr');
  const held = new Set((data.extra_groups || []).map((g) => g.id));
  const addable = groups.filter((g) => !held.has(g.id));
  const roleChoices = rolesForCompany(roles, companyId).filter((r) => r.id !== data.job_role?.id);

  async function addGroup(gid) {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    try { await api.addGroupMembers(g.id, [email]); toastOk(`Added ${who} to “${g.name}”.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not add to group.'); }
  }
  // One membership: held on its row with no dialog; Undo adds it back.
  async function removeGroup(g) {
    try { await api.removeGroupMember(g.id, email); toastOk(`Removed ${who} from “${g.name}”.`); }
    catch (e) { throw new Error(e?.message || 'Could not remove.', { cause: e }); }
    return {
      undoMessage: `Removed ${who} from “${g.name}”.`,
      undo: async () => {
        try { await api.addGroupMembers(g.id, [email]); toastOk(`Added ${who} to “${g.name}”.`); refresh(); }
        catch (e) { toastErr(e?.message || 'Could not add to group.'); }
      },
    };
  }
  async function setTier(tier) {
    if (!tier || !superAdmin) return;
    if (!await dialog.confirm(`Set ${who}'s tier to "${ROLES[tier].label}" - just for this person? It overrides their job role's tier and won't change when the role's tier is edited.`, { title: 'Override Tier', confirmText: 'Set Tier' })) return;
    try { await assignRole(email, tier, who); toastOk(`${who} is now ${ROLES[tier].label}.`); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not set tier.'); }
  }
  async function resetTier() {
    if (!data.job_role || !superAdmin) return;
    if (!await dialog.confirm(`Reset ${who} to follow their "${data.job_role.name}" tier again?`, { title: 'Reset Tier', confirmText: 'Reset' })) return;
    try { await api.assignJobRole(data.job_role.id, email); toastOk('Now follows the job-role tier.'); refresh(); }
    catch (e) { toastErr(e?.message || 'Could not reset.'); }
  }
  const addScope = async (module_id, scope_id, done) => {
    if (!scope_id) return;
    try {
      setScopes(await api.addAccessScope(email, { module_id, scope_type: 'entity', scope_id }));
      done('');
      toastOk(module_id === 'hr' ? `People access limited to ${entityName(scope_id)}.` : `Limited to ${entityName(scope_id)}.`);
    } catch (e) { toastErr(e?.message || 'Could not add the limit.'); }
  };
  const removeScope = async (s) => {
    try { setScopes(await api.deleteAccessScope(email, s.id)); toastOk(`Removed the ${entityName(s.scopeId)} limit.`); }
    catch (e) { toastErr(e?.message || 'Could not remove the limit.'); }
  };
  const scopeList = (list, pickValue, setPick, moduleId, empty) => (
    <>
      {list.length === 0 && <div style={sub}>{empty}</div>}
      {list.map((s) => (
        <div key={s.id} style={rowLine}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{entityName(s.scopeId)}</span>
          <button type="button" onClick={() => removeScope(s)} aria-label={`Remove ${entityName(s.scopeId)}`} title="Remove limit"
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={14} /></button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <select style={{ ...select, flex: 1 }} value={pickValue} onChange={(e) => setPick(e.target.value)} aria-label="Add a Company">
          <option value="">Add a company…</option>
          {entities.filter((en) => !list.some((s) => s.scopeId === en.id)).map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
        </select>
        <button type="button" className="secondary-btn" onClick={() => addScope(moduleId, pickValue, setPick)} disabled={!pickValue}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Limit</button>
      </div>
    </>
  );

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {showLifecycle && isExternal && ext && (
        <ExternalPersonSection ext={ext} toastOk={toastOk} toastErr={toastErr}
          onChanged={() => { loadExt(); onExternalChanged?.(); refresh(); }}
          onRemoved={() => onRemoved?.()} />
      )}

      <div style={{ ...head, marginTop: 4 }}>Job Role</div>
      <div style={rowLine}>
        {data.job_role
          ? <><Shield size={14} style={{ color: 'var(--muted)' }} /><span style={{ fontWeight: 700, fontSize: 14 }}>{data.job_role.name}</span>
            {data.job_role.company_id && <span style={sub}>{entityName(data.job_role.company_id)}</span>}<TierBadge tier={data.job_role.tier} /></>
          : <span style={sub}>No job role yet.</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="secondary-btn" onClick={() => (onChangeRole ? onChangeRole() : setRoleOpen(true))}
          title="The reason is kept in their role history"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <Shield size={13} /> {data.job_role ? 'Change Role' : 'Set Job Role'}
        </button>
      </div>
      {data.job_role?.description && <div style={{ ...sub, marginTop: 6 }}>{data.job_role.description}</div>}
      {showHistory && !isExternal && (
        <div style={{ marginTop: 12 }}>
          <RoleChangeRequestCard email={email} refreshKey={historyKey} toastOk={toastOk} toastErr={toastErr}
            onDecided={() => { setHistoryKey((n) => n + 1); refresh(); }} />
          <RoleHistory email={email} refreshKey={`${historyKey}-${data.job_role?.id || ''}`} />
        </div>
      )}

      {/* Externals are hard-capped at the Employee tier by the server, so a
          tier choice would only mislead. */}
      {!isExternal && (
        <>
          <div style={head}>Tier</div>
          <div style={rowLine}>
            <TierBadge tier={data.tier} />
            {data.tier_pinned && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Set for this person</span>}
            <span style={{ flex: 1 }} />
            {superAdmin && (
              <>
                <select value="" onChange={(e) => setTier(e.target.value)} style={select} aria-label="Override Tier">
                  <option value="">{data.tier_pinned ? 'Change this person’s tier…' : 'Override tier for this person…'}</option>
                  {TIERS.map((t) => <option key={t} value={t}>{ROLES[t].label}</option>)}
                </select>
                {data.tier_pinned && data.job_role && (
                  <button type="button" className="secondary-btn" onClick={resetTier} style={{ fontSize: 13 }}>Reset to Role Tier</button>
                )}
              </>
            )}
          </div>
          <div style={{ ...sub, marginTop: 6 }}>
            {data.tier_pinned
              ? 'Set directly for this person - editing the job role’s tier won’t change them.'
              : 'Follows their job role.'}
            {superAdmin ? ' Override it to give this person a different tier while keeping them in the same role.' : ' Only a Super Administrator overrides a person’s tier.'}
          </div>
        </>
      )}

      <div style={head}>Extra Groups <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{(data.extra_groups || []).length}</span></div>
      {(data.extra_groups || []).length === 0 && <div style={sub}>None - access comes from the job role.</div>}
      {(data.extra_groups || []).map((g) => (
        <div key={g.id} style={rowLine}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{g.name}</span>
          <HoldButton size="sm" label="Remove" doneLabel="Removed" icon={X} ariaLabel={`Remove from ${g.name}`}
            onConfirm={() => removeGroup(g)} onDone={() => refresh()}
            fallbackMessage={`Remove ${who} from "${g.name}"? They lose that extra access; their job-role baseline is untouched.`} />
        </div>
      ))}
      {addable.length > 0 && (
        <select value="" onChange={(e) => e.target.value && addGroup(e.target.value)} style={{ ...select, marginTop: 10 }} aria-label="Add to a Group">
          <option value="">Add to a group…</option>
          {addable.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      )}

      {!isExternal ? (
        <>
          <div style={head}>People Admin Companies <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{hrScopes.length || 'All'}</span></div>
          <div style={{ ...sub, marginBottom: 6 }}>With none set, an HR grant covers every company. Add companies to limit this person&apos;s People, Time and Leave administration to just those. Directory and task assignment stay company-wide.</div>
          {scopeList(hrScopes, addHrCo, setAddHrCo, 'hr', '')}
        </>
      ) : (
        <>
          <div style={head}>Company Access <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{companyScopes.length || 'All'}</span></div>
          <div style={{ ...sub, marginBottom: 6 }}>Limit this {identityType} user to specific companies. With none set, an external user sees nothing; a guest is unrestricted until you add a limit.</div>
          {scopeList(companyScopes, addCo, setAddCo, 'company', '')}
        </>
      )}

      <div style={head}>What They Can Do <span style={{ fontWeight: 600, color: 'var(--muted)' }}>{(data.modules || []).length} modules</span></div>
      {(data.modules || []).length === 0
        ? <div style={sub}>Nothing yet - set a job role to give them their baseline.</div>
        : data.modules.map((m) => {
          const mod = MODULES.find((x) => x.id === m.module);
          return (
            <div key={m.module} style={{ ...rowLine, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{mod?.label || m.module}</div>
                <div style={{ ...sub, fontSize: 12, marginTop: 2 }}>{capabilityText(m.module, m.level, mod?.label)}</div>
              </div>
              <LevelPill level={m.level} title={`${mod?.label || m.module} · ${MODULE_LEVELS[m.level]?.label || m.level}`} />
              <span style={{ fontSize: 12, color: 'var(--muted)', minWidth: 120, textAlign: 'right' }}>{m.manual ? `From ${m.source}` : 'From their job role'}</span>
            </div>
          );
        })}
      <div style={{ ...sub, fontSize: 12, marginTop: 8 }}>Access is the job role plus any groups, taking the highest level per module.</div>

      {roleOpen && (
        <RoleChangeModal
          employee={{ ...(employee || {}), workEmail: email, firstName: employee?.firstName || who, jobTitle: employee?.jobTitle || data.job_role?.name || '', identityType }}
          roles={roleChoices}
          onClose={() => setRoleOpen(false)} toastErr={toastErr}
          onChanged={(res) => {
            setRoleOpen(false); setHistoryKey((n) => n + 1);
            toastOk(`${who} is now ${res.roleName}.${res.warning ? ` ${res.warning}` : ''}`);
            refresh();
          }} />
      )}
    </div>
  );
}
