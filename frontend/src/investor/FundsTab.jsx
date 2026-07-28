import { useEffect, useMemo, useState } from 'react';
import { Briefcase, ExternalLink, Info, Loader, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import { formatCurrency, formatMultiple, formatPercent, numOrNull } from './lib/format';
import { EmptyState, ErrorState, FG, LoadingState, Modal, PeopleSelect, StatusText, ThinBar, useIrLoad } from './lib/ui';

const BLANK = {
  name: '', entityName: '', strategy: '', propertyName: '', status: 'raising',
  targetRaise: '', minimumInvestment: '', preferredReturnPct: '',
  gpPromotePct: '', targetIrrPct: '', targetMultiple: '', holdPeriodYears: '',
  inceptionDate: '', closeDate: '', exitDate: '',
  fundManagerEmail: '', description: '', thesis: '', propertyAssetId: '',
};

const s = v => (v === null || v === undefined ? '' : String(v));

function toPayload(f) {
  return {
    name: f.name.trim(),
    entityName: f.entityName.trim() || null,
    strategy: f.strategy.trim() || null,
    propertyName: f.propertyName.trim() || null,
    status: f.status,
    targetRaise: numOrNull(f.targetRaise),
    minimumInvestment: numOrNull(f.minimumInvestment),
    preferredReturnPct: numOrNull(f.preferredReturnPct),
    gpPromotePct: numOrNull(f.gpPromotePct),
    targetIrrPct: numOrNull(f.targetIrrPct),
    targetMultiple: numOrNull(f.targetMultiple),
    holdPeriodYears: numOrNull(f.holdPeriodYears),
    inceptionDate: f.inceptionDate || null,
    closeDate: f.closeDate || null,
    exitDate: f.exitDate || null,
    fundManagerEmail: f.fundManagerEmail || null,
    description: f.description.trim() || null,
    thesis: f.thesis.trim() || null,
    // '' (not null) so clearing the link actually clears it on PATCH - the
    // backend treats null as "leave unchanged" and '' as "no linked property".
    propertyAssetId: f.propertyAssetId || '',
  };
}

// Cross-view jump to Asset Management (standard nexus:navigate pattern). No
// deep-link-to-a-property support exists over there yet, so this lands on the
// general screen - don't fake a query param the target won't read.
function goToAssetMgmt(e) {
  e.stopPropagation();
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'property-asset' } }));
}

// Grant/revoke read-only investor-portal access for this deal, one investor at
// a time. Lives in the EDIT modal only - a brand-new deal has no commitments,
// and the backend refuses grants without a real commitment behind them.
function DealPortalAccess({ fundId }) {
  const { data, loading, error, reload } = useIrLoad(
    () => Promise.all([api.getIrCommitments({ fundId }), api.getIrInvestors()]),
    [fundId],
  );
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const rows = useMemo(() => {
    const [commitments, investors] = data || [[], []];
    const byInvestor = new Map();
    (commitments || []).forEach(c => {
      const cur = byInvestor.get(c.investorId);
      if (cur) cur.amount += Number(c.commitmentAmount) || 0;
      else byInvestor.set(c.investorId, { investorId: c.investorId, name: c.investorName || '', amount: Number(c.commitmentAmount) || 0 });
    });
    const invById = new Map((investors || []).map(i => [i.id, i]));
    return [...byInvestor.values()]
      .map(r => ({
        ...r,
        email: invById.get(r.investorId)?.email || '',
        granted: !!invById.get(r.investorId)?.portalFundIds?.includes(fundId),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, fundId]);

  const toggle = async (row) => {
    if (busyId) return;
    setBusyId(row.investorId); setErr(''); setNote('');
    try {
      if (row.granted) {
        await api.revokeIrPortalAccess(row.investorId, fundId);
      } else {
        const res = await api.grantIrPortalAccess(row.investorId, fundId);
        // nextStep = the manual Entra guest-invite reminder - only present when
        // a new guest record was just created; the GP still has to act on it.
        if (res?.nextStep) setNote(res.nextStep);
      }
      await reload();
    } catch (e) {
      // 400 (no email / no commitment) and 409 (internal-employee email clash)
      // messages are actionable - surface them as-is, formErr-style.
      setErr(e?.message || (row.granted ? 'Revoke failed.' : 'Grant failed.'));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="form-group-full" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink)' }}>Investors in This Deal</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 10px' }}>
        Portal access gives an investor a read-only view of this deal only - their capital account, cash flows, documents, and updates.
      </div>
      {note && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, border: '1px solid hsla(var(--color-blue), 0.4)', borderRadius: 10, padding: '9px 12px', marginBottom: 10 }}>
          <Info size={14} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: 12.5, color: 'var(--ink)', flex: 1, lineHeight: 1.5 }}>{note}</span>
          <button type="button" onClick={() => setNote('')} title="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}>
            <X size={14} />
          </button>
        </div>
      )}
      {loading ? <LoadingState label="Loading investors…" /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          No investors have a commitment in this deal yet - add commitments first, then grant portal access here.
        </div>
      ) : (
        <div>
          {rows.map((r, i) => (
            <div key={r.investorId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--line)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || 'Unnamed Investor'}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatCurrency(r.amount)} committed{r.email ? ` · ${r.email}` : ''}
                </div>
              </div>
              {r.granted && <StatusText status="active" label="Portal Access" size={11.5} />}
              <button type="button" className="secondary-btn" disabled={!!busyId} onClick={() => toggle(r)}
                style={{ fontSize: 12, padding: '5px 12px', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, ...(r.granted ? { color: 'hsl(var(--color-red))' } : {}) }}>
                {busyId === r.investorId && <Loader size={12} style={{ animation: 'spin 0.8s linear infinite' }} />}
                {r.granted ? 'Revoke Portal Access' : 'Grant Portal Access'}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <div style={{ color: 'hsl(var(--color-red))', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

export default function FundsTab() {
  const nameOf = useNameResolver();
  const { data: funds, loading, error, reload } = useIrLoad(() => api.getIrFunds(), []);
  const [people, setPeople] = useState([]);
  useEffect(() => { api.getPeopleDirectory().then(d => setPeople(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  // Optional Deal ↔ Property link (read-only reference into Asset Management,
  // not duplication). The workspace endpoint is grant-gated (property-asset
  // viewer), so a 403 for GPs without Asset Management access just leaves this
  // null and hides the picker - it must never error the Deal form.
  const [assetProps, setAssetProps] = useState(null);
  useEffect(() => {
    api.getPropertyWorkspace()
      .then(ws => setAssetProps(Array.isArray(ws?.properties) ? ws.properties : []))
      .catch(() => {});
  }, []);

  const [modal, setModal] = useState(null); // { id?, form }
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');

  const openAdd = () => { setFormErr(''); setModal({ id: null, form: { ...BLANK } }); };
  const openEdit = (f) => {
    setFormErr('');
    setModal({
      id: f.id,
      form: {
        name: s(f.name), entityName: s(f.entityName), strategy: s(f.strategy), propertyName: s(f.propertyName),
        status: f.status || 'raising', targetRaise: s(f.targetRaise),
        minimumInvestment: s(f.minimumInvestment), preferredReturnPct: s(f.preferredReturnPct),
        gpPromotePct: s(f.gpPromotePct), targetIrrPct: s(f.targetIrrPct), targetMultiple: s(f.targetMultiple),
        holdPeriodYears: s(f.holdPeriodYears), inceptionDate: s(f.inceptionDate).slice(0, 10),
        closeDate: s(f.closeDate).slice(0, 10), exitDate: s(f.exitDate).slice(0, 10),
        fundManagerEmail: s(f.fundManagerEmail),
        description: s(f.description), thesis: s(f.thesis),
        propertyAssetId: s(f.propertyAssetId),
      },
    });
  };

  const setF = patch => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      const payload = toPayload(modal.form);
      if (modal.id) await api.updateIrFund(modal.id, payload);
      else await api.createIrFund(payload);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!modal?.id || busy) return;
    if (!window.confirm('Delete this deal? Commitments, calls, and distributions tied to it may be affected.')) return;
    setBusy(true); setFormErr('');
    try {
      await api.deleteIrFund(modal.id);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const stat = (label, value) => (
    <div key={label}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Deals</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Every deal - raise progress, terms, and lifecycle status</p>
        </div>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Deal
        </button>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : (funds || []).length === 0 ? (
        <EmptyState icon={Briefcase} title="No Deals Yet" sub="Add your first deal to start tracking commitments, capital calls, and distributions." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
          {(funds || []).map(f => (
            <div key={f.id} onClick={() => openEdit(f)} role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') openEdit(f); }}
              style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{f.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {[f.strategy, f.propertyName].filter(Boolean).join(' · ') || f.entityName || '-'}
                  </div>
                </div>
                <StatusText status={f.status} />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 5, fontVariantNumeric: 'tabular-nums' }}>
                  <span>Committed <strong style={{ color: 'var(--ink)' }}>{formatCurrency(f.totalCommitted)}</strong></span>
                  <span>Target {formatCurrency(f.targetRaise)}</span>
                </div>
                <ThinBar value={f.totalCommitted} max={f.targetRaise} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px 12px' }}>
                {stat('Target IRR', formatPercent(f.targetIrrPct))}
                {stat('Target Multiple', formatMultiple(f.targetMultiple))}
                {stat('Pref Return', formatPercent(f.preferredReturnPct))}
                {stat('Called', formatCurrency(f.totalCalled))}
                {stat('Distributed', formatCurrency(f.totalDistributed))}
              </div>

              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: 'var(--muted)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.fundManagerEmail ? nameOf(f.fundManagerEmail) : 'No manager assigned'}
                </span>
                <span style={{ flexShrink: 0 }}>{f.investorCount ?? 0} investor{(f.investorCount ?? 0) === 1 ? '' : 's'}</span>
              </div>

              {f.propertyAssetId && (
                <button type="button" onClick={goToAssetMgmt}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: 12, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                  <ExternalLink size={13} /> View in Asset Management
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? 'Edit Deal' : 'Add Deal'} onClose={() => setModal(null)} width={640}>
          <form onSubmit={save}>
            <div className="form-grid">
              <FG label="Deal Name" full>
                <input className="form-input" required value={modal.form.name} placeholder="e.g. 1204 Maple Ave, LLC"
                  onChange={e => setF({ name: e.target.value })} />
              </FG>
              <FG label="Legal Entity">
                <input className="form-input" value={modal.form.entityName} placeholder="e.g. GG VAF III, LLC"
                  onChange={e => setF({ entityName: e.target.value })} />
              </FG>
              <FG label="Status">
                <select className="form-select" value={modal.form.status} onChange={e => setF({ status: e.target.value })}>
                  <option value="raising">Raising</option>
                  <option value="active">Active</option>
                  <option value="exited">Exited</option>
                </select>
              </FG>
              <FG label="Strategy">
                <input className="form-input" value={modal.form.strategy} placeholder="e.g. Value-Add Multifamily"
                  onChange={e => setF({ strategy: e.target.value })} />
              </FG>
              <FG label="Property Name">
                <input className="form-input" value={modal.form.propertyName} placeholder="e.g. The Elms at Riverside"
                  onChange={e => setF({ propertyName: e.target.value })} />
              </FG>
              <FG label="Target Raise ($)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.targetRaise}
                  onChange={e => setF({ targetRaise: e.target.value })} />
              </FG>
              <FG label="Minimum Investment ($)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.minimumInvestment}
                  onChange={e => setF({ minimumInvestment: e.target.value })} />
              </FG>
              <FG label="Hold Period (Years)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.holdPeriodYears}
                  onChange={e => setF({ holdPeriodYears: e.target.value })} />
              </FG>
              <FG label="Preferred Return (%)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.preferredReturnPct}
                  onChange={e => setF({ preferredReturnPct: e.target.value })} />
              </FG>
              <FG label="GP Promote (%)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.gpPromotePct}
                  onChange={e => setF({ gpPromotePct: e.target.value })} />
              </FG>
              <FG label="Target IRR (%)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.targetIrrPct}
                  onChange={e => setF({ targetIrrPct: e.target.value })} />
              </FG>
              <FG label="Target Multiple (x)">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.targetMultiple}
                  onChange={e => setF({ targetMultiple: e.target.value })} />
              </FG>
              <FG label="Inception Date">
                <input className="form-input" type="date" value={modal.form.inceptionDate} onChange={e => setF({ inceptionDate: e.target.value })} />
              </FG>
              <FG label="Close Date">
                <input className="form-input" type="date" value={modal.form.closeDate} onChange={e => setF({ closeDate: e.target.value })} />
              </FG>
              <FG label="Exit Date">
                <input className="form-input" type="date" value={modal.form.exitDate} onChange={e => setF({ exitDate: e.target.value })} />
              </FG>
              <FG label="Deal Manager" full>
                <PeopleSelect value={modal.form.fundManagerEmail} onChange={v => setF({ fundManagerEmail: v })} people={people} placeholder="Select a deal manager…" />
              </FG>
              {/* Picker only when the workspace loaded (grant-gated - hidden on 403);
                  an already-linked deal still shows the jump link either way. */}
              {(Array.isArray(assetProps) || modal.form.propertyAssetId) && (
                <FG label="Linked Property (Asset Management)" full>
                  {Array.isArray(assetProps) ? (
                    <select className="form-select" value={modal.form.propertyAssetId} onChange={e => setF({ propertyAssetId: e.target.value })}>
                      <option value="">No Linked Property</option>
                      {modal.form.propertyAssetId && !assetProps.some(p => p.id === modal.form.propertyAssetId) && (
                        <option value={modal.form.propertyAssetId}>Linked Property (No Longer in Portfolio)</option>
                      )}
                      {[...assetProps].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map(p => (
                        <option key={p.id} value={p.id}>{p.name || p.siteName || p.id}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Linked to a property in Asset Management.</div>
                  )}
                  {modal.form.propertyAssetId && (
                    <button type="button" onClick={goToAssetMgmt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, marginTop: 6, cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: 12, fontWeight: 600, fontFamily: 'Inter, sans-serif' }}>
                      <ExternalLink size={12} /> View in Asset Management
                    </button>
                  )}
                </FG>
              )}
              <FG label="Description" full>
                <textarea className="form-input" value={modal.form.description} placeholder="One or two sentences investors will see about this deal…"
                  onChange={e => setF({ description: e.target.value })} style={{ minHeight: 64, resize: 'vertical' }} />
              </FG>
              <FG label="Investment Thesis" full>
                <textarea className="form-input" value={modal.form.thesis} placeholder="Why this deal - market, business plan, exit…"
                  onChange={e => setF({ thesis: e.target.value })} style={{ minHeight: 64, resize: 'vertical' }} />
              </FG>
              {modal.id && <DealPortalAccess fundId={modal.id} />}
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              {modal.id && (
                <button type="button" className="secondary-btn" disabled={busy} onClick={remove}
                  style={{ marginRight: 'auto', color: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                {modal.id ? 'Save Changes' : 'Create Deal'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
