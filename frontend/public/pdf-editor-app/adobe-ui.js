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
      // Measure & Scale: calibrate once against a known distance on the plan,
      // then every line/perimeter/area is labeled with the real-world size.
      ['--measure--', 'Measure & Scale'],
      ['mcalibrate', '📐 Calibrate scale (set the plan scale)'],
      ['mlength', '↦ Measure length'],
      ['mperim', '⟿ Measure perimeter'],
      ['marea', '▦ Measure area'],
    ];
    for (const [kind, text] of KINDS) {
      // A "--measure--" entry is a non-clickable section header, not a shape.
      if (kind === '--measure--') {
        const hdr = document.createElement('div');
        hdr.className = 'dropdown-group-label';
        hdr.textContent = text;
        hdr.style.marginTop = '4px';
        menu.appendChild(hdr);
        continue;
      }
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
  // A single "Unlock PDF" tool button (strips an open-password). Unlock has no
  // toolbar element of its own - it runs via window.unlockPdfTool() - so the
  // Optimize group gets this lightweight button instead of an el('#...').
  function buildUnlockBtn() {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.id = 'unlockBtn';
    b.title = 'Remove a password from a PDF';
    b.dataset.reveal = 'unlock';
    b.innerHTML = '<span style="display:inline">Unlock</span>';
    b.addEventListener('click', () => { if (window.unlockPdfTool) window.unlockPdfTool(); });
    return b;
  }

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

  // Measure & Scale: a dedicated toolbar button (after Highlight) that opens a
  // small menu. It drives the same engine as the Shape menu's measure kinds -
  // arm the shape tool, then set the measure kind.
  const measureBtn = el('#measureTool');
  const shapeToolForMeasure = el('#shapeTool');
  if (measureBtn && shapeToolForMeasure) {
    const mMenu = document.createElement('div');
    mMenu.className = 'dropdown-menu';
    mMenu.id = 'measureMenu';
    const MMODES = [
      ['setscale',   '⚖ Set scale directly (1 in = 10 ft)', true],  // action, not a kind
      ['embedscale', '🧾 Use embedded scale (from the PDF)', true],
      ['mcalibrate', '📐 Calibrate by drawing a known line'],
      ['storescale', '📌 Store scale in this page', true],
      ['lockscale',  '🔒 Lock / unlock scale', true],
      ['mlength',    '↦ Measure length'],
      ['mpolylen',   '⌇ Measure polyline length'],
      ['mperim',     '⟿ Measure perimeter'],
      ['marea',      '▦ Measure area'],
      ['mdynfill',   '🪣 Dynamic fill (auto-detect a room)'],
      ['mcutout',    '⊟ Area cutout (subtract a void)'],
      ['mangle',     '∠ Measure angle'],
      ['mradius',    '◐ Measure radius / diameter'],
      ['mvolume',    '⬒ Measure volume (area × depth)'],
      ['mcount',     '# Count'],
      ['snapcontent','🧲 Snap to Content (on/off)', true],  // action: toggle snapping
      ['hidelabels', '👁 Show / hide measurement labels', true],
      ['mlist',      '☰ Measurements list & totals', true],  // action: open the panel
    ];
    for (const [kind, label, isAction] of MMODES) {
      const it = document.createElement('button');
      it.className = 'dropdown-item';
      it.dataset.kind = kind;
      it.textContent = label;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        mMenu.classList.remove('open');
        if (isAction) {
          // Actions open a dialog/panel rather than arming a draw tool.
          if (kind === 'setscale' && window.openSetScaleDialog) window.openSetScaleDialog();
          else if (kind === 'mlist' && window.toggleMeasureList) window.toggleMeasureList();
          else if (kind === 'embedscale' && window.useEmbeddedScale) window.useEmbeddedScale();
          else if (kind === 'storescale' && window.storeScaleInPage) window.storeScaleInPage();
          else if (kind === 'lockscale' && window.toggleScaleLock) {
            const locked = window.toggleScaleLock();
            it.textContent = (locked ? '🔒 ' : '🔓 ') + 'Lock / unlock scale';
          }
          else if (kind === 'snapcontent' && window.toggleSnapContent) {
            const on = window.toggleSnapContent();
            it.textContent = (on ? '✓ ' : '') + '🧲 Snap to Content (on/off)';
          }
          else if (kind === 'hidelabels' && window.toggleMeasureLabels) {
            const hidden = window.toggleMeasureLabels();
            it.textContent = (hidden ? '✓ ' : '') + '👁 Show / hide measurement labels';
          }
          return;
        }
        // Arm the shape tool (the measure engine lives on it) WITHOUT opening the
        // Shapes dropdown (M9). Also make sure the Shapes menu is closed.
        if (window.activateShapeToolForMeasure) window.activateShapeToolForMeasure();
        else if (!shapeToolForMeasure.classList.contains('active')) shapeToolForMeasure.click();
        document.getElementById('shapeMenu')?.classList.remove('open');
        window.setShapeKind && window.setShapeKind(kind);
        measureBtn.classList.add('active');
        mMenu.querySelectorAll('.dropdown-item[data-kind]').forEach(x => {
          if (['setscale'].includes(x.dataset.kind)) return;
          x.textContent = (x.dataset.kind === kind ? '✓ ' : '') + x.textContent.replace(/^✓ /, '');
        });
      });
      mMenu.appendChild(it);
    }
    document.body.appendChild(mMenu);
    measureBtn.addEventListener('click', () => {
      const r = measureBtn.getBoundingClientRect();
      mMenu.style.top = r.bottom + 4 + 'px';
      mMenu.style.left = r.left + 'px';
      mMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#measureTool') && !e.target.closest('#measureMenu')) mMenu.classList.remove('open');
    });
    // Drop the measure entries from the Shape menu now that they have their own
    // button (avoids two places for the same thing).
    const shapeMenu = document.getElementById('shapeMenu');
    if (shapeMenu) {
      shapeMenu.querySelectorAll('.dropdown-item').forEach(it => {
        if (['mcalibrate','mlength','mpolylen','mperim','marea','mdynfill','mcutout','mangle','mradius','mvolume','mcount'].includes(it.dataset.kind)) it.remove();
      });
      shapeMenu.querySelectorAll('.dropdown-group-label').forEach(h => {
        if (/measure & scale/i.test(h.textContent)) h.remove();
      });
    }
  }

  // Paint-bar custom color: the rainbow swatch opens the OS color picker
  // (gradient + eyedropper + RGB), mirroring into the app's color state.
  const pbCustom = el('#pbCustomColor');
  const mainColor = el('#colorPicker');
  if (pbCustom && mainColor) {
    const cur = el('#pbColorCurrent');
    const showCur = () => { if (cur) cur.style.background = mainColor.value; };
    pbCustom.addEventListener('input', () => {
      mainColor.value = pbCustom.value;
      // Fire the same pipeline a swatch click uses (brush color + actives).
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
      // color dot
      const dot = document.createElement('input');
      dot.type = 'color';
      dot.className = 'layer-dot';
      dot.value = l.color || '#888888';
      dot.title = 'Layer color (used as the pen color when this layer is active)';
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
    { id: 'edit',     label: 'Assemble',        tint: '#b06ee8',
      desc: 'Text, draw, highlight, measure, stamps, images',
      members: [el('#textTool'), el('[data-tool="edittext"]'), el('#drawTool'), el('#highlightTool'), el('#measureTool'), el('#shapeTool'), wrapOf('#stampBtn'), el('#imageTool'), el('#cropTool'), el('#toolOptions')] },
    { id: 'organize', label: 'Organize Pages',  tint: '#4caf7d',
      desc: 'Rotate, add, merge, split pages',
      members: [el('#rotateBtn'), el('#addPageBtn'), el('#addImagePageBtn'), el('#mergeBtn'), el('#splitBtn'), el('#watermarkBtn'), el('#pageNumBtn'), el('#nupBtn'), el('#rmBlankBtn')] },
    { id: 'sign',     label: 'Fill & Sign',     tint: '#5aa2e8',
      desc: 'Add your signature to the document',
      // A clear "signing" icon: a fountain pen writing on a signature line.
      svg: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
           '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/><path d="M3 22h18" opacity="0.6"/></svg>',
      members: [el('#signatureBtn'), el('#formsBtn'), el('#protectBtn'), el('#compareBtn')] },
    { id: 'export',   label: 'Export & Convert', tint: '#3ab5a0',
      desc: 'PDF to Word/Excel/images, Word to PDF',
      members: [buildExportBar()] },
    { id: 'optimize', label: 'Optimize',        tint: '#5c9e57',
      desc: 'Compress, repair, OCR',
      // Down-arrow into a tray: shrink / clean up the file.
      svg: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
      members: [el('#compressBtn'), el('#sanitizeBtn'), el('#ocrBtn')] },
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
  const headLabel = document.createElement('span');
  headLabel.textContent = 'Tools';
  head.appendChild(headLabel);
  // Collapse toggle: hides the tools list for more document space. A small
  // floating tab re-opens it when collapsed.
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'adobe-tools-collapse';
  collapseBtn.type = 'button';
  collapseBtn.title = 'Hide tools panel';
  collapseBtn.setAttribute('aria-label', 'Hide tools panel');
  collapseBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  head.appendChild(collapseBtn);
  panel.appendChild(head);

  // A floating tab shown when the panel is collapsed, to bring it back.
  const reopenTab = document.createElement('button');
  reopenTab.className = 'adobe-tools-reopen';
  reopenTab.type = 'button';
  reopenTab.title = 'Show tools panel';
  reopenTab.setAttribute('aria-label', 'Show tools panel');
  reopenTab.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';

  const setToolsCollapsed = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    reopenTab.style.display = collapsed ? 'flex' : 'none';
  };
  collapseBtn.addEventListener('click', () => setToolsCollapsed(true));
  reopenTab.addEventListener('click', () => setToolsCollapsed(false));

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
    optimize: 'Compress the file, repair a damaged PDF, run OCR, or remove a password.',
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
  mainContainer.appendChild(reopenTab);
  reopenTab.style.display = 'none'; // panel starts expanded

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

    // iLovePDF-style icons (full SVG markup, 24×24): rounded 2-tone tiles with
    // the signature corner-arrow accent. Recreated in their visual language
    // (not their copyrighted files) for the landing tool grid. `_a` is the arrow
    // color slot the card fills from the tile tint.
    // iLovePDF signature: white marks on the colored tile, plus a small
    // corner-arrow badge in a darker shade of the same color (--icf-d). The
    // arrow sits in the lower-right, exactly like their icons.
    const ARROW = '<g transform="translate(15.5 15.5)"><rect x="-1" y="-1" width="8" height="8" rx="2" fill="var(--icf-d)"/><path d="M1.4 3.5h3.2m0 0-1.3-1.3M4.6 3.5 3.3 4.8" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>';
    const ICF = {
      // Merge: two rounded pages overlapping + inward corner arrow.
      merge:    '<rect x="3.5" y="3.5" width="10" height="13" rx="2.2" fill="#fff" opacity=".5"/><rect x="7.5" y="6" width="10" height="13" rx="2.2" fill="#fff"/>' + ARROW,
      // Split: one page separating into two + corner arrow.
      split:    '<rect x="3.5" y="4" width="9.5" height="13" rx="2.2" fill="#fff"/><rect x="10.5" y="6.5" width="8" height="11" rx="2.2" fill="#fff" opacity=".5"/>' + ARROW,
      // Rearrange: 2×2 grid of rounded squares.
      organize: '<rect x="4" y="4" width="7" height="7" rx="1.8" fill="#fff"/><rect x="13" y="4" width="7" height="7" rx="1.8" fill="#fff" opacity=".65"/><rect x="4" y="13" width="7" height="7" rx="1.8" fill="#fff" opacity=".65"/><rect x="13" y="13" width="7" height="7" rx="1.8" fill="#fff"/>',
      // Rotate: page with a circular rotate arrow (white).
      rotate:   '<rect x="4.5" y="4.5" width="15" height="15" rx="2.6" fill="#fff" opacity=".22"/><path d="M16.6 9a4.6 4.6 0 1 0 1.1 3.7" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M17.2 6v3.2H14" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      // Word: white doc + a small "W" + corner arrow.
      word:     '<rect x="4.5" y="3.5" width="11" height="14" rx="2" fill="#fff"/><path d="M6.8 7l1.2 5 1.2-3.5L10.4 12l1.2-5" stroke="var(--icf-a)" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' + ARROW,
      // Excel: white doc + an "X" + corner arrow.
      excel:    '<rect x="4.5" y="3.5" width="11" height="14" rx="2" fill="#fff"/><path d="M7 7l4 6m0-6l-4 6" stroke="var(--icf-a)" stroke-width="1.4" fill="none" stroke-linecap="round"/>' + ARROW,
      // Image/JPG: photo frame + corner arrow.
      image:    '<rect x="3.5" y="4.5" width="13" height="11" rx="2" fill="#fff"/><circle cx="7" cy="8.5" r="1.3" fill="var(--icf-a)"/><path d="M4.8 14l3-3 2.2 2.2L12.5 10l3 3v1.2H4.8z" fill="var(--icf-a)"/>' + ARROW,
      // Markdown: white doc with an "M▾" glyph.
      markdown: '<rect x="4" y="6" width="16" height="12" rx="2.4" fill="#fff"/><path d="M7 15V9l2.3 2.6L11.6 9v6M15.2 9v3.6m0 0-1.4-1.3M15.2 12.6l1.4-1.3" stroke="var(--icf-a)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      // Compress: four inward corner arrows around a white box.
      compress: '<rect x="8" y="8" width="8" height="8" rx="1.6" fill="#fff"/><path d="M4.5 4.5l2.5 2.5M4.5 4.5h2.4M4.5 4.5v2.4M19.5 19.5l-2.5-2.5M19.5 19.5h-2.4M19.5 19.5v-2.4M19.5 4.5l-2.5 2.5M19.5 4.5h-2.4M19.5 4.5v2.4M4.5 19.5l2.5-2.5M4.5 19.5h2.4M4.5 19.5v-2.4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      // Repair: wrench crossing a screwdriver (white).
      sanitize: '<path d="M9.5 9.5l5 5m-5 0 1.3-1.3M9.5 14.5l-1.4 1.4a1.5 1.5 0 0 0 2.1 2.1l1.4-1.4M14.5 9.5l1.4-1.4a1.5 1.5 0 0 0-2.1-2.1L12.4 7.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      // OCR: white scan frame + text lines.
      ocr:      '<path d="M8 5.5H6a1 1 0 0 0-1 1v2M16 5.5h2a1 1 0 0 1 1 1v2M8 18.5H6a1 1 0 0 1-1-1v-2M16 18.5h2a1 1 0 0 0 1-1v-2" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M8.5 10.5h7M8.5 13.5h4.5" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
      // Unlock: open padlock (white).
      unlock:   '<rect x="5.5" y="10.5" width="13" height="9" rx="2" fill="#fff"/><path d="M8.5 10.5V7a3.5 3.5 0 0 1 6.7-1.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="12" cy="15" r="1.4" fill="var(--icf-a)"/>',
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
      rotate:   'M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10',
      addpage:  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6',
      addimage: 'M4 3h16v18H4zM9 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 16l-5-5L6 20',
      watermark:'M12 2C8 8 6 11 6 14a6 6 0 0 0 12 0c0-3-2-6-6-12z',
      pagenum:  'M6 4h12v16H6zM9 8h1v8M14 8h1v4a2 2 0 0 1-2 2',
      nup:      'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
      rmblank:  'M6 4h12v16H6zM9 9l6 6M15 9l-6 6',
      stamp:    'M5 21h14M12 3a3 3 0 0 1 3 3c0 2-2 3-2 5h-2c0-2-2-3-2-5a3 3 0 0 1 3-3zM8 13h8v4H8z',
      comment:  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
      compare:  'M9 3v18M3 7h6M3 11h6M15 3v18M15 7h6M15 11h6',
      sanitize: 'M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6zM9 12l2 2 4-4',
      template: 'M4 2h16v20H4zM8 6h8M8 18h8M9 10l6 4M15 10l-6 4',
      unlock:   'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5zM12 15v3',
      markdown: 'M4 5h16v14H4zM7 15V9l2.5 3L12 9v6M16 9v4m0 0l-1.5-1.5M16 13l1.5-1.5',
    };

    // Three simple groups (owner request Aug 2026): Edit · Convert · Tools.
    // Each card carries a one-line description (pro editors always label what a
    // tool does). Convert tiles open a direction submenu instead of two one-way
    // tiles; `isSub` marks those.
    // Full iLovePDF-style tool grid: every function as a labeled icon card,
    // grouped by category. "Assemble" leads (Neil, Aug 2026); the old "Edit PDF"
    // card is gone - dropping/opening a file already starts editing.
    // Exact layout Neil specified (Aug 2026): three rows only. Row 1 = the core
    // assemble tools; Convert = Word/Image direction-pickers + Excel; Optimize =
    // Compress/Repair/OCR. Everything else is reachable inside the editor once a
    // file is open; the landing stays minimal and user-friendly. (Editing is the
    // "Edit" badge on the dropzone card itself - no separate Edit PDF tile.)
    const ROWS = [
      { title: 'Assemble', cards: [
        ['Rotate PDF',    'Turn pages left or right',      '#4caf7d', IC.rotate,   () => pickPdfThen(() => revealTool('organize', '#rotateBtn'))],
        ['Rearrange PDF', 'Reorder and add pages',          '#8a6d3b', IC.organize, () => pickPdfThen(() => revealTool('organize', '#addPageBtn'))],
        ['Split PDF',     'Extract or separate pages',     '#3a97d4', IC.split,    () => pickPdfThen(() => revealTool('organize', '#splitBtn'))],
        ['Merge PDF',     'Combine files into one',        '#e8734a', IC.merge,    () => pickPdfThen(() => revealTool('organize', '#mergeBtn'))],
      ]},
      { title: 'Convert', cards: [
        ['Word ⇄ PDF',   'Convert either direction',      '#2b7cd3', IC.word, (card) => directionPick(card, [
          ['PDF → Word', () => pickPdfThen(() => revealExport('word'))],
          ['Word → PDF', () => docxPicker && docxPicker.click()],
        ]), true],
        ['Excel ⇄ PDF',  'Export tables to a spreadsheet','#1d7044', IC.excel, (card) => directionPick(card, [
          ['PDF → Excel', () => pickPdfThen(() => revealExport('excel'))],
        ]), true],
        ['JPG ⇄ PDF',    'Convert either direction',      '#c2588f', IC.image, (card) => directionPick(card, [
          ['PDF → JPG', () => pickPdfThen(() => revealExport('image'))],
          ['JPG → PDF', () => window.imageToPdfDialog && window.imageToPdfDialog()],
        ]), true],
        ['PDF → Markdown','Export text as a .md file',     '#3b6ea5', IC.markdown,  () => pickPdfThen(() => window.exportMarkdownTool && window.exportMarkdownTool())],
      ]},
      { title: 'Optimize', cards: [
        ['Compress PDF',  'Reduce the file size',          '#5c9e57', IC.compress,  () => pickPdfThen(() => revealTool('optimize', '#compressBtn'))],
        ['Repair PDF',    'Fix a damaged or corrupt PDF',  '#6b7280', IC.sanitize,  () => pickPdfThen(() => revealTool('optimize', '#sanitizeBtn'))],
        ['OCR (scanned)', 'Make scans searchable',         '#7dc243', IC.ocr,       () => pickPdfThen(() => revealTool('optimize', '#ocrBtn'))],
        ['Lock PDF',      'Password-protect the file',     '#d4506e', IC.protect,   () => pickPdfThen(() => revealTool('sign', '#protectBtn'))],
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
      '<span class="welcome-drop-hint">Upload a PDF up to 750 MB, or a Word (.docx, .doc) or image (PNG, JPG) file to convert into a PDF.</span>';
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
      // Reverse map: an IC path string → its key, so a card that passes IC.merge
      // can pick up the richer iLovePDF-style ICF.merge icon when one exists.
      const IC_KEY = {};
      for (const k in IC) IC_KEY[IC[k]] = k;
      for (const [label, desc, tint, path, fn, isSub] of row.cards) {
        const c = document.createElement('button');
        c.className = 'welcome-card';
        const key = IC_KEY[path];
        const rich = key && ICF[key];
        const iconSvg = rich
          // iLovePDF-style: white 2-tone marks on the colored tile. --icf-a is
          // the tile tint (for glyphs sitting ON white); --icf-d is a darker
          // shade for the corner-arrow badge.
          ? `<svg width="24" height="24" viewBox="0 0 24 24" style="--icf-a:${tint};--icf-d:color-mix(in srgb, ${tint} 78%, #000)">${rich}</svg>`
          : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
        c.innerHTML =
          `<span class="welcome-card-ic" style="background:${tint};color:#fff">${iconSvg}</span>` +
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
  // Select is NOT surfaced on the right (Pranshu) - it stays available via the
  // main tool row / keyboard, but the top-right cursor button is hidden. The
  // element remains in the DOM so app.js's listeners and setActiveTool('select')
  // resets keep working.
  const selBtn = el('#selectTool'); if (selBtn) selBtn.style.display = 'none';
  const keepRight = [el('#searchToggle'),
                     ...(IN_PORTAL ? [] : [el('#themeToggle')]), el('#undoBtn'), el('#redoBtn')];
  if (IN_PORTAL) { const tt = el('#themeToggle'); if (tt) tt.style.display = 'none'; }
  for (const b of keepRight) if (b) right.appendChild(b);
  // Print button — annotations flattened, real system print dialog
  const printBtn = document.createElement('button');
  printBtn.id = 'printBtn';
  printBtn.className = 'tool-btn';
  printBtn.title = 'Print with your markups (Cmd/Ctrl+P)'; printBtn.setAttribute('aria-label', 'Print');
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
  histBtn.title = 'Recent files'; histBtn.setAttribute('aria-label', 'Recent files');
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
  infoBtn.title = 'Document information (title, author, keywords)'; infoBtn.setAttribute('aria-label', 'Document information');
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
    headerBrand.title = 'PDF Tools';
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
      // Note: #selectTool is intentionally omitted - it stays hidden (Pranshu);
      // its listeners still work, it's just never surfaced in the top bar.
      for (const s of ['#openFileBtn', '#searchToggle', '#undoBtn', '#redoBtn', '#downloadBtn', '#printBtn']) {
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
      document.title = name ? `${name} — PDF Tools` : 'PDF Tools';
      // Landing-page card flow: the PDF just finished loading — run the tool
      // the user picked (buttons need a beat to enable first).
      if (name && pendingAction) { const fn = pendingAction; pendingAction = null; setTimeout(fn, 400); }
    };
    new MutationObserver(sync).observe(fileInfo, { childList: true, characterData: true, subtree: true });
    sync();
  }
})();
