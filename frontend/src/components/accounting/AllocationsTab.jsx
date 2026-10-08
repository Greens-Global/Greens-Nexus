import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Save, Settings2, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Amount from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { control } from './reportControls';
import { downloadBlob } from './reportModel';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { dialog } from '../../ui/dialog';
import { ensureStepUp, isStepUpRequired, StepUpNeeded } from '../../stepup/StepUp';

// Accounting > Allocations (Neil, 10/01: "allocations journal entry from
// people and done monthly"). Pick a month; the basis is each person's hours
// by work site from Time Clock and the cost that month's wages from the
// payroll card. The preview entry debits each entity's wage expense account
// by the person's share and credits the paying entity's allocation clearing
// account. The mapping (work site -> entity + account, company -> paying
// entity + clearing account) is edited here and saved in nexus_settings.
// Keep Run saves the preview; a kept run exports as an Intacct GL import
// CSV (the accounting app's bank-import layout) or a workbook. Nothing is
// posted anywhere.
//
// Wages for everyone are payroll figures, so the backend asks for a fresh
// step-up (like the payroll card); the Verify card handles that.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-color)' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '4px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', verticalAlign: 'top' };
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const warn = { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: '#92400e', background: 'rgba(180,83,9,0.13)' };
const hours = (min) => `${(Number(min || 0) / 60).toFixed(2)} h`;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const shiftMonth = (key, n) => { const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + n, 1); return monthKey(d); };

export default function AllocationsTab({ canEdit = false }) {
  const [month, setMonth] = useState(() => monthKey(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)));
  const [preview, setPreview] = useState(null);
  const [state, setState] = useState({ loading: false, error: '', stepUp: false });
  const [mapData, setMapData] = useState(null);     // { map, sites, companies }
  const [mapOpen, setMapOpen] = useState(false);
  const [draft, setDraft] = useState(null);         // the mapping as edited
  const [runs, setRuns] = useState(null);
  const [busy, setBusy] = useState('');

  const loadMap = useCallback(() => api.getAllocationsMap().then((d) => { setMapData(d); setDraft(d.map); }).catch(() => setMapData({ map: { journal: 'GJ', sites: {}, companies: {}, offsite: {} }, sites: [], companies: [] })), []);
  const loadRuns = useCallback(() => api.getAllocationRuns().then((d) => setRuns(d?.runs || [])).catch(() => setRuns([])), []);
  useEffect(() => { loadMap(); loadRuns(); }, [loadMap, loadRuns]);

  const loadPreview = useCallback((m) => {
    setState({ loading: true, error: '', stepUp: false });
    api.previewAllocations(m).then((d) => { setPreview(d); setState({ loading: false, error: '', stepUp: false }); })
      .catch((e) => { setPreview(null); setState({ loading: false, error: isStepUpRequired(e) ? '' : (e?.message || 'Could not build the preview.'), stepUp: isStepUpRequired(e) }); });
  }, []);
  useEffect(() => { loadPreview(month); }, [month, loadPreview]);

  const unmapped = (preview?.unmapped?.sites?.length || 0) + (preview?.unmapped?.companies?.length || 0);
  const lines = useMemo(() => (preview?.entries || []).flatMap((e) => e.lines.map((l) => ({ ...l, entry: e.description }))), [preview]);

  async function saveMap() {
    setBusy('map');
    try { const d = await api.saveAllocationsMap(draft); setMapData((cur) => ({ ...cur, map: d.map })); setMapOpen(false); loadPreview(month); }
    catch (e) { await dialog.alert(e?.message || 'Could not save the mapping.', { title: 'Mapping' }); }
    setBusy('');
  }
  const setSite = (id, f, v) => setDraft((cur) => ({ ...cur, sites: { ...(cur.sites || {}), [id]: { ...((cur.sites || {})[id] || {}), [f]: v } } }));
  const setCompany = (id, f, v) => setDraft((cur) => ({ ...cur, companies: { ...(cur.companies || {}), [id]: { ...((cur.companies || {})[id] || {}), [f]: v } } }));

  async function keepRun() {
    if (unmapped) { await dialog.alert('Map every work site and company first - some lines have no entity or account.', { title: 'Keep Run' }); return; }
    setBusy('run');
    try {
      const r = await api.saveAllocationRun({ month, entity: '', preview });
      loadRuns();
      return r;
    } catch (e) {
      if (isStepUpRequired(e)) { const up = await ensureStepUp(); if (up.ok) return keepRun(); }
      else await dialog.alert(e?.message || 'Could not keep the run.', { title: 'Keep Run' });
    } finally { setBusy(''); }
    return null;
  }
  async function exportRun(id, kind) {
    setBusy(`x-${id}`);
    try { const { blob, filename } = await (kind === 'xlsx' ? api.allocationRunExcel(id) : api.allocationRunCsv(id)); downloadBlob(filename, blob); }
    catch (e) { await dialog.alert(e?.message || 'Could not export.', { title: 'Export' }); }
    setBusy('');
  }
  async function keepAndExport(kind) {
    const r = await keepRun();
    if (r?.id) exportRun(r.id, kind);
  }
  async function removeRun(r) {
    if (!await dialog.confirm(`Remove the ${monthLabel(r.month)} run kept by ${r.byName}? Nothing was posted, so Intacct is untouched.`, { title: 'Remove Run', confirmText: 'Remove' })) return;
    try { await api.deleteAllocationRun(r.id); loadRuns(); } catch (e) { await dialog.alert(e?.message || 'Could not remove it.', { title: 'Remove Run' }); }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button type="button" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 5, display: 'inline-flex', color: 'var(--text-muted)' }}><ChevronLeft size={16} /></button>
          <strong style={{ fontSize: '0.86rem', minWidth: 80, textAlign: 'center' }}>{monthLabel(month)}</strong>
          <button type="button" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 5, display: 'inline-flex', color: 'var(--text-muted)' }}><ChevronRight size={16} /></button>
        </div>
        {preview && (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {preview.totals.people} people · wages <strong><Amount value={preview.totals.wages} /></strong> · debits <strong><Amount value={preview.totals.debits} /></strong> · credits <strong><Amount value={preview.totals.credits} /></strong>
            {preview.currencies?.length > 1 && <span style={{ ...warn, marginLeft: 8 }}>Mixed currencies: {preview.currencies.join(', ')}</span>}
            {unmapped > 0 && <span style={{ ...warn, marginLeft: 8 }}>{unmapped} unmapped</span>}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button type="button" className="secondary-btn" onClick={() => setMapOpen((v) => !v)} aria-expanded={mapOpen} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Settings2 size={13} /> Account Mapping</button>}
          {canEdit && <button type="button" className="secondary-btn" disabled={!!busy || !preview?.entries?.length || unmapped > 0} onClick={() => keepAndExport('csv')} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export Intacct CSV</button>}
          {canEdit && <button type="button" className="secondary-btn" disabled={!!busy || !preview?.entries?.length || unmapped > 0} onClick={() => keepAndExport('xlsx')} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export Excel</button>}
          {canEdit && <button type="button" className="primary-btn" disabled={!!busy || !preview?.entries?.length || unmapped > 0} onClick={keepRun} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Save size={13} /> {busy === 'run' ? 'Keeping...' : 'Keep Run'}</button>}
        </div>
      </div>

      {mapOpen && draft && (
        <div style={{ ...card, padding: 14 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: '0.95rem' }}>Account Mapping</h3>
          <p style={{ margin: '0 0 10px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Each work site is an Intacct entity and the wage expense account its hours are charged to. Each company pays through an entity: its allocation clearing account takes the credit, and its wage account carries anyone with no site hours that month.</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <label htmlFor="alloc-journal" style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Journal</label>
            <input id="alloc-journal" type="text" value={draft.journal || ''} onChange={(e) => setDraft((cur) => ({ ...cur, journal: e.target.value }))} style={{ ...control, width: 90 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Work Site</th><th style={th}>Entity</th><th style={th}>Wage Account</th></tr></thead>
              <tbody>
                {[...(mapData?.sites || []), { id: '__offsite__', name: 'No location (off site)' }].map((s) => {
                  const isOff = s.id === '__offsite__';
                  const m = isOff ? (draft.offsite || {}) : ((draft.sites || {})[s.id] || {});
                  const set = (f, v) => (isOff ? setDraft((cur) => ({ ...cur, offsite: { ...(cur.offsite || {}), [f]: v } })) : setSite(s.id, f, v));
                  return (
                    <tr key={s.id}>
                      <td style={td}>{s.name}</td>
                      <td style={td}><input type="text" aria-label={`${s.name} entity`} value={m.entity || ''} placeholder="15000" onChange={(e) => set('entity', e.target.value)} style={{ ...control, width: 90 }} /></td>
                      <td style={td}><input type="text" aria-label={`${s.name} wage account`} value={m.account || ''} placeholder="60100" onChange={(e) => set('account', e.target.value)} style={{ ...control, width: 90 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Company (Pays)</th><th style={th}>Entity</th><th style={th}>Clearing Account</th><th style={th}>Wage Account</th></tr></thead>
              <tbody>
                {(mapData?.companies || []).map((c) => {
                  const m = (draft.companies || {})[c.id] || {};
                  return (
                    <tr key={c.id}>
                      <td style={td}>{c.name}</td>
                      <td style={td}><input type="text" aria-label={`${c.name} entity`} value={m.entity || ''} placeholder="12000" onChange={(e) => setCompany(c.id, 'entity', e.target.value)} style={{ ...control, width: 90 }} /></td>
                      <td style={td}><input type="text" aria-label={`${c.name} clearing account`} value={m.account || ''} placeholder="21500" onChange={(e) => setCompany(c.id, 'account', e.target.value)} style={{ ...control, width: 90 }} /></td>
                      <td style={td}><input type="text" aria-label={`${c.name} wage account`} value={m.wageAccount || ''} placeholder="60100" onChange={(e) => setCompany(c.id, 'wageAccount', e.target.value)} style={{ ...control, width: 90 }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="secondary-btn" onClick={() => { setDraft(mapData.map); setMapOpen(false); }}>Cancel</button>
            <button type="button" className="primary-btn" disabled={busy === 'map'} onClick={saveMap}>Save Mapping</button>
          </div>
        </div>
      )}

      {state.stepUp ? (
        <StepUpNeeded label="wages by person" onVerified={() => loadPreview(month)} />
      ) : (
        <AsyncSection loading={state.loading && !preview} error={!!state.error} errorMessage={state.error} onRetry={() => loadPreview(month)} skeleton={<SkeletonBlocks count={2} />}>
          {preview && !preview.people.length ? (
            <div style={{ ...card, padding: 24, textAlign: 'center' }}>
              <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.86rem' }}>No wages or site hours in {monthLabel(month)}. Hours come from Time Clock punches at work sites; wages from the payroll card.</p>
            </div>
          ) : preview && (
            <>
              <div style={{ ...card, overflow: 'auto' }}>
                <h3 style={{ margin: 0, padding: '10px 12px 4px', fontSize: '0.9rem' }}>Basis - {formatDate(preview.start)} to {formatDate(preview.end)}</h3>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={th}>Person</th><th style={th}>Company</th><th style={thNum}>Wages</th><th style={th}>Work Site</th><th style={thNum}>Hours</th><th style={thNum}>Share</th><th style={thNum}>Amount</th><th style={th}>Entity</th><th style={th}>Account</th></tr></thead>
                  <tbody>
                    {preview.people.map((p) => p.sites.map((s, i) => (
                      <tr key={`${p.email}-${i}`}>
                        {i === 0 && <td style={td} rowSpan={p.sites.length}><strong>{p.name}</strong><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{p.payType === 'fixed' ? 'Salaried' : 'Hourly'}{p.department ? ` · ${p.department}` : ''}</div></td>}
                        {i === 0 && <td style={td} rowSpan={p.sites.length}>{p.companyName || <span style={warn}>No company</span>}</td>}
                        {i === 0 && <td style={tdNum} rowSpan={p.sites.length}><Amount value={p.wages} />{p.currency !== 'USD' ? ` ${p.currency}` : ''}</td>}
                        <td style={td}>{s.workSite}</td>
                        <td style={tdNum}>{hours(s.workedMin)}</td>
                        <td style={tdNum}>{s.share.toFixed(1)}%</td>
                        <td style={tdNum}><Amount value={s.amount} /></td>
                        <td style={td}>{s.entity || <span style={warn}>Unmapped</span>}</td>
                        <td style={td}>{s.account || <span style={warn}>Unmapped</span>}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
              <div style={{ ...card, overflow: 'auto' }}>
                <h3 style={{ margin: 0, padding: '10px 12px 4px', fontSize: '0.9rem' }}>Entry Preview - {preview.entries.length} {preview.entries.length === 1 ? 'entry' : 'entries'}, dated {formatDate(preview.end)}</h3>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr><th style={th}>Entry</th><th style={th}>Account</th><th style={th}>Entity</th><th style={th}>Dept</th><th style={th}>Memo</th><th style={thNum}>Debit</th><th style={thNum}>Credit</th></tr></thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} style={l.mapped ? undefined : { background: 'rgba(180,83,9,0.06)' }}>
                        <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{l.entry}</td>
                        <td style={td}>{l.acct_no || <span style={warn}>Unmapped</span>}</td>
                        <td style={td}>{l.location_id || <span style={warn}>Unmapped</span>}</td>
                        <td style={td}>{l.dept_id}</td>
                        <td style={td}>{l.memo}</td>
                        <td style={tdNum}><Amount value={l.debit} zero="blank" /></td>
                        <td style={tdNum}><Amount value={l.credit} zero="blank" /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...td, fontWeight: 700 }} colSpan={5}>Total</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={preview.totals.debits} /></td>
                      <td style={{ ...tdNum, fontWeight: 700 }}><Amount value={preview.totals.credits} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </AsyncSection>
      )}

      <div style={{ ...card, overflow: 'auto' }}>
        <h3 style={{ margin: 0, padding: '10px 12px 4px', fontSize: '0.9rem' }}>Runs Kept</h3>
        <AsyncSection loading={runs === null} skeleton={<SkeletonBlocks count={1} height={60} />}>
          {!runs?.length ? (
            <p style={{ margin: 0, padding: '8px 12px 14px', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>No runs yet. Keep Run saves the preview above so its file can be produced again unchanged.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Month</th><th style={th}>Kept By</th><th style={th}>When</th><th style={thNum}>People</th><th style={thNum}>Wages</th><th style={thNum}>Debits</th><th style={th}></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{monthLabel(r.month)}</td>
                    <td style={td}>{r.byName}</td>
                    <td style={td}>{formatDateTime(r.at)}</td>
                    <td style={tdNum}>{r.totals?.people ?? r.people}</td>
                    <td style={tdNum}><Amount value={r.totals?.wages} /></td>
                    <td style={tdNum}><Amount value={r.totals?.debits} /></td>
                    <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button type="button" className="secondary-btn" disabled={busy === `x-${r.id}`} onClick={() => exportRun(r.id, 'csv')} style={{ fontSize: '0.72rem', marginRight: 6 }}>Intacct CSV</button>
                      <button type="button" className="secondary-btn" disabled={busy === `x-${r.id}`} onClick={() => exportRun(r.id, 'xlsx')} style={{ fontSize: '0.72rem', marginRight: 6 }}>Excel</button>
                      {canEdit && <button type="button" aria-label={`Remove run ${monthLabel(r.month)}`} onClick={() => removeRun(r)} style={{ border: 'none', background: 'none', padding: 4, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)', verticalAlign: 'middle' }}><Trash2 size={14} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </AsyncSection>
      </div>
    </div>
  );
}
