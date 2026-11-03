import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGroupDirty } from '../lib/groupDirty';
import { useDraft } from '../lib/useDraft';
import { confirmDiscard } from '../lib/dialogGuard';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import SaveRow from './SaveRow';

// Payroll Export Codes (Neil, Oct 17 2026): the name each pay class carries in
// the QuickBooks IIF (payroll item) and the Intacct payroll memo, per company.
// The server holds the defaults (exactly the names the exports always used);
// a blank box reads the default, and Use the Default clears the company's
// names. Changing is administrator only, like Punch Rounding. The boxes are
// one draft with one Save row at the foot (the Settings save pattern).

export const PAY_CLASS_LABELS = {
  regular: 'Regular',
  overtime: 'Overtime (1.5x)',
  doubleTime: 'Double Time (2x)',
  holiday: 'Holiday',
  sick: 'Sick',
  vacation: 'Vacation',
  personal: 'Personal',
  shiftDifferential: 'Shift Differential',
  callBack: 'Call-Back Pay',
  mealPremium: 'Meal Premium',
  restPremium: 'Rest Premium',
  advanceRepayment: 'Salary Advance Repayment',
};

const draftOf = (data) => Object.fromEntries((data?.classes || []).map((c) => [c.key, c.custom ? c.code : '']));
// The form as saved: each class's own name ('' = the default) and the QuickBooks company name.
const formOf = (data) => (data ? { codes: draftOf(data), qb: data.quickbooksCompanyName || '' } : null);
const trimmed = (f) => (f ? { codes: Object.fromEntries(Object.entries(f.codes).map(([k, v]) => [k, (v || '').trim()])), qb: (f.qb || '').trim() } : null);

// `company` (Settings' scope picker, Oct 23) fixes the company and hides the
// select; on its own the panel offers every company. Settings' group card
// carries the title and description, so the panel draws neither (Oct 25):
// one title per setting. With a company fixed it reports whether that
// company has names of its own (`onOverride`), for the group's chip.
export default function PayrollExportCodes({ toastOk, toastErr, company: scoped = '', onOverride }) {
  const [companies, setCompanies] = useState(null);   // null while loading
  const [company, setCompany] = useState(scoped);
  useEffect(() => { if (scoped) setCompany(scoped); }, [scoped]);
  const [data, setData] = useState(null);
  // The QuickBooks company name the IIF header carries (Oct 19); blank = the company's own name.
  const saved = useMemo(() => formOf(data), [data]);
  const { draft: form, patch, dirty: rawDirty, reset } = useDraft(saved);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

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

  // Only the latest request lands, so a slow answer for the company picked
  // before never overwrites the one picked now.
  const seq = useRef(0);
  const load = useCallback(() => {
    if (companies === null) return;
    const mine = ++seq.current;
    setErr('');
    setData(null);
    api.timeExportCodesGet(company)
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the payroll export codes.'); });
  }, [company, companies]);
  useEffect(() => { load(); }, [load]);

  // True once the names are saved.
  const save = async (codes, qbName, kind) => {
    setBusy(kind);
    try {
      const next = await api.timeExportCodesSet(company, codes, qbName);
      setData(next);
      toastOk?.(kind === 'reset' ? 'Payroll export codes back to the default.' : 'Payroll export codes saved.');
      return true;
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the payroll export codes.');
      return false;
    } finally { setBusy(''); }
  };

  const anyCustom = (data?.classes || []).some((c) => c.custom) || !!data?.quickbooksCompanyName;
  useEffect(() => { if (data && scoped) onOverride?.(anyCustom); }, [data, scoped, anyCustom, onOverride]);
  // Spaces alone are no change: the server trims them away.
  const dirty = rawDirty && JSON.stringify(trimmed(form)) !== JSON.stringify(saved);
  const saveDraft = () => save(form.codes, form.qb, 'save');
  useGroupDirty(dirty, saveDraft);
  // The panel's own company select (outside Settings' scope picker) asks
  // before it drops unsaved names.
  const pickCompany = async (id) => {
    if (dirty && !(await confirmDiscard())) return;
    reset();
    setCompany(id);
  };

  return (
    <div data-testid="payroll-export-codes">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
          Leave a box blank to use the default shown in it. The names must match the payroll items in QuickBooks.
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
      ) : !data || !form ? (
        <div style={{ marginTop: 12 }}><SkeletonBlocks count={2} height={36} borderRadius={8} /></div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10, marginTop: 12 }}>
            {data.classes.map((c) => (
              <label key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                <span>{PAY_CLASS_LABELS[c.key] || c.key}</span>
                <input className="form-input" type="text" maxLength={data.maxLength || 31} placeholder={c.default}
                  aria-label={`${PAY_CLASS_LABELS[c.key] || c.key} code`}
                  value={form.codes[c.key] || ''} onChange={(e) => patch({ codes: { ...form.codes, [c.key]: e.target.value } })}
                  style={{ fontSize: 12.5 }} />
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginTop: 12, maxWidth: 440 }}>
            <span>QuickBooks Company Name</span>
            <input className="form-input" type="text" maxLength={data.quickbooksCompanyMaxLength || 100}
              placeholder={data.quickbooksCompanyDefault || ''} aria-label="QuickBooks Company Name"
              value={form.qb} onChange={(e) => patch({ qb: e.target.value })} style={{ fontSize: 12.5 }} />
            <span style={{ fontSize: 11.5 }}>The company name in the QuickBooks IIF header. It must match the QuickBooks company file; leave it blank to use the company's name.</span>
          </label>
          <SaveRow dirty={dirty} busy={busy === 'save'} onSave={saveDraft} onDiscard={reset}
            onUseDefault={anyCustom ? () => save({}, '', 'reset') : undefined} useDefaultBusy={busy === 'reset'}
            note="Applies to the next QuickBooks and Intacct payroll export." />
        </>
      )}
    </div>
  );
}
