// A board embedded in a note (11/02/2026): the node round-trips through the
// HTML the server keeps, with only a note id, a title and our own thumbnail.
import { describe, it, expect, vi } from 'vitest';
import { generateHTML, generateJSON } from '@tiptap/core';

vi.mock('../../lib/storageView', () => ({ isOwnImageUrl: (u) => /supabase\.co\/storage/.test(u || '') }));
vi.mock('../newBoard', () => ({ openBoard: vi.fn() }));

import { buildExtensions } from '../noteExtensions';

const OWN = 'https://x.supabase.co/storage/v1/object/public/task-files/notes/boards/note_1/thumb.png';
const exts = buildExtensions('');

describe('BoardEmbed node', () => {
  it('parses the saved anchor and renders it back with the same attributes', () => {
    const html = `<p>Plan</p><a data-type="boardEmbed" data-note="note_abc" data-thumb="${OWN}" title="Yard Layout">Yard Layout</a>`;
    const json = generateJSON(html, exts);
    const node = json.content.find((n) => n.type === 'boardEmbed');
    expect(node.attrs).toEqual({ noteId: 'note_abc', title: 'Yard Layout', thumbUrl: OWN });
    const out = generateHTML(json, exts);
    expect(out).toContain('data-type="boardEmbed"');
    expect(out).toContain('data-note="note_abc"');
    expect(out).toContain(`data-thumb="${OWN}"`);
    expect(out).toContain('>Yard Layout</a>');
  });

  it('drops a foreign thumbnail and a bad note id on the way in and out', () => {
    const html = '<a data-type="boardEmbed" data-note="javascript:x" data-thumb="https://evil.example/a.png" title="T">T</a>';
    const node = generateJSON(html, exts).content.find((n) => n.type === 'boardEmbed');
    expect(node.attrs.noteId).toBe('');
    expect(node.attrs.thumbUrl).toBe('');
    const out = generateHTML({ type: 'doc', content: [{ type: 'boardEmbed', attrs: { noteId: 'note_ok', title: 'x'.repeat(300), thumbUrl: 'https://evil.example/a.png' } }] }, exts);
    expect(out).not.toContain('evil.example');
    expect(out).toContain('data-note="note_ok"');
    expect(out).not.toContain('x'.repeat(201));
  });

  it('a plain link is still a link, not a board', () => {
    const json = generateJSON('<p><a href="https://nexus.example/x">x</a></p>', exts);
    expect(JSON.stringify(json)).not.toContain('boardEmbed');
  });
});
