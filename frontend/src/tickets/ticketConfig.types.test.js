import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the five ticket types can be offered on Submit a Ticket (Oct 1): an
// order saved before then that still switches on a retired type (dev had
// Service Request and Change / Enhancement on) stops offering it.

let saved = null;
vi.mock('../api', () => ({ api: { getTicketTaxonomySettings: vi.fn(() => Promise.resolve(saved)) } }));

const { refreshTicketConfig } = await import('./ticketConfig');
const { TICKET_TYPE_ORDER, TICKET_TYPE_KEYS } = await import('./ticketMeta');

beforeEach(() => { saved = null; });

describe('intake types from the saved order', () => {
  it('drops retired types and repeats from a saved order', async () => {
    saved = { typeOrder: ['incident', 'bug', 'service_request', 'change_request', 'bug'] };
    await refreshTicketConfig();
    expect([...TICKET_TYPE_ORDER]).toEqual(['incident', 'bug']);
  });

  it('falls back to the five when a saved order names none of them', async () => {
    saved = { typeOrder: ['service_request'] };
    await refreshTicketConfig();
    expect([...TICKET_TYPE_ORDER]).toEqual([...TICKET_TYPE_KEYS]);
  });
});
