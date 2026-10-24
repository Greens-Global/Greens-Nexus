import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import { formatHHMM } from '../lib/datetime';

// Shift Differentials and Call-Back Pay (Neil, Oct 17 2026): per company, OFF
// by default. While off nothing on any time sheet changes. On, HR lists the
// differentials (a flat amount or a percent of the base rate per hour worked
// inside a time window, on certain days, at certain sites) and the call-back
// minimum. The server (pay_premiums.py) validates and prices; this card only
// edits the rule. Changing it is administrator only, like Punch Rounding.

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
// select; on its own the panel offers every company.
export default function PayPremiums({ toastOk, toastErr, company: scoped = '' }) {
  const [companies, setCompanies] = useState(null);   // null while loading
  const [company, setCompany] = useState(scoped);
  useEffect(() => { if (scoped) setCompany(scoped); }, [scoped]);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
      .then((d) => { if (mine === seq.current) { setData(d); setDraft(draftOf(d)); } })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the shift differentials.'); });
  }, [company, companies]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.timePremiumsSet(company, bodyOf(draft));
      setData(saved);
      setDraft(draftOf(saved));
      toastOk?.('Shift differentials saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the shift differentials.'); }
    setBusy(false);
  };

  const dirty = !!data && !!draft && JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(draftOf(data)));
  const setRule = (i, patch) => setDraft((d) => ({ ...d, differentials: d.differentials.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort());
  const sites = data?.sites || [];
  const siteName = (id) => sites.find((s) => s.id === id)?.name || id;

  return (
    <div data-testid="pay-premiums" style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Shift Differentials and Call-Back Pay</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            Extra pay per hour worked at night, on weekends or at certain sites, and a minimum paid time when someone is called back after clocking out. Set per company, off by default. Hourly employees only. A finalized time sheet keeps the rules it was finalized with.
          </span>
        </span>
        {!scoped && companies && companies.length > 0 && (
          <select className="form-input" aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={{ fontSize: 12.5, width: 'auto', maxWidth: 260 }}>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.enabled} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} />
            Pay shift differentials and call-back pay for this company
          </label>
          {draft.enabled && (
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
                      <input className="form-input" type="time" aria-label="Window start" value={r.start}
                        onChange={(e) => setRule(i, { start: e.target.value })} style={{ fontSize: 12.5 }} />
                    </label>
                    <label style={lbl}>To
                      <input className="form-input" type="time" aria-label="Window end" value={r.end}
                        onChange={(e) => setRule(i, { end: e.target.value })} style={{ fontSize: 12.5 }} />
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
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={draft.callBack.enabled}
                    onChange={(e) => setDraft((d) => ({ ...d, callBack: { ...d.callBack, enabled: e.target.checked } }))} />
                  Call-Back Pay
                </label>
                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0 24px', lineHeight: 1.45 }}>
                  When someone clocks in again the same day after being clocked out for a while, and works less than the minimum, the shortfall is paid at the base rate. It is not counted as hours worked or toward overtime.
                </div>
                {draft.callBack.enabled && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, paddingLeft: 24 }}>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="primary-btn" style={{ fontSize: 12 }} disabled={busy || !dirty} onClick={save}>Save</button>
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} disabled={busy || !dirty}
              onClick={() => setDraft(draftOf(data))}>Discard Changes</button>
          </div>
        </>
      )}
    </div>
  );
}
