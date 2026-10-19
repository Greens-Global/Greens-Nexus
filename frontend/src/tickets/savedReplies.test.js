import { describe, it, expect } from 'vitest';
import { PLACEHOLDERS, fillPlaceholders, placeholderValues, rankReplies, replyText, displayName } from './savedReplies';

// Saved replies (Oct 2026): placeholders are filled when a reply is inserted
// into the ticket composer. The list must match the backend's
// (routers/ticket_saved_replies.py PLACEHOLDERS).

const ticket = { code: '000042', subject: 'Printer <jam> & smoke', requesterId: 'maria.lopez@greensglobal.com', application: 'Printer or Scanner' };
const names = { 'maria.lopez@greensglobal.com': 'Maria Lopez', 'sam@greensglobal.com': 'Sam Patel' };
const nameOf = (e) => names[e] || e;

describe('saved reply placeholders', () => {
  it('documents the same six names as the backend', () => {
    expect(PLACEHOLDERS.map((p) => p.key)).toEqual(['requester_first_name', 'requester_name', 'ticket_number',
      'ticket_subject', 'agent_first_name', 'agent_name']);
  });

  it('fills every known placeholder for the ticket and the agent', () => {
    const v = placeholderValues({ ticket, agentEmail: 'sam@greensglobal.com', nameOf });
    expect(v).toEqual({
      requester_first_name: 'Maria', requester_name: 'Maria Lopez', ticket_number: 'Ticket #42',
      ticket_subject: 'Printer <jam> & smoke', agent_first_name: 'Sam', agent_name: 'Sam Patel',
    });
    const out = fillPlaceholders('<p>Hi {requester_first_name}, about {ticket_number} ({ticket_subject}) - {agent_name}</p>', v);
    expect(out).toBe('<p>Hi Maria, about Ticket #42 (Printer &lt;jam&gt; &amp; smoke) - Sam Patel</p>');
  });

  it('leaves unknown placeholders, and known ones with no value, as typed', () => {
    const v = placeholderValues({ ticket: { code: '' }, agentEmail: 'sam@greensglobal.com', nameOf });
    expect(fillPlaceholders('{order_number} {ticket_number} {Agent_Name} {agent_first_name}', v))
      .toBe('{order_number} {ticket_number} {Agent_Name} Sam');
  });

  it('names someone it does not know from their address, never the raw address', () => {
    expect(displayName('', 'jo.smith@x.com')).toBe('Jo Smith');
    expect(displayName('jo.smith@x.com', 'jo.smith@x.com')).toBe('Jo Smith');
    const v = placeholderValues({ ticket: { requesterId: 'new.person@x.com' }, agentEmail: '', nameOf });
    expect(v.requester_first_name).toBe('New');
  });

  it('plain text can skip the escaping', () => {
    expect(fillPlaceholders('{ticket_subject}', { ticket_subject: 'a < b' }, { html: false })).toBe('a < b');
  });
});

describe('rankReplies', () => {
  const rows = [
    { id: '1', title: 'Welcome', body: '<p>Hello</p>', helpTopic: '', useCount: 9 },
    { id: '2', title: 'Printer Fix', body: '<p>Turn it off &amp; on</p>', helpTopic: 'Printer or Scanner', useCount: 1 },
    { id: '3', title: 'Another Printer', body: '<p>Toner</p>', helpTopic: 'printer or scanner', useCount: 3 },
  ];
  it('puts the ticket topic first, then by use', () => {
    expect(rankReplies(rows, { topic: 'Printer or Scanner' }).map((r) => r.id)).toEqual(['3', '2', '1']);
    expect(rankReplies(rows).map((r) => r.id)).toEqual(['1', '3', '2']);
  });
  it('searches title, text and topic', () => {
    expect(rankReplies(rows, { query: 'toner' }).map((r) => r.id)).toEqual(['3']);
    expect(rankReplies(rows, { query: 'off & on' }).map((r) => r.id)).toEqual(['2']);
    expect(rankReplies(rows, { query: 'scanner' }).map((r) => r.id).sort()).toEqual(['2', '3']);
  });
  it('replyText strips markup', () => {
    expect(replyText('<p>One</p><p>Two &amp; <b>three</b></p>')).toBe('One Two & three');
  });
});
