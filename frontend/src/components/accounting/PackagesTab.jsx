import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FileDown, MessageSquareText, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput } from './Amount';
import AsyncSection, { SkeletonBlocks, Spinner } from '../AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { useNameResolver } from '../../lib/useNameResolver';
import { control } from './reportControls';
import { bookLabel, downloadBlob, entityText, periodText, reportDef, resolveConfig, runReport, withAdjustments } from './reportModel';
import { SkeletonBlocks as Blocks } from '../AsyncState';

// Accounting -> Packages (Neil, Sep 25). A lender asks for the same set of
// statements every quarter, for every property with a loan. A package is that
// set, kept under a name: pick memorized reports, put them in order, and
// "Build PDF" reads each one fresh from the ledger and hands back one PDF -
// a cover with the contents, then every statement.
//
// Only the list is stored. A memorized report with a named period ("Last
// Quarter") moves with the calendar, so the same package is right next
// quarter without being touched.
//
// Sep 30 (Neil, call of 09/29): each statement in a package can carry
// adjustments - an add-back and a note per line (the $100,000 gate booked as
// Repairs and Maintenance) - and the PDF then prints As Reported, Adjustment,
// Adjusted and Note, with the totals moved to match. The ledger is never
// touched; the adjustment lives on the package.

const blank = () => ({ id: '', name: '', description: '', shared: false, items: [], mine: true });

export default function PackagesTab() {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();
  const [packages, setPackages] = useState(null);
  const [reports, setReports] = useState([]);
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);       // the package on the right, being edited
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [build, setBuild] = useState(null);       // { done, of, title } while a PDF is being made
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adjusting, setAdjusting] = useState(null);   // index of the statement whose adjustments are open

  const load = useCallback(() => Promise.all([api.getAccountingPackages(), api.getAccountingSavedReports()])
    .then(([p, r]) => { setPackages(p || []); setReports(r || []); setError(''); return p || []; })
    .catch((e) => { setPackages((cur) => cur || []); setError(e?.message || 'Could not load the packages.'); return []; }), []);
  useEffect(() => {
    load().then((p) => setDraft((d) => d || (p[0] ? { ...p[0] } : null)));
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, [load]);

  const byId = useMemo(() => new Map(reports.map((r) => [r.id, r])), [reports]);
  const original = draft?.id ? (packages || []).find((p) => p.id === draft.id) : null;
  const shape = (p) => [p.name, p.description, p.shared, p.items.map((i) => [i.reportId, i.title, i.adjustments || []])];
  const dirty = !!draft && JSON.stringify(shape(draft)) !== JSON.stringify(original ? shape(original) : ['', '', false, []]);
  const canEdit = !!draft && (draft.mine || !draft.id);
  const unused = reports.filter((r) => !draft?.items.some((i) => i.reportId === r.id));
  const missing = draft?.items.filter((i) => !byId.has(i.reportId)).length || 0;

  const patch = (p) => { setDraft((d) => ({ ...d, ...p })); setNote(''); };
  const move = (i, by) => {
    const items = [...draft.items];
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    patch({ items });
  };

  const save = async () => {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      const body = { name: draft.name.trim(), description: draft.description || '', shared: !!draft.shared, items: draft.items.filter((i) => byId.has(i.reportId)).map((i) => ({ reportId: i.reportId, title: i.title || '', ...(i.adjustments?.length ? { adjustments: i.adjustments } : {}) })) };
      const out = draft.id ? await api.updateAccountingPackage(draft.id, body) : await api.createAccountingPackage(body);
      await load();
      setDraft({ ...out });
      setNote('Saved.');
    } catch (e) {
      setError(e?.message || 'Could not save the package.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteAccountingPackage(draft.id);
      const p = await load();
      setDraft(p[0] ? { ...p[0] } : null);
    } catch (e) {
      setError(e?.message || 'Could not delete the package.');
    }
  };

  // Every statement is read from the ledger now, one after another, then set
  // into one PDF. A statement that cannot be read stops the build: a package
  // that silently lost a statement is worse than no package.
  const buildPdf = async () => {
    const items = draft.items.filter((i) => byId.has(i.reportId));
    if (!items.length || build) return;
    setError('');
    setNote('');
    try {
      const statements = [];
      for (let i = 0; i < items.length; i += 1) {
        const report = byId.get(items[i].reportId);
        const title = items[i].title || report.name;
        setBuild({ done: i, of: items.length, title });
        const result = withAdjustments(await runReport(api, resolveConfig(report.config), entities), items[i].adjustments);
        statements.push({ title, result, entities });
      }
      setBuild({ done: items.length, of: items.length, title: 'Setting the pages' });
      // pdf-lib is large; it loads only when a PDF is asked for.
      const { buildPackagePdf } = await import('./reportPdf');
      const bytes = await buildPackagePdf({ name: draft.name.trim() || 'Reporting Package', description: draft.description, preparedBy: nameOf(myEmail) || '', statements });
      downloadBlob(`${(draft.name.trim() || 'Reporting-Package').replace(/[^A-Za-z0-9]+/g, '-')}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
      setNote(`PDF built - ${statements.length} ${statements.length === 1 ? 'statement' : 'statements'}.`);
    } catch (e) {
      setError(`The PDF was not built: ${e?.message || 'a statement could not be read.'}`);
    } finally {
      setBuild(null);
    }
  };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
  const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
  const describe = (r) => {
    const c = resolveConfig(r.config);
    return [reportDef(c.report).label, entityText(c, entities), periodText(c), c.report === 'cash-position' ? '' : bookLabel(c.book)].filter(Boolean).join(' · ');
  };

  return (
    <AsyncSection loading={packages === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 12, alignItems: 'start' }} className="acct-packages">
        <div style={{ ...card, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong style={{ fontSize: '0.86rem' }}>Packages</strong>
            <button type="button" className="secondary-btn" onClick={() => { setDraft(blank()); setNote(''); setError(''); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
              <Plus size={13} /> New Package
            </button>
          </div>
          {(packages || []).length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '6px 2px' }}>No packages yet. A package is a set of memorized reports sent out as one PDF.</div>}
          <div style={{ display: 'grid', gap: 2 }}>
            {(packages || []).map((p) => {
              const on = draft?.id === p.id;
              return (
                <button key={p.id} type="button" onClick={() => { setDraft({ ...p }); setNote(''); setError(''); setConfirmDelete(false); }} aria-pressed={on}
                  style={{ textAlign: 'left', border: 'none', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', font: 'inherit', background: on ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', color: 'var(--text-primary)' }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {p.items.length} {p.items.length === 1 ? 'statement' : 'statements'} · {p.mine ? (p.shared ? 'shared with the team' : 'only you') : `shared by ${nameOf(p.owner)}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ ...card, padding: 14 }}>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem', marginBottom: 10 }}>{error}</div>}
          {!draft ? (
            <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', padding: '18px 4px' }}>
              Start with New Package. You will need memorized reports to put in it - set one up on the Reports tab and press Memorize.
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) minmax(200px, 1.4fr)', gap: 10 }}>
                <div>
                  <label style={label} htmlFor="acct-pkg-name">Package Name</label>
                  <input id="acct-pkg-name" type="text" value={draft.name} maxLength={120} disabled={!canEdit} onChange={(e) => patch({ name: e.target.value })}
                    placeholder="F&M Bank - Valley Center - Quarterly" style={{ ...control, width: '100%' }} />
                </div>
                <div>
                  <label style={label} htmlFor="acct-pkg-desc">Prepared For (shown on the cover)</label>
                  <input id="acct-pkg-desc" type="text" value={draft.description || ''} maxLength={400} disabled={!canEdit} onChange={(e) => patch({ description: e.target.value })}
                    placeholder="Prepared for Farmers & Merchants Bank" style={{ ...control, width: '100%' }} />
                </div>
              </div>

              <div style={{ ...label, marginTop: 14 }}>Statements, in the order they are printed</div>
              {draft.items.length === 0 && <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', padding: '4px 0 8px' }}>Nothing in this package yet. Add a memorized report below.</div>}
              <div style={{ display: 'grid', gap: 4 }}>
                {draft.items.map((it, i) => {
                  const r = byId.get(it.reportId);
                  return (
                    <div key={it.reportId} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-color)', borderRadius: 8, padding: '5px 8px', background: r ? 'var(--bg-card)' : 'var(--bg-secondary)' }}>
                      <span style={{ width: 20, fontSize: '0.78rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}.</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <input type="text" value={it.title || ''} maxLength={120} disabled={!canEdit || !r} aria-label={`Title of statement ${i + 1}`}
                          onChange={(e) => patch({ items: draft.items.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)) })}
                          placeholder={r ? r.name : 'This memorized report is no longer available'} style={{ ...control, width: '100%', border: 'none', padding: 0, height: 22, fontWeight: 600, background: 'none' }} />
                        <div style={{ fontSize: '0.7rem', color: r ? 'var(--text-muted)' : 'var(--bad-fg, #dc2626)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r ? describe(r) : 'Deleted, or no longer shared with you. It is left out of the PDF - remove it or pick another.'}
                        </div>
                      </div>
                      {r && (
                        <button type="button" onClick={() => setAdjusting(i)} aria-label={`Adjustments on statement ${i + 1}`} title="Add-backs and notes on this statement's lines"
                          style={{ ...icon, gap: 4, alignItems: 'center', fontSize: '0.74rem', color: it.adjustments?.length ? 'var(--wk-brand, #2b45e1)' : 'var(--text-muted)', fontWeight: it.adjustments?.length ? 700 : 400 }}>
                          <MessageSquareText size={14} /> {it.adjustments?.length ? `${it.adjustments.length} ${it.adjustments.length === 1 ? 'adjustment' : 'adjustments'}` : 'Adjust'}
                        </button>
                      )}
                      {canEdit && (
                        <span style={{ display: 'inline-flex' }}>
                          <button type="button" style={icon} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move statement ${i + 1} up`}><ArrowUp size={14} /></button>
                          <button type="button" style={icon} onClick={() => move(i, 1)} disabled={i === draft.items.length - 1} aria-label={`Move statement ${i + 1} down`}><ArrowDown size={14} /></button>
                          <button type="button" style={icon} onClick={() => patch({ items: draft.items.filter((_, k) => k !== i) })} aria-label={`Remove statement ${i + 1}`}><Trash2 size={14} /></button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {canEdit && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <select value="" aria-label="Add a memorized report" disabled={!unused.length} style={{ ...control, minWidth: 260, maxWidth: '100%' }}
                    onChange={(e) => e.target.value && patch({ items: [...draft.items, { reportId: e.target.value, title: '' }] })}>
                    <option value="">{reports.length ? (unused.length ? 'Add a memorized report...' : 'Every memorized report is in this package') : 'No memorized reports yet'}</option>
                    {unused.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!draft.shared} onChange={(e) => patch({ shared: e.target.checked })} /> <Users size={13} /> Share with the accounting team
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <button type="button" className="primary-btn" onClick={buildPdf} disabled={!!build || dirty || !draft.items.some((i) => byId.has(i.reportId))}
                  title={dirty ? 'Save the package first' : 'Read every statement from the ledger and build one PDF'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                  {build ? <Spinner size={14} /> : <FileDown size={14} />} {build ? `Building ${Math.min(build.done + 1, build.of)} of ${build.of}` : 'Build PDF'}
                </button>
                {canEdit && (
                  <button type="button" className="secondary-btn" onClick={save} disabled={!dirty || !draft.name.trim() || saving} style={{ fontSize: '0.8rem' }}>
                    {saving ? 'Saving...' : draft.id ? 'Save Changes' : 'Save Package'}
                  </button>
                )}
                {build && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} role="status">{build.title}</span>}
                {!build && note && <span style={{ fontSize: '0.78rem', color: 'var(--ok-fg, #15803d)' }} role="status">{note}</span>}
                {!build && !note && dirty && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
                {!build && missing > 0 && <span style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{missing} {missing === 1 ? 'statement is' : 'statements are'} no longer available</span>}
                {canEdit && draft.id && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                    {confirmDelete ? (
                      <>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Delete this package?</span>
                        <button type="button" className="secondary-btn" style={{ fontSize: '0.76rem', color: 'var(--bad-fg, #dc2626)' }} onClick={remove}>Delete</button>
                        <button type="button" className="secondary-btn" style={{ fontSize: '0.76rem' }} onClick={() => setConfirmDelete(false)}>Keep</button>
                      </>
                    ) : (
                      <button type="button" style={{ ...icon, fontSize: '0.76rem', gap: 5, alignItems: 'center' }} onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete Package</button>
                    )}
                  </span>
                )}
              </div>
              {!canEdit && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 8 }}>Shared by {nameOf(draft.owner)}. You can build the PDF; only they can change the package.</div>}
            </>
          )}
        </div>
      </div>
      {adjusting !== null && draft?.items[adjusting] && byId.has(draft.items[adjusting].reportId) && (
        <AdjustmentsEditor item={draft.items[adjusting]} report={byId.get(draft.items[adjusting].reportId)} entities={entities} canEdit={canEdit} onClose={() => setAdjusting(null)}
          onSave={(adjustments) => { patch({ items: draft.items.map((x, k) => (k === adjusting ? { ...x, adjustments } : x)) }); setAdjusting(null); }} />
      )}
    </AsyncSection>
  );
}

// The lines of one statement, each with an add-back and a note. Saved on the
// package with Save Changes; the ledger is never touched.
function AdjustmentsEditor({ item, report, entities, canEdit, onClose, onSave }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [rows, setRows] = useState(() => Object.fromEntries((item.adjustments || []).map((a) => [a.account, { amount: a.amount || '', note: a.note || '' }])));
  const [q, setQ] = useState('');
  const [onlyAdjusted, setOnlyAdjusted] = useState(false);
  useEffect(() => {
    let alive = true;
    runReport(api, resolveConfig(report.config), entities).then((r) => { if (alive) setResult(r); }).catch((e) => { if (alive) setError(e?.message || 'Could not read the statement.'); });
    return () => { alive = false; };
  }, [report, entities]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const accounts = (result?.rows || []).filter((r) => r.kind === 'account' && r.code);
  const at = result ? result.columns.findIndex((c) => c.type === 'amount') : 0;
  const money = (n) => { const v = Number(n) || 0; const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 ? `(${s})` : s; };
  const shown = accounts.filter((a) => {
    const s = q.trim().toLowerCase();
    const has = rows[a.code] && (Number(rows[a.code].amount) || (rows[a.code].note || '').trim());
    return (!onlyAdjusted || has) && (!s || a.code.toLowerCase().includes(s) || (a.title || '').toLowerCase().includes(s));
  });
  const set = (code, p) => setRows((r) => ({ ...r, [code]: { amount: '', note: '', ...(r[code] || {}), ...p } }));
  const list = Object.entries(rows).map(([account, v]) => ({ account, amount: Number(v.amount) || 0, note: (v.note || '').trim() })).filter((a) => a.amount || a.note);
  const total = list.reduce((s, a) => s + a.amount, 0);
  const single = result && result.columns.filter((c) => c.type === 'amount').length === 1 && result.mode === 'single' && ['pnl', 'balance-sheet'].includes(result.config.report);
  const ctl = { ...control, height: 26, fontSize: '0.76rem' };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Adjustments" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '96vw', width: 'min(1040px, 96vw)', maxHeight: '92vh' }}>
        <div className="modal-header" style={{ padding: '12px 18px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Adjustments - {item.title || report.name}</h3>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
              An add-back in the statement's own sign (a negative amount on an expense takes it out), and a note the lender reads beside the line. {single ? 'The PDF prints As Reported, Adjustment, Adjusted and Note.' : 'This layout prints the notes only; amounts need a Total Only income statement or balance sheet.'}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '6px 18px 10px', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
              <Search size={12} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--text-muted)' }} />
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search account by name or code" aria-label="Search account by name or code" style={{ ...ctl, width: '100%', paddingLeft: 26 }} />
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyAdjusted} onChange={(e) => setOnlyAdjusted(e.target.checked)} /> Only lines with an adjustment
            </label>
            <span style={{ marginLeft: 'auto', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>{list.length} {list.length === 1 ? 'line' : 'lines'} · net adjustment <strong>{money(total)}</strong></span>
          </div>
          {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{error}</div>}
          {!result && !error && <Blocks count={4} />}
          {result && (
            <div className="acct-lines-wrap" style={{ maxHeight: 'calc(92vh - 230px)' }}>
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead><tr><th scope="col">Account</th><th scope="col" className="acct-num">As Reported</th><th scope="col" className="acct-num">Adjustment</th><th scope="col" className="acct-num">Adjusted</th><th scope="col">Note</th></tr></thead>
                <tbody>
                  {shown.map((a) => {
                    const v = rows[a.code] || { amount: '', note: '' };
                    const adj = Number(v.amount) || 0;
                    return (
                      <tr key={a.code}>
                        <td><span className="acct-code">{a.code}</span>{a.title}</td>
                        <td className="acct-num"><Amount value={a.values[at]} /></td>
                        <td className="acct-num"><AmountInput value={v.amount} disabled={!canEdit} aria-label={`Adjustment for ${a.code}`} placeholder="" onChange={(n) => set(a.code, { amount: n == null ? '' : n })} style={{ ...ctl, width: 130, textAlign: 'right' }} /></td>
                        <td className="acct-num" style={{ fontWeight: adj ? 700 : 400 }}><Amount value={(a.values[at] || 0) + adj} /></td>
                        <td style={{ whiteSpace: 'normal', minWidth: 260 }}><input type="text" value={v.note} maxLength={300} disabled={!canEdit} aria-label={`Note for ${a.code}`} placeholder="Why, for the lender" onChange={(e) => set(a.code, { note: e.target.value })} style={{ ...ctl, width: '100%' }} /></td>
                      </tr>
                    );
                  })}
                  {!shown.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '18px 10px' }}>{accounts.length ? 'No line matches.' : 'This statement has no account lines.'}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          {canEdit && <button type="button" className="primary-btn" onClick={() => onSave(list)} disabled={!result}>Keep Adjustments</button>}
        </div>
      </div>
    </div>
  );
}
