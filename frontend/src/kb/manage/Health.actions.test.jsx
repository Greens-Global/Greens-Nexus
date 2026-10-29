// Manage > Health actions (WP 4.3, Oct 29 2026): a reader report is resolved
// and a page request closed with a word back, in a popup (never the browser's
// prompt box); a page request is assigned to an author.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
const HEALTH = {
  stats: { published: 1, stale: 0, flags: 1, drafts: 0, in_review: 0, requests: 1, unmigrated: 0, signatures_outstanding: 0 },
  review_queue: [], stale: [], drafts: [], in_review: [], activity: [],
  misses: [{ query: 'portcullis', count: 3, last_day: '2026-10-28', results: 0 }], synonyms: [['fob', 'key card']],
  flags: [{ id: 'flg_1', doc_id: 'kb_1', title: 'Gate Codes', code: 'SOP-001', text: 'Step 2 is out of date', user_name: 'Eve', created_at: '2026-10-28T10:00:00Z', version: '1.0' }],
  requests: [{ id: 'req_1', query: 'How do I reset a gate?', note: '', user_name: 'Eve', created_at: '2026-10-28T10:00:00Z', collection_id: '', assigned_to: '', assigned_name: '' }],
};
vi.mock('../../api', () => {
  const api = {
    kbHealth: () => Promise.resolve(HEALTH),
    kbPeople: () => Promise.resolve([{ email: 'al@example.com', name: 'Al Author', department: 'Ops', job_title: 'Writer', role: 'employee' }]),
    kbResolveFlag: (id, note) => { calls.push(['resolve', id, note]); return Promise.resolve({}); },
    kbCloseRequest: (id, note) => { calls.push(['close', id, note]); return Promise.resolve({}); },
    kbAssignRequest: (id, email) => { calls.push(['assign', id, email]); return Promise.resolve({}); },
    kbSaveSynonyms: (groups) => { calls.push(['synonyms', groups]); return Promise.resolve({ groups }); },
  };
  return { api, default: api };
});

const { default: Health } = await import('./Health');
afterEach(() => { cleanup(); calls.length = 0; });

describe('Health actions', () => {
  it('resolves a reader report with a note in a popup', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    render(<Health me={{ can_manage: true }} />);
    fireEvent.click(await screen.findByRole('button', { name: /Resolve/ }));
    const box = await screen.findByLabelText('A Word Back to the Reader');
    fireEvent.change(box, { target: { value: 'Updated step 2' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Resolve/ }).at(-1));
    await waitFor(() => expect(calls).toEqual([['resolve', 'flg_1', 'Updated step 2']]));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('closes a page request with a note', async () => {
    render(<Health me={{ can_manage: true }} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Close$/ }));
    fireEvent.change(await screen.findByLabelText('A Word Back to the Person Who Asked'), { target: { value: 'See Gate Codes' } });
    fireEvent.click(screen.getByRole('button', { name: /Close Request/ }));
    await waitFor(() => expect(calls).toEqual([['close', 'req_1', 'See Gate Codes']]));
  });

  it('assigns a page request to an author', async () => {
    render(<Health me={{ can_manage: true }} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Assign$/ }));
    const search = await screen.findByPlaceholderText('A Knowledge Base author');
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'Al' } });
    await screen.findByText('Al Author');
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('button', { name: /^Assign$/ }).at(-1));
    await waitFor(() => expect(calls).toEqual([['assign', 'req_1', 'al@example.com']]));
  });

  it('adds a synonym from a search that found nothing, keeping the ones there', async () => {
    render(<Health me={{ can_manage: true }} />);
    expect(await screen.findByText('fob = key card')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Synonym' }));
    fireEvent.change(await screen.findByLabelText('Words Your Pages Use'), { target: { value: 'Gate, entry code' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Add Synonym/ }).at(-1));
    await waitFor(() => expect(calls).toEqual([['synonyms', [['fob', 'key card'], ['portcullis', 'gate', 'entry code']]]]));
  });
});
