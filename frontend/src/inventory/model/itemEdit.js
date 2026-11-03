// Item Management - Which fields an item edit actually changed.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { OP_STATUS_PERSON } from './status';

// ── Edit Item Modal ────────────────────────────────────────────────────────────
// The Edit form submits every field; send only the ones that actually changed so
// the audit log reflects the real edit (not "changed everything"). Maps the
// snake_case payload keys to the camelCase item fields for comparison.
const _EDIT_FIELD_MAP = {
  name: 'name', item_type: 'itemType', make: 'make', model: 'model', year: 'year',
  department: 'department', default_owner: 'defaultOwner', ownership_type: 'ownershipType',
  status: 'status', op_status: 'opStatus', location: 'location', photo_url: 'photoUrl',
  op_status_person_email: 'opStatusPersonEmail', op_status_person_name: 'opStatusPersonName',
  picture_required: 'pictureRequired', asset_value: 'assetValue',
};
export function diffItemEdit(item, data) {
  const out = {};
  for (const [k, camel] of Object.entries(_EDIT_FIELD_MAP)) {
    if (!(k in data)) continue;
    const nv = data[k], ov = item[camel];
    let same;
    if (k === 'asset_value')           same = (Number(nv) || 0) === (Number(ov) || 0);
    else if (k === 'picture_required') same = !!nv === (ov !== false);
    else                               same = String(nv ?? '') === String(ov ?? '');
    if (!same) out[k] = nv;
  }
  // If op_status changed to a person-bound status, carry the person fields too so
  // the server can record/notify, even if those strings happened to match.
  if ('op_status' in out && OP_STATUS_PERSON.has(out.op_status)) {
    if ('op_status_person_email' in data) out.op_status_person_email = data.op_status_person_email;
    if ('op_status_person_name'  in data) out.op_status_person_name  = data.op_status_person_name;
  }
  return out;
}
