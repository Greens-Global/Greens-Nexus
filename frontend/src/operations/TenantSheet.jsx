// Operations > Tenants - one tenant's record, a sheet from the right
// (Neil, 11/17/2026).
//
// Opening it asks GET /facility-ops/tenants/{customerId}, which re-reads the
// tenant and their gate codes LIVE from Cubby; when Cubby cannot be reached
// the server answers with the copy Nexus keeps and says so (`live.ok` false),
// and the first line here says it too, with Try Again. Gate codes are shown
// plainly - Nexus is internal only. Nothing is editable: Cubby stays the
// single source of truth, and tenant details are changed there.
//
// The ledger is not in that payload: it is the Reports drill-down's read
// (GET /ops-reports/tenant/ledger, per facility and customer - DrillPanel.jsx
// draws the same columns), asked for the lease the person picks.
//
// The look follows the 11/17/2026 rule: plain headings, hairlines between
// sections, a state as colored words in its own row - no boxes, no pills.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime, formatTime, toDateInputValue } from '../lib/datetime';
import { FS } from '../lib/typeScale';
import { Modal } from '../tasks/components';
import { money, tidy } from './model';
import './ops.css';

const usd = (c) => money(c, { exact: true });
const telHref = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
const muted = { color: 'var(--muted)', fontSize: FS.label };
const bad = { color: 'var(--bad-fg)', fontSize: FS.label };
const warn = { color: 'var(--warn-fg)', fontSize: FS.label };
const nums = { fontVariantNumeric: 'tabular-nums' };
// "RV" stays "RV"; Cubby's own codes ("BOAT_TRAILER") read as words.
const vehicleType = (t) => (/^[A-Z0-9]{1,3}$/.test(t || '') ? t : tidy(t));
const US = new Set(['', 'us', 'usa', 'united states', 'united states of america']);

const Phone = ({ value }) => (value ? <a className="ops-name" href={telHref(value)} style={nums}>{value}</a> : null);
const Email = ({ value }) => (value ? <a className="ops-name" href={`mailto:${value}`} style={{ overflowWrap: 'anywhere' }}>{value}</a> : null);

function Section({ title, right, children }) {
  return (
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <h4 style={{ margin: 0, fontSize: FS.body, fontWeight: 700, color: 'var(--ink)' }}>{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

// Label on the left, value on the right - a plain list, no boxes.
function Facts({ rows }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(88px, 150px) minmax(0, 1fr)', gap: '8px 16px', margin: 0, fontSize: FS.body }}>
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt style={{ color: 'var(--muted)' }}>{k}</dt>
          <dd style={{ margin: 0, color: 'var(--ink)', minWidth: 0 }}>{v || '-'}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Table({ cols, rows, label }) {
  return (
    <div className="req-table-wrapper">
      <table className="req-table stack-table" aria-label={label}>
        <thead><tr>{cols.map(([head, , num]) => <th key={head} className={num ? 'num' : undefined}>{head}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([head, get, num], c) => (
                <td key={head} data-th={c === 0 ? undefined : head} className={num ? 'num' : undefined}>{get(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const plain = (text, style) => <p style={{ margin: 0, fontSize: FS.body, color: 'var(--muted)', ...style }}>{text}</p>;

// "Texts are turned off (opted out)." - only when Cubby says they are.
function offSentence(what, pref) {
  if (!pref?.suppressed) return '';
  const why = tidy(pref.suppressionReason || '').toLowerCase();
  return `${what} are turned off${why ? ` (${why})` : ''}.`;
}

function addressLines(c) {
  const cityLine = [[c.city, c.state].filter(Boolean).join(', '), c.zip].filter(Boolean).join(' ');
  const country = US.has(String(c.country || '').trim().toLowerCase()) ? '' : c.country;
  return [c.address, c.address2, cityLine, country].filter(Boolean);
}

// Every lease's second contacts, each person once.
function secondContacts(leases) {
  const seen = new Set();
  const out = [];
  leases.forEach((l) => (l.altContacts || []).forEach((a) => {
    const key = [a.name, String(a.phone || '').replace(/\D/g, ''), a.email].map((v) => String(v || '').trim().toLowerCase()).join('|');
    if (key === '||' || seen.has(key)) return;
    seen.add(key);
    out.push(a);
  }));
  return out;
}

function UnitCell({ l, today }) {
  const v = l.vehicle;
  const vehicle = v && (v.type || v.plate)
    ? `${vehicleType(v.type) || 'Vehicle'}${v.plate ? ` - plate ${v.plate}` : ''}${v.state ? ` (${v.state})` : ''}` : '';
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600, ...nums }}>{l.unitName || '-'}</div>
      {l.moveOut
        ? <div style={muted}>Moved out {formatDate(l.moveOut)}</div>
        : l.scheduledMoveOut?.date && <div style={l.scheduledMoveOut.date < today ? bad : warn}>Moves out {formatDate(l.scheduledMoveOut.date)}</div>}
      {l.overlockNeeded && <div style={bad}>Overlock needed</div>}
      {vehicle && <div style={muted}>{vehicle}</div>}
    </div>
  );
}

function Insurance({ l, today }) {
  const c = l.coverage;
  const p = l.privatePolicy;
  if (!c && !p) return '-';
  return (
    <div style={{ minWidth: 0 }}>
      {c && <div>{[tidy(c.type) || 'Coverage', c.amountCents ? money(c.amountCents) : ''].filter(Boolean).join(' - ')}</div>}
      {c && c.premiumCents > 0 && <div style={muted}>{usd(c.premiumCents)} a month</div>}
      {p && <div>Own policy{p.number ? ` ${p.number}` : ''}</div>}
      {p?.expires && (p.expires < today
        ? <div style={bad}>Policy expired {formatDate(p.expires)}</div>
        : <div style={muted}>Expires {formatDate(p.expires)}</div>)}
    </div>
  );
}

const balance = (cents) => (cents > 0 ? <span style={{ color: 'var(--bad-fg)' }}>{usd(cents)}</span> : cents < 0 ? usd(cents) : '-');
const onOff = (v) => (v == null ? '-' : v ? 'On' : 'Off');
const leaseKey = (l) => `${l.facilityId}:${l.leaseId}`;

// The ledger of the lease picked. One read per facility (that is how Cubby's
// ledger comes back), kept while the sheet is open.
function Ledger({ customerId, leases }) {
  const first = leases.find((l) => !l.moveOut) || leases[0];
  const [picked, setPicked] = useState(first ? leaseKey(first) : '');
  const lease = leases.find((l) => leaseKey(l) === picked) || first;
  const fid = lease?.facilityId || '';
  const [ledgers, setLedgers] = useState({});
  const asked = useRef(new Set());
  const got = ledgers[fid];
  useEffect(() => {
    if (!fid || asked.current.has(fid)) return;
    asked.current.add(fid);
    api.opsTenantLedger(fid, customerId)
      .then((data) => setLedgers((s) => ({ ...s, [fid]: { status: 'ready', entries: data?.entries || [] } })))
      .catch((err) => {
        console.error('Operations: could not read the tenant ledger', err);
        setLedgers((s) => ({ ...s, [fid]: { status: 'error' } }));
      });
  }, [fid, customerId, got]);
  const retry = () => {
    asked.current.delete(fid);
    setLedgers((s) => { const next = { ...s }; delete next[fid]; return next; });
  };

  if (!lease) return plain('No lease to show a ledger for.');
  const here = leases.filter((l) => l.facilityId === fid);
  let entries = got?.status === 'ready' ? got.entries : [];
  // The read covers every lease at the facility; show the picked unit's lines
  // when Cubby named the unit on them.
  const mine = here.length > 1 && lease.unitName ? entries.filter((e) => e.unit === lease.unitName) : entries;
  const narrowed = mine.length > 0 && mine.length < entries.length;
  if (narrowed) entries = mine;
  const picker = leases.length > 1 && (
    <select className="form-select" aria-label="Lease for the ledger" value={leaseKey(lease)} onChange={(e) => setPicked(e.target.value)}
      style={{ width: 'auto', maxWidth: '100%', fontSize: FS.body }}>
      {leases.map((l) => (
        <option key={leaseKey(l)} value={leaseKey(l)}>
          {`Unit ${l.unitName || '-'} - ${l.facilityName || ''}${l.moveOut ? `, moved out ${formatDate(l.moveOut)}` : ''}`}
        </option>
      ))}
    </select>
  );
  return (
    <Section title="Ledger" right={picker}>
      {!got && <div role="status" aria-busy="true" aria-label="Reading the ledger from Cubby"><SkeletonBlocks count={3} height={30} borderRadius={8} /></div>}
      {got?.status === 'error' && (
        <p role="alert" style={{ margin: 0, fontSize: FS.body, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Couldn&apos;t load the ledger from Cubby.</span>
          <button type="button" className="secondary-btn" onClick={retry}>Try Again</button>
        </p>
      )}
      {got?.status === 'ready' && (entries.length === 0 ? plain('No ledger entries in Cubby.') : (
        <Table label="Ledger" rows={entries} cols={[
          ['Date', (e) => formatDate(e.date, '-')],
          ...(here.length > 1 && !narrowed ? [['Unit', (e) => e.unit || '-']] : []),
          ['Entry', (e) => e.type || '-'], ['Category', (e) => e.category || '-'],
          ['Description', (e) => [e.description, e.accrues && e.accrues.split(' - ').map((d) => formatDate(d)).join(' - '), e.waived && 'Waived'].filter(Boolean).join(' - ') || '-'],
          ['Amount', (e) => usd(e.amount), true], ['Paid', (e) => (e.paid == null ? '-' : usd(e.paid)), true]]} />
      ))}
    </Section>
  );
}

function Record({ data, onRetry, retrying }) {
  const today = toDateInputValue(new Date());
  const c = data.contact || {};
  const leases = data.leases || [];
  const address = addressLines(c);
  const sentences = [offSentence('Texts', data.commPrefs?.sms), offSentence('Emails', data.commPrefs?.email)].filter(Boolean);
  const seconds = secondContacts(leases);
  const gates = (data.facilities || []).filter((f) => f.gateCode);
  const payments = data.payments || [];
  const hasContact = !!(c.phone || c.email || address.length);
  return (
    <>
      {data.live?.ok ? (
        <p className="ops-note" style={{ margin: 0 }} data-testid="ops-tenant-live">
          Live from Cubby{data.live.asOf ? ` at ${formatTime(data.live.asOf)}` : ''}
        </p>
      ) : (
        <p className="ops-note" role="status" data-testid="ops-tenant-live"
          style={{ margin: 0, color: 'var(--warn-fg)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            Cubby could not be reached - showing {data.storedAsOf ? `the copy from ${formatDateTime(data.storedAsOf)}` : 'the last copy Nexus has'}.
          </span>
          <button type="button" className="secondary-btn" onClick={onRetry} disabled={retrying}>{retrying ? 'Trying...' : 'Try Again'}</button>
        </p>
      )}

      <Section title="Contact">
        {hasContact ? (
          <Facts rows={[
            ['Phone', c.phone ? <Phone value={c.phone} /> : null],
            ['Email', c.email ? <Email value={c.email} /> : null],
            ['Address', address.length ? address.map((line, i) => <div key={i}>{line}</div>) : null],
          ]} />
        ) : plain('Cubby returned no contact details for this tenant.')}
        {(data.military || sentences.length > 0) && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.body, color: 'var(--ink)' }}>
            {data.military && <div>Military</div>}
            {sentences.map((s) => <div key={s}>{s}</div>)}
          </div>
        )}
      </Section>

      {seconds.length > 0 && (
        <Section title="Second Contacts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: FS.body }}>
            {seconds.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: '2px 16px', flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{a.name || 'No Name'}</span>
                <Phone value={a.phone} />
                <Email value={a.email} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {gates.length > 0 && (
        <Section title="Gate Access">
          <Facts rows={gates.map((f) => [f.facilityName || f.facilityId, (
            <span key={f.facilityId} style={{ display: 'inline-flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span data-testid="ops-tenant-gate" style={{ fontWeight: 600, letterSpacing: '.04em', ...nums }}>{f.gateCode}</span>
              <span style={{ color: f.gateCodeEnabled ? 'var(--ok-fg)' : 'var(--bad-fg)' }}>{f.gateCodeEnabled ? 'Enabled' : 'Disabled'}</span>
            </span>
          )])} />
        </Section>
      )}

      <Section title="Units">
        {leases.length === 0 ? plain('No leases in Cubby for this tenant.') : (
          <Table label="Units" rows={leases} cols={[
            ['Unit', (l) => <UnitCell l={l} today={today} />],
            ['Facility', (l) => l.facilityName || '-'],
            ['Size', (l) => l.unitSize || '-'],
            ['Rent', (l) => usd(l.rentCents), true],
            ['Paid Through', (l) => <span style={nums}>{formatDate(l.paidThrough, '-')}</span>],
            ['Autopay', (l) => onOff(l.autopay)],
            ['Insurance', (l) => <Insurance l={l} today={today} />],
            ['Balance', (l) => balance(l.balanceCents), true],
          ]} />
        )}
      </Section>

      {leases.length > 0 && <Ledger customerId={data.customerId} leases={leases} />}

      <Section title="Payments">
        {payments.length === 0 ? plain('No payments in Cubby yet.') : (
          <Table label="Payments" rows={payments} cols={[
            ['Date', (p) => <span style={nums}>{formatDate(p.date, '-')}</span>],
            ['Amount', (p) => usd(p.amountCents), true],
            ['Status', (p) => tidy(p.status) || '-'],
            ['Method', (p) => tidy(p.method) || '-'],
          ]} />
        )}
      </Section>
    </>
  );
}

export default function TenantSheet({ customerId, onClose }) {
  const [loaded, setLoaded] = useState({ id: null, status: 'loading' });
  const [retrying, setRetrying] = useState(false);
  const [tries, setTries] = useState(0);
  const latest = useRef(0);
  const read = useCallback(() => {
    const mine = ++latest.current;
    return api.opsTenantRecord(customerId)
      .then((data) => { if (mine === latest.current) setLoaded({ id: customerId, status: 'ready', data }); })
      .catch((err) => {
        console.error('Operations: could not open the tenant', err);
        // A re-read that fails keeps the copy already on screen.
        if (mine === latest.current) {
          setLoaded((s) => (s.id === customerId && s.status === 'ready' ? s
            : { id: customerId, status: err?.status === 403 ? 'denied' : err?.status === 404 ? 'missing' : 'error' }));
        }
      });
  }, [customerId]);
  useEffect(() => { read(); }, [read, tries]);
  const state = loaded.id === customerId ? loaded : { status: 'loading' };
  const data = state.status === 'ready' ? state.data : null;
  const again = async () => {
    setRetrying(true);
    try { await read(); } finally { setRetrying(false); }
  };

  const title = data ? (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span>{data.name || 'Tenant'}</span>
      {data.companyName && <span style={{ fontSize: FS.label, fontWeight: 400, color: 'var(--muted)' }}>{data.companyName}</span>}
    </span>
  ) : 'Tenant';

  return (
    <Modal title={title} onClose={onClose} width="60vw"
      footer={(close) => (
        <>
          <span style={{ marginRight: 'auto', fontSize: FS.label, color: 'var(--muted)' }}>Tenant details are changed in Cubby.</span>
          {data?.cubbyUrl && (
            <a className="secondary-btn" href={data.cubbyUrl} target="_blank" rel="noopener noreferrer"
              style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Open in Cubby <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
          <button type="button" className="secondary-btn" onClick={() => close()}>Close</button>
        </>
      )}>
      {/* .ops-root carries the Operations colors and number alignment into the sheet, which is drawn outside the page. */}
      <div className="ops-root" data-testid="ops-tenant-sheet" style={{ flexShrink: 0 }}>
        {state.status === 'loading' && (
          <div role="status" aria-busy="true" aria-label="Reading the tenant from Cubby"><SkeletonBlocks count={5} height={52} borderRadius={8} /></div>
        )}
        {state.status === 'denied' && <p className="ops-note" role="alert" style={{ margin: 0 }}>You do not have access to tenant details.</p>}
        {state.status === 'missing' && <p className="ops-note" role="alert" style={{ margin: 0 }}>This tenant is not in a facility you can see.</p>}
        {state.status === 'error' && (
          <p className="ops-note" role="alert" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>Couldn&apos;t load this tenant.</span>
            <button type="button" className="secondary-btn" onClick={() => { setLoaded({ id: null, status: 'loading' }); setTries((n) => n + 1); }}>Try Again</button>
          </p>
        )}
        {data && <Record data={data} onRetry={again} retrying={retrying} />}
      </div>
    </Modal>
  );
}
