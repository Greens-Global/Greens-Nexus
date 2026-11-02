import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGroupDirty } from '../lib/groupDirty';
import { useDraft } from '../lib/useDraft';
import { confirmDiscard } from '../lib/dialogGuard';
import SaveRow from './SaveRow';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { formatHHMM } from '../lib/datetime';
import { Switch } from './settings/SettingsUI';
import { TimeField } from '../tasks/components';

// Shift Differentials and Call-Back Pay (Neil, Oct 17 2026): per company, OFF
// by default. While off nothing on any time sheet changes. On, HR lists the
// differentials (a flat amount or a percent of the base rate per hour worked
// inside a time window, on certain days, at certain sites) and the call-back
// minimum. The server (pay_premiums.py) validates and prices; this card only
// edits the rule. Changing it is administrator only, like Punch Rounding.
// The two switches (pay premiums at all, call-back pay) save on click with a
// toast; the differentials and the call-back minutes are one draft with ONE
// Save row at the foot (the Settings save pattern, Oct 23 2026).

const DAYS = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]];
const blankRule = () => ({ id: '', name: '', kind: 'flat', amount: '', start: '', end: '', days: [], sites: [] });
const draftOf = (d) => ({
  enabled: !!d?.enabled,
  differentials: (d?.differentials || []).map((r) => ({ ...r, amount: String(r.amount ?? '') })),
  callBack: { enabled: !!d?.callBack?.enabled, minimumMin: String(d?.callBack?.minimumMin ?? 120), gapMin: String(d?.callBack?.gapMin ?? 60) },
});
const bodyOf = (draft) => ({
  enabled: draft.enabled,
  differentials: draft.differentials.map((r) => ({ ...r, amount: Number(r.amount) || 0 })),
  callBack: { enabled: draft.callBack.enabled, minimumMin: Number(draft.callBack.minimumMin) || 0, gapMin: Number(draft.callBack.gapMin) || 0 },
});

export function ruleSummary(r, siteName = (id) => id) {
  const amt = Number(r.amount) || 0;
  const parts = [r.kind === 'percent' ? `${amt}% of the base rate per hour` : `$${amt.toFixed(2)} per hour`];
  if (r.start && r.end) parts.push(`${formatHHMM(r.start)} - ${formatHHMM(r.end)}`);
  if ((r.days || []).length) parts.push(DAYS.filter(([, n]) => r.days.includes(n)).map(([l]) => l).join(', '));
  if ((r.sites || []).length) parts.push(`at ${r.sites.map(siteName).join(', ')}`);
  if (!(r.start && r.end) && !(r.days || []).length && !(r.sites || []).length) parts.push('all hours worked');
  return parts.join(' · ');
}

const chip = (on) => ({
  fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
  border: `1px solid ${on ? 'hsl(var(--color-blue))' : 'var(--line)'}`,
  background: on ? 'hsla(var(--color-blue), 0.12)' : 'transparent',
  color: on ? 'hsl(var(--color-blue))' : 'var(--muted)',
});
const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' };

// `company` (Settings' scope picker, Oct 23) fixes the company and hides the
// select; on its own the panel offers every company. Settings' group card
// carries the title and description (Oct 25: one title per setting). With a
// company fixed it reports whether the company pays premiums (`onOverride`).
// A Settings switch row (components/settings/SettingsUI.jsx's look) inside
// this panel's padded card: title and description on the left, the shared
// switch on the right, the whole row its label. The switch is named by the title.
function InlineSwitchRow({ id, title, desc, checked, disabled, onChange, style }) {
  return (
    <label className="nx-set-row-main" htmlFor={id} style={style}>
      <span className="nx-set-row-text">
        <span className="nx-set-row-title">{title}</span>
        {desc && <span className="nx-set-row-desc" id={`${id}-desc`}>{desc}</span>}
      </span>
      <span className="nx-set-row-control">
        <Switch id={id} label={title} describedBy={desc ? `${id}-desc` : undefined} checked={checked} disabled={disabled} onChange={onChange} />
      </span>
    </label>
  );
}

export default function PayPremiums({ toastOk, toastErr, company: scoped = '', onOverride }) {
  const [companies, setCompanies] = useState(null);   // null while loading
  const [company, setCompany] = useState(scoped);
  useEffect(() => { if (scoped) setCompany(scoped); }, [scoped]);
  const [data, setData] = useState(null);
  const saved = useMemo(() => (data ? draftOf(data) : null), [data]);
  // A switch saved on click carries over a half-typed rule beside it (rebase).
  const { draft, setDraft, dirty: rawDirty, reset } = useDraft(saved, { rebase: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');   // '' | 'save' | 'enabled' | 'callBack'
  const [flipped, setFlipped] = useState(null);   // { enabled?, callBack? } while a switch saves

  useEffect(() => {
    let alive = true;
    api.getEntities()
      .then((d) => {
        if (!alive) return;
        const list = Array.isArray(d) ? d : [];
        setCompanies(list);
        setCompany((c) => c || list[0]?.id || '');
      })
      .catch(() => { if (alive) { setCompanies([]); setCompany(''); } });
    return () => { alive = false; };
  }, []);

  // Only the latest request lands (a slow answer for the company picked
  // before never overwrites the one picked now).
  const seq = useRef(0);
  const load = useCallback(() => {
    if (companies === null) return;
    const mine = ++seq.current;
    setErr('');
    setData(null);
    api.timePremiumsGet(company)
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the shift differentials.'); });
  }, [company, companies]);
  useEffect(() => { load(); }, [load]);

  // The typed draft, over the switches as they are saved; true once it landed.
  const save = async () => {
    setBusy('save');
    try {
      const body = bodyOf({ ...draft, enabled: saved.enabled, callBack: { ...draft.callBack, enabled: saved.callBack.enabled } });
      const next = await api.timePremiumsSet(company, body);
      setDraft(draftOf(next));
      setData(next);
      toastOk?.('Shift differentials saved.');
      return true;
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the shift differentials.');
      return false;
    } finally { setBusy(''); }
  };
  // A switch saves only itself, over the rule as saved - never the draft.
  // On a refusal it goes back to where it was.
  const flip = async (key, on) => {
    setBusy(key);
    setFlipped({ [key]: on });
    try {
      const body = key === 'enabled' ? { ...saved, enabled: on } : { ...saved, callBack: { ...saved.callBack, enabled: on } };
      const next = await api.timePremiumsSet(company, bodyOf(body));
      setData(next);
      toastOk?.(key === 'enabled'
        ? (on ? 'Shift differentials are on for this company.' : 'Shift differentials are off for this company.')
        : (on ? 'Call-back pay is on.' : 'Call-back pay is off.'));
    } catch (e) { toastErr?.(e?.message || 'Could not change that.'); }
    finally { setFlipped(null); setBusy(''); }
  };

  useEffect(() => { if (data && scoped) onOverride?.(!!data.enabled); }, [data, scoped, onOverride]);
  const dirty = rawDirty && !!saved && JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(saved));
  useGroupDirty(dirty, save);
  // The panel's own company select asks before it drops an unsaved rule.
  const pickCompany = async (id) => {
    if (dirty && !(await confirmDiscard())) return;
    reset();
    setCompany(id);
  };
  const enabledOn = flipped?.enabled ?? saved?.enabled;
  const callBackOn = flipped?.callBack ?? saved?.callBack.enabled;
  const setRule = (i, patch) => setDraft((d) => ({ ...d, differentials: d.differentials.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort());
  const sites = data?.sites || [];
  const siteName = (id) => sites.find((s) => s.id === id)?.name || id;

  return (
    <div data-testid="pay-premiums">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
          Hourly employees only. A finalized time sheet keeps the rules it was finalized with.
        </span>
        {!scoped && companies && companies.length > 0 && (
          <select className="form-input" aria-label="Company" value={company} onChange={(e) => pickCompany(e.target.value)} style={{ fontSize: 12.5, width: 'auto', maxWidth: 260 }}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </select>
        )}
        {busy && <Spinner size={14} />}
      </div>
      {err ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'hsl(var(--color-red))', paddingTop: 10 }}>
          <span style={{ flex: 1 }}>{err}</span>
          <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={load}>Retry</button>
        </div>
      ) : !data || !draft ? (
        <div style={{ marginTop: 12 }}><SkeletonBlocks count={2} height={36} borderRadius={8} /></div>
      ) : (
        <>
          <InlineSwitchRow id="pay-premiums-on" title="Pay Shift Differentials and Call-Back Pay" style={{ marginTop: 12 }}
            desc="For this company; off by default." checked={!!enabledOn} disabled={!!busy}
            onChange={(on) => flip('enabled', on)} />
          {enabledOn && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {draft.differentials.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No differentials yet. Add one below, or use call-back pay on its own.</div>
              )}
              {draft.differentials.map((r, i) => (
                <div key={r.id || `new-${i}`} data-testid="premium-rule" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, alignItems: 'end' }}>
                    <label style={lbl}>Name
                      <input className="form-input" type="text" maxLength={40} placeholder="Night Differential" aria-label="Differential name"
                        value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} style={{ fontSize: 12.5 }} />
                    </label>
                    <label style={lbl}>Pays
                      <select className="form-input" aria-label="Differential type" value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value })} style={{ fontSize: 12.5 }}>
                        <option value="flat">Flat $ per hour</option>
                        <option value="percent">Percent of base rate</option>
                      </select>
                    </label>
                    <label style={lbl}>{r.kind === 'percent' ? 'Percent' : 'Amount per hour'}
                      <input className="form-input" type="number" min="0" step={r.kind === 'percent' ? '0.5' : '0.01'} aria-label="Differential amount"
                        value={r.amount} onChange={(e) => setRule(i, { amount: e.target.value })} style={{ fontSize: 12.5 }} />
                    </label>
                    <label style={lbl}>From
                      <TimeField ariaLabel="Window start" value={r.start} step={15}
                        onChange={(v) => setRule(i, { start: v })} style={{ fontSize: 12.5 }} />
                    </label>
                    <label style={lbl}>To
                      <TimeField ariaLabel="Window end" value={r.end} step={15}
                        onChange={(v) => setRule(i, { end: v })} style={{ fontSize: 12.5 }} />
                    </label>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 4 }}>Days</span>
                    {DAYS.map(([l, n]) => (
                      <button key={l} type="button" aria-pressed={r.days.includes(n)} style={chip(r.days.includes(n))}
                        onClick={() => setRule(i, { days: toggleIn(r.days, n) })}>{l}</button>
                    ))}
                  </div>
                  {sites.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 4 }}>Sites</span>
                      {sites.map((s) => (
                        <button key={s.id} type="button" aria-pressed={r.sites.includes(s.id)} style={chip(r.sites.includes(s.id))}
                          onClick={() => setRule(i, { sites: toggleIn(r.sites, s.id) })}>{s.name}</button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{ruleSummary(r, siteName)}. No days picked = every day; no sites picked = every site.</span>
                    <button type="button" className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      onClick={() => setDraft((d) => ({ ...d, differentials: d.differentials.filter((_, j) => j !== i) }))}>
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>
                </div>
              ))}
              {draft.differentials.length < (data.maxRules || 20) && (
                <div>
                  <button type="button" className="secondary-btn" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    onClick={() => setDraft((d) => ({ ...d, differentials: [...d.differentials, blankRule()] }))}>
                    <Plus size={12} /> Add Differential
                  </button>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                A differential pays the hours worked inside its window on its own line, on top of regular and overtime pay. A window that crosses midnight counts from the day it starts. Overtime is not recalculated with the differential included - check with payroll whether your overtime rate must include it.
              </div>
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <InlineSwitchRow id="pay-premiums-callback" title="Call-Back Pay" checked={!!callBackOn} disabled={!!busy}
                  onChange={(on) => flip('callBack', on)}
                  desc="When someone clocks in again the same day after being clocked out for a while, and works less than the minimum, the shortfall is paid at the base rate. It is not counted as hours worked or toward overtime." />
                {callBackOn && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--muted)' }}>Minimum paid</span>
                      <input className="form-input" type="number" min="15" max="720" aria-label="Call-back minimum minutes" value={draft.callBack.minimumMin}
                        onChange={(e) => setDraft((d) => ({ ...d, callBack: { ...d.callBack, minimumMin: e.target.value } }))} style={{ width: 80, fontSize: 12.5 }} />
                      <span style={{ color: 'var(--muted)' }}>min</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--muted)' }}>After clocked out at least</span>
                      <input className="form-input" type="number" min="0" max="720" aria-label="Call-back gap minutes" value={draft.callBack.gapMin}
                        onChange={(e) => setDraft((d) => ({ ...d, callBack: { ...d.callBack, gapMin: e.target.value } }))} style={{ width: 80, fontSize: 12.5 }} />
                      <span style={{ color: 'var(--muted)' }}>min</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}
          {(enabledOn || dirty) && (
            <SaveRow dirty={dirty} busy={busy === 'save'} onSave={save} onDiscard={reset}
              note="Saves the differentials and the call-back minutes. The switches save when clicked." />
          )}
        </>
      )}
    </div>
  );
}
