// The Asset Management property a ticket is about (Property Tickets, Neil
// 10/05). Deleted, private (for those who cannot see them), vehicle and
// equipment assets never appear - see propertyMeta.js / /ticket-properties.
import { TicketSelect } from './TicketAtoms';
import { useTicketProperties, propertyLabel } from './propertyMeta';

// `noneOption` (Create a Ticket, Neil Oct 28 2026): the list starts with
// "None / Other" (PROPERTY_NONE) as a real answer and nothing is picked until
// the person picks - instead of "No Property" standing in for no answer.
export const PROPERTY_NONE = '__none__';
export function PropertySelect({ value, onChange, fallbackName = '', invalid = false, disabled = false, style, noneOption = false }) {
  const { properties, loading, error } = useTicketProperties();
  const options = properties.map((p) => ({ id: p.id, label: propertyLabel(p) }));
  // A ticket linked to a property since deleted (or now private to you) still
  // says where it was, rather than looking unlinked.
  if (value && value !== PROPERTY_NONE && !loading && !properties.some((p) => p.id === value)) {
    options.unshift({ id: value, label: `${fallbackName || 'Property'} (no longer in Asset Management)` });
  }
  return (
    <TicketSelect value={value || ''} onChange={onChange} disabled={disabled} invalid={invalid} style={style}
      placeholder={loading ? 'Loading properties…' : error ? "Couldn't load properties" : 'Select property'}
      searchPlaceholder="Search properties…" emptyText="No properties to choose from."
      options={noneOption
        ? [{ id: PROPERTY_NONE, label: 'None / Other', desc: 'Not at one of our properties' }, ...options]
        : [{ id: '', label: 'No Property' }, ...options]} />
  );
}
