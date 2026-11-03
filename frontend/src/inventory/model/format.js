// Item Management - Money and request-number formatting.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).

export const fmtMoney = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');

// Short request number derived from the order/checkout id - Neil: tag the
// backend request number on the front end and make it searchable
// ("hey, I'm talking about request number 818").
export function requestNo(key) {
  return (key || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase();
}
