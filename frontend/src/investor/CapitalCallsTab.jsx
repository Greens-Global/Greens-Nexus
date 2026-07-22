import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, Loader, Plus, Send } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate } from './lib/format';
import { EmptyState, ErrorState, FG, LoadingState, Modal, StatusText, ThinBar, useIrLoad } from './lib/ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function CapitalCallsTab() {
  const [fundFilter, setFundFilter] = useState('');
  const { data: calls, loading, error, reload } =
    useIrLoad(() => api.getIrCapitalCalls({ fundId: fundFilter }), [fundFilter]);

  const [funds, setFunds] = useState([]);
  useEffect(() => { api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  // Expanded call + its allocations
  const [expandedId, setExpandedId] = useState(null);
  const [allocs, setAllocs] = useState({ loading: false, error: '', rows: [] });
  const [payEdit, setPayEdit] = useState(null); // { allocId, paidDate, paidAmount }
  const [actionErr, setActionErr] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const loadAllocs = useCallback(async (callId) => {
    setAllocs({ loading: true, error: '', rows: [] });
    try {
      const rows = await api.getIrCapitalCallAllocations(callId);
      setAllocs({ loading: false, error: '', rows: Array.isArray(rows) ? rows : [] });
    } catch (e) {
      setAllocs({ loading: false, error: e?.message || 'Failed to load allocations', rows: [] });
    }
  }, []);

  const toggle = (call) => {
    setPayEdit(null); setActionErr('');
    if (expandedId === call.id) { setExpandedId(null); return; }
    setExpandedId(call.id);
    loadAllocs(call.id);
  };

  const setAllocStatus = async (alloc, patch) => {
    if (actionBusy) return;
    setActionBusy(true); setActionErr('');
    try {
      await api.updateIrCapitalCallAllocation(alloc.id, patch);
      setPayEdit(null);
      await loadAllocs(alloc.callId);
      await reload(); // refresh paid/pending aggregates on the call rows
    } catch (e) {
      setActionErr(e?.message || 'Update failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const setCallStatus = async (call, status, confirmMsg) => {
    if (actionBusy) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setActionBusy(true); setActionErr('');
    try {
      await api.updateIrCapitalCall(call.id, { status });
      await reload();
      if (expandedId === call.id) await loadAllocs(call.id);
    } catch (e) {
      setActionErr(e?.message || 'Update failed.');
    } finally {
      setActionBusy(false);
    }
  };

  // New Capital Call modal
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');

  const openAdd = () => {
    setFormErr('');
    setModal({ fundId: fundFilter || '', title: '', purpose: '', totalAmount: '', noticeDate: today(), dueDate: '' });
  };

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      await api.createIrCapitalCall({
        fundId: Number(modal.fundId),
        title: modal.title.trim(),
        purpose: modal.purpose.trim() || null,
        totalAmount: Number(modal.totalAmount) || 0,
        noticeDate: modal.noticeDate || null,
        dueDate: modal.dueDate || null,
      });
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Could not create the capital call.');
    } finally {
      setBusy(false);
    }
  };

  const rows = calls || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Capital Calls</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Draft, issue, and collect — expand a call to work its investor allocations</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 200 }} value={fundFilter} onChange={e => setFundFilter(e.target.value)}>
            <option value="">All Deals</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New Capital Call
          </button>
        </div>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={ArrowDownToLine} title="No Capital Calls"
          sub={fundFilter ? 'This fund has no capital calls yet.' : 'Issue your first capital call to start collecting committed capital.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(call => {
            const open = expandedId === call.id;
            const paid = call.paidAmount ?? 0;
            const total = call.totalAmount ?? 0;
            return (
              <div key={call.id} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
                <div onClick={() => toggle(call)} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') toggle(call); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', cursor: 'pointer', flexWrap: 'wrap' }}>
                  {open ? <ChevronDown size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <ChevronRight size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{call.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      Call #{call.callNumber} · {call.fundName} · Notice {formatDate(call.noticeDate)} · Due {formatDate(call.dueDate)}
                    </div>
                  </div>
                  <div style={{ flex: '0 1 220px', minWidth: 160 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)', marginBottom: 4, fontVariantNumeric: 'tabular-nums' }}>
                      <span><strong style={{ color: 'var(--ink)' }}>{formatCurrency(paid)}</strong> collected</span>
                      <span>of {formatCurrency(total)}</span>
                    </div>
                    <ThinBar value={paid} max={total} color="hsl(var(--color-green))" />
                  </div>
                  <StatusText status={call.status} />
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px' }}>
                    {call.purpose && <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>{call.purpose}</p>}

                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      {call.status === 'draft' && (
                        <button className="primary-btn" disabled={actionBusy}
                          onClick={() => setCallStatus(call, 'issued', 'Issue this capital call? Allocations become due for every committed investor.')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                          <Send size={13} /> Issue Call
                        </button>
                      )}
                      {call.status === 'issued' && (
                        <button className="secondary-btn" disabled={actionBusy}
                          onClick={() => setCallStatus(call, 'closed', 'Close this capital call? No further payments will be tracked against it.')}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                          <Check size={13} /> Close Call
                        </button>
                      )}
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {call.allocationCount ?? allocs.rows.length} allocation{(call.allocationCount ?? allocs.rows.length) === 1 ? '' : 's'} · {formatCurrency(call.pendingAmount)} outstanding
                      </span>
                    </div>

                    {actionErr && <ErrorState message={actionErr} />}

                    {allocs.loading ? <LoadingState label="Loading allocations…" /> : allocs.error ? <ErrorState message={allocs.error} onRetry={() => loadAllocs(call.id)} /> : allocs.rows.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '8px 0' }}>No allocations yet — they generate when the call is issued.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table className="req-table">
                          <thead>
                            <tr>
                              <th>Investor</th>
                              <th style={{ textAlign: 'right' }}>Amount</th>
                              <th>Status</th>
                              <th>Paid</th>
                              <th style={{ textAlign: 'right' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allocs.rows.map(a => (
                              <tr key={a.id}>
                                <td style={{ fontWeight: 600 }}>{a.investorName}</td>
                                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(a.amount)}</td>
                                <td><StatusText status={a.status} /></td>
                                <td style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                                  {a.status === 'paid' ? `${formatCurrency(a.paidAmount ?? a.amount)} on ${formatDate(a.paidDate)}` : '—'}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {(a.status === 'pending' || a.status === 'overdue') && payEdit?.allocId !== a.id && (
                                    <span style={{ display: 'inline-flex', gap: 6 }}>
                                      <button className="primary-btn" disabled={actionBusy}
                                        onClick={() => setAllocStatus(a, { status: 'paid', paidDate: today(), paidAmount: a.amount })}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Mark Paid
                                      </button>
                                      <button className="secondary-btn" disabled={actionBusy}
                                        onClick={() => setPayEdit({ allocId: a.id, paidDate: today(), paidAmount: String(a.amount ?? '') })}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Record Partial…
                                      </button>
                                      <button className="secondary-btn" disabled={actionBusy}
                                        onClick={() => { if (window.confirm('Waive this allocation? The investor will not be asked for this capital.')) setAllocStatus(a, { status: 'waived' }); }}
                                        style={{ fontSize: 11.5, padding: '4px 10px', color: 'var(--muted)' }}>
                                        Waive
                                      </button>
                                    </span>
                                  )}
                                  {payEdit?.allocId === a.id && (
                                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                      <input className="form-input" type="date" value={payEdit.paidDate}
                                        onChange={e => setPayEdit(p => ({ ...p, paidDate: e.target.value }))}
                                        style={{ width: 140, padding: '4px 8px', fontSize: 12 }} />
                                      <input className="form-input" type="number" min="0" step="any" value={payEdit.paidAmount}
                                        onChange={e => setPayEdit(p => ({ ...p, paidAmount: e.target.value }))}
                                        style={{ width: 110, padding: '4px 8px', fontSize: 12 }} />
                                      <button className="primary-btn" disabled={actionBusy}
                                        onClick={() => setAllocStatus(a, { status: 'paid', paidDate: payEdit.paidDate, paidAmount: Number(payEdit.paidAmount) || 0 })}
                                        style={{ fontSize: 11.5, padding: '4px 10px' }}>
                                        Save
                                      </button>
                                      <button className="secondary-btn" onClick={() => setPayEdit(null)} style={{ fontSize: 11.5, padding: '4px 10px' }}>Cancel</button>
                                    </span>
                                  )}
                                  {a.status === 'waived' && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Waived</span>}
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
        <Modal title="New Capital Call" onClose={() => setModal(null)}>
          <form onSubmit={create}>
            <div className="form-grid">
              <FG label="Deal" full>
                <select className="form-select" required value={modal.fundId} onChange={e => setModal(m => ({ ...m, fundId: e.target.value }))}>
                  <option value="">Select a deal…</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FG>
              <FG label="Title" full>
                <input className="form-input" required value={modal.title} placeholder="e.g. Call 2 — Renovation Draw"
                  onChange={e => setModal(m => ({ ...m, title: e.target.value }))} />
              </FG>
              <FG label="Purpose" full>
                <textarea className="form-input" value={modal.purpose} placeholder="What this capital funds — shown on the notice…"
                  onChange={e => setModal(m => ({ ...m, purpose: e.target.value }))} style={{ minHeight: 64, resize: 'vertical' }} />
              </FG>
              <FG label="Total Amount ($)">
                <input className="form-input" type="number" min="0" step="any" required value={modal.totalAmount}
                  onChange={e => setModal(m => ({ ...m, totalAmount: e.target.value }))} />
              </FG>
              <FG label="Notice Date">
                <input className="form-input" type="date" value={modal.noticeDate} onChange={e => setModal(m => ({ ...m, noticeDate: e.target.value }))} />
              </FG>
              <FG label="Due Date">
                <input className="form-input" type="date" required value={modal.dueDate} onChange={e => setModal(m => ({ ...m, dueDate: e.target.value }))} />
              </FG>
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                Create Draft Call
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
