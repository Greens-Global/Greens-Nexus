// The shared document behind a live Document Builder session (docModel.js).
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { seedLiveDoc, validateLiveDoc, syncPageIds, pageField, isRemoteTr, pagesOf } from './docModel';

const para = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const textOf = (doc, field) => JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(field)));

describe('seedLiveDoc', () => {
  it('puts every page, the bands and the settings into one shared document', () => {
    const doc = seedLiveDoc({ pages: [{ id: 'p1', json: para('One') }, { id: 'p2', json: para('Two') }],
      header: para('Head'), footer: null, pageSetup: { size: 'letter' }, trackChanges: true });
    expect(doc.getArray('pages').toArray()).toEqual(['p1', 'p2']);
    expect(textOf(doc, pageField('p2'))).toContain('Two');
    expect(textOf(doc, 'header')).toContain('Head');
    expect(doc.getMap('meta').toJSON()).toEqual({ header: true, footer: false, pageSetup: { size: 'letter' }, trackChanges: true });
    expect(() => validateLiveDoc(doc)).not.toThrow();
  });

  it('splits a pre-pages document at its page breaks', () => {
    const pages = pagesOf({ body: { type: 'doc', content: [para('A').content[0], { type: 'pageBreak' }, para('B').content[0]] } });
    expect(pages).toHaveLength(2);
  });
});

describe('validateLiveDoc', () => {
  it('refuses a broken page list and unknown nodes', () => {
    const bad = new Y.Doc();
    bad.getArray('pages').push(['p1', 'p1']);
    expect(() => validateLiveDoc(bad)).toThrow();
    const odd = seedLiveDoc({ pages: [{ id: 'p1', json: para('x') }] });
    odd.transact(() => { odd.getXmlFragment(pageField('p1')).insert(0, [new Y.XmlElement('script')]); });
    expect(() => validateLiveDoc(odd)).toThrow();
  });
});

describe('syncPageIds', () => {
  it('keeps a page a colleague added at the same time', () => {
    const a = seedLiveDoc({ pages: [{ id: 'p1', json: para('x') }, { id: 'p2', json: para('y') }] });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    syncPageIds(a, ['p1', 'p2', 'pa']);         // A adds a page at the end
    syncPageIds(b, ['pb', 'p1', 'p2']);         // B adds one at the start, offline
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(a.getArray('pages').toArray()).toEqual(b.getArray('pages').toArray());
    expect(a.getArray('pages').toArray().sort()).toEqual(['p1', 'p2', 'pa', 'pb']);
  });

  it('moves and removes pages', () => {
    const d = seedLiveDoc({ pages: ['p1', 'p2', 'p3'].map((id) => ({ id, json: para(id) })) });
    syncPageIds(d, ['p3', 'p1']);
    expect(d.getArray('pages').toArray()).toEqual(['p3', 'p1']);
  });
});

describe('isRemoteTr', () => {
  const tr = (meta) => ({ getMeta: (k) => (k === 'y-sync$' ? meta : undefined) });
  it('is someone else\'s typing, never my own Undo', () => {
    expect(isRemoteTr(tr({ isChangeOrigin: true }))).toBe(true);
    expect(isRemoteTr(tr({ isChangeOrigin: true, isUndoRedoOperation: true }))).toBe(false);
    expect(isRemoteTr(tr(undefined))).toBe(false);
    expect(isRemoteTr(undefined)).toBe(false);
  });
});
