import { useState } from 'react';
import { CollectionTable } from '../shared/CollectionTable.jsx';
import { ManageUnitsModal } from './ManageUnitsModal.jsx';

/**
 * Wraps CollectionTable for the `maintenance` collection with a per-unit filter. Properties
 * without any defined units just show CollectionTable directly, plus a low-key opt-in link to
 * set up multi-tenant suites/units. Once units exist, a pill row lets you scope the log to
 * "All Units", "Common Areas" (records with no `unit` set), or a specific unit.
 */
export function PropertyMaintenanceSection({ p: property, rows, filters, setFilters, highlightItem, onAdd, onEdit, onSaveUnits, onQuickAdd }) {
  const units = property.tenantUnits || [];
  const [unitFilter, setUnitFilter] = useState('all');
  const [managing, setManaging] = useState(false);

  const filteredRows =
    unitFilter === 'all' ? rows : unitFilter === 'common' ? rows.filter((r) => !r.unit) : rows.filter((r) => r.unit === unitFilter);

  const pill = (value, label) => (
    <button
      key={value}
      onClick={() => setUnitFilter(value)}
      style={{
        padding: '6px 13px',
        borderRadius: 8,
        fontSize: '0.8rem',
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        whiteSpace: 'nowrap',
        background: unitFilter === value ? 'var(--bg-card)' : 'transparent',
        color: unitFilter === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        boxShadow: unitFilter === value ? 'var(--shadow-sm)' : 'none',
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      {units.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 4,
            padding: 4,
            borderRadius: 10,
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            marginBottom: 14,
          }}
        >
          {pill('all', 'All Units')}
          {pill('common', 'Common Areas')}
          {units.map((u) => pill(u.label, u.label))}
          <button
            onClick={() => setManaging(true)}
            style={{
              marginLeft: 'auto',
              padding: '6px 12px',
              borderRadius: 8,
              fontSize: '0.76rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            {'⚙ Manage Units'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setManaging(true)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'hsl(var(--color-blue))', fontSize: '0.8rem', fontWeight: 600, padding: 0, marginBottom: 14 }}
        >
          + Multi-tenant property? Set up suites/units
        </button>
      )}

      {managing && (
        <ManageUnitsModal
          units={units}
          onSave={(updatedUnits) => {
            onSaveUnits(updatedUnits);
            setManaging(false);
          }}
          onClose={() => setManaging(false)}
        />
      )}

      <CollectionTable
        coll="maintenance"
        rows={filteredRows}
        active={property}
        filters={filters}
        setFilters={setFilters}
        highlightItem={highlightItem}
        onAdd={onAdd}
        onEdit={onEdit}
        onQuickAdd={onQuickAdd}
      />
    </>
  );
}
