import { useCallback, useEffect, useState } from 'react';
import { ArrowUpFromLine, Check, ChevronDown, ChevronRight, Loader, Plus, Send } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate, statusLabel } from './lib/format';
import { EmptyState, ErrorState, FG, LoadingState, Modal, StatusText, ThinBar, useIrLoad } from './lib/ui';

const today = () => new Date().toISOString().slice(0, 10);

const DIST_TYPES = ['return_of_capital', 'preferred_return', 'profit_split', 'mixed'];

export default function DistributionsTab() {
  const [fundFilter, setFundFilter] = useState('');
  const { data: dists, loading, error, reload } =
    useIrLoad(() => api.getIrDistributions({ fundId: fundFilter }), [fundFilter]);

  const [funds, setFunds] = useState([]);
  useEffect(() => { api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  const [expandedId, setExpandedId] = useState(null);
  const [allocs, setAllocs] = useState({ loading: false, error: '', rows: [] });
  const [payEdit, setPayEdit] = useState(null); // { allocId, paidDate }
  const [actionErr, setActionErr] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const loadAllocs = useCallback(async (distId) => {
    setAllocs({ loading: true, error: '', rows: [] });
    try {
      const rows = await api.getIrDistributionAllocations(distId);
      setAllocs({ loading: false, error: '', rows: Array.isArray(rows) ? rows : [] });
    } catch (e) {
      setAllocs({ loading: false, error: e?.message || 'Failed to load allocations', rows: [] });
    }
  }, []);

  const toggle = (dist) => {
    setPayEdit(null); setActionErr('');
    if (expandedId === dist.id) { setExpandedId(null); return; }
    setExpandedId(dist.id);
    loadAllocs(dist.id);
  };

  const markAllocPaid = async (alloc, paidDate) => {
    if (actionBusy) return;
    setActionBusy(true); setActionErr('');
    try {
      await api.updateIrDistributionAllocation(alloc.id, { status: 'paid', paidDate });
      setPayEdit(null);
      await loadAllocs(alloc.distributionId);
      await reload();
    } catch (e) {
      setActionErr(e?.message || 'Update failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const setDistStatus = async (dist, status, confirmMsg) => {
    if (actionBusy) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setActionBusy(true); setActionErr('');
    try {
      await api.updateIrDistribution(dist.id, { status });
      await reload();
      if (expandedId === dist.id) await loadAllocs(dist.id);
    } catch (e) {
      setActionErr(e?.message || 'Update failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');

  const openAdd = () => {
    setFormErr('');
    setModal({ fundId: fundFilter || '', title: '', distributionType: 'return_of_capital', totalAmount: '', distributionDate: today() });
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      await api.createIrDistribution({
        fundId: Number(modal.fundId),
        title: modal.title.trim(),
        distributionType: modal.distributionType,
        totalAmount: Number(modal.totalAmount) || 0,
        distributionDate: modal.distributionDate || null,
      });
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Could not create the distribution.');
    } finally {
      setBusy(false);
    }
  };

  const rows = dists || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Distributions</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Capital returned to LPs — expand a distribution to confirm investor payments</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 200 }} value={fundFilter} onChange={e => setFundFilter(e.target.value)}>
            <option value="">All Deals</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New Distribution
          </button>
        </div>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={ArrowUpFromLine} title="No Distributions"
          sub={fundFilter ? 'This fund has not distributed capital yet.' : 'Record a distribution when the portfolio returns capital to investors.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(dist => {
            const open = expandedId === dist.id;
            const paid = dist.paidAmount ?? 0;
            const total = dist.totalAmount ?? 0;
            return (
              <div key={dist.id} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
                <div onClick={() => toggle(dist)} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') toggle(dist); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', cursor: 'pointer', flexWrap: 'wrap' }}>
                  {open ? <ChevronDown size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <ChevronRight size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{dist.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      Distribution #{dist.distributionNumber} · {dist.fundName} · {statusLabel(dist.distributionType)} · {formatDate(dist.distributionDate)}
                    </div>
                  </div>
                  <div style={{ flex: '0 1 220px', minWidth: 160 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4, fontVariantNumeric: 'tabular-nums' }}>
                      <span><strong style={{ color: 'var(--ink)' }}>{formatCurrency(paid)}</strong> paid out</span>
                      <span>of {formatCurrency(total)}</span>
                    </div>
                    <ThinBar value={paid} max={total} color="hsl(var(--color-green))" />
                  </div>
                  <StatusText status={dist.status} />
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      {dist.status === 'draft' && (
                        <button className="primary-btn" disabled={actionBusy}
                          onClick={() => setDistStatus(dist, 'issued', 'Issue this distribution? Investor allocations become payable.')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                          <Send size={13} /> Issue Distribution
                        </button>
                      )}
                      {dist.status === 'issued' && (
                        <button className="secondary-btn" disabled={actionBusy}
                          onClick={() => setDistStatus(dist, 'paid', 'Mark the whole distribution paid? Use the per-investor actions below if only some payments have cleared.')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                          <Check size={13} /> Mark Distribution Paid
                        </button>
                      )}
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {dist.allocationCount ?? allocs.rows.length} allocation{(dist.allocationCount ?? allocs.rows.length) === 1 ? '' : 's'} · {formatCurrency(dist.pendingAmount)} pending
                      </span>
                    </div>

                    {actionErr && <ErrorState message={actionErr} />}

                    {allocs.loading ? <LoadingState label="Loading allocations…" /> : allocs.error ? <ErrorState message={allocs.error} onRetry={() => loadAllocs(dist.id)} /> : allocs.rows.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '8px 0' }}>No allocations yet — they generate when the distribution is issued.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table className="req-table">
                          <thead>
                            <tr>
                              <th>Investor</th>
                              <th style={{ textAlign: 'right' }}>Amount</th>
                              <th>Status</th>
                              <th>Paid Date</th>
                              <th style={{ textAlign: 'right' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allocs.rows.map(a => (
                              <tr key={a.id}>
                                <td style={{ fontWeight: 600 }}>{a.investorName}</td>
                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(a.amount)}</td>
                                <td><StatusText status={a.status} /></td>
                                <td style={{ fontSize: 12, color: 'var(--muted)' }}>{a.status === 'paid' ? formatDate(a.paidDate) : '—'}</td>
                                <td style={{ textAlign: 'right' }}>
                                  {a.status === 'pending' && payEdit?.allocId !== a.id && (
                                    <span style={{ display: 'inline-flex', gap: 6 }}>
                                      <button className="primary-btn" disabled={actionBusy}
                                        onClick={() => markAllocPaid(a, today())}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Mark Paid
                                      </button>
                                      <button className="secondary-btn" disabled={actionBusy}
                                        onClick={() => setPayEdit({ allocId: a.id, paidDate: today() })}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Pick Date…
                                      </button>
                                    </span>
                                  )}
                                  {payEdit?.allocId === a.id && (
                                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                      <input className="form-input" type="date" value={payEdit.paidDate}
                                        onChange={e => setPayEdit(p => ({ ...p, paidDate: e.target.value }))}
                                        style={{ width: 140, padding: '4px 8px', fontSize: 12 }} />
                                      <button className="primary-btn" disabled={actionBusy}
                                        onClick={() => markAllocPaid(a, payEdit.paidDate)}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Save
                                      </button>
                                      <button className="secondary-btn" onClick={() => setPayEdit(null)} style={{ fontSize: 11.5, padding: '4px 10px' }}>Cancel</button>
                                    </span>
                                  )}
                                  {a.status === 'paid' && <Check size={14} style={{ color: 'hsl(var(--color-green))' }} />}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <Modal title="New Distribution" onClose={() => setModal(null)}>
          <form onSubmit={create}>
            <div className="form-grid">
              <FG label="Deal" full>
                <select className="form-select" required value={modal.fundId} onChange={e => setModal(m => ({ ...m, fundId: e.target.value }))}>
                  <option value="">Select a deal…</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FG>
              <FG label="Title" full>
                <input className="form-input" required value={modal.title} placeholder="e.g. Q2 2026 Preferred Return"
                  onChange={e => setModal(m => ({ ...m, title: e.target.value }))} />
              </FG>
              <FG label="Distribution Type">
                <select className="form-select" value={modal.distributionType} onChange={e => setModal(m => ({ ...m, distributionType: e.target.value }))}>
                  {DIST_TYPES.map(t => <option key={t} value={t}>{statusLabel(t)}</option>)}
                </select>
              </FG>
              <FG label="Total Amount ($)">
                <input className="form-input" type="number" min="0" step="any" required value={modal.totalAmount}
                  onChange={e => setModal(m => ({ ...m, totalAmount: e.target.value }))} />
              </FG>
              <FG label="Distribution Date">
                <input className="form-input" type="date" required value={modal.distributionDate}
                  onChange={e => setModal(m => ({ ...m, distributionDate: e.target.value }))} />
              </FG>
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                Create Draft Distribution
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
