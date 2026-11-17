// Settings > Operations > Tenants And Facility Access (Neil, 11/17/2026):
// access to Operations' tenant details is by role (an Access Group or a job
// role) and by person, including which facilities each sees.
//
// Administrators and Super Administrators see every facility and tenant
// details with no rule. Everyone else sees tenant details only when a rule
// here says so (the server fails closed - backend/ops_access.py `reach`): a
// person's reach is their own rule plus the rules of every role they are in.
// One rule per subject; `facilityIds` empty means every facility.
//
// Settings saves one way (Oct 23 2026): the facility list and the Tenant
// Details switch save on change, with a toast; a save that fails puts the
// control back and says why. Removing a rule is a hold on its row. Only an
// Administrator, or someone with Full access to Operations, opens this
// (GET /facility-ops/access answers 403 to anyone else).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, User, Users } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import AnchoredMenu from '../components/AnchoredMenu';
import NewButton from '../components/NewButton';
import { Switch } from '../components/settings/SettingsUI';
import { FS } from '../lib/typeScale';
import { PersonSelect } from '../tasks/components';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import './ops.css';

const note = { margin: 0, fontSize: FS.body, color: 'var(--muted)', lineHeight: 1.6 };
const lower = (v) => String(v || '').trim().toLowerCase();
const subjectKey = (r) => `${r.subjectType}:${lower(r.subjectId)}`;

function facilityWords(ids, facilities) {
  if (!ids.length) return 'Every Facility';
  const names = ids.map((id) => facilities.find((f) => f.id === id)?.name || id);
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
}

// "Every Facility" or the picked ones. An empty list MEANS every facility, so
// the last picked facility cannot be unticked - that would quietly widen the
// rule to all of them; Every Facility is its own choice.
function FacilityChoice({ name, ids, facilities, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const every = ids.length === 0;
  const flip = (id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div className="ops-ms" style={{ maxWidth: 'none', minWidth: 0 }}>
      <button type="button" ref={btn} className="ops-ms-btn" aria-haspopup="true" aria-expanded={open} disabled={disabled}
        aria-label={`Facilities for ${name}: ${facilityWords(ids, facilities)}`} onClick={() => setOpen((o) => !o)}
        style={disabled ? { opacity: 0.6, cursor: 'default' } : undefined}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{facilityWords(ids, facilities)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} role="group" aria-label={`Facilities for ${name}`}
        minWidth={240} style={{ padding: 6, maxHeight: 320, overflowY: 'auto' }}>
        <label className="ops-ms-opt ops-ms-all">
          <input type="checkbox" checked={every} disabled={every || disabled} onChange={() => onChange([])} />
          Every Facility
        </label>
        {facilities.map((f) => {
          const on = ids.includes(f.id);
          const last = on && ids.length === 1;
          return (
            <label key={f.id} className="ops-ms-opt" data-off={last || undefined}
              title={last ? 'Keep at least one facility, or pick Every Facility.' : undefined}>
              <input type="checkbox" checked={on} disabled={disabled || last} onChange={() => flip(f.id)} />{f.name}
            </label>
          );
        })}
        {facilities.length === 0 && <div style={{ ...note, padding: '6px 8px' }}>The facility list fills in after the first Cubby sync.</div>}
      </AnchoredMenu>
    </div>
  );
}

export default function OpsAccessSettings({ toastOk, toastErr }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [busy, setBusy] = useState(() => new Set());   // rule ids with a save on its way
  const [adding, setAdding] = useState('');            // '' | 'person' | 'group'
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState('');
  const [people, setPeople] = useState({ status: 'loading', rows: [] });

  const load = useCallback(() => api.opsAccess()
    .then((data) => setState({ status: 'ready', data: { rules: data?.rules || [], facilities: data?.facilities || [], groups: data?.groups || [] } }))
    .catch((err) => {
      console.error('Operations access: could not load the rules', err);
      setState({ status: err?.status === 403 ? 'denied' : 'error', data: null });
    }), []);
  useEffect(() => { load(); }, [load]);

  // The curated Nexus People list - the only people picker (CLAUDE.md).
  const loadPeople = useCallback(() => api.getPeopleDirectory()
    .then((rows) => setPeople({ status: 'ready', rows: (rows || []).map((p) => ({ email: lower(p.email), name: p.name || p.email, title: p.title || '' })).filter((p) => p.email) }))
    .catch((err) => {
      console.error('Operations access: could not load the people list', err);
      setPeople({ status: 'error', rows: [] });
    }), []);
  useEffect(() => { loadPeople(); }, [loadPeople]);
  const personOf = useMemo(() => new Map(people.rows.map((p) => [p.email, p])), [people.rows]);

  const fail = (err) => {
    const why = err?.message || 'That could not be saved.';
    if (toastErr) toastErr(why); else setProblem(why);
  };
  const setRules = (fn) => setState((s) => (s.data ? { ...s, data: { ...s.data, rules: fn(s.data.rules) } } : s));
  const mark = (id, on) => setBusy((b) => { const next = new Set(b); if (on) next.add(id); else next.delete(id); return next; });
  // The save answers with the whole list or with the one rule; either is taken.
  const absorb = (out) => {
    if (Array.isArray(out?.rules)) {
      setState((s) => ({ status: 'ready', data: { ...s.data, ...out, facilities: out.facilities || s.data?.facilities || [], groups: out.groups || s.data?.groups || [] } }));
      return true;
    }
    const rule = out?.rule || out;
    if (!rule?.id) return false;
    setRules((rs) => (rs.some((r) => subjectKey(r) === subjectKey(rule)) ? rs.map((r) => (subjectKey(r) === subjectKey(rule) ? { ...r, ...rule } : r)) : [...rs, rule]));
    return true;
  };

  const nameOf = (r) => r.subjectName || (r.subjectType === 'person' ? personOf.get(lower(r.subjectId))?.name : '') || r.subjectId;

  // Shown at once, saved at once; put back when the save does not land.
  const change = async (rule, patch, okText) => {
    const next = { ...rule, ...patch };
    setProblem('');
    setRules((rs) => rs.map((r) => (r.id === rule.id ? next : r)));
    mark(rule.id, true);
    try {
      absorb(await api.saveOpsAccess({ subjectType: next.subjectType, subjectId: next.subjectId, facilityIds: next.facilityIds || [], tenantDetails: !!next.tenantDetails }));
      toastOk?.(okText);
    } catch (err) {
      console.error('Operations access: could not save the rule', err);
      setRules((rs) => rs.map((r) => (r.id === rule.id ? rule : r)));
      fail(err);
    } finally { mark(rule.id, false); }
  };

  // A new rule starts with Tenant Details off: adding someone gives nothing
  // until the switch is turned on.
  const create = async (subjectType, subjectId, name) => {
    setAdding(''); setProblem(''); setCreating(true);
    try {
      const out = await api.saveOpsAccess({ subjectType, subjectId, facilityIds: [], tenantDetails: false });
      if (!absorb(out)) await load();
      toastOk?.(`Rule added for ${name}`);
    } catch (err) {
      console.error('Operations access: could not add the rule', err);
      fail(err);
    } finally { setCreating(false); }
  };

  if (state.status === 'loading') return <div role="status" aria-busy="true" aria-label="Loading the access rules"><SkeletonBlocks count={3} height={44} borderRadius={10} /></div>;
  if (state.status === 'denied') {
    return <p role="alert" style={note}>Only an Administrator, a Super Administrator or someone with Full access to Operations can open these rules.</p>;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" style={{ ...note, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Couldn&apos;t load the access rules.</span>
        <button type="button" className="secondary-btn" onClick={() => { setState({ status: 'loading', data: null }); load(); }}>Try Again</button>
      </p>
    );
  }

  const { rules, facilities, groups } = state.data;
  const taken = new Set(rules.map(subjectKey));
  const freePeople = people.rows.filter((p) => !taken.has(`person:${p.email}`));
  const freeGroups = groups.filter((g) => !taken.has(`group:${lower(g.id)}`));
  const groupSets = [['Access Groups', freeGroups.filter((g) => !g.isJobRole)], ['Job Roles', freeGroups.filter((g) => g.isJobRole)]].filter(([, list]) => list.length);

  return (
    <div className="ops-root" data-testid="ops-access-settings" style={{ gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px 18px', flexWrap: 'wrap' }}>
        <p style={{ ...note, flex: '1 1 320px', maxWidth: '68ch' }}>
          Administrators and Super Administrators see every facility and tenant details. Everyone else sees tenant details only when a rule here says so.
        </p>
        <NewButton menuLabel="New rule" busy={creating ? 'Adding...' : ''} onPick={(k) => { setProblem(''); setAdding(k); }} items={[
          { key: 'person', label: 'Person...', hint: 'One person from Nexus People', Icon: User },
          { key: 'group', label: 'Role...', hint: 'An Access Group or a job role', Icon: Users },
        ]} />
      </div>

      {problem && <p role="alert" style={{ ...note, color: 'var(--bad-fg)' }}>Not saved - {problem}</p>}

      {adding && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} data-testid="ops-access-new">
          <div style={{ flex: '0 1 320px', minWidth: 220 }}>
            {adding === 'person' && people.status === 'ready' && (
              <PersonSelect value="" people={freePeople} allowNone={false} placeholder="Pick a person" ariaLabel="Person for the new rule" autoFocus
                onChange={(email) => { if (email) create('person', email, personOf.get(email)?.name || email); }} />
            )}
            {adding === 'person' && people.status === 'loading' && <SkeletonBlocks count={1} height={36} borderRadius={8} />}
            {adding === 'person' && people.status === 'error' && (
              <p role="alert" style={{ ...note, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>Couldn&apos;t load the people list.</span>
                <button type="button" className="secondary-btn" onClick={() => { setPeople({ status: 'loading', rows: [] }); loadPeople(); }}>Try Again</button>
              </p>
            )}
            {adding === 'group' && (groupSets.length ? (
              <select className="form-select" aria-label="Role for the new rule" defaultValue="" autoFocus
                onChange={(e) => { const g = groups.find((x) => String(x.id) === e.target.value); if (g) create('group', g.id, g.name); }}>
                <option value="" disabled>Pick a role</option>
                {groupSets.map(([label, list]) => (
                  <optgroup key={label} label={label}>{list.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>
                ))}
              </select>
            ) : <p style={note}>Every Access Group and job role already has a rule.</p>)}
          </div>
          <button type="button" className="secondary-btn" onClick={() => setAdding('')}>Cancel</button>
        </div>
      )}

      <div>
        {rules.length > 0 && (
          <div className="ops-access-row ops-access-head" aria-hidden="true">
            <span>Person or Role</span><span>Facilities</span><span>Tenant Details</span><span />
          </div>
        )}
        {rules.length === 0 && (
          <p style={{ ...note, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
            No rules yet. Only Administrators and Super Administrators see tenant details.
          </p>
        )}
        {rules.map((r) => {
          const name = nameOf(r);
          const person = r.subjectType === 'person' ? personOf.get(lower(r.subjectId)) : null;
          const under = r.subjectType === 'person' ? (person?.title || r.subjectId) : 'Role';
          const saving = busy.has(r.id);
          return (
            <div key={r.id} className="ops-access-row" data-testid="ops-access-rule">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: FS.body, fontWeight: 600, color: 'var(--ink)', overflowWrap: 'anywhere' }}>{name}</div>
                <div style={{ fontSize: FS.label, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{under}</div>
              </div>
              <FacilityChoice name={name} ids={r.facilityIds || []} facilities={facilities} disabled={saving}
                onChange={(ids) => change(r, { facilityIds: ids }, `${name} sees ${ids.length ? facilityWords(ids, facilities) : 'every facility'}`)} />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: FS.body, color: 'var(--ink)' }}>
                <Switch checked={!!r.tenantDetails} disabled={saving} label={`Tenant Details for ${name}`}
                  onChange={(on) => change(r, { tenantDetails: on }, on ? `${name} sees tenant details` : `${name} no longer sees tenant details`)} />
                <span className="ops-access-lab">Tenant Details</span>
              </label>
              <HoldButton label="Remove" doneLabel="Removed" size="sm" holdMs={HOLD_RECORD_MS} disabled={saving}
                ariaLabel={`Remove the rule for ${name}`}
                fallbackMessage={`Remove the rule for ${name}? They keep only what their tier and their other rules give.`}
                onConfirm={() => api.deleteOpsAccess(r.id)}
                onDone={() => { setRules((rs) => rs.filter((x) => x.id !== r.id)); toastOk?.(`Rule removed for ${name}`); }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
