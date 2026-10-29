// Review & Push (Miranda's mockup, artboard 4): the proposed changes - new web
// and standard rates from the Proposed column, and promotions (Cubby calls them
// discounts) - approved by an Ops Manager or the Owner, then pushed to Cubby
// (only with Settings > Global Settings > Operations > Push to Cubby on) or,
// with the switch off, marked Entered in Cubby after staff typed them there.
// Guardrails are the server's (routers/ops_cma.py): over 10% or below the
// market low needs the Owner, .50 endings kept, never twice in 7 days, read
// back from Cubby, one-click revert, idempotent by request id. Cubby's API has
// no discount write, so promotions are always entered by hand.
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Eye, Plus, RotateCcw, Send, X } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, LoadingState } from '../../components/AsyncState';
import { Modal, AvatarName, usePeople } from '../../tasks/components';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { dash, exportRows, requestId, signedUsd, usd } from './cmaModel';

const STATUS = {
  approved: ['pill-info', 'Approved'], pushed: ['status-approved', 'Pushed to Cubby'], entered: ['status-approved', 'Entered in Cubby'],
  failed: ['status-rejected', 'Push Failed'], rejected: ['pill-muted', 'Returned'], reverted: ['pill-muted', 'Reverted'],
};
const usDay = (iso) => (iso ? formatDate(iso) : dash);

function PromoModal({ data, onClose, onSaved }) {
  const [f, setF] = useState({ kind: 'promo_add', name: '', calculation: 'percent', amount: '', periods: '1', start: '', end: '', reason: '', units: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggle = (n) => setF({ ...f, units: f.units.includes(n) ? f.units.filter((x) => x !== n) : [...f.units, n] });
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.proposeOpsCmaPromo({ facility_id: data.facilityId, kind: f.kind, name: f.name, calculation: f.calculation,
        amount: f.amount === '' ? null : Number(f.amount), periods: Number(f.periods) || 1, start: f.start, end: f.end,
        unit_types: f.units, reason: f.reason });
      onSaved();
    } catch (err) {
      console.error('Operations: promotion could not be proposed', err);
      setError(err?.status === 422 && err?.message ? err.message : 'The promotion could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Propose a Promotion" onClose={onClose} width="60vw" minHeight="60vh" footer={<>
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="primary-btn" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Add to Review'}</button>
    </>}>
      <p className="cma-note" style={{ marginTop: 0 }}>A promotion is a discount in Cubby. Cubby&apos;s API can&apos;t create or end one, so once approved it is entered in Cubby (Pricing &gt; Discounts) by hand and marked entered here.</p>
      <div className="cma-form">
        <label>What
          <select className="form-input" value={f.kind} onChange={set('kind')}>
            <option value="promo_add">New Promotion</option><option value="promo_end">End a Promotion</option>
          </select>
        </label>
        <label>Discount Name<input className="form-input" value={f.name} maxLength={120} onChange={set('name')} placeholder="First 2 months 50% off" /></label>
        {f.kind === 'promo_add' && (
          <>
            <label>Calculation
              <select className="form-input" value={f.calculation} onChange={set('calculation')}>
                {Object.entries(data.calculations).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {f.calculation !== 'first_month_1' && (
              <label>{f.calculation === 'percent' ? 'Percent Off' : 'Amount Off ($)'}<input className="form-input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
            )}
            <label>Number of Periods<input className="form-input" type="number" min="1" max="24" value={f.periods} onChange={set('periods')} /></label>
            <label>Start Date<input className="form-input" type="date" value={f.start} onChange={set('start')} /></label>
          </>
        )}
        <label>End Date<input className="form-input" type="date" value={f.end} onChange={set('end')} /></label>
        <label className="nx-fill" style={{ gridColumn: '1 / -1' }}>Why<textarea className="form-input" rows={3} value={f.reason} maxLength={300} onChange={set('reason')} placeholder="66% occupied with 47 vacant; rate already below market" /></label>
      </div>
      <fieldset style={{ border: '1px solid var(--line)', borderRadius: 10, marginTop: 12, padding: '8px 12px' }}>
        <legend style={{ fontSize: 12, fontWeight: 600 }}>Pricing Groups</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
          {data.unitTypes.map((u) => (
            <label key={u.name} style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={f.units.includes(u.name)} onChange={() => toggle(u.name)} /> {u.name}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="cma-error" role="alert">{error}</p>}
    </Modal>
  );
}

function PreviewModal({ items, onClose }) {
  return (
    <Modal title="What Cubby Will Show" onClose={onClose} width="60vw" minHeight="60vh">
      <p className="cma-note" style={{ marginTop: 0 }}>After these changes, each pricing group in Cubby (Pricing &gt; Pricing Groups) reads:</p>
      <div className="req-table-wrapper">
        <table className="req-table stack-table cma-table" data-testid="preview-table">
          <thead><tr><th>Pricing Group</th><th className="num">Standard Rate</th><th className="num">Web Rate</th><th>Discount</th><th>From</th></tr></thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.key}>
                <td><strong>{x.type === 'rate' ? x.unitType : x.promo.unitTypes.join(', ')}</strong></td>
                <td className="num">{x.type === 'rate' ? <>{usd(x.newStandard)} <span className="rm-muted">was {usd(x.nowStandard)}</span></> : dash}</td>
                <td className="num">{x.type === 'rate' ? <>{usd(x.newWeb)} <span className="rm-muted">was {usd(x.nowWeb)}</span></> : dash}</td>
                <td>{x.type === 'rate' ? dash : `${x.kind === 'promo_end' ? 'Ends: ' : ''}${x.promo.name} (${x.promoText})`}</td>
                <td>{usDay(x.effective)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cma-note">Existing tenants&apos; rents are not touched - their increases stay in Cubby&apos;s ECRI queue.</p>
    </Modal>
  );
}

export default function CmaReview({ facility, onSection, onChanged }) {
  const fid = facility.id;
  // approvedBy / doneBy arrive as emails: shown as the person (face + name).
  const people = usePeople();
  const who = (email) => {
    const p = people.find((x) => x.email === (email || '').toLowerCase());
    return <AvatarName email={email} name={p?.name || email} size={18} />;
  };
  const [state, setState] = useState({ status: 'loading', data: null });
  const [picked, setPicked] = useState(null);
  const [role, setRole] = useState('ops_manager');
  const [send, setSend] = useState('effective');
  const [effective, setEffective] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState([]);
  const [modal, setModal] = useState('');
  const load = useCallback(async () => {
    try { setState({ status: 'ready', data: await api.getOpsCmaReview(fid) }); } catch (err) {
      console.error('Operations: review could not be loaded', err);
      setState({ status: 'error', data: null });
    }
  }, [fid]);
  useEffect(() => { load(); }, [load]);
  if (state.status === 'loading') return <LoadingState size="section" label="Loading the review" minHeight={240} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the review." onRetry={load} />;
  const d = state.data;
  const items = [
    ...d.rates.map((r) => ({ ...r, key: `rate:${r.unitType}` })),
    ...d.promos.map((p) => ({ ...p, type: 'promo', key: `promo:${p.id}` })),
  ];
  const open = items.filter((x) => !(x.blocks || []).length);
  const chosen = picked ? items.filter((x) => picked.has(x.key)) : open;
  const isOn = (x) => (picked ? picked.has(x.key) : !(x.blocks || []).length);
  const toggle = (x) => {
    const s = new Set(picked || open.map((y) => y.key));
    if (s.has(x.key)) s.delete(x.key); else s.add(x.key);
    setPicked(s);
  };
  const needsOwner = chosen.some((x) => x.needsOwner);
  const pushReady = d.pushOn && d.pushReady;
  const proposers = [...new Set(items.map((x) => x.proposedBy).filter(Boolean))];
  const firstEff = chosen.map((x) => x.effective).filter(Boolean).sort()[0] || '';
  const setView = (data) => { setState({ status: 'ready', data }); onChanged?.(); };

  const apply = async (mode) => {
    setBusy(mode); setError(''); setResults([]);
    try {
      const out = await api.applyOpsCmaReview({
        facility_id: fid, request_id: requestId(), approver_role: role, send, effective_date: effective, note, mode,
        rates: chosen.filter((x) => x.type === 'rate').map((x) => x.unitType),
        promos: chosen.filter((x) => x.type === 'promo').map((x) => x.id),
      });
      setResults(out.results);
      setPicked(null);
      setView(out.review);
    } catch (err) {
      console.error('Operations: review could not be applied', err);
      setError(err?.message || 'That could not be saved. Nothing was changed. Try again.');
    } finally { setBusy(''); }
  };
  const reject = async () => {
    const why = window.prompt('Return these to the proposer? A note for them (optional):', '');
    if (why === null) return;
    setBusy('reject'); setError('');
    try {
      setView(await api.rejectOpsCmaReview({ facility_id: fid, note: why, rates: chosen.filter((x) => x.type === 'rate').map((x) => x.unitType),
        promos: chosen.filter((x) => x.type === 'promo').map((x) => x.id) }));
      setPicked(null);
    } catch (err) {
      console.error('Operations: reject failed', err);
      setError('That could not be saved. Try again.');
    } finally { setBusy(''); }
  };
  const act = async (fn, label) => {
    setBusy(label); setError('');
    try { setView(await fn()); } catch (err) { console.error(`Operations: ${label} failed`, err); setError(err?.message || 'That did not work. Try again.'); } finally { setBusy(''); }
  };
  const exportList = (format) => exportRows(format, {
    title: 'CMA Review', facility: d.facility, asOf: d.asOf, rows: items,
    columns: [
      { header: 'Cubby Pricing Group', get: (x) => (x.type === 'rate' ? x.unitType : (x.promo.unitTypes || []).join('; ')), width: 26 },
      { header: 'Change', get: (x) => (x.type === 'rate' ? x.change : x.kind === 'promo_end' ? 'End Promotion' : 'Add Promotion'), width: 16 },
      { header: 'Web Rate Now', get: (x) => (x.type === 'rate' ? usd(x.nowWeb) : ''), width: 12 },
      { header: 'New Web Rate', get: (x) => (x.type === 'rate' ? usd(x.newWeb) : ''), width: 12 },
      { header: 'Standard Rate Now', get: (x) => (x.type === 'rate' ? usd(x.nowStandard) : ''), width: 14 },
      { header: 'New Standard Rate', get: (x) => (x.type === 'rate' ? usd(x.newStandard) : ''), width: 14 },
      { header: 'Promotion', get: (x) => (x.type === 'promo' ? `${x.promo.name} - ${x.promoText}` : ''), width: 30 },
      { header: 'Why', get: (x) => (x.type === 'rate' ? x.why : x.reason), width: 40 },
      { header: 'Effective', get: (x) => usDay(x.effective), width: 12 },
      { header: 'Who It Affects', get: (x) => x.affects, width: 28 },
      { header: 'Guardrails', get: (x) => [...(x.notes || []), ...(x.blocks || [])].join('; '), width: 40 },
    ],
  }).catch((err) => console.error('Operations: review export failed', err));

  return (
    <>
      <div className="dash-card" data-testid="cma-review">
        <div className="cma-crumb"><button type="button" onClick={() => onSection('overview')}>CMA · {d.facility}</button> / Review &amp; Push</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <div>
            <h2 className="cma-title">{d.pushOn ? 'Review & Push to Cubby' : 'Review & Mark Entered in Cubby'}</h2>
            <div className="cma-sub">
              {d.name} · {items.length} {items.length === 1 ? 'change' : 'changes'} proposed{proposers.length ? ` by ${proposers.join(', ')}` : ''} · nothing changes in Cubby until approved
            </div>
          </div>
          {items.length > 0 && <span className="status-badge status-pending">Awaiting Approval</span>}
        </div>
        {!d.pushOn && (
          <p className="cma-note">Push to Cubby is turned off (Settings &gt; Operations), so Nexus only reads from Cubby. Enter the approved changes in Cubby by hand, then mark them entered here.</p>
        )}
        {d.pushOn && !d.pushReady && <p className="cma-note" style={{ color: 'var(--warn-fg)' }}>Push to Cubby is on, but this server has no Cubby key with the Manager role yet, so changes can only be marked entered.</p>}
        <div className="cma-actions">
          {d.canPropose && <button type="button" className="secondary-btn cma-btn" onClick={() => setModal('promo')}><Plus size={14} aria-hidden="true" /> Propose a Promotion</button>}
          <button type="button" className="secondary-btn cma-btn" onClick={() => exportList('csv')} disabled={!items.length}>Export CSV</button>
          <button type="button" className="secondary-btn cma-btn" onClick={() => exportList('xls')} disabled={!items.length}>Export XLS</button>
        </div>
      </div>

      <div className="cma-side">
        <section className="cma-panel" aria-label="Proposed changes">
          {items.length === 0 ? (
            <div className="ops-empty">Nothing proposed. Type a Proposed rate on the CMA Overview, or propose a promotion.</div>
          ) : (
            <div className="req-table-wrapper">
              <table className="req-table stack-table cma-table" data-testid="review-table">
                <thead><tr>
                  <th aria-label="Include" /><th>Cubby Pricing Group</th><th>Change</th><th className="num">Now in Cubby</th><th className="num">New</th>
                  <th>Why</th><th>Effective</th><th>Who It Affects</th>
                </tr></thead>
                <tbody>
                  {items.map((x) => {
                    const blocked = (x.blocks || []).length > 0;
                    const guard = (
                      <>
                        {(x.notes || []).map((n) => <div key={n} className="cma-why" style={{ color: 'var(--warn-fg)' }}>{n}</div>)}
                        {(x.blocks || []).map((n) => <div key={n} className="cma-why" style={{ color: 'var(--bad-fg)' }}>{n}</div>)}
                      </>
                    );
                    if (x.type === 'promo') {
                      return (
                        <tr key={x.key}>
                          <td><input type="checkbox" checked={isOn(x)} onChange={() => toggle(x)} aria-label={`Include ${x.promo.name}`} /></td>
                          <td><strong>{(x.promo.unitTypes || []).join(', ')}</strong></td>
                          <td data-th="Change"><span className="status-badge pill-info">{x.kind === 'promo_end' ? 'End Promotion' : 'Add Promotion'}</span><div className="cma-type-sub">Cubby discount program</div></td>
                          <td className="num" data-th="Now in Cubby">{x.kind === 'promo_end' ? x.promo.name : dash}</td>
                          <td className="num" data-th="New">{x.kind === 'promo_end' ? 'Ended' : <><strong>{x.promoText}</strong><div className="cma-type-sub">{x.promo.name}</div></>}</td>
                          <td data-th="Why"><div className="cma-why">{x.reason || dash}</div>
                            {d.canPropose && <button type="button" className="rm-linkbtn cma-why" onClick={() => act(async () => { await api.withdrawOpsCmaPromo(x.id); return api.getOpsCmaReview(fid); }, 'withdraw')}>Withdraw</button>}
                          </td>
                          <td data-th="Effective" style={{ whiteSpace: 'nowrap' }}>{x.promo.start ? `${usDay(x.promo.start)} - ${usDay(x.promo.end)}` : usDay(x.promo.end)}</td>
                          <td data-th="Who It Affects">{x.affects}</td>
                        </tr>
                      );
                    }
                    return (
                      <Fragment key={x.key}>
                        <tr>
                          <td rowSpan={2}><input type="checkbox" checked={isOn(x)} disabled={blocked} onChange={() => toggle(x)} aria-label={`Include ${x.unitType}`} /></td>
                          <td rowSpan={2}><strong>{x.unitType}</strong><div className="cma-type-sub">{signedUsd(x.revDelta)} / mo on occupied units</div></td>
                          <td data-th="Change"><span className={`status-badge ${x.newWeb >= x.nowWeb ? 'status-approved' : 'pill-warn'}`}>{x.change}</span><div className="cma-type-sub">Web (sell) rate</div></td>
                          <td className="num" data-th="Now in Cubby">{usd(x.nowWeb)}</td>
                          <td className="num" data-th="New"><strong>{usd(x.newWeb)}</strong></td>
                          <td data-th="Why"><div className="cma-why">{x.why}</div>{guard}</td>
                          <td data-th="Effective" style={{ whiteSpace: 'nowrap' }}>{usDay(effective || x.effective)}</td>
                          <td data-th="Who It Affects">{x.affects}</td>
                        </tr>
                        <tr>
                          <td data-th="Change"><span className={`status-badge ${x.newStandard >= x.nowStandard ? 'status-approved' : 'pill-warn'}`}>{x.change}</span><div className="cma-type-sub">Set (standard) rate</div></td>
                          <td className="num" data-th="Now in Cubby">{usd(x.nowStandard)}</td>
                          <td className="num" data-th="New"><strong>{usd(x.newStandard)}</strong></td>
                          <td data-th="Why"><div className="cma-why">Keep the standard rate in step with the web rate</div></td>
                          <td data-th="Effective" style={{ whiteSpace: 'nowrap' }}>{usDay(effective || x.effective)}</td>
                          <td data-th="Who It Affects">Walk-in quotes</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="cma-actions">
            <button type="button" className="secondary-btn cma-btn" onClick={() => onSection('overview')}><ArrowLeft size={14} aria-hidden="true" /> Back to CMA</button>
            <span className="cma-hint">Existing tenants aren&apos;t touched - their increases stay in Cubby&apos;s ECRI queue.</span>
          </div>
          {results.length > 0 && (
            <ul className="cma-note" data-testid="apply-results" style={{ paddingLeft: 16 }}>
              {results.map((r) => (
                <li key={r.key}><strong>{r.unitType || r.promo?.name}</strong>: {(STATUS[r.status] || ['', r.status === 'blocked' ? 'Not Approved' : 'Skipped'])[1]}{r.detail ? ` - ${r.detail}` : ''}</li>
              ))}
            </ul>
          )}
        </section>

        <div className="cma-cards">
          <section className="cma-panel" aria-label={d.pushOn ? 'Approve and push' : 'Approve and mark entered'}>
            <h3 className="cma-h3">{pushReady ? 'Approve & Push' : 'Approve & Mark Entered'}</h3>
            <div className="cma-form" style={{ gridTemplateColumns: '1fr', marginTop: 10 }}>
              <label>Proposed By<input className="form-input" readOnly value={proposers.join(', ') || dash} /></label>
              <label>Approver
                <select className="form-input" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Approver">
                  {Object.entries(d.roleLabels).map(([k, l]) => <option key={k} value={k} disabled={!d.roles[k]}>{l}{d.roles[k] ? '' : ' (not you)'}</option>)}
                </select>
              </label>
              {pushReady && (
                <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                  <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Send to Cubby</legend>
                  <label style={{ flexDirection: 'row', gap: 6, fontWeight: 400 }}><input type="radio" name="send" checked={send === 'effective'} onChange={() => setSend('effective')} /> On effective date ({usDay(effective || firstEff)})</label>
                  <label style={{ flexDirection: 'row', gap: 6, fontWeight: 400 }}><input type="radio" name="send" checked={send === 'immediate'} onChange={() => setSend('immediate')} /> Immediately after approval</label>
                </fieldset>
              )}
              <label>Effective Date<input className="form-input" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} aria-label="Effective date" /></label>
              <label>Note for the Log<input className="form-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Oct CMA - 12x32 below market, 12x26 promo test" /></label>
            </div>
            {needsOwner && role !== 'owner' && <p className="cma-note" style={{ color: 'var(--warn-fg)' }}>A ticked change needs the Owner as approver.</p>}
            {error && <p className="cma-error" role="alert">{error}</p>}
            <div className="cma-actions">
              <button type="button" className="secondary-btn cma-btn" onClick={reject} disabled={!chosen.length || !!busy || !d.roles.ops_manager}><X size={14} aria-hidden="true" /> Reject</button>
              <button type="button" className="secondary-btn cma-btn" onClick={() => setModal('preview')} disabled={!chosen.length}><Eye size={14} aria-hidden="true" /> Preview What Cubby Will Show</button>
              {pushReady ? (
                <button type="button" className="primary-btn cma-btn" onClick={() => apply('push')} disabled={!chosen.length || !!busy || !d.roles[role]}>
                  <Send size={14} aria-hidden="true" /> {busy === 'push' ? 'Pushing' : `Approve & Push ${chosen.length} ${chosen.length === 1 ? 'Change' : 'Changes'}`}
                </button>
              ) : null}
              <button type="button" className={pushReady ? 'secondary-btn cma-btn' : 'primary-btn cma-btn'} onClick={() => apply('entered')} disabled={!chosen.length || !!busy || !d.roles[role]}
                title="Staff entered these in Cubby by hand">
                <Check size={14} aria-hidden="true" /> {busy === 'entered' ? 'Saving' : `Mark ${chosen.length} Entered in Cubby`}
              </button>
            </div>
            {!d.roles.ops_manager && <p className="cma-note">Approving needs an Ops Manager (a manager, or Full access to Operations).</p>}
          </section>
          <section className="cma-panel cma-after">
            <h3 className="cma-h3">After It&apos;s Pushed</h3>
            <p className="cma-note">Nexus reads the new rates back from Cubby to confirm each change landed, records it in Rate History, and keeps a one-click revert to the previous rate.</p>
          </section>
          <section className="cma-panel cma-guard">
            <h3 className="cma-h3">Guardrails</h3>
            <ul>
              <li>Changes over 10% or below the market low need the Owner&apos;s approval</li>
              <li>Rates ending in .50 are kept</li>
              <li>A pricing group can&apos;t change twice in 7 days</li>
            </ul>
          </section>
        </div>
      </div>

      {d.decided.length > 0 && (
        <section className="cma-panel" aria-label="Decided changes">
          <h3 className="cma-h3">Decided</h3>
          <div className="req-table-wrapper">
            <table className="req-table stack-table cma-table" data-testid="decided-table">
              <thead><tr><th>Pricing Group</th><th>Change</th><th>Status</th><th>Approved</th><th>Done</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {d.decided.map((c) => {
                  const [cls, label] = STATUS[c.status] || ['pill-muted', c.status];
                  return (
                    <tr key={c.id}>
                      <td><strong>{c.kind === 'rate' ? c.unitType : (c.promo.unitTypes || []).join(', ')}</strong>{c.revertOf ? <div className="cma-type-sub">Revert</div> : null}</td>
                      <td data-th="Change">{c.kind === 'rate'
                        ? <>Web {usd(c.oldWeb)} → {usd(c.newWeb)}<div className="cma-type-sub">Standard {usd(c.oldStandard)} → {usd(c.newStandard)}</div></>
                        : <>{c.kind === 'promo_end' ? 'End ' : ''}{c.promo.name}<div className="cma-type-sub">{c.promoText}</div></>}</td>
                      <td data-th="Status"><span className={`status-badge ${cls}`}>{label}</span>{c.detail ? <div className="cma-why">{c.detail}</div> : null}</td>
                      <td data-th="Approved">{c.approvedBy ? <>{who(c.approvedBy)}<div className="cma-type-sub">{d.roleLabels[c.approverRole] || ''} {formatDateTime(c.approvedAt)}</div></> : dash}{c.note ? <div className="cma-why">{c.note}</div> : null}</td>
                      <td data-th="Done">{c.doneAt ? <>{c.doneBy ? who(c.doneBy) : dash}<div className="cma-type-sub">{formatDateTime(c.doneAt)}</div></> : dash}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {['approved', 'failed'].includes(c.status) && (
                          <button type="button" className="secondary-btn cma-btn" disabled={!!busy} onClick={() => act(() => api.markOpsCmaEntered(c.id), 'entered')}
                            aria-label={`Mark ${c.unitType || c.promo.name} Entered in Cubby`}><Check size={13} aria-hidden="true" /> Mark Entered</button>
                        )}
                        {c.kind === 'rate' && ['approved', 'failed'].includes(c.status) && pushReady && (
                          <button type="button" className="secondary-btn cma-btn" disabled={!!busy} onClick={() => act(() => api.retryOpsCmaChange(c.id), 'retry')} style={{ marginLeft: 6 }}>
                            <Send size={13} aria-hidden="true" /> {c.status === 'failed' ? 'Retry' : 'Push Now'}</button>
                        )}
                        {c.kind === 'rate' && ['pushed', 'entered'].includes(c.status) && !c.revertedAt && d.roles.ops_manager && (
                          <button type="button" className="secondary-btn cma-btn" disabled={!!busy} style={{ marginLeft: 6 }}
                            onClick={() => window.confirm(pushReady ? `Push the old rates for ${c.unitType} back to Cubby now?` : `Propose the old rates for ${c.unitType} again?`) && act(() => api.revertOpsCmaChange(c.id), 'revert')}
                            aria-label={`Revert ${c.unitType}`}><RotateCcw size={13} aria-hidden="true" /> Revert</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {modal === 'promo' && <PromoModal data={d} onClose={() => setModal('')} onSaved={() => { setModal(''); load(); onChanged?.(); }} />}
      {modal === 'preview' && <PreviewModal items={chosen} onClose={() => setModal('')} />}
    </>
  );
}
