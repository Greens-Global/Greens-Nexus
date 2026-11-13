import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, FileText, Trash2, Plus, Heart, Landmark, Wallet } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { currencyOptions, moneyPrefix } from '../asset/lib/currency';
import { timeTrackingText } from '../lib/timeTracking';
import { useNameResolver } from '../lib/useNameResolver';
import { DateField } from '../tasks/components';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../stepup/StepUp';
import MealWaiverCard from '../components/MealWaiverCard';
import { useTabDraft } from './useTabDraft';
import { Row, SectionHead, Field, EditButton, TabSaveRow } from './shared';
import { BOX, DATE_BOX, GRID, HINT, maskId } from './lib';
import { formatHoursWords } from '../lib/hoursText';

// ── Pay & Benefits (HR Section B - gated by hr_comp grant / owner) ───────────
// Read and edited in place (11/03/2026; it was the Pay, Benefits & Bank
// popup). Pay & Benefits is the one writer of PayrollRate (Charmi, Sep 30) -
// the time sheet only reads. The PAN is shown here read only; Compliance is
// its one editable home. `readOnly` (Oct 7): a manager viewing a direct
// report - no Edit, no upload or delete, and no bank accounts (the server
// sends none to them either).
const PAY_BASIS = [['salary', 'Salary'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['fixed_fee', 'Fixed Fee']];
const PAY_FREQ = [['monthly', 'Monthly'], ['semimonthly', 'Semi-Monthly'], ['biweekly', 'Bi-Weekly'], ['weekly', 'Weekly']];
// Default pay frequency by pay type (Charmi, Aug 4): hourly and US salary ->
// biweekly; India (INR) salary -> monthly.
const defaultPayFreq = (payBasis, currency) => (payBasis === 'hourly' ? 'biweekly' : (currency === 'INR' ? 'monthly' : 'biweekly'));
const BANK_TYPES = [['checking', 'Checking'], ['savings', 'Savings'], ['current', 'Current']];
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const BENEFIT_TYPES = [['health', 'Health'], ['dental', 'Dental'], ['vision', 'Vision'], ['life', 'Life'], ['disability', 'Disability'], ['retirement', 'Retirement / 401k / PF'], ['other', 'Other']];
// "California (Work site: GS Temecula, CA)" - the person's work state and why (work_state.py, Oct 20 2026).
const workStateText = (w) => (w?.state ? `${w.stateName || w.state} (${w.label})` : `Unknown - ${w?.label || 'no work site'}`);
const OT_RULES = [['ca', 'California (daily 8h / 12h, 7th day, weekly 40h)'], ['federal', 'Federal (weekly 40h only)'], ['none', 'None (no US overtime premium)']];
const COMP_DEFAULTS = { base: '', payBasis: 'salary', frequency: 'biweekly', currency: 'USD', effectiveDate: '', history: [], benefits: [], overtimeRule: '', fullDayHours: '8' };
const label = (list, v) => (list.find(([x]) => x === v) || [])[1] || v || '';
const money = (v, cur) => (v ? `${moneyPrefix(cur)}${Number(v).toLocaleString()}` : '-');
const otName = (k) => label(OT_RULES, k).split(' (')[0];
/** "CA 8810 · " for a workers' comp entry with a state / class code, else ''. */
const wcClassText = (r) => { const s = [r?.state, r?.classCode].filter(Boolean).join(' '); return s ? `${s} · ` : ''; };

export default function PayTab({ employee, readOnly = false, onGoCompliance, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [wc, setWc] = useState({ rates: [], history: [] });
  const [stubs, setStubs] = useState([]);
  const [stubPeriod, setStubPeriod] = useState('');
  const [stubBusy, setStubBusy] = useState(false);
  const [stepLocked, setStepLocked] = useState(false);   // comp/bank need a fresh step-up
  // A failed read is an error with Retry, never an empty record (11/11/2026):
  // an empty record offered Edit, and a save from it replaced the real pay
  // and bank accounts with blanks.
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const stubFileRef = useRef(null);
  const nameOf = useNameResolver();   // "Changed by" shows a name, never a raw email
  const thisYear = new Date().getFullYear();

  useEffect(() => {
    let live = true;
    api.getCompensation(employee.id)
      .then(r => {
        if (!live) return;
        setStepLocked(false);
        setLoadError('');
        setData({ comp: r.compensation || {}, bank: r.bank || [], payroll: r.payroll || {}, rateHistory: r.rateHistory || [], gstin: r.gstin || '', pan: r.pan || '', ownPayLocked: !!r.ownPayLocked });
      })
      .catch(e => {
        // Compensation/bank require a fresh step-up MFA - show the Verify gate.
        if (isStepUpRequired(e)) { if (live) setStepLocked(true); return; }
        if (live) { setData(null); setLoadError(e?.message || 'Could not load pay and benefits.'); }
      });
    if (!readOnly) api.getWorkersCompRates(employee.id).then(r => { if (live) setWc(r || { rates: [], history: [] }); }).catch(() => {});
    api.hrPaystubs(employee.id).then(r => { if (live) setStubs(Array.isArray(r) ? r : []); }).catch(() => {});
    return () => { live = false; };
  }, [employee.id, reload, readOnly]);

  // The draft: what the Save row writes (pay, time clock, benefits, bank,
  // GSTIN) plus a new workers' comp rate for a year.
  const saved = useMemo(() => {
    if (!data) return null;
    const comp = { ...COMP_DEFAULTS, ...data.comp };
    if (comp.overtimeRule === undefined || comp.overtimeRule === null) comp.overtimeRule = '';
    // A record saved before Sep 30 has no hours of its own - start from what the time sheet uses today.
    if (!data.comp.fullDayHours && data.payroll?.fullDayHours) comp.fullDayHours = String(data.payroll.fullDayHours);
    return { comp, bank: data.bank, gstin: data.gstin || '', wcYear: String(thisYear), wcRate: '', wcClass: '', wcState: '', wcDesc: '' };
  }, [data, thisYear]);

  const t = useTabDraft(saved, {
    label: 'Pay & Benefits',
    onSave: async (draft) => {
      // The insurer's sheet (Charmi / Neil, 11/05/2026): State | Class Code |
      // Description | Rate Per $100. A box left empty keeps what is in force
      // for that year, so a new year's rate keeps its class and a new class
      // keeps its rate.
      const base = (wc.rates || []).find(r => r.year <= Number(draft.wcYear));
      const classTyped = [draft.wcClass, draft.wcState, draft.wcDesc].some(v => (v || '').trim());
      let wcRate = draft.wcRate === '' ? null : Number(draft.wcRate);
      if (wcRate === null && classTyped) {
        if (!base) { toastErr("Enter the workers' comp Rate Per $100 of Wages too."); return false; }
        wcRate = base.ratePct;
      }
      if (wcRate !== null && !(wcRate >= 0 && wcRate <= 100)) { toastErr("The workers' comp rate is per $100 of wages, from 0 to 100."); return false; }
      const wcState = (draft.wcState || '').trim().toUpperCase();
      if (wcState && !/^[A-Z]{2}$/.test(wcState)) { toastErr('The workers\' comp state is its two-letter code, e.g. CA.'); return false; }
      const up = await ensureStepUp();
      if (!up.ok) { if (!up.cancelled) toastErr('Identity check did not complete.'); return false; }
      const payDirty = JSON.stringify({ comp: draft.comp, bank: draft.bank, gstin: draft.gstin }) !== JSON.stringify({ comp: saved.comp, bank: saved.bank, gstin: saved.gstin });
      try {
        if (payDirty) {
          const clean = { ...draft.comp }; delete clean.history;   // the server owns history
          // The PAN is left out: Compliance is where it changes (null = unchanged on the server).
          await api.saveCompensation(employee.id, { compensation: clean, bank: draft.bank, gstin: draft.gstin });
        }
        if (wcRate !== null) {
          await api.addWorkersCompRate(employee.id, {
            year: Number(draft.wcYear), ratePct: wcRate,
            classCode: (draft.wcClass || '').trim() || base?.classCode || '',
            state: wcState || base?.state || '',
            description: (draft.wcDesc || '').trim() || base?.description || '',
          });
        }
        toastOk('Pay & Benefits saved.');
        setReload(n => n + 1);
        return true;
      } catch (e) { toastErr(e?.message || 'Could not save compensation.'); return false; }
    },
  });

  if (stepLocked) return <StepUpNeeded label="Compensation, bank and paystub details are confidential." onVerified={() => setReload(n => n + 1)} />;

  const uploadStub = async (file) => {
    if (!file) return;
    setStubBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('period', stubPeriod);
      const created = await api.hrPaystubUpload(employee.id, form);
      setStubs(s => [created, ...s]);
      setStubPeriod('');
    } catch (e) { toastErr?.(e?.message || 'Could not upload the paystub.'); }
    finally { setStubBusy(false); if (stubFileRef.current) stubFileRef.current.value = ''; }
  };
  const openStub = async (id) => {
    try { const { url } = await api.getDocUrl(id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not open the paystub.'); }
  };
  // One record, gone for good: held on its row (HOLD_RECORD_MS); a refusal shows under the button.
  const deleteStub = async (id) => {
    await api.deleteEmployeeDoc(id);
    setStubs(s => s.filter(x => x.id !== id));
  };

  const d = t.draft || saved;
  const comp = d?.comp || {};
  const setC = (k, v) => t.patch({ comp: { ...comp, [k]: v } });
  const benefits = comp.benefits || [];
  const setBenefits = (list) => t.patch({ comp: { ...comp, benefits: list } });
  const bank = d?.bank || [];
  const setBank = (list) => t.patch({ bank: list });
  const gstinBad = !!d?.gstin && !GSTIN_RE.test(d.gstin);
  // GSTIN and PAN are Indian tax IDs: shown for people in India (or paid in INR),
  // and wherever one is already on file so nothing saved is hidden (Neil, 11/12/2026).
  const india = data?.payroll?.country === 'IN' || comp.currency === 'INR' || !!data?.gstin || !!data?.pan;
  const wcNow = (wc.rates || []).find(r => r.year <= thisYear);
  const payroll = data?.payroll || {};
  const locked = !!data?.ownPayLocked;
  const sel = (id, value, onChange, opts) => (
    <select id={id} className="form-input" style={BOX} value={value} onChange={ev => onChange(ev.target.value)}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <div>
      <SectionHead icon={Wallet} title="Pay & Benefits" first>
        <span style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Lock size={12} /> {readOnly ? 'Read only · your direct report' : 'Restricted · compensation grant'}
        </span>
        {!readOnly && data && !loadError && !t.editing && <EditButton onClick={t.startEdit} />}
      </SectionHead>
      {loadError ? <ErrorBanner message={loadError} onRetry={() => { setLoadError(''); setReload(n => n + 1); }} />
        : !data ? <SkeletonBlocks count={4} height={44} /> : (
        <>
          {t.editing && locked && (
            <div data-testid="own-pay-hint" style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lock size={12} /> Another administrator or HR sets your pay - you can still update your bank accounts.
            </div>
          )}

          <SectionHead title="Base Pay" />
          {t.editing ? (
            <fieldset disabled={locked} data-testid="comp-pay-fields" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div style={GRID}>
                <Field label="Base Amount" htmlFor="pay-base"><input id="pay-base" className="form-input" style={BOX} type="number" value={comp.base} onChange={ev => setC('base', ev.target.value)} placeholder="e.g. 90000" /></Field>
                <Field label="Currency" htmlFor="pay-currency">
                  <select id="pay-currency" className="form-input" style={BOX} value={comp.currency} onChange={ev => { const cur = ev.target.value; t.patch({ comp: { ...comp, currency: cur, frequency: defaultPayFreq(comp.payBasis, cur) } }); }}>
                    {currencyOptions().map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Pay Basis" htmlFor="pay-basis">{sel('pay-basis', comp.payBasis, b => t.patch({ comp: { ...comp, payBasis: b, frequency: defaultPayFreq(b, comp.currency) } }), PAY_BASIS)}</Field>
                <Field label="Pay Frequency" htmlFor="pay-frequency">{sel('pay-frequency', comp.frequency, v => setC('frequency', v), PAY_FREQ)}</Field>
                <Field label="Effective Date" hint="A changed base applies from this date; days before it keep the old rate. Leave the date as it is to correct the current record.">
                  <DateField value={comp.effectiveDate || ''} onChange={v => setC('effectiveDate', v || '')} title="Effective Date" placeholder="Pick a date" disabled={locked} style={DATE_BOX} />
                </Field>
              </div>
            </fieldset>
          ) : (
            <div>
              <Row label="Base" value={data.comp.base ? `${money(data.comp.base, data.comp.currency)} · ${label(PAY_BASIS, data.comp.payBasis)}` : ''} />
              <Row label="Frequency" value={label(PAY_FREQ, data.comp.frequency)} />
              <Row label="Effective" value={formatDate(data.comp.effectiveDate)} />
            </div>
          )}

          <SectionHead title="Time Clock" />
          {t.editing ? (
            <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div style={GRID}>
                <Field label="Overtime Rule" htmlFor="pay-ot" hint={payroll.workState?.byWorkState
                  ? `The default follows where they work: California is the California rule, another US state is Federal, India is None. ${payroll.workState.state ? `Work state: ${workStateText(payroll.workState)}.` : 'Work state unknown - give them a work site, or pick a rule here.'} The time sheet only reads this.`
                  : "The default follows the company's country: US is California, India is None. The time sheet only reads this."}>
                  <select id="pay-ot" className="form-input" style={BOX} value={comp.overtimeRule || ''} onChange={ev => setC('overtimeRule', ev.target.value)}>
                    <option value="">Company Default{payroll.defaultOvertimeRule ? ` (${otName(payroll.defaultOvertimeRule)})` : ''}</option>
                    {OT_RULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Full Day Hours" htmlFor="pay-fullday" hint="Salaried: a full day is this minus an hour, a half day is 4 hours; weekend pay is pro-rated against it. Hourly: the paid holiday credit.">
                  <input id="pay-fullday" className="form-input" type="number" min="1" max="24" step="0.5" style={BOX} value={comp.fullDayHours} onChange={ev => setC('fullDayHours', ev.target.value)} placeholder="8" />
                </Field>
              </div>
            </fieldset>
          ) : (
            <div>
              <Row label="Overtime Rule" value={`${otName(payroll.overtimeRule) || '-'}${data.comp.overtimeRule ? ''
                : (payroll.defaultOvertimeRule && payroll.defaultOvertimeRule !== payroll.overtimeRule
                  ? ` (the company default is now ${otName(payroll.defaultOvertimeRule)} - not applied yet)`
                  : ' (company default)')}`} />
              {/* Where they work decides the default rule (Charmi, Oct 20): California work state -> California rule. */}
              {payroll.workState?.byWorkState && <Row label="Work State" value={workStateText(payroll.workState)} />}
              <Row label="Full Day Hours" value={payroll.fullDayHours ? formatHoursWords(payroll.fullDayHours, { compact: true }) : ''} />
            </div>
          )}
          {/* Read only: set on the person's role in Settings > Access, beside the screen-share exemption (Visesh, 10/02). */}
          <div data-testid="comp-time-tracking"><Row label="Time Tracking" value={timeTrackingText(payroll)} /></div>
          {/* CA-rule hourly staff only (Oct 17 2026): the meal period waiver in Nexus Sign. */}
          <MealWaiverCard email={employee.workEmail} />

          {!readOnly && (
            <>
              <SectionHead title="Workers' Comp" />
              {t.editing && (
                <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                  <div style={GRID} data-testid="comp-workers-comp">
                    <Field label="Effective Year" htmlFor="comp-wc-year">
                      <input id="comp-wc-year" className="form-input" type="number" min="2000" max={thisYear + 1} step="1" style={BOX} value={d.wcYear} onChange={ev => t.patch({ wcYear: ev.target.value })} />
                    </Field>
                    <Field label="State" htmlFor="comp-wc-state">
                      <input id="comp-wc-state" className="form-input" maxLength={2} style={BOX} value={d.wcState} onChange={ev => t.patch({ wcState: ev.target.value.toUpperCase() })} placeholder={wcNow?.state || 'e.g. CA'} />
                    </Field>
                    <Field label="Class Code" htmlFor="comp-wc-class">
                      <input id="comp-wc-class" className="form-input" maxLength={20} style={BOX} value={d.wcClass} onChange={ev => t.patch({ wcClass: ev.target.value })} placeholder={wcNow?.classCode || 'e.g. 8810'} />
                    </Field>
                    <Field label="Rate Per $100 of Wages" htmlFor="comp-wc-rate">
                      <input id="comp-wc-rate" className="form-input" type="number" min="0" max="100" step="0.01" style={BOX} value={d.wcRate} onChange={ev => t.patch({ wcRate: ev.target.value })} placeholder={wcNow ? `In force: ${wcNow.ratePct}` : 'e.g. 0.84'} />
                    </Field>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Field label="Description" htmlFor="comp-wc-desc">
                      <input id="comp-wc-desc" className="form-input" maxLength={300} style={BOX} value={d.wcDesc} onChange={ev => t.patch({ wcDesc: ev.target.value })} placeholder={wcNow?.description || 'The insurer\'s class description, e.g. Clerical Office Employees-NOC'} />
                    </Field>
                  </div>
                </fieldset>
              )}
              <div style={HINT}>
                As on the insurer&apos;s sheet: State, Class Code, Description and Rate Per $100 of Wages. Accounting &gt; Compensation charges this rate on every $100 of Bonus plus Salaried / Hourly Payroll from the effective year on, until a later year has its own rate.
                {wcNow ? ` In force now: ${wcClassText(wcNow)}$${wcNow.ratePct} per $100 (from ${wcNow.year}).` : ' No rate set yet.'} A new entry for a year replaces it there (a box left empty keeps what is in force); every earlier entry stays below.
              </div>
              {wc.history?.length > 0 && wc.history.map((h, i) => {
                const inForce = wc.rates.some(r => r.year === h.year && r.setAt === h.setAt);
                return (
                  <div key={`${h.year}-${h.setAt}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--line)', color: inForce ? 'var(--ink)' : 'var(--muted)' }}>
                    <span>{h.year} · {wcClassText(h)}${h.ratePct} per $100{h.description ? ` · ${h.description}` : ''}{inForce ? '' : ' (replaced)'}</span>
                    <span>{h.setBy ? nameOf(h.setBy) : ''}{h.setAt ? ` · ${formatDate(h.setAt.slice(0, 10))}` : ''}</span>
                  </div>
                );
              })}
            </>
          )}

          <SectionHead title="Pay History" />
          {(data.rateHistory || []).length === 0
            ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>No pay recorded yet.</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    {['Base', 'Basis', 'Currency', 'Effective', 'Changed By'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 ? 'right' : 'left', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', padding: '6px 8px 6px 0', borderBottom: '1px solid var(--line)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rateHistory.map((h, i) => (
                    <tr key={h.id || i} style={{ fontWeight: i === 0 ? 700 : 400 }}>
                      <td style={{ textAlign: 'right', padding: '7px 8px 7px 0', borderBottom: '1px solid var(--line)' }}>{money(h.base, h.currency)}{h.payBasis === 'hourly' ? '/hr' : '/mo'}</td>
                      <td style={{ padding: '7px 8px 7px 0', borderBottom: '1px solid var(--line)' }}>{label(PAY_BASIS, h.payBasis)}</td>
                      <td style={{ padding: '7px 8px 7px 0', borderBottom: '1px solid var(--line)' }}>{h.currency}</td>
                      <td style={{ padding: '7px 8px 7px 0', borderBottom: '1px solid var(--line)' }}>{h.effectiveDate ? formatDate(h.effectiveDate) : 'Since always'}</td>
                      <td style={{ padding: '7px 0', borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>{h.changedBy ? nameOf(h.changedBy) : '-'}{h.changedAt ? ` · ${formatDate(h.changedAt.slice(0, 10))}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

          <SectionHead icon={Heart} title="Benefits & Deductions" />
          {t.editing ? (
            <>
              {benefits.map((bn, i) => (
                <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '4px 0 12px' }}>
                  <div style={GRID}>
                    <Field label="Type" htmlFor={`bn-type-${i}`}>{sel(`bn-type-${i}`, bn.type, v => setBenefits(benefits.map((x, j) => (j === i ? { ...x, type: v } : x))), BENEFIT_TYPES)}</Field>
                    <Field label="Plan / Provider" htmlFor={`bn-plan-${i}`}><input id={`bn-plan-${i}`} className="form-input" style={BOX} value={bn.plan || ''} onChange={ev => setBenefits(benefits.map((x, j) => (j === i ? { ...x, plan: ev.target.value } : x)))} /></Field>
                    <Field label="Per-Paycheck Deduction" htmlFor={`bn-ded-${i}`}><input id={`bn-ded-${i}`} className="form-input" style={BOX} type="number" value={bn.deduction ?? ''} onChange={ev => setBenefits(benefits.map((x, j) => (j === i ? { ...x, deduction: ev.target.value } : x)))} placeholder={`in ${comp.currency}`} /></Field>
                    <Field label="Note" htmlFor={`bn-note-${i}`}><input id={`bn-note-${i}`} className="form-input" style={BOX} value={bn.note || ''} onChange={ev => setBenefits(benefits.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} /></Field>
                  </div>
                  <button type="button" onClick={() => setBenefits(benefits.filter((_, j) => j !== i))} style={{ marginTop: 8, background: 'none', border: 'none', color: 'hsl(var(--color-red))', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0 }}><Trash2 size={12} /> Remove</button>
                </div>
              ))}
              <button type="button" className="secondary-btn" onClick={() => setBenefits([...benefits, { type: 'health', plan: '', deduction: '', note: '' }])} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}><Plus size={13} /> Add Benefit / Deduction</button>
            </>
          ) : (data.comp.benefits || []).length === 0
            ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>None recorded.</div>
            : data.comp.benefits.map((bn, i) => <Row key={`bn${i}`} label={label(BENEFIT_TYPES, bn.type)} value={[bn.plan, bn.deduction && `${money(bn.deduction, data.comp.currency)}/paycheck`, bn.note].filter(Boolean).join(' · ')} />)}

          {!readOnly && (
            <>
              <SectionHead icon={Landmark} title="Bank Accounts" />
              {t.editing ? (
                <>
                  {bank.map((acc, i) => {
                    const setAcc = (k, v) => setBank(bank.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                    return (
                      <div key={i} style={{ borderBottom: '1px solid var(--line)', padding: '4px 0 12px' }}>
                        <div style={GRID}>
                          <Field label="Account Holder" htmlFor={`bk-holder-${i}`}><input id={`bk-holder-${i}`} className="form-input" style={BOX} value={acc.holder || ''} onChange={ev => setAcc('holder', ev.target.value)} /></Field>
                          <Field label="Bank Name" htmlFor={`bk-name-${i}`}><input id={`bk-name-${i}`} className="form-input" style={BOX} value={acc.bankName || ''} onChange={ev => setAcc('bankName', ev.target.value)} /></Field>
                          <Field label="Account Number" htmlFor={`bk-number-${i}`}><input id={`bk-number-${i}`} className="form-input" style={BOX} value={acc.number || ''} onChange={ev => setAcc('number', ev.target.value)} /></Field>
                          <Field label="Routing / IFSC" htmlFor={`bk-routing-${i}`}><input id={`bk-routing-${i}`} className="form-input" style={BOX} value={acc.routingOrIfsc || ''} onChange={ev => setAcc('routingOrIfsc', ev.target.value)} /></Field>
                          <Field label="Type" htmlFor={`bk-type-${i}`}>{sel(`bk-type-${i}`, acc.type || 'checking', v => setAcc('type', v), BANK_TYPES)}</Field>
                        </div>
                        <button type="button" onClick={() => setBank(bank.filter((_, j) => j !== i))} style={{ marginTop: 8, background: 'none', border: 'none', color: 'hsl(var(--color-red))', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0 }}><Trash2 size={12} /> Remove</button>
                      </div>
                    );
                  })}
                  <button type="button" className="secondary-btn" onClick={() => setBank([...bank, { holder: '', bankName: '', number: '', routingOrIfsc: '', type: 'checking' }])} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}><Plus size={13} /> Add Bank Account</button>
                  {india && <div style={GRID}>
                    <Field label="GSTIN" htmlFor="comp-gstin">
                      <input id="comp-gstin" className="form-input" style={{ ...BOX, textTransform: 'uppercase', borderColor: gstinBad ? 'hsl(var(--color-red))' : undefined }} value={d.gstin} maxLength={15}
                        onChange={ev => t.patch({ gstin: ev.target.value.toUpperCase().replace(/\s/g, '') })} placeholder="e.g. 27ABCDE1234F1Z5" aria-invalid={gstinBad} />
                      <div style={{ ...HINT, color: gstinBad ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
                        {gstinBad ? 'Not a valid GSTIN - 15 characters, like 27ABCDE1234F1Z5.' : "Printed on the person's invoices when set."}
                      </div>
                    </Field>
                  </div>}
                </>
              ) : (
                <>
                  {data.bank.length === 0
                    ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>None recorded.</div>
                    : data.bank.map((acc, i) => <Row key={`bk${i}`} label={acc.bankName || 'Account'} value={[acc.holder, maskId(acc.number), acc.routingOrIfsc, label(BANK_TYPES, acc.type)].filter(Boolean).join(' · ')} />)}
                  {data.gstin && <Row label="GSTIN" value={maskId(data.gstin)} />}
                </>
              )}
              {/* PAN: one editable home - Compliance (11/03/2026). */}
              {india && <div data-testid="pay-pan" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', width: 130, flexShrink: 0 }}>PAN</span>
                <span style={{ fontSize: 13, color: data.pan ? 'var(--ink)' : 'var(--muted)', flex: 1 }}>{data.pan ? maskId(data.pan) : '-'}</span>
                {onGoCompliance && (
                  <button type="button" className="secondary-btn" onClick={onGoCompliance} style={{ fontSize: 12 }}>Edit in Compliance</button>
                )}
              </div>}
            </>
          )}

          {t.editing && <TabSaveRow t={t} saveDisabled={gstinBad} note="Saves pay, time clock, workers' comp, benefits and bank accounts." />}

          <SectionHead icon={FileText} title="Paystubs" />
          {!readOnly && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
              <input className="form-input" placeholder='Pay period, e.g. "Jun 16 - Jun 30, 2026"' value={stubPeriod} data-nx-noguard=""
                onChange={ev => setStubPeriod(ev.target.value)} style={{ flex: 1, minWidth: 200, fontSize: 13 }} aria-label="Pay Period" />
              <input ref={stubFileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={ev => uploadStub(ev.target.files?.[0])} />
              <button type="button" className="secondary-btn" disabled={stubBusy} onClick={() => stubFileRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                {stubBusy ? 'Uploading…' : 'Upload PDF'}
              </button>
            </div>
          )}
          {stubs.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 0' }}>{readOnly ? 'None uploaded.' : 'None uploaded. The employee sees these under My HR.'}</div>
            : stubs.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <FileText size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <button type="button" onClick={() => openStub(s.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', padding: 0 }}>
                  {s.fileName}
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatDate(s.createdAt?.slice(0, 10))}</span>
                {!readOnly && (
                  <HoldButton label="Delete" doneLabel="Deleted" size="sm" holdMs={HOLD_RECORD_MS}
                    ariaLabel="Delete Paystub" onConfirm={() => deleteStub(s.id)} />
                )}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
