import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHARE_CACHE, SHARE_META, SHARE_MAX_AGE_MS, SHARE_ACTIONS, readShare, clearShare, sweepShare, shareWords, shareSeed, carryLine, carriesFiles } from './shareTarget';
import { ACTIONS } from './quickCreate';
import { onRequest } from '../../functions/share-target.js';

// Share to Nexus, the app's side: reading back what public/sw.js kept,
// clearing it, and what each of the three forms is seeded with.
const sw = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../public/manifest.webmanifest'), 'utf8'));

function fakeCaches() {
  const store = new Map();
  const entry = (body, type = '') => ({ json: async () => JSON.parse(body), blob: async () => new Blob([body], { type }) });
  return {
    store,
    has: async (n) => store.has(n),
    delete: async (n) => store.delete(n),
    open: async (n) => {
      if (!store.has(n)) store.set(n, new Map());
      const m = store.get(n);
      return { match: async (k) => m.get(k), put: async (k, body, type) => { m.set(k, entry(body, type)); } };
    },
  };
}
async function stash(cs, meta, files = {}) {
  const c = await cs.open(SHARE_CACHE);
  await c.put(SHARE_META, JSON.stringify(meta));
  for (const [k, [body, type]] of Object.entries(files)) await c.put(k, body, type);
}
const NOW = 1_800_000_000_000;

describe('shareTarget - the stash', () => {
  let cs;
  beforeEach(() => { cs = fakeCaches(); globalThis.caches = cs; });
  afterEach(() => { delete globalThis.caches; });

  it('uses the same cache and key names the worker writes with', () => {
    expect(sw).toContain(`const SHARE_CACHE = '${SHARE_CACHE}';`);
    expect(sw).toContain(`const SHARE_META = '${SHARE_META}';`);
    expect(SHARE_CACHE.startsWith('nexus-shell-')).toBe(false);   // activate never removes it as an old shell
  });

  it('reads the words and the files back as File objects', async () => {
    await stash(cs, {
      at: NOW - 5000, title: ' Gate ', text: 'Keypad is dead', url: '', skipped: 0,
      files: [{ key: '/__nexus-share/file/0', name: 'gate.jpg', type: 'image/jpeg', size: 4, lastModified: 1700000000000 }],
    }, { '/__nexus-share/file/0': ['JPEG', 'image/jpeg'] });
    const shared = await readShare(NOW);
    expect(shared).toMatchObject({ title: 'Gate', text: 'Keypad is dead', url: '', skipped: 0 });
    expect(shared.files).toHaveLength(1);
    expect(shared.files[0]).toBeInstanceOf(File);
    expect(shared.files[0]).toMatchObject({ name: 'gate.jpg', type: 'image/jpeg', size: 4, lastModified: 1700000000000 });
  });

  it('a file whose bytes are gone is counted, not invented', async () => {
    await stash(cs, { at: NOW, title: '', text: 'x', url: '', skipped: 1, files: [{ key: '/__nexus-share/file/0', name: 'a.pdf', type: 'application/pdf', size: 9 }] });
    const shared = await readShare(NOW);
    expect(shared.files).toEqual([]);
    expect(shared.skipped).toBe(2);
  });

  it('nothing shared, an empty share, or no Cache Storage here reads as null', async () => {
    expect(await readShare(NOW)).toBeNull();
    await stash(cs, { at: NOW, title: '', text: '  ', url: '', files: [], skipped: 0 });
    expect(await readShare(NOW)).toBeNull();
    delete globalThis.caches;
    expect(await readShare(NOW)).toBeNull();
    await expect(clearShare()).resolves.toBeUndefined();
    await expect(sweepShare(NOW)).resolves.toBeUndefined();
  });

  it('a share older than a day is removed and never shown', async () => {
    await stash(cs, { at: NOW - SHARE_MAX_AGE_MS - 1, title: '', text: 'old', url: '', files: [] });
    expect(await readShare(NOW)).toBeNull();
    expect(cs.store.has(SHARE_CACHE)).toBe(false);
  });

  it('sweepShare removes only a share past its day (or one it cannot read)', async () => {
    await stash(cs, { at: NOW - 1000, title: '', text: 'fresh', url: '', files: [] });
    await sweepShare(NOW);
    expect(cs.store.has(SHARE_CACHE)).toBe(true);
    await sweepShare(NOW + SHARE_MAX_AGE_MS);
    expect(cs.store.has(SHARE_CACHE)).toBe(false);
    await (await cs.open(SHARE_CACHE)).put('/other', '{}');   // a cache with no meta: an interrupted share
    await sweepShare(NOW);
    expect(cs.store.has(SHARE_CACHE)).toBe(false);
  });

  it('clearShare removes it (used, dismissed, signed out)', async () => {
    await stash(cs, { at: NOW, title: '', text: 'x', url: '', files: [] });
    await clearShare();
    expect(cs.store.has(SHARE_CACHE)).toBe(false);
    expect(await readShare(NOW)).toBeNull();
  });
});

describe('shareTarget - what each form starts with', () => {
  const photo = new File(['x'], 'gate.jpg', { type: 'image/jpeg' });
  const link = { title: 'Gate Keypad Manual', text: 'Worth a read', url: 'https://example.com/manual', files: [] };

  it('the subject is the shared title, else the first line of the text; the link rides on its own line once', () => {
    expect(shareWords(link)).toEqual({ subject: 'Gate Keypad Manual', body: 'Worth a read\nhttps://example.com/manual' });
    expect(shareWords({ text: '\nFirst line\nSecond', url: '' })).toEqual({ subject: 'First line', body: '\nFirst line\nSecond' });
    // Android puts the link in the text: it is not said twice.
    expect(shareWords({ text: 'Look https://example.com/a', url: 'https://example.com/a' }).body).toBe('Look https://example.com/a');
    expect(shareWords({ files: [photo] })).toEqual({ subject: '', body: '' });   // a photo alone: the form asks for a title
    expect(shareWords({ text: 'word '.repeat(60) }).subject.length).toBeLessThanOrEqual(120);
    expect(shareWords(null)).toEqual({ subject: '', body: '' });
  });

  it('a ticket and a task carry the words and the files; a note carries the words only', () => {
    const shared = { ...link, files: [photo] };
    expect(shareSeed('ticket', shared)).toEqual({ subject: 'Gate Keypad Manual', description: 'Worth a read\nhttps://example.com/manual', files: [photo] });
    expect(shareSeed('task', shared)).toEqual({ title: 'Gate Keypad Manual', description: '<p>Worth a read</p><p>https://example.com/manual</p>', files: [photo] });
    expect(shareSeed('note', shared)).toEqual({ html: '<p>Gate Keypad Manual</p><p>Worth a read</p><p>https://example.com/manual</p>' });
    expect(Object.keys(shareSeed('note', shared))).toEqual(['html']);
    expect(carriesFiles('ticket') && carriesFiles('task')).toBe(true);
    expect(carriesFiles('note')).toBe(false);
  });

  it('shared text is escaped, never markup', () => {
    const shared = { title: '', text: '<img src=x onerror=alert(1)>', url: '', files: [] };
    expect(shareSeed('task', shared).description).toBe('');   // one line: it is the title, not said twice
    expect(shareSeed('task', { ...shared, text: 'A\n<b>B</b>' }).description).toBe('<p>A</p><p>&lt;b&gt;B&lt;/b&gt;</p>');
    expect(shareSeed('note', shared).html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(shareSeed('ticket', shared).description).toBe('<img src=x onerror=alert(1)>');   // plain text: the form escapes it (seedHtml)
  });

  it('a photo alone starts a ticket or a task with the file, and gives a note nothing', () => {
    const shared = { title: '', text: '', url: '', files: [photo] };
    expect(shareSeed('ticket', shared)).toEqual({ subject: '', description: '', files: [photo] });
    expect(shareSeed('task', shared)).toEqual({ title: '', description: '', files: [photo] });
    expect(shareSeed('note', shared)).toBeNull();
    expect(shareSeed('ticket', null)).toBeNull();
    expect(shareSeed('board', shared)).toBeNull();
  });

  it('says plainly what goes along, and when a file cannot', () => {
    const both = { ...link, files: [photo, photo] };
    expect(carryLine('ticket', both)).toBe('Starts with the text filled in and 2 files attached.');
    expect(carryLine('task', { files: [photo] })).toBe('Starts with 1 file attached.');
    expect(carryLine('task', link)).toBe('Starts with the text filled in.');
    expect(carryLine('ticket', null)).toBe('Starts a blank one.');
    expect(carryLine('note', both)).toBe('Takes the text only. Open the note and add the file from your phone.');
    expect(carryLine('note', { files: [photo] })).toBe('A note cannot take the file from here. Open the note and add it from your phone.');
    expect(carryLine('note', link)).toBe("Adds the text to today's Quick Note.");
  });

  it('offers only Quick Actions the bolt has', () => {
    expect(SHARE_ACTIONS).toEqual(['ticket', 'task', 'note']);
    SHARE_ACTIONS.forEach((key) => expect(ACTIONS.some((it) => it.key === key), key).toBe(true));
  });
});

describe('public/manifest.webmanifest - the installed app', () => {
  it('has the four shortcuts on addresses the app routes', () => {
    expect(manifest.shortcuts.map((s) => [s.name, s.url])).toEqual([
      ['New Task', '/?do=new-task'],
      ['New Ticket', '/?do=new-ticket'],
      ['Time Clock', '/workday/overview'],
      ['Approvals', '/dashboard/approvals'],
    ]);
    manifest.shortcuts.forEach((s) => {
      expect(s.url.startsWith(manifest.scope)).toBe(true);
      s.icons.forEach((i) => expect(() => readFileSync(resolve(__dirname, '../../public', `.${i.src}`))).not.toThrow());
    });
  });

  it('sends a share to the one path the worker answers, as a multipart POST with files', () => {
    const t = manifest.share_target;
    expect(t).toMatchObject({ action: '/share-target', method: 'POST', enctype: 'multipart/form-data' });
    expect(sw).toContain(`const SHARE_PATH = '${t.action}';`);
    expect(t.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
    expect(t.params.files).toHaveLength(1);
    expect(t.params.files[0].name).toBe('files');                       // the field the worker reads
    expect(sw).toContain("form.getAll('files')");
    expect(t.params.files[0].accept).toEqual(expect.arrayContaining(['image/*', 'application/pdf', '.docx', '.xlsx']));
  });
});

describe('functions/share-target.js - no worker in front (the kill switch)', () => {
  const call = (method, url = 'https://nexus.test/share-target?x=1') => onRequest({ request: { url, method } });

  it('sends a share home with a 303 and never reads the body', () => {
    const res = call('POST');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://nexus.test/?share=1');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('anything else typed at the address just goes home', () => {
    expect(call('GET').headers.get('Location')).toBe('https://nexus.test/');
  });
});
