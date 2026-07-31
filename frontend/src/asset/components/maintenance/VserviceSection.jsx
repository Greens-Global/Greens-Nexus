import { useState } from 'react';
import { CollectionTable } from '../shared/CollectionTable.jsx';
import { RecommendedMaintenance } from './RecommendedMaintenance.jsx';

/**
 * Wraps CollectionTable for the `vservice` collection (vehicle/equipment service log) with two
 * sub-tabs: "Service Log" (the editable record list, default) and "Recommended Maintenance"
 * (a read-only reference schedule) - the latter tab only appears when the asset actually has a
 * researched maintenanceSchedule.
 */
export function VserviceSection({ p: asset, rows, filters, setFilters, highlightItem, onAdd, onEdit, onQuickAdd }) {
  const hasSchedule = asset.maintenanceSchedule && asset.maintenanceSchedule.items && asset.maintenanceSchedule.items.length > 0;
  const [tab, setTab] = useState('log');

  const tabBtn = (value, label) => (
    <button
      key={value}
      onClick={() => setTab(value)}
      style={{
        padding: '7px 14px',
        borderRadius: 8,
        fontSize: '0.82rem',
        fontWeight: 600,
        cursor: 'pointer',
        border: 'none',
        background: tab === value ? 'var(--bg-card)' : 'transparent',
        color: tab === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        boxShadow: tab === value ? 'var(--shadow-sm)' : 'none',
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', marginBottom: 14 }}>
        {tabBtn('log', 'Service Log')}
        {hasSchedule && tabBtn('recommended', 'Recommended Maintenance')}
      </div>

      {tab === 'recommended' && hasSchedule ? (
        <RecommendedMaintenance p={asset} />
      ) : (
        <CollectionTable
          coll="vservice"
          rows={rows}
          active={asset}
          filters={filters}
          setFilters={setFilters}
          highlightItem={highlightItem}
          onAdd={onAdd}
          onEdit={onEdit}
          onQuickAdd={onQuickAdd}
        />
      )}
    </>
  );
}
