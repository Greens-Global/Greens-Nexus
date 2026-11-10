import { describe, it, expect, vi } from 'vitest';
import { isUntitled, suggestName, askForName } from './untitled';

// A document or sheet starts unnamed and is named on Close (Neil, 11/10/2026).
describe('untitled', () => {
  it('knows an unnamed document or sheet', () => {
    for (const t of ['', '  ', null, undefined, 'Untitled Document', 'untitled sheet', 'Untitled Document (2)']) expect(isUntitled(t)).toBe(true);
    for (const t of ['Vendor Agreement', 'Untitled Ideas', 'Untitled Document Draft 2']) expect(isUntitled(t)).toBe(false);
  });

  it('suggests the first line of text, cut at a word', () => {
    expect(suggestName('\n\n  Master Services Agreement.\nThis agreement...')).toBe('Master Services Agreement');
    expect(suggestName('')).toBe('');
    const long = suggestName('This agreement is made between Greens Global and the vendor named below for the services');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(' ')).toBe(false);
  });

  it('asks with a required name and says Keep Editing / Save & Close', async () => {
    const dialog = { prompt: vi.fn().mockResolvedValue('  Q3 Budget  ') };
    expect(await askForName(dialog, { kind: 'sheet' })).toBe('Q3 Budget');
    const opts = dialog.prompt.mock.calls[0][1];
    expect(opts).toMatchObject({ title: 'Name This Sheet', required: true, confirmText: 'Save & Close', cancelText: 'Keep Editing' });
    dialog.prompt.mockResolvedValue(null);
    expect(await askForName(dialog)).toBe(null);
    dialog.prompt.mockResolvedValue('Untitled Document');
    expect(await askForName(dialog)).toBe(null);
  });
});
