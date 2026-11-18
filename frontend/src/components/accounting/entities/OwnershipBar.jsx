import { pctText } from './structureModel';

// Who owns an entity, as one stacked bar and a ranked list - a cap table
// (Neil, 11/17/2026). The six largest owners by name, the rest counted
// together, and whatever is not recorded yet shown as such, never spread
// over the owners. Percentages are the operating agreement's (a deal's
// members in Investor Relations, else the entity's own owners).

const COLORS = ['var(--ec-part)', 'var(--ec-corp)', 'var(--ec-prop)', 'var(--ec-trust)', 'var(--ec-lend)', 'var(--ec-disr)', 'var(--ec-person)'];
const TOP = 6;

function capRows(owners) {
  const known = (owners || []).filter((o) => o.pct !== null && o.pct !== undefined && Number(o.pct) > 0)
    .map((o) => ({ ...o, pct: Number(o.pct) })).sort((a, b) => b.pct - a.pct);
  // Seven owners show by name; more than that and the smallest are counted together.
  const cut = known.length <= TOP + 1 ? known.length : TOP;
  const top = known.slice(0, cut).map((o, i) => ({ ...o, color: COLORS[i % COLORS.length] }));
  const rest = known.slice(cut);
  const rows = [...top];
  if (rest.length) rows.push({ id: 'rest', label: `${rest.length} more ${rest.length === 1 ? 'owner' : 'owners'}`, pct: rest.reduce((s, o) => s + o.pct, 0), color: COLORS[TOP % COLORS.length] });
  const total = known.reduce((s, o) => s + o.pct, 0);
  const missing = Math.max(0, Math.round((100 - total) * 10000) / 10000);
  const unknown = (owners || []).filter((o) => o.pct === null || o.pct === undefined).length;
  return { rows, total, missing, unknown };
}

export default function OwnershipBar({ owners, onOpenEntity }) {
  const { rows, missing, unknown } = capRows(owners);
  if (!rows.length) return null;
  const label = rows.map((r) => `${r.label} ${pctText(r.pct)}`).join(', ');
  return (
    <div className="ent-cap">
      <div className="ent-cap-bar" role="img" aria-label={`Ownership: ${label}${missing >= 0.01 ? `, ${pctText(missing)} not recorded` : ''}`}>
        {rows.map((r) => <span key={r.id} style={{ width: `${r.pct}%`, background: r.color }} title={`${r.label} ${pctText(r.pct)}`} />)}
        {missing >= 0.01 && <span style={{ width: `${missing}%`, background: 'transparent' }} title={`${pctText(missing)} not recorded`} />}
      </div>
      <div className="ent-cap-list">
        {rows.map((r) => (
          <div key={r.id} className="ent-cap-row">
            <i style={{ background: r.color }} aria-hidden="true" />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.kind === 'entity' && r.code && onOpenEntity
                ? <button type="button" className="ent-link" onClick={() => onOpenEntity(r.code)}>{r.label}</button> : r.label}
              {r.sub && r.kind !== 'entity' && <span className="ent-muted"> - {r.sub}</span>}
            </span>
            <b>{pctText(r.pct)}</b>
          </div>
        ))}
        {(missing >= 0.01 || unknown > 0) && (
          <div className="ent-cap-row ent-muted">
            <i style={{ background: 'var(--border-color)' }} aria-hidden="true" />
            <span>{missing >= 0.01 ? 'Not recorded yet' : ''}{unknown ? `${missing >= 0.01 ? ' - ' : ''}${unknown} ${unknown === 1 ? 'owner has' : 'owners have'} no percentage` : ''}</span>
            <b>{missing >= 0.01 ? pctText(missing) : ''}</b>
          </div>
        )}
      </div>
    </div>
  );
}
