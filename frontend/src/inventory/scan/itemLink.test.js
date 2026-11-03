import { describe, it, expect } from 'vitest';
import { itemSub, itemPath, itemUrl, parseItemSub, parseScannedCode } from './itemLink';
import { itemLinkSub, VIEW_TO_PATH, PATH_TO_VIEW } from '../../lib/routes';

// Items phase 4: every item has a stable link, /itemmanagement/item/<id>.
// App.jsx's parsePath turns the path into the Items sub "item/<id>" (through
// itemLinkSub) and the address writer turns the sub back into the same path.

const ORIGIN = 'https://nexus.example.com';

describe('the item link', () => {
  it('builds the path and the full link on the app origin', () => {
    expect(itemSub('7f3a-1')).toBe('item/7f3a-1');
    expect(itemPath('7f3a-1')).toBe('/itemmanagement/item/7f3a-1');
    expect(itemUrl('7f3a-1', ORIGIN)).toBe('https://nexus.example.com/itemmanagement/item/7f3a-1');
    expect(itemUrl('7f3a-1', `${ORIGIN}/`)).toBe('https://nexus.example.com/itemmanagement/item/7f3a-1');
    expect(itemUrl('a b/c', ORIGIN)).toBe('https://nexus.example.com/itemmanagement/item/a%20b%2Fc');
  });

  it('defaults to the page origin', () => {
    expect(itemUrl('x1')).toBe(`${window.location.origin}/itemmanagement/item/x1`);
  });

  it('reads the item id back out of a sub, old bell form included', () => {
    expect(parseItemSub('item/7f3a-1')).toBe('7f3a-1');
    expect(parseItemSub('item:7f3a-1')).toBe('7f3a-1');
    expect(parseItemSub(itemSub('a b/c'))).toBe('a b/c');
    for (const other of [null, '', 'catalog', 'manage', 'item', 'item/', 'items/abc', 'myitem/abc']) {
      expect(parseItemSub(other)).toBeNull();
    }
  });
});

describe('routing: the address bar', () => {
  // parsePath's own steps for a pathname (App.jsx): segments, the view alias, then itemLinkSub.
  const parse = (pathname) => {
    const segs = pathname.split('/').filter(Boolean);
    const view = PATH_TO_VIEW[segs[0]] || segs[0];
    return { view, sub: itemLinkSub(view, segs) ?? segs[1] ?? null };
  };
  // App.jsx's address writer for a view + sub.
  const write = (view, sub) => `/${VIEW_TO_PATH[view] || view}${sub ? `/${sub}` : ''}`;

  it('opens /itemmanagement/item/<id> on the item', () => {
    expect(parse('/itemmanagement/item/7f3a-1')).toEqual({ view: 'inventory', sub: 'item/7f3a-1' });
  });

  it('keeps the old /inventory address working', () => {
    expect(parse('/inventory/item/7f3a-1')).toEqual({ view: 'inventory', sub: 'item/7f3a-1' });
  });

  it('writes the same path back, so a refresh or Back lands on the same item', () => {
    const { view, sub } = parse(itemPath('7f3a-1'));
    expect(write(view, sub)).toBe('/itemmanagement/item/7f3a-1');
    expect(parseItemSub(sub)).toBe('7f3a-1');
  });

  it('leaves every other Items address alone', () => {
    expect(parse('/itemmanagement/catalog')).toEqual({ view: 'inventory', sub: 'catalog' });
    expect(parse('/itemmanagement/item')).toEqual({ view: 'inventory', sub: 'item' });
    expect(itemLinkSub('tasks', ['tasks', 'item', 'x'])).toBeNull();
  });
});

describe('what a scanned code means', () => {
  it('a Nexus item link on this origin is the item', () => {
    expect(parseScannedCode(`${ORIGIN}/itemmanagement/item/7f3a-1`, ORIGIN)).toEqual({ kind: 'item', id: '7f3a-1' });
    expect(parseScannedCode(`${ORIGIN}/inventory/item/7f3a-1/`, ORIGIN)).toEqual({ kind: 'item', id: '7f3a-1' });
    expect(parseScannedCode(`${ORIGIN}/itemmanagement/item:7f3a-1?x=1`, ORIGIN)).toEqual({ kind: 'item', id: '7f3a-1' });
  });

  it('an item link printed on ANY host is the item (review M1: dev, a preview, prod)', () => {
    // Safe: only the id travels, through the walled GET /items/by-code; the
    // scanned URL is never opened.
    expect(parseScannedCode('https://dev.nexus.greensglobal.com/itemmanagement/item/7f3a-1')).toEqual({ kind: 'item', id: '7f3a-1' });
    expect(parseScannedCode('http://localhost:5173/inventory/item/7f3a-1')).toEqual({ kind: 'item', id: '7f3a-1' });
    expect(parseScannedCode('ftp://files.example/itemmanagement/item/7f3a-1').kind).toBe('foreign');
  });

  it('a page that is not an item link is foreign', () => {
    expect(parseScannedCode('https://evil.example/some/page').kind).toBe('foreign');
    expect(parseScannedCode(`${ORIGIN}/tasks/mine`, ORIGIN).kind).toBe('foreign');
    expect(parseScannedCode('http://[bad', ORIGIN).kind).toBe('foreign');
  });

  it('plain text is a code to look up (a serial, an old tag)', () => {
    expect(parseScannedCode('  GG-00042 ', ORIGIN)).toEqual({ kind: 'code', code: 'GG-00042' });
    expect(parseScannedCode('', ORIGIN)).toEqual({ kind: 'empty' });
    expect(parseScannedCode(null, ORIGIN)).toEqual({ kind: 'empty' });
  });
});
