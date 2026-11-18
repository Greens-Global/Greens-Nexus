import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useGroupDirty } from '../lib/groupDirty';
import { useDraft } from '../lib/useDraft';
import { confirmDiscard } from '../lib/dialogGuard';
import { api } from '../api';
import { SkeletonBlocks, Spinner } from './AsyncState';
import SaveRow from './SaveRow';
import { SwitchRow } from './settings/SettingsUI';
import { parseTimerLists, guessPayItems } from '../lib/qbTimerLists';

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
// The form as saved: each class's own name ('' = the default), the QuickBooks
// company name, and the TIMERHDR create time (Charmi, 11/03/2026).
const formOf = (data) => (data ? { codes: draftOf(data), qb: data.quickbooksCompanyName || '', qbCreate: data.quickbooksCreateTime || '' } : null);
const trimmed = (f) => (f ? { codes: Object.fromEntries(Object.entries(f.codes).map(([k, v]) => [k, (v || '').trim()])), qb: (f.qb || '').trim(), qbCreate: (f.qbCreate || '').trim() } : null);

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
  // What the QuickBooks Timer Lists file said (Charmi, 11/06/2026): its
  // payroll items feed each box's suggestions; null = no file read yet.
  const [qbFile, setQbFile] = useState(null);
  const fileRef = useRef(null);

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

  // True once the names are saved. `qbCreate` undefined leaves the saved
  // create time alone (Use the Default resets names, never that number).
  const save = async (codes, qbName, kind, qbCreate = undefined) => {
    setBusy(kind);
    try {
      const next = await api.timeExportCodesSet(company, codes, qbName, qbCreate);
      setData(next);
      toastOk?.(kind === 'reset' ? 'Payroll export codes back to the default.' : 'Payroll export codes saved.');
      return true;
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the payroll export codes.');
      return false;
    } finally { setBusy(''); }
  };

  // Leave Customer:Job Blank saves on click (the Settings switch rule); the
  // saved names travel with it unchanged.
  // Old Timer Header (Charmi, 11/12/2026): QuickBooks 2022 and later import
  // through Import > IIF Files with no TIMERHDR; on brings it back. Saves on click.
  const setTimerHeader = async (on) => {
    setBusy('timer');
    try {
      const next = await api.timeExportCodesSet(company, saved?.codes || {}, undefined, undefined, undefined, on);
      setData(next);
      toastOk?.(on ? 'The QuickBooks file will carry the old Timer header.' : 'The QuickBooks file is ready for Import > IIF Files.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the switch.');
    } finally { setBusy(''); }
  };

  const setBlankJob = async (on) => {
    setBusy('job');
    try {
      const next = await api.timeExportCodesSet(company, saved?.codes || {}, undefined, undefined, on);
      setData(next);
      toastOk?.(on ? 'Customer:Job will be left blank in the QuickBooks file.' : 'Customer:Job will carry the work site again.');
    } catch (e) {
      toastErr?.(e?.message || 'Could not save the switch.');
    } finally { setBusy(''); }
  };

  // Fills the boxes from the Timer Lists file; nothing is saved until Save.
  const readTimerLists = async (file) => {
    if (!file || !form || !data) return;
    let text;
    try {
      text = typeof file.text === 'function' ? await file.text() : await new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result || ''));
        r.onerror = () => fail(r.error);
        r.readAsText(file);
      });
    } catch { toastErr?.('Could not read that file.'); return; }
    const got = parseTimerLists(text);
    if (!got.payrollItems.length && !got.createTime) {
      toastErr?.('That file has no payroll items or create time. Export it from QuickBooks with File > Utilities > Export > Timer Lists.');
      return;
    }
    const guess = guessPayItems(got.payrollItems);
    const known = new Set(got.payrollItems.map((n) => n.toLowerCase()));
    // A box keeps a name QuickBooks has; anything else takes the guess.
    const codes = { ...form.codes };
    for (const c of data.classes) {
      const cur = ((codes[c.key] || '').trim() || c.default).toLowerCase();
      if (guess[c.key] && !known.has(cur)) codes[c.key] = guess[c.key];
    }
    patch({ codes, qb: got.companyName || form.qb, qbCreate: got.createTime || form.qbCreate });
    setQbFile({ ...got, guessed: Object.keys(guess).length });
  };
  // A pay class whose name is not a payroll item in the file: QuickBooks refuses it.
  const missing = (key, def) => {
    if (!qbFile?.payrollItems?.length) return false;
    const name = ((form?.codes?.[key] || '').trim() || def).toLowerCase();
    return !qbFile.payrollItems.some((n) => n.toLowerCase() === name);
  };

  const anyCustom = (data?.classes || []).some((c) => c.custom) || !!data?.quickbooksCompanyName || !!data?.quickbooksCreateTime || !!data?.quickbooksBlankJob;
  useEffect(() => { if (data && scoped) onOverride?.(anyCustom); }, [data, scoped, anyCustom, onOverride]);
  // Spaces alone are no change: the server trims them away.
  const dirty = rawDirty && JSON.stringify(trimmed(form)) !== JSON.stringify(saved);
  const saveDraft = () => save(form.codes, form.qb, 'save', form.qbCreate);
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
          <select className="form-input" aria-label="Company" value={company} onChange={(e) => pickCompany(e.target.value)} style={{ fontSize: 13, width: 'auto', maxWidth: 260 }}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </select>
        )}
        {busy && <Spinner size={14} />}
      </div>
      {err ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'hsl(var(--color-red))', paddingTop: 10 }}>
          <span style={{ flex: 1 }}>{err}</span>
          <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={load}>Retry</button>
        </div>
      ) : !data || !form ? (
        <div style={{ marginTop: 12 }}><SkeletonBlocks count={2} height={36} borderRadius={8} /></div>
      ) : (
        <>
          {/* Read the payroll item names off her QuickBooks file (Charmi, 11/06/2026). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
            <span style={{ flex: 1, minWidth: 220, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
              {qbFile
                ? (qbFile.payrollItems.length
                  ? `Read ${qbFile.payrollItems.length} payroll items from QuickBooks${qbFile.guessed ? ` and matched ${qbFile.guessed}` : ''}. Check each box, then Save.`
                  : 'The file had no payroll items, only the company details. Type the names as QuickBooks shows them under Lists > Payroll Item List.')
                : 'If your QuickBooks has File > Utilities > Export > Timer Lists (2021 and earlier), read that file here and Nexus fills in the names. Otherwise type the payroll item names as QuickBooks shows them under Lists > Payroll Item List.'}
            </span>
            <input ref={fileRef} type="file" accept=".iif,.txt" hidden aria-label="QuickBooks Timer Lists file"
              onChange={(e) => { readTimerLists(e.target.files?.[0]); e.target.value = ''; }} />
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={() => fileRef.current?.click()}>
              Read QuickBooks File
            </button>
          </div>
          {qbFile?.payrollItems?.length > 0 && (
            <datalist id="qb-payroll-items">
              {qbFile.payrollItems.map((n) => <option key={n} value={n} />)}
            </datalist>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10, marginTop: 12 }}>
            {data.classes.map((c) => (
              <label key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                <span>{PAY_CLASS_LABELS[c.key] || c.key}</span>
                <input className="form-input" type="text" maxLength={data.maxLength || 31} placeholder={c.default}
                  aria-label={`${PAY_CLASS_LABELS[c.key] || c.key} code`} list={qbFile?.payrollItems?.length ? 'qb-payroll-items' : undefined}
                  value={form.codes[c.key] || ''} onChange={(e) => patch({ codes: { ...form.codes, [c.key]: e.target.value } })}
                  style={{ fontSize: 13 }} />
                {missing(c.key, c.default) && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>Not in this QuickBooks file - needed only if this pay is used</span>
                )}
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginTop: 12, maxWidth: 440 }}>
            <span>QuickBooks Company Name</span>
            <input className="form-input" type="text" maxLength={data.quickbooksCompanyMaxLength || 100}
              placeholder={data.quickbooksCompanyDefault || ''} aria-label="QuickBooks Company Name"
              value={form.qb} onChange={(e) => patch({ qb: e.target.value })} style={{ fontSize: 13 }} />
            <span style={{ fontSize: 12 }}>The company name in the QuickBooks IIF header. It must match the QuickBooks company file; leave it blank to use the company's name.</span>
          </label>
          {/* COMPANYCREATETIME (Charmi, 11/03/2026): without it the IIF carries 0
              and QuickBooks' Timer Activities import can refuse every row. */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', marginTop: 12, maxWidth: 440 }}>
            <span>QuickBooks Company Create Time</span>
            <input className="form-input" type="text" inputMode="numeric" maxLength={12}
              placeholder="e.g. 1361233702" aria-label="QuickBooks Company Create Time"
              value={form.qbCreate} onChange={(e) => patch({ qbCreate: e.target.value.replace(/[^0-9]/g, '') })} style={{ fontSize: 13 }} />
            <span style={{ fontSize: 12 }}>
              Only with Old Timer Header on (QuickBooks 2021 and earlier): File &gt; Utilities &gt; Export &gt; Timer Lists,
              open that file in Notepad and copy the number at the end of its TIMERHDR line.
            </span>
          </label>
          <div style={{ marginTop: 12 }}>
            <SwitchRow id="qb-timer-header" title="Old Timer Header (QuickBooks 2021 and Earlier)"
              desc="Off: the file is imported with File > Utilities > Import > IIF Files (QuickBooks 2022 and later). Turn on only for an older QuickBooks that imports time with Timer Activities."
              checked={!!data.quickbooksTimerHeader} disabled={!!busy} onChange={setTimerHeader} />
            <SwitchRow id="qb-blank-job" title="Leave Customer:Job Blank"
              desc="Turn on when the QuickBooks file has no customers for the work sites. Each row then carries only the employee, date, hours and payroll item, not billable."
              checked={!!data.quickbooksBlankJob} disabled={!!busy} onChange={setBlankJob} />
          </div>
          <SaveRow dirty={dirty} busy={busy === 'save'} onSave={saveDraft} onDiscard={reset}
            onUseDefault={anyCustom ? () => save({}, '', 'reset') : undefined} useDefaultBusy={busy === 'reset'}
            note="Applies to the next QuickBooks and Intacct payroll export." />
        </>
      )}
    </div>
  );
}
