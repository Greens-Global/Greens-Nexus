// Operations > Tenants - the tenant directory (Neil, 11/17/2026).
//
// Nexus keeps a READ-ONLY copy of tenant contact details: Cubby stays the
// single source of truth, the copy is refreshed by the 15-minute sync, and
// nothing here edits a tenant. One search box finds a tenant by name, unit,
// phone, email, plate or gate code (GET /facility-ops/tenants - the server
// does the matching, 50 rows a page); a row opens the tenant's record
// (TenantSheet), which re-reads that tenant live from Cubby.
//
// Who sees this is the access rules (Settings > Operations > Tenants And
// Facility Access): FacilityOperations shows the tab only when
// /facility-ops/access/me says Tenant Details, and the server answers 403 to
// anyone else - said here as a plain line, never as an empty list.
//
// The look follows the 11/17/2026 rule: no card around the list, no pills -
// a search box, three plain choices, one quiet line and a table.
import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime, formatTime } from '../lib/datetime';
import { FS } from '../lib/typeScale';
import { useIsMobile } from '../lib/useIsMobile';
import { count, money } from './model';
import { isThirdParty } from './thirdParty';
import TenantSheet from './TenantSheet';

const PAGE = 50;
const WAIT_MS = 250;
const WHICH = [['current', 'Current'], ['former', 'Former'], ['all', 'All']];

// "at 2:15 PM" today, "on 11/16/2026, 2:15 PM" any other day.
function atWords(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === now.toDateString() ? `at ${formatTime(d)}` : `on ${formatDateTime(d)}`;
}

const telHref = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;
const stop = (e) => e.stopPropagation();
const muted = { color: 'var(--muted)', fontSize: FS.label };

// `facility` is the page's Facility choice (null = every facility the person
// may see); `within` is the page's State choice as facility ids (null = no
// State picked); `many` says more than one facility is in view, so each row
// names its own.
export default function Tenants({ facility = null, within = null, many = false }) {
  const isMobile = useIsMobile();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [which, setWhich] = useState('current');
  const [openId, setOpenId] = useState('');
  const [tries, setTries] = useState(0);
  const facilityId = facility?.id || '';
  const withinIds = !facilityId && within?.length ? within.join(',') : '';
  const outside = !!facility && isThirdParty(facility);

  // Wait for a pause in typing before asking.
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), WAIT_MS);
    return () => clearTimeout(t);
  }, [q]);

  // The page belongs to one search: a new word, choice or facility starts at the top.
  const filterKey = `${term}|${which}|${facilityId}|${withinIds}`;
  const [pageAt, setPageAt] = useState({ key: filterKey, page: 0 });
  const page = pageAt.key === filterKey ? pageAt.page : 0;
  const setPage = (p) => setPageAt({ key: filterKey, page: p });
  const offset = page * PAGE;
  const key = `${filterKey}|${offset}`;

  const [loaded, setLoaded] = useState({ key: null, status: 'loading' });
  // An answer a newer question has overtaken is dropped, never drawn.
  const latest = useRef(0);
  useEffect(() => {
    if (outside) return;
    const mine = ++latest.current;
    api.opsTenants({ q: term, facility: facilityId, facilities: withinIds, status: which, limit: PAGE, offset })
      .then((data) => { if (mine === latest.current) setLoaded({ key, status: 'ready', data: data || {} }); })
      .catch((err) => {
        console.error('Operations: could not load the tenants', err);
        if (mine === latest.current) setLoaded({ key, status: err?.status === 403 ? 'denied' : 'error' });
      });
  }, [key, term, facilityId, withinIds, which, offset, outside, tries]);

  // What is on screen while the next answer is on its way: the rows already
  // there (dimmed), or the skeleton when there are none to keep.
  const waiting = loaded.key !== key;
  const status = !waiting ? loaded.status : loaded.status === 'ready' ? 'ready' : 'loading';
  const rows = status === 'ready' ? (loaded.data.rows || []) : [];
  const total = status === 'ready' ? (Number(loaded.data.total) || 0) : 0;
  const shownFrom = waiting ? null : offset;
  const retry = () => { setLoaded({ key: null, status: 'loading' }); setTries((n) => n + 1); };

  if (outside) {
    return (
      <p className="ops-note" style={{ margin: 0 }}>
        Tenant details come from Cubby. {facility.shortName || facility.name || 'This store'} is run by another operator, so its tenants are not here.
      </p>
    );
  }

  return (
    <div data-testid="ops-tenants" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px 18px', flexWrap: 'wrap' }}>
        <label className="ops-search" style={{ flex: '1 1 320px', maxWidth: 480, marginBottom: 0 }}>
          <Search size={15} aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!isMobile}
            placeholder="Search name, unit, phone, email, plate or gate code" aria-label="Search tenants by name, unit, phone, email, plate or gate code" />
          {q && <button type="button" className="ops-x" onClick={() => setQ('')} aria-label="Clear search"><X size={14} aria-hidden="true" /></button>}
        </label>
        <div className="scroll-tabs" role="group" aria-label="Which tenants" style={{ display: 'flex', gap: 2 }}>
          {WHICH.map(([value, label]) => {
            const on = which === value;
            return (
              <button key={value} type="button" aria-pressed={on} onClick={() => setWhich(value)}
                style={{ padding: '7px 12px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: FS.body,
                  fontWeight: on ? 700 : 500, color: on ? 'var(--ink)' : 'var(--muted)', whiteSpace: 'nowrap',
                  borderBottom: `2px solid ${on ? 'var(--ink)' : 'transparent'}` }}>{label}</button>
            );
          })}
        </div>
      </div>

      {status === 'loading' && (
        <div role="status" aria-busy="true" aria-label="Loading tenants"><SkeletonBlocks count={8} height={38} borderRadius={8} /></div>
      )}

      {status === 'denied' && <p className="ops-note" role="alert" style={{ margin: 0 }}>You do not have access to tenant details.</p>}

      {status === 'error' && (
        <p className="ops-note" role="alert" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>Couldn&apos;t load the tenants.</span>
          <button type="button" className="secondary-btn" onClick={retry}>Try Again</button>
        </p>
      )}

      {status === 'ready' && (
        <>
          <p className="ops-note" style={{ margin: 0 }} data-testid="ops-tenants-synced">
            {loaded.data.syncedAt ? `Read from Cubby ${atWords(loaded.data.syncedAt)}` : 'Not read from Cubby yet - the next sync fills this in.'}
          </p>
          {rows.length === 0 ? (
            <p className="ops-note" style={{ margin: 0 }} aria-live="polite">No tenants match.</p>
          ) : (
            <div className="req-table-wrapper" aria-busy={waiting || undefined} style={waiting ? { opacity: 0.55 } : undefined}>
              <table className="req-table stack-table">
                <thead>
                  <tr><th>Tenant</th><th>Units</th><th>Phone</th><th>Email</th><th className="num">Balance</th><th>Paid Through</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.facilityId}:${r.customerId}`} onClick={() => setOpenId(r.customerId)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ minWidth: 0 }}>
                          <button type="button" className="ops-cell" style={{ textAlign: 'left' }}
                            onClick={(e) => { e.stopPropagation(); setOpenId(r.customerId); }}>{r.name || 'No Name'}</button>
                          {r.companyName && <div style={muted}>{r.companyName}</div>}
                          {which === 'all' && !r.current && <div style={muted}>Former tenant</div>}
                        </div>
                      </td>
                      <td data-th="Units">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontVariantNumeric: 'tabular-nums' }}>{(r.units || []).join(', ') || '-'}</div>
                          {many && r.facilityName && <div style={muted}>{r.facilityName}</div>}
                        </div>
                      </td>
                      <td data-th="Phone">
                        {r.phone ? <a className="ops-name" href={telHref(r.phone)} onClick={stop} style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{r.phone}</a> : '-'}
                      </td>
                      <td data-th="Email">
                        {r.email ? <a className="ops-name" href={`mailto:${r.email}`} onClick={stop} style={{ overflowWrap: 'anywhere' }}>{r.email}</a> : '-'}
                      </td>
                      <td data-th="Balance" className="num">
                        {r.balanceCents > 0 ? <span style={{ color: 'var(--bad-fg)' }}>{money(r.balanceCents, { exact: true })}</span>
                          : r.balanceCents < 0 ? money(r.balanceCents, { exact: true }) : '-'}
                      </td>
                      <td data-th="Paid Through" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDate(r.paidThrough, '-')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > 0 && (
            <div className="ops-pager">
              <span aria-live="polite">
                {shownFrom == null ? `${count(total)} in all` : `${count(shownFrom + 1)} - ${count(shownFrom + rows.length)} of ${count(total)}`}
              </span>
              {total > PAGE && (
                <span className="ops-pager-btns">
                  <button type="button" className="secondary-btn" onClick={() => setPage(page - 1)} disabled={waiting || page === 0}>Previous</button>
                  <button type="button" className="secondary-btn" onClick={() => setPage(page + 1)} disabled={waiting || offset + PAGE >= total}>Next</button>
                </span>
              )}
            </div>
          )}
        </>
      )}

      {openId && <TenantSheet customerId={openId} onClose={() => setOpenId('')} />}
    </div>
  );
}
