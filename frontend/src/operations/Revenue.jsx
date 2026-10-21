// Operations > ECRI Management (Neil, Oct 20 2026; renamed from Revenue
// Management to Cubby's words, Miranda, Oct 21 2026): rent changes for
// EXISTING tenants (in self storage, the existing-customer rate increase).
//
// "Does the rate need to go up or down? And what pricing strategy am I
// adding? ... create a strategy and apply it to a unit type or to a person."
//
// Three parts: the tenant table (rent vs today's street rate, stay, last rent
// change, balance), saved strategies, and batches (Draft -> Approved ->
// Notified -> Applied). Every number in a preview comes from the server
// (backend/ops_revenue.py); saving a batch recomputes it there. Nexus never
// emails a tenant: staff print the notice letters or use the mail-merge
// export. Push to Cubby is locked behind the Operations switch (Settings >
// Global Settings > Operations, OFF by default - Visesh, Oct 21 2026): while it
// is off staff enter each new rent in Cubby by hand and mark the row Entered in
// Cubby; with it on (and a Manager-role key) a row can be pushed, one at a time.
// Street rates for new renters are Market Rates' job, not this tab's.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, FileText, Download, Send, Check, X } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { formatDate, formatDateTime } from '../lib/datetime';
import { money } from './model';
import SectionPicker from './SectionPicker';
import { csvName, downloadCsv } from './csv';

const cash = (c) => money(c, { exact: true });

// Over/Under Standard Rate (Miranda, Oct 21 2026: Cubby's words, as a percent):
// (current rate - current standard rate) / current standard rate. Negative =
// the tenant pays under the standard rate. null when there is no standard rate.
export function overUnderPct(t) {
  if (!t?.street) return null;
  return Math.round(((t.rent - t.street) / t.street) * 1000) / 10;
}
export const overUnderText = (p) => (p == null ? '-' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);
// Under the standard rate reads red; at or over it, the table's own color.
function OverUnderCell({ t }) {
  const p = overUnderPct(t);
  return (
    <td data-th="Over/Under Standard Rate" className="num" data-under={p != null && p < 0}
      style={p != null && p < 0 ? { color: 'var(--bad-fg)', fontWeight: 600 } : undefined}>
      {overUnderText(p)}
    </td>
  );
}
const signed = (c) => `${c > 0 ? '+' : c < 0 ? '-' : ''}${cash(Math.abs(c))}`;
const SECTIONS = [
  { key: 'tenants', label: 'Tenants' },
  { key: 'strategies', label: 'Strategies' },
  { key: 'batches', label: 'Rent Changes' },
];
const STATUS = {
  draft: ['pill-muted', 'Draft'], approved: ['pill-info', 'Approved'], notified: ['status-pending', 'Notified'],
  applied: ['status-approved', 'Applied'], canceled: ['pill-muted', 'Canceled'],
};
const ROW_STATUS = {
  // "pushed" / "failed" come from Push to Cubby (only with the Operations switch on).
  pending: ['pill-muted', 'Not Yet in Cubby'], pushed: ['status-approved', 'Pushed to Cubby'],
  entered: ['status-approved', 'Entered in Cubby'], failed: ['status-rejected', 'Push Failed'], removed: ['pill-muted', 'Removed'],
};
const CAP_LABEL = { street: 'Capped at standard rate', street_plus: 'Capped at standard rate +', none: 'No cap' };

function stay(months) {
  if (months == null) return '-';
  const y = Math.floor(months / 12), m = months % 12;
  return y ? `${y}y ${m}m` : `${m}m`;
}

// The first of the month on or after today + notice days, as YYYY-MM-DD.
export function defaultEffective(asOf, noticeDays) {
  const d = new Date(`${asOf || new Date().toISOString().slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() + Number(noticeDays || 30));
  if (d.getDate() !== 1) { d.setMonth(d.getMonth() + 1); d.setDate(1); }
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function filterTenants(rows, f) {
  const q = (f.q || '').trim().toLowerCase();
  return rows.filter((t) => {
    if (f.unitType && t.unitType !== f.unitType) return false;
    if (q && !`${t.tenant} ${t.unit}`.toLowerCase().includes(q)) return false;
    if (f.underPct !== '' && f.underPct != null) {
      const p = overUnderPct(t);     // the column's own figure: under by more than X% = below -X%
      if (!(p != null && -p > Number(f.underPct))) return false;
    }
    if (f.stayed !== '' && f.stayed != null && !((t.monthsStayed ?? -1) > Number(f.stayed))) return false;
    if (f.noIncrease !== '' && f.noIncrease != null) {
      const since = t.monthsSinceIncrease ?? t.monthsStayed ?? 0;
      if (since < Number(f.noIncrease)) return false;
    }
    return true;
  });
}

function Badge({ map, value }) {
  const [cls, label] = map[value] || ['pill-muted', value];
  return <span className={`status-badge ${cls}`}>{label}</span>;
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 };

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Strategy form (used to save one, and to try one in a preview) ────────────

export function blankStrategy(defaults = {}) {
  return {
    name: '', method: defaults.method || 'percent', increase_pct: defaults.increasePct ?? 8,
    increase_dollars: (defaults.increaseCents || 0) / 100 || 25, cap_mode: defaults.capMode || 'street',
    cap_pct: defaults.capPct ?? 0, round_dollar: defaults.roundDollar ?? true,
    min_months_in: defaults.minMonthsIn ?? 12, min_months_since: defaults.minMonthsSince ?? 12,
    skip_balance: defaults.skipBalance ?? true, notice_days: defaults.noticeDays ?? 30,
  };
}

const fromSaved = (s) => ({
  name: s.name, method: s.method, increase_pct: s.increasePct, increase_dollars: s.increaseCents / 100,
  cap_mode: s.capMode, cap_pct: s.capPct, round_dollar: s.roundDollar, min_months_in: s.minMonthsIn,
  min_months_since: s.minMonthsSince, skip_balance: s.skipBalance, notice_days: s.noticeDays,
});

export function toBody(f) {
  return {
    name: (f.name || '').trim() || 'Untitled Strategy', method: f.method,
    increase_pct: f.method === 'percent' ? Number(f.increase_pct) || 0 : 0,
    increase_cents: f.method === 'amount' ? Math.round((Number(f.increase_dollars) || 0) * 100) : 0,
    cap_mode: f.cap_mode, cap_pct: f.cap_mode === 'street_plus' ? Number(f.cap_pct) || 0 : 0,
    round_dollar: !!f.round_dollar, min_months_in: Number(f.min_months_in) || 0,
    min_months_since: Number(f.min_months_since) || 0, skip_balance: !!f.skip_balance,
    notice_days: Number(f.notice_days) || 30,
  };
}

function StrategyFields({ f, set }) {
  const up = (k) => (e) => set({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Strategy Name"><input className="form-input" value={f.name} onChange={up('name')} placeholder="Annual Increase 8%" maxLength={120} /></Field>
      <div style={grid}>
        <Field label="Increase By">
          <select className="form-input" value={f.method} onChange={up('method')} aria-label="Increase method">
            <option value="percent">Percent (+X%)</option>
            <option value="amount">Dollar Amount (+$Y)</option>
          </select>
        </Field>
        {f.method === 'percent'
          ? <Field label="Increase %"><input className="form-input" type="number" min="0" max="100" step="0.5" value={f.increase_pct} onChange={up('increase_pct')} aria-label="Increase percent" /></Field>
          : <Field label="Increase $"><input className="form-input" type="number" min="0" step="1" value={f.increase_dollars} onChange={up('increase_dollars')} aria-label="Increase dollars" /></Field>}
        <Field label="Cap">
          <select className="form-input" value={f.cap_mode} onChange={up('cap_mode')} aria-label="Cap">
            <option value="street">At Current Standard Rate</option>
            <option value="street_plus">At Current Standard Rate + %</option>
            <option value="none">No Cap</option>
          </select>
        </Field>
        {f.cap_mode === 'street_plus' && (
          <Field label="Standard Rate + %"><input className="form-input" type="number" min="0" max="100" step="0.5" value={f.cap_pct} onChange={up('cap_pct')} aria-label="Cap percent over standard rate" /></Field>
        )}
      </div>
      <div style={grid}>
        <Field label="Months Since Move-In" hint="At least this many, counted to the effective date.">
          <input className="form-input" type="number" min="0" max="240" value={f.min_months_in} onChange={up('min_months_in')} aria-label="Months since move-in" />
        </Field>
        <Field label="Months Since Last Increase" hint="Uses Cubby's last rent change date, else the last change made here.">
          <input className="form-input" type="number" min="0" max="240" value={f.min_months_since} onChange={up('min_months_since')} aria-label="Months since last increase" />
        </Field>
        <Field label="Notice Days" hint="California requires written notice before a rent change. 30 days is the default; set what the rental agreement requires.">
          <input className="form-input" type="number" min="1" max="365" value={f.notice_days} onChange={up('notice_days')} aria-label="Notice days" />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!f.skip_balance} onChange={up('skip_balance')} /> Skip tenants with a balance due
        </label>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!f.round_dollar} onChange={up('round_dollar')} /> Round new rent to a whole dollar
        </label>
      </div>
      <p className="ops-note" style={{ margin: 0 }}>
        Tenants who already have a rent change scheduled in Cubby, or are in an open batch here, are always skipped.
      </p>
    </div>
  );
}

function StrategyModal({ initial, defaults, onClose, onSaved }) {
  const [f, setF] = useState(() => (initial ? fromSaved(initial) : blankStrategy(defaults)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.opsRevenueSaveStrategy(initial?.id, toBody(f));
      onSaved();
    } catch (e) { setErr(e?.message || "Couldn't save the strategy."); } finally { setBusy(false); }
  };
  return (
    <Modal title={initial ? 'Edit Strategy' : 'New Strategy'} onClose={onClose} minHeight="60vh"
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" onClick={save} disabled={busy || !f.name.trim()}>{busy ? 'Saving…' : 'Save Strategy'}</button>
      </>}>
      {err && <ErrorBanner message={err} />}
      <StrategyFields f={f} set={setF} />
    </Modal>
  );
}

// ── Apply a strategy: choose, preview, save as a Draft ───────────────────────

function Impact({ totals }) {
  const cards = [
    ['Tenants Changing', `${totals.eligible} of ${totals.inScope}`, totals.skipped ? `${totals.skipped} skipped` : 'none skipped'],
    ['Monthly Impact', signed(totals.monthlyIncrease), `${cash(totals.currentMonthly)} -> ${cash(totals.newMonthly)}`],
    ['Annual Impact', signed(totals.annualIncrease), `Average +${totals.avgIncreasePct}%`],
    ['Capped', String(totals.capped), 'held at the cap'],
  ];
  return (
    <div className="kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
      {cards.map(([label, value, sub]) => (
        <div className="kpi-card" key={label}>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value">{value}</div>
          <div className="kpi-delta">{sub}</div>
        </div>
      ))}
    </div>
  );
}

function ApplyModal({ facilityId, data, strategies, selected, onClose, onSaved }) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id || 'new');
  const [draft, setDraft] = useState(() => blankStrategy(data.defaults));
  const [scopeType, setScopeType] = useState(selected.length > 1 ? 'tenants' : selected.length === 1 ? 'tenant' : 'unit_type');
  const [unitType, setUnitType] = useState(data.unitTypes[0] || '');
  const [oneKey, setOneKey] = useState(selected[0] || data.tenants[0]?.key || '');
  const chosen = strategies.find((s) => s.id === strategyId);
  const notice = chosen ? chosen.noticeDays : Number(draft.notice_days) || 30;
  const [effective, setEffective] = useState(() => defaultEffective(data.asOf, notice));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const body = () => ({
    facility_id: facilityId,
    ...(chosen ? { strategy_id: chosen.id } : { strategy: toBody(draft) }),
    scope: scopeType === 'unit_type' ? { type: 'unit_type', unitType }
      : scopeType === 'tenant' ? { type: 'tenant', keys: [oneKey] } : { type: 'tenants', keys: selected },
    effective_date: effective,
  });
  // Any change to the inputs makes the preview stale.
  useEffect(() => { setResult(null); }, [strategyId, draft, scopeType, unitType, oneKey, effective]);

  const run = async (save) => {
    setBusy(true); setErr('');
    try {
      if (save) { onSaved(await api.opsRevenueCreateBatch(body())); return; }
      setResult(await api.opsRevenuePreview(body()));
    } catch (e) { setErr(e?.message || "Couldn't build the preview."); } finally { setBusy(false); }
  };
  const saveStrategy = async () => {
    setBusy(true); setErr('');
    try {
      const s = await api.opsRevenueSaveStrategy(null, toBody(draft));
      onSaved(null, s);
      setStrategyId(s.id);
    } catch (e) { setErr(e?.message || "Couldn't save the strategy."); } finally { setBusy(false); }
  };

  return (
    <Modal title="Apply a Strategy" onClose={onClose} minHeight="60vh"
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
        <button type="button" className="secondary-btn" onClick={() => run(false)} disabled={busy}>{busy && !result ? 'Working…' : 'Preview'}</button>
        <button type="button" className="primary-btn" onClick={() => run(true)} disabled={busy || !result || !result.totals.eligible}>Save as Draft</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {err && <ErrorBanner message={err} />}
        <div style={grid}>
          <Field label="Strategy">
            <select className="form-input" value={strategyId} onChange={(e) => setStrategyId(e.target.value)} aria-label="Strategy">
              {strategies.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.summary})</option>)}
              <option value="new">New Strategy…</option>
            </select>
          </Field>
          <Field label="Apply To">
            <select className="form-input" value={scopeType} onChange={(e) => setScopeType(e.target.value)} aria-label="Apply to">
              <option value="unit_type">A Unit Type</option>
              <option value="tenants" disabled={!selected.length}>Selected Tenants ({selected.length})</option>
              <option value="tenant">One Tenant</option>
            </select>
          </Field>
          {scopeType === 'unit_type' && (
            <Field label="Unit Type">
              <select className="form-input" value={unitType} onChange={(e) => setUnitType(e.target.value)} aria-label="Unit type">
                {data.unitTypes.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          )}
          {scopeType === 'tenant' && (
            <Field label="Tenant">
              <select className="form-input" value={oneKey} onChange={(e) => setOneKey(e.target.value)} aria-label="Tenant">
                {data.tenants.map((t) => <option key={t.key} value={t.key}>{t.unit} - {t.tenant}</option>)}
              </select>
            </Field>
          )}
          <Field label="Effective Date" hint={`Needs ${notice} days of notice. Notice goes out by ${formatDate(new Date(new Date(`${effective}T12:00:00`).getTime() - notice * 86400000))}.`}>
            <input className="form-input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} aria-label="Effective date" />
          </Field>
        </div>
        {strategyId === 'new' && (
          <div className="dash-card" style={{ margin: 0 }}>
            <StrategyFields f={draft} set={setDraft} />
            <div style={{ marginTop: 12 }}>
              <button type="button" className="secondary-btn" onClick={saveStrategy} disabled={busy || !draft.name.trim()}>Save This Strategy</button>
            </div>
          </div>
        )}
        {result && (
          <>
            <Impact totals={result.totals} />
            <p className="ops-note" style={{ margin: 0 }}>
              {result.scopeLabel} - {result.strategy.summary}. Effective {formatDate(result.effectiveDate)}, notice by {formatDate(result.noticeDate)}.
              Rents are per billing cycle, as Cubby's rent roll shows them. Nothing is saved until Save as Draft.
            </p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr>
                  <th>Tenant</th><th>Unit</th><th className="num">Current Rate</th><th className="num">Current Standard Rate</th>
                  <th className="num">New Rate</th><th className="num">Change</th><th>Why Not</th>
                </tr></thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.key} style={r.eligible ? undefined : { color: 'var(--muted)' }}>
                      <td>{r.tenant}</td>
                      <td data-th="Unit">{r.unit} <span style={{ color: 'var(--muted)' }}>{r.unitType}</span></td>
                      <td data-th="Current Rate" className="num">{cash(r.rent)}</td>
                      <td data-th="Current Standard Rate" className="num">{cash(r.street)}</td>
                      <td data-th="New Rate" className="num">{r.eligible ? <strong>{cash(r.newRent)}</strong> : '-'}</td>
                      <td data-th="Change" className="num">{r.eligible ? `${signed(r.increase)} (${r.increasePct}%)${r.capped ? ' Capped' : ''}` : '-'}</td>
                      <td data-th="Why Not">{r.reasons.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── A batch: approve, notices, mark entered in Cubby, applied ────────────────

function BatchModal({ batchId, onClose, onChanged }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setB(await api.opsRevenueBatch(batchId)); } catch (e) { setErr(e?.message || "Couldn't load the batch."); }
  }, [batchId]);
  useEffect(() => { load(); }, [load]);

  const act = async (key, fn) => {
    setBusy(key); setErr('');
    try { const out = await fn(); if (out) setB(out); onChanged(); } catch (e) { setErr(e?.message || 'That did not work.'); } finally { setBusy(''); }
  };
  const status = (s, ask) => act(s, async () => {
    if (ask && !window.confirm(ask)) return null;
    return api.opsRevenueSetStatus(batchId, s);
  });
  const push = (c) => act(c.id, async () => {
    if (!window.confirm(`Schedule ${c.tenant}'s new rent in Cubby: ${cash(c.rent)} -> ${cash(c.newRent)}?`)) return null;
    try {
      return await api.opsRevenuePush(batchId, c.id);
    } catch (e) {
      if (e?.status === 409 && e?.detail?.cubbyDate && window.confirm(`${e.message}

Use Cubby's date?`)) {
        return api.opsRevenuePush(batchId, c.id, true);
      }
      throw e;
    }
  });
  const letters = () => act('letters', async () => {
    const { blob, filename } = await api.opsRevenueLetters(batchId);
    download(blob, filename);
    return null;
  });
  const exportCsv = () => act('export', async () => {
    const x = await api.opsRevenueExport(batchId);
    downloadCsv(csvName('Rent Changes', x.facility, x.asOf), x.columns, x.rows);
    return null;
  });

  if (!b) {
    return (
      <Modal title="Rent Change Batch" onClose={onClose} minHeight="60vh">
        {err ? <ErrorBanner message={err} onRetry={load} /> : <LoadingState label="Loading the batch" />}
      </Modal>
    );
  }
  const open = b.status === 'approved' || b.status === 'notified';
  return (
    <Modal title={`${b.scopeLabel} - ${b.strategyName}`} onClose={onClose} minHeight="60vh"
      footer={<>
        {['draft', 'approved', 'notified'].includes(b.status) && (
          <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => status('canceled', 'Cancel this batch? Nothing already in Cubby is undone.')}>Cancel Batch</button>
        )}
        {b.status === 'draft' && <button type="button" className="primary-btn" disabled={!!busy} onClick={() => status('approved')}>Approve</button>}
        {b.status === 'approved' && <button type="button" className="primary-btn" disabled={!!busy} onClick={() => status('notified', 'Mark notified? Confirm every tenant was sent their written notice.')}>Mark Notified</button>}
        {b.status === 'notified' && <button type="button" className="primary-btn" disabled={!!busy || b.inCubby < b.count} onClick={() => status('applied')}>Mark Applied</button>}
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {err && <ErrorBanner message={err} />}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <Badge map={STATUS} value={b.status} />
          <span>{b.facility}</span>
          <span>Effective {formatDate(b.effectiveDate)}</span>
          <span>Notice by {formatDate(b.noticeDate)}</span>
          <span>{b.count} tenants, {signed(b.monthlyIncrease)} a month, {signed(b.annualIncrease)} a year</span>
        </div>
        {b.status !== 'draft' && b.status !== 'canceled' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" disabled={!!busy} onClick={letters} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FileText size={14} aria-hidden="true" /> Print Notices</button>
            <button type="button" className="secondary-btn" disabled={!!busy} onClick={exportCsv} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Download size={14} aria-hidden="true" /> Mail Merge and Checklist</button>
          </div>
        )}
        <p className="ops-note" style={{ margin: 0 }}>
          Nexus never emails tenants. Print the notices (address them from Cubby) or use the mail-merge file.
          {open && (b.pushReady
            ? ' Push each change to Cubby, or mark it Entered in Cubby if staff typed it there. The batch is Applied once every row is in Cubby.'
            : b.pushOn
              ? " Push to Cubby is on, but this server has no Cubby key with the Manager role yet, so enter each change in Cubby and mark it entered here."
              : " Nexus doesn't change rents in Cubby. Enter each change in Cubby, then mark it entered here. The batch is Applied once every row is marked.")}
        </p>
        <div className="req-table-wrapper">
          <table className="req-table stack-table">
            <thead><tr>
              <th>Tenant</th><th>Unit</th><th className="num">Current Rate</th><th className="num">New Rate</th>
              <th className="num">Change</th><th>Cubby</th><th aria-label="Actions" />
            </tr></thead>
            <tbody>
              {b.changes.map((c) => (
                <tr key={c.id} style={c.status === 'removed' ? { color: 'var(--muted)', textDecoration: 'line-through' } : undefined}>
                  <td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.tenant}</a> : c.tenant}</td>
                  <td data-th="Unit">{c.unit} <span style={{ color: 'var(--muted)' }}>{c.unitType}</span></td>
                  <td data-th="Current Rate" className="num">{cash(c.rent)}</td>
                  <td data-th="New Rate" className="num">{cash(c.newRent)}</td>
                  <td data-th="Change" className="num">{signed(c.increase)}</td>
                  <td data-th="Cubby">
                    <Badge map={ROW_STATUS} value={c.status} />
                    {c.cubbyChangeDate && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Takes effect {formatDate(c.cubbyChangeDate)}</div>}
                    {c.status === 'failed' && c.pushDetail && <div style={{ fontSize: 12, color: 'var(--bad-fg)' }}>{c.pushDetail}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {b.status === 'draft' && c.status !== 'removed' && (
                      <button type="button" className="icon-btn" title="Remove from batch" aria-label={`Remove ${c.tenant}`} disabled={!!busy}
                        onClick={() => act(c.id, () => api.opsRevenueRemoveChange(batchId, c.id))}><X size={14} /></button>
                    )}
                    {open && ['pending', 'failed'].includes(c.status) && b.pushReady && c.leaseId && (
                      <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => push(c)} aria-label={`Push ${c.tenant} to Cubby`}
                        style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginRight: 6 }}><Send size={13} aria-hidden="true" /> Push to Cubby</button>
                    )}
                    {open && ['pending', 'failed'].includes(c.status) && (
                      <button type="button" className="secondary-btn" disabled={!!busy}
                        onClick={() => act(c.id, () => api.opsRevenueEntered(batchId, c.id))} aria-label={`Mark ${c.tenant} Entered in Cubby`}
                        style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Check size={13} aria-hidden="true" /> Entered in Cubby</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.audit?.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>History</summary>
            <ul style={{ fontSize: 12.5, color: 'var(--muted)', paddingLeft: 18 }}>
              {b.audit.map((a, i) => (
                <li key={i}>{formatDateTime(a.at)} - {a.actor} - {a.action.replace('_', ' ')}{a.detail?.unit ? ` (${a.detail.unit})` : ''}{a.detail?.error ? `: ${a.detail.error}` : ''}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

// ── The tab ───────────────────────────────────────────────────────────────────

// The facility comes from the page's one Facility dropdown (Oct 20).
// Operations' top bar picks the view (ECRI Management menu, Oct 21) through
// `section` / `onSection`; without them the in-page View dropdown does.
export default function Revenue({ facility, section: sectionProp, onSection }) {
  const facilityId = facility?.id || '';
  const [ownSection, setOwnSection] = useState('tenants');
  const section = sectionProp || ownSection;
  const setSection = onSection || setOwnSection;
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const [strategies, setStrategies] = useState([]);
  const [batches, setBatches] = useState([]);
  const [filters, setFilters] = useState({ unitType: '', q: '', underPct: '', stayed: '', noIncrease: '' });
  const [picked, setPicked] = useState(() => new Set());
  const [modal, setModal] = useState(null);   // {kind: 'apply' | 'strategy' | 'batch', ...}

  const loadStrategies = useCallback(async () => {
    try { setStrategies((await api.opsRevenueStrategies()).strategies || []); } catch { /* the tenant table still works */ }
  }, []);
  const loadBatches = useCallback(async () => {
    if (!facilityId) return;
    try { setBatches((await api.opsRevenueBatches(facilityId)).batches || []); } catch { /* shown empty */ }
  }, [facilityId]);
  const load = useCallback(async () => {
    if (!facilityId) return;
    setState((s) => ({ status: 'loading', data: s.data?.facilityId === facilityId ? s.data : null, error: null }));
    try {
      setState({ status: 'ready', data: await api.opsRevenueTenants(facilityId), error: null });
    } catch (err) {
      setState({ status: 'error', data: null, error: err });
    }
  }, [facilityId]);
  useEffect(() => { setPicked(new Set()); load(); loadBatches(); }, [load, loadBatches]);
  useEffect(() => { loadStrategies(); }, [loadStrategies]);

  const data = state.data;
  const rows = useMemo(() => filterTenants(data?.tenants || [], filters), [data, filters]);
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (key) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allPicked = rows.length > 0 && rows.every((t) => picked.has(t.key));

  if (!facilityId) {
    return (
      <div className="dash-card">
        <div className="dash-card-title">Pick a Facility</div>
        <div className="dash-card-sub">Pick a facility above to see ECRI Management. Rent changes are planned one facility at a time.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {!onSection && (
          <SectionPicker label="View" value={section} onChange={setSection}
            options={SECTIONS.map((s) => ({ value: s.key, label: s.label }))} />
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <button type="button" className="primary-btn" disabled={!data} onClick={() => setModal({ kind: 'apply' })}
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Plus size={14} aria-hidden="true" /> Apply Strategy{picked.size ? ` (${picked.size})` : ''}
          </button>
        </div>
      </div>

      {state.status === 'loading' && !data && <LoadingState label="Reading the tenants" minHeight={240} />}
      {state.status === 'error' && <ErrorBanner message={state.error?.message || "Couldn't load the tenants."} onRetry={load} />}

      {section === 'tenants' && data && (
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Current Tenants</div>
            <div className="dash-card-sub">
              Each tenant&apos;s current rate against today&apos;s current standard rate, from Cubby as of {formatDate(data.asOf)}. Tick tenants to apply a strategy to just them.
            </div>
          </div></div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '4px 0 12px' }}>
            <input className="form-input" placeholder="Search tenant or unit" value={filters.q} onChange={setF('q')} aria-label="Search tenants" style={{ maxWidth: 220 }} />
            <select className="form-input" value={filters.unitType} onChange={setF('unitType')} aria-label="Filter by unit type" style={{ maxWidth: 200 }}>
              <option value="">All Unit Types</option>
              {data.unitTypes.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Under Standard Rate By More Than
              <input className="form-input" type="number" min="0" value={filters.underPct} onChange={setF('underPct')} aria-label="Under standard rate by more than percent" style={{ width: 70 }} />%</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Stayed More Than
              <input className="form-input" type="number" min="0" value={filters.stayed} onChange={setF('stayed')} aria-label="Stayed more than months" style={{ width: 70 }} />Months</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>No Increase In
              <input className="form-input" type="number" min="0" value={filters.noIncrease} onChange={setF('noIncrease')} aria-label="No increase in months" style={{ width: 70 }} />Months</label>
          </div>
          {rows.length === 0 ? <div className="ops-empty">No tenants match these filters.</div> : (
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Select all shown" checked={allPicked}
                    onChange={() => setPicked((s) => { const n = new Set(s); rows.forEach((t) => (allPicked ? n.delete(t.key) : n.add(t.key))); return n; })} /></th>
                  <th>Tenant</th><th>Unit</th><th>Move-In</th><th className="num">Stay</th><th className="num">Current Rate</th>
                  <th className="num">Current Standard Rate</th><th className="num">Over/Under Standard Rate</th><th>Last Rent Change</th><th className="num">Balance</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.key}>
                      <td><input type="checkbox" checked={picked.has(t.key)} onChange={() => toggle(t.key)} aria-label={`Select ${t.tenant}`} /></td>
                      <td>{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.tenant}</a> : t.tenant}</td>
                      <td data-th="Unit">{t.unit} <span style={{ color: 'var(--muted)' }}>{t.unitType}</span></td>
                      <td data-th="Move-In">{formatDate(t.moveIn, '-')}</td>
                      <td data-th="Stay" className="num">{stay(t.monthsStayed)}</td>
                      <td data-th="Current Rate" className="num">{cash(t.rent)}</td>
                      <td data-th="Current Standard Rate" className="num">{cash(t.street)}</td>
                      <OverUnderCell t={t} />
                      <td data-th="Last Rent Change">{t.lastIncrease ? `${formatDate(t.lastIncrease)}${t.lastIncreaseSource === 'nexus' ? ' (Nexus)' : ''}` : 'None'}</td>
                      <td data-th="Balance" className="num" style={t.pastDue ? { color: 'var(--bad-fg)', fontWeight: 600 } : undefined}>
                        {t.balance ? `${cash(t.balance)}${t.pastDue ? ' Past Due' : ''}` : '-'}
                      </td>
                      <td data-th="Status">
                        {t.scheduled && <span className="status-badge pill-info" title={`${cash(t.scheduled.amount)} from ${formatDate(t.scheduled.date)}`}>Scheduled in Cubby</span>}
                        {t.pending && <span className="status-badge status-pending">In a {STATUS[t.pending.status]?.[1] || ''} Batch</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {section === 'strategies' && (
        <div className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-title">Strategies</div>
              <div className="dash-card-sub">Saved rent-change rules. Apply one to a unit type, to selected tenants or to one person.</div>
            </div>
            <button type="button" className="secondary-btn" onClick={() => setModal({ kind: 'strategy' })} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Plus size={14} aria-hidden="true" /> New Strategy
            </button>
          </div>
          {strategies.length === 0 ? <div className="ops-empty">No strategies yet. Create one to get started.</div> : (
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Name</th><th>Rule</th><th>Eligibility</th><th className="num">Notice</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {strategies.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600 }}>{s.name}</td>
                      <td data-th="Rule">{s.summary}{s.roundDollar ? ', whole dollars' : ''}</td>
                      <td data-th="Eligibility">{s.minMonthsIn}+ months in, {s.minMonthsSince}+ months since last increase{s.skipBalance ? ', no balance due' : ''}</td>
                      <td data-th="Notice" className="num">{s.noticeDays} days</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button type="button" className="icon-btn" aria-label={`Edit ${s.name}`} onClick={() => setModal({ kind: 'strategy', strategy: s })}><Pencil size={14} /></button>
                        <button type="button" className="icon-btn" aria-label={`Archive ${s.name}`}
                          onClick={async () => { if (window.confirm(`Archive ${s.name}? Batches built from it keep it.`)) { await api.opsRevenueArchiveStrategy(s.id).catch(() => {}); loadStrategies(); } }}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ops-note" style={{ marginTop: 10 }}>Cap: {Object.values(CAP_LABEL).join(', ')}. Notice days are set per strategy (California requires written notice; 30 days by default).</p>
        </div>
      )}

      {section === 'batches' && (
        <div className="dash-card">
          <div className="dash-card-head"><div>
            <div className="dash-card-title">Rent Changes</div>
            <div className="dash-card-sub">Each batch moves Draft, Approved, Notified, Applied. Open one to print notices and get it into Cubby.</div>
          </div></div>
          {batches.length === 0 ? <div className="ops-empty">No rent changes at this facility yet.</div> : (
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr>
                  <th>Created</th><th>Applies To</th><th>Strategy</th><th>Effective</th><th className="num">Tenants</th>
                  <th className="num">Monthly</th><th className="num">Annual</th><th className="num">In Cubby</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} onClick={() => setModal({ kind: 'batch', id: b.id })} style={{ cursor: 'pointer' }}>
                      <td><button type="button" className="ops-link" onClick={(e) => { e.stopPropagation(); setModal({ kind: 'batch', id: b.id }); }}>{formatDate(b.createdAt)}</button>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{b.createdBy}</div></td>
                      <td data-th="Applies To">{b.scopeLabel}</td>
                      <td data-th="Strategy">{b.strategyName}</td>
                      <td data-th="Effective">{formatDate(b.effectiveDate)}</td>
                      <td data-th="Tenants" className="num">{b.count}</td>
                      <td data-th="Monthly" className="num">{signed(b.monthlyIncrease)}</td>
                      <td data-th="Annual" className="num">{signed(b.annualIncrease)}</td>
                      <td data-th="In Cubby" className="num">{b.inCubby} of {b.count}</td>
                      <td data-th="Status"><Badge map={STATUS} value={b.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {modal?.kind === 'strategy' && (
        <StrategyModal initial={modal.strategy} defaults={data?.defaults} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); loadStrategies(); }} />
      )}
      {modal?.kind === 'apply' && data && (
        <ApplyModal facilityId={facilityId} data={data} strategies={strategies} selected={[...picked]}
          onClose={() => setModal(null)}
          onSaved={(batch) => {
            loadStrategies();
            if (!batch) return;                  // a strategy was saved from inside the modal
            setPicked(new Set());
            load(); loadBatches(); setSection('batches');
            setModal({ kind: 'batch', id: batch.id });
          }} />
      )}
      {modal?.kind === 'batch' && (
        <BatchModal batchId={modal.id} onClose={() => setModal(null)}
          onChanged={() => { loadBatches(); load(); }} />
      )}
    </div>
  );
}
