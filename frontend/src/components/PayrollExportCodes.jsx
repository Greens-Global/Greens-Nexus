import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';

// Payroll Export Codes (Neil, Oct 17 2026): the name each pay class carries in
// the QuickBooks IIF (payroll item) and the Intacct payroll memo, per company.
// The server holds the defaults (exactly the names the exports always used);
// a blank box reads the default, and Reset to Default clears the company's
// names. Changing is administrator only, like Punch Rounding.

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
};

const draftOf = (data) => Object.fromEntries((data?.classes || []).map((c) => [c.key, c.custom ? c.code : '']));

// `company` (Settings' scope picker, Oct 23) fixes the company and hides the
// select; on its own the panel offers every company.
export default function PayrollExportCodes({ toastOk, toastErr, company: scoped = '' }) {
  const [companies, setCompanies] = useState(null);   // null while loading
  const [company, setCompany] = useState(scoped);
  useEffect(() => { if (scoped) setCompany(scoped); }, [scoped]);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  // The QuickBooks company name the IIF header carries (Oct 19); blank = the company's own name.
  const [qbDraft, setQbDraft] = useState('');
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
      .then((d) => { if (mine === seq.current) { setData(d); setDraft(draftOf(d)); setQbDraft(d?.quickbooksCompanyName || ''); } })
      .catch((e) => { if (mine === seq.current) setErr(e?.message || 'Could not load the payroll export codes.'); });
  }, [company, companies]);
  useEffect(() => { load(); }, [load]);

  const save = async (codes, qbName, kind) => {
    setBusy(kind);
    try {
      const saved = await api.timeExportCodesSet(company, codes, qbName);
      setData(saved);
      setDraft(draftOf(saved));
      setQbDraft(saved?.quickbooksCompanyName || '');
      toastOk?.(kind === 'reset' ? 'Payroll export codes reset to default.' : 'Payroll export codes saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save the payroll export codes.'); }
    setBusy('');
  };

  const anyCustom = (data?.classes || []).some((c) => c.custom) || !!data?.quickbooksCompanyName;
  const dirty = (data?.classes || []).some((c) => (draft[c.key] || '').trim() !== (c.custom ? c.code : ''))
    || qbDraft.trim() !== (data?.quickbooksCompanyName || '');

  return (
    <div data-testid="payroll-export-codes" style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Payroll Export Codes</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            The payroll item name each pay class carries in the QuickBooks IIF and the Intacct payroll memo, set per company. Leave a box blank to use the default shown in it. The names must match the payroll items in QuickBooks.
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
      ) : !data ? (
        <div style={{ marginTop: 12 }}><SkeletonBlocks count={2} height={36} borderRadius={8} /></div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10, marginTop: 12 }}>
            {data.classes.map((c) => (
              <label key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                <span>{PAY_CLASS_LABELS[c.key] || c.key}</span>
                <input className="form-input" type="text" maxLength={data.maxLength || 31} placeholder={c.default}
                  aria-label={`${PAY_CLASS_LABELS[c.key] || c.key} code`}
                  value={draft[c.key] || ''} onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                  style={{ fontSize: 12.5 }} />
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginTop: 12, maxWidth: 440 }}>
            <span>QuickBooks Company Name</span>
            <input className="form-input" type="text" maxLength={data.quickbooksCompanyMaxLength || 100}
              placeholder={data.quickbooksCompanyDefault || ''} aria-label="QuickBooks Company Name"
              value={qbDraft} onChange={(e) => setQbDraft(e.target.value)} style={{ fontSize: 12.5 }} />
            <span style={{ fontSize: 11.5 }}>The company name in the QuickBooks IIF header. It must match the QuickBooks company file; leave it blank to use the company's name.</span>
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="primary-btn" style={{ fontSize: 12 }} disabled={!!busy || !dirty}
              onClick={() => save(draft, qbDraft, 'save')}>Save</button>
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} disabled={!!busy || !anyCustom}
              onClick={() => save({}, '', 'reset')}>Reset to Default</button>
          </div>
        </>
      )}
    </div>
  );
}
