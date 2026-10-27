import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

// The journal entry window (chat 10/26, item 03 - Urmi: "In the entry of any
// account, header is still not static"): the lines scroll in their own box
// under a heading row pinned as one block.

const lines = Array.from({ length: 40 }, (_, i) => ({
  id: `l${i}`, gl_code: String(62100 + i), account_name: `Account ${i}`, debit: i % 2 ? 10 : 0, credit: i % 2 ? 0 : 10, book_tag: 'both',
}));

vi.mock('../../api', () => ({
  api: {
    getAccountingEntry: vi.fn(async () => ({ entry: { id: 'e1', entry_no: 'IA-1', entry_date: '2026-10-01', posted_at: '2026-10-02' }, lines, intacct: [] })),
    getAccountingPrefs: vi.fn(async () => ({ prefs: {} })),
    saveAccountingPrefs: vi.fn(async () => ({})),
  },
}));

import EntryDetail from './EntryDetail';
import { resetAccountingPrefs } from './prefs';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  resetAccountingPrefs();
});

describe('EntryDetail', () => {
  it('scrolls the lines in their own box under a pinned heading row', async () => {
    render(<EntryDetail entryId="e1" entryNo="IA-1" onClose={() => {}} />);
    const box = await screen.findByTestId('entry-lines-box');
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('acct-entry--box')).toBe(true);
    expect(box.parentElement.classList.contains('acct-entry-body')).toBe(true);
    const table = box.querySelector('table');
    expect(table.classList.contains('acct-sticky-head')).toBe(true);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(41);   // 40 lines + Total

    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    // The window is a column that does not scroll; the box takes what is left and scrolls.
    expect(css).toContain('.modal-content.acct-entry.acct-entry--box { display: flex; flex-direction: column; overflow: hidden; }');
    expect(css).toContain('.acct-entry-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; }');
    expect(css).toContain('.acct-entry-body > .acct-entry-box { flex: 0 1 auto; min-height: 120px; }');
    expect(css).toContain('.acct-lines-wrap { overflow: auto;');
    expect(css).toContain('.acct-sticky-head.acct-sticky-head thead { position: sticky; top: 0; z-index: 3; }');
  });
});
