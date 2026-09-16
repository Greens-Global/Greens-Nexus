// Can you actually TYPE in the document the importer just produced?
//
// Sagar, Sep 16, testing an imported Word document: "Undo is not working,
// Can't type sometime in the word doc which is imported, pressing space bar
// isn't inserting a space it's moving to the next character".
//
// Two root causes, both below the UI:
//
//  1. STRUCTURE. `image` used to be a BLOCK node while the importer wrote
//     pictures into a paragraph's inline content, where Word puts them.
//     Node.fromJSON does NOT validate, so the document loaded fine and then
//     threw "Called contentMatchAt on a node with invalid content" on the
//     first transform touching that paragraph. A Teams transcript is one
//     avatar per speaker turn, so most paragraphs silently refused to be
//     typed in - and an undo that landed on one threw the same way.
//
//     The image node is INLINE now, which is both valid and faithful: Word
//     keeps the avatar and the speaker's name in one paragraph, drawing
//     first. repairDocJson migrates documents saved either way - a picture
//     stranded at block level gets wrapped, stray inline content gets a
//     paragraph - so no saved document stays unusable.
//
//  2. CSS. ProseMirror's own stylesheets were never imported. Without
//     `.ProseMirror { white-space: pre-wrap }` the browser collapses runs of
//     spaces, which is precisely "the space bar moves the caret without
//     inserting anything"; without the gapcursor stylesheet the caret beside
//     a block image is invisible. That half is guarded in main.test.js.
//
//     npx vitest run src/lib/docEditorIntegrity.test.js
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { BODY_EXTENSIONS, repairDocJson } from './docBuilderSchema';

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const img = (attrs = {}) => ({ type: 'image', attrs: { src: IMG, width: 22, height: 22, ...attrs } });
const para = (...inline) => ({ type: 'paragraph', content: inline });
const text = (t) => ({ type: 'text', text: t });

const mount = (json) => new Editor({ extensions: BODY_EXTENSIONS, content: json });

// Types at the very end of the document, the way a person would.
function typeAtEnd(editor, str) {
  editor.commands.focus('end');
  editor.commands.insertContent(str);
}

describe('a document holding pictures stays editable', () => {
  it('repairs a picture that was saved inside a paragraph', () => {
    // Exactly what the old importer wrote for "<avatar>Neil Kadakia 0:03".
    const broken = { type: 'doc', content: [para(img(), text('Neil Kadakia   0:03'))] };
    const editor = mount(repairDocJson(broken));
    expect(() => typeAtEnd(editor, 'X')).not.toThrow();
    expect(editor.state.doc.textContent).toBe('Neil Kadakia   0:03X');
    editor.destroy();
  });

  it('leaves the picture beside the text, which is where Word put it', () => {
    // Word writes the avatar and the speaker's name into the SAME paragraph,
    // drawing first - verified against this document's own document.xml. The
    // image node is inline for exactly that reason, so this shape is valid and
    // must survive untouched; splitting it moves the picture onto its own line.
    const doc = { type: 'doc', content: [para(img(), text('Neil Kadakia'))] };
    expect(repairDocJson(doc)).toEqual(doc);
    const editor = mount(repairDocJson(doc));
    expect(editor.state.doc.firstChild.type.name).toBe('paragraph');
    expect(editor.state.doc.firstChild.firstChild.type.name).toBe('image');
    editor.destroy();
  });

  it('keeps the text on both sides of a picture, in order', () => {
    const doc = { type: 'doc', content: [para(text('before '), img(), text(' after'))] };
    const editor = mount(repairDocJson(doc));
    const kinds = [];
    editor.state.doc.firstChild.forEach((n) => kinds.push(n.type.name));
    expect(kinds).toEqual(['text', 'image', 'text']);
    expect(editor.state.doc.textContent).toBe('before  after');
    expect(() => typeAtEnd(editor, '!')).not.toThrow();
    editor.destroy();
  });

  it('migrates a picture an older version saved at block level', () => {
    // Documents written while `image` was a block node have it sitting
    // directly under doc, which the inline node makes invalid the other way
    // round. It gets wrapped in a paragraph rather than dropped.
    const legacy = { type: 'doc', content: [img(), para(text('Neil Kadakia'))] };
    const repaired = repairDocJson(legacy);
    expect(repaired.content[0].type).toBe('paragraph');
    expect(repaired.content[0].content[0].type).toBe('image');
    const editor = mount(repaired);
    let images = 0;
    editor.state.doc.descendants((n) => { if (n.type.name === 'image') images += 1; });
    expect(images).toBe(1);
    expect(() => typeAtEnd(editor, 'X')).not.toThrow();
    editor.destroy();
  });

  it('undo works on a repaired document', () => {
    const broken = { type: 'doc', content: [para(img(), text('Neil Kadakia'))] };
    const editor = mount(repairDocJson(broken));
    typeAtEnd(editor, ' speaking');
    expect(editor.state.doc.textContent).toBe('Neil Kadakia speaking');
    expect(editor.can().undo()).toBe(true);
    editor.chain().focus().undo().run();      // the exact call the toolbar makes
    expect(editor.state.doc.textContent).toBe('Neil Kadakia');
    editor.chain().focus().redo().run();
    expect(editor.state.doc.textContent).toBe('Neil Kadakia speaking');
    editor.destroy();
  });

  it('leaves an already-valid document exactly as it was', () => {
    const good = { type: 'doc', content: [para(text('Clause 1.'), img()), para(text('Clause 2.'))] };
    expect(repairDocJson(good)).toEqual(good);
  });

  it('wraps a stray run of text that is not in any block', () => {
    // The other direction: inline content sitting directly under doc.
    const broken = { type: 'doc', content: [text('orphaned text')] };
    const repaired = repairDocJson(broken);
    expect(repaired.content[0].type).toBe('paragraph');
    const editor = mount(repaired);
    expect(editor.state.doc.textContent).toBe('orphaned text');
    editor.destroy();
  });

  it('never produces an empty document, which would render as nothing', () => {
    expect(repairDocJson({ type: 'doc', content: [] }).content).toEqual([{ type: 'paragraph' }]);
  });

  it('repairs a picture inside a table cell too', () => {
    const broken = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(img(), text('cell'))] }] }],
      }],
    };
    const editor = mount(repairDocJson(broken));
    expect(() => typeAtEnd(editor, 'Z')).not.toThrow();
    expect(editor.state.doc.textContent).toContain('cell');
    editor.destroy();
  });
});

describe('the model keeps whitespace the way a Word user types it', () => {
  // The DOM half of this (white-space: pre-wrap) is enforced in main.test.js;
  // these pin that nothing in the schema is eating spaces before they get there.
  it('keeps consecutive spaces', () => {
    const editor = mount({ type: 'doc', content: [para(text('a'))] });
    typeAtEnd(editor, '   b');
    expect(editor.state.doc.textContent).toBe('a   b');
    editor.destroy();
  });

  it('keeps a trailing space at the end of a paragraph', () => {
    const editor = mount({ type: 'doc', content: [para(text('signed'))] });
    typeAtEnd(editor, ' ');
    expect(editor.state.doc.textContent).toBe('signed ');
    editor.destroy();
  });
});
