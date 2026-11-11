import { describe, it, expect, afterEach } from 'vitest';
import { Editor, generateHTML, generateJSON } from '@tiptap/core';
import { cleanTabStops, nextStop } from './docTabs';
import { BODY_EXTENSIONS } from './docBuilderSchema';

// Word's tabs (Neil, 11/11/2026): a real tab node and tab stops measured in
// points from the left margin - what Word writes as w:tab / w:tabs.
let editor = null;
afterEach(() => { editor?.destroy(); editor = null; });

describe('tab stops', () => {
  it('cleans what a paragraph stores: numbers, known kinds, sorted, no duplicates', () => {
    expect(cleanTabStops([{ pos: 216, align: 'right' }, { pos: '72', align: 'bogus' }, { pos: 72.2, align: 'center' }, { pos: -5 }, null]))
      .toEqual([{ pos: 72, align: 'left' }, { pos: 216, align: 'right' }]);
    expect(cleanTabStops('nope')).toEqual([]);
  });

  it('runs a tab to the next stop, then to Word\'s half-inch defaults', () => {
    const stops = [{ pos: 108, align: 'right' }];   // 1.5 in
    expect(nextStop(10, stops)).toEqual({ px: 144, align: 'right' });
    expect(nextStop(150, stops)).toEqual({ px: 192, align: 'left' });   // 2 in, the next default
    expect(nextStop(0, [])).toEqual({ px: 48, align: 'left' });
  });
});

describe('the tab node', () => {
  it('Tab inserts a tab, which reads as a tab in plain text', () => {
    editor = new Editor({ extensions: BODY_EXTENSIONS, content: '<p>Name</p>' });
    editor.commands.focus('end');
    editor.commands.keyboardShortcut('Tab');
    editor.commands.insertContent('Date');
    expect(editor.getText()).toBe('Name\tDate');
    expect(JSON.stringify(editor.getJSON())).toContain('"type":"tab"');
  });

  it('keeps a paragraph\'s stops through HTML, as an import or a paste carries them', () => {
    const json = { type: 'doc', content: [{ type: 'paragraph', attrs: { tabStops: [{ pos: 432, align: 'right' }] }, content: [
      { type: 'text', text: 'Employee' }, { type: 'tab' }, { type: 'text', text: 'Date' },
    ] }] };
    const html = generateHTML(json, BODY_EXTENSIONS);
    expect(html).toContain('data-tab-stops');
    const back = generateJSON(html, BODY_EXTENSIONS);
    expect(back.content[0].attrs.tabStops).toEqual([{ pos: 432, align: 'right' }]);
    expect(back.content[0].content.map((n) => n.type)).toEqual(['text', 'tab', 'text']);
  });
});
