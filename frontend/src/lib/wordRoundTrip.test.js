// What Nexus sends to Word comes back (Neil, 11/11/2026: "Make sure it's
// fully word compatible"). The four files in __fixtures__/word were written
// by the real exporter (backend/docx_roundtrip_fixtures.py, kept current by
// backend/test_docx_roundtrip_fixtures.py); each is imported here by the real
// importer and checked for what went out.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertDocxToTiptap } from './docxToTiptap';

const fixture = (name) => {
  const buf = readFileSync(resolve(__dirname, '__fixtures__/word', `${name}.docx`));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name: `${name}.docx`, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', arrayBuffer: async () => ab };
};
const walk = (node, fn) => { if (!node) return; if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return; } fn(node); walk(node.content, fn); };
const all = (node, type) => { const out = []; walk(node, (n) => { if (n.type === type) out.push(n); }); return out; };
const text = (node) => { let s = ''; walk(node, (n) => { if (n.type === 'text') s += n.text; }); return s; };

describe('Word round trip', () => {
  it('an offer letter template: headings, variables, a tab stop, the footer', async () => {
    const { body, footer, pageSetup } = await convertDocxToTiptap(fixture('offer-letter'), {});
    expect(all(body, 'heading').map(text)).toEqual(['Offer of Employment']);
    // The MERGEFIELDs come back as variables, not as «token» text.
    expect(all(body, 'mergeField').map((n) => n.attrs.token)).toEqual(['full_name', 'job_title', 'company', 'start_date', 'salary']);
    expect(text(body)).not.toContain('«');
    const sig = all(body, 'paragraph').find((p) => text(p).startsWith('Employee'));
    expect(sig.attrs.tabStops).toEqual([{ pos: 432, align: 'right' }]);
    expect(sig.content.map((n) => n.type)).toEqual(['text', 'tab', 'text']);
    expect(all(body, 'bulletList')).toHaveLength(1);
    // The footer's words come back; Word's page number fields are Nexus's own.
    expect(text(footer)).toContain('Greens Global - Confidential');
    expect(text(footer)).not.toMatch(/Page \d/);
    expect(pageSetup.size).toBe('letter');
  });

  it('a policy: footnotes in order, headings, the contents, no watermark text in the body', async () => {
    const { body } = await convertDocxToTiptap(fixture('policy'), {});
    expect(all(body, 'footnote').map((n) => n.attrs.text)).toEqual(['Codes change every 90 days.', 'Including sites under construction.']);
    expect(all(body, 'heading').map(text)).toEqual(expect.arrayContaining(['Purpose', 'Scope']));
    expect(text(body)).toContain('Purpose');
    expect(text(body)).not.toContain('DRAFT');
  });

  it('a redlined contract: changes stay tracked, by whom, and the comment comes with its words', async () => {
    const { body, comments } = await convertDocxToTiptap(fixture('redlined-contract'), {});
    const marked = (type) => { const out = []; walk(body, (n) => { if (n.type === 'text' && (n.marks || []).some((m) => m.type === type)) out.push(n); }); return out; };
    const ins = marked('insertion');
    const del = marked('deletion');
    expect(ins.map((n) => n.text).join('')).toBe('$4,500');
    expect(del.map((n) => n.text).join('')).toBe('$4,000');
    expect(ins[0].marks.find((m) => m.type === 'insertion').attrs.author).toBe('Neil Patel');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'Sagar Mehta', text: 'Should this be 60 days?', quote: 'with 30 days notice' });
    const onComment = marked('comment');
    expect(onComment.map((n) => n.text).join('')).toBe('with 30 days notice');
    expect(onComment[0].marks.find((m) => m.type === 'comment').attrs.id).toBe(comments[0].id);
  });

  it('a landscape table: the page, the margins and the merged cell come back', async () => {
    const { body, pageSetup } = await convertDocxToTiptap(fixture('landscape-table'), {});
    expect(pageSetup.orientation).toBe('landscape');
    expect(pageSetup.marginIn).toEqual({ top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 });
    const [table] = all(body, 'table');
    expect(table.content).toHaveLength(2);
    expect(table.content[0].content[0].attrs.colspan).toBe(2);
    expect(text(table)).toContain('Austin');
  });
});
