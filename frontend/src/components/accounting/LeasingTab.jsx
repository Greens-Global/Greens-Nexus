import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Mail, Pencil, Plus, Search, Trash2, UserPlus, X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { control } from './reportControls';
import { iso } from './reportModel';

// Accounting -> Leasing: leases and monthly recurring income (Neil and
// Charmi, Sep 25). Rent was tracked in a workbook and chased by hand; this is
// the same thing as an app.
//
//   Rent Roll    every lease, every month of the year: what was expected,
//                what came in, and what that makes of the month.
//   Outstanding  who is behind, by how much, and how to reach them.
//   Tenants      the leases themselves: the tenant (an Intacct customer), the
//                dates, the late-fee rule, and the rent as it changes.
//
// What was received is read from the ledger - whatever posted to the lease's
// rental income account for that customer in that month - so nobody keys a
// payment here. A tenant who moves out is ended, not overwritten: "New Tenant
// in This Space" ends the old lease and starts the next one.

const SECTIONS = [{ key: 'roll', label: 'Rent Roll' }, { key: 'outstanding', label: 'Outstanding' }, { key: 'tenants', label: 'Tenants' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = {
  paid: { label: 'Paid', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' },
  short: { label: 'Short', fg: '#92400e', bg: 'rgba(180,83,9,0.13)' },
  unpaid: { label: 'Unpaid', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
  late: { label: 'Late', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
  due: { label: 'Due', fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  upcoming: { label: 'Upcoming', fg: 'var(--text-muted)', bg: 'transparent' },
  unknown: { label: 'Not read', fg: 'var(--text-muted)', bg: 'var(--bg-secondary)' },
  none: { label: 'Nothing due', fg: 'var(--text-muted)', bg: 'transparent' },
};
const LEASE_STATUS = { active: 'Active', ended: 'Ended', vacant: 'Vacant' };

const money = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const whole = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const blank = () => ({ propertyName: '', region: '', tenancy: 'external', landlord: '', entityCode: '', incomeAccounts: ['41101'], customerId: '', tenantName: '', contactName: '', phone: '', email: '', mailingAddress: '', leaseStart: iso(new Date()), leaseEnd: '', securityDeposit: 0, leaseTerms: '', lateFee: 0, dueDay: 1, graceDays: 5, status: 'active', notes: '', rates: [{ startDate: iso(new Date()), rent: 0, cam: 0, other: 0, note: '' }] });

export default function LeasingTab({ canEdit = false, canDelete = false }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [roll, setRoll] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState('roll');
  const [q, setQ] = useState('');
  const [show, setShow] = useState('current');       // current | behind | all
  const [editing, setEditing] = useState(null);       // { lease, replacing? }
  const [cell, setCell] = useState(null);             // { row, month }
  const seq = useRef(0);

  const load = useCallback((y) => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    return api.getLeasingRentRoll(y)
      .then((d) => { if (mine === seq.current) setRoll(d); })
      .catch((e) => { if (mine === seq.current) { setRoll((r) => r || { rows: [], totals: [], summary: {} }); setError(e?.message || 'Could not load the rent roll.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, []);
  useEffect(() => { load(year); }, [year, load]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (roll?.rows || []).filter((r) => {
      const l = r.lease;
      if (show === 'current' && l.status === 'ended') return false;
      if (show === 'behind' && !r.monthsBehind) return false;
      return !s || [l.propertyName, l.tenantName, l.landlord, l.region, l.customerId].some((v) => (v || '').toLowerCase().includes(s));
    });
  }, [roll, q, show]);
  const sum = roll?.summary || {};
  const thisMonth = iso(new Date()).slice(0, 7);

  return (
    <AsyncSection loading={roll === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
            {SECTIONS.map((s) => (
              <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
                style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                {s.label}{s.key === 'outstanding' && sum.behind ? ` (${sum.behind})` : ''}
              </button>
            ))}
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button type="button" style={icon} aria-label="Previous year" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
            <button type="button" style={icon} aria-label="Next year" disabled={year >= new Date().getFullYear() + 1} onClick={() => setYear((y) => y + 1)}><ChevronRight size={16} /></button>
          </div>
          <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a property or a tenant" aria-label="Search a property or a tenant" style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Which leases" style={control}>
            <option value="current">Current Leases</option>
            <option value="behind">Behind on Rent</option>
            <option value="all">All, Including Ended</option>
          </select>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
            <span>Expected <strong>{money(sum.expectedToDate)}</strong></span>
            <span>Received <strong>{money(sum.receivedToDate)}</strong></span>
            <span>Owed <strong style={{ color: sum.owed ? 'var(--bad-fg, #dc2626)' : undefined }}>{money(sum.owed)}</strong></span>
            {canEdit && (
              <button type="button" className="primary-btn" onClick={() => setEditing({ lease: blank() })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
                <Plus size={14} /> New Lease
              </button>
            )}
          </div>
        </div>

        {error && <div style={bad}>{error}</div>}
        {roll?.warning && (
          <div style={{ ...card, padding: '8px 12px', borderColor: '#b45309', display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.82rem', color: '#92400e' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{roll.warning}
          </div>
        )}

        <div style={{ opacity: loading ? 0.6 : 1 }}>
          {section === 'roll' && <RentRoll rows={rows} totals={roll?.totals || []} year={year} thisMonth={thisMonth} onCell={(row, month) => setCell({ row, month })} onLease={(l) => setEditing({ lease: l })} any={(roll?.rows || []).length > 0} canEdit={canEdit} />}
          {section === 'outstanding' && <Outstanding rows={rows.filter((r) => r.monthsBehind)} year={year} />}
          {section === 'tenants' && <Tenants rows={rows} canEdit={canEdit} onEdit={(l) => setEditing({ lease: l })} onReplace={(l) => setEditing({ lease: { ...blank(), propertyName: l.propertyName, region: l.region, tenancy: l.tenancy, landlord: l.landlord, entityCode: l.entityCode, incomeAccounts: l.incomeAccounts, lateFee: l.lateFee, dueDay: l.dueDay, graceDays: l.graceDays }, replacing: l })} />}
        </div>
      </div>
      {cell && <MonthDetail cell={cell} canEdit={canEdit} onClose={() => setCell(null)} onSaved={() => { setCell(null); load(year); }} />}
      {editing && <LeaseEditor lease={editing.lease} replacing={editing.replacing} canDelete={canDelete} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(year); }} />}
    </AsyncSection>
  );
}

function RentRoll({ rows, totals, year, thisMonth, onCell, onLease, any, canEdit }) {
  if (!rows.length) {
    return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{any ? 'No lease matches.' : `No leases yet.${canEdit ? ' Start with New Lease: the tenant, the dates and the rent.' : ''}`}</div>;
  }
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap" style={{ maxHeight: '74vh' }}>
        <table className="acct-lines acct-roll" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th scope="col" style={{ position: 'sticky', left: 0, zIndex: 5, minWidth: 250 }}>Property and Tenant</th>
              <th scope="col" className="acct-num">Rent</th>
              {MONTHS.map((m, i) => <th key={m} scope="col" className="acct-num" style={`${year}-${String(i + 1).padStart(2, '0')}` === thisMonth ? { color: 'var(--wk-brand, #2b45e1)' } : undefined}>{m}</th>)}
              <th scope="col" className="acct-num">Owed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const l = r.lease;
              const rate = [...l.rates].reverse().find((x) => x.startDate <= `${thisMonth}-31`) || l.rates[0];
              return (
                <tr key={l.id}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, whiteSpace: 'normal', minWidth: 250 }}>
                    <button type="button" className="acct-drill" onClick={() => onLease(l)} style={{ fontWeight: 600, textAlign: 'left' }}>{l.propertyName}</button>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{l.status === 'vacant' ? 'Vacant' : l.tenantName}{l.status === 'ended' ? ` · ended ${l.leaseEnd ? formatDate(l.leaseEnd) : ''}` : ''}</div>
                  </td>
                  <td className="acct-num">{rate ? whole(rate.rent + rate.cam + rate.other) : '-'}</td>
                  {r.months.map((c) => {
                    if (!c.inForce) return <td key={c.month} className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>;
                    const s = STATUS[c.status] || STATUS.none;
                    return (
                      <td key={c.month} className="acct-num" style={{ padding: 2 }}>
                        <button type="button" onClick={() => onCell(r, c)} aria-label={`${l.propertyName}, ${monthName(c.month)}: ${s.label}, received ${money(c.received)} of ${money(c.expected)}`}
                          title={`${s.label} - received ${money(c.received)} of ${money(c.expected)}${c.note ? ` - ${c.note}` : ''}`}
                          style={{ width: '100%', border: 'none', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontVariantNumeric: 'tabular-nums', padding: '3px 6px', textAlign: 'right', background: s.bg, color: s.fg, fontWeight: ['short', 'unpaid', 'late'].includes(c.status) ? 700 : 400 }}>
                          {c.status === 'upcoming' || c.status === 'due' || c.status === 'unknown' ? whole(c.expected) : whole(c.received)}{c.note ? '*' : ''}
                        </button>
                      </td>
                    );
                  })}
                  <td className="acct-num" style={{ fontWeight: 700, color: r.owed ? 'var(--bad-fg, #dc2626)' : 'var(--text-muted)' }}>{r.owed ? money(r.owed) : '-'}</td>
                </tr>
              );
            })}
            <tr className="acct-grand">
              <td style={{ position: 'sticky', left: 0 }}>Received - all leases</td><td />
              {totals.map((t) => <td key={t.month} className="acct-num" title={`Expected ${money(t.expected)}`}>{t.expected || t.received ? whole(t.received) : '-'}</td>)}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
        {['paid', 'short', 'unpaid', 'due', 'upcoming'].map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: STATUS[k].bg, border: `1px solid ${STATUS[k].fg}` }} />{k === 'unpaid' ? 'Unpaid or late' : STATUS[k].label}
          </span>
        ))}
        <span>A paid month shows what came in; a month not yet paid shows what is expected. * has a note. Click a month for the detail.</span>
      </div>
    </div>
  );
}

function reminder(row, year) {
  const l = row.lease;
  const behind = row.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status));
  const lines = behind.map((c) => `  ${monthName(c.month)}: ${money(c.balance)} of ${money(c.expected)}`).join('\n');
  const body = `Hello ${l.contactName || l.tenantName},\n\nOur records for ${l.propertyName} show rent outstanding for ${year}:\n\n${lines}\n\nTotal outstanding: ${money(row.owed)}${row.lateFees ? `\nLate fees under the lease: ${money(row.lateFees)}` : ''}\n\nIf you have already paid, please reply with the date and amount so we can match it.\n\nThank you.`;
  return `mailto:${encodeURIComponent(l.email)}?subject=${encodeURIComponent(`Rent outstanding - ${l.propertyName}`)}&body=${encodeURIComponent(body)}`;
}

function Outstanding({ rows, year }) {
  if (!rows.length) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>Nobody is behind on rent for {year}.</div>;
  const sorted = [...rows].sort((a, b) => b.owed - a.owed);
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap">
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr><th scope="col">Property</th><th scope="col">Tenant</th><th scope="col">Months Behind</th><th scope="col" className="acct-num">Owed</th><th scope="col" className="acct-num">Late Fees</th><th scope="col">Contact</th><th scope="col" aria-label="Write" /></tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const l = r.lease;
              const months = r.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status)).map((c) => MONTHS[Number(c.month.slice(5, 7)) - 1]);
              return (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600 }}>{l.propertyName}</td>
                  <td>{l.tenantName}</td>
                  <td style={{ whiteSpace: 'normal' }}>{r.monthsBehind} - {months.join(', ')}</td>
                  <td className="acct-num" style={{ fontWeight: 700, color: 'var(--bad-fg, #dc2626)' }}>{money(r.owed)}</td>
                  <td className="acct-num">{r.lateFees ? money(r.lateFees) : '-'}</td>
                  <td style={{ whiteSpace: 'normal' }}>{[l.contactName, l.phone].filter(Boolean).join(' · ') || '-'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {l.email
                      ? <a className="secondary-btn" href={reminder(r, year)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px', textDecoration: 'none' }}><Mail size={13} /> Write to Tenant</a>
                      : <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>No email on file</span>}
                  </td>
                </tr>
              );
            })}
            <tr className="acct-grand"><td colSpan={3}>Total Outstanding - {sorted.length} {sorted.length === 1 ? 'tenant' : 'tenants'}</td><td className="acct-num">{money(sorted.reduce((s, r) => s + r.owed, 0))}</td><td className="acct-num">{money(sorted.reduce((s, r) => s + r.lateFees, 0))}</td><td colSpan={2} /></tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>Write to Tenant opens your own email with the months and amounts filled in. Nothing is sent until you press send.</div>
    </div>
  );
}

function Tenants({ rows, canEdit, onEdit, onReplace }) {
  if (!rows.length) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>No lease matches.</div>;
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap">
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr><th scope="col">Property</th><th scope="col">Tenant</th><th scope="col">Landlord</th><th scope="col">Lease</th><th scope="col" className="acct-num">Rent</th><th scope="col" className="acct-num">CAM</th><th scope="col" className="acct-num">Deposit</th><th scope="col">Status</th><th scope="col" aria-label="Change" /></tr>
          </thead>
          <tbody>
            {rows.map(({ lease: l }) => {
              const rate = l.rates[l.rates.length - 1];
              return (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'normal' }}>{l.propertyName}{l.region ? <div style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{l.region}</div> : null}</td>
                  <td style={{ whiteSpace: 'normal' }}>{l.tenantName || '-'}{l.customerId ? <span className="acct-code" style={{ marginLeft: 8 }}>{l.customerId}</span> : null}</td>
                  <td style={{ whiteSpace: 'normal' }}>{l.landlord || '-'}</td>
                  <td>{l.leaseStart ? formatDate(l.leaseStart) : '-'} to {l.leaseEnd ? formatDate(l.leaseEnd) : 'month to month'}</td>
                  <td className="acct-num">{rate ? money(rate.rent) : '-'}</td>
                  <td className="acct-num">{rate?.cam ? money(rate.cam) : '-'}</td>
                  <td className="acct-num">{l.securityDeposit ? money(l.securityDeposit) : '-'}</td>
                  <td>{LEASE_STATUS[l.status] || l.status}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button type="button" style={icon} aria-label={`Change ${l.propertyName}`} title="Change this lease" onClick={() => onEdit(l)}><Pencil size={14} /></button>
                        {l.status !== 'ended' && <button type="button" style={icon} aria-label={`New tenant at ${l.propertyName}`} title="New tenant in this space" onClick={() => onReplace(l)}><UserPlus size={14} /></button>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// One month of one lease: the figures, and the deduction and note only a
// person can know (the tenant fixed the AC and took it off the rent).
function MonthDetail({ cell, canEdit, onClose, onSaved }) {
  const { row, month } = cell;
  const [adjustment, setAdjustment] = useState(month.adjustment || 0);
  const [note, setNote] = useState(month.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = STATUS[month.status] || STATUS.none;
  const dirty = Number(adjustment || 0) !== Number(month.adjustment || 0) || note !== (month.note || '');
  const save = () => {
    setBusy(true);
    setError('');
    api.setLeasingMonth(row.lease.id, month.month, { adjustment: Number(adjustment) || 0, note }).then(onSaved).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const fact = (k, v, strong) => (<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.86rem', padding: '3px 0' }}><span style={{ color: 'var(--text-secondary)' }}>{k}</span><span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 700 : 400 }}>{v}</span></div>);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`${row.lease.propertyName}, ${monthName(month.month)}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>{monthName(month.month)}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{row.lease.propertyName} · {row.lease.tenantName || 'Vacant'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 10 }}>
          <span style={{ justifySelf: 'start', padding: '2px 10px', borderRadius: 999, fontSize: '0.76rem', fontWeight: 700, color: s.fg, background: s.bg, border: `1px solid ${s.fg}` }}>{s.label}</span>
          <div>
            {fact('Expected', money(month.expected))}
            {month.adjustment ? fact('Includes a deduction of', money(month.adjustment)) : null}
            {fact('Received', month.status === 'unknown' ? 'Not read' : money(month.received))}
            {fact('Balance', month.status === 'unknown' ? '-' : money(month.balance), true)}
            {month.lateFee ? fact('Late fee under the lease', money(month.lateFee)) : null}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Received is what posted to account {row.lease.incomeAccounts.join(', ')} for customer {row.lease.customerId || '(none set)'} in this month.</div>
          {canEdit && (
            <>
              <div>
                <label style={label} htmlFor="lease-m-adj">Agreed Deduction</label>
                <input id="lease-m-adj" type="number" min="0" step="0.01" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} style={{ ...control, width: 160 }} />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Taken off what is expected this month, such as a repair the tenant paid for.</div>
              </div>
              <div>
                <label style={label} htmlFor="lease-m-note">Note</label>
                <input id="lease-m-note" type="text" value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} style={{ ...control, width: '100%' }} />
              </div>
            </>
          )}
          {!canEdit && month.note && <div style={{ fontSize: '0.84rem' }}>{month.note}</div>}
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
          {canEdit && <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving...' : 'Save'}</button>}
        </div>
      </div>
    </div>
  );
}

function LeaseEditor({ lease, replacing, canDelete, onClose, onSaved }) {
  const [l, setL] = useState(() => ({ ...lease, rates: (lease.rates || []).map((r) => ({ ...r })) }));
  const [movedOut, setMovedOut] = useState(() => { const d = new Date(`${lease.leaseStart || iso(new Date())}T00:00:00`); d.setDate(d.getDate() - 1); return iso(d); });
  const [customers, setCustomers] = useState(null);
  const [entities, setEntities] = useState([]);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (p) => setL((x) => ({ ...x, ...p }));
  useEffect(() => {
    api.getLeasingCustomers().then((d) => setCustomers(d?.customers || [])).catch(() => setCustomers([]));
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const matches = useMemo(() => {
    const s = find.trim().toLowerCase();
    if (!s) return [];
    return (customers || []).filter((c) => c.code.toLowerCase().includes(s) || (c.name || '').toLowerCase().includes(s)).slice(0, 8);
  }, [customers, find]);
  const vacant = l.status === 'vacant';
  const ready = l.propertyName.trim() && (vacant || l.tenantName.trim()) && l.rates.every((r) => r.startDate);
  const body = () => ({ ...l, securityDeposit: Number(l.securityDeposit) || 0, lateFee: Number(l.lateFee) || 0, dueDay: Number(l.dueDay) || 1, graceDays: Number(l.graceDays) || 0,
    incomeAccounts: String(l.incomeAccounts).split(',').map((x) => x.trim()).filter(Boolean),
    rates: l.rates.map((r) => ({ startDate: r.startDate, rent: Number(r.rent) || 0, cam: Number(r.cam) || 0, other: Number(r.other) || 0, note: r.note || '' })) });
  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const work = replacing ? api.replaceLeasingTenant(replacing.id, { ...body(), movedOut }) : l.id ? api.updateLeasingLease(l.id, body()) : api.createLeasingLease(body());
    work.then(onSaved).catch((e) => { setError(e?.message || 'Could not save the lease.'); setBusy(false); });
  };
  const field = (key, text, props = {}) => (
    <div>
      <label style={label} htmlFor={`lease-${key}`}>{text}</label>
      <input id={`lease-${key}`} type="text" value={l[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} style={{ ...control, width: '100%' }} {...props} />
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={replacing ? 'New tenant in this space' : l.id ? 'Change lease' : 'New lease'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{replacing ? 'New Tenant in This Space' : l.id ? 'Change Lease' : 'New Lease'}</h3>
            {replacing && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{replacing.tenantName}'s lease is ended and kept. This starts the next one.</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 14, maxHeight: '72vh', overflowY: 'auto' }}>
          {replacing && (
            <div style={{ maxWidth: 240 }}>
              <label style={label} htmlFor="lease-moved">Last Day of {replacing.tenantName}</label>
              <input id="lease-moved" type="date" value={movedOut} onChange={(e) => setMovedOut(e.target.value)} style={{ ...control, width: '100%' }} />
            </div>
          )}
          <div style={grid}>
            {field('propertyName', 'Property or Space', { maxLength: 200, autoFocus: true, placeholder: '910 SECR - Ste 100, San Clemente' })}
            {field('region', 'Region', { maxLength: 120, placeholder: 'Orange County' })}
            {field('landlord', 'Landlord (the tenant pays)', { maxLength: 200 })}
            <div>
              <label style={label} htmlFor="lease-tenancy">Tenant Is</label>
              <select id="lease-tenancy" value={l.tenancy} onChange={(e) => set({ tenancy: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="external">External</option><option value="internal">Internal - a related company</option>
              </select>
            </div>
            <div>
              <label style={label} htmlFor="lease-status">Status</label>
              <select id="lease-status" value={l.status} onChange={(e) => set({ status: e.target.value })} style={{ ...control, width: '100%' }}>
                {Object.entries(LEASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          {!vacant && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ position: 'relative' }}>
                <label style={label} htmlFor="lease-find">Tenant - find the Intacct customer</label>
                <input id="lease-find" type="text" value={find} onChange={(e) => setFind(e.target.value)} placeholder={customers ? 'Type a name or a customer code' : 'Loading customers...'} style={{ ...control, width: '100%' }} />
                {matches.length > 0 && (
                  <div role="listbox" aria-label="Customers" style={{ border: '1px solid var(--border-color)', borderRadius: 8, marginTop: 4, padding: 4, display: 'grid', gap: 1 }}>
                    {matches.map((c) => (
                      <button key={c.code} type="button" role="option" aria-selected={c.code === l.customerId} onClick={() => { set({ customerId: c.code, tenantName: c.name || l.tenantName }); setFind(''); }}
                        style={{ display: 'flex', gap: 8, border: 'none', background: 'none', borderRadius: 6, padding: '4px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}>
                        <span style={{ flex: 1 }}>{c.name || c.code}</span><span style={{ color: 'var(--text-muted)' }}>{c.code}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div style={grid}>
                {field('tenantName', 'Tenant Name', { maxLength: 200 })}
                {field('customerId', 'Intacct Customer Code', { maxLength: 60 })}
                {field('contactName', 'Primary Contact', { maxLength: 200 })}
                {field('phone', 'Phone', { maxLength: 60 })}
                {field('email', 'Email', { maxLength: 200, type: 'email' })}
                {field('mailingAddress', 'Mailing Address', { maxLength: 300 })}
              </div>
            </div>
          )}

          <div style={grid}>
            {field('leaseStart', 'Lease Start', { type: 'date' })}
            <div>
              <label style={label} htmlFor="lease-leaseEnd">Lease End</label>
              <input id="lease-leaseEnd" type="date" value={l.leaseEnd || ''} onChange={(e) => set({ leaseEnd: e.target.value })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Leave empty for month to month.</div>
            </div>
            {field('leaseTerms', 'Lease Terms', { maxLength: 200, placeholder: 'Annual, month to month...' })}
            {field('securityDeposit', 'Security Deposit', { type: 'number', min: 0, step: '0.01' })}
            {field('lateFee', 'Late Fee', { type: 'number', min: 0, step: '0.01' })}
            {field('dueDay', 'Rent Due on Day', { type: 'number', min: 1, max: 28 })}
            {field('graceDays', 'Late After (days past due)', { type: 'number', min: 0, max: 60 })}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={label}>Rent - each change is a new line, in force until the next one</span>
              <button type="button" className="secondary-btn" onClick={() => set({ rates: [...l.rates, { startDate: '', rent: l.rates[l.rates.length - 1]?.rent || 0, cam: l.rates[l.rates.length - 1]?.cam || 0, other: 0, note: '' }] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px' }}><Plus size={12} /> Add Rent Change</button>
            </div>
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              {l.rates.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '150px repeat(3, minmax(90px, 1fr)) minmax(120px, 2fr) 30px', gap: 6, alignItems: 'center' }}>
                  <input type="date" value={r.startDate} aria-label={`Rent ${i + 1} starts`} onChange={(e) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, startDate: e.target.value } : x)) })} style={control} />
                  {[['rent', 'Rent'], ['cam', 'CAM'], ['other', 'Other']].map(([k, text]) => (
                    <input key={k} type="number" min="0" step="0.01" value={r[k]} placeholder={text} aria-label={`${text} of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, n) => (n === i ? { ...x, [k]: e.target.value } : x)) })} style={control} />
                  ))}
                  <input type="text" value={r.note || ''} maxLength={200} placeholder="Note, such as Renewal" aria-label={`Note of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)) })} style={control} />
                  <button type="button" style={icon} aria-label={`Remove rent ${i + 1}`} onClick={() => set({ rates: l.rates.filter((_, k) => k !== i) })}><Trash2 size={14} /></button>
                </div>
              ))}
              {!l.rates.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No rent yet. Without one, nothing is expected from this lease.</div>}
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Starts On, Rent, CAM (common area maintenance), Other, Note.</div>
            </div>
          </div>

          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-entity">Entity the Income Posts To</label>
              <select id="lease-entity" value={l.entityCode} onChange={(e) => set({ entityCode: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="">Not set</option>
                {entities.map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
                {l.entityCode && !entities.some((e) => e.code === l.entityCode) && <option value={l.entityCode}>{l.entityCode}</option>}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="lease-accounts">Rental Income Accounts</label>
              <input id="lease-accounts" type="text" value={Array.isArray(l.incomeAccounts) ? l.incomeAccounts.join(', ') : l.incomeAccounts} onChange={(e) => set({ incomeAccounts: e.target.value })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>GL codes, separated by commas. What posts here for the tenant counts as rent received.</div>
            </div>
          </div>
          {field('notes', 'Notes', { maxLength: 1000 })}
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <span>
            {canDelete && l.id && !replacing && (confirm ? (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: '0.8rem' }}>
                Entered by mistake?
                <button type="button" className="secondary-btn" style={{ color: 'var(--bad-fg, #dc2626)' }} onClick={() => api.deleteLeasingLease(l.id).then(onSaved).catch((e) => setError(e?.message || 'Could not delete.'))}>Delete Lease</button>
                <button type="button" className="secondary-btn" onClick={() => setConfirm(false)}>Keep</button>
              </span>
            ) : <button type="button" style={{ ...icon, fontSize: '0.78rem', gap: 5, alignItems: 'center' }} onClick={() => setConfirm(true)}><Trash2 size={13} /> Delete</button>)}
          </span>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="primary-btn" onClick={save} disabled={!ready || busy}>{busy ? 'Saving...' : 'Save'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
