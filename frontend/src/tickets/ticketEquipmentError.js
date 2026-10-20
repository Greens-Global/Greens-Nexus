// The server's refusal of an Equipment pick on Create a Ticket
// (backend/routers/ticket_items.py check_items: 403 not yours, 404 gone or
// behind the wall, 422 another company / too many). Every one of those
// messages names "equipment", which is how it is told apart from any other
// refusal of the form. '' = not an equipment error.
export function equipmentError(e) {
  const msg = typeof e?.detail === 'string' ? e.detail : String(e?.message || '');
  return [403, 404, 422].includes(e?.status) && /equipment/i.test(msg) ? msg : '';
}
