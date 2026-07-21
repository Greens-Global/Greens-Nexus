// "Assembled Asset" summary table. Shown on the LEAD parcel of a group that has been marked
// `assembled` (see ParcelManager's "Treat parcels as one assembled asset" checkbox). Lists
// every parcel in the group with just the lightweight fields (APN, lot size, acquisition,
// zoning) plus a Total row — the full project detail lives only on the lead.
//
// Renders null if the group has fewer than 2 members (nothing to summarize).

import { formatNumber, normLabel } from '../../lib/format.js';
import { groupMembersOf, parcelAcres, parcelLot } from '../../lib/parcelGrouping.js';

/** Read a field's value: prefer the flat top-level key, else fall back to the free-text snapshot. */
function parcelField(p, label, key) {
  if (key && p[key] != null && String(p[key]).trim() !== '') return String(p[key]);
  let value = '';
  (p.snapshot || []).forEach((group) => {
    (group.fields || []).forEach((f) => {
      if (normLabel(f.label) === normLabel(label) && f.value != null && String(f.value).trim() !== '') {
        value = String(f.value);
      }
    });
  });
  return value;
}

function toMoney(v) {
  const n = parseFloat(String(v || '').replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : 0;
}

const cellStyle = {
  padding: '9px 14px',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
  borderTop: '1px solid var(--border-color)',
};

const COLUMNS = ['Parcel', 'APN', 'Lot Size', 'Acquisition', 'Zoning'];

export function AssemblageParcels({ lead, all, onOpen }) {
  const members = groupMembersOf(lead, all);
  if (members.length < 2) return null;

  const totalAcres = members.reduce((sum, m) => sum + parcelAcres(m), 0);
  const totalCost = members.reduce((sum, m) => sum + toMoney(parcelField(m, 'Acquisition Price')), 0);

  return (
    <div
      style={{
        marginBottom: 14,
        borderRadius: 14,
        border: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-card)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        <div
          style={{
            fontSize: '1rem',
            fontWeight: 800,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            color: 'var(--text-primary)',
          }}
        >
          Parcels in This Assemblage
        </div>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {members.length} parcels · ~{totalAcres.toFixed(1)} ac
          {totalCost > 0 ? ` · $${formatNumber(totalCost)} cost basis` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr>
              {COLUMNS.map((c, i) => (
                <th
                  key={i}
                  style={{
                    textAlign: 'left',
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-muted)',
                    padding: '8px 14px',
                    backgroundColor: 'var(--bg-secondary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isLead = m.id === lead.id;
              const acquisitionPrice = toMoney(parcelField(m, 'Acquisition Price'));
              return (
                <tr
                  key={m.id}
                  onClick={() => onOpen(m.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(m.id);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {m.name}
                    {isLead ? (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: '0.58rem',
                          fontWeight: 700,
                          letterSpacing: '0.03em',
                          color: 'hsl(var(--color-purple))',
                        }}
                      >
                        LEAD
                      </span>
                    ) : null}
                  </td>
                  <td style={cellStyle}>{parcelField(m, 'APN', 'apn') || '—'}</td>
                  <td style={cellStyle}>{parcelLot(m) || '—'}</td>
                  <td style={cellStyle}>{acquisitionPrice > 0 ? `$${formatNumber(acquisitionPrice)}` : '—'}</td>
                  <td style={cellStyle}>{parcelField(m, 'Zoning', 'zoning') || '—'}</td>
                </tr>
              );
            })}
            <tr style={{ borderTop: '2px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <td style={{ padding: '9px 14px', fontWeight: 700, color: 'var(--text-primary)' }}>Total</td>
              <td style={{ padding: '9px 14px' }} />
              <td style={{ padding: '9px 14px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                ~{totalAcres.toFixed(2)} ac
              </td>
              <td style={{ padding: '9px 14px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {totalCost > 0 ? `$${formatNumber(totalCost)}` : '—'}
              </td>
              <td style={{ padding: '9px 14px' }} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
