// The words for an entity's legal record - the same keys as backend
// legal_entities.py (ENTITY_TYPES, TAX_CLASSES, MANAGEMENT, STATUSES).

export const ENTITY_TYPES = [
  ['llc_single', 'Single-Member LLC'], ['llc_multi', 'Multi-Member LLC'], ['lp', 'Limited Partnership'],
  ['gp', 'General Partnership'], ['c_corp', 'C Corporation'], ['s_corp', 'S Corporation'], ['trust', 'Trust'], ['other', 'Other'],
];
export const TAX_CLASSES = [
  ['disregarded', 'Disregarded Entity'], ['partnership', 'Partnership'], ['s_corp', 'S Corporation'], ['c_corp', 'C Corporation'], ['trust', 'Trust'],
];
export const MANAGEMENT = [['member', 'Member-Managed'], ['manager', 'Manager-Managed'], ['board', 'Board of Directors'], ['trustee', 'Trustee']];
export const STATUSES = [['active', 'Active'], ['inactive', 'Inactive'], ['dissolved', 'Dissolved'], ['sold', 'Sold']];
