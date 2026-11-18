// Nexus bridge (Neil, 11/02/2026): connects the PDF engine to the Nexus shell
// around it (frontend/src/views/PdfEditorModule.jsx).
//
// The engine knows nothing about Nexus; the shell cannot reach into the iframe.
// This file is the one place the two meet. It talks to the engine only through
// window.__pdfEngine and its pdf-engine:* window events, talks to the shell only
// through postMessage, and adds the Nexus buttons to the engine's own screen:
// Open From Egnyte / Documents on the landing page and the Open control, Save To
// Egnyte and Send For Signature in the Save menu. The buttons only ask; the
// shell draws the dialogs and makes the calls.
//
//   Shell to bridge:  nexus:pdf-config { canSign, canDocuments, canSaveEgnyte, saveBack }
//                     nexus:pdf-open { id, bytes: ArrayBuffer, name }
//                     nexus:pdf-build { id }
//                     nexus:pdf-mark-saved
//   Bridge to shell:  pdf-bridge:ready { engine }
//                     pdf-bridge:action { action }
//                     pdf-bridge:state { hasDoc, dirty, name, pages, redacted }
//                     pdf-bridge:did { action, name, pages }
//                     pdf-bridge:local-open { name, pages }
//                     pdf-bridge:reply { id, ok, bytes, name, pages, redacted, error }
//
// Both ends check the origin and the source on every message and send to the
// exact origin. Opened on its own, with no Nexus around it, this file does
// nothing at all.
(function () {
  'use strict';

  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;

  var ORIGIN = window.location.origin;
  var ENGINE_WAIT_MS = 5000;
  var MOUNT_TRIES = 50;
  var DID_ACTIONS = { download: 1, redact: 1, protect: 1, export: 1 };

  var ICONS = {
    egnyte: '<path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    documents: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  };

  var config = { canSign: false, canDocuments: false, canSaveEgnyte: false, saveBack: null };
  var lastName = '';
  // A file picked or dropped on this computer. The engine opens it, or asks
  // Replace or Merge first, so what it became is only known at the next state.
  var localPick = false;

  function post(msg, transfer) {
    try { parentWin.postMessage(msg, ORIGIN, transfer || []); } catch (_) { /* the shell is gone */ }
  }

  function engine() {
    return window.__pdfEngine || null;
  }

  function whenEngine() {
    return new Promise(function (resolve) {
      var waited = 0;
      (function tick() {
        var eng = engine();
        if (eng) { resolve(eng); return; }
        if (waited >= ENGINE_WAIT_MS) { resolve(null); return; }
        waited += 100;
        setTimeout(tick, 100);
      })();
    });
  }

  function engineInfo(eng) {
    try {
      var info = (eng || engine()).info() || {};
      return {
        hasDoc: !!info.hasDoc,
        name: String(info.name || ''),
        pages: Number(info.pages) || 0,
        redacted: !!info.redacted,
      };
    } catch (_) {
      return { hasDoc: false, name: '', pages: 0, redacted: false };
    }
  }

  function engineDirty(eng) {
    try { return !!(eng || engine()).isDirty(); } catch (_) { return false; }
  }

  function reply(id, body, transfer) {
    var msg = { type: 'pdf-bridge:reply', id: id };
    for (var key in body) msg[key] = body[key];
    post(msg, transfer);
  }

  function refuse(id, err) {
    reply(id, { ok: false, error: err && err.message ? String(err.message) : 'failed' });
  }

  // ── requests from the shell ───────────────────────────────────────────────

  function handleOpen(d) {
    localPick = false;
    if (Object.prototype.toString.call(d.bytes) !== '[object ArrayBuffer]') { refuse(d.id); return; }
    whenEngine().then(function (eng) {
      if (!eng || typeof eng.openBytes !== 'function') { reply(d.id, { ok: false, error: 'unavailable' }); return null; }
      return Promise.resolve(eng.openBytes(new Uint8Array(d.bytes), String(d.name || 'document.pdf'))).then(function () {
        var info = engineInfo(eng);
        lastName = info.name;
        reply(d.id, { ok: true, name: info.name, pages: info.pages, redacted: info.redacted });
      });
    }).catch(function (err) { refuse(d.id, err); });
  }

  function handleBuild(d) {
    whenEngine().then(function (eng) {
      if (!eng || typeof eng.buildOutput !== 'function') { reply(d.id, { ok: false, error: 'unavailable' }); return null; }
      return Promise.resolve(eng.buildOutput()).then(function (out) {
        var bytes = out && out.bytes;
        if (!bytes || !bytes.buffer) { refuse(d.id); return; }
        // A copy is what crosses: moving the engine's own buffer would leave it
        // detached, and the document is still open in the engine.
        var copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        var info = engineInfo(eng);
        reply(d.id, { ok: true, bytes: copy, name: String(out.name || info.name || 'document.pdf'),
          pages: info.pages, redacted: info.redacted }, [copy]);
      });
    }).catch(function (err) { refuse(d.id, err); });
  }

  function handleMarkSaved() {
    localPick = false;
    var eng = engine();
    if (!eng || typeof eng.markSaved !== 'function') return;
    try { eng.markSaved(); } catch (_) { /* the shell already moved on */ }
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || e.source !== parentWin) return;
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'nexus:pdf-config') {
      config = {
        canSign: !!d.canSign,
        canDocuments: !!d.canDocuments,
        canSaveEgnyte: !!d.canSaveEgnyte,
        saveBack: d.saveBack && d.saveBack.folder ? { folder: String(d.saveBack.folder), name: String(d.saveBack.name || '') } : null,
      };
      mountAll();
    } else if (d.type === 'nexus:pdf-open') {
      handleOpen(d);
    } else if (d.type === 'nexus:pdf-build') {
      handleBuild(d);
    } else if (d.type === 'nexus:pdf-mark-saved') {
      handleMarkSaved();
    }
  });

  // ── what the engine reports ───────────────────────────────────────────────

  function sendState(detail) {
    var d = detail || {};
    var eng = engine();
    var info = eng ? engineInfo(eng) : { hasDoc: false, name: '', pages: 0, redacted: false };
    var name = d.name != null ? String(d.name) : info.name;
    var hasDoc = d.hasDoc != null ? !!d.hasDoc : info.hasDoc;
    var dirty = d.dirty != null ? !!d.dirty : (eng ? engineDirty(eng) : false);
    var pages = d.pages != null ? (Number(d.pages) || 0) : info.pages;
    post({ type: 'pdf-bridge:state', hasDoc: hasDoc, dirty: dirty, name: name, pages: pages, redacted: info.redacted });
    // A new name tells the shell a different file came in. The same name, clean,
    // straight after a pick here is a replace it could not otherwise see; dirty
    // straight after a pick is a merge, and the file keeps its origin.
    if (localPick && hasDoc) {
      localPick = false;
      if (!dirty && name === lastName) post({ type: 'pdf-bridge:local-open', name: name, pages: pages });
    }
    lastName = hasDoc ? name : '';
  }

  window.addEventListener('pdf-engine:state', function (e) { sendState(e.detail); });

  window.addEventListener('pdf-engine:did', function (e) {
    var d = e.detail || {};
    if (!DID_ACTIONS[d.action]) return;
    post({ type: 'pdf-bridge:did', action: d.action, name: String(d.name || ''), pages: Number(d.pages) || 0 });
  });

  // ── buttons on the engine's screen ────────────────────────────────────────

  function ask(action) {
    post({ type: 'pdf-bridge:action', action: action });
  }

  function icon(key) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[key] + '</svg>';
  }

  function injectStyle() {
    if (document.getElementById('nxBridgeStyle')) return;
    var style = document.createElement('style');
    style.id = 'nxBridgeStyle';
    style.textContent =
      '.nx-open-from { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }' +
      '.nx-open-from button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 10px 14px;' +
      ' background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius);' +
      ' font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: border-color .12s, color .12s; }' +
      '.nx-open-from button:hover { border-color: var(--accent); color: var(--accent-text); }' +
      '.nx-open-from button:focus-visible, #nxOpenMenu .dropdown-item:focus-visible, #nxSaveGroup .dropdown-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }' +
      '#nxSaveGroup { max-width: 240px; }' +
      '#nxSaveGroup .dropdown-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }';
    (document.head || document.documentElement).appendChild(style);
  }

  function makeItem(text, action, onDone, title) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dropdown-item';
    btn.textContent = text;
    btn.setAttribute('data-nx-action', action);
    if (title) btn.title = title;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (onDone) onDone();
      ask(action);
    });
    return btn;
  }

  function mountLanding() {
    var left = document.querySelector('.welcome-left');
    if (!left) return false;
    // On a touch screen adobe-ui.js draws a row of tiles under Choose a File
    // (11/13/2026); Egnyte and Documents join it as short tiles there.
    var tiles = document.querySelector('.welcome-start-more');
    var box = document.getElementById('nxOpenFromNexus');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nxOpenFromNexus';
      box.className = 'nx-open-from';
      (tiles || left).appendChild(box);
    }
    box.textContent = '';
    var entries = [['Open From Egnyte', 'open-egnyte', 'egnyte', 'Egnyte']];
    if (config.canDocuments) entries.push(['Open From Documents', 'open-documents', 'documents', 'Documents']);
    entries.forEach(function (entry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = icon(entry[2]);
      btn.appendChild(document.createTextNode(tiles ? entry[3] : entry[0]));
      if (tiles) btn.setAttribute('aria-label', entry[0]);
      btn.setAttribute('data-nx-action', entry[1]);
      btn.addEventListener('click', function (e) { e.stopPropagation(); ask(entry[1]); });
      box.appendChild(btn);
    });
    return true;
  }

  function closeOpenMenu(refocus) {
    var menu = document.getElementById('nxOpenMenu');
    if (!menu || !menu.classList.contains('open')) return;
    menu.classList.remove('open');
    if (refocus) {
      var btn = document.getElementById('openFileBtn');
      if (btn) btn.focus();
    }
  }

  function buildOpenMenu() {
    var menu = document.getElementById('nxOpenMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'nxOpenMenu';
      menu.className = 'dropdown-menu';
      document.body.appendChild(menu);
    }
    menu.textContent = '';
    var local = document.createElement('button');
    local.type = 'button';
    local.className = 'dropdown-item';
    local.textContent = 'From This Computer';
    local.addEventListener('click', function (e) {
      e.stopPropagation();
      closeOpenMenu();
      var input = document.getElementById('fileInput');
      if (input) input.click();
    });
    menu.appendChild(local);
    menu.appendChild(makeItem('From Egnyte', 'open-egnyte', closeOpenMenu));
    if (config.canDocuments) menu.appendChild(makeItem('From Documents', 'open-documents', closeOpenMenu));
    return menu;
  }

  // The engine's Save menu is built by adobe-ui.js. Ours is one group at its top
  // that this file rebuilds when the shell's config changes.
  function mountSaveMenu() {
    var menu = document.getElementById('saveMenu');
    if (!menu) return false;
    var group = document.getElementById('nxSaveGroup');
    if (!group) {
      group = document.createElement('div');
      group.id = 'nxSaveGroup';
      menu.insertBefore(group, menu.firstChild);
    }
    group.textContent = '';
    var done = function () { menu.classList.remove('open'); };
    if (config.canSaveEgnyte && config.saveBack) {
      var parts = config.saveBack.folder.split('/').filter(Boolean);
      var folder = parts.length ? parts[parts.length - 1] : 'Egnyte';
      group.appendChild(makeItem('Save Back To ' + folder, 'save-back', done, config.saveBack.folder));
    }
    if (config.canSaveEgnyte) group.appendChild(makeItem('Save To Egnyte...', 'save-egnyte', done));
    if (config.canSign) group.appendChild(makeItem('Send For Signature...', 'send-sign', done));
    if (group.childNodes.length) {
      var rule = document.createElement('div');
      rule.className = 'dropdown-divider';
      group.appendChild(rule);
      var label = document.createElement('div');
      label.className = 'dropdown-group-label';
      label.textContent = 'Download';
      group.appendChild(label);
    }
    return true;
  }

  function mountAll() {
    injectStyle();
    var landing = mountLanding();
    var save = mountSaveMenu();
    return landing && save;
  }

  // The engine builds these on its own schedule: try until both are there.
  function mountWhenReady() {
    var tries = 0;
    (function tick() {
      if (mountAll() || ++tries >= MOUNT_TRIES) return;
      setTimeout(tick, 200);
    })();
  }

  // Beat app.js's own listener on the Open control, as adobe-ui.js does for Save.
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest || !target.closest('#openFileBtn')) return;
    e.stopPropagation();
    var menu = document.getElementById('nxOpenMenu');
    if (menu && menu.classList.contains('open')) { closeOpenMenu(); return; }
    menu = buildOpenMenu();
    var saveMenu = document.getElementById('saveMenu');
    if (saveMenu) saveMenu.classList.remove('open');
    var r = target.closest('#openFileBtn').getBoundingClientRect();
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.left = Math.max(8, r.left) + 'px';
    menu.style.minWidth = '200px';
    menu.classList.add('open');
    if (menu.firstChild) menu.firstChild.focus();
  }, true);

  document.addEventListener('click', function (e) {
    var menu = document.getElementById('nxOpenMenu');
    if (menu && !menu.contains(e.target)) closeOpenMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeOpenMenu(true);
  });

  // Where a file came from matters to Save: note a pick or a drop from here.
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fileInput') localPick = true;
  }, true);
  document.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) localPick = true;
  }, true);

  // ── start ─────────────────────────────────────────────────────────────────

  mountWhenReady();
  var ready = engine();
  post({ type: 'pdf-bridge:ready', engine: !!ready });
  if (ready) sendState();
})();
