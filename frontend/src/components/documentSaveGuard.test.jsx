// An autosave must never blank a document that had content.
//
// Sagar, Sep 17: "It's showing saved, but if I click on X it discards all
// without saving the template."
//
// The version history said exactly what happened - two writes a second apart,
// same version number, one of them empty:
//
//   v7  21:40:48  blocks=138  chars=4206   'OFFER LETTER...'
//   v7  21:40:48  blocks=1    chars=0      ''
//   v6  21:40:38  blocks=1    chars=0      ''
//
// Something autosaved an EMPTY page every couple of seconds alongside the real
// one. Both writes succeeded, so the header said "Saved"; whichever landed
// last won, and the content survived or vanished by luck.
//
// The existing guard only refused a save with NO PAGES, which waves through a
// page that exists and is empty. isEmptyContent is the same judgement one
// level down.
//
//     npx vitest run src/components/documentSaveGuard.test.jsx
import { describe, expect, it } from 'vitest';
import { isEmptyContent } from './DocumentBuilder';

const page = (...content) => ({ id: 'p1', json: { type: 'doc', content } });
const para = (...inline) => ({ type: 'paragraph', content: inline });
const text = (t) => ({ type: 'text', text: t });

describe('deciding whether a document says anything', () => {
  it('a page with real text is not empty', () => {
    expect(isEmptyContent({ pages: [page(para(text('OFFER LETTER')))] })).toBe(false);
  });

  it('a lone empty paragraph is empty', () => {
    // Exactly what a freshly mounted editor returns - and what was being saved
    // over the real thing.
    expect(isEmptyContent({ pages: [page({ type: 'paragraph' })] })).toBe(true);
    expect(isEmptyContent({ pages: [page(para(text('   ')))] })).toBe(true);
  });

  it('no pages at all is empty', () => {
    expect(isEmptyContent({ pages: [] })).toBe(true);
    expect(isEmptyContent({})).toBe(true);
    expect(isEmptyContent(null)).toBe(true);
  });

  it('a page holding only a picture is not empty', () => {
    expect(isEmptyContent({ pages: [page({ type: 'image', attrs: { src: 'x' } })] })).toBe(false);
  });

  it('a page holding only variables is not empty', () => {
    // A template can be almost entirely merge fields - losing that is losing
    // the template.
    expect(isEmptyContent({ pages: [page(para({ type: 'mergeField', attrs: { token: 'offer.salary' } }))] }))
      .toBe(false);
  });

  it('a table, shape or textbox counts as content', () => {
    for (const type of ['table', 'docShape', 'docTextbox', 'pageBreak', 'bookmark']) {
      expect(isEmptyContent({ pages: [page({ type })] }), type).toBe(false);
    }
  });

  it('looks past empty pages to a later one that has content', () => {
    expect(isEmptyContent({ pages: [page(), { id: 'p2', json: { type: 'doc', content: [para(text('Clause 1'))] } }] }))
      .toBe(false);
  });

  it('counts a header or footer when the body is empty', () => {
    // Emptying the body of a letterheaded template is a real edit; the
    // document still says something.
    expect(isEmptyContent({
      pages: [page()],
      header: { type: 'doc', content: [para(text('Greens Global'))] },
    })).toBe(false);
  });

  it('survives content that is not shaped the way it expects', () => {
    expect(isEmptyContent({ pages: [{ id: 'p1' }] })).toBe(true);
    expect(isEmptyContent({ pages: [{ id: 'p1', json: null }] })).toBe(true);
    expect(isEmptyContent({ pages: 'nonsense' })).toBe(true);
  });
});
