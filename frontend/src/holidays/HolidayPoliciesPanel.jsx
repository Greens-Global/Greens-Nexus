// Settings > Companies > Holiday Policies, the Every Company face (Neil, Oct
// 29 2026): named sets of holidays and their weekend rule, each applied to
// one or more companies. Assigning is live - editing a policy updates every
// company it applies to; a company skips or changes a holiday for itself on
// its own Holiday Calendar.
import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Pencil, Plus, Trash2, Eye } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import HolidayPolicyEditor from './HolidayPolicyEditor';
import { Chip } from './HolidaySourcePicker';
import { weekendRuleLabel, plural, otherCompaniesText, HINT } from './holidayLib';

const ICON_BTN = { background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', fontSize: 12 };

export default function HolidayPoliciesPanel({ entities = null, toastOk, toastErr }) {
  const [state, setState] = useState({ policies: null, error: false });
  const [editing, setEditing] = useState(null);   // a policy, 'new', or null

  const load = useCallback(() => api.getHolidayPolicies()
    .then(r => setState({ policies: Array.isArray(r) ? r : [], error: false }))
    .catch(() => setState(s => ({ policies: s.policies || [], error: true }))), []);
  const { policies, error } = state;
  useEffect(() => { load(); }, [load]);

  async function remove(p) {
    const cos = p.companies || [];
    const others = Number(p.otherCompanies) || 0;
    // Companies outside this admin's scope lose it too - counted, not named.
    const who = cos.length
      ? `${plural(cos.length, 'company', 'companies')}${otherCompaniesText(others)} will lose this policy's holidays: ${cos.map(c => c.name).join(', ')}.`
      : `${plural(others, 'other company', 'other companies')} will lose this policy's holidays.`;
    const message = cos.length || others
      ? `${who} Holidays a company changed for itself stay on its calendar as its own.`
      : 'No company uses it.';
    if (!await dialog.confirm(message, { title: `Delete ${p.name}?`, confirmText: 'Delete Policy', danger: true })) return;
    try {
      await api.deleteHolidayPolicy(p.id);
      toastOk?.(`Deleted ${p.name}.`);
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not delete the policy.'); }
  }

  const list = policies || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <p style={HINT}>Editing a policy updates every company it applies to. Each holiday keeps the date shown here - weekend holidays move only when the policy says so.</p>
        <button className="primary-btn" onClick={() => setEditing('new')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Policy
        </button>
      </div>
      <AsyncSection loading={policies === null} error={error && !list.length} onRetry={load}
        errorMessage="Holiday policies could not be loaded right now - please try again."
        isEmpty={list.length === 0}
        skeleton={<SkeletonBlocks count={3} height={64} borderRadius={10} />}
        emptyContent={(
          <div style={{ border: '1px dashed var(--line)', borderRadius: 12, padding: '22px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <CalendarDays size={22} style={{ color: 'var(--muted)' }} aria-hidden="true" />
            <div style={{ fontWeight: 700, fontSize: 13 }}>No Holiday Policies Yet</div>
            <p style={HINT}>Make one for each set of holidays you give - for example US Holidays and India Holidays - and apply it to the companies that use it.</p>
          </div>
        )}>
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
          {list.map(p => {
            const years = (p.years || []).slice().sort();
            const cos = p.companies || [];
            return (
              <div key={p.id} style={{ display: 'flex', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--line)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.name}</div>
                  {p.description && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.description}</div>}
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {plural((p.holidays || []).length, 'holiday')}
                    {years.length > 0 && ` · ${years.join(', ')}`}
                    {` · Weekends: ${weekendRuleLabel(p.weekendRule)}`}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
                    {cos.map(c => <Chip key={c.id}>{c.name}</Chip>)}
                    {Number(p.otherCompanies) > 0 && (
                      <Chip title="Companies you do not manage that use this policy">
                        {`+${plural(Number(p.otherCompanies), 'Other Company', 'Other Companies')}`}
                      </Chip>
                    )}
                    {!cos.length && !(Number(p.otherCompanies) > 0) && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Not applied to any company yet.</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {p.canEdit === false ? (
                    <button type="button" style={ICON_BTN} onClick={() => setEditing(p)} aria-label={`View ${p.name}`}><Eye size={13} /> View</button>
                  ) : (
                    <>
                      <button type="button" style={ICON_BTN} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}><Pencil size={13} /> Edit</button>
                      <button type="button" style={{ ...ICON_BTN, color: 'hsl(var(--color-red))' }} onClick={() => remove(p)} aria-label={`Delete ${p.name}`}><Trash2 size={13} /> Delete</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </AsyncSection>
      {editing && (
        <HolidayPolicyEditor policy={editing === 'new' ? null : editing} entities={entities}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}
          toastOk={toastOk} toastErr={toastErr} />
      )}
    </div>
  );
}
