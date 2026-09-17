// ProseMirror's stylesheets are load-bearing, not decoration.
//
// They were never imported, and the symptoms read as editor bugs rather than
// missing CSS, which is why this is a test and not a comment:
//
//   * .ProseMirror { white-space: pre-wrap } - without it the browser collapses
//     runs of spaces. Typing a second space appeared to move the caret and
//     insert nothing ("pressing space bar isn't inserting a space it's moving
//     to the next character", Sagar, Sep 16).
//   * .ProseMirror-gapcursor - the caret shown beside a block image or table.
//     Unstyled it is an invisible zero-size div, so clicking next to one of an
//     imported transcript's 49 avatars looked like the document ignored you.
//   * img.ProseMirror-separator / .ProseMirror-hideselection /
//     .ProseMirror-selectednode - ProseMirror's own internal elements, which
//     render as visible junk without their rules.
//   * prosemirror-tables - column resize handles and the selected-cell tint;
//     Table is configured with resizable: true, which does nothing without it.
//
//     npx vitest run src/main.test.js
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'prosemirror-view/style/prosemirror.css',
  'prosemirror-gapcursor/style/gapcursor.css',
  'prosemirror-tables/style/tables.css',
];

describe('the app loads ProseMirror\'s stylesheets', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.jsx'), 'utf8');

  for (const sheet of REQUIRED) {
    it(`imports ${sheet}`, () => {
      expect(src).toContain(sheet);
    });
  }

  it('loads them before the app stylesheet, so app rules still win', () => {
    const lastSheet = Math.max(...REQUIRED.map(s => src.indexOf(s)));
    expect(lastSheet).toBeLessThan(src.indexOf("'./style.css'"));
  });

  it('keeps the Document Builder floats anchored to the page', () => {
    // prosemirror.css sets position:relative on .ProseMirror. Floating images
    // and shapes store x/y measured from .doc-page (insertPageCoords) and are
    // positioned against it (applyWrapStyle), so letting .ProseMirror become
    // the containing block would shift every one of them by the page padding.
    const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
    expect(css).toMatch(/\.doc-editor \.ProseMirror\s*\{[^}]*position:\s*static/);
  });
});
