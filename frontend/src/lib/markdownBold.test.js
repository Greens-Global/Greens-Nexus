// Literal **pairs** become bold, never asterisks in a packet document (Neil,
// Oct 22: documents "coming in with ****** formatting").
//
//     npx vitest run src/lib/markdownBold.test.js
import { describe, expect, it } from 'vitest';
import { splitMdBold, boldTextNode } from './markdownBold';
import { repairDocJson } from './docBuilderSchema';
import { importDocumentFile } from './docBuilderImport';

const doc = (...content) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

describe('splitMdBold', () => {
  it('takes out a pair on the same text', () => {
    expect(splitMdBold('a **b** c')).toEqual([['a ', false], ['b', true], [' c', false]]);
    expect(splitMdBold('**Term:** one')).toEqual([['Term:', true], [' one', false]]);
  });
  it('leaves lone or spaced-out asterisks as written', () => {
    for (const t of ['5 * 3', 'a ** b', '** not bold **', 'end **', '****', 'Note*', '']) {
      expect(splitMdBold(t)).toEqual([[t, false]]);
    }
  });
});

describe('boldTextNode', () => {
  it('adds a bold mark to the pair and keeps the other marks', () => {
    const italic = [{ type: 'italic' }];
    expect(boldTextNode({ type: 'text', text: 'x **y**', marks: italic })).toEqual([
      { type: 'text', text: 'x ', marks: italic },
      { type: 'text', text: 'y', marks: [{ type: 'italic' }, { type: 'bold' }] },
    ]);
    const plain = { type: 'text', text: 'nothing here' };
    expect(boldTextNode(plain)[0]).toBe(plain);
  });
});

describe('repairDocJson (every document on its way into the editor)', () => {
  it('turns a saved "a **b** c" into a, bold b, c', () => {
    const out = repairDocJson(doc({ type: 'text', text: 'a **b** c' }));
    expect(out.content[0].content).toEqual([
      { type: 'text', text: 'a ' }, { type: 'text', text: 'b', marks: [{ type: 'bold' }] }, { type: 'text', text: ' c' },
    ]);
  });
  it('leaves a code block alone', () => {
    const code = { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x = **kw**' }] }] };
    expect(repairDocJson(code).content[0].content).toEqual([{ type: 'text', text: 'x = **kw**' }]);
  });
});

describe('.txt / .md import', () => {
  it('writes **pairs** as <strong>', async () => {
    const body = 'This **Agreement** binds.\n\nPlain & simple * here';
    const file = { name: 'nda.md', size: body.length, text: async () => body };   // jsdom's File has no text()
    const { html } = await importDocumentFile(file);
    expect(html).toBe('<p>This <strong>Agreement</strong> binds.</p>\n<p>Plain &amp; simple * here</p>');
  });
});
