// ── Adobe Acrobat-style UI layer ───────────────────────────────────────────────
// Runs AFTER app.js. It does not change any behavior: every existing button
// keeps its id and event listeners (moving a DOM node preserves them). It only
// REORGANIZES the chrome the way Acrobat does:
//   • a slim top bar (Open / Download / undo–redo / select / search / theme)
//   • a right-hand TOOLS panel (Edit PDF, Comment, Organize Pages, …)
//   • picking a tool opens a contextual toolbar with just that tool's buttons
(function () {
  const $ = (sel) => document.querySelector(sel);

  const header = $('.toolbar');
  const mainContainer = $('.main-container');
  const pageWrapper = $('#pageWrapper');
  if (!header || !mainContainer) return;

  // Running inside the Nexus portal (iframe) vs the standalone desktop app.
  // In the portal, the surrounding Nexus chrome already provides branding +
  // theme, so we drop those from our own top bar; the desktop app keeps them.
  const IN_PORTAL = (function () { try { return window.self !== window.top; } catch (_) { return true; } })();

  // Drop the "PDF Editor" title text. On macOS the window uses hiddenInset
  // traffic lights that overlay the top-left, so leave a spacer in its place.
  const title = $('.app-title');
  if (title) {
    if (/Mac/i.test(navigator.platform)) {
      const sp = document.createElement('span');
      sp.style.cssText = 'width:64px;flex-shrink:0;-webkit-app-region:drag;';
      title.replaceWith(sp);
    } else title.remove();
  }

  // ── Contextual toolbar (hidden until a tool group is opened) ───────────────
  const ctxBar = document.createElement('div');
  ctxBar.id = 'adobeCtxBar';
  ctxBar.className = 'adobe-ctx-bar';
  ctxBar.style.display = 'none';
  pageWrapper.insertBefore(ctxBar, pageWrapper.firstChild);

  const ctxTitle = document.createElement('span');
  ctxTitle.className = 'adobe-ctx-title';
  ctxBar.appendChild(ctxTitle);

  const groupHost = document.createElement('div');
  groupHost.className = 'adobe-ctx-groups';
  ctxBar.appendChild(groupHost);

  const ctxHistory = document.createElement('div');
  ctxHistory.className = 'adobe-ctx-history';
  ctxBar.appendChild(ctxHistory); // anchor for the docked page pill


  // ── Tool groups: which EXISTING elements belong to each Acrobat tool ────────
  // Elements are moved (not cloned) so app.js listeners stay attached.
  const el = (sel) => document.querySelector(sel);
  const wrapOf = (sel) => { const b = el(sel); return b ? b.closest('.dropdown-wrap') || b : null; };

  // ── Shape picker: clicking Shape shows a menu of shape types ────────────────
  // app.js exposes window.setShapeKind; the tool itself stays #shapeTool.
  const shapeBtn = el('#shapeTool');
  if (shapeBtn) {
    // Rebrand the button: "Shapes" with a multi-shape icon (square+circle+triangle).
    const label = shapeBtn.querySelector('span');
    if (label) label.textContent = 'Shapes';
    shapeBtn.title = 'Shapes';
    const oldSvg = shapeBtn.querySelector('svg');
    if (oldSvg) oldSvg.outerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.id = 'shapeMenu';
    const KINDS = [
      ['rect', '▭ Rectangle'], ['square', '□ Square'], ['circle', '◯ Circle / Ellipse'], ['triangle', '△ Triangle'],
      ['line', '― Line'], ['polyline', '⌇ Polyline (multi-segment)'], ['polygon', '⬠ Polygon (multi-point)'],
      ['arrow', '→ Arrow'], ['arrow2', '↔ Double arrow'],
      ['cloud', '☁ Cloud (revision)'], ['callout', '💬 Text callout (arrow + note)'],
      ['ellipsecallout', '🗨 Speech bubble'],
      ['count', '① Count (click to tally items)'],
      ['redact', '⬛ Redact (removes content permanently)'],
    ];
    for (const [kind, text] of KINDS) {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.textContent = text;
      it.dataset.kind = kind;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        window.setShapeKind && window.setShapeKind(kind);
        // Tick the chosen shape in the menu so the active kind stays visible.
        menu.querySelectorAll('.dropdown-item').forEach(x =>
          x.textContent = (x.dataset.kind === kind ? '✓ ' : '') + x.textContent.replace(/^✓ /, ''));
        menu.classList.remove('open');
        // Make sure the shape tool is armed (no-op if it already is).
        if (!shapeBtn.classList.contains('active')) shapeBtn.click();
        menu.classList.remove('open'); // shapeBtn.click() reopens it — close again
      });
      menu.appendChild(it);
    }
    menu.firstChild.textContent = '✓ ' + menu.firstChild.textContent; // rect is the default

    // Line style: solid / dashed / dotted (applies to the next drawn shape)
    const styleDiv = document.createElement('div');
    styleDiv.className = 'dropdown-group-label';
    styleDiv.textContent = 'Line style';
    menu.appendChild(styleDiv);
    const styleRow = document.createElement('div');
    styleRow.style.cssText = 'display:flex;gap:4px;padding:4px 12px 8px;';
    for (const [sv, sl] of [['solid', '——'], ['dashed', '– –'], ['dotted', '· · ·']]) {
      const sb = document.createElement('button');
      sb.textContent = sl;
      sb.title = sv;
      sb.dataset.style = sv;
      sb.style.cssText = 'flex:1;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:' +
        (sv === 'solid' ? 'var(--accent)' : 'var(--bg-tertiary)') + ';color:' + (sv === 'solid' ? '#fff' : 'var(--text-primary)') + ';cursor:pointer;font-size:12px;';
      sb.addEventListener('click', (e) => {
        e.stopPropagation();
        window.setShapeStyle && window.setShapeStyle(sv);
        if (!shapeBtn.classList.contains('active')) { shapeBtn.click(); menu.classList.remove('open'); }
        styleRow.querySelectorAll('button').forEach(x => {
          const on = x.dataset.style === sv;
          x.style.background = on ? 'var(--accent)' : 'var(--bg-tertiary)';
          x.style.color = on ? '#fff' : 'var(--text-primary)';
        });
      });
      styleRow.appendChild(sb);
    }
    menu.appendChild(styleRow);
    document.body.appendChild(menu);
    shapeBtn.addEventListener('click', () => {
      const r = shapeBtn.getBoundingClientRect();
      menu.style.top = r.bottom + 4 + 'px';
      menu.style.left = r.left + 'px';
      menu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#shapeTool') && !e.target.closest('#shapeMenu')) menu.classList.remove('open');
    });
  }

  let docxPicker = null; // set in buildExportBar; reused by the welcome screen
  let imgPicker = null;  // set in buildExportBar; reused by the welcome screen
  let pendingAction = null; // landing-page card action to run after a PDF loads

  // ── Export & Convert toolbar: clear named actions instead of one dropdown ──
  // Existing export menu items keep their app.js listeners; the named buttons
  // simply click them. Word→PDF / exact-look Word use window hooks from app.js.
  function buildExportBar() {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const oldWrap = wrapOf('#exportBtn');
    if (oldWrap) { oldWrap.style.display = 'none'; box.appendChild(oldWrap); }

    const needDoc = () => {
      const dl = el('#downloadBtn');
      if (dl && dl.disabled) { const s = el('#statusText'); if (s) s.textContent = 'Open a PDF first.'; return true; }
      return false;
    };
    const clickExport = (k) => { if (!needDoc()) el(`#exportMenu [data-export="${k}"]`)?.click(); };
    const mk = (text, title, fn, revealKey) => {
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.title = title;
      if (revealKey) b.dataset.reveal = revealKey; // so landing cards can pulse it
      b.innerHTML = `<span style="display:inline">${text}</span>`;
      b.addEventListener('click', fn);
      box.appendChild(b);
      return b;
    };

    // Word → PDF (opens the converted file straight in the editor)
    docxPicker = document.createElement('input');
    const docxInput = docxPicker;
    docxInput.type = 'file';
    docxInput.accept = '.docx,.doc';
    docxInput.style.display = 'none';
    docxInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f && window.convertWordToPdf) window.convertWordToPdf(f);
      e.target.value = '';
    });
    document.body.appendChild(docxInput);
    mk('Word → PDF', 'Convert a Word (.docx) file to PDF and open it here', () => docxInput.click());

    // Image → PDF (multi-select; one page per image)
    imgPicker = document.createElement('input');
    const imgPdfInput = imgPicker;
    imgPdfInput.type = 'file';
    imgPdfInput.accept = 'image/png,image/jpeg';
    imgPdfInput.multiple = true;
    imgPdfInput.style.display = 'none';
    imgPdfInput.addEventListener('change', (e) => {
      if (e.target.files?.length && window.convertImagesToPdf) window.convertImagesToPdf(e.target.files);
      e.target.value = '';
    });
    document.body.appendChild(imgPdfInput);
    mk('Image → PDF', 'Combine PNG/JPG images into a PDF (one page per image)', () => window.imageToPdfDialog ? window.imageToPdfDialog() : imgPdfInput.click());

    mk('PDF → Word', 'Editable Word file — font sizes and bold are kept; scanned pages are included as exact images',
      () => { if (!needDoc()) window.exportWordSmart && window.exportWordSmart(); }, 'word');
    mk('PDF → Excel', 'Extract the text into an Excel spreadsheet', () => clickExport('excel'), 'excel');

    // PDF → Image with a type submenu
    const imgBtn = mk('PDF → Image ▾', 'Export pages as PNG, JPEG or TIFF images', () => {
      const r = imgBtn.getBoundingClientRect();
      imgMenu.style.top = r.bottom + 4 + 'px';
      imgMenu.style.left = r.left + 'px';
      imgMenu.classList.toggle('open');
    }, 'image');
    const imgMenu = document.createElement('div');
    imgMenu.className = 'dropdown-menu';
    imgMenu.id = 'imgExportMenu';
    for (const [k, t] of [['png', 'PNG — this page'], ['jpeg', 'JPEG — this page'], ['tiff', 'TIFF — this page'],
                          ['all-png', 'PNG — all pages'], ['all-jpeg', 'JPEG — all pages']]) {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.textContent = t;
      it.addEventListener('click', (e) => { e.stopPropagation(); imgMenu.classList.remove('open'); clickExport(k); });
      imgMenu.appendChild(it);
    }
    document.body.appendChild(imgMenu);
    document.addEventListener('click', (e) => {
      if (!imgMenu.contains(e.target) && e.target !== imgBtn && !imgBtn.contains(e.target)) imgMenu.classList.remove('open');
    });
    return box;
  }

  // ── Draw mode picker: pen / pencil / marker / spray ────────────────────────
  const drawBtn = el('#drawTool');
  if (drawBtn) {
    const dMenu = document.createElement('div');
    dMenu.className = 'dropdown-menu';
    dMenu.id = 'drawMenu';
    const DMODES = [
      ['pen', '🖊 Pen — smooth solid line'],
      ['pencil', '✏️ Pencil — thin, light stroke'],
      ['marker', '🖍 Marker — broad, semi-transparent'],
      ['spray', '💨 Spray — airbrush dots'],
    ];
    for (const [mode, label] of DMODES) {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.dataset.mode = mode;
      it.textContent = label;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        window.setDrawMode && window.setDrawMode(mode);
        dMenu.querySelectorAll('.dropdown-item').forEach(x =>
          x.textContent = (x.dataset.mode === mode ? '✓ ' : '') + x.textContent.replace(/^✓ /, ''));
        dMenu.classList.remove('open');
        if (!drawBtn.classList.contains('active')) drawBtn.click();
        dMenu.classList.remove('open');
      });
      dMenu.appendChild(it);
    }
    dMenu.firstChild.textContent = '✓ ' + dMenu.firstChild.textContent;
    document.body.appendChild(dMenu);
    drawBtn.addEventListener('click', () => {
      const r = drawBtn.getBoundingClientRect();
      dMenu.style.top = r.bottom + 4 + 'px';
      dMenu.style.left = r.left + 'px';
      dMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#drawTool') && !e.target.closest('#drawMenu')) dMenu.classList.remove('open');
    });
  }

  // ── Highlight mode picker: text-snap / freehand / underline / strike ───────
  const hlBtn = el('#highlightTool');
  if (hlBtn) {
    const hlMenu = document.createElement('div');
    hlMenu.className = 'dropdown-menu';
    hlMenu.id = 'highlightMenu';
    const HMODES = [
      ['text', '🖍 Highlight text (exact words)'],
      ['free', '✏️ Freehand highlight'],
      ['underline', 'U̲ Underline text'],
      ['strike', 'S̶ Strikethrough text'],
    ];
    for (const [mode, label] of HMODES) {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.dataset.mode = mode;
      it.textContent = label;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        window.setHighlightMode && window.setHighlightMode(mode);
        hlMenu.querySelectorAll('.dropdown-item').forEach(x =>
          x.textContent = (x.dataset.mode === mode ? '✓ ' : '') + x.textContent.replace(/^✓ /, ''));
        hlMenu.classList.remove('open');
        if (!hlBtn.classList.contains('active')) hlBtn.click();
        hlMenu.classList.remove('open');
      });
      hlMenu.appendChild(it);
    }
    hlMenu.firstChild.textContent = '✓ ' + hlMenu.firstChild.textContent;
    document.body.appendChild(hlMenu);
    hlBtn.addEventListener('click', () => {
      const r = hlBtn.getBoundingClientRect();
      hlMenu.style.top = r.bottom + 4 + 'px';
      hlMenu.style.left = r.left + 'px';
      hlMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#highlightTool') && !e.target.closest('#highlightMenu')) hlMenu.classList.remove('open');
    });
  }

  // Paint-bar custom colour: the rainbow swatch opens the OS colour picker
  // (gradient + eyedropper + RGB), mirroring into the app's colour state.
  const pbCustom = el('#pbCustomColor');
  const mainColor = el('#colorPicker');
  if (pbCustom && mainColor) {
    const cur = el('#pbColorCurrent');
    const showCur = () => { if (cur) cur.style.background = mainColor.value; };
    pbCustom.addEventListener('input', () => {
      mainColor.value = pbCustom.value;
      // Fire the same pipeline a swatch click uses (brush colour + actives).
      mainColor.dispatchEvent(new Event('input', { bubbles: true }));
      mainColor.dispatchEvent(new Event('change', { bubbles: true }));
      showCur();
    });
    mainColor.addEventListener('input', showCur);
    showCur();
  }

  // Paint-bar size SLIDER — drag for any exact size (presets still work).
  // It proxies the main #sizePicker so brushes/shapes/eraser all follow.
  const pbSlider = el('#pbSizeSlider');
  const pbSizeVal = el('#pbSizeVal');
  const mainSize = el('#sizePicker');
  if (pbSlider && mainSize) {
    const syncFromMain = () => { pbSlider.value = mainSize.value; if (pbSizeVal) pbSizeVal.textContent = mainSize.value; };
    pbSlider.addEventListener('input', () => {
      mainSize.value = pbSlider.value;
      if (pbSizeVal) pbSizeVal.textContent = pbSlider.value;
      mainSize.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mainSize.addEventListener('input', syncFromMain);
    syncFromMain();
  }

  // Paint-bar eraser toggle (MS-Paint style): click to erase, click again to
  // return to the pen/highlighter you were using.
  const pbEraser = el('#pbEraser');
  const eraserReal = el('#eraserTool');
  if (pbEraser && eraserReal) {
    let backTo = '#drawTool';
    pbEraser.addEventListener('click', () => {
      if (eraserReal.classList.contains('active')) {
        el(backTo)?.click(); // back to the previous drawing tool
      } else {
        backTo = el('#highlightTool')?.classList.contains('active') ? '#highlightTool'
               : el('#shapeTool')?.classList.contains('active') ? '#shapeTool' : '#drawTool';
        eraserReal.click();
      }
    });
    new MutationObserver(() => pbEraser.classList.toggle('active', eraserReal.classList.contains('active')))
      .observe(eraserReal, { attributes: true, attributeFilter: ['class'] });
    // The Whiteout toggle belongs next to the eraser (app.js shows/hides it).
    const eo = el('#eraserOptions');
    if (eo) pbEraser.after(eo);
  }

  // ── Layers panel: create → name → mark up → hide → next option ────────────
  const LAYER_PALETTE = ['#f44336', '#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#795548', '#E91E63'];
  const layersPanel = document.createElement('aside');
  layersPanel.className = 'layers-panel';
  layersPanel.innerHTML =
    '<div class="layers-head"><span>Layers</span><button class="icon-btn" id="layersClose" title="Close">✕</button></div>' +
    '<div class="layers-hint">Each layer is one set of markups (e.g. "Layer 2"). Click a layer to draw on it; the eye hides it. Hidden layers are not saved into the PDF.</div>' +
    '<button class="layers-add" id="layersAdd">+ New layer</button>' +
    '<div class="layers-list" id="layersList"></div>';
  function toggleLayersPanel(force) {
    const on = force !== undefined ? force : layersPanel.style.display !== 'flex';
    layersPanel.style.display = on ? 'flex' : 'none';
    if (on) renderLayers();
  }
  function renderLayers() {
    const listEl = layersPanel.querySelector('#layersList');
    if (!window.pdfLayers) return;
    listEl.innerHTML = '';
    for (const l of window.pdfLayers.list()) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (l.active ? ' active' : '');
      // colour dot
      const dot = document.createElement('input');
      dot.type = 'color';
      dot.className = 'layer-dot';
      dot.value = l.color || '#888888';
      dot.title = 'Layer colour (used as the pen colour when this layer is active)';
      dot.addEventListener('input', () => window.pdfLayers.setColor(l.id, dot.value));
      dot.addEventListener('click', (e) => e.stopPropagation());
      // name
      const nm = document.createElement('span');
      nm.className = 'layer-name';
      const counts = (window.pdfLayers.counts && window.pdfLayers.counts()) || {};
      nm.textContent = l.name + (counts[l.id] ? '  ·  ' + counts[l.id] : '');
      nm.title = 'Click to draw on this layer · double-click to rename';
      nm.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const inp = document.createElement('input');
        inp.className = 'layer-rename';
        inp.value = l.name;
        nm.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => { window.pdfLayers.rename(l.id, inp.value.trim() || l.name); renderLayers(); };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') renderLayers(); });
      });
      // eye toggle
      const eye = document.createElement('button');
      eye.className = 'layer-eye' + (l.visible ? ' on' : '');
      eye.title = l.visible ? 'Hide this layer' : 'Show this layer';
      eye.innerHTML = l.visible
        ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M1 1l22 22"/></svg>';
      eye.addEventListener('click', (e) => { e.stopPropagation(); window.pdfLayers.setVisible(l.id, !l.visible); renderLayers(); });
      // move selected markups onto this layer
      const mv = document.createElement('button');
      mv.className = 'layer-eye';
      mv.title = 'Move the selected markup(s) to this layer';
      mv.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      mv.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.pdfLayers.assignSelected && window.pdfLayers.assignSelected(l.id)) renderLayers();
      });
      // delete
      const del = document.createElement('button');
      del.className = 'layer-del';
      del.textContent = '✕';
      del.title = 'Delete this layer and its markups';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.confirm(`Delete layer "${l.name}" and all its markups?`)) {
          window.pdfLayers.remove(l.id);
          renderLayers();
        }
      });
      row.append(dot, nm, mv, eye, del);
      row.addEventListener('click', () => { window.pdfLayers.setActive(l.id); renderLayers(); });
      listEl.appendChild(row);
    }
  }
  window.renderLayersPanel = () => { if (layersPanel.style.display === 'flex') renderLayers(); };
  layersPanel.querySelector('#layersClose').addEventListener('click', () => toggleLayersPanel(false));
  layersPanel.querySelector('#layersAdd').addEventListener('click', () => {
    if (!window.pdfLayers) return;
    const n = window.pdfLayers.list().length;
    // "Layer 2", "Layer 3", ... (the next number) - clearer than "Option N".
    window.pdfLayers.add('Layer ' + (n + 1), LAYER_PALETTE[n % LAYER_PALETTE.length]);
    renderLayers();
  });
  layersPanel.style.display = 'none';
  mainContainer.appendChild(layersPanel);

  // ── Full font lists in both font dropdowns ─────────────────────────────────
  // Try the OS font enumeration API first (every installed font); fall back to
  // a broad curated list filtered to fonts actually available on this machine.
  (async () => {
    const CURATED = [
      'Arial', 'Arial Black', 'Arial Narrow', 'Avenir', 'Avenir Next', 'Baskerville', 'Big Caslon',
      'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Calibri', 'Cambria', 'Chalkboard', 'Charter',
      'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot', 'Futura',
      'Garamond', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Hoefler Text',
      'Impact', 'Lucida Grande', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy', 'Optima',
      'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'Seravek', 'SignPainter',
      'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino',
    ];
    let families = [];
    try {
      if (window.queryLocalFonts) {
        const fonts = await window.queryLocalFonts();
        families = [...new Set(fonts.map(f => f.family))];
      }
    } catch { /* permission denied — curated fallback */ }
    if (!families.length) {
      families = CURATED.filter(f => { try { return document.fonts.check(`12px "${f}"`); } catch { return false; } });
      if (!families.length) families = CURATED;
    }
    families.sort((a, b) => a.localeCompare(b));
    for (const selId of ['fontFamily', 'tbFontFamily']) {
      const sel = document.getElementById(selId);
      if (!sel) continue;
      const current = sel.value;
      sel.innerHTML = '';
      for (const f of families) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = f;
        o.style.fontFamily = `"${f}"`; // each entry previews in its own face
        sel.appendChild(o);
      }
      sel.value = families.includes(current) ? current : (families.includes('Arial') ? 'Arial' : families[0]);
    }
  })();

  // Match the Sign button's own icon to the clearer pen-on-line one.
  const sigBtn = el('#signatureBtn');
  if (sigBtn) {
    const s = sigBtn.querySelector('svg');
    if (s) s.outerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/><path d="M3 22h18" opacity="0.6"/></svg>';
  }

  const GROUPS = [
    { id: 'edit',     label: 'Edit PDF',        tint: '#b06ee8',
      desc: 'Text, draw, highlight, stamps, images',
      members: [el('#textTool'), el('[data-tool="edittext"]'), el('#drawTool'), el('#highlightTool'), el('#shapeTool'), wrapOf('#stampBtn'), el('#imageTool'), el('#cropTool'), el('#toolOptions')] },
    { id: 'organize', label: 'Organize Pages',  tint: '#4caf7d',
      desc: 'Rotate, add, merge, split pages',
      members: [el('#rotateBtn'), el('#addPageBtn'), el('#addImagePageBtn'), el('#templatePageBtn'), el('#mergeBtn'), el('#splitBtn'), el('#watermarkBtn'), el('#pageNumBtn'), el('#nupBtn'), el('#rmBlankBtn')] },
    { id: 'sign',     label: 'Fill & Sign',     tint: '#5aa2e8',
      desc: 'Add your signature to the document',
      // A clear "signing" icon: a fountain pen writing on a signature line.
      svg: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
           '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/><path d="M3 22h18" opacity="0.6"/></svg>',
      members: [el('#signatureBtn'), el('#formsBtn'), el('#protectBtn'), el('#sanitizeBtn'), el('#compareBtn')] },
    { id: 'export',   label: 'Export & Convert', tint: '#3ab5a0',
      desc: 'PDF to Word/Excel/images, Word to PDF',
      members: [buildExportBar(), el('#compressBtn')] },
    { id: 'ocr',      label: 'Scan & OCR',      tint: '#7dc243',
      desc: 'Make scanned pages searchable',
      members: [el('#ocrBtn')] },
    { id: 'layers',   label: 'Layers',          tint: '#e8734a',
      desc: 'Versions of markups — show or hide',
      svg: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
      action: () => toggleLayersPanel() },
  ];

  // AI features are disabled: hide every AI entry point. The elements stay in
  // the DOM (app.js binds listeners to them by id — removing them would crash
  // its init), they are just never visible or reachable.
  for (const sel of ['#aiToggleBtn', '#aiPanel', '#tbAiEdit']) {
    const n = el(sel); if (n) n.style.display = 'none';
  }

  // Move each group's members into its own container inside the context bar.
  for (const g of GROUPS) {
    if (!g.members) continue;
    const box = document.createElement('div');
    box.className = 'adobe-ctx-group';
    box.dataset.group = g.id;
    box.style.display = 'none';
    for (const m of g.members) if (m) box.appendChild(m);
    groupHost.appendChild(box);
    g.box = box;
  }

  // ── Right-hand Tools panel (Acrobat's tool list) ────────────────────────────
  const panel = document.createElement('aside');
  panel.id = 'adobeToolsPanel';
  panel.className = 'adobe-tools-panel';
  const head = document.createElement('div');
  head.className = 'adobe-tools-head';
  head.textContent = 'Tools';
  panel.appendChild(head);

  const iconFor = (g) => {
    // A group can define its own icon; otherwise reuse its first button's SVG.
    if (g.svg) { const t = document.createElement('span'); t.innerHTML = g.svg; return t.firstChild; }
    const src = g.members && g.members.find(Boolean);
    const svg = src && src.querySelector && src.querySelector('svg');
    if (g.id === 'ai') { const b = el('#aiToggleBtn'); return b?.querySelector('svg')?.cloneNode(true) || null; }
    return svg ? svg.cloneNode(true) : null;
  };

  // First-step hints so a new user knows what to do after opening a tool.
  const HINTS = {
    edit: 'Add or edit text, draw or highlight on the page, add stamps and images.',
    comment: 'Add shapes on the page, or open the notes panel for page comments.',
    organize: 'Rotate the current page, add or merge pages, or split out a page range.',
    sign: 'Click Sign to create your signature, then place it anywhere on the page.',
    export: 'Choose a format to export the current page or the whole document.',
    ocr: 'Run OCR to make scanned pages searchable and selectable.',
  };
  const setHint = (t) => { const s = el('#statusText'); if (s && t) s.textContent = t; };

  let active = null;
  // The page/zoom pill docks INTO the contextual bar while a tool is open
  // (next to the tool options/font controls) and floats over the document
  // top-center otherwise.
  const dockPageNav = (intoBar) => {
    const pn = el('#pageNav');
    if (!pn) return;
    if (intoBar) {
      pn.classList.add('docked');
      ctxBar.insertBefore(pn, ctxBar.querySelector('.adobe-ctx-history'));
    } else {
      pn.classList.remove('docked');
      const ea = el('#editorArea');
      const csw = el('#canvasScrollWrapper');
      if (ea) ea.insertBefore(pn, csw || null);
    }
  };
  const open = (g) => {
    if (g.action) { g.action(); return; }
    if (active) active.box.style.display = 'none';
    active = g;
    g.box.style.display = 'flex';
    ctxTitle.textContent = g.label;
    ctxTitle.style.color = g.tint;
    ctxBar.style.display = 'flex';
    dockPageNav(true);
    panel.querySelectorAll('.adobe-tool-item').forEach(b => b.classList.toggle('active', b.dataset.group === g.id));
    setHint(HINTS[g.id]);
  };
  const close = () => {
    if (active) active.box.style.display = 'none';
    active = null;
    ctxBar.style.display = 'none';
    dockPageNav(false);
    panel.querySelectorAll('.adobe-tool-item').forEach(b => b.classList.remove('active'));
    // Return to the neutral select tool so no drawing mode stays armed.
    const sel = el('#selectTool'); if (sel && !sel.classList.contains('active')) sel.click();
  };
  // Escape closes the open tool (unless the user is typing in a field).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) close();
  });

  for (const g of GROUPS) {
    const item = document.createElement('button');
    item.className = 'adobe-tool-item';
    item.dataset.group = g.id;
    item.title = g.desc;
    const ic = document.createElement('span');
    ic.className = 'adobe-tool-ic';
    ic.style.background = g.tint + '22';
    ic.style.color = g.tint;
    const svg = iconFor(g);
    if (svg) { svg.setAttribute('width', '17'); svg.setAttribute('height', '17'); ic.appendChild(svg); }
    const tx = document.createElement('span');
    tx.className = 'adobe-tool-tx';
    tx.innerHTML = `<b>${g.label}</b><small>${g.desc}</small>`;
    item.appendChild(ic); item.appendChild(tx);
    item.addEventListener('click', () => (active === g ? close() : open(g)));
    panel.appendChild(item);
  }
  mainContainer.appendChild(panel);

  // ── Page bar: compact floating-pill labels ─────────────────────────────────
  // Same elements (ids/listeners intact) — only the visual text is tidied.
  const prev = el('#prevPage'), next = el('#nextPage');
  if (prev) { prev.innerHTML = '&#8249;'; prev.title = 'Previous page'; }
  if (next) { next.innerHTML = '&#8250;'; next.title = 'Next page'; }
  const info = document.querySelector('.page-info');
  const pageInput = el('#pageInput'), totalPages = el('#totalPages');
  if (info && pageInput && totalPages) {
    info.textContent = '';
    const sep = document.createElement('span');
    sep.className = 'page-sep';
    sep.textContent = '/';
    info.append(pageInput, sep, totalPages);
    pageInput.title = 'Current page — type a number and press Enter';
  }
  const zo = el('#zoomOut'), zi = el('#zoomIn');
  if (zo) zo.innerHTML = '&#8722;';
  if (zi) zi.innerHTML = '+';

  // ── Landing page: iLovePDF-style tool grid ─────────────────────────────────
  // Cards that need a PDF open the picker, then auto-jump into the tool once
  // the file loads (pendingAction, resolved by the fileInfo observer below).
  const BRAND_MARK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' +
    '<path d="M9 17v-6l6 6v-6"/></svg>'; // "N" strokes inside a document = Nexus

  const dz = el('#dropZone');
  if (dz) {
    // Rebuilt landing: a standard drag-and-drop / Open dropzone on top, then the
    // tools grouped into three labeled rows (Edit · Convert · Tools). The old
    // "Nexus PDF Editor" brand lockup and "What do you want to do?" title are
    // gone — the Documents module already frames this as the PDF Editor, so a
    // second title just wasted the vertical space the tiles need.
    dz.innerHTML = '';
    dz.classList.add('welcome-landing');

    const pickPdfThen = (fn) => { pendingAction = fn; el('#fileInput')?.click(); };
    const expItem = (k) => el(`#exportMenu [data-export="${k}"]`)?.click();
    const openGroup = (id) => { const g = GROUPS.find(x => x.id === id); if (g) open(g); };

    // Landing card → navigate to the tab where the tool lives and pulse the
    // exact button, so the user learns WHERE the option is (instead of the tool
    // just running silently). `target` is a CSS selector for the button to
    // highlight; omit it to just open the tab.
    const revealTool = (groupId, target) => {
      openGroup(groupId);
      if (!target) return;
      // Wait a frame so the group's box is displayed before we pulse the button.
      requestAnimationFrame(() => {
        const btn = el(target);
        if (!btn) return;
        btn.scrollIntoView({ inline: 'center', block: 'nearest' });
        btn.classList.add('tool-reveal-pulse');
        setTimeout(() => btn.classList.remove('tool-reveal-pulse'), 2400);
      });
    };
    // For export tools (Word/Excel/Image), open the Export tab and pulse the
    // matching labeled button in the export bar (tagged with data-reveal).
    const revealExport = (k) => {
      openGroup('export');
      requestAnimationFrame(() => {
        const item = el(`[data-reveal="${k}"]`);
        if (!item) return;
        item.scrollIntoView({ inline: 'center', block: 'nearest' });
        item.classList.add('tool-reveal-pulse');
        setTimeout(() => item.classList.remove('tool-reveal-pulse'), 2400);
      });
    };

    // A direction-picker: click one Convert tile, choose which way to convert.
    // Simpler than two tiles each; the anchor is the clicked card so the popup
    // appears right under it.
    let openConvertMenu = null;
    const closeConvertMenu = () => { if (openConvertMenu) { openConvertMenu.remove(); openConvertMenu = null; } };
    document.addEventListener('click', closeConvertMenu);
    const directionPick = (anchor, options) => {
      closeConvertMenu();
      const menu = document.createElement('div');
      menu.className = 'welcome-dir-menu';
      for (const [label, fn] of options) {
        const b = document.createElement('button');
        b.className = 'welcome-dir-item';
        b.textContent = label;
        b.addEventListener('click', (e) => { e.stopPropagation(); closeConvertMenu(); fn(); });
        menu.appendChild(b);
      }
      const r = anchor.getBoundingClientRect();
      menu.style.left = Math.round(r.left) + 'px';
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      menu.style.minWidth = Math.round(r.width) + 'px';
      document.body.appendChild(menu);
      openConvertMenu = menu;
    };

    // SVG path strings (24×24, stroke) keyed for reuse.
    const IC = {
      edit:     'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5ZM15 5l4 4',
      organize: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
      merge:    'M2 2h8v12H2zM14 10h8v12h-8zM10 8h4m-2-2v4',
      split:    'M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4',
      word:     'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13l2 5 2-5 2 5 2-5',
      image:    'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
      excel:    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 12l6 6M15 12l-6 6',
      ocr:      'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35M8 11h6M11 8v6',
      sign:     'M3 17c2.5 0 3-6 5-6s1.5 4 3 4 2-8 4-8 1.5 6 3 6M3 21h18',
      protect:  'M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4',
      compress: 'M8 3l4 4 4-4M8 21l4-4 4 4M12 7v10',
    };

    // Three simple groups (owner request Aug 2026): Edit · Convert · Tools.
    // Each card carries a one-line description (pro editors always label what a
    // tool does). Convert tiles open a direction submenu instead of two one-way
    // tiles; `isSub` marks those.
    const ROWS = [
      { title: 'Edit', cards: [
        ['Edit PDF',      'Add text, shapes and edits',   '#b06ee8', IC.edit,     () => pickPdfThen(() => revealTool('edit', '#textTool'))],
        ['Rearrange PDF', 'Reorder, rotate and add pages','#4caf7d', IC.organize, () => pickPdfThen(() => revealTool('organize', '#rotateBtn'))],
        ['Merge PDF',     'Combine files into one',       '#e8734a', IC.merge,    () => pickPdfThen(() => revealTool('organize', '#mergeBtn'))],
        ['Split PDF',     'Extract or separate pages',    '#3a97d4', IC.split,    () => pickPdfThen(() => revealTool('organize', '#splitBtn'))],
      ]},
      { title: 'Convert', cards: [
        ['Word ⇄ PDF', 'Convert either direction', '#2b7cd3', IC.word, (card) => directionPick(card, [
          ['PDF → Word', () => pickPdfThen(() => revealExport('word'))],
          ['Word → PDF', () => docxPicker && docxPicker.click()],
        ]), true],
      ]},
    ];

    // Two-panel layout the owner preferred, made foolproof with an explicit
    // "Step 1 / Step 2" framing: LEFT = upload the file (the clear starting
    // point) with a Recent list; RIGHT = all the tools, grouped. A tool always
    // opens the picker first if no file is loaded, so the two steps can also be
    // done in one click.
    const wrap = document.createElement('div');
    wrap.className = 'welcome-shell';

    // ── Left column: Step 1 = upload ──
    const leftCol = document.createElement('div');
    leftCol.className = 'welcome-left';

    const drop = document.createElement('button');
    drop.className = 'welcome-drop';
    drop.type = 'button';
    drop.innerHTML =
      '<span class="welcome-drop-ic">' +
      '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M12 3v13M7 8l5-5 5 5"/></svg></span>' +
      '<span class="welcome-drop-txt">' +
      '<span class="welcome-drop-t">Drop your PDF here to get started</span>' +
      '<span class="welcome-drop-s">or click the button below to browse your files</span>' +
      '</span>' +
      '<span class="welcome-drop-btn">Choose File</span>' +
      '<span class="welcome-drop-hint">Upload a PDF up to 100 MB, or a Word (.docx, .doc) or image (PNG, JPG) file to convert into a PDF.</span>';
    drop.addEventListener('click', (e) => { e.stopPropagation(); el('#fileInput')?.click(); });
    leftCol.appendChild(drop);
    wrap.appendChild(leftCol);

    // ── Right column: Step 2 = pick a tool ──
    const tools = document.createElement('div');
    tools.className = 'welcome-tools';
    for (const row of ROWS) {
      const section = document.createElement('div');
      section.className = 'welcome-row';
      const rhead = document.createElement('div');
      rhead.className = 'welcome-row-title';
      rhead.textContent = row.title;
      section.appendChild(rhead);
      const grid = document.createElement('div');
      grid.className = 'welcome-grid';
      for (const [label, desc, tint, path, fn, isSub] of row.cards) {
        const c = document.createElement('button');
        c.className = 'welcome-card';
        c.innerHTML =
          `<span class="welcome-card-ic" style="background:${tint};color:#fff">` +
          `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></span>` +
          `<span class="welcome-card-body">` +
          `<span class="welcome-card-tx">${label}${isSub ? ' <span class="welcome-card-caret">▾</span>' : ''}</span>` +
          `<span class="welcome-card-desc">${desc}</span></span>`;
        c.addEventListener('click', (e) => { e.stopPropagation(); fn(c); });
        grid.appendChild(c);
      }
      section.appendChild(grid);
      tools.appendChild(section);
    }
    wrap.appendChild(tools);
    dz.appendChild(wrap);

    // If the picker is cancelled, disarm the landing-card action so a later
    // manual open doesn't unexpectedly fire a stale tool/export.
    el('#fileInput')?.addEventListener('cancel', () => { pendingAction = null; });
  }

  // ── Slim down the top bar ───────────────────────────────────────────────────
  // Keep: title, Open, Download, undo/redo (left) + Select, Search, Theme (right).
  const left = $('.toolbar-left'), center = $('.toolbar-center'), right = $('.toolbar-right');
  // Undo/Redo live on the RIGHT, next to Save — that's where the user's eyes
  // are while editing (they were easy to miss tucked in the far-left corner).
  const keepRight = [el('#selectTool'), el('#searchToggle'),
                     ...(IN_PORTAL ? [] : [el('#themeToggle')]), el('#undoBtn'), el('#redoBtn')];
  if (IN_PORTAL) { const tt = el('#themeToggle'); if (tt) tt.style.display = 'none'; }
  for (const b of keepRight) if (b) right.appendChild(b);
  // Print button — annotations flattened, real system print dialog
  const printBtn = document.createElement('button');
  printBtn.id = 'printBtn';
  printBtn.className = 'tool-btn';
  printBtn.title = 'Print with your markups (Cmd/Ctrl+P)';
  printBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>';
  printBtn.addEventListener('click', () => window.printPdf && window.printPdf());
  right.appendChild(printBtn);

  // Save ▾: prominent accent button on the far right. Click = format menu
  // (PDF / Word / Excel / images), so the user chooses how to save.
  const dl = el('#downloadBtn');
  if (dl) {
    const span = dl.querySelector('span');
    if (span) span.textContent = 'Save ▾';
    dl.title = 'Save this document — choose a format';
    dl.classList.add('save-pdf-btn');
    right.appendChild(dl);

    const saveMenu = document.createElement('div');
    saveMenu.className = 'dropdown-menu';
    saveMenu.id = 'saveMenu';
    const exp = (k) => el(`#exportMenu [data-export="${k}"]`)?.click();
    // Most-used formats up front; everything else behind "Other formats".
    const PRIMARY = [
      ['PDF — all pages', () => window.downloadPDF && window.downloadPDF()],
      ['PDF — selected pages…', () => el('#splitBtn')?.click()],
      ['PNG image — this page', () => exp('png')],
      ['JPEG image — this page', () => exp('jpeg')],
    ];
    const OTHER = [
      ['Flattened PDF (uneditable)', () => window.saveFlattened && window.saveFlattened()],
      ['All text (.txt)', () => window.extractAllText && window.extractAllText()],
      ['Word (.docx)', () => window.exportWordSmart && window.exportWordSmart()],
      ['Excel (.xlsx)', () => exp('excel')],
      ['TIFF image — this page', () => exp('tiff')],
      ['PNG images — all pages (ZIP)', () => exp('all-png')],
      ['JPEG images — all pages (ZIP)', () => exp('all-jpeg')],
    ];
    const addItem = (parent, text, fn) => {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.textContent = text;
      it.addEventListener('click', (e) => { e.stopPropagation(); saveMenu.classList.remove('open'); fn(); });
      parent.appendChild(it);
    };
    for (const [text, fn] of PRIMARY) addItem(saveMenu, text, fn);
    const moreBtn = document.createElement('button');
    moreBtn.className = 'dropdown-item';
    moreBtn.textContent = 'Other formats  ▸';
    saveMenu.appendChild(moreBtn);
    const moreBox = document.createElement('div');
    moreBox.style.display = 'none';
    saveMenu.appendChild(moreBox);
    for (const [text, fn] of OTHER) addItem(moreBox, text, fn);
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = moreBox.style.display !== 'none';
      moreBox.style.display = open ? 'none' : 'block';
      moreBtn.textContent = open ? 'Other formats  ▸' : 'Other formats  ▾';
    });
    document.body.appendChild(saveMenu);
    // Intercept the button's click BEFORE app.js's own target listener can
    // fire (same-element capture doesn't beat registration order — a
    // document-level capture handler does). Cmd+S calls downloadPDF directly.
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#downloadBtn')) return;
      e.stopPropagation(); // never reaches the button → no instant download
      const r = dl.getBoundingClientRect();
      saveMenu.style.top = r.bottom + 6 + 'px';
      saveMenu.style.left = Math.max(8, r.right - 230) + 'px';
      saveMenu.style.minWidth = '220px';
      saveMenu.classList.toggle('open');
    }, true);
    document.addEventListener('click', (e) => {
      if (!saveMenu.contains(e.target) && !dl.contains(e.target)) saveMenu.classList.remove('open');
    });
  }
  if (center) center.style.display = 'none';

  // ── Recent files: history button in the top-right ──────────────────────────
  const RKEY = 'pdfEditorRecents';
  const getRecents = () => { try { return JSON.parse(localStorage.getItem(RKEY)) || []; } catch { return []; } };
  const addRecent = (name, path) => {
    if (!path || !/\.pdf$/i.test(name)) return;
    const r = getRecents().filter(x => x.path !== path);
    r.unshift({ name, path });
    try { localStorage.setItem(RKEY, JSON.stringify(r.slice(0, 10))); } catch { /* storage full */ }
  };
  el('#fileInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0]; if (f?.path) addRecent(f.name, f.path);
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f?.path && /\.pdf$/i.test(f.name)) addRecent(f.name, f.path);
  }, true);

  const histBtn = document.createElement('button');
  histBtn.className = 'tool-btn';
  histBtn.title = 'Recent files';
  histBtn.innerHTML =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const histMenu = document.createElement('div');
  histMenu.className = 'dropdown-menu';
  histMenu.id = 'recentMenu';
  document.body.appendChild(histMenu);
  histBtn.addEventListener('click', () => {
    const r = getRecents();
    histMenu.innerHTML = '<div class="dropdown-group-label">Recent files</div>';
    if (!r.length) {
      const none = document.createElement('div');
      none.className = 'dropdown-group-label';
      none.textContent = 'Nothing opened yet';
      histMenu.appendChild(none);
    }
    for (const it of r) {
      const b = document.createElement('button');
      b.className = 'dropdown-item';
      b.textContent = it.name;
      b.title = it.path;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        histMenu.classList.remove('open');
        try {
          const p = it.path.replace(/\\/g, '/');
          const res = await fetch('file://' + (p.startsWith('/') ? '' : '/') + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F'));
          const blob = await res.blob();
          addRecent(it.name, it.path); // bump to top
          await window.loadPdfFile(new File([blob], it.name, { type: 'application/pdf' }));
        } catch {
          const s = el('#statusText'); if (s) s.textContent = 'Could not reopen ' + it.name + ' — the file may have moved.';
        }
      });
      histMenu.appendChild(b);
    }
    const rect = histBtn.getBoundingClientRect();
    histMenu.style.top = rect.bottom + 6 + 'px';
    histMenu.style.left = Math.max(8, rect.right - 260) + 'px';
    histMenu.style.minWidth = '240px';
    histMenu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!histMenu.contains(e.target) && !histBtn.contains(e.target)) histMenu.classList.remove('open');
  });
  const searchBtnRef = el('#searchToggle');
  if (searchBtnRef) searchBtnRef.after(histBtn); else right.appendChild(histBtn);
  // Hidden per request: Recent files (clock) button is not shown in the toolbar.
  // All its logic is kept above so it can be re-enabled by removing this line.
  histBtn.style.display = 'none';

  // Document Info (i) button
  const infoBtn = document.createElement('button');
  infoBtn.className = 'tool-btn';
  infoBtn.title = 'Document information (title, author, keywords)';
  infoBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
  infoBtn.addEventListener('click', () => window.documentInfoDialog && window.documentInfoDialog());
  histBtn.after(infoBtn);
  // Hidden per request: Document information (i) button is not shown.
  infoBtn.style.display = 'none';

  // ── Outline / bookmarks panel (opens from a button in the Pages sidebar) ──
  const outlinePanel = document.createElement('aside');
  outlinePanel.className = 'outline-panel';
  outlinePanel.style.display = 'none';
  outlinePanel.innerHTML = '<div class="outline-head"><span>Bookmarks</span><button class="icon-btn" id="outlineClose">✕</button></div><div class="outline-list" id="outlineList"></div>';
  mainContainer.appendChild(outlinePanel);
  outlinePanel.querySelector('#outlineClose').addEventListener('click', () => { outlinePanel.style.display = 'none'; });
  async function toggleOutline() {
    if (outlinePanel.style.display === 'flex') { outlinePanel.style.display = 'none'; return; }
    const items = window.pdfOutline ? await window.pdfOutline.get() : [];
    const listEl = outlinePanel.querySelector('#outlineList');
    if (!items.length) {
      listEl.innerHTML = '<div class="outline-empty">This PDF has no bookmarks / table of contents.</div>';
    } else {
      listEl.innerHTML = '';
      for (const it of items) {
        const row = document.createElement('button');
        row.className = 'outline-row';
        row.style.paddingLeft = (10 + it.depth * 16) + 'px';
        row.textContent = it.title;
        row.title = it.page ? 'Go to page ' + it.page : it.title;
        if (it.page) row.addEventListener('click', () => window.pdfOutline.goto(it.page));
        else row.style.opacity = '0.6';
        listEl.appendChild(row);
      }
    }
    outlinePanel.style.display = 'flex';
  }
  window.toggleOutline = toggleOutline;
  // Bind the bookmarks button here (was an inline onclick=, removed so the CSP
  // can use script-src 'self' without 'unsafe-inline').
  el('#bookmarksBtn')?.addEventListener('click', () => toggleOutline());

  // ── Close document: obvious way back to the welcome screen ─────────────────
  // A full reload is the one reliable way to reset every bit of app.js state
  // (annotations, undo stacks, comments, pdf bytes) — it lands on Home.
  const closeDoc = document.createElement('button');
  closeDoc.className = 'tool-btn close-doc-btn';
  closeDoc.title = 'Close this document and return to Home';
  closeDoc.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Close file</span>';
  closeDoc.style.display = 'none';
  closeDoc.addEventListener('click', () => {
    if (!window.confirm('Close this document? Unsaved changes will be lost.')) return;
    location.reload();
  });
  const openBtn = el('#openFileBtn');
  if (openBtn) openBtn.after(closeDoc);

  // ── Header brand: compact mark on the far left (after the traffic lights) ──
  if (!IN_PORTAL) {
    const headerBrand = document.createElement('span');
    headerBrand.className = 'header-brand';
    headerBrand.innerHTML = `<span class="brand-mark brand-mark-sm">${BRAND_MARK}</span><span class="header-brand-tx">Nexus</span>`;
    headerBrand.title = 'Nexus PDF Editor';
    left.insertBefore(headerBrand, left.firstChild ? left.firstChild.nextSibling : null);
  }

  // ── Document title in the header (professional apps show the open file) ───
  const docTitle = document.createElement('div');
  docTitle.className = 'header-doc-title';
  docTitle.textContent = 'No document open';
  left.after(docTitle);

  // Mirror app.js state without touching it: #fileInfo (status bar) is updated
  // on every load — watch it to switch the title and reveal Close.
  const fileInfo = el('#fileInfo');
  let _everHadDoc = false; // latches true once any document has been opened
  if (fileInfo) {
    const sync = () => {
      const t = fileInfo.textContent || '';
      const name = t.split('|')[0].trim();
      const pages = (t.match(/(\d+)\s*page/) || [])[1];
      if (name) _everHadDoc = true;
      docTitle.textContent = name || 'No document open';
      docTitle.title = name;
      if (pages) {
        docTitle.textContent = '';
        const b = document.createElement('b'); b.textContent = name;
        const sm = document.createElement('small'); sm.textContent = `${pages} page${pages === '1' ? '' : 's'}`;
        docTitle.append(b, sm);
      }
      closeDoc.style.display = name ? 'inline-flex' : 'none';
      // The landing grid IS the tool chooser — the right Tools panel only makes
      // sense once a document is open (its buttons are dead before that).
      panel.style.display = name ? '' : 'none';
      // Same for the left Pages sidebar — there are no pages to show yet.
      const sb = el('#sidebar'), sbh = el('#sidebarResizeHandle');
      if (sb) sb.style.display = name ? '' : 'none';
      if (sbh) sbh.style.display = name ? '' : 'none';
      // Top bar on the landing page: only Recent files + Theme are meaningful.
      // Open duplicates the "Open PDF" card; the rest need a document.
      for (const s of ['#openFileBtn', '#selectTool', '#searchToggle', '#undoBtn', '#redoBtn', '#downloadBtn', '#printBtn']) {
        const n = el(s); if (n) n.style.display = name ? 'inline-flex' : 'none';
      }
      // In the portal, hide the whole top bar on the landing state (the tool
      // grid is self-sufficient); reveal it once a document is open. Once a doc
      // is open the header MUST stay visible so the user can always Close/Save,
      // even through transient states (e.g. a conversion briefly re-loading) -
      // we never hide it while a document is present.
      if (IN_PORTAL) {
        // Show once any doc has been opened, and keep it shown through transient
        // empty states (e.g. a conversion re-loading) so Close/Save never vanish.
        header.style.display = (name || _everHadDoc) ? '' : 'none';
      }
      // Window/tab title mirrors the open document, like every desktop app.
      document.title = name ? `${name} — Nexus PDF Editor` : 'Nexus PDF Editor';
      // Landing-page card flow: the PDF just finished loading — run the tool
      // the user picked (buttons need a beat to enable first).
      if (name && pendingAction) { const fn = pendingAction; pendingAction = null; setTimeout(fn, 400); }
    };
    new MutationObserver(sync).observe(fileInfo, { childList: true, characterData: true, subtree: true });
    sync();
  }
})();
