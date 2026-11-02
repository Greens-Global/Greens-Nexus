import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The bridge is a plain script in public/, so it is read as text and run against
// a stand-in window and a document of its own: a stub window.__pdfEngine, a fake
// parent that records what it is sent. The real engine is never loaded here.
const src = readFileSync(resolve(process.cwd(), 'public/pdf-editor-app/nexus-bridge.js'), 'utf8');
const ORIGIN = 'https://nexus.example';

function stubEngine(over = {}) {
  return {
    openBytes: vi.fn(() => Promise.resolve()),
    buildOutput: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), name: 'Out.pdf' })),
    isDirty: vi.fn(() => false),
    markSaved: vi.fn(),
    info: vi.fn(() => ({ hasDoc: true, name: 'Lease.pdf', pages: 4, redacted: false })),
    ...over,
  };
}

function engineDom(doc) {
  doc.body.innerHTML = `
    <button id="openFileBtn"></button>
    <input type="file" id="fileInput">
    <div class="welcome-left"><button class="welcome-drop"></button></div>
    <div id="saveMenu" class="dropdown-menu"><button class="dropdown-item">PDF</button></div>`;
}

function boot({ engine, standalone = false, withDom = true, listen } = {}) {
  const doc = document.implementation.createHTMLDocument('engine');
  if (withDom) engineDom(doc);
  const win = new EventTarget();
  const parentWin = { postMessage: vi.fn() };
  win.parent = standalone ? win : parentWin;
  win.location = { origin: ORIGIN };
  if (engine) win.__pdfEngine = engine;
  if (listen) win.addEventListener = listen;
  new Function('window', 'document', src)(win, doc);
  const sent = (type) => parentWin.postMessage.mock.calls.map(c => c[0]).filter(m => m.type === type);
  const send = (data, { origin = ORIGIN, source = parentWin } = {}) => {
    const e = new Event('message');
    e.data = data;
    e.origin = origin;
    e.source = source;
    win.dispatchEvent(e);
  };
  const fire = (type, detail) => {
    const e = new Event(type);
    e.detail = detail;
    win.dispatchEvent(e);
  };
  return { doc, win, parentWin, sent, send, fire };
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); });

describe('running with no Nexus around it', () => {
  it('does nothing at all', () => {
    const listen = vi.fn();
    const { doc } = boot({ standalone: true, listen });
    expect(doc.getElementById('nxOpenFromNexus')).toBeNull();
    expect(doc.getElementById('nxSaveGroup')).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe('messages', () => {
  it('says it is ready, to the exact origin, and whether the engine is there', () => {
    const { parentWin, sent } = boot({ engine: stubEngine() });
    expect(sent('pdf-bridge:ready')[0].engine).toBe(true);
    parentWin.postMessage.mock.calls.forEach(c => expect(c[1]).toBe(ORIGIN));
  });

  it('ignores a message from another origin', async () => {
    const engine = stubEngine();
    const { send } = boot({ engine });
    send({ type: 'nexus:pdf-mark-saved' }, { origin: 'https://evil.example' });
    send({ type: 'nexus:pdf-open', id: 1, bytes: new ArrayBuffer(1), name: 'x.pdf' }, { origin: 'https://evil.example' });
    await flush();
    expect(engine.markSaved).not.toHaveBeenCalled();
    expect(engine.openBytes).not.toHaveBeenCalled();
  });

  it('ignores a same-origin message that is not from the parent', () => {
    const engine = stubEngine();
    const { send } = boot({ engine });
    send({ type: 'nexus:pdf-mark-saved' }, { source: { postMessage() {} } });
    expect(engine.markSaved).not.toHaveBeenCalled();
  });

  it('ignores a message with no type', () => {
    const { send, parentWin } = boot({ engine: stubEngine() });
    const before = parentWin.postMessage.mock.calls.length;
    send(null);
    send('text');
    send({ id: 3 });
    expect(parentWin.postMessage.mock.calls.length).toBe(before);
  });

  it('opens bytes in the engine and answers with what it became', async () => {
    const engine = stubEngine();
    const { send, sent } = boot({ engine });
    const bytes = new Uint8Array([9, 8]).buffer;
    send({ type: 'nexus:pdf-open', id: 7, bytes, name: 'Lease.pdf' });
    await flush();
    const [arg, name] = engine.openBytes.mock.calls[0];
    expect(arg).toBeInstanceOf(Uint8Array);
    expect([...arg]).toEqual([9, 8]);
    expect(name).toBe('Lease.pdf');
    expect(sent('pdf-bridge:reply')[0]).toMatchObject({ id: 7, ok: true, name: 'Lease.pdf', pages: 4 });
  });

  it('answers no when the engine cannot open it', async () => {
    const engine = stubEngine({ openBytes: vi.fn(() => Promise.reject(new Error('bad pdf'))) });
    const { send, sent } = boot({ engine });
    send({ type: 'nexus:pdf-open', id: 8, bytes: new ArrayBuffer(1), name: 'x.pdf' });
    await flush();
    expect(sent('pdf-bridge:reply')[0]).toMatchObject({ id: 8, ok: false });
  });

  it('refuses an open whose bytes are not an ArrayBuffer', async () => {
    const engine = stubEngine();
    const { send, sent } = boot({ engine });
    send({ type: 'nexus:pdf-open', id: 9, bytes: 'not bytes', name: 'x.pdf' });
    await flush();
    expect(engine.openBytes).not.toHaveBeenCalled();
    expect(sent('pdf-bridge:reply')[0]).toMatchObject({ id: 9, ok: false });
  });

  it('sends a transferred copy of the output, leaving the engine its own buffer', async () => {
    const own = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4);
    const engine = stubEngine({ buildOutput: vi.fn(() => Promise.resolve({ bytes: own, name: 'Out.pdf' })) });
    const { send, parentWin } = boot({ engine });
    send({ type: 'nexus:pdf-build', id: 11 });
    await flush();
    const call = parentWin.postMessage.mock.calls.find(c => c[0].type === 'pdf-bridge:reply');
    const [msg, origin, transfer] = call;
    expect(origin).toBe(ORIGIN);
    expect(msg).toMatchObject({ id: 11, ok: true, name: 'Out.pdf', pages: 4 });
    expect([...new Uint8Array(msg.bytes)]).toEqual([1, 2, 3]);
    expect(transfer).toEqual([msg.bytes]);
    expect(msg.bytes).not.toBe(own.buffer);
  });

  it('answers no when the save pipeline fails', async () => {
    const engine = stubEngine({ buildOutput: vi.fn(() => Promise.reject(new Error('nope'))) });
    const { send, sent } = boot({ engine });
    send({ type: 'nexus:pdf-build', id: 12 });
    await flush();
    expect(sent('pdf-bridge:reply')[0]).toMatchObject({ id: 12, ok: false });
  });

  it('tells the engine a save happened', () => {
    const engine = stubEngine();
    const { send } = boot({ engine });
    send({ type: 'nexus:pdf-mark-saved' });
    expect(engine.markSaved).toHaveBeenCalledTimes(1);
  });

  it('tolerates the engine being absent', async () => {
    vi.useFakeTimers();
    const { send, sent, parentWin } = boot({});
    expect(sent('pdf-bridge:ready')[0].engine).toBe(false);
    send({ type: 'nexus:pdf-mark-saved' });
    send({ type: 'nexus:pdf-open', id: 13, bytes: new ArrayBuffer(1), name: 'x.pdf' });
    send({ type: 'nexus:pdf-build', id: 14 });
    await vi.advanceTimersByTimeAsync(6000);
    const replies = sent('pdf-bridge:reply');
    expect(replies.map(r => r.id).sort()).toEqual([13, 14]);
    replies.forEach(r => expect(r).toMatchObject({ ok: false, error: 'unavailable' }));
    parentWin.postMessage.mock.calls.forEach(c => expect(c[1]).toBe(ORIGIN));
  });

  it('waits for an engine that arrives a moment late', async () => {
    vi.useFakeTimers();
    const { win, send, sent } = boot({});
    send({ type: 'nexus:pdf-open', id: 15, bytes: new ArrayBuffer(1), name: 'x.pdf' });
    const engine = stubEngine();
    win.__pdfEngine = engine;
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.openBytes).toHaveBeenCalledTimes(1);
    expect(sent('pdf-bridge:reply')[0]).toMatchObject({ id: 15, ok: true });
  });
});

describe('what the engine reports', () => {
  it('passes state on with the redaction flag', () => {
    const engine = stubEngine({ info: () => ({ hasDoc: true, name: 'A.pdf', pages: 2, redacted: true }) });
    const { fire, sent } = boot({ engine });
    fire('pdf-engine:state', { hasDoc: true, dirty: true, name: 'A.pdf', pages: 2 });
    const last = sent('pdf-bridge:state').at(-1);
    expect(last).toMatchObject({ hasDoc: true, dirty: true, name: 'A.pdf', pages: 2, redacted: true });
  });

  it('passes only the listed actions on', () => {
    const { fire, sent } = boot({ engine: stubEngine() });
    ['download', 'redact', 'protect', 'export'].forEach(action => fire('pdf-engine:did', { action, name: 'A.pdf', pages: 2 }));
    fire('pdf-engine:did', { action: 'delete', name: 'A.pdf' });
    fire('pdf-engine:did', {});
    expect(sent('pdf-bridge:did').map(m => m.action)).toEqual(['download', 'redact', 'protect', 'export']);
  });

  it('reports a same-name replace from this computer', () => {
    const { doc, fire, sent } = boot({ engine: stubEngine() });
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'A.pdf', pages: 2 });
    doc.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }));
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'A.pdf', pages: 3 });
    expect(sent('pdf-bridge:local-open')).toEqual([{ type: 'pdf-bridge:local-open', name: 'A.pdf', pages: 3 }]);
  });

  it('does not call a merge a new file', () => {
    const { doc, fire, sent } = boot({ engine: stubEngine() });
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'A.pdf', pages: 2 });
    doc.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }));
    fire('pdf-engine:state', { hasDoc: true, dirty: true, name: 'A.pdf', pages: 5 });
    expect(sent('pdf-bridge:local-open')).toEqual([]);
  });

  it('leaves a new name to the state message', () => {
    const { doc, fire, sent } = boot({ engine: stubEngine() });
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'A.pdf', pages: 2 });
    doc.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }));
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'B.pdf', pages: 2 });
    expect(sent('pdf-bridge:local-open')).toEqual([]);
  });

  it('does not take a save after a cancelled pick for a new file', () => {
    const { doc, fire, send, sent } = boot({ engine: stubEngine() });
    fire('pdf-engine:state', { hasDoc: true, dirty: true, name: 'A.pdf', pages: 2 });
    doc.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }));
    send({ type: 'nexus:pdf-mark-saved' });
    fire('pdf-engine:state', { hasDoc: true, dirty: false, name: 'A.pdf', pages: 2 });
    expect(sent('pdf-bridge:local-open')).toEqual([]);
  });
});

describe('the buttons it adds', () => {
  const actions = (root) => [...root.querySelectorAll('[data-nx-action]')].map(b => b.getAttribute('data-nx-action'));

  it('puts Open From Egnyte on the landing page, and Documents only for those who have it', () => {
    const { doc, send } = boot({ engine: stubEngine() });
    expect(actions(doc.getElementById('nxOpenFromNexus'))).toEqual(['open-egnyte']);
    send({ type: 'nexus:pdf-config', canDocuments: true });
    expect(actions(doc.getElementById('nxOpenFromNexus'))).toEqual(['open-egnyte', 'open-documents']);
    expect(doc.querySelector('[data-nx-action="open-egnyte"]').textContent).toBe('Open From Egnyte');
    expect(doc.querySelector('[data-nx-action="open-documents"]').textContent).toBe('Open From Documents');
  });

  it('asks the shell when a landing button is clicked', () => {
    const { doc, sent } = boot({ engine: stubEngine() });
    doc.querySelector('[data-nx-action="open-egnyte"]').click();
    expect(sent('pdf-bridge:action')).toEqual([{ type: 'pdf-bridge:action', action: 'open-egnyte' }]);
  });

  it('adds nothing to the Save menu for someone who can do none of it', () => {
    const { doc } = boot({ engine: stubEngine() });
    expect(doc.getElementById('nxSaveGroup').childNodes.length).toBe(0);
  });

  it('adds the Save items the shell allows, at the top of the menu, once', () => {
    const { doc, send } = boot({ engine: stubEngine() });
    const config = { type: 'nexus:pdf-config', canSign: true, canSaveEgnyte: true, saveBack: { folder: '/Shared/Leases/2026', name: 'A.pdf' } };
    send(config);
    send(config);
    const menu = doc.getElementById('saveMenu');
    expect(menu.querySelectorAll('#nxSaveGroup').length).toBe(1);
    expect(menu.firstChild.id).toBe('nxSaveGroup');
    expect(actions(menu)).toEqual(['save-back', 'save-egnyte', 'send-sign']);
    const back = menu.querySelector('[data-nx-action="save-back"]');
    expect(back.textContent).toBe('Save Back To 2026');
    expect(back.title).toBe('/Shared/Leases/2026');
    expect(menu.querySelector('.dropdown-group-label').textContent).toBe('Download');
  });

  it('drops Save Back when the file no longer has a place to go back to', () => {
    const { doc, send } = boot({ engine: stubEngine() });
    send({ type: 'nexus:pdf-config', canSaveEgnyte: true, saveBack: { folder: '/Shared', name: 'A.pdf' } });
    send({ type: 'nexus:pdf-config', canSaveEgnyte: true, saveBack: null });
    expect(actions(doc.getElementById('saveMenu'))).toEqual(['save-egnyte']);
  });

  it('hides the Egnyte saves from someone who cannot upload', () => {
    const { doc, send } = boot({ engine: stubEngine() });
    send({ type: 'nexus:pdf-config', canSign: true, canSaveEgnyte: false, saveBack: { folder: '/Shared', name: 'A.pdf' } });
    expect(actions(doc.getElementById('saveMenu'))).toEqual(['send-sign']);
  });

  it('closes the Save menu and asks the shell', () => {
    const { doc, send, sent } = boot({ engine: stubEngine() });
    send({ type: 'nexus:pdf-config', canSign: true });
    const menu = doc.getElementById('saveMenu');
    menu.classList.add('open');
    menu.querySelector('[data-nx-action="send-sign"]').click();
    expect(menu.classList.contains('open')).toBe(false);
    expect(sent('pdf-bridge:action').at(-1).action).toBe('send-sign');
  });

  it('turns the Open control into a menu without firing the engine\'s own listener', () => {
    const { doc, send } = boot({ engine: stubEngine() });
    send({ type: 'nexus:pdf-config', canDocuments: true });
    const own = vi.fn();
    const btn = doc.getElementById('openFileBtn');
    btn.addEventListener('click', own);
    btn.click();
    expect(own).not.toHaveBeenCalled();
    const menu = doc.getElementById('nxOpenMenu');
    expect(menu.classList.contains('open')).toBe(true);
    expect([...menu.querySelectorAll('button')].map(b => b.textContent))
      .toEqual(['From This Computer', 'From Egnyte', 'From Documents']);
  });

  it('From This Computer still uses the engine\'s own file picker', () => {
    const { doc } = boot({ engine: stubEngine() });
    const pick = vi.fn();
    const input = doc.getElementById('fileInput');
    input.click = pick;
    doc.getElementById('openFileBtn').click();
    doc.getElementById('nxOpenMenu').querySelector('button').click();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(doc.getElementById('nxOpenMenu').classList.contains('open')).toBe(false);
  });

  it('closes the Open menu on Escape and on a click outside', () => {
    const { doc } = boot({ engine: stubEngine() });
    const btn = doc.getElementById('openFileBtn');
    btn.click();
    const menu = doc.getElementById('nxOpenMenu');
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.classList.contains('open')).toBe(false);
    btn.click();
    expect(menu.classList.contains('open')).toBe(true);
    doc.querySelector('.welcome-drop').click();
    expect(menu.classList.contains('open')).toBe(false);
  });

  it('mounts on a screen the engine builds later', () => {
    vi.useFakeTimers();
    const { doc } = boot({ engine: stubEngine(), withDom: false });
    expect(doc.getElementById('nxOpenFromNexus')).toBeNull();
    engineDom(doc);
    vi.advanceTimersByTime(400);
    expect(doc.getElementById('nxOpenFromNexus')).not.toBeNull();
    expect(doc.getElementById('nxSaveGroup')).not.toBeNull();
  });
});
