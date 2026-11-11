import { describe, it, expect, afterEach } from 'vitest';
import { Editor, generateHTML, generateJSON } from '@tiptap/core';
import { BODY_EXTENSIONS } from './docBuilderSchema';
import { numberFootnotes } from './docFootnote';

// Word's footnotes (Neil, 11/11/2026): a note is an inline node carrying its
// words, numbered across every page in order.
const editors = [];
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); });
const make = (content) => { const e = new Editor({ extensions: BODY_EXTENSIONS, content }); editors.push(e); return e; };

describe('footnotes', () => {
  it('keep their words through HTML', () => {
    const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Salary' }, { type: 'footnote', attrs: { text: 'Before taxes.' } }] }] };
    const html = generateHTML(json, BODY_EXTENSIONS);
    expect(html).toContain('data-footnote="Before taxes."');
    const back = generateJSON(html, BODY_EXTENSIONS);
    expect(back.content[0].content[1]).toEqual({ type: 'footnote', attrs: { text: 'Before taxes.' } });
  });

  it('are numbered across the pages, in order', () => {
    const one = make({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }, { type: 'footnote', attrs: { text: 'first' } }, { type: 'footnote', attrs: { text: 'second' } }] }] });
    const two = make({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }, { type: 'footnote', attrs: { text: 'third' } }] }] });
    expect(numberFootnotes([one, two])).toBe(3);
    expect([...two.view.dom.querySelectorAll('sup.doc-footnote')].map((el) => el.textContent)).toEqual(['3']);
    expect([...one.view.dom.querySelectorAll('sup.doc-footnote')].map((el) => el.title)).toEqual(['first', 'second']);
  });
});
