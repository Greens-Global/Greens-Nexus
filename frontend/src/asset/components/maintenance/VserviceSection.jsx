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
    <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
      style={{
        padding: '8px 0', marginBottom: -1, border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit', fontSize: 13, fontWeight: tab === value ? 600 : 500,
        color: tab === value ? 'var(--text-primary)' : 'var(--text-secondary)',
        borderBottom: tab === value ? '2px solid var(--text-primary)' : '2px solid transparent',
      }}>
      {label}
    </button>
  );

  return (
    <>
      {hasSchedule && (
        <div role="tablist" aria-label="Service" style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--border-color)', marginBottom: 4 }}>
          {tabBtn('log', 'Service Log')}
          {tabBtn('recommended', 'Recommended Maintenance')}
        </div>
      )}

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
