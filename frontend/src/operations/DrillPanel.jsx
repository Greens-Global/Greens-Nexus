// Operations > Reports drill-down: click a tenant and see their units,
// balance, payments and Cubby ledger; click a unit and see who has rented it.
// One panel, 60% of the screen (CLAUDE.md popup rule), full screen on a phone.
// A tenant's units open the unit, a unit's tenants open the tenant.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';
import { money } from './model';

const usd = (c) => money(c, { exact: true });

function Facts({ items }) {
  return (
    <dl className="ops-hit-facts" style={{ marginBottom: 14 }}>
      {items.filter(Boolean).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || '-'}</dd></div>)}
    </dl>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h4 className="ops-drill-h">{title}</h4>
      {children}
    </section>
  );
}

function Table({ cols, rows, empty }) {
  if (!rows.length) return <div className="ops-empty" style={{ padding: 10 }}>{empty}</div>;
  return (
    <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
      <table className="req-table">
        <thead><tr>{cols.map(([label, , num]) => <th key={label} className={num ? 'num' : ''}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([label, get, num]) => <td key={label} className={num ? 'num' : ''}>{get(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Tenant({ data, ledger, open }) {
  const unitBtn = (r) => <button type="button" className="ops-cell" onClick={() => open('unit', data.facilityId, r.unitId)}>{r.unit}</button>;
  return (
    <>
      <Facts items={[['Facility', data.facility], ['Units Now', String(data.units.length)], ['Balance Due', usd(data.balance.total)],
        ['Monthly Rent', usd(data.units.reduce((a, u) => a + u.rent, 0))]]} />
      <Section title="Units Rented Now">
        <Table empty="No unit rented now." rows={data.units} cols={[
          ['Unit', unitBtn], ['Type', (u) => u.type], ['Rent', (u) => usd(u.rent), true], ['Street Rate', (u) => usd(u.street), true],
          ['Moved In', (u) => formatDate(u.moveIn)], ['Paid Through', (u) => formatDate(u.paidThrough)],
          ['Autopay', (u) => (u.autoPay ? 'Yes' : 'No')], ['Overlocked', (u) => (u.overlocked ? 'Yes' : 'No')]]} />
      </Section>
      <Section title="What They Owe">
        <Table empty="Nothing past due." rows={data.balance.lines} cols={[
          ['Unit', unitBtn], ['Total', (r) => usd(r.total), true], ['0-30 Days', (r) => usd(r.range_0_30), true],
          ['31-60 Days', (r) => usd(r.range_30_60), true], ['61-90 Days', (r) => usd(r.range_60_90), true],
          ['91-120 Days', (r) => usd(r.range_90_120), true], ['120+ Days', (r) => usd(r.range_120_plus), true]]} />
      </Section>
      <Section title="Cubby Ledger">
        {ledger.status === 'loading' && <LoadingState size="section" label="Reading the ledger from Cubby" minHeight={80} />}
        {ledger.status === 'error' && <div className="ops-empty" role="alert">{ledger.error}</div>}
        {ledger.status === 'ready' && (
          <Table empty="No ledger entries in Cubby." rows={ledger.data.entries} cols={[
            ['Date', (e) => formatDate(e.date)], ['Unit', (e) => e.unit], ['Entry', (e) => e.type], ['Category', (e) => e.category],
            ['Description', (e) => [e.description, e.accrues && e.accrues.split(' - ').map((d) => formatDate(d)).join(' - '), e.waived && 'Waived'].filter(Boolean).join(' - ')],
            ['Amount', (e) => usd(e.amount), true], ['Paid', (e) => (e.paid == null ? '' : usd(e.paid)), true]]} />
        )}
      </Section>
      <Section title="Payments">
        <Table empty="No payments in Cubby yet (payments start 09/15/2026)." rows={data.payments} cols={[
          ['Date', (p) => formatDate(p.date)], ['Amount', (p) => usd(p.amount), true], ['Method', (p) => p.method],
          ['Status', (p) => p.status], ['Reason', (p) => p.reason]]} />
      </Section>
      <Section title="Rental History">
        <Table empty="No tenancies." rows={data.rentals} cols={[
          ['Unit', unitBtn], ['Moved In', (r) => formatDate(r.moveIn)], ['Moved Out', (r) => formatDate(r.moveOut) || 'Current'],
          ['Rent', (r) => usd(r.rent), true], ['Days', (r) => (r.stayDays ?? '').toLocaleString('en-US'), true]]} />
      </Section>
    </>
  );
}

function Unit({ data, open }) {
  const tenantBtn = (cid, name) => (cid ? <button type="button" className="ops-cell" onClick={() => open('tenant', data.facilityId, cid)}>{name}</button> : name);
  return (
    <>
      <Facts items={[['Facility', data.facility], ['Type', data.type], ['Size', data.size], ['Status', data.status],
        ['Street Rate', usd(data.street)], data.tenant && ['Rent', usd(data.rent)], data.tenant && ['Paid Through', formatDate(data.paidThrough)],
        data.tenant && ['Balance Due', usd(data.balance)], data.reason && ['Off Market', [data.reason, data.note].filter(Boolean).join(': ')],
        ['Overlocked', data.overlocked ? 'Yes' : 'No']]} />
      {data.tenant && <p style={{ fontSize: 13.5 }}>Rented by {tenantBtn(data.tenant.customerId, data.tenant.name)}</p>}
      <Section title="Rental History">
        <Table empty="Cubby has no tenancies for this unit." rows={data.history} cols={[
          ['Tenant', (r) => tenantBtn(r.customerId, r.tenant)], ['Moved In', (r) => formatDate(r.moveIn)],
          ['Moved Out', (r) => formatDate(r.moveOut) || 'Current'], ['Rent', (r) => usd(r.rent), true],
          ['Days', (r) => (r.stayDays ?? '').toLocaleString('en-US'), true]]} />
      </Section>
      {data.tasks.length > 0 && (
        <Section title="Open Tasks">
          <Table empty="" rows={data.tasks} cols={[['Task', (t) => t.title], ['Due', (t) => formatDate(t.dueDate)]]} />
        </Section>
      )}
    </>
  );
}

export default function DrillPanel({ target, onClose }) {
  // A stack, so Back returns from a unit to the tenant it was opened from.
  const [stack, setStack] = useState([target]);
  const top = stack[stack.length - 1];
  const key = top.join(':');
  const [loaded, setState] = useState({ status: 'loading', key: '' });
  // What was read belongs to one target; a new target reads as loading until its own data lands.
  const state = loaded.key === key ? loaded : { status: 'loading' };
  const [ledger, setLedger] = useState({ status: 'idle' });
  const panelRef = useRef(null);

  useEffect(() => {
    let live = true;
    setLedger({ status: 'idle' });
    const [kind, fid, id] = top;
    const k = top.join(':');
    const read = kind === 'tenant' ? api.opsTenant(fid, id) : api.opsUnit(fid, id);
    read.then((data) => { if (live) setState({ status: 'ready', data, key: k }); })
      .catch((err) => { if (live) setState({ status: 'error', error: err?.message || 'Could not load this.', key: k }); });
    if (kind === 'tenant') {
      setLedger({ status: 'loading' });
      api.opsTenantLedger(fid, id)
        .then((data) => { if (live) setLedger({ status: 'ready', data }); })
        .catch((err) => { if (live) setLedger({ status: 'error', error: err?.message || 'Cubby did not return the ledger.' }); });
    }
    return () => { live = false; };
  }, [top]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (kind, fid, id) => setStack((s) => [...s, [kind, fid, id]]);
  const data = state.data;
  const title = state.status !== 'ready' ? (top[0] === 'tenant' ? 'Tenant' : 'Unit')
    : top[0] === 'tenant' ? data.name : `Unit ${data.unit}`;

  return (
    <div className="ops-drill-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ops-drill dash-card" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <div className="ops-drill-head">
          {stack.length > 1 && (
            <button type="button" className="ops-x" aria-label="Back" onClick={() => setStack((s) => s.slice(0, -1))}><ArrowLeft size={18} /></button>
          )}
          <h3 style={{ margin: 0, fontSize: 18, flex: 1 }}>{title}</h3>
          {state.status === 'ready' && top[0] === 'tenant' && data.cubbyUrl && (
            <a className="ops-link" href={data.cubbyUrl} target="_blank" rel="noreferrer">Open in Cubby <ExternalLink size={12} aria-hidden="true" /></a>
          )}
          <button type="button" className="ops-x" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="ops-drill-body">
          {state.status === 'loading' && <LoadingState size="section" label="Reading from the synced Cubby data" minHeight={200} />}
          {state.status === 'error' && <ErrorBanner message={state.error} />}
          {state.status === 'ready' && (top[0] === 'tenant' ? <Tenant data={data} ledger={ledger} open={open} /> : <Unit data={data} open={open} />)}
        </div>
      </div>
    </div>
  );
}
