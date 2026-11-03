// Item Management - How a field value reads in the activity log.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { EMPTY } from '../model/auditFeed';
import { PhotoChip } from './PhotoChip';

export function auditVal(field, value, kind) {
  if (field === 'photo_url') return value ? <PhotoChip url={value} kind={kind} /> : EMPTY;
  // Show the friendly ownership words everywhere, never the raw "transient" (Neil).
  if (field === 'ownership_type' && value) return value === 'permanent' ? 'Permanent' : 'Temporary';
  return value === '' || value == null ? EMPTY : value;
}
