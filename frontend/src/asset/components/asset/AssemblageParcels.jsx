// "Assembled Asset" summary table. Shown on the LEAD parcel of a group that has been marked
// `assembled` (see ParcelManager's "Treat parcels as one assembled asset" checkbox). Lists
// every parcel in the group with just the lightweight fields (APN, lot size, acquisition,
// zoning) plus a Total row - the full project detail lives only on the lead.
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
  padding: '9px 12px 9px 0',
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
    <section aria-label="Parcels in This Assemblage" style={{ marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Parcels in This Assemblage</h3>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {members.length} parcels · about {totalAcres.toFixed(1)} acres
          {totalCost > 0 ? ` · $${formatNumber(totalCost)} cost basis` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {COLUMNS.map((c, i) => (
                <th
                  key={i}
                  style={{
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--text-secondary)',
                    padding: '8px 12px 8px 0',
                    borderBottom: '1px solid var(--border-color)',
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
                    {isLead ? <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>(Lead)</span> : null}
                  </td>
                  <td style={cellStyle}>{parcelField(m, 'APN', 'apn') || '-'}</td>
                  <td style={cellStyle}>{parcelLot(m) || '-'}</td>
                  <td style={cellStyle}>{acquisitionPrice > 0 ? `$${formatNumber(acquisitionPrice)}` : '-'}</td>
                  <td style={cellStyle}>{parcelField(m, 'Zoning', 'zoning') || '-'}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>Total</td>
              <td style={cellStyle} />
              <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                about {totalAcres.toFixed(2)} acres
              </td>
              <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                {totalCost > 0 ? `$${formatNumber(totalCost)}` : '-'}
              </td>
              <td style={cellStyle} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
