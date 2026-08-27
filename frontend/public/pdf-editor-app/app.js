/* ================================================
   PDF Editor - Main Application Logic
   ================================================ */

(function () {
    'use strict';

    // ── Configure PDF.js worker ──
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

    // ── State ──
    const state = {
        pdfDoc: null,           // PDF.js document
        pdfBytes: null,         // Raw ArrayBuffer of original PDF
        currentPage: 1,
        totalPages: 0,
        zoom: 1.0,
        activeTool: 'select',
        fileName: '',
        // Per-page annotation data (serialized Fabric objects)
        annotations: {},
        // Undo/Redo stacks per page
        undoStacks: {},
        redoStacks: {},
        // Comments per page: { pageNum: [{ id, text, time }] }
        comments: {},
        // Annotation layers (document-wide): every markup is tagged with the
        // active layer's id; layers toggle visibility and skip export when off.
        layers: [{ id: 1, name: 'Layer 1', visible: true, color: null }],
        activeLayer: 1,
        nextLayerId: 2,
        viewMode: 'preview',
        thumbZoom: 1, // Pages-panel thumbnail size multiplier (slider)
        // AI state
        ollamaOnline: false,
        aiPanelOpen: false,
        aiAbortController: null,
    };

    // ── Dirty tracking: orange Save + guard against losing unsaved work ──
    let _isDirty = false;
    let _suppressRasterWarn = false;   // "don't warn again" for the redaction-flatten notice (S5)
    function markDirty(d = true) {
        _isDirty = d;
        const btn = document.getElementById('downloadBtn');
        if (btn) btn.classList.toggle('dirty', d);
    }
    window.addEventListener('beforeunload', (e) => {
        if (_isDirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Comment feature is PARKED for now (user request) — set true to restore.
    const COMMENTS_ENABLED = false;

    // ── DOM Elements ──
    const $ = (sel) => document.querySelector(sel);
    const dom = {
        fileInput: $('#fileInput'),
        imageInput: $('#imageInput'),
        openFileBtn: $('#openFileBtn'),
        downloadBtn: $('#downloadBtn'),
        undoBtn: $('#undoBtn'),
        redoBtn: $('#redoBtn'),
        dropZone: $('#dropZone'),
        editorArea: $('#editorArea'),
        pageNav: $('#pageNav'),
        canvasScrollWrapper: $('#canvasScrollWrapper'),
        canvasWrapper: $('#canvasWrapper'),
        pdfCanvas: $('#pdfCanvas'),
        fabricCanvasEl: $('#fabricCanvas'),
        prevPage: $('#prevPage'),
        nextPage: $('#nextPage'),
        pageInput: $('#pageInput'),
        totalPages: $('#totalPages'),
        zoomIn: $('#zoomIn'),
        zoomOut: $('#zoomOut'),
        zoomFit: $('#zoomFit'),
        zoomLevel: $('#zoomLevel'),
        colorPicker: $('#colorPicker'),
        sizePicker: $('#sizePicker'),
        sizeValue: $('#sizeValue'),
        opacityPicker: $('#opacityPicker'),
        opacityValue: $('#opacityValue'),
        fontFamily: $('#fontFamily'),
        paintBar: $('#paintBar'),
        mainContainer: document.querySelector('.main-container'),
        thumbnailList: $('#thumbnailList'),
        sidebar: $('#sidebar'),
        toggleSidebar: $('#toggleSidebar'),
        statusText: $('#statusText'),
        fileInfo: $('#fileInfo'),
        toolOptions: $('#toolOptions'),
        cropConfirmBar: $('#cropConfirmBar'),
        cropApply: $('#cropApply'),
        cropCancel: $('#cropCancel'),
        exportBtn: $('#exportBtn'),
        exportMenu: $('#exportMenu'),
        addPageBtn: $('#addPageBtn'),
        mergeBtn: $('#mergeBtn'),
        mergeInput: $('#mergeInput'),
        rotateBtn: $('#rotateBtn'),
        stampBtn: $('#stampBtn'),
        stampMenu: $('#stampMenu'),
        splitBtn: $('#splitBtn'),
        splitModal: $('#splitModal'),
        splitRange: $('#splitRange'),
        splitTotal: $('#splitTotal'),
        splitExtract: $('#splitExtract'),
        splitClose: $('#splitClose'),
        splitCancelBtn: $('#splitCancelBtn'),
        ocrBtn: $('#ocrBtn'),
        ocrProgress: $('#ocrProgress'),
        ocrStatus: $('#ocrStatus'),
        ocrProgressBar: $('#ocrProgressBar'),
        ocrCancelBtn: $('#ocrCancelBtn'),
        searchToggle: $('#searchToggle'),
        searchBar: $('#searchBar'),
        searchInput: $('#searchInput'),
        searchInfo: $('#searchInfo'),
        searchPrev: $('#searchPrev'),
        searchNext: $('#searchNext'),
        searchClose: $('#searchClose'),
        sidebarResizeHandle: $('#sidebarResizeHandle'),
        commentToggle: $('#commentToggle'),
        commentPanel: $('#commentPanel'),
        commentPageNum: $('#commentPageNum'),
        commentList: $('#commentList'),
        commentInput: $('#commentInput'),
        addCommentBtn: $('#addCommentBtn'),
        closeComments: $('#closeComments'),
        // Text format bar
        textFormatBar: $('#textFormatBar'),
        tbBold: $('#tbBold'),
        tbItalic: $('#tbItalic'),
        tbUnderline: $('#tbUnderline'),
        tbStrike: $('#tbStrike'),
        tbFontDec: $('#tbFontDec'),
        tbFontSize: $('#tbFontSize'),
        tbFontInc: $('#tbFontInc'),
        tbFontFamily: $('#tbFontFamily'),
        tbColor: $('#tbColor'),
        tbAlignLeft: $('#tbAlignLeft'),
        tbAlignCenter: $('#tbAlignCenter'),
        tbAlignRight: $('#tbAlignRight'),
        tbAiEdit: $('#tbAiEdit'),
        // Image edit bar
        imageEditBar: $('#imageEditBar'),
        ibFlipH: $('#ibFlipH'),
        ibFlipV: $('#ibFlipV'),
        ibOpacity: $('#ibOpacity'),
        ibOpacityVal: $('#ibOpacityVal'),
        ibBringFront: $('#ibBringFront'),
        ibSendBack: $('#ibSendBack'),
        ibCrop: $('#ibCrop'),
        // AI Edit modal
        aiEditModal: $('#aiEditModal'),
        closeAiEditModal: $('#closeAiEditModal'),
        aiEditOriginalText: $('#aiEditOriginalText'),
        aiEditInstruction: $('#aiEditInstruction'),
        aiEditRewriteBtn: $('#aiEditRewriteBtn'),
        aiEditResultSection: $('#aiEditResultSection'),
        aiEditResultText: $('#aiEditResultText'),
        aiEditFooter: $('#aiEditFooter'),
        aiEditApplyBtn: $('#aiEditApplyBtn'),
        aiEditCancelBtn: $('#aiEditCancelBtn'),
        // Export all progress
        exportAllProgress: $('#exportAllProgress'),
        exportAllStatus: $('#exportAllStatus'),
        exportAllBar: $('#exportAllBar'),
        // AI Replace / Stanza edit
        aiReplaceFind: $('#aiReplaceFind'),
        aiReplaceInstruction: $('#aiReplaceInstruction'),
        aiReplaceBtn: $('#aiReplaceBtn'),
        aiReplaceStatus: $('#aiReplaceStatus'),
        // AI Panel
        aiToggleBtn: $('#aiToggleBtn'),
        aiPanel: $('#aiPanel'),
        closeAiPanel: $('#closeAiPanel'),
        aiStatusDot: $('#aiStatusDot'),
        aiStatusText: $('#aiStatusText'),
        aiModelSelect: $('#aiModelSelect'),
        aiSummarizeBtn: $('#aiSummarizeBtn'),
        aiCurrentPageBtn: $('#aiCurrentPageBtn'),
        aiTagsBtn: $('#aiTagsBtn'),
        aiQuestionInput: $('#aiQuestionInput'),
        aiAskBtn: $('#aiAskBtn'),
        aiProgress: $('#aiProgress'),
        aiProgressLabel: $('#aiProgressLabel'),
        aiProgressBar: $('#aiProgressBar'),
        aiOutputArea: $('#aiOutputArea'),
    };

    // ── Fabric.js Canvas ──
    let fabricCanvas = null;
    let _isRestoring = false; // prevents saveAnnotationState from firing during loadFromJSON

    // ── Per-page text item cache (cleared on page/zoom change) ──
    // Format: [{ item, bbox: {left,top,width,height} }]
    let _textItemsCache = null;

    // ── Initialize ──
    function init() {
        setupEventListeners();
        setupAIPanel();
        setupTextFormatBar();
        setupImageEditBar();
        setupAiEditModal();
        setupTooltips();
        setupSignature();
        setupTheme();
    }

    // ── Instant custom tooltips (replace slow native title tooltips) ──
    // Uses event delegation so it also covers buttons created later
    // (thumbnails, dropdown items, contextual bars).
    function setupTooltips() {
        const tip = document.createElement('div');
        tip.id = 'customTooltip';
        document.body.appendChild(tip);

        let current = null;

        // Find the nearest ancestor (incl. self) that carries tooltip text.
        function tooltipTarget(el) {
            while (el && el !== document.body) {
                if (el.nodeType === 1 && (el.hasAttribute('title') || el.dataset.tip)) return el;
                el = el.parentElement;
            }
            return null;
        }

        function show(el) {
            // Move native title into data-tip so the OS tooltip never appears.
            if (el.hasAttribute('title')) {
                el.dataset.tip = el.getAttribute('title');
                el.removeAttribute('title');
            }
            const text = el.dataset.tip;
            if (!text) return;
            current = el;
            tip.textContent = text;
            tip.classList.add('visible');
            position(el);
        }

        function position(el) {
            const r = el.getBoundingClientRect();
            // Measure after content set
            const tw = tip.offsetWidth;
            const th = tip.offsetHeight;
            const gap = 8;
            let left = r.left + r.width / 2 - tw / 2;
            // Keep within viewport horizontally
            left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));

            let top = r.bottom + gap;
            let placement = 'below';
            // Flip above if it would overflow the bottom edge
            if (top + th > window.innerHeight - 6) {
                top = r.top - th - gap;
                placement = 'above';
            }
            tip.style.left = left + 'px';
            tip.style.top = top + 'px';
            tip.classList.remove('above', 'below');
            tip.classList.add(placement);
            // Point the arrow at the element's center
            const arrowX = Math.max(10, Math.min(r.left + r.width / 2 - left, tw - 10));
            tip.style.setProperty('--arrow-x', arrowX + 'px');
        }

        function hide() {
            current = null;
            tip.classList.remove('visible');
        }

        document.addEventListener('mouseover', (e) => {
            const el = tooltipTarget(e.target);
            if (el && el !== current) show(el);
        });
        document.addEventListener('mouseout', (e) => {
            if (current && (!e.relatedTarget || !current.contains(e.relatedTarget))) {
                if (tooltipTarget(e.relatedTarget) !== current) hide();
            }
        });
        // Hide on any click (e.g. after pressing a tool button)
        document.addEventListener('click', hide, true);
        // Hide when scrolling so it doesn't float in a stale position
        window.addEventListener('scroll', hide, true);
    }

    // ── Light / Dark theme toggle (persisted across sessions) ──
    function setupTheme() {
        const btn = document.getElementById('themeToggle');
        const apply = (theme) => {
            document.documentElement.setAttribute('data-theme', theme);
        };

        // Embedded in Nexus: the HOST owns the theme, so every module matches
        // (owner request Jul 30 - theme consistency across modules). The initial
        // value arrives as a ?theme= param so the very first paint is already
        // correct (no flash of the wrong theme); later changes arrive by
        // postMessage, because changing the iframe src would reload the engine
        // and throw away whatever document the user has open.
        if (window.parent !== window) {
            let initial = null;
            try { initial = new URLSearchParams(location.search).get('theme'); } catch (_) {}
            apply(initial === 'light' ? 'light' : 'dark');
            window.addEventListener('message', (e) => {
                if (e.origin !== window.location.origin) return;
                const d = e.data;
                if (d && d.type === 'nexus:theme' && (d.theme === 'light' || d.theme === 'dark')) apply(d.theme);
            });
            // The host's theme switch is the only control while embedded - a
            // second toggle in here would just drift out of sync with the shell.
            if (btn) btn.style.display = 'none';
            return;
        }

        // Follow the SYSTEM theme unless the user explicitly chose one here.
        const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
        let saved = null;
        try { saved = localStorage.getItem('pdfEditorTheme'); } catch (_) {}
        apply(saved || (mq && mq.matches ? 'light' : 'dark'));
        // Live-sync when the OS/main-app theme changes (only while on auto).
        if (mq && mq.addEventListener) mq.addEventListener('change', (e) => {
            let pref = null;
            try { pref = localStorage.getItem('pdfEditorTheme'); } catch (_) {}
            if (!pref) apply(e.matches ? 'light' : 'dark');
        });

        if (btn) {
            btn.addEventListener('click', () => {
                const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
                apply(next);
                try { localStorage.setItem('pdfEditorTheme', next); } catch (_) {}
                showToast(next === 'light' ? 'Light theme' : 'Dark theme');
            });
        }
    }

    // ── Signature feature: type your name, pick a handwriting style, drop it on the page ──
    // The signature is rasterized to a transparent PNG and added as a Fabric image, so the
    // chosen font is preserved exactly when the PDF is exported (via drawImageOnPDF).
    const SIGNATURE_FONTS = [
        { label: 'Classic',   font: "'Snell Roundhand', 'Savoye LET', cursive" },
        { label: 'Casual',    font: "'Bradley Hand', 'Segoe Script', cursive" },
        { label: 'Brush',     font: "'Brush Script MT', 'Snell Roundhand', cursive" },
        { label: 'Marker',    font: "'SignPainter', 'Bradley Hand', cursive" },
        { label: 'Elegant',   font: "'Savoye LET', 'Snell Roundhand', cursive" },
        { label: 'Formal',    font: "'Zapfino', 'Snell Roundhand', cursive" },
    ];

    function setupSignature() {
        const modal   = document.getElementById('signatureModal');
        const openBtn = document.getElementById('signatureBtn');
        const closeBtn = document.getElementById('signatureClose');
        const cancelBtn = document.getElementById('signatureCancelBtn');
        const insertBtn = document.getElementById('signatureInsert');
        const nameInput = document.getElementById('signatureName');
        const colorInput = document.getElementById('signatureColor');
        const styleList = document.getElementById('signatureStyleList');
        if (!modal || !openBtn) return;

        let selectedFont = SIGNATURE_FONTS[0].font;

        // Build the style option cards
        SIGNATURE_FONTS.forEach((s, idx) => {
            const opt = document.createElement('div');
            opt.className = 'signature-style-option' + (idx === 0 ? ' selected' : '');
            opt.dataset.font = s.font;
            opt.innerHTML = `<span class="sig-preview" style="font-family:${s.font}"></span>`;
            opt.addEventListener('click', () => {
                selectedFont = s.font;
                styleList.querySelectorAll('.signature-style-option')
                    .forEach((o) => o.classList.toggle('selected', o === opt));
            });
            styleList.appendChild(opt);
        });

        function refreshPreviews() {
            const name = nameInput.value.trim();
            const color = colorInput.value;
            styleList.querySelectorAll('.sig-preview').forEach((el) => {
                if (name) {
                    el.textContent = name;
                    el.style.color = color;
                    el.classList.remove('sig-placeholder');
                } else {
                    el.textContent = 'Your Name';
                    el.classList.add('sig-placeholder');
                    el.style.color = '';
                }
            });
        }

        function open() {
            if (!state.pdfDoc) return;
            modal.style.display = 'flex';
            refreshPreviews();
            nameInput.focus();
        }
        function close() { modal.style.display = 'none'; }

        openBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        nameInput.addEventListener('input', refreshPreviews);
        colorInput.addEventListener('input', refreshPreviews);
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); insertBtn.click(); }
        });

        insertBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) { showToast('Type your name first'); nameInput.focus(); return; }
            insertSignature(name, selectedFont, colorInput.value);
            close();
        });
    }

    // Rasterize the signature to a transparent PNG and add it to the canvas as an image.
    function insertSignature(name, fontFamily, color) {
        if (!fabricCanvas) return;
        const fontSize = 96;           // render large for crispness, then scale down
        const pad = 24;

        // Measure text width at the target font
        const measureCanvas = document.createElement('canvas');
        const mctx = measureCanvas.getContext('2d');
        mctx.font = `${fontSize}px ${fontFamily}`;
        const textWidth = Math.max(mctx.measureText(name).width, 20);

        const canvasW = Math.ceil(textWidth + pad * 2);
        const canvasH = Math.ceil(fontSize * 1.8 + pad * 2);

        const canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(name, pad, canvasH / 2);

        const dataUrl = canvas.toDataURL('image/png');
        fabric.Image.fromURL(dataUrl, (img) => {
            // Scale so the signature is a sensible size on the page (~40% canvas width, capped)
            const targetW = Math.min(fabricCanvas.width * 0.4, 320);
            const scale = targetW / img.width;
            img.scale(scale);
            img.set({
                left: fabricCanvas.width * 0.5 - targetW / 2,
                top: fabricCanvas.height * 0.65,
                cornerStyle: 'circle',
                transparentCorners: false,
                _isSignature: true,
            });
            fabricCanvas.add(img);
            fabricCanvas.setActiveObject(img);
            fabricCanvas.renderAll();
            setActiveTool('select');
            saveAnnotationState();
            showToast('Signature added — drag to position, corners to resize');
        });
    }

    // ── Event Listeners ──
    function setupEventListeners() {
        // File open
        dom.openFileBtn.addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', handleFileSelect);

        // Drag & drop
        dom.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dom.dropZone.classList.add('drag-over');
        });
        dom.dropZone.addEventListener('dragleave', () => {
            dom.dropZone.classList.remove('drag-over');
        });
        dom.dropZone.addEventListener('drop', handleFileDrop);

        // Also allow drop on the entire editor area
        dom.editorArea.addEventListener('dragover', (e) => e.preventDefault());
        dom.editorArea.addEventListener('drop', handleFileDrop);

        // Download
        dom.downloadBtn.addEventListener('click', downloadPDF);

        // Page navigation
        dom.prevPage.addEventListener('click', () => goToPage(state.currentPage - 1));
        dom.nextPage.addEventListener('click', () => goToPage(state.currentPage + 1));
        dom.pageInput.addEventListener('change', () => {
            const n = parseInt(dom.pageInput.value, 10);
            // Invalid or out-of-range input: snap the box back to the current
            // page instead of leaving stale/bad text sitting in it.
            if (!Number.isFinite(n) || n < 1 || n > state.totalPages) {
                dom.pageInput.value = state.currentPage;
                return;
            }
            goToPage(n);
        });

        // Zoom
        dom.zoomIn.addEventListener('click', () => setZoom(state.zoom + 0.15));
        dom.zoomOut.addEventListener('click', () => setZoom(state.zoom - 0.15));
        dom.zoomFit.addEventListener('click', fitToWidth);
        document.getElementById('zoomFitPage')?.addEventListener('click', fitToPage);
        // Ctrl/Cmd + mouse wheel zooms the document (like every desktop viewer),
        // instead of the browser zooming the whole page.
        dom.canvasScrollWrapper?.addEventListener('wheel', (e) => {
            if (!(e.ctrlKey || e.metaKey) || !state.pdfDoc) return;
            e.preventDefault();
            setZoom(state.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
        }, { passive: false });
        document.getElementById('scrollModeBtn')?.addEventListener('click', () => setScrollMode(!window.isScrollMode()));

        // Toolbar hide/show (Pranshu): collapse the tool rows to give the
        // document more vertical room. The main toolbar (Open/Save + tools) stays
        // as a slim bar; a second click restores everything.
        document.getElementById('toolbarToggle')?.addEventListener('click', () => {
            const collapsed = document.body.classList.toggle('toolbar-collapsed');
            const btn = document.getElementById('toolbarToggle');
            if (btn) {
                btn.title = collapsed ? 'Show toolbar' : 'Hide toolbar (more viewing space)';
                btn.setAttribute('aria-label', collapsed ? 'Show toolbar' : 'Hide toolbar');
            }
        });
        document.getElementById('printBtn')?.addEventListener('click', printPdf);

        // Tools
        document.querySelectorAll('[data-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                // Any tool the user clicks needs the single-page editable Fabric
                // canvas; in continuous-scroll mode that canvas is frozen, so
                // Select (and the others) did nothing on the default scroll view
                // (Pranshu). Leave scroll mode on an explicit tool click - not on
                // the internal setActiveTool('select') resets, which must not
                // yank the user out of scrolling.
                if (window.isScrollMode && window.isScrollMode()) _exitScrollForOp();
                setActiveTool(btn.dataset.tool);
            });
        });

        // Tool options - size slider
        dom.sizePicker.addEventListener('input', () => {
            dom.sizeValue.textContent = dom.sizePicker.value;
            updateSizePresetActive();
            // If a shape/line is selected, change ITS border thickness live so
            // the size picker doubles as a "manage border width" control.
            applyStrokeWidthToSelection(parseInt(dom.sizePicker.value, 10));
            if (fabricCanvas && fabricCanvas.isDrawingMode) {
                if (state.activeTool === 'eraser') {
                    // Eraser uses 2× size for better coverage
                    fabricCanvas.freeDrawingBrush.width = Math.max(parseInt(dom.sizePicker.value, 10) * 2, 10);
                    applyToolMode(); // re-apply to update cursor SVG
                } else {
                    fabricCanvas.freeDrawingBrush.width = parseInt(dom.sizePicker.value, 10);
                }
            } else if (fabricCanvas && state.activeTool === 'eraser') {
                // Annotation-erase mode isn't a drawing brush — just refresh the cursor size
                applyToolMode();
            }
        });

        // Size preset buttons
        document.querySelectorAll('.size-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const size = parseInt(btn.dataset.size, 10);
                dom.sizePicker.value = size;
                dom.sizeValue.textContent = size;
                updateSizePresetActive();
                applyStrokeWidthToSelection(size);
                if (fabricCanvas && fabricCanvas.isDrawingMode) {
                    fabricCanvas.freeDrawingBrush.width = size;
                }
            });
        });

        // Color picker
        dom.colorPicker.addEventListener('input', () => {
            updateSwatchActive();
            applyBrushColor();
        });

        // Color swatches
        document.querySelectorAll('.swatch').forEach((swatch) => {
            swatch.addEventListener('click', () => {
                if (!swatch.dataset.color) return; // custom-picker swatch has no preset color
                dom.colorPicker.value = swatch.dataset.color;
                updateSwatchActive();
                applyBrushColor();
            });
        });

        // Opacity slider
        dom.opacityPicker.addEventListener('input', () => {
            dom.opacityValue.textContent = dom.opacityPicker.value + '%';
            if (fabricCanvas && fabricCanvas.isDrawingMode) {
                applyBrushColor();
            }
        });

        // Sidebar toggle
        const syncSidebarReopen = () => {
            const btn = document.getElementById('sidebarReopen');
            if (btn) btn.classList.toggle('show', dom.sidebar.classList.contains('collapsed'));
        };
        dom.toggleSidebar.addEventListener('click', () => {
            dom.sidebar.classList.toggle('collapsed');
            syncSidebarReopen();
        });
        // Floating reopen tab (visible only while collapsed) brings Pages back.
        document.getElementById('sidebarReopen')?.addEventListener('click', () => {
            dom.sidebar.classList.remove('collapsed');
            syncSidebarReopen();
        });

        // Sidebar resize
        setupSidebarResize();

        // View mode switcher
        document.querySelectorAll('.view-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => setViewMode(btn.dataset.view));
        });

        // Eraser: Whiteout mode toggle
        const eraserWhiteoutCb = document.getElementById('eraserWhiteout');
        if (eraserWhiteoutCb) {
            eraserWhiteoutCb.addEventListener('change', () => {
                _eraserWhiteout = eraserWhiteoutCb.checked;
                if (state.activeTool === 'eraser') applyToolMode();
                showToast(_eraserWhiteout
                    ? 'Whiteout ON — covers original PDF text/images'
                    : 'Eraser removes your annotations only');
            });
        }

        // Undo / Redo
        dom.undoBtn.addEventListener('click', undo);
        dom.redoBtn.addEventListener('click', redo);

        // Image input
        dom.imageInput.addEventListener('change', handleImageSelect);

        // Crop
        dom.cropApply.addEventListener('click', applyCrop);
        dom.cropCancel.addEventListener('click', cancelCrop);

        // Merge & Add Page
        dom.mergeBtn.addEventListener('click', () => dom.mergeInput.click());
        dom.mergeInput.addEventListener('change', handleMergeSelect);
        dom.addPageBtn.addEventListener('click', addBlankPage);
        // Add Images as new pages (Organize tab) → opens a multi-select picker.
        const addImagePageInput = document.getElementById('addImagePageInput');
        document.getElementById('addImagePageBtn')?.addEventListener('click', () => addImagePageInput?.click());
        addImagePageInput?.addEventListener('change', (e) => {
            if (e.target.files?.length) appendImagesAsPages(e.target.files);
            e.target.value = ''; // allow re-selecting the same files later
        });
        const templatePageBtn = document.getElementById('templatePageBtn');
        if (templatePageBtn) templatePageBtn.addEventListener('click', addTemplatePage);

        // Comments
        dom.commentToggle.addEventListener('click', toggleCommentPanel);
        dom.closeComments.addEventListener('click', toggleCommentPanel);
        dom.addCommentBtn.addEventListener('click', addComment);
        dom.commentInput.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                addComment();
            }
        });

        // Rotate
        dom.rotateBtn.addEventListener('click', rotatePage);

        // Stamp dropdown
        dom.stampBtn.addEventListener('click', toggleStampMenu);
        dom.stampMenu.querySelectorAll('.dropdown-item').forEach((item) => {
            item.addEventListener('click', () => {
                addStamp(item.dataset.stamp);
                dom.stampMenu.classList.remove('open');
            });
        });

        // Export dropdown
        dom.exportBtn.addEventListener('click', toggleExportMenu);
        dom.exportMenu.querySelectorAll('.dropdown-item').forEach((item) => {
            item.addEventListener('click', () => {
                exportAs(item.dataset.export);
                dom.exportMenu.classList.remove('open');
            });
        });

        // Close all dropdowns on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#stampBtn') && !e.target.closest('#stampMenu')) {
                dom.stampMenu.classList.remove('open');
            }
            if (!e.target.closest('#exportBtn') && !e.target.closest('#exportMenu')) {
                dom.exportMenu.classList.remove('open');
            }
        });

        // Split
        dom.splitBtn.addEventListener('click', openSplitModal);
        dom.splitClose.addEventListener('click', closeSplitModal);
        dom.splitCancelBtn.addEventListener('click', closeSplitModal);
        dom.splitExtract.addEventListener('click', splitPDF);
        dom.splitModal.addEventListener('click', (e) => {
            if (e.target === dom.splitModal) closeSplitModal();
        });

        // OCR
        dom.ocrBtn.addEventListener('click', runOCR);
        dom.ocrCancelBtn.addEventListener('click', cancelOCR);

        // Search
        dom.searchToggle.addEventListener('click', toggleSearchBar);
        dom.searchClose.addEventListener('click', closeSearchBar);
        dom.searchInput.addEventListener('input', debounce(searchText, 300));
        dom.searchPrev.addEventListener('click', () => navigateSearch(-1));
        dom.searchNext.addEventListener('click', () => navigateSearch(1));
        dom.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateSearch(e.shiftKey ? -1 : 1);
            }
        });
        // S8: match-case / whole-word toggles + results-list toggle.
        const toggleOpt = (id, apply) => {
            const b = document.getElementById(id);
            if (!b) return;
            b.addEventListener('click', () => {
                const on = b.getAttribute('aria-pressed') !== 'true';
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.classList.toggle('active', on);
                apply(on);
            });
        };
        toggleOpt('searchCase', (on) => { _searchCase = on; searchText(); });
        toggleOpt('searchWord', (on) => { _searchWord = on; searchText(); });
        document.getElementById('searchListToggle')?.addEventListener('click', () => {
            const panel = document.getElementById('searchResultsPanel');
            const b = document.getElementById('searchListToggle');
            const show = panel.style.display === 'none';
            panel.style.display = show ? 'block' : 'none';
            b.setAttribute('aria-pressed', show ? 'true' : 'false');
            b.classList.toggle('active', show);
            if (show) _renderSearchResults();
        });

        // AI Panel
        dom.aiToggleBtn.addEventListener('click', toggleAiPanel);
        dom.closeAiPanel.addEventListener('click', toggleAiPanel);

        // Pages-panel thumbnail size slider: scales instantly via CSS, then
        // re-renders sharp thumbnails when the user stops dragging.
        const thumbZoom = document.getElementById('thumbZoom');
        if (thumbZoom) {
            let tzTimer = null;
            thumbZoom.addEventListener('input', () => {
                state.thumbZoom = parseInt(thumbZoom.value, 10) / 100;
                dom.thumbnailList.style.setProperty('--tz', state.thumbZoom);
                clearTimeout(tzTimer);
                tzTimer = setTimeout(() => { if (state.pdfDoc) generateThumbnails(); }, 350);
            });
        }

        // Document tools
        document.getElementById('watermarkBtn')?.addEventListener('click', addWatermarkTool);
        document.getElementById('pageNumBtn')?.addEventListener('click', addPageNumbersTool);
        document.getElementById('compressBtn')?.addEventListener('click', compressPdfTool);
        document.getElementById('formsBtn')?.addEventListener('click', fillFormsTool);
        document.getElementById('protectBtn')?.addEventListener('click', addPasswordTool);
        document.getElementById('compareBtn')?.addEventListener('click', comparePdfsTool);
        document.getElementById('sanitizeBtn')?.addEventListener('click', sanitizePdfTool);
        document.getElementById('rmBlankBtn')?.addEventListener('click', removeBlankPagesTool);
        document.getElementById('nupBtn')?.addEventListener('click', nUpTool);
        document.getElementById('measureListClose')?.addEventListener('click', () => window.toggleMeasureList());
        document.getElementById('measureExportBtn')?.addEventListener('click', () => window.exportMeasurements());
        document.getElementById('measureFilter')?.addEventListener('input', (e) => {
            window._measureFilter = e.target.value; if (window.renderMeasureList) window.renderMeasureList();
        });
        document.getElementById('measureSort')?.addEventListener('change', (e) => {
            window._measureSort = e.target.value; if (window.renderMeasureList) window.renderMeasureList();
        });
        document.getElementById('scaleChip')?.addEventListener('click', () => window.openSetScaleDialog && window.openSetScaleDialog());

        // Keyboard shortcuts
        document.addEventListener('keydown', handleKeyboard);
    }

    // ── Keyboard Shortcuts ──
    function handleKeyboard(e) {
        if (!state.pdfDoc) return;

        // Don't intercept when typing in input fields or editing Fabric text
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (fabricCanvas) {
            const activeObj = fabricCanvas.getActiveObject();
            if (activeObj && activeObj.isEditing) {
                // Escape exits text editing cleanly instead of leaving the box in
                // an editing/selected limbo (B5).
                if (e.key === 'Escape') {
                    e.preventDefault(); e.stopImmediatePropagation();
                    activeObj.exitEditing();
                    fabricCanvas.discardActiveObject();
                    fabricCanvas.requestRenderAll();
                    hideContextualBars();
                    setStatus('Ready');
                }
                return;
            }
        }

        const ctrl = e.ctrlKey || e.metaKey;

        // Polyline/polygon: Enter finishes, Escape cancels the in-progress shape.
        if (polyKind) {
            if (e.key === 'Enter') { e.preventDefault(); polyFinish(); return; }
            if (e.key === 'Escape') { e.preventDefault(); polyCancel(); return; }
        }
        // Measurement in progress: Enter finishes, Escape cancels ONLY the
        // measurement (never the ribbon - M10), Backspace removes the last point.
        if (measureKind) {
            if (e.key === 'Enter') { e.preventDefault(); measureFinish(); return; }
            // stopPropagation so the ribbon's window-level Escape can't also fire.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); measureCancel(); setStatus('Measurement cancelled'); return; }
            if (e.key === 'Backspace' && measurePts.length) {
                e.preventDefault(); measurePts.pop(); measureRedraw();
                setStatus(measurePts.length ? 'Removed last point - ' + measurePts.length + ' left' : 'Click to start again');
                return;
            }
        }
        // A measure tool is armed but nothing drawn yet: Escape disarms the
        // measure engine in place and returns to the Select cursor WITHOUT
        // touching the Assemble ribbon (M10). We flip tool state directly rather
        // than via setActiveTool, whose button path collapses the ribbon.
        if (e.key === 'Escape' && state.activeTool === 'shape' && _MEASURE_KINDS.includes(shapeKind)) {
            e.preventDefault();
            // Stop the event reaching the ribbon's own Escape handler (it would
            // collapse Assemble). We disarm the tool here, so by the time that
            // handler ran isMeasureActive() would already be false - hence stopping
            // propagation, not relying on the guard, is what fixes M10.
            // stopImmediatePropagation covers the case where both handlers sit on
            // the same target and registration order would otherwise decide.
            e.stopImmediatePropagation();
            document.getElementById('measureTool')?.classList.remove('active');
            shapeKind = 'rect';                // leave the measure engine
            state.activeTool = 'select';
            document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
            applyToolMode();
            setStatus('Measure tool off');
            return;
        }

        if (e.key === 'F1' || (ctrl && e.key === '/')) {
            e.preventDefault();
            toggleShortcutsOverlay();
            return;
        }
        if (ctrl && e.key === 'p') {
            e.preventDefault();
            printPdf();
            return;
        }
        if (ctrl && e.key === 'z') {
            e.preventDefault();
            undo();
        } else if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
            e.preventDefault();
            redo();
        } else if (ctrl && e.key === 's') {
            e.preventDefault();
            downloadPDF();
        } else if (ctrl && e.key === 'f') {
            e.preventDefault();
            toggleSearchBar();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (fabricCanvas) {
                const active = fabricCanvas.getActiveObjects();
                if (active.length > 0) {
                    let hadMeasure = false;
                    active.forEach((obj) => {
                        if (obj._measure) { hadMeasure = true; _removeMeasureExtras(obj._measure._mid); }
                        fabricCanvas.remove(obj);
                    });
                    fabricCanvas.discardActiveObject();
                    fabricCanvas.renderAll();
                    saveAnnotationState();
                    if (hadMeasure && window.renderMeasureList) window.renderMeasureList();
                }
            }
        } else if (!ctrl && !e.altKey) {
            switch (e.key.toLowerCase()) {
                case 'v': setActiveTool('select'); break;
                case 't': setActiveTool('text'); break;
                case 'd': setActiveTool('draw'); break;
                case 'h': setActiveTool('highlight'); break;
                case 'r': setActiveTool('shape'); break;
                case 'e': setActiveTool('eraser'); break;
                case 'i': setActiveTool('image'); break;
                case 'c': setActiveTool('crop'); break;
            }
        }
    }

    // ── File Handling ──
    async function handleFileSelect(e) {
        const file = e.target.files[0];
        e.target.value = ''; // allow re-picking the same file later
        if (!file) return;
        await _openOrMergeFile(file);
    }

    // Shared by the Open button AND drag-and-drop: if a document is already
    // open, ask whether to REPLACE it (open as new) or MERGE the picked file in,
    // so a drop never silently discards unsaved edits.
    async function _openOrMergeFile(file) {
        const hasDoc = !!(state.pdfDoc && state.pdfBytes);
        if (hasDoc) {
            const choice = await _choiceModal('Open PDF', 'A document is already open. What would you like to do?', [
                { key: 'new',   label: 'Open as new PDF' },
                { key: 'merge', label: 'Merge into current PDF' },
            ]);
            if (!choice) return;                       // cancelled
            if (choice === 'merge') { await mergeFilesIntoDoc([file]); return; }
        }
        loadPDF(file);
    }

    // Merge one or more picked files into the currently open document, reusing
    // the same engine as the Merge button (so Open→Merge and Merge stay in sync).
    async function mergeFilesIntoDoc(files) {
        await handleMergeSelect({ target: { files, value: '' } });
    }

    function handleFileDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        dom.dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
            _openOrMergeFile(file);   // same open-as-new / merge prompt as the Open button
        } else if (file) {
            showToast('Please drop a valid PDF file');
        }
    }

    async function loadPDF(file) {
        setStatus('Loading PDF...');
        // Snapshot the currently-open document so a failed open doesn't leave
        // state.pdfBytes (new, bad) disagreeing with state.pdfDoc (old) - which
        // would make a later save/merge use the wrong bytes.
        const _prevBytes = state.pdfBytes, _prevName = state.fileName;
        state.fileName = file.name;

        try {
            const arrayBuffer = await file.arrayBuffer();
            state.pdfBytes = arrayBuffer.slice(0); // keep a copy

            let pdf;
            let pdfPassword = null;
            for (let attempt = 0; ; attempt++) {
                try {
                    pdf = await pdfjsLib.getDocument({
                        data: arrayBuffer.slice(0), fontExtraProperties: true,
                        ...(pdfPassword ? { password: pdfPassword } : {}),
                    }).promise;
                    break;
                } catch (err) {
                    // Locked PDF → ASK for the password instead of erroring out
                    if (err && err.name === 'PasswordException' && attempt < 3) {
                        pdfPassword = await customPrompt(
                            attempt === 0 ? 'This PDF is password-protected. Enter the password:'
                                          : 'Wrong password — try again:', 'Password');
                        if (!pdfPassword) { setStatus('Open cancelled — password required'); return; }
                        continue;
                    }
                    throw err;
                }
            }
            // Remember the password that unlocked this file (if any). state.pdfBytes
            // still holds the ENCRYPTED original, so any tool that re-loads it with
            // pdf-lib (Unlock, save, merge...) needs this to actually decrypt.
            state.pdfPassword = pdfPassword || null;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            // Tear down any continuous view from a previous document so the new
            // one builds fresh (it's now kept hidden between edits, not destroyed).
            if (typeof destroyScrollView === 'function') destroyScrollView();
            _savedScrollTop = null;
            state.pdfDoc = pdf;
            state.totalPages = pdf.numPages;
            state.currentPage = 1;
            state.annotations = {};
            state.undoStacks = {};
            state.redoStacks = {};
            state.comments = {};
            state.layers = [{ id: 1, name: 'Layer 1', visible: true, color: null }];
            state.activeLayer = 1;
            state.nextLayerId = 2;
            _docUndoStack.length = 0; // C1: never undo across documents
            markDirty(false);
            if (window.renderLayersPanel) window.renderLayersPanel();
            if (COMMENTS_ENABLED) importPdfComments(); // comment feature parked

            // Update UI
            dom.dropZone.style.display = 'none';
            dom.pageNav.style.display = 'flex';
            dom.canvasScrollWrapper.style.display = 'flex';
            dom.downloadBtn.disabled = false;
            dom.exportBtn.disabled = false;
            dom.mergeBtn.disabled = false;
            dom.addPageBtn.disabled = false;
            dom.commentToggle.disabled = false;
            dom.rotateBtn.disabled = false;
            dom.stampBtn.disabled = false;
            dom.splitBtn.disabled = false;
            dom.ocrBtn.disabled = false;
            _ocrRunning = false;
            const sigBtn = document.getElementById('signatureBtn');
            if (sigBtn) sigBtn.disabled = false;
            const tplBtn = document.getElementById('templatePageBtn');
            if (tplBtn) tplBtn.disabled = false;
            for (const id of ['watermarkBtn', 'pageNumBtn', 'compressBtn', 'formsBtn',
                              'protectBtn', 'compareBtn', 'sanitizeBtn', 'rmBlankBtn', 'nupBtn', 'addImagePageBtn']) {
                const b = document.getElementById(id);
                if (b) b.disabled = false;
            }
            dom.searchToggle.disabled = false;
            // Show the search bar by default so users can search without knowing
            // Ctrl+F (Pranshu). It stays docked top-right; the x still closes it.
            if (dom.searchBar) {
                dom.searchBar.style.display = 'flex';
                if (dom.searchInfo) dom.searchInfo.textContent = '0/0';
            }
            dom.aiToggleBtn.disabled = false;
            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;

            // Initialize Fabric canvas
            initFabricCanvas();

            // Fit to the screen width first, then open in continuous scroll by
            // default so the user can scroll the whole document immediately.
            // fitToWidth() defers its work into a rAF (waits for layout), so we
            // enable scroll on a short timeout AFTER that — a plain double-rAF
            // could race fitToWidth and build the scroll view before the zoom is
            // set, leaving it un-scrollable. The timeout guarantees layout+fit
            // are done first.
            fitToWidth();
            setTimeout(() => {
                if (state.pdfDoc && window.setScrollMode && !window.isScrollMode()) setScrollMode(true);
            }, 120);

            // Generate thumbnails
            generateThumbnails();

            setStatus('PDF loaded successfully');
            // Tell the Nexus shell a document is open, so it can hide the top bar
            // for full-bleed editing (the landing screen keeps the bar).
            try { window.parent && window.parent.postMessage({ type: 'pdf-editor:doc-state', hasDoc: true }, '*'); } catch (_) {}
        } catch (err) {
            console.error(err);
            // A malformed/damaged PDF: try to REPAIR it with pdf-lib (which is
            // far more tolerant) before giving up, like a real viewer.
            try {
                setStatus('File looks damaged — attempting repair...');
                const repaired = await PDFLib.PDFDocument.load(
                    file ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(state.pdfBytes),
                    { ignoreEncryption: true, throwOnInvalidObject: false });
                const fixed = await repaired.save();
                showToast('PDF was damaged — opened a repaired copy');
                setStatus('Opened a repaired copy of a damaged PDF');
                return await loadPDF(new File([fixed], (file && file.name) || 'repaired.pdf', { type: 'application/pdf' }));
            } catch (err2) {
                // Total failure: restore the previous document's bytes so state
                // stays consistent (state.pdfDoc still points at the old doc).
                state.pdfBytes = _prevBytes;
                state.fileName = _prevName;
                setStatus('Error loading PDF: ' + err.message);
                showToast('This PDF could not be opened (damaged beyond repair)');
            }
        }
    }

    // ── Fabric Canvas Setup ──
    function initFabricCanvas() {
        if (fabricCanvas) {
            fabricCanvas.dispose();
        }
        fabricCanvas = new fabric.Canvas('fabricCanvas', {
            isDrawingMode: false,
            selection: true,
            preserveObjectStacking: true,
        });

        // Save state on object modifications
        fabricCanvas.on('object:modified', (e) => {
            if (e && e.target && e.target.excludeFromExport) return; // crop box etc.
            // Reshaping/moving a measurement must recompute its value (M3).
            if (e && e.target && e.target._measure && typeof _remeasureShape === 'function') {
                _remeasureShape(e.target);
            }
            // A dragged caption gets/updates its leader line back to the anchor (M22).
            if (e && e.target && e.target._measureCaption && typeof _updateLeaderFor === 'function') {
                _updateLeaderFor(e.target);
            }
            saveAnnotationState();
        });
        // Live leader while dragging a caption.
        fabricCanvas.on('object:moving', (e) => {
            if (e && e.target && e.target._measureCaption && typeof _updateLeaderFor === 'function') {
                _updateLeaderFor(e.target);
            }
        });
        fabricCanvas.on('object:added', (e) => {
            const o = e && e.target;
            // Tag new markups with the active layer (not restores or UI helpers)
            if (o && !_isRestoring && !o.excludeFromExport && o._layerId === undefined) {
                o._layerId = state.activeLayer;
            }
            saveAnnotationState();
            updateUndoRedoButtons();
        });
        fabricCanvas.on('object:removed', (e) => {
            if (e && e.target && e.target === cropRect) {
                cropRect = null;
                clearCropDimOverlay();
                updateCropDims();
                if (typeof _syncCropApply === 'function') _syncCropApply();
            }
            updateUndoRedoButtons();
        });

        // When an eraser path finishes being drawn, mark it as non-selectable
        fabricCanvas.on('path:created', (e) => {
            if (state.activeTool === 'eraser' && e.path) {
                e.path.set({
                    selectable: false,
                    evented: false,
                    _isEraserPath: true,
                });
                fabricCanvas.renderAll();
            }
        });

        // Handle text tool click
        fabricCanvas.on('mouse:down', handleCanvasClick);

        // Right-click a measurement on the canvas -> the same context menu as the
        // list row (M7: Edit / Duplicate / Copy / Delete).
        if (fabricCanvas.upperCanvasEl) {
            fabricCanvas.upperCanvasEl.addEventListener('contextmenu', (ev) => {
                // Compute the click point in canvas space from the raw DOM event
                // (getPointer expects a fabric-wrapped event; on a bare contextmenu
                // it can misfire). Account for the CSS<->backing-store scale.
                const el = fabricCanvas.upperCanvasEl;
                const r = el.getBoundingClientRect();
                const sx = (fabricCanvas.getWidth() || r.width) / r.width;
                const sy = (fabricCanvas.getHeight() || r.height) / r.height;
                const p = { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
                const hit = _measureHitAt(p);
                if (hit && hit._measure && typeof _measureRowMenu === 'function') {
                    ev.preventDefault();
                    _measureRowMenu(ev, hit._measure._mid);
                }
            });
        }

        // Handle shape drawing
        fabricCanvas.on('mouse:down', handleShapeStart);
        fabricCanvas.on('mouse:move', handleShapeMove);
        fabricCanvas.on('mouse:up', handleShapeEnd);

        // Multi-click markups (polyline / polygon): click to add points,
        // double-click to finish. Uses its own click/move handlers.
        fabricCanvas.on('mouse:down', polyAddPoint);
        fabricCanvas.on('mouse:move', polyMove);
        fabricCanvas.on('mouse:dblclick', polyFinish);

        // Count tool: each click drops a numbered marker.
        fabricCanvas.on('mouse:down', handleCountClick);

        // Measurement / dimension tools (calibrate, length, perimeter, area).
        fabricCanvas.on('mouse:down', handleMeasureClick);
        fabricCanvas.on('mouse:move', handleMeasureMove);
        fabricCanvas.on('mouse:dblclick', measureFinish);

        // Text-snap highlight / underline / strikethrough
        fabricCanvas.on('mouse:down', handleHilightStart);
        fabricCanvas.on('mouse:move', handleHilightMove);
        fabricCanvas.on('mouse:up', handleHilightEnd);

        // Comment-on-text (armed from the comment panel)
        fabricCanvas.on('mouse:down', handleTextCommentStart);
        fabricCanvas.on('mouse:move', handleTextCommentMove);
        fabricCanvas.on('mouse:up', handleTextCommentEnd);

        // Select-cursor text selection → Highlight/Comment mini-toolbar
        fabricCanvas.on('mouse:down', handleSelTextDown);
        fabricCanvas.on('mouse:up', handleSelTextUp);

        // Handle eraser (drag-to-delete annotations, or whiteout brush)
        fabricCanvas.on('object:moving', handleCropAdjust);
        fabricCanvas.on('object:scaling', handleCropAdjust);

        fabricCanvas.on('mouse:down', handleEraserDown);
        fabricCanvas.on('mouse:move', handleEraserMove);
        fabricCanvas.on('mouse:move', updateEraserCursor);   // Paint-style round cursor
        fabricCanvas.on('mouse:out', clearEraserCursor);
        fabricCanvas.on('mouse:up', handleEraserUp);

        // Handle crop
        fabricCanvas.on('mouse:down', handleCropStart);
        fabricCanvas.on('mouse:move', handleCropMove);
        fabricCanvas.on('mouse:up', handleCropEnd);

        // Handle edit text (explicit tool mode)
        fabricCanvas.on('mouse:down', handleEditTextClick);

        // Double-click on canvas → edit PDF text directly (works in any mode)
        fabricCanvas.on('mouse:dblclick', handleCanvasDblClick);

        // Hover → change cursor to text cursor over PDF text
        fabricCanvas.on('mouse:move', handleCanvasHover);

        // Contextual bars for selected objects
        fabricCanvas.on('selection:created', (e) => showContextualBar(e.selected && e.selected[0]));
        fabricCanvas.on('selection:updated', (e) => showContextualBar(e.selected && e.selected[0]));
        fabricCanvas.on('selection:cleared', () => hideContextualBars());
    }

    // Double-click: enter text edit mode regardless of active tool
    function handleCanvasDblClick(opt) {
        // Only act if not already in an annotation tool that handles its own dblclick
        if (['draw', 'highlight', 'crop', 'shape'].includes(state.activeTool)) return;
        // If double-clicking an existing Fabric object, let Fabric handle it
        if (opt.target) return;
        // Enter PDF text edit at the clicked position
        enterTextEditMode(opt);
    }

    // Cursor changes to text cursor when hovering over selectable PDF text
    let _lastHoverWasText = false;
    function handleCanvasHover(opt) {
        if (!_textItemsCache) return;
        // Don't interfere with draw/highlight/crop/shape tools
        if (['draw', 'highlight', 'crop', 'shape'].includes(state.activeTool)) return;
        // Don't override cursor when hovering a Fabric object
        if (opt.target) {
            if (_lastHoverWasText) {
                fabricCanvas.defaultCursor = 'default';
                _lastHoverWasText = false;
            }
            return;
        }
        const p = fabricCanvas.getPointer(opt.e);
        const hit = findTextItemAt(p.x, p.y, 3);
        if (hit && !_lastHoverWasText) {
            fabricCanvas.defaultCursor = 'text';
            _lastHoverWasText = true;
        } else if (!hit && _lastHoverWasText) {
            fabricCanvas.defaultCursor = 'default';
            _lastHoverWasText = false;
        }
    }

    // ── Render Page ──
    async function renderPage(pageNum) {
        if (!state.pdfDoc) return;

        // Save current page annotations before switching
        if (fabricCanvas && state.currentPage !== pageNum) {
            saveCurrentAnnotations();
        }

        state.currentPage = pageNum;
        dom.pageInput.value = pageNum;
        // Each sheet can carry its own stored scale (Store Scale in Page).
        _applyStoredScaleForPage(pageNum);

        setStatus(`Rendering page ${pageNum}...`);

        try {
            // Cancel any in-flight render — two renders on one canvas throw
            // and leave the page blank until the next successful pass.
            if (state._renderTask) { try { state._renderTask.cancel(); } catch (_) {} }
            const page = await state.pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: state.zoom * 1.5 }); // 1.5 for retina

            // Resize PDF canvas
            const pdfCanvas = dom.pdfCanvas;
            pdfCanvas.width = viewport.width;
            pdfCanvas.height = viewport.height;
            pdfCanvas.style.width = (viewport.width / 1.5) + 'px';
            pdfCanvas.style.height = (viewport.height / 1.5) + 'px';

            // Render PDF page
            const ctx = pdfCanvas.getContext('2d');
            state._renderTask = page.render({ canvasContext: ctx, viewport });
            try { await state._renderTask.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; throw e; }
            state._renderTask = null;

            // Resize Fabric canvas to match display size
            const displayWidth = viewport.width / 1.5;
            const displayHeight = viewport.height / 1.5;
            fabricCanvas.setWidth(displayWidth);
            fabricCanvas.setHeight(displayHeight);

            // Invalidate text cache — new page/zoom means positions changed
            _textItemsCache = null;

            // Restore annotations for this page
            restoreAnnotations(pageNum);

            // Update thumbnail active state
            updateThumbnailActive();

            // Update navigation button states
            dom.prevPage.disabled = pageNum <= 1;
            dom.nextPage.disabled = pageNum >= state.totalPages;

            // Update comment panel for this page
            refreshCommentPanel();

            setStatus(`Page ${pageNum} of ${state.totalPages}`);

            // Pre-populate text cache in background (ready for hover/click)
            buildTextItemsCache(pageNum);
            renderPageLinks(pageNum);

            // Search highlights must track every re-render (zoom, page ops)
            if (dom.searchBar.style.display === 'flex' && searchResults.length) {
                drawPageSearchHighlights();
            } else {
                clearSearchHighlights();
            }
        } catch (err) {
            console.error(err);
            setStatus('Error rendering page: ' + err.message);
        }
    }

    // Build the text item cache for the current page at current zoom.
    // Each entry stores:
    //   bbox      — hit-detection box (generous, includes line spacing)
    //   baseline  — exact PDF text baseline Y in display pixels
    //   fontSizePx — exact font size in display pixels (from transform matrix)
    let _cacheGen = 0;
    async function buildTextItemsCache(pageNum) {
        const token = ++_cacheGen;
        try {
            const page = await state.pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            // A newer build started, or the user moved on — discard this one.
            if (token !== _cacheGen || pageNum !== state.currentPage) return;
            const viewport = page.getViewport({ scale: state.zoom });
            _textItemsCache = textContent.items
                .filter(item => item.str.trim())
                .map(item => {
                    const tx = item.transform;
                    const [vx, vy] = viewport.convertToViewportPoint(tx[4], tx[5]);

                    // Font size in PDF user-space units. Use the full vertical
                    // scale of the text matrix - hypot(tx[1], tx[3]) - NOT tx[3]
                    // alone: when the matrix carries any skew/scale (common), tx[3]
                    // under-reports and the edit box came up SMALLER than the
                    // original glyphs, so double-click appeared to shrink the word
                    // (Pranshu). This matches how search highlights measure size.
                    // Multiplied by zoom -> exact size in display pixels, kept
                    // fractional so the edit matches and exports at the true size.
                    const fontUnits = Math.hypot(tx[1] || 0, tx[3] || 0) || Math.abs(tx[3]);
                    const fontSizePx = Math.max(fontUnits * state.zoom, 6);

                    // Hit-detection box: use item.height (line height) when available for
                    // a generous clickable area, but fall back to fontSizePx.
                    const lineHeightPx = Math.max(
                        (item.height > 0 ? item.height : Math.abs(tx[3])) * state.zoom,
                        fontSizePx
                    );
                    const w = Math.max(item.width * state.zoom, 10);

                    return {
                        item,
                        // baseline = vy (PDF text origin = baseline in viewport coords)
                        baseline: vy,
                        fontSizePx,
                        bbox: {
                            left:   vx,
                            top:    vy - lineHeightPx,  // above baseline
                            width:  w,
                            height: lineHeightPx + fontSizePx * 0.25, // descender allowance
                        },
                    };
                });
        } catch (_) { _textItemsCache = null; }
    }

    // Find the text item at a given canvas display position (with optional padding)
    function findTextItemAt(x, y, pad = 4) {
        if (!_textItemsCache) return null;
        for (const entry of _textItemsCache) {
            const { left, top, width, height } = entry.bbox;
            if (x >= left - pad && x <= left + width + pad &&
                y >= top  - pad && y <= top  + height + pad) {
                return entry;
            }
        }
        return null;
    }

    // ── Annotation Persistence (per page) ──
    function saveCurrentAnnotations() {
        if (!fabricCanvas) return;
        if (window.isScrollMode && window.isScrollMode()) return; // scroll mode: editor canvas is frozen
        // Store fabricData + the zoom level at which it was captured so
        // downloadPDF can correctly scale coordinates back to PDF space.
        state.annotations[state.currentPage] = {
            fabricData: fabricCanvas.toJSON(),
            zoom: state.zoom,
        };
    }

    function restoreAnnotations(pageNum) {
        if (!fabricCanvas) return;
        _isRestoring = true;
        fabricCanvas.clear();
        const entry = state.annotations[pageNum];
        if (entry) {
            // Support both the new { fabricData, zoom } format and old plain-JSON format
            const data = entry.fabricData || entry;
            fabricCanvas.loadFromJSON(data, () => {
                // Drop orphans of deleted layers, then apply layer visibility.
                const ids = new Set(state.layers.map(l => l.id));
                fabricCanvas.forEachObject((o) => {
                    if (o._layerId !== undefined && !ids.has(o._layerId)) fabricCanvas.remove(o);
                });
                applyLayerVisibility();
                _isRestoring = false;
                fabricCanvas.renderAll();
                applyToolMode();
                renderImportedCommentMarks(pageNum);
            });
        } else {
            _isRestoring = false;
            applyToolMode();
            renderImportedCommentMarks(pageNum);
        }
        updateUndoRedoButtons();
    }

    // Rotate a page's stored annotations by `deg` (90/180/270, CW) so markups
    // follow the page instead of being discarded (M4). Fabric coordinates are in
    // canvas px at the capture zoom; for 90 CW on a W x H canvas a point (x,y) ->
    // (H - y, x) and the canvas becomes H x W. Measurements keep their values -
    // geomPx (length/area) is rotation-invariant; only positions + angles move.
    async function _rotatePageAnnotations(pageNum, deg) {
        const entry = state.annotations[pageNum];
        if (!entry) return;
        const data = entry.fabricData || entry;
        if (!data.objects || !data.objects.length) return;
        const zoom = entry.zoom || 1;
        // Pre-rotation canvas dimensions from the CURRENT pdf.js page (still the
        // old orientation at this point) at the capture zoom.
        let W, H;
        try {
            const pj = await state.pdfDoc.getPage(pageNum);
            const vp = pj.getViewport({ scale: zoom });
            W = vp.width; H = vp.height;
        } catch (_) { return; }   // can't map without dimensions - leave as-is
        const times = ((deg / 90) % 4 + 4) % 4;
        if (!times) return;
        // Enliven the objects so fabric's own geometry model does the transform,
        // then rotate each about the canvas center-mapping for a 90 CW step. Doing
        // it on live objects (not raw JSON) avoids the local-vs-absolute coordinate
        // traps of line x1/y1 and polygon points.
        const objs = await new Promise((res) => fabric.util.enlivenObjects(data.objects, res));
        for (let t = 0; t < times; t++) {
            const mapPt = (x, y) => ({ x: H - y, y: x });   // 90 CW on W x H canvas
            objs.forEach((o) => {
                if (!o) return;
                const c = o.getCenterPoint();          // absolute center, all types
                const nc = mapPt(c.x, c.y);
                o.angle = ((o.angle || 0) + 90) % 360;  // rotate orientation
                o.setPositionByOrigin(new fabric.Point(nc.x, nc.y), 'center', 'center');
                o.setCoords();
            });
            [W, H] = [H, W];
        }
        // Re-serialize with the same custom props the export list carries so
        // _measure etc. survive. toObject was patched globally to include them.
        const rotated = objs.filter(Boolean).map(o => o.toObject());
        const newData = { ...data, objects: rotated };
        if (entry.fabricData) entry.fabricData = newData; else state.annotations[pageNum] = newData;
        // Drop this page's undo/redo history: the pre-rotation snapshots are in
        // the old coordinate space. (Rotate itself is undoable via pushDocSnapshot.)
        delete state.undoStacks[pageNum];
        delete state.redoStacks[pageNum];
    }

    // Debounced thumbnail refresh so markups appear in the strip (B8) without
    // re-rendering every thumbnail on each stroke.
    let _thumbRefreshT = null;
    function _scheduleThumbRefresh() {
        if (_thumbRefreshT) clearTimeout(_thumbRefreshT);
        _thumbRefreshT = setTimeout(() => { _thumbRefreshT = null; try { generateThumbnails(); } catch (_) {} }, 900);
    }

    // ── Undo / Redo ──
    function saveAnnotationState() {
        // Skip if we're in the middle of restoring annotations (loadFromJSON fires object:added)
        if (_isRestoring) return;
        markDirty();
        _scheduleThumbRefresh();   // reflect the new/changed markup in thumbnails (B8)
        const page = state.currentPage;
        if (!state.undoStacks[page]) state.undoStacks[page] = [];
        // Seed a baseline snapshot representing the canvas *before* this action so
        // the very first annotation on a page can be undone (undo needs length > 1).
        if (state.undoStacks[page].length === 0) {
            const baseline = fabricCanvas.toJSON();
            baseline.objects = [];
            state.undoStacks[page].push(JSON.stringify(baseline));
        }
        const snap = fabricCanvas.toJSON();
        snap.__zoom = state.zoom; // snapshot is only valid at this zoom
        state.undoStacks[page].push(JSON.stringify(snap));
        // Limit stack size
        if (state.undoStacks[page].length > 50) {
            state.undoStacks[page].shift();
        }
        // Clear redo stack on new action
        state.redoStacks[page] = [];
        updateUndoRedoButtons();
    }

    function undo() {
        const page = state.currentPage;
        const stack = state.undoStacks[page];
        if (!stack || stack.length <= 1) {
            if (_docUndoStack.length) undoDocChange(); // e.g. undo a crop
            return;
        }

        const current = stack.pop();
        if (!state.redoStacks[page]) state.redoStacks[page] = [];
        state.redoStacks[page].push(current);

        const prev = stack[stack.length - 1];
        const fabricData = JSON.parse(prev);
        const snapZoom = fabricData.__zoom || state.zoom;
        _isRestoring = true;
        fabricCanvas.loadFromJSON(fabricData, () => {
            // The snapshot was taken at snapZoom — rescale to the current zoom.
            if (Math.abs(snapZoom - state.zoom) > 0.001) rescaleCanvasObjects(state.zoom / snapZoom);
            const liveIds = new Set(state.layers.map(l => l.id));
            fabricCanvas.forEachObject((o) => {
                if (o._layerId !== undefined && !liveIds.has(o._layerId)) fabricCanvas.remove(o);
            });
            applyLayerVisibility();
            _isRestoring = false;
            fabricCanvas.renderAll();
            applyToolMode();
            saveCurrentAnnotations(); // re-tag with the CURRENT zoom, coords now match
        });
        updateUndoRedoButtons();
    }

    function redo() {
        const page = state.currentPage;
        const redoStack = state.redoStacks[page];
        if (!redoStack || redoStack.length === 0) return;

        const next = redoStack.pop();
        if (!state.undoStacks[page]) state.undoStacks[page] = [];
        state.undoStacks[page].push(next);

        const fabricData = JSON.parse(next);
        const snapZoom = fabricData.__zoom || state.zoom;
        _isRestoring = true;
        fabricCanvas.loadFromJSON(fabricData, () => {
            if (Math.abs(snapZoom - state.zoom) > 0.001) rescaleCanvasObjects(state.zoom / snapZoom);
            const liveIds = new Set(state.layers.map(l => l.id));
            fabricCanvas.forEachObject((o) => {
                if (o._layerId !== undefined && !liveIds.has(o._layerId)) fabricCanvas.remove(o);
            });
            applyLayerVisibility();
            _isRestoring = false;
            fabricCanvas.renderAll();
            applyToolMode();
            saveCurrentAnnotations();
        });
        updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
        const page = state.currentPage;
        dom.undoBtn.disabled = (!state.undoStacks[page] || state.undoStacks[page].length <= 1)
            && _docUndoStack.length === 0;
        dom.redoBtn.disabled = !state.redoStacks[page] || state.redoStacks[page].length === 0;
    }

    // ── Page Navigation ──
    // If continuous scroll is active, drop back to single-page mode before any
    // structural change so ops target the real editor canvas, not stale pages.
    function _exitScrollForOp() { if (window.isScrollMode && window.isScrollMode()) setScrollMode(false); }

    function goToPage(num) {
        if (num < 1 || num > state.totalPages) return;
        // In continuous-scroll mode, scroll to the page and stay in scroll mode
        // (what a user expects from clicking a thumbnail). Only fall back to the
        // single-page renderer when scroll mode isn't active.
        if (window.isScrollMode && window.isScrollMode() && window.scrollToScrollPage(num)) return;
        saveCurrentAnnotations();
        renderPage(num);
    }

    // ── Zoom ──
    // Rescale all annotations by a zoom ratio so they stay locked to the page
    // (same physical size/position relative to the PDF) when the zoom changes.
    // Without this, edited text drifts and exports at the wrong size.
    function rescaleCanvasObjects(ratio) {
        if (!fabricCanvas || !ratio || ratio === 1) return;
        fabricCanvas.getObjects().forEach((o) => {
            o.left = (o.left || 0) * ratio;
            o.top = (o.top || 0) * ratio;
            if (o.type === 'i-text' || o.type === 'text' || o.type === 'textbox') {
                // Scale font size (keeps text crisp) rather than object scale
                o.fontSize = (o.fontSize || 16) * ratio;
            } else {
                o.scaleX = (o.scaleX || 1) * ratio;
                o.scaleY = (o.scaleY || 1) * ratio;
            }
            if (o.strokeWidth) o.strokeWidth = o.strokeWidth * ratio;
            o.setCoords();
        });
        fabricCanvas.renderAll();
    }

    function setZoom(level) {
        const oldZoom = state.zoom;
        state.zoom = Math.max(0.25, Math.min(4, level));
        dom.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
        // In continuous-scroll mode, rebuild the stacked pages at the new zoom
        // instead of the single-page canvas.
        if (window.isScrollMode && window.isScrollMode()) {
            window.rerenderScrollForZoom();
            return;
        }
        // Rescale live annotations to the new zoom, THEN save — so the stored
        // coordinates and the stored zoom label always stay consistent.
        rescaleCanvasObjects(state.zoom / oldZoom);
        saveCurrentAnnotations();
        renderPage(state.currentPage);
    }

    function _maybeScrollZoom() { if (window.isScrollMode && window.isScrollMode()) { window.rerenderScrollForZoom(); return true; } return false; }
    // Apply a freshly computed zoom to whichever view is active. In continuous
    // scroll the single-page canvas is frozen, so renderPage() would do nothing
    // (that was the "Fit does nothing" bug) - re-render the scroll view instead.
    function _applyFitZoom(newZoom) {
        const oldZoom = state.zoom;
        state.zoom = Math.max(0.25, Math.min(4, newZoom));
        dom.zoomLevel.textContent = Math.round(state.zoom * 100) + '%';
        rescaleCanvasObjects(state.zoom / oldZoom);
        saveCurrentAnnotations();
        if (window.isScrollMode && window.isScrollMode()) {
            window.rerenderScrollForZoom();   // resize every scroll page to the new zoom
        } else {
            renderPage(state.currentPage);
        }
    }

    function fitToPage() {
        if (!state.pdfDoc) return;
        requestAnimationFrame(() => {
            state.pdfDoc.getPage(state.currentPage).then((page) => {
                const viewport = page.getViewport({ scale: 1 });
                const availW = dom.editorArea.clientWidth - 60;
                const availH = dom.canvasScrollWrapper.clientHeight - 30;
                if (availW <= 0 || availH <= 0) return;
                _applyFitZoom(Math.min(availW / viewport.width, availH / viewport.height));
            });
        });
    }

    function fitToWidth() {
        if (!state.pdfDoc) return;
        // Wait one animation frame so the browser has finished layout
        // (editorArea.clientWidth may be 0 if called immediately after display:flex)
        requestAnimationFrame(() => {
            state.pdfDoc.getPage(state.currentPage).then((page) => {
                const viewport = page.getViewport({ scale: 1 });
                const containerWidth = dom.editorArea.clientWidth - 60; // padding
                if (containerWidth <= 0) return; // layout not ready, skip
                _applyFitZoom(containerWidth / viewport.width);
            });
        });
    }

    // ── Tool Management ──
    function setActiveTool(tool) {
        state.activeTool = tool;

        // Update button states
        document.querySelectorAll('[data-tool]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        // The Measure button has no data-tool; clear its active state whenever a
        // different tool is chosen (it re-highlights when a measure kind is picked).
        const mBtn = document.getElementById('measureTool');
        if (mBtn && tool !== 'shape') mBtn.classList.remove('active');

        // Clean up crop if switching away from crop tool
        if (tool !== 'crop' && cropRect) {
            cleanupCrop();
        }
        if (tool !== 'crop') {
            dom.cropConfirmBar.style.display = 'none';
        }

        // If image tool, open file picker immediately
        if (tool === 'image') {
            dom.imageInput.click();
            return;
        }

        applyToolMode();
    }

    function applyToolMode() {
        if (!fabricCanvas) return;

        // While any tool other than Select is active, PDF link overlays must not
        // intercept clicks (N1: mid-measurement clicks were jumping to hyperlinked
        // sheets). A wrapper class flips their pointer-events off via CSS.
        if (dom.canvasWrapper) dom.canvasWrapper.classList.toggle('markup-active', state.activeTool !== 'select');

        // Show/hide paint bar for draw/highlight tools
        const isPaintTool = ['draw', 'highlight', 'eraser', 'shape'].includes(state.activeTool);
        dom.paintBar.classList.toggle('visible', isPaintTool);
        dom.mainContainer.classList.toggle('with-paint-bar', isPaintTool);

        // Show the Whiteout toggle only while the eraser is active
        const eraserOptions = document.getElementById('eraserOptions');
        if (eraserOptions) eraserOptions.style.display = state.activeTool === 'eraser' ? 'flex' : 'none';

        // The color/size/font strip is retired: the TEXT formatting bar
        // (shown when text is selected/edited) carries all those controls.
        const toolOptions = document.getElementById('toolOptions');
        if (toolOptions) toolOptions.style.display = 'none';

        // Unmount the text/image contextual bar when the tool changes, unless the
        // new tool is Select (where a text selection legitimately keeps it) - B3.
        // Prevents the formatting row lingering after a tool/ribbon switch and the
        // ~36px layout jump it caused (B7).
        if (state.activeTool !== 'select') {
            if (fabricCanvas.getActiveObject()) { _isRestoring = true; fabricCanvas.discardActiveObject(); _isRestoring = false; }
            hideContextualBars();
        }

        // Reset modes
        clearEraserCursor();
        // Remove edit-text guide boxes unless we're (re)entering that tool.
        if (state.activeTool !== 'edittext') clearEditTextGuides();
        fabricCanvas.isDrawingMode = false;
        fabricCanvas.selection = true;
        fabricCanvas.defaultCursor = 'default';
        fabricCanvas.hoverCursor = 'move';
        fabricCanvas.forEachObject((obj) => {
            obj.selectable = true;
            obj.evented = true;
        });

        switch (state.activeTool) {
            case 'select':
                fabricCanvas.defaultCursor = 'default';
                break;

            case 'text':
                fabricCanvas.defaultCursor = 'text';
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((obj) => {
                    obj.selectable = false;
                    obj.evented = false;
                });
                break;

            case 'draw': {
                fabricCanvas.isDrawingMode = true;
                const size = parseInt(dom.sizePicker.value, 10) || 4;
                const userOpacity = parseInt(dom.opacityPicker.value, 10) / 100;
                const col = dom.colorPicker.value;
                let brush;
                switch (drawMode) {
                    case 'pencil': // thin, light, slightly rough — like graphite
                        brush = new fabric.PencilBrush(fabricCanvas);
                        brush.width = Math.max(1, Math.round(size * 0.55));
                        brush.color = hexToRgba(col, userOpacity * 0.65);
                        brush.decimate = 2.5; // less smoothing = pencil grain
                        break;
                    case 'marker': // broad, semi-transparent, flat tip
                        brush = new fabric.PencilBrush(fabricCanvas);
                        brush.width = Math.max(8, size * 2.2);
                        brush.color = hexToRgba(col, userOpacity * 0.55);
                        brush.strokeLineCap = 'butt';
                        break;
                    case 'spray': // airbrush
                        brush = new fabric.SprayBrush(fabricCanvas);
                        brush.width = Math.max(14, size * 3);
                        brush.density = 22;
                        brush.dotWidth = Math.max(1, size * 0.25);
                        brush.color = hexToRgba(col, userOpacity);
                        break;
                    default: // pen — smooth, solid, round tip
                        brush = new fabric.PencilBrush(fabricCanvas);
                        brush.width = size;
                        brush.color = hexToRgba(col, userOpacity);
                        brush.strokeLineCap = 'round';
                }
                fabricCanvas.freeDrawingBrush = brush;
                break;
            }

            case 'highlight': {
                if (highlightMode === 'free') {
                    fabricCanvas.isDrawingMode = true;
                    fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
                    const hlOpacity = Math.min(parseInt(dom.opacityPicker.value, 10) / 100, 0.4);
                    fabricCanvas.freeDrawingBrush.color = hexToRgba(dom.colorPicker.value, hlOpacity);
                    fabricCanvas.freeDrawingBrush.width = Math.max(20, parseInt(dom.sizePicker.value, 10) * 3);
                } else {
                    // Text-snap modes: drag over text, marks snap to the words.
                    fabricCanvas.defaultCursor = 'text';
                    fabricCanvas.selection = false;
                    fabricCanvas.forEachObject((o) => { o.selectable = false; o.evented = false; });
                    if (!_textItemsCache) buildTextItemsCache(state.currentPage);
                }
                break;
            }

            case 'shape':
                fabricCanvas.defaultCursor = 'crosshair';
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((obj) => {
                    obj.selectable = false;
                    obj.evented = false;
                });
                break;

            case 'eraser': {
                const eraserSize = Math.max(parseInt(dom.sizePicker.value, 10) * 2, 10);
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((obj) => { obj.selectable = false; obj.evented = false; });

                if (_eraserWhiteout) {
                    // Whiteout mode: paint the sampled background color over content
                    // (covers original PDF text / images — like a redaction/whiteout).
                    fabricCanvas.isDrawingMode = true;
                    fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
                    fabricCanvas.freeDrawingBrush.color = _eraserBgColor || '#ffffff';
                    fabricCanvas.freeDrawingBrush.width = eraserSize;
                    fabricCanvas.freeDrawingBrush.strokeLineCap = 'round';
                    fabricCanvas.freeDrawingBrush.strokeLineJoin = 'round';
                } else {
                    // Default mode: remove ONLY your annotations — drag over highlights,
                    // drawings and shapes to delete them. Never touches the PDF text.
                    fabricCanvas.isDrawingMode = false;
                }

                // Round cursor visualises the eraser size in either mode
                const strokeCol = _eraserWhiteout ? '%23c0392b' : '%23666';
                const cursorSvg = `<svg xmlns='http://www.w3.org/2000/svg' width='${eraserSize}' height='${eraserSize}'><circle cx='${eraserSize/2}' cy='${eraserSize/2}' r='${eraserSize/2 - 1}' fill='none' stroke='#666' stroke-width='1.5'/></svg>`;
                fabricCanvas.defaultCursor = `url("data:image/svg+xml,${encodeURIComponent(cursorSvg).replace('%23666', strokeCol)}") ${eraserSize/2} ${eraserSize/2}, crosshair`;
                break;
            }

            case 'crop':
                fabricCanvas.defaultCursor = 'crosshair';
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((obj) => {
                    obj.selectable = false;
                    obj.evented = false;
                });
                dom.cropConfirmBar.style.display = 'flex';
                _syncCropApply();   // starts disabled until a rectangle is drawn (B9)
                break;

            case 'edittext':
                setStatus('Edit Text: click any highlighted block to edit it - font, size and style are kept');
                fabricCanvas.defaultCursor = 'text';
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((obj) => {
                    // Allow re-editing existing text objects
                    if (obj.type === 'i-text') {
                        obj.selectable = true;
                        obj.evented = true;
                    } else {
                        obj.selectable = false;
                        obj.evented = false;
                    }
                });
                // Outline every editable text block so the user sees what's editable.
                showEditTextGuides();
                break;
        }
    }

    // ── Text Tool ──
    function handleCanvasClick(opt) {
        if (state.activeTool !== 'text') return;

        const pointer = fabricCanvas.getPointer(opt.e);

        // Don't add text if clicking on existing object
        if (opt.target) return;

        const text = new fabric.IText('Type here', {
            left: pointer.x,
            top: pointer.y,
            fontSize: parseInt(dom.sizePicker.value, 10) + 14,
            fontFamily: dom.fontFamily.value,
            fill: dom.colorPicker.value,
            editable: true,
            cursorColor: dom.colorPicker.value,
        });

        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
        text.selectAll();
    }

    // ── Shape Tool (rect / circle / triangle / line / arrow / cloud) ──
    let shapeStartPoint = null;
    let currentShape = null;
    let shapeKind = 'rect';
    let shapeStyle = 'solid'; // solid | dashed | dotted
    // Exposed so the UI layer's Shape dropdown can pick the shape type/style.
    window.setShapeKind = (k) => {
        // Switching tools (or re-picking one) must abandon any half-drawn
        // measurement - otherwise the leftover points + preview leak into the
        // next tool and it finishes a bogus shape from the old anchor.
        if (k !== shapeKind) { try { measureCancel(); } catch (_) {} }
        shapeKind = k;
        // One-line hint per measure tool so the click sequence + snapping is discoverable.
        const hints = {
            mangle:  'Angle: click first ray end, then the vertex, then the second ray end',
            mradius: 'Radius: click the center, then the edge (shows radius + diameter)',
            mvolume: 'Volume: outline the area, double-click to finish, then enter a depth',
            mcount:  'Count: click to drop markers - the list tallies them',
            mdynfill:'Dynamic fill: click inside an enclosed room to auto-measure its area',
            mlength: 'Length: click two points. Hold Shift for straight/45 deg; snaps to nearby ends',
            mpolylen:'Polyline length: click points along a run, double-click to finish (one total)',
            mperim:  'Perimeter: click points, double-click to close. Shift = ortho, snaps to ends',
            marea:   'Area: click points, double-click to close. Shift = ortho, snaps to ends',
            mcutout: 'Area cutout: click inside an area, then outline the void, double-click to subtract',
        };
        if (hints[k]) setStatus(hints[k]);
        // Re-apply tool mode so freshly-finished measurements become
        // non-selectable while a measure tool is armed (M18: a click starts a
        // point instead of selecting an existing markup).
        if (_MEASURE_KINDS && _MEASURE_KINDS.includes(k) && state.activeTool === 'shape') {
            try { applyToolMode(); } catch (_) {}
            // The Measure button is the visually-active one, not Shapes (N4).
            document.getElementById('shapeTool')?.classList.remove('active');
            document.getElementById('measureTool')?.classList.add('active');
        }
    };
    window.setShapeStyle = (s) => { shapeStyle = s; };
    // Activate the shape tool for the measure engine WITHOUT opening the Shapes
    // dropdown (M9). Leaves scroll mode first so the edit canvas is live.
    window.activateShapeToolForMeasure = () => {
        if (window.isScrollMode && window.isScrollMode()) _exitScrollForOp();
        setActiveTool('shape');
    };
    const shapeDash = (w) => shapeStyle === 'dashed' ? [w * 3.5, w * 2.5]
        : shapeStyle === 'dotted' ? [Math.max(1, w * 0.5), w * 2.2] : null;

    // Revision-cloud path: semicircular bumps around the bounding box perimeter.
    function cloudPathString(w, h) {
        const r = Math.max(7, Math.min(16, Math.min(w, h) / 6));
        const nx = Math.max(2, Math.round(w / (2 * r)));
        const ny = Math.max(2, Math.round(h / (2 * r)));
        const sx = w / nx, sy = h / ny;
        let d = 'M 0 0 ';
        for (let i = 0; i < nx; i++) d += `A ${sx / 2} ${r} 0 0 1 ${(i + 1) * sx} 0 `;
        for (let i = 0; i < ny; i++) d += `A ${r} ${sy / 2} 0 0 1 ${w} ${(i + 1) * sy} `;
        for (let i = nx; i > 0; i--) d += `A ${sx / 2} ${r} 0 0 1 ${(i - 1) * sx} ${h} `;
        for (let i = ny; i > 0; i--) d += `A ${r} ${sy / 2} 0 0 1 0 ${(i - 1) * sy} `;
        return d + 'Z';
    }

    // ── Multi-click markups: polyline & polygon ────────────────────────────────
    // Unlike drag shapes, these collect points on each click and finish on
    // double-click (or Enter/Escape). polyKind is set when such a tool is armed.
    let polyPts = [];          // committed points [{x,y}, ...]
    let polyPreview = null;     // live fabric object being previewed
    let polyKind = null;        // 'polyline' | 'polygon' while collecting

    function polyStyleBase() {
        const sw = parseInt(dom.sizePicker.value, 10) || 2;
        return {
            fill: polyKind === 'polygon' ? 'transparent' : '',
            stroke: dom.colorPicker.value,
            strokeWidth: sw,
            strokeDashArray: shapeDash(sw),
            strokeLineJoin: 'round',
            strokeLineCap: shapeStyle === 'dotted' ? 'round' : 'butt',
            selectable: false,
            objectCaching: false,
        };
    }
    function polyRedraw(livePt) {
        if (polyPreview) { _isRestoring = true; fabricCanvas.remove(polyPreview); _isRestoring = false; polyPreview = null; }
        const pts = livePt ? [...polyPts, livePt] : [...polyPts];
        if (pts.length < 2) return;
        const base = polyStyleBase();
        polyPreview = (polyKind === 'polygon')
            ? new fabric.Polygon(pts, base)
            : new fabric.Polyline(pts, { ...base, fill: '' });
        _isRestoring = true;
        fabricCanvas.add(polyPreview);
        _isRestoring = false;
        fabricCanvas.renderAll();
    }
    function polyAddPoint(opt) {
        if (state.activeTool !== 'shape' || (shapeKind !== 'polyline' && shapeKind !== 'polygon')) return;
        if (opt.target && !polyKind) return; // clicking an existing object, not drawing
        polyKind = shapeKind;
        const p = fabricCanvas.getPointer(opt.e);
        polyPts.push({ x: p.x, y: p.y });
        if (polyPts.length === 1) setStatus('Click to add points - double-click (or Enter) to finish, Esc to cancel');
        polyRedraw();
    }
    function polyMove(opt) {
        if (!polyKind || !polyPts.length) return;
        const p = fabricCanvas.getPointer(opt.e);
        polyRedraw({ x: p.x, y: p.y });
    }
    function polyFinish() {
        if (!polyKind) return;
        if (polyPreview) { _isRestoring = true; fabricCanvas.remove(polyPreview); _isRestoring = false; polyPreview = null; }
        const need = polyKind === 'polygon' ? 3 : 2;
        if (polyPts.length >= need) {
            const base = polyStyleBase();
            base.selectable = true;
            const final = (polyKind === 'polygon')
                ? new fabric.Polygon(polyPts, base)
                : new fabric.Polyline(polyPts, { ...base, fill: '' });
            fabricCanvas.add(final);
            final.setCoords();
            saveAnnotationState();
            saveCurrentAnnotations();
        }
        polyPts = []; polyKind = null;
        fabricCanvas.renderAll();
        setStatus('Ready');
    }
    function polyCancel() {
        if (polyPreview) { _isRestoring = true; fabricCanvas.remove(polyPreview); _isRestoring = false; polyPreview = null; }
        polyPts = []; polyKind = null;
        fabricCanvas.renderAll();
    }

    // ── Count tool ─────────────────────────────────────────────────────────────
    // When the 'count' shape kind is active, each click drops a numbered marker.
    // The number auto-increments across clicks so you can tally items on a plan.
    // The count is per current session/page; markers carry _countMark so a live
    // total can be read from the canvas.
    let countNext = 1;
    function countNextNumber() {
        // Resume numbering after the highest existing count marker on this page.
        let max = 0;
        if (fabricCanvas) fabricCanvas.forEachObject((o) => { if (o._countMark && o._countNum > max) max = o._countNum; });
        return max + 1;
    }
    function handleCountClick(opt) {
        if (state.activeTool !== 'shape' || shapeKind !== 'count') return;
        // S2: the old Shapes Count is unified with Measure > Count so there's ONE
        // tally in the Markups list. Delegate to the measure count engine.
        if (opt.target && (opt.target._countMark || opt.target._measurePt)) return;
        const p = fabricCanvas.getPointer(opt.e);
        placeCountMarker(p);
    }

    // ── Measurement / Dimension (Bluebeam-style, with scale calibration) ────────
    // measureScale = real-world units per PAGE pixel (i.e. at zoom 1). Set once by
    // calibrating against a known distance; then length/area/perimeter read out in
    // real units. Stored per-document; persists until re-calibrated or a new doc.
    let measureScale = null;   // number (units per page-pixel) | null = uncalibrated
    let measureUnit = 'ft';    // display unit label
    let _scaleLocked = false;  // when true, Calibrate/Set Scale are blocked
    // Per-page stored scales: page number -> { scale, unit }. "Store Scale in
    // Page" saves here so each sheet keeps its own calibration across page
    // switches, save, and reload.
    const _pageScales = {};
    // Live-scale chip updater; reassigned to the real implementation below. A
    // let-with-stub avoids a temporal-dead-zone error from callers that run
    // during the first page render.
    let _updateScaleChip = function () {};
    function _applyStoredScaleForPage(pg) {
        const s = _pageScales[pg];
        if (s) { measureScale = s.scale; measureUnit = s.unit; }
        else { measureScale = null; }   // each sheet is independent (M2)
        if (typeof _updateScaleChip === 'function') _updateScaleChip();
    }
    // Express the live scale as a readable "1 in = X ft" plus unit + precision +
    // lock, for the toolbar chip (M6). measureScale is real-units per page-pixel;
    // page-pixels are PDF points, so 1 inch = 72 px.
    function _scaleChipText() {
        if (!measureScale) return 'No scale - click to set';
        const perInch = measureScale * 72;   // real units represented by 1 inch on the page
        const shown = perInch >= 100 ? perInch.toFixed(0) : perInch.toFixed(2);
        return '1 in = ' + shown + ' ' + measureUnit + '  ·  ' + measureUnit + '  ·  ' + _mPrecision() + 'dp' + (_scaleLocked ? '  🔒' : '');
    }
    _updateScaleChip = function () {
        const chip = document.getElementById('scaleChip');
        if (chip) {
            chip.style.display = (state && state.pdfDoc) ? 'inline-flex' : 'none';
            chip.textContent = _scaleChipText();
            chip.classList.toggle('scale-chip-unset', !measureScale);
        }
        // Keep the Measure menu's scale + lock labels honest (M6/M29).
        if (window.updateMeasureMenuLabels) {
            const perInch = measureScale ? measureScale * 72 : 0;
            const scaleText = measureScale
                ? 'Scale: 1 in = ' + (perInch >= 100 ? perInch.toFixed(0) : perInch.toFixed(2)) + ' ' + measureUnit + ' (click to change)'
                : 'Set scale directly...';
            window.updateMeasureMenuLabels({ scaleText, locked: _scaleLocked });
        }
    };
    // Guard the two scale-setting entry points against an accidental change.
    function _scaleChangeAllowed() {
        if (_scaleLocked) {
            showToast('Scale is locked - unlock it from the Measure menu to change it');
            setStatus('Scale is locked');
            return false;
        }
        return true;
    }
    window.toggleScaleLock = function () {
        _scaleLocked = !_scaleLocked;
        showToast(_scaleLocked ? 'Scale locked - it will not change accidentally' : 'Scale unlocked');
        setStatus(_scaleLocked ? 'Scale: LOCKED' : 'Scale: unlocked');
        _updateScaleChip();
        return _scaleLocked;
    };
    window.storeScaleInPage = function () {
        if (!measureScale) { showToast('Set a scale first, then store it'); return; }
        _pageScales[state.currentPage] = { scale: measureScale, unit: measureUnit };
        showToast('Scale stored on page ' + state.currentPage + ' - it will reload with this sheet');
        setStatus('Scale stored in page ' + state.currentPage);
        _updateScaleChip();
    };
    // ISO 32000 defines a page /VP viewport with a /Measure dict (the "embedded
    // scale"). Read it via pdf-lib if present so a drawing that already carries a
    // scale can be used without re-calibrating.
    window.useEmbeddedScale = async function () {
        if (!_scaleChangeAllowed()) return;
        try {
            const src = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            const page = src.getPage(state.currentPage - 1);
            const vp = page.node.lookup(PDFLib.PDFName.of('VP'));
            const found = _readEmbeddedMeasure(vp);
            if (!found) { showToast('No embedded scale found in this PDF - use Calibrate or Set Scale'); return; }
            measureScale = found.scale; measureUnit = found.unit;
            _pageScales[state.currentPage] = { scale: measureScale, unit: measureUnit };
            showToast('Using the PDF\'s embedded scale - measurements show in ' + measureUnit);
            setStatus('Embedded scale loaded: measurements in ' + measureUnit);
        } catch (e) { console.warn(e); showToast('Could not read an embedded scale from this PDF'); }
    };
    // Parse a /VP array's first /Measure /RL (ratio) into units-per-page-pixel.
    function _readEmbeddedMeasure(vp) {
        try {
            const arr = (vp && vp.asArray) ? vp.asArray() : null;
            if (!arr || !arr.length) return null;
            for (const viewport of arr) {
                const vpd = viewport && viewport.lookup ? viewport : null;
                const measure = vpd && vpd.lookup(PDFLib.PDFName.of('Measure'));
                const x = measure && measure.lookup && measure.lookup(PDFLib.PDFName.of('X'));
                const xArr = x && x.asArray ? x.asArray() : null;
                const nd = xArr && xArr[0];
                // /X [ <numberformat> ] where the number format /C is units per point.
                const c = nd && nd.lookup && nd.lookup(PDFLib.PDFName.of('C'));
                const unitName = nd && nd.lookup && nd.lookup(PDFLib.PDFName.of('U'));
                if (c && typeof c.asNumber === 'function') {
                    // C = real units per default user-space unit (point). Convert
                    // to per page-pixel (page px == point here).
                    const unit = unitName && unitName.asString ? unitName.asString() : measureUnit;
                    return { scale: c.asNumber(), unit: String(unit).replace(/[^a-zA-Z]/g, '') || measureUnit };
                }
            }
        } catch (_) {}
        return null;
    }
    let measurePts = [];       // active measurement points (canvas px)
    let measurePreview = null; // live fabric preview
    let measureKind = null;    // 'mlength' | 'mperim' | 'marea' while collecting
    let pendingCalib = null;   // {p1, p2} awaiting the real-length prompt
    let _cutoutTarget = null;  // the area shape a cutout is being subtracted from
    // Measurements keep their OWN color, independent of the last drawing tool
    // (M16). Defaults to a blueprint blue; the Edit dialog and a measure color
    // control update it.
    let _measureColorState = '#1971c2';
    function _measureColor() { return _measureColorState; }
    window.setMeasureColor = function (c) { if (c) _measureColorState = c; };
    // Display precision (decimal places) for measurement values. 2 by default.
    let _measurePrecision = 2;
    function _mPrecision() { return _measurePrecision; }
    // Global show/hide for all measurement captions on the plan (M21).
    let _measureLabelsHidden = false;
    window.toggleMeasureLabels = function () {
        _measureLabelsHidden = !_measureLabelsHidden;
        if (fabricCanvas) {
            fabricCanvas.forEachObject((o) => {
                if (o._midLink && o.type === 'text') o.set({ visible: !_measureLabelsHidden });
            });
            fabricCanvas.requestRenderAll(); saveCurrentAnnotations();
        }
        showToast(_measureLabelsHidden ? 'Measurement labels hidden' : 'Measurement labels shown');
        return _measureLabelsHidden;
    };
    window.setMeasurePrecision = function (n) { _measurePrecision = Math.max(0, Math.min(6, n | 0)); if (window.renderMeasureList) window.renderMeasureList(); };

    // Canvas px -> page px (undo the zoom) so measurements are zoom-independent.
    const toPagePx = (d) => d / (state.zoom || 1);

    // ── Snapping ────────────────────────────────────────────────────────────
    // Ortho: hold Shift to lock the segment being drawn to 0/45/90 deg off the
    // previous point. Endpoint: snap the cursor to a nearby vertex of an existing
    // measurement markup so chained take-offs meet exactly.
    let _snapShift = false;   // updated from key state on every measure move/click
    const SNAP_PX = 10;       // endpoint snap radius, in canvas px
    function _orthoSnap(from, p) {
        if (!from) return p;
        const dx = p.x - from.x, dy = p.y - from.y;
        const ang = Math.atan2(dy, dx);
        const step = Math.PI / 4;                       // 45 deg increments
        const snapAng = Math.round(ang / step) * step;
        const len = Math.hypot(dx, dy);
        return { x: from.x + Math.cos(snapAng) * len, y: from.y + Math.sin(snapAng) * len };
    }
    function _endpointSnap(p) {
        // Scan existing measurement shapes on the canvas for a nearby vertex.
        let best = null, bestD = SNAP_PX;
        fabricCanvas.forEachObject((o) => {
            if (!o._measure && !o._measurePt) return;
            const verts = [];
            if (o.type === 'line') { verts.push({ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }); }
            else if (o.points && o.points.length) {
                // Polyline/Polygon points are relative to the object's own origin.
                const ox = o.left, oy = o.top;
                const px0 = o.pathOffset ? o.pathOffset.x : 0, py0 = o.pathOffset ? o.pathOffset.y : 0;
                o.points.forEach(pt => verts.push({ x: ox + (pt.x - px0), y: oy + (pt.y - py0) }));
            } else if (o._measurePt) { verts.push({ x: o.left, y: o.top }); }
            for (const v of verts) {
                const d = Math.hypot(v.x - p.x, v.y - p.y);
                if (d < bestD) { bestD = d; best = v; }
            }
        });
        return best || p;
    }
    // Snap to Content: find the nearest dark pixel of the rendered PDF (a drawn
    // line/edge) to the cursor, by scanning the page bitmap. Works for vector or
    // raster content since it reads the actual rendered pixels. The page canvas
    // is rendered at zoom*1.5 while the fabric canvas is at display size, so we
    // scale between the two. Returns a fabric-canvas point, or the input if none.
    let _snapContent = false;   // toggled from the measure menu
    const CONTENT_SNAP_PX = 12; // search radius in fabric-canvas px
    function _contentSnap(p) {
        const pc = dom.pdfCanvas;
        if (!pc || !pc.width) return p;
        const sx = pc.width / (fabricCanvas.getWidth() || 1);   // page-px per fabric-px (~1.5)
        const sy = pc.height / (fabricCanvas.getHeight() || 1);
        const cx = Math.round(p.x * sx), cy = Math.round(p.y * sy);
        const rx = Math.round(CONTENT_SNAP_PX * sx), ry = Math.round(CONTENT_SNAP_PX * sy);
        const x0 = Math.max(0, cx - rx), y0 = Math.max(0, cy - ry);
        const w = Math.min(pc.width - x0, rx * 2), h = Math.min(pc.height - y0, ry * 2);
        if (w <= 0 || h <= 0) return p;
        let data;
        try { data = pc.getContext('2d').getImageData(x0, y0, w, h).data; } catch (_) { return p; }
        let best = null, bestD = Infinity;
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const i = (yy * w + xx) * 4;
                // "dark enough to be a line" - low luminance, opaque.
                if (data[i + 3] > 40 && (data[i] + data[i + 1] + data[i + 2]) < 360) {
                    const gx = x0 + xx, gy = y0 + yy;
                    const d = (gx - cx) * (gx - cx) + (gy - cy) * (gy - cy);
                    if (d < bestD) { bestD = d; best = { x: gx / sx, y: gy / sy }; }
                }
            }
        }
        return best || p;
    }

    // Apply snapping to a raw pointer position given the anchor it extends from.
    function _snapPoint(p, from) {
        let out = _endpointSnap(p);                     // endpoint (own markups) wins
        if (out === p && _snapContent) out = _contentSnap(p);   // then PDF content
        if (out === p && _snapShift && from) out = _orthoSnap(from, p);  // then ortho
        return out;
    }
    window.toggleSnapContent = function () {
        _snapContent = !_snapContent;
        showToast(_snapContent ? 'Snap to Content on - measurements snap to drawing lines'
                               : 'Snap to Content off');
        setStatus(_snapContent ? 'Snap to Content: ON' : 'Snap to Content: OFF');
        return _snapContent;
    };

    // Absolute canvas-space vertices of a fabric polygon/polyline object.
    // Fabric stores points relative to the point-set's own min corner and places
    // the object at left/top = that min corner (default originX/Y left/top). Using
    // pathOffset (the bbox CENTER) as the base is wrong and shifts every vertex,
    // so anchor on the actual min of the points instead.
    function _absVerts(o) {
        const pts = o.points || [];
        if (!pts.length) return [];
        let minX = Infinity, minY = Infinity;
        for (const pt of pts) { if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y; }
        const m = o.calcTransformMatrix ? o.calcTransformMatrix() : null;
        return pts.map(pt => {
            // Local coords relative to the object's top-left origin.
            const lx = pt.x - minX, ly = pt.y - minY;
            if (m) {
                // Honor any move/scale/rotate applied after creation.
                return { x: m[0] * (pt.x - o.pathOffset.x) + m[2] * (pt.y - o.pathOffset.y) + m[4],
                         y: m[1] * (pt.x - o.pathOffset.x) + m[3] * (pt.y - o.pathOffset.y) + m[5] };
            }
            return { x: o.left + lx, y: o.top + ly };
        });
    }
    // Ray-casting point-in-polygon.
    function _pointInPoly(p, verts) {
        let inside = false;
        for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
            const a = verts[i], b = verts[j];
            if (((a.y > p.y) !== (b.y > p.y)) &&
                (p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || 1e-9) + a.x)) inside = !inside;
        }
        return inside;
    }
    // Distance from point p to segment a-b, in canvas px.
    function _distToSeg(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        return Math.hypot(p.x - cx, p.y - cy);
    }
    // The measurement under a point, tolerant enough for thin lines (M7). Areas/
    // volumes: point-in-polygon; lines/polylines/perimeters/angles: within TOL of
    // any segment; radius line: near the line; count dot: within its radius.
    function _measureHitAt(p) {
        const TOL = 8;
        let best = null, bestD = Infinity;
        fabricCanvas.forEachObject((o) => {
            if (!o._measure) return;
            const m = o._measure;
            if ((m.area || m.cubic) && o.points) {
                if (_pointInPoly(p, _absVerts(o))) { if (bestD > 0) { best = o; bestD = 0; } }
                return;
            }
            if (o.type === 'line') {
                const mtx = o.calcTransformMatrix(); const c = o.calcLinePoints();
                const a = fabric.util.transformPoint({ x: c.x1, y: c.y1 }, mtx);
                const b = fabric.util.transformPoint({ x: c.x2, y: c.y2 }, mtx);
                const d = _distToSeg(p, a, b);
                if (d < TOL && d < bestD) { best = o; bestD = d; }
            } else if (o.points) {
                const v = _absVerts(o);
                for (let i = 1; i < v.length; i++) {
                    const d = _distToSeg(p, v[i - 1], v[i]);
                    if (d < TOL && d < bestD) { best = o; bestD = d; }
                }
            } else if (m.kind === 'mcount') {
                const d = Math.hypot(p.x - o.left, p.y - o.top);
                if (d < (o.radius || 8) + 4 && d < bestD) { best = o; bestD = d; }
            }
        });
        return best;
    }

    // The Area (or Volume) measurement polygon under a point, if any.
    function _areaShapeAt(p) {
        let hit = null;
        fabricCanvas.forEachObject((o) => {
            if (hit) return;
            if (!o._measure || !o.points) return;
            if (o._measure.kind !== 'marea' && o._measure.kind !== 'mvolume') return;
            if (_pointInPoly(p, _absVerts(o))) hit = o;
        });
        return hit;
    }

    // Length units, all expressed in millimetres (the base) so any unit can be
    // converted to any other. PDF user space is 72 points = 1 inch = 25.4 mm.
    const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, yd: 914.4 };
    const PT_PER_MM = 72 / 25.4;   // points per millimetre (page px are PDF points)

    // Set the scale DIRECTLY (no drawing): "pageVal pageUnit on the page = realVal
    // realUnit in the real world" - e.g. 1 in = 10 ft. Computes measureScale
    // (real-units-per-page-pixel) so all readouts come out in realUnit.
    async function setScaleDirect(pageVal, pageUnit, realVal, realUnit) {
        const pagePerPx = 1 / PT_PER_MM / UNIT_MM[pageUnit];  // pageUnits represented by 1 page px
        const realPerPage = (realVal / pageVal);              // realUnits per 1 pageUnit
        const newScale = pagePerPx * realPerPage;             // realUnits per page px
        await _applyScaleChange(newScale, realUnit,
            'Scale set: ' + pageVal + ' ' + pageUnit + ' = ' + realVal + ' ' + realUnit);
        return;
    }
    window.setMeasureScaleDirect = setScaleDirect;

    function fmtMeasure(pagePixels, kind) {
        if (!measureScale) return '(set scale first)';
        if (kind === 'area') {
            const val = pagePixels * measureScale * measureScale; // px^2 -> unit^2
            return _fmtNum(val) + ' ' + measureUnit + '²';
        }
        const val = pagePixels * measureScale;
        return _fmtNum(val) + ' ' + measureUnit;
    }

    function measureStyleBase() {
        const sw = parseInt(dom.sizePicker.value, 10) || 2;
        // Measurements use their own color state, NOT the last drawing tool's (M16).
        return { stroke: _measureColor(), strokeWidth: sw, fill: 'transparent',
                 selectable: false, objectCaching: false };
    }

    // Distance between consecutive points, in canvas px.
    function polyLenPx(pts, close) {
        let d = 0;
        for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
        if (close && pts.length > 2) d += Math.hypot(pts[0].x - pts[pts.length-1].x, pts[0].y - pts[pts.length-1].y);
        return d;
    }
    // Shoelace area in canvas px^2.
    function polyAreaPx(pts) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        return Math.abs(a) / 2;
    }

    function measureLabel(text, x, y) {
        // Auto-nudge so a new caption doesn't land exactly on an existing one (M22).
        const pos = _avoidLabelOverlap(x, y);
        const t = new fabric.Text(text, { left: pos.x, top: pos.y, fontSize: 14, fill: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.72)', fontFamily: 'sans-serif', padding: 3,
            originX: 'center', originY: 'center',
            // Draggable so the user can pull an overlapping label aside; a leader
            // line then connects it back to the measurement (M22).
            selectable: true, hasControls: false, hasBorders: true, lockScalingX: true, lockScalingY: true, lockRotation: true,
            visible: !_measureLabelsHidden });
        t._measureCaption = true;
        t._anchor = { x, y };   // where the label belongs (for the leader line)
        // Follow the active layer so the caption hides/saves with its markup (M31).
        t._layerId = state.activeLayer;
        return t;
    }

    // Nudge a new label position if it would sit right on top of an existing
    // measurement caption. Simple spiral of small offsets until clear.
    function _avoidLabelOverlap(x, y) {
        if (!fabricCanvas) return { x, y };
        const near = (ax, ay) => {
            let clash = false;
            fabricCanvas.forEachObject((o) => {
                if (o._measureCaption && Math.abs(o.left - ax) < 22 && Math.abs(o.top - ay) < 14) clash = true;
            });
            return clash;
        };
        if (!near(x, y)) return { x, y };
        const steps = [[0,-18],[0,18],[26,0],[-26,0],[0,-36],[0,36],[26,-18],[-26,18]];
        for (const [dx, dy] of steps) if (!near(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        return { x: x, y: y + 18 };
    }

    // Draw/refresh the leader line from a caption to its anchor when the caption
    // has been dragged away from where it belongs (M22).
    function _updateLeaderFor(lbl) {
        if (!lbl || !lbl._anchor) return;
        // Remove any existing leader for this label (by live ref, or by mid after
        // a reload where the ref was lost).
        const old = fabricCanvas.getObjects().find(o => o._isLeader &&
            (o._leaderFor === lbl || (lbl._midLink && o._decorFor === lbl._midLink)));
        if (old) { _isRestoring = true; fabricCanvas.remove(old); _isRestoring = false; }
        const dx = lbl.left - lbl._anchor.x, dy = lbl.top - lbl._anchor.y;
        // Only draw a leader once the label is a meaningful distance from anchor.
        if (Math.hypot(dx, dy) < 24) return;
        const leader = new fabric.Line([lbl._anchor.x, lbl._anchor.y, lbl.left, lbl.top], {
            stroke: 'rgba(0,0,0,0.55)', strokeWidth: 1, strokeDashArray: [3, 2],
            selectable: false, evented: false, objectCaching: false });
        leader._leaderFor = lbl;                 // live ref (not serialized)
        leader._measureDecor = true;
        leader._decorFor = lbl._midLink;         // so it's cleaned up with the measurement
        leader._isLeader = true;
        leader._layerId = lbl._layerId;
        _isRestoring = true; fabricCanvas.add(leader); leader.moveTo(0); _isRestoring = false;
    }

    // Decorative angle arc + short extension marks at the vertex (M25). Tagged
    // _measureDecor so it is cleaned up with its parent measurement.
    function drawAngleArc(pts, color, mid) {
        const [a, b, c] = pts;
        const r = Math.min(28, Math.hypot(a.x - b.x, a.y - b.y) * 0.4, Math.hypot(c.x - b.x, c.y - b.y) * 0.4) || 20;
        let a1 = Math.atan2(a.y - b.y, a.x - b.x);
        let a2 = Math.atan2(c.y - b.y, c.x - b.x);
        // Sweep the short way between the rays.
        let d = a2 - a1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
        const steps = Math.max(6, Math.round(Math.abs(d) / (Math.PI / 24)));
        const path = [];
        for (let i = 0; i <= steps; i++) {
            const ang = a1 + d * (i / steps);
            path.push({ x: b.x + Math.cos(ang) * r, y: b.y + Math.sin(ang) * r });
        }
        const arc = new fabric.Polyline(path, { stroke: color, strokeWidth: 1.5, fill: '', selectable: false, evented: false, objectCaching: false });
        arc._measureDecor = true; arc._decorFor = mid; arc._layerId = state.activeLayer;
        _isRestoring = true; fabricCanvas.add(arc); _isRestoring = false;
    }

    // Decorative circle for a radius measurement (M26). center in canvas px,
    // radiusPx the drawn radius in canvas px.
    function drawRadiusCircle(center, radiusPx, color, mid) {
        const circ = new fabric.Circle({ left: center.x, top: center.y, radius: radiusPx,
            originX: 'center', originY: 'center', stroke: color, strokeWidth: 1.2,
            fill: '', strokeDashArray: [4, 3], selectable: false, evented: false, objectCaching: false });
        circ._measureDecor = true; circ._decorFor = mid; circ._layerId = state.activeLayer;
        _isRestoring = true; fabricCanvas.add(circ); _isRestoring = false;
    }

    function measureRedraw(livePt) {
        if (measurePreview) { _isRestoring = true; fabricCanvas.remove(measurePreview); _isRestoring = false; measurePreview = null; }
        const pts = livePt ? [...measurePts, livePt] : [...measurePts];
        if (pts.length < 2) return;
        const base = measureStyleBase();
        const areaKind = (measureKind === 'marea' || measureKind === 'mvolume');
        const shape = (measureKind === 'mcutout')
            ? new fabric.Polygon(pts, { ...base, fill: 'rgba(245,76,76,0.18)', stroke: '#e03131' })
            : areaKind
            ? new fabric.Polygon(pts, { ...base, fill: 'rgba(76,110,245,0.12)' })
            : new fabric.Polyline(pts, { ...base, fill: '' });
        _isRestoring = true; fabricCanvas.add(shape); measurePreview = shape; _isRestoring = false;
        fabricCanvas.renderAll();
    }

    // Count tool: drop a small numbered dot. Each marker is its own measurement
    // row (type "Count"); the Markups List tallies them.
    // Unique id per measurement so the Markups List can select/edit the exact
    // shape (and its linked label) even across page switches and reloads.
    let _midSeq = 0;
    function _newMid() { _midSeq += 1; return 'm' + _midSeq + '_' + (state.currentPage || 1); }
    // Stamp id + editable-property defaults onto a freshly created _measure.
    // geomPx is the scale-INDEPENDENT raw measure in page-pixels (length px,
    // area px^2, or a fixed value like degrees) so the real value can always be
    // recomputed as geomPx * scale^power. scaleAt records the calibration the
    // measurement was taken under, so we can detect/flag mixed-scale totals.
    function _tagMeasure(shape, m, geomPx) {
        m._mid = _newMid();
        if (m.subject === undefined) m.subject = m.type;   // Bluebeam "Subject"
        m.color = shape.stroke || _measureColor();
        m.thickness = shape.strokeWidth || 2;
        if (geomPx !== undefined) m.geomPx = geomPx;
        m.scaleAt = (m.kind === 'mangle' || m.kind === 'mcount') ? null : measureScale;
        m.scaleUnitAt = measureUnit;
        return m;
    }
    // The exponent scale is raised to for a given measurement kind.
    function _scalePow(m) { return m.cubic ? 3 : m.area ? 2 : 1; }
    // Recompute a measurement's real value from its stored raw geometry and the
    // CURRENT scale. Angle/count don't depend on scale. Volume keeps its depth.
    function _recomputeMeasure(m) {
        if (!m || m.geomPx == null) return;
        if (m.kind === 'mangle' || m.kind === 'mcount') return;   // scale-free
        if (!measureScale) return;
        if (m.kind === 'mvolume') {
            const areaNow = m.geomPx * measureScale * measureScale;   // geomPx here = area px^2
            m.baseArea = areaNow;
            m.value = areaNow * (m.depth || 1);
        } else {
            m.value = m.geomPx * Math.pow(measureScale, _scalePow(m));
            if (m.kind === 'mradius') m.diameter = m.value * 2;
        }
        m.unit = measureUnit;
        m.scaleAt = measureScale; m.scaleUnitAt = measureUnit;   // now current
    }
    // Recompute a measurement's raw geometry (geomPx) from the shape's CURRENT
    // vertices after the user drags/reshapes it, then its value + label (M3).
    // Accounts for any post-creation scale/move via the transform matrix.
    function _remeasureShape(shape) {
        const m = shape._measure; if (!m) return;
        if (m.kind === 'mangle') {
            // Recompute the angle from the polyline's 3 absolute vertices.
            const v = _absVerts(shape);
            if (v.length >= 3) { m.value = angleDeg([v[0], v[1], v[2]]); _relabelMeasure(m, shape); }
            return;
        }
        if (m.kind === 'mcount') return;
        if (shape.type === 'line') {
            // Endpoints in absolute canvas space via the transform matrix.
            const mtx = shape.calcTransformMatrix();
            const c = shape.calcLinePoints();   // local coords relative to center
            const a = fabric.util.transformPoint({ x: c.x1, y: c.y1 }, mtx);
            const b = fabric.util.transformPoint({ x: c.x2, y: c.y2 }, mtx);
            m.geomPx = toPagePx(Math.hypot(b.x - a.x, b.y - a.y));
        } else if (shape.points) {
            const v = _absVerts(shape);
            if (m.area || m.cubic) m.geomPx = toPagePx(toPagePx(polyAreaPx(v)));
            else m.geomPx = toPagePx(polyLenPx(v, m.kind === 'mperim'));
        }
        _recomputeMeasure(m);
        _relabelMeasure(m, shape);
        if (window.renderMeasureList) window.renderMeasureList();
    }

    // Refresh the on-plan caption text of a measurement to match its value.
    function _relabelMeasure(m, shape) {
        const lbl = fabricCanvas && fabricCanvas.getObjects().find(o => o._midLink === m._mid && o.type === 'text');
        if (!lbl) return;
        if (m.label) { lbl.set({ text: m.label }); return; }   // custom label wins
        lbl.set({ text: _autoLabelText(m) });
    }
    // The default on-plan caption for a measurement (² / ³ / ° rendered right).
    function _autoLabelText(m) {
        if (m.kind === 'mcount') return String(m.value);
        if (m.kind === 'mangle') return _fmtNum(m.value) + '°';
        if (m.kind === 'mradius') return 'R ' + _fmtNum(m.value) + ' ' + m.unit
            + '  (Ø ' + _fmtNum(m.diameter || m.value * 2) + ' ' + m.unit + ')';
        if (m.cubic) return _fmtNum(m.value) + ' ' + m.unit + '³'
            + (m.depth ? '  (d ' + m.depth + ' ' + m.unit + ')' : '');
        const suf = m.area ? '²' : '';
        const pre = m.kind === 'mperim' ? 'Perimeter: ' : m.kind === 'marea' ? 'Area: ' : '';
        return pre + _fmtNum(m.value) + ' ' + m.unit + suf;
    }
    // Recompute every measurement on the current page against the live scale and
    // refresh labels + the list. Returns how many were changed.
    function _recomputeAllOnPage() {
        if (!fabricCanvas) return 0;
        let n = 0;
        fabricCanvas.forEachObject((o) => {
            if (o._measure && o._measure.geomPx != null && o._measure.kind !== 'mangle' && o._measure.kind !== 'mcount') {
                _recomputeMeasure(o._measure); _relabelMeasure(o._measure, o); n++;
            }
        });
        if (n) { fabricCanvas.requestRenderAll(); saveAnnotationState(); saveCurrentAnnotations(); }
        if (window.renderMeasureList) window.renderMeasureList();
        return n;
    }

    let _countSeq = 0;
    let _countGroup = 'Count';   // the subject the current count session drops into (M27)
    window.setCountGroup = function (name) { _countGroup = (name || 'Count').trim() || 'Count'; };
    function placeCountMarker(p) {
        const color = _measureColor();
        const dot = new fabric.Circle({ left: p.x, top: p.y, radius: 6, fill: color,
            stroke: '#fff', strokeWidth: 1.5, originX: 'center', originY: 'center', selectable: true });
        _countSeq += 1;
        const num = new fabric.Text(String(_countSeq), { left: p.x, top: p.y - 16, fontSize: 12,
            fill: '#fff', backgroundColor: color, fontFamily: 'sans-serif', padding: 2,
            originX: 'center', originY: 'center', selectable: false });
        dot._measurePt = true;   // so endpoint-snap can see it
        dot._measure = _tagMeasure(dot, { kind: 'mcount', type: 'Count', value: 1, unit: '', area: false,
                         page: state.currentPage, label: '', subject: _countGroup });
        dot._measure.color = color;   // fill color, so the list swatch isn't empty (M27)
        num._measureLabelFor = dot._measure;
        num._midLink = dot._measure._mid;
        fabricCanvas.add(dot); fabricCanvas.add(num);
        saveAnnotationState(); saveCurrentAnnotations();
        if (window.renderMeasureList) window.renderMeasureList();
        setStatus('Count "' + _countGroup + '": ' + _countSeq + ' - click to add more, switch tools when done');
    }

    // Set Scale dialog (Bluebeam-style): type the scale directly, e.g. 1 in =
    // 10 ft, with unit dropdowns - no need to draw a known line.
    async function openSetScaleDialog() {
        if (!_scaleChangeAllowed()) return;
        _exitScrollForOp();
        const unitOpts = (sel) => ['mm','cm','m','in','ft','yd']
            .map(u => `<option value="${u}"${u===sel?' selected':''}>${u}</option>`).join('');
        // Preload the CURRENT scale so the dialog reflects reality (M6). Derive a
        // clean "1 pageUnit = realVal realUnit" from measureScale if one is set.
        let curPageUnit = 'in', curRealUnit = measureUnit || 'ft', curRealVal = 10;
        if (measureScale) {
            curRealVal = +(measureScale * 72).toFixed(4);   // real units per inch
        }
        const presets = [
            ['', 'Presets...'],
            ['1|in|10|ft', '1 in = 10 ft'],
            ['0.125|in|1|ft', '1/8" = 1\'-0"'],
            ['0.25|in|1|ft', '1/4" = 1\'-0"'],
            ['0.5|in|1|ft', '1/2" = 1\'-0"'],
            ['1|in|20|ft', '1 in = 20 ft'],
            ['1|mm|20|mm', '1:20'],
            ['1|mm|50|mm', '1:50'],
            ['1|mm|100|mm', '1:100'],
        ].map(([v2, l]) => `<option value="${v2}">${l}</option>`).join('');
        const precOpts = [0,1,2,3,4].map(n => `<option value="${n}"${n===_mPrecision()?' selected':''}>${n} dp</option>`).join('');
        const v = await _toolModal('Set Scale', `
            <p class="modal-hint" style="margin:0 0 10px;">Enter the drawing scale directly, or pick a preset. Example: 1 in = 10 ft means one inch on the page equals ten feet in real life.</p>
            <select class="modal-input" data-k="preset" style="width:100%;margin-bottom:10px;">${presets}</select>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <input type="number" class="modal-input" data-k="pageVal" value="1" step="any" style="width:70px;">
                <select class="modal-input" data-k="pageUnit" style="width:70px;">${unitOpts(curPageUnit)}</select>
                <span style="font-weight:700;">=</span>
                <input type="number" class="modal-input" data-k="realVal" value="${curRealVal}" step="any" style="width:90px;">
                <select class="modal-input" data-k="realUnit" style="width:70px;">${unitOpts(curRealUnit)}</select>
            </div>
            <div style="display:flex;gap:14px;align-items:flex-end;margin-top:12px;flex-wrap:wrap;">
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Precision
                  <select class="modal-input" data-k="precision" style="width:90px;">${precOpts}</select>
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Apply to
                  <select class="modal-input" data-k="scope" style="width:150px;">
                    <option value="page">This page</option>
                    <option value="all">All pages</option>
                  </select>
                </label>
            </div>
            <p class="modal-hint" style="margin:12px 0 0;">Prefer to measure a known distance instead? Use "Calibrate scale".</p>`,
            'Set Scale', (overlay) => {
                // Preset dropdown fills the four fields.
                const presetSel = overlay.querySelector('[data-k="preset"]');
                presetSel && presetSel.addEventListener('change', () => {
                    if (!presetSel.value) return;
                    const [pv, pu, rv, ru] = presetSel.value.split('|');
                    overlay.querySelector('[data-k="pageVal"]').value = pv;
                    overlay.querySelector('[data-k="pageUnit"]').value = pu;
                    overlay.querySelector('[data-k="realVal"]').value = rv;
                    overlay.querySelector('[data-k="realUnit"]').value = ru;
                });
            });
        if (!v) return;
        const pv = parseFloat(v.pageVal), rv = parseFloat(v.realVal);
        if (!(pv > 0) || !(rv > 0)) { showToast('Enter valid numbers on both sides'); return; }
        // Apply precision immediately and re-render (N3). Parse carefully: "0 dp"
        // is a valid choice, so `parseInt(...) || 2` would WRONGLY snap 0 back to
        // 2 (0 is falsy). Use the parsed value whenever it's a real number.
        if (v.precision !== undefined) {
            const pp = parseInt(v.precision, 10);
            _measurePrecision = Number.isFinite(pp) ? Math.max(0, Math.min(6, pp)) : _measurePrecision;
            _recomputeAllOnPage();   // relabels every measurement at the new precision
        }
        const newScale = (1 / PT_PER_MM / UNIT_MM[v.pageUnit]) * (rv / pv);
        // N2: if the scale value is unchanged (e.g. the user only touched
        // precision), don't fire the "scale changed - recalculate?" prompt.
        const scaleUnchanged = measureScale != null && v.realUnit === measureUnit
            && Math.abs(newScale - measureScale) < 1e-9;
        if (scaleUnchanged) { _updateScaleChip(); showToast('Updated'); return; }
        if (v.scope === 'all') {
            // Set the same scale on every page (M6 "apply to all").
            for (let i = 1; i <= (state.totalPages || 1); i++) _pageScales[i] = { scale: newScale, unit: v.realUnit };
            measureScale = newScale; measureUnit = v.realUnit;
            _recomputeAllOnPage(); _updateScaleChip();
            showToast('Scale applied to all ' + (state.totalPages || 1) + ' pages');
        } else {
            await setScaleDirect(pv, v.pageUnit, rv, v.realUnit);
        }
    }
    window.openSetScaleDialog = openSetScaleDialog;

    // Ask the real length of the calibration line via the in-page modal and set
    // the scale. Kept separate so handleMeasureClick stays sync.
    async function _finishCalibration(px) {
        if (!_scaleChangeAllowed()) return;
        // Loop until valid or cancelled, so bad input doesn't strand a half-state
        // with the calibration line already gone (M17).
        let realLen = null, unit = measureUnit;
        for (;;) {
            const ans = await customPrompt(
                'Enter the real length of the line you drew (number + unit), e.g. 10 ft, 5 m, 24 in:',
                'e.g. 10 ft', realLen == null ? '10 ft' : '');
            if (!ans) { setStatus('Calibration cancelled - scale unchanged'); return; }
            const m = ans.trim().match(/^([\d.]+)\s*([a-zA-Z"']+)?$/);
            if (m && parseFloat(m[1]) > 0) { realLen = parseFloat(m[1]); unit = m[2] || measureUnit; break; }
            showToast('Could not read that - try like "10 ft". Enter again or Cancel.');
        }
        const newScale = realLen / toPagePx(px);   // units per page-pixel
        await _applyScaleChange(newScale, unit, 'Calibrated: ' + realLen + ' ' + unit);
    }

    // Central scale-change path (M1/M12). Sets the scale, stores it on the page,
    // and - if measurements already exist on this page - offers to recompute them
    // so the totals never silently mix scales.
    async function _applyScaleChange(newScale, newUnit, desc) {
        const existing = fabricCanvas ? fabricCanvas.getObjects().filter(o =>
            o._measure && o._measure.geomPx != null &&
            o._measure.kind !== 'mangle' && o._measure.kind !== 'mcount') : [];
        measureScale = newScale; measureUnit = newUnit;
        _pageScales[state.currentPage] = { scale: measureScale, unit: measureUnit };
        if (existing.length) {
            const choice = await _choiceModal('Scale changed',
                'You changed the scale with ' + existing.length + ' measurement' +
                (existing.length > 1 ? 's' : '') + ' already on this page. Recalculate ' +
                (existing.length > 1 ? 'them' : 'it') + ' to the new scale, or keep the values as originally taken?',
                [{ key: 'recalc', label: 'Recalculate' }, { key: 'keep', label: 'Keep as taken' }]);
            if (choice === 'recalc') {
                const n = _recomputeAllOnPage();
                showToast('Scale set (' + newUnit + ') - recalculated ' + n + ' measurement' + (n > 1 ? 's' : ''));
            } else {
                // Leave old values but mark them so mixed-scale totals can be flagged.
                if (window.renderMeasureList) window.renderMeasureList();
                showToast('Scale set (' + newUnit + ') - existing measurements kept as taken');
            }
        } else {
            showToast('Scale set - measurements will show in ' + newUnit);
        }
        setStatus(desc + ' - measurements in ' + newUnit);
        _updateScaleChip();
    }

    // ── Dynamic Fill (H2) ───────────────────────────────────────────────────
    // Click inside an enclosed region on the plan; flood-fill the rendered page
    // bitmap to find the room, compute its area by counting interior pixels
    // (converted through the scale), and drop an Area measurement. This is the
    // "paint-bucket" takeoff: no clicking each corner.
    async function dynamicFillAt(canvasPt) {
        if (!measureScale) { showToast('Set the scale first'); return; }
        const pc = dom.pdfCanvas;
        if (!pc || !pc.width) { showToast('Open a page first'); return; }
        const sx = pc.width / (fabricCanvas.getWidth() || 1);   // page-px per fabric-px
        const sy = pc.height / (fabricCanvas.getHeight() || 1);
        const W = pc.width, H = pc.height;
        let data;
        try { data = pc.getContext('2d').getImageData(0, 0, W, H).data; } catch (_) { showToast('Cannot read the page pixels'); return; }
        const startX = Math.round(canvasPt.x * sx), startY = Math.round(canvasPt.y * sy);
        if (startX < 0 || startY < 0 || startX >= W || startY >= H) return;
        const idx = (x, y) => (y * W + x) * 4;
        // A pixel is "wall/line" (a barrier) if it's dark; interior is light.
        const isWall = (x, y) => { const i = idx(x, y); return data[i + 3] > 40 && (data[i] + data[i + 1] + data[i + 2]) < 360; };
        if (isWall(startX, startY)) { showToast('Click inside an open area, not on a line'); return; }
        // Scanline flood fill over light pixels, bounded so a leak can't fill the
        // whole sheet. Cap at ~1/3 of the page.
        const cap = Math.floor(W * H / 3);
        const visited = new Uint8Array(W * H);
        const stack = [[startX, startY]];
        let count = 0; let minX = startX, maxX = startX, minY = startY, maxY = startY;
        setStatus('Dynamic fill: detecting the enclosed area...');
        while (stack.length) {
            const [x, y] = stack.pop();
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const f = y * W + x;
            if (visited[f]) continue;
            if (isWall(x, y)) continue;
            visited[f] = 1; count++;
            if (count > cap) { showToast('That area is not enclosed - the fill leaked out'); setStatus('Ready'); return; }
            if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        if (count < 50) { showToast('That region is too small to measure'); setStatus('Ready'); return; }
        // Interior pixel count -> page-px^2 -> real area. Each page px covers
        // (1/sx)*(1/sy) fabric-px, and toPagePx converts fabric-px to page-px.
        const fabricAreaPx2 = count / (sx * sy);              // area in fabric px^2
        const pageAreaPx2 = toPagePx(toPagePx(fabricAreaPx2)); // page px^2 (undo zoom)
        const realArea = pageAreaPx2 * measureScale * measureScale;
        // Draw a translucent rectangle over the detected bounds as a visual marker
        // (a full outline trace would be heavier; the bounds + label read clearly).
        const rx = minX / sx, ry = minY / sy, rw = (maxX - minX) / sx, rh = (maxY - minY) / sy;
        const base = measureStyleBase(); base.selectable = true;
        const rect = new fabric.Rect({ left: rx, top: ry, width: rw, height: rh,
            fill: 'rgba(45,158,68,0.16)', stroke: base.stroke, strokeWidth: base.strokeWidth,
            strokeDashArray: [6, 4], selectable: true, objectCaching: false });
        // Use polygon-style _measure but store geomPx as the true filled area so
        // scale-recompute keeps working.
        rect._measure = _tagMeasure(rect, { kind: 'marea', type: 'Area', value: realArea, unit: measureUnit,
            area: true, page: state.currentPage, label: '', dynamicFill: true }, pageAreaPx2);
        fabricCanvas.add(rect);
        const cx = rx + rw / 2, cy = ry + rh / 2;
        const lbl = measureLabel(_autoLabelText(rect._measure), cx, cy);
        lbl.selectable = true; lbl._midLink = rect._measure._mid; lbl._measureLabelFor = rect._measure;
        fabricCanvas.add(lbl);
        fabricCanvas.requestRenderAll();
        saveAnnotationState(); saveCurrentAnnotations();
        if (window.renderMeasureList) window.renderMeasureList();
        setStatus('Dynamic fill: area ' + realArea.toFixed(_mPrecision()) + ' ' + measureUnit + '²');
    }

    const _MEASURE_KINDS = ['mlength', 'mpolylen', 'mperim', 'marea', 'mcutout', 'mcalibrate', 'mangle', 'mradius', 'mvolume', 'mcount', 'mdynfill'];
    // True while a measure tool is armed or a measurement is mid-draw - lets the
    // ribbon's global Escape handler defer to us so it doesn't collapse (M10).
    window.isMeasureActive = () => (state.activeTool === 'shape' && _MEASURE_KINDS.includes(shapeKind)) || !!measureKind;
    // True whenever any markup tool (not plain select/pan) is active, so PDF link
    // overlays don't hijack clicks meant for the canvas (B2).
    function _isMarkupModeActive() { return state.activeTool && state.activeTool !== 'select'; }
    // Exposed so the ribbon's Escape handler leaves the group open while a markup
    // tool is armed (B4).
    window.isEditorMarkupActive = _isMarkupModeActive;
    // In-page confirm for arming Redact (S1) - window.confirm can be dropped in an
    // iframe, so use the styled choice modal.
    window.confirmRedact = async function () {
        const choice = await _choiceModal('Redact content',
            'Redaction permanently removes the content under each box when you save the PDF. This cannot be undone after download. Draw the boxes, then Save to apply. Continue?',
            [{ key: 'go', label: 'Continue' }]);
        return choice === 'go';
    };
    function handleMeasureClick(opt) {
        if (state.activeTool !== 'shape') return;
        if (!_MEASURE_KINDS.includes(shapeKind)) return;
        _snapShift = !!(opt.e && opt.e.shiftKey);
        const raw = fabricCanvas.getPointer(opt.e);
        const anchor = measurePts.length ? measurePts[measurePts.length - 1] : null;
        const p = _snapPoint(raw, anchor);

        // Count: each click drops a numbered marker; no scale required.
        if (shapeKind === 'mcount') { placeCountMarker(p); return; }

        // Dynamic fill: one click inside a room auto-detects the area.
        if (shapeKind === 'mdynfill') { dynamicFillAt(p); return; }

        if (shapeKind === 'mcalibrate') {
            // Two clicks define a known distance, then ask its real length.
            measurePts.push({ x: p.x, y: p.y });
            measureRedraw();
            if (measurePts.length === 2) {
                const px = polyLenPx(measurePts, false);
                if (measurePreview) { _isRestoring = true; fabricCanvas.remove(measurePreview); _isRestoring = false; measurePreview = null; }
                measurePts = [];
                fabricCanvas.renderAll();
                // Use the in-page modal (not window.prompt, which browsers can
                // silently drop inside an iframe) so the scale entry always shows.
                _finishCalibration(px);
            } else {
                setStatus('Calibrate: click the second end of a KNOWN distance');
            }
            return;
        }

        // Measurement tools need a scale first.
        if (!measureScale) {
            showToast('Set the scale first: pick "Calibrate scale" and draw a known distance');
            setStatus('Measurement needs a scale - use "Calibrate scale" first');
            return;
        }

        // Area cutout: first click picks the area to cut from, then the void is
        // outlined; double-click subtracts it from that area's value.
        if (shapeKind === 'mcutout') {
            if (!_cutoutTarget) {
                const hit = _areaShapeAt(p);
                if (!hit) { showToast('Click inside an existing Area measurement first'); return; }
                _cutoutTarget = hit;
                measureKind = 'mcutout';
                setStatus('Now outline the void inside the area - double-click to subtract');
                return;
            }
            measureKind = 'mcutout';
            measurePts.push({ x: p.x, y: p.y });
            measureRedraw();
            setStatus('Cutout: click void corners - double-click to subtract');
            return;
        }

        measureKind = shapeKind;    // mlength | mpolylen | mperim | marea | mangle | mradius | mvolume
        measurePts.push({ x: p.x, y: p.y });
        measureRedraw();
        // Auto-finish at the natural point count for the fixed-vertex tools.
        if (measureKind === 'mlength' && measurePts.length === 2) measureFinish();
        else if (measureKind === 'mradius' && measurePts.length === 2) measureFinish();
        else if (measureKind === 'mangle' && measurePts.length === 3) measureFinish();
        else if (measureKind === 'mangle')
            setStatus(measurePts.length === 1 ? 'Angle: click the vertex' : 'Angle: click the second ray end');
        else {
            // Kind-specific continuation text so it doesn't contradict the arming
            // hint (M19). Backspace removes the last point (M20).
            const cont = {
                mlength:  'Length: click the second point to finish (Shift = straight/45 deg)',
                mradius:  'Radius: click the edge to finish',
                mpolylen: 'Polyline: click the next point - double-click or Enter to finish, Backspace to undo, Esc to cancel',
                mperim:   'Perimeter: click the next corner - double-click or Enter to close, Backspace to undo, Esc to cancel',
                marea:    'Area: click the next corner - double-click or Enter to close, Backspace to undo, Esc to cancel',
                mvolume:  'Volume: click the next corner - double-click or Enter to finish, Backspace to undo, Esc to cancel',
                mcutout:  'Cutout: click the next void corner - double-click to subtract, Backspace to undo, Esc to cancel',
            };
            setStatus(cont[measureKind] || 'Click to add points - double-click (or Enter) to finish, Esc to cancel');
        }
    }
    function handleMeasureMove(opt) {
        if (!measureKind || !measurePts.length) return;
        _snapShift = !!(opt.e && opt.e.shiftKey);
        const raw = fabricCanvas.getPointer(opt.e);
        const p = _snapPoint(raw, measurePts[measurePts.length - 1]);
        measureRedraw(p);
        _updateLiveReadout(p);
    }

    // Live running readout next to the cursor while drawing (M20): running
    // length / area / angle, plus dx/dy for the current segment.
    let _liveReadout = null;
    function _updateLiveReadout(p) {
        const pts = [...measurePts, p];
        let txt = '';
        const prev = measurePts[measurePts.length - 1];
        const dx = toPagePx(Math.abs(p.x - prev.x)), dy = toPagePx(Math.abs(p.y - prev.y));
        const P = _mPrecision();
        if (measureKind === 'mangle' && pts.length >= 3) {
            txt = angleDeg([pts[0], pts[1], pts[2]]).toFixed(P) + '°';
        } else if (measureKind === 'marea' || measureKind === 'mvolume' || measureKind === 'mcutout') {
            if (measureScale && pts.length >= 3) txt = 'A ' + (toPagePx(toPagePx(polyAreaPx(pts))) * measureScale * measureScale).toFixed(P) + ' ' + measureUnit + '²';
            else if (measureScale) txt = 'seg ' + (toPagePx(polyLenPx([prev, p], false)) * measureScale).toFixed(P) + ' ' + measureUnit;
        } else if (measureScale) {
            const closed = measureKind === 'mperim';
            const total = toPagePx(polyLenPx(pts, closed)) * measureScale;
            const seg = toPagePx(polyLenPx([prev, p], false)) * measureScale;
            txt = total.toFixed(P) + ' ' + measureUnit + (pts.length > 2 ? '  (seg ' + seg.toFixed(P) + ')' : '');
        }
        if (measureScale && txt && measureKind !== 'mangle') {
            txt += '   Δx ' + (dx * measureScale).toFixed(P) + '  Δy ' + (dy * measureScale).toFixed(P);
        }
        if (!txt) { _clearLiveReadout(); return; }
        if (_liveReadout) { _isRestoring = true; fabricCanvas.remove(_liveReadout); _isRestoring = false; }
        _liveReadout = new fabric.Text(txt, { left: p.x + 14, top: p.y - 10, fontSize: 12, fill: '#fff',
            backgroundColor: 'rgba(25,113,194,0.92)', fontFamily: 'sans-serif', padding: 3,
            selectable: false, evented: false, excludeFromExport: true });
        _isRestoring = true; fabricCanvas.add(_liveReadout); _isRestoring = false;
        fabricCanvas.requestRenderAll();
    }
    function _clearLiveReadout() {
        if (_liveReadout) { _isRestoring = true; fabricCanvas.remove(_liveReadout); _isRestoring = false; _liveReadout = null; }
    }
    // Angle at pts[1] (vertex) between rays to pts[0] and pts[2], in degrees.
    function angleDeg(pts) {
        const [a, b, c] = pts;
        const v1 = { x: a.x - b.x, y: a.y - b.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const dot = v1.x * v2.x + v1.y * v2.y;
        const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
        return Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180 / Math.PI;
    }
    function measureFinish() {
        if (!measureKind) return;
        _clearLiveReadout();
        if (measurePreview) { _isRestoring = true; fabricCanvas.remove(measurePreview); _isRestoring = false; measurePreview = null; }
        const pts = measurePts;
        // Angle needs 3 pts; area/volume need 3; radius/length need 2.
        const need = (measureKind === 'marea' || measureKind === 'mvolume' || measureKind === 'mangle') ? 3 : 2;

        // Angle: report degrees, no scale needed.
        if (measureKind === 'mangle') {
            if (pts.length >= 3) {
                const base = measureStyleBase(); base.selectable = true; base.fill = '';
                const shape = new fabric.Polyline([pts[0], pts[1], pts[2]], base);
                fabricCanvas.add(shape);
                const deg = angleDeg(pts);
                shape._measure = _tagMeasure(shape, { kind: 'mangle', type: 'Angle', value: deg, unit: '°',
                                   area: false, page: state.currentPage, label: '' }, null);
                drawAngleArc(pts, shape._measure.color, shape._measure._mid);   // arc (M25)
                const lbl = measureLabel(deg.toFixed(_mPrecision()) + '°', pts[1].x + 14, pts[1].y - 14);
                lbl.selectable = true; lbl._measureLabelFor = shape._measure; lbl._midLink = shape._measure._mid;
                fabricCanvas.add(lbl);
                saveAnnotationState(); saveCurrentAnnotations();
                if (window.renderMeasureList) window.renderMeasureList();
            }
            measurePts = []; measureKind = null; fabricCanvas.renderAll(); setStatus('Ready'); return;
        }

        // Radius / diameter: two clicks = center + edge (radius) OR edge-to-edge.
        // We treat it as a straight distance and report both radius and diameter.
        if (measureKind === 'mradius') {
            if (pts.length >= 2 && measureScale) {
                const base = measureStyleBase(); base.selectable = true;
                const shape = new fabric.Line([pts[0].x, pts[0].y, pts[1].x, pts[1].y], base);
                fabricCanvas.add(shape);
                const radiusPx = toPagePx(polyLenPx(pts, false));   // page-px, scale-free
                const dist = radiusPx * measureScale;               // real radius
                shape._measure = _tagMeasure(shape, { kind: 'mradius', type: 'Radius', value: dist, unit: measureUnit,
                                   area: false, page: state.currentPage, label: '',
                                   diameter: dist * 2 }, radiusPx);
                // Draw the actual circle (center = pts[0], through pts[1]) - M26.
                drawRadiusCircle(pts[0], polyLenPx(pts, false), shape._measure.color, shape._measure._mid);
                const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2 - 12;
                const lbl = measureLabel(_autoLabelText(shape._measure), cx, cy);
                lbl.selectable = true; lbl._measureLabelFor = shape._measure; lbl._midLink = shape._measure._mid;
                fabricCanvas.add(lbl);
                saveAnnotationState(); saveCurrentAnnotations();
                if (window.renderMeasureList) window.renderMeasureList();
            } else if (!measureScale) {
                showToast('Set the scale first');
            }
            measurePts = []; measureKind = null; fabricCanvas.renderAll(); setStatus('Ready'); return;
        }

        // Volume: draw the area polygon, then ask for a depth and multiply.
        if (measureKind === 'mvolume') {
            if (pts.length >= 3 && measureScale) { finishVolume([...pts]); }
            else if (!measureScale) { showToast('Set the scale first'); }
            measurePts = []; measureKind = null; fabricCanvas.renderAll(); setStatus('Ready'); return;
        }

        // Area cutout: subtract the void polygon's area from the target area's
        // value, draw the void outline, and record it on the target for export.
        if (measureKind === 'mcutout') {
            if (pts.length >= 3 && _cutoutTarget && _cutoutTarget._measure) {
                const voidAreaPx = toPagePx(toPagePx(polyAreaPx(pts)));   // page-px^2, scale-free
                const tm = _cutoutTarget._measure;
                // Track cutout area in page-px^2 so it survives scale changes, and
                // reduce the stored geomPx so recompute stays correct.
                tm.cutoutPx = (tm.cutoutPx || 0) + voidAreaPx;
                tm.geomPx = Math.max(0, (tm.geomPx || 0) - voidAreaPx);
                _recomputeMeasure(tm);
                const base = measureStyleBase(); base.selectable = true;
                // Diagonal hatch fill so a cutout reads as a void (M13).
                const voidShape = new fabric.Polygon(pts, { ...base, fill: 'rgba(224,49,49,0.18)', stroke: '#e03131', strokeDashArray: [5, 3] });
                voidShape._cutoutFor = tm._mid;
                fabricCanvas.add(voidShape);
                _relabelMeasure(tm);   // renders ² correctly on the plan (M13)
                saveAnnotationState(); saveCurrentAnnotations();
                if (window.renderMeasureList) window.renderMeasureList();
                setStatus('Cutout subtracted - area is now ' + tm.value.toFixed(_mPrecision()) + ' ' + tm.unit + '²');
            } else if (!_cutoutTarget) {
                showToast('Pick an area to cut from first');
            }
            measurePts = []; measureKind = null; _cutoutTarget = null;
            fabricCanvas.renderAll(); return;
        }

        if (pts.length >= need) {
            const base = measureStyleBase(); base.selectable = true;
            let cx, cy, geomPx, mKindLabel, isArea = false;
            let shape;
            if (measureKind === 'mlength') {
                shape = new fabric.Line([pts[0].x, pts[0].y, pts[1].x, pts[1].y], base);
                fabricCanvas.add(shape);
                geomPx = toPagePx(polyLenPx(pts, false));   // length in page-px
                mKindLabel = 'Length';
                cx = (pts[0].x + pts[1].x) / 2; cy = (pts[0].y + pts[1].y) / 2 - 12;
            } else if (measureKind === 'mpolylen') {
                shape = new fabric.Polyline(pts, { ...base, fill: '' });
                fabricCanvas.add(shape);
                geomPx = toPagePx(polyLenPx(pts, false));   // open path
                mKindLabel = 'Polyline';
                cx = pts[0].x; cy = pts[0].y - 14;
            } else if (measureKind === 'mperim') {
                // Close the outline so the counted closing side is actually drawn (M24).
                shape = new fabric.Polygon(pts, { ...base, fill: '' });
                fabricCanvas.add(shape);
                geomPx = toPagePx(polyLenPx(pts, true));
                mKindLabel = 'Perimeter';
                cx = pts[0].x; cy = pts[0].y - 14;
            } else { // marea
                shape = new fabric.Polygon(pts, { ...base, fill: 'rgba(25,113,194,0.12)' });
                fabricCanvas.add(shape);
                geomPx = toPagePx(toPagePx(polyAreaPx(pts))); // area in page-px^2
                mKindLabel = 'Area'; isArea = true;
                cx = pts.reduce((s,p)=>s+p.x,0)/pts.length; cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;
            }
            const val = geomPx * Math.pow(measureScale, isArea ? 2 : 1);
            shape._measure = _tagMeasure(shape, {
                kind: measureKind,
                type: mKindLabel,
                value: val,
                unit: measureUnit,
                area: isArea,
                page: state.currentPage,
                label: '',
            }, geomPx);
            const lbl = measureLabel(_autoLabelText(shape._measure), cx, cy);
            lbl.selectable = true;
            lbl._measureLabelFor = shape._measure;
            lbl._midLink = shape._measure._mid;
            fabricCanvas.add(lbl);
            saveAnnotationState(); saveCurrentAnnotations();
            if (window.renderMeasureList) window.renderMeasureList();
        }
        measurePts = []; measureKind = null;
        fabricCanvas.renderAll();
        setStatus('Ready');
    }
    function measureCancel() {
        if (measurePreview) { _isRestoring = true; fabricCanvas.remove(measurePreview); _isRestoring = false; measurePreview = null; }
        _clearLiveReadout();
        measurePts = []; measureKind = null; _cutoutTarget = null;
        fabricCanvas.renderAll();
    }

    // Volume = polygon area x a depth the user types. Result is in cubic units of
    // the current measure unit (e.g. ft³). Depth is entered in the same unit.
    async function finishVolume(pts) {
        const base = measureStyleBase(); base.selectable = true;
        const shape = new fabric.Polygon(pts, { ...base, fill: 'rgba(25,113,194,0.12)' });
        fabricCanvas.add(shape); fabricCanvas.renderAll();
        const areaPagePx = toPagePx(toPagePx(polyAreaPx(pts)));      // page-px^2, scale-free
        const area = areaPagePx * measureScale * measureScale;      // real area
        const ans = await customPrompt(
            'Enter the depth / thickness in ' + measureUnit + ' (e.g. 0.5):',
            'depth in ' + measureUnit, '1');
        if (!ans) { fabricCanvas.remove(shape); fabricCanvas.renderAll(); setStatus('Volume cancelled'); return; }
        const depth = parseFloat(ans);
        if (!(depth > 0)) { fabricCanvas.remove(shape); showToast('Enter a valid depth'); return; }
        const vol = area * depth;
        shape._measure = _tagMeasure(shape, { kind: 'mvolume', type: 'Volume', value: vol, unit: measureUnit,
                           area: false, cubic: true, page: state.currentPage, label: '',
                           baseArea: area, depth: depth }, areaPagePx);
        const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length, cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;
        // Label shows the depth so it's not hidden (M23).
        const lbl = measureLabel(vol.toFixed(_mPrecision()) + ' ' + measureUnit + '³  (d ' + depth + ' ' + measureUnit + ')', cx, cy);
        lbl.selectable = true; lbl._measureLabelFor = shape._measure; lbl._midLink = shape._measure._mid;
        fabricCanvas.add(lbl);
        saveAnnotationState(); saveCurrentAnnotations();
        if (window.renderMeasureList) window.renderMeasureList();
        setStatus('Volume: ' + vol.toFixed(_mPrecision()) + ' ' + measureUnit + '³');
    }

    // ── Markups List + Totals (Bluebeam-style takeoff panel) ────────────────────
    // Collect every measurement across ALL pages: the current page from live
    // fabric objects, other pages from their saved annotation JSON.
    function collectMeasurements() {
        // Persist the live canvas first so the current page's measurements are
        // also in state.annotations - then read EVERYTHING from there. This
        // avoids double-counting (live + saved) and guarantees the page number
        // is the annotation key, not a stale value stored on the object.
        try { if (fabricCanvas) saveCurrentAnnotations(); } catch (_) {}
        // Exclude measurements on hidden or deleted layers - they won't be saved
        // into the PDF, so the on-screen takeoff must not count them (M31).
        const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
        const live = new Set(state.layers.map(l => l.id));
        const skipLayer = (o) => o._layerId !== undefined && (hidden.has(o._layerId) || !live.has(o._layerId));
        const rows = [];
        for (const [pgStr, entry] of Object.entries(state.annotations || {})) {
            const pg = parseInt(pgStr, 10);
            const objs = (entry && (entry.fabricData || entry).objects) || [];
            objs.forEach((o) => { if (o._measure && !skipLayer(o)) rows.push({ ...o._measure, page: pg }); });
        }
        rows.sort((a, b) => (a.page - b.page));
        return rows;
    }

    // Every NON-measure annotation across all pages, for the general Markups list
    // (S11): text, shapes, stamps, ink, highlights, images, redactions. Each row
    // is { page, kind, label, mid, obj (live only), _idx }. Skips helpers and
    // hidden/deleted layers so the list mirrors what will save.
    function collectAllMarkups() {
        try { if (fabricCanvas) saveCurrentAnnotations(); } catch (_) {}
        const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
        const live = new Set(state.layers.map(l => l.id));
        const skipLayer = (o) => o._layerId !== undefined && (hidden.has(o._layerId) || !live.has(o._layerId));
        const classify = (o) => {
            if (o._measure) return null;                        // measurements have their own list
            if (o._measureCaption || o._measureDecor || o._isLeader) return null; // measurement helpers
            if (o.excludeFromExport || o._isTextCover || o._isCommentMark) return null;
            if (o._isStamp) return { kind: 'Stamp', label: _objText(o) || 'Stamp' };
            if (o._isRedact) return { kind: 'Redaction', label: 'Redaction box' };
            const t = o.type;
            if (t === 'i-text' || t === 'text' || t === 'textbox') return { kind: 'Text', label: _objText(o) };
            if (t === 'image') return { kind: 'Image', label: 'Image' };
            if (t === 'path' || t === 'polyline' && o.fill === '') return { kind: 'Ink', label: 'Freehand' };
            if (t === 'rect') return { kind: 'Rectangle', label: 'Rectangle' };
            if (t === 'circle' || t === 'ellipse') return { kind: 'Ellipse', label: 'Ellipse' };
            if (t === 'triangle') return { kind: 'Triangle', label: 'Triangle' };
            if (t === 'line') return { kind: 'Line', label: 'Line' };
            if (t === 'polygon') return { kind: 'Polygon', label: 'Polygon' };
            if (t === 'polyline') return { kind: 'Polyline', label: 'Polyline' };
            if (t === 'group') return { kind: 'Group', label: 'Group' };
            return { kind: (t || 'Markup'), label: (t || 'Markup') };
        };
        const rows = [];
        for (const [pgStr, entry] of Object.entries(state.annotations || {})) {
            const pg = parseInt(pgStr, 10);
            const objs = (entry && (entry.fabricData || entry).objects) || [];
            objs.forEach((o, idx) => {
                if (skipLayer(o)) return;
                const c = classify(o);
                if (c) rows.push({ page: pg, kind: c.kind, label: c.label, _idx: idx });
            });
        }
        rows.sort((a, b) => (a.page - b.page));
        return rows;
    }
    function _objText(o) {
        const s = (o && (o.text != null ? o.text : ''));
        return String(s).replace(/\s+/g, ' ').trim().slice(0, 40);
    }

    function _unitSuffix(m) {
        if (m.cubic) return '³';
        if (m.area) return '²';
        return '';
    }
    // Number formatting with thousands separators at the current precision (N5).
    function _fmtNum(n) {
        const P = _mPrecision();
        return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: P, maximumFractionDigits: P });
    }
    // Currency formatting with thousands separators (N5).
    function _fmtMoney(n) {
        return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function _fmtVal(m) {
        if (m.kind === 'mcount') return String(m.value);           // plain integer
        if (m.kind === 'mangle') return _fmtNum(m.value) + '°';    // unit already '°'
        if (m.kind === 'mradius') return 'R ' + _fmtNum(m.value) + ' ' + m.unit
            + ' / Ø ' + _fmtNum(m.diameter || m.value * 2) + ' ' + m.unit;   // M14: unit on Ø
        if (m.cubic) return _fmtNum(m.value) + ' ' + m.unit + '³'
            + (m.depth ? ' (d ' + m.depth + ' ' + m.unit + ')' : '');        // M23: show depth in the list too
        return _fmtNum(m.value) + ' ' + m.unit + _unitSuffix(m);
    }

    window.renderMeasureList = function renderMeasureList() {
        const panel = document.getElementById('measureListPanel');
        if (!panel) return;
        const body = panel.querySelector('.measure-list-body');
        const rows = collectMeasurements();
        const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
            { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
        if (!rows.length) {
            // No measurements, but still show the general markups list (S11).
            let mh = '<div class="measure-empty">No measurements yet. Use the Measure tool for length, perimeter, area, angle, radius, volume or count.</div>';
            mh += _renderAllMarkupsSection(escH);
            body.innerHTML = mh;
            _wireMarkupRows(body);
            return;
        }
        const P = _mPrecision();
        const sortMode = window._measureSort || 'page';
        const filt = (window._measureFilter || '').toLowerCase();
        const matches = (m) => !filt || (m.type + ' ' + (m.subject || '') + ' ' + (m.label || '') + ' p' + m.page).toLowerCase().includes(filt);
        // The filter narrows the list AND the subtotals/totals/cost (M32), so what
        // you see summed always matches the rows shown. `filteredRows` is the set.
        const filteredRows = rows.filter(matches);
        // Groups keyed by Subject + TYPE + unit, so the same Subject on different
        // measurement types stays distinguishable (M15). Angles/radii are never
        // summed - we show count and min/max/avg instead (M11).
        const totals = {};
        filteredRows.forEach((m) => {
            const grp = (m.subject || m.type);
            const uSuf = m.unit + _unitSuffix(m);
            const key = grp + '|' + m.type + '|' + uSuf;
            totals[key] = totals[key] || { subject: grp, type: m.type, unit: uSuf, sum: 0, count: 0,
                                           kind: m.kind, min: Infinity, max: -Infinity, scales: new Set(), cost: 0, hasCost: false };
            const t = totals[key];
            t.sum += m.value; t.count++;
            t.min = Math.min(t.min, m.value); t.max = Math.max(t.max, m.value);
            if (m.scaleAt != null) t.scales.add(+m.scaleAt.toFixed(6));
            if (m.unitCost != null) { t.hasCost = true; t.cost += m.value * m.unitCost; }
        });
        // Per-page subtotals + sortable rows. Sort key from the panel (default page).
        let shown = rows.map((m, i) => ({ m, i })).filter(({ m }) => matches(m));
        shown.sort((A, B) => {
            if (sortMode === 'type') return A.m.type.localeCompare(B.m.type) || A.m.page - B.m.page;
            if (sortMode === 'subject') return (A.m.subject || '').localeCompare(B.m.subject || '') || A.m.page - B.m.page;
            if (sortMode === 'value') return (B.m.value || 0) - (A.m.value || 0);
            return A.m.page - B.m.page;
        });
        let html = '<div class="measure-row measure-row-head"><span></span><span class="measure-row-type">Item</span><span class="measure-row-page">Pg</span><span class="measure-row-val">Value</span></div>';
        let lastPage = null;
        shown.forEach(({ m, i }) => {
            if (sortMode === 'page' && m.page !== lastPage) {
                const pageRows = filteredRows.filter(r => r.page === m.page);
                html += `<div class="measure-subtotal">Sheet ${m.page} - ${pageRows.length} item${pageRows.length > 1 ? 's' : ''}</div>`;
                lastPage = m.page;
            }
            const name = m.label ? escH(m.label) : escH(m.subject || m.type);
            const swColor = m.color || (m.kind === 'mcount' ? '#e8590c' : '#1971c2');
            const dot = `<span class="measure-swatch" style="background:${escH(swColor)}"></span>`;
            const mixed = (m.scaleAt != null && measureScale != null && Math.abs(m.scaleAt - measureScale) > 1e-6)
                ? ' <span class="measure-flag" title="Captured under a different scale than the current one">⚠</span>' : '';
            html += `<div class="measure-row" data-mid="${escH(m._mid || '')}" data-i="${i}" title="Click to edit; right-click for more">
                ${dot}<span class="measure-row-type">${name}${mixed}</span>
                <span class="measure-row-page">p${m.page}</span>
                <span class="measure-row-val">${_fmtVal(m)}</span>
            </div>`;
        });
        html += '<div class="measure-totals-head">Totals</div>';
        Object.values(totals).forEach((t) => {
            const mixed = t.scales.size > 1 ? ' <span class="measure-flag" title="This total mixes measurements taken at different scales">⚠ mixed scale</span>' : '';
            const label = t.subject === t.type ? t.type : t.subject + ' - ' + t.type;
            let val;
            if (t.kind === 'mcount') val = String(t.count);
            else if (t.kind === 'mangle' || t.kind === 'mradius') {
                // Never sum angles/radii - show the range instead (M11).
                const u = t.kind === 'mangle' ? '°' : ' ' + t.unit;
                val = t.count === 1 ? _fmtNum(t.min) + u
                    : `min ${_fmtNum(t.min)} / max ${_fmtNum(t.max)} / avg ${_fmtNum(t.sum / t.count)}${u}`;
            } else val = _fmtNum(t.sum) + ' ' + t.unit;
            const cost = t.hasCost ? ` <span class="measure-cost">${_fmtMoney(t.cost)}</span>` : '';
            html += `<div class="measure-total-row"><span>${escH(label)} (${t.count})${mixed}</span><b>${val}${cost}</b></div>`;
        });
        // Grand total cost across every group that has costs.
        const grand = Object.values(totals).reduce((s, t) => s + (t.hasCost ? t.cost : 0), 0);
        if (grand > 0) html += `<div class="measure-total-row measure-grand"><span>Estimated cost</span><b>${_fmtMoney(grand)}</b></div>`;
        html += _renderAllMarkupsSection(escH);
        body.innerHTML = html;
        body.querySelectorAll('.measure-row[data-mid]').forEach((row) => {
            row.addEventListener('click', () => {
                const mid = row.getAttribute('data-mid');
                if (mid) editMeasurement(mid);
            });
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const mid = row.getAttribute('data-mid');
                if (mid) _measureRowMenu(e, mid);
            });
        });
        _wireMarkupRows(body);
    };

    // Build the "All Markups" section HTML (S11): every non-measure annotation,
    // grouped by page, click-to-go. Respects the same filter box.
    function _renderAllMarkupsSection(escH) {
        const filt = (window._measureFilter || '').toLowerCase();
        let markups = collectAllMarkups();
        if (filt) markups = markups.filter(r => (r.kind + ' ' + r.label + ' p' + r.page).toLowerCase().includes(filt));
        if (!markups.length) return '';
        // Type tally for the header.
        const byKind = {};
        markups.forEach(r => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
        let h = '<div class="measure-totals-head">Markups (' + markups.length + ')</div>';
        let lastPage = null;
        markups.forEach((r) => {
            if (r.page !== lastPage) {
                const n = markups.filter(x => x.page === r.page).length;
                h += `<div class="measure-subtotal">Sheet ${r.page} - ${n} markup${n > 1 ? 's' : ''}</div>`;
                lastPage = r.page;
            }
            const lbl = r.label ? escH(r.label) : escH(r.kind);
            h += `<div class="measure-row markup-row" data-mpage="${r.page}" data-midx="${r._idx}" title="Go to this markup">
                <span class="markup-kind">${escH(r.kind)}</span>
                <span class="measure-row-type">${lbl}</span>
                <span class="measure-row-page">p${r.page}</span>
            </div>`;
        });
        return h;
    }
    // Clicking an All-Markups row navigates to its page and selects the object.
    function _wireMarkupRows(body) {
        body.querySelectorAll('.markup-row[data-mpage]').forEach((row) => {
            row.addEventListener('click', () => {
                const pg = parseInt(row.getAttribute('data-mpage'), 10);
                const idx = parseInt(row.getAttribute('data-midx'), 10);
                _goToMarkup(pg, idx);
            });
        });
    }
    async function _goToMarkup(pg, idx) {
        if (pg !== state.currentPage) { await goToPage(pg); await new Promise(r => setTimeout(r, 150)); }
        // Select the object at that stored index on the (now current) page.
        try {
            const objs = fabricCanvas.getObjects().filter(o => !o.excludeFromExport);
            // Prefer selecting the live object; fall back to the nth non-helper.
            const target = fabricCanvas.getObjects()[idx] || objs[idx];
            if (target && target.selectable) {
                if (state.activeTool !== 'select') setActiveTool('select');
                fabricCanvas.setActiveObject(target);
                fabricCanvas.requestRenderAll();
            }
        } catch (_) {}
        setStatus('Jumped to markup on sheet ' + pg);
    }

    // Right-click context menu on a measurement row (M7): Edit / Duplicate /
    // Delete / Copy value.
    function _measureRowMenu(e, mid) {
        document.querySelectorAll('.measure-ctx').forEach(n => n.remove());
        const menu = document.createElement('div');
        menu.className = 'measure-ctx';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;`;
        const items = [['Edit', 'edit'], ['Duplicate', 'dup'], ['Copy value', 'copy'], ['Delete', 'del']];
        menu.innerHTML = items.map(([lbl, act]) =>
            `<button data-act="${act}"${act === 'del' ? ' class="danger"' : ''}>${lbl}</button>`).join('');
        document.body.appendChild(menu);
        // Escape closes the menu (and only the menu) - capture phase + stop so it
        // pre-empts the measure/ribbon Escape handlers while the menu is open.
        const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
        const close = () => { menu.remove(); document.removeEventListener('keydown', onEsc, true); };
        menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            const act = b.dataset.act; close();
            if (act === 'edit') editMeasurement(mid);
            else if (act === 'del') deleteMeasurement(mid);
            else if (act === 'dup') duplicateMeasurement(mid);
            else if (act === 'copy') { const s = _findMeasureShape(mid); if (s) navigator.clipboard?.writeText(_fmtVal(s._measure)).then(() => showToast('Value copied')); }
        }));
        document.addEventListener('keydown', onEsc, true);
        setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    }

    // Find the live fabric shape carrying a given measurement id on the CURRENT
    // page (measurements on other pages must be opened by navigating there).
    function _findMeasureShape(mid) {
        if (!fabricCanvas) return null;
        let hit = null;
        fabricCanvas.forEachObject((o) => { if (o._measure && o._measure._mid === mid) hit = o; });
        return hit;
    }

    // Edit a measurement's properties (Bluebeam-style): custom Label + Subject,
    // color, and line thickness. Applies live to the shape + its label + the list.
    async function editMeasurement(mid) {
        const shape = _findMeasureShape(mid);
        if (!shape) {
            // The measurement lives on another page - tell the user where.
            let onPage = null;
            for (const [pgStr, entry] of Object.entries(state.annotations || {})) {
                const objs = (entry && (entry.fabricData || entry).objects) || [];
                if (objs.some(o => o._measure && o._measure._mid === mid)) { onPage = parseInt(pgStr, 10); break; }
            }
            if (onPage && onPage !== state.currentPage) showToast('That measurement is on page ' + onPage + ' - open that page to edit it');
            else showToast('Could not find that measurement');
            return;
        }
        const m = shape._measure;
        const v = await _toolModal('Edit Measurement', `
            <div style="display:flex;flex-direction:column;gap:10px;">
              <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Label (shown on the plan; blank = auto)
                <input type="text" class="modal-input" data-k="label" value="${(m.label||'').replace(/"/g,'&quot;')}" placeholder="e.g. North wall">
              </label>
              <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Subject (groups totals in the list)
                <input type="text" class="modal-input" data-k="subject" value="${(m.subject||m.type||'').replace(/"/g,'&quot;')}">
              </label>
              <div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;">
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Color
                  <input type="color" class="modal-input" data-k="color" value="${m.color||'#1971c2'}" style="width:52px;height:34px;padding:2px;">
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Thickness
                  <input type="number" class="modal-input" data-k="thickness" value="${m.thickness||2}" min="1" max="20" step="1" style="width:70px;">
                </label>
                ${m.kind === 'mvolume' ? `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Depth (${m.unit})
                  <input type="number" class="modal-input" data-k="depth" value="${m.depth||1}" min="0" step="any" style="width:80px;">
                </label>` : ''}
              </div>
              <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Unit cost (per ${(m.unit + _unitSuffix(m)) || 'item'}) - optional
                <input type="number" class="modal-input" data-k="unitCost" value="${m.unitCost != null ? m.unitCost : ''}" min="0" step="any" placeholder="e.g. 12.50" style="width:120px;">
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" data-k="hideLabel"${m.hideLabel ? ' checked' : ''}> Hide the label on the plan</label>
            </div>`, 'Save', (overlay) => {
              // Add a Delete button into the footer.
              const footer = overlay.querySelector('.modal-footer');
              if (footer) {
                const del = document.createElement('button');
                del.className = 'crop-btn cancel'; del.textContent = 'Delete'; del.dataset.act = 'delete';
                del.style.marginRight = 'auto'; del.style.color = '#e03131';
                footer.insertBefore(del, footer.firstChild);
                del.addEventListener('click', () => { overlay.remove(); deleteMeasurement(mid); });
              }
            });
        if (!v) return;
        // Apply to the model.
        m.label = (v.label || '').trim();
        m.subject = (v.subject || m.type).trim();
        m.color = v.color || m.color;
        m.thickness = Math.max(1, parseInt(v.thickness, 10) || m.thickness);
        m.hideLabel = !!v.hideLabel;
        if (v.unitCost !== undefined) {
            const uc = parseFloat(v.unitCost);
            m.unitCost = (v.unitCost === '' || isNaN(uc)) ? null : uc;
        }
        if (m.kind === 'mvolume' && v.depth !== undefined) {
            const d = parseFloat(v.depth);
            if (d > 0) { m.depth = d; _recomputeMeasure(m); }
        }
        shape.set({ stroke: m.color, strokeWidth: m.thickness });
        const lbl = fabricCanvas.getObjects().find(o => o._midLink === mid && o.type === 'text');
        if (lbl) {
            lbl.set({ visible: !m.hideLabel });
            _relabelMeasure(m, shape);
        }
        fabricCanvas.requestRenderAll();
        saveAnnotationState(); saveCurrentAnnotations();
        if (window.renderMeasureList) window.renderMeasureList();
        setStatus('Measurement updated');
    }
    window.editMeasurement = editMeasurement;

    // Remove a measurement's label + decor (arc/circle) + cutouts, given its id.
    // Used by every delete path so nothing is left orphaned on the sheet (M5/M8).
    function _removeMeasureExtras(mid) {
        if (!mid || !fabricCanvas) return;
        const kill = [];
        fabricCanvas.forEachObject((o) => {
            if (o._midLink === mid) kill.push(o);
            if (o._cutoutFor === mid) kill.push(o);
            if (o._measureDecor && o._decorFor === mid) kill.push(o);
        });
        _isRestoring = true; kill.forEach(o => fabricCanvas.remove(o)); _isRestoring = false;
    }

    // Delete a measurement AND its linked label + any decor (arc/circle) so no
    // orphaned caption is left painted on the sheet (M5).
    function deleteMeasurement(mid) {
        const shape = _findMeasureShape(mid);
        if (!shape) { showToast('Open the page that measurement is on to delete it'); return; }
        _removeMeasureExtras(mid);
        _isRestoring = true; fabricCanvas.remove(shape); _isRestoring = false;
        fabricCanvas.requestRenderAll();
        saveAnnotationState(); saveCurrentAnnotations();
        if (window.renderMeasureList) window.renderMeasureList();
        setStatus('Measurement deleted');
    }
    window.deleteMeasurement = deleteMeasurement;

    // Duplicate a measurement, offset slightly, as a fresh independent markup.
    function duplicateMeasurement(mid) {
        const shape = _findMeasureShape(mid);
        if (!shape) return;
        shape.clone((clone) => {
            clone.set({ left: (shape.left || 0) + 16, top: (shape.top || 0) + 16 });
            const nm = { ...shape._measure }; nm._mid = _newMid();
            clone._measure = nm;
            fabricCanvas.add(clone);
            const cx = clone.left, cy = (clone.top || 0) - 12;
            const lbl = measureLabel(_autoLabelText(nm), cx, cy);
            lbl.selectable = true; lbl._midLink = nm._mid; lbl._measureLabelFor = nm;
            fabricCanvas.add(lbl);
            fabricCanvas.requestRenderAll();
            saveAnnotationState(); saveCurrentAnnotations();
            if (window.renderMeasureList) window.renderMeasureList();
            setStatus('Measurement duplicated');
        }, ['_measure']);
    }
    window.duplicateMeasurement = duplicateMeasurement;

    // Export all measurements to a CSV the user can open in Excel (Quantity Link
    // equivalent) - type, page, value, unit, plus the per-type totals.
    // Shared measurement + totals tables used by both the xlsx and csv paths.
    function _buildMeasureTables() {
        const rows = collectMeasurements();
        const uSuf = (m) => m.unit + (m.cubic ? '³' : m.area ? '²' : '');
        const detail = rows.map((m) => ({
            Type: m.type,
            Subject: m.subject || m.type,
            Page: m.page,
            Value: m.kind === 'mcount' ? m.value : +m.value.toFixed(4),
            Unit: uSuf(m),
            'Unit cost': m.unitCost != null ? m.unitCost : '',
            'Extended cost': m.unitCost != null ? +(m.value * m.unitCost).toFixed(2) : '',
            Label: m.label || '',
        }));
        const tmap = {};
        rows.forEach((m) => {
            const grp = m.subject || m.type;
            const k = grp + '|' + m.type + '|' + uSuf(m);
            tmap[k] = tmap[k] || { Subject: grp, Type: m.type, Unit: uSuf(m), Total: 0, Count: 0, kind: m.kind, Cost: 0, hasCost: false };
            tmap[k].Total += m.value; tmap[k].Count++;
            if (m.unitCost != null) { tmap[k].hasCost = true; tmap[k].Cost += m.value * m.unitCost; }
        });
        const totals = Object.values(tmap).map((t) => ({
            Subject: t.Subject, Type: t.Type,
            Total: t.kind === 'mcount' ? t.Count : +t.Total.toFixed(4),
            Unit: t.Unit, Count: t.Count,
            'Extended cost': t.hasCost ? +t.Cost.toFixed(2) : '',
        }));
        return { rows, detail, totals };
    }

    // Export to a real Excel workbook (Measurements + Totals sheets) using the
    // bundled SheetJS. Falls back to CSV if the library can't be loaded.
    window.exportMeasurements = async function exportMeasurements() {
        const { rows, detail, totals } = _buildMeasureTables();
        if (!rows.length) { showToast('No measurements to export'); return; }
        const base = (state.fileName || 'document').replace(/\.pdf$/i, '') + '_measurements';
        try {
            if (typeof XLSX === 'undefined') {
                await loadScript('libs/xlsx.full.min.js')
                    .catch(() => loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'));
            }
            const wb = XLSX.utils.book_new();
            const wsD = XLSX.utils.json_to_sheet(detail, { header: ['Type', 'Subject', 'Page', 'Value', 'Unit', 'Unit cost', 'Extended cost', 'Label'] });
            const wsT = XLSX.utils.json_to_sheet(totals, { header: ['Subject', 'Type', 'Total', 'Unit', 'Count', 'Extended cost'] });
            XLSX.utils.book_append_sheet(wb, wsD, 'Measurements');
            XLSX.utils.book_append_sheet(wb, wsT, 'Totals');
            XLSX.writeFile(wb, base + '.xlsx');
            showToast('Exported ' + rows.length + ' measurements to Excel (.xlsx)');
        } catch (e) {
            console.warn('xlsx export failed, falling back to CSV:', e);
            _exportMeasurementsCsv(detail, totals, base, rows.length);
        }
    };

    function _exportMeasurementsCsv(detail, totals, base, n) {
        const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
        let csv = 'Type,Subject,Page,Value,Unit,Unit cost,Extended cost,Label\n';
        detail.forEach((r) => { csv += [esc(r.Type), esc(r.Subject), r.Page, r.Value, esc(r.Unit), r['Unit cost'], r['Extended cost'], esc(r.Label)].join(',') + '\n'; });
        csv += '\nTotals\nSubject,Type,Total,Unit,Count,Extended cost\n';
        totals.forEach((t) => { csv += [esc(t.Subject), esc(t.Type), t.Total, esc(t.Unit), t.Count, t['Extended cost']].join(',') + '\n'; });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = base + '.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        showToast('Exported ' + n + ' measurements to CSV');
    }

    window.toggleMeasureList = function toggleMeasureList() {
        const panel = document.getElementById('measureListPanel');
        if (!panel) return;
        const showing = panel.style.display !== 'none';
        panel.style.display = showing ? 'none' : 'flex';
        if (!showing) window.renderMeasureList();
    };

    let dragKind = 'rect'; // kind locked at mousedown — menu changes mid-drag can't corrupt it
    // Build a complete arrow as ONE filled polygon path (shaft + head cut
    // from the same outline) — the shaft is always perfectly centred on the
    // head, at any thickness. Used live during the drag AND as the final object.
    function makeArrow(x1, y1, x2, y2, stroke, strokeWidth, dash, isDouble) {
        const rad = Math.atan2(y2 - y1, x2 - x1);
        const ux = Math.cos(rad), uy = Math.sin(rad);
        const nx = -uy, ny = ux;                       // unit normal
        const hw = Math.max(1.2, strokeWidth / 2);     // shaft half-width
        const dist = Math.hypot(x2 - x1, y2 - y1);
        // Head length wants to scale with stroke, but must never exceed the
        // drag itself or the polygon self-intersects (bowtie) on short drags.
        const hLen = Math.min(Math.max(14, strokeWidth * 4.5),
                              dist * (isDouble ? 0.42 : 0.85));  // head length
        const hHalf = hLen * 0.45;                     // head half-width
        const P = (px, py) => px.toFixed(2) + ' ' + py.toFixed(2);
        // head base points (front)
        const bx = x2 - ux * hLen, by = y2 - uy * hLen;
        // tail: plain end or mirrored head (double arrow)
        const tbx = x1 + ux * hLen, tby = y1 + uy * hLen;
        let d;
        if (isDouble) {
            d = 'M ' + P(x1, y1) +
                ' L ' + P(tbx + nx * hHalf, tby + ny * hHalf) +
                ' L ' + P(tbx + nx * hw, tby + ny * hw) +
                ' L ' + P(bx + nx * hw, by + ny * hw) +
                ' L ' + P(bx + nx * hHalf, by + ny * hHalf) +
                ' L ' + P(x2, y2) +
                ' L ' + P(bx - nx * hHalf, by - ny * hHalf) +
                ' L ' + P(bx - nx * hw, by - ny * hw) +
                ' L ' + P(tbx - nx * hw, tby - ny * hw) +
                ' L ' + P(tbx - nx * hHalf, tby - ny * hHalf) +
                ' Z';
        } else {
            d = 'M ' + P(x1 + nx * hw, y1 + ny * hw) +
                ' L ' + P(bx + nx * hw, by + ny * hw) +
                ' L ' + P(bx + nx * hHalf, by + ny * hHalf) +
                ' L ' + P(x2, y2) +
                ' L ' + P(bx - nx * hHalf, by - ny * hHalf) +
                ' L ' + P(bx - nx * hw, by - ny * hw) +
                ' L ' + P(x1 - nx * hw, y1 - ny * hw) +
                ' Z';
        }
        const p = new fabric.Path(d, {
            fill: stroke, stroke: null, strokeWidth: 0,
            strokeLineJoin: 'round',
        });
        p.setControlsVisibility({ ml: false, mt: false, mr: false, mb: false });
        return p;
    }

    // Puffy callout cloud (white fill, colored outline) — normalized path.
    const CLOUD_PATH = 'M 168 96 C 190 96 200 82 198 68 C 210 58 206 38 192 34 C 192 18 176 8 162 12 ' +
        'C 154 0 134 -2 124 8 C 112 -4 90 -2 82 10 C 66 2 46 8 42 24 C 24 22 10 34 12 50 ' +
        'C 0 56 0 76 12 82 C 12 96 28 106 44 102 C 52 114 74 118 86 108 C 98 120 122 120 132 108 ' +
        'C 144 116 164 110 168 96 Z';

    function handleShapeStart(opt) {
        if (state.activeTool !== 'shape') return;
        // Polyline/polygon are multi-click (handled by polyAddPoint), not drag.
        if (shapeKind === 'polyline' || shapeKind === 'polygon') return;
        // Count is click-to-drop (handled by handleCountClick), not drag.
        if (shapeKind === 'count') return;
        // Measurement tools are click-based (handled by handleMeasureClick).
        if (_MEASURE_KINDS.includes(shapeKind)) return;
        if (opt.target) return;

        dragKind = shapeKind;
        shapeStartPoint = fabricCanvas.getPointer(opt.e);
        const sw = parseInt(dom.sizePicker.value, 10);
        const base = {
            fill: 'transparent',
            stroke: dom.colorPicker.value,
            strokeWidth: sw,
            selectable: false,
            strokeDashArray: shapeDash(sw),
            strokeLineCap: shapeStyle === 'dotted' ? 'round' : 'butt',
            // Keep the border a constant visual thickness when the shape is
            // resized (without this, scaling a shape also fattens its outline).
            strokeUniform: true,
        };
        if (dragKind === 'line' || dragKind === 'arrow' || dragKind === 'arrow2') {
            currentShape = new fabric.Line(
                [shapeStartPoint.x, shapeStartPoint.y, shapeStartPoint.x, shapeStartPoint.y], base);
        } else if (dragKind === 'ellipsecallout') {
            // Speech bubble: live-preview as the actual ellipse body so the user
            // sees the bubble forming; tail + text are added on mouseup.
            currentShape = new fabric.Ellipse({ left: shapeStartPoint.x, top: shapeStartPoint.y, rx: 0, ry: 0,
                ...base, fill: 'rgba(255,255,255,0.85)' });
            setStatus('Drag to size the speech bubble - release to add text');
        } else if (dragKind === 'callout') {
            // Text callout: live-preview as a rounded note box (not a plain
            // square) so it's clear you're drawing a callout; leader line + text
            // are added on mouseup.
            currentShape = new fabric.Rect({ left: shapeStartPoint.x, top: shapeStartPoint.y, width: 0, height: 0,
                rx: 6, ry: 6, ...base, fill: 'rgba(255,255,255,0.85)' });
            setStatus('Drag to size the note box - release to add text');
        } else if (dragKind === 'circle') {
            currentShape = new fabric.Ellipse({ left: shapeStartPoint.x, top: shapeStartPoint.y, rx: 0, ry: 0, ...base });
        } else if (dragKind === 'triangle') {
            currentShape = new fabric.Triangle({ left: shapeStartPoint.x, top: shapeStartPoint.y, width: 0, height: 0, ...base });
        } else if (dragKind === 'redact') {
            // TRUE redaction: solid black box; on save the whole page is
            // rasterized so the covered content is permanently destroyed.
            currentShape = new fabric.Rect({ left: shapeStartPoint.x, top: shapeStartPoint.y, width: 0, height: 0,
                fill: '#000000', stroke: null, strokeWidth: 0, selectable: false, _isRedact: true });
        } else {
            // rect / square — also the drag ghost for cloud (dashed until mouseup)
            currentShape = new fabric.Rect({ left: shapeStartPoint.x, top: shapeStartPoint.y, width: 0, height: 0,
                ...base, ...(dragKind === 'cloud' ? { strokeDashArray: [6, 4] } : {}) });
        }
        // Suppress object:added state save — we'll save the final state in handleShapeEnd
        _isRestoring = true;
        fabricCanvas.add(currentShape);
        _isRestoring = false;
    }

    function handleShapeMove(opt) {
        if (state.activeTool !== 'shape' || !currentShape || !shapeStartPoint) return;

        const pointer = fabricCanvas.getPointer(opt.e);
        const width = pointer.x - shapeStartPoint.x;
        const height = pointer.y - shapeStartPoint.y;

        if (dragKind === 'arrow' || dragKind === 'arrow2') {
            // Rebuild the full arrow each move — the user sees the REAL arrow
            // (with its head) while dragging, not a bare line.
            const dist = Math.hypot(pointer.x - shapeStartPoint.x, pointer.y - shapeStartPoint.y);
            _isRestoring = true;
            fabricCanvas.remove(currentShape);
            if (dist > 18) {
                currentShape = makeArrow(shapeStartPoint.x, shapeStartPoint.y, pointer.x, pointer.y,
                    dom.colorPicker.value, parseInt(dom.sizePicker.value, 10) || 2,
                    shapeDash(parseInt(dom.sizePicker.value, 10) || 2), dragKind === 'arrow2');
                currentShape.set({ selectable: false });
            } else {
                currentShape = new fabric.Line(
                    [shapeStartPoint.x, shapeStartPoint.y, pointer.x, pointer.y],
                    { stroke: dom.colorPicker.value, strokeWidth: parseInt(dom.sizePicker.value, 10) || 2, selectable: false });
            }
            fabricCanvas.add(currentShape);
            _isRestoring = false;
        } else if (dragKind === 'line') {
            currentShape.set({ x2: pointer.x, y2: pointer.y });
        } else if (dragKind === 'circle' || dragKind === 'ellipsecallout') {
            currentShape.set({
                left: width >= 0 ? shapeStartPoint.x : pointer.x,
                top: height >= 0 ? shapeStartPoint.y : pointer.y,
                rx: Math.abs(width) / 2,
                ry: Math.abs(height) / 2,
            });
        } else {
            let w = Math.abs(width), h = Math.abs(height);
            if (dragKind === 'square') w = h = Math.max(w, h); // constrain 1:1
            currentShape.set({
                left: width >= 0 ? shapeStartPoint.x : pointer.x - (dragKind === 'square' ? w - Math.abs(width) : 0),
                top: height >= 0 ? shapeStartPoint.y : pointer.y - (dragKind === 'square' ? h - Math.abs(height) : 0),
                width: w,
                height: h,
            });
        }
        currentShape.setCoords();
        fabricCanvas.renderAll();
    }

    function handleShapeEnd() {
        if (state.activeTool !== 'shape' || !currentShape) return;

        const bb = currentShape.getBoundingRect(true, true);
        if (bb.width < 5 && bb.height < 5) {
            fabricCanvas.remove(currentShape);
            currentShape = null;
            shapeStartPoint = null;
            return;
        }

        const stroke = currentShape.stroke, strokeWidth = currentShape.strokeWidth;
        const dash = shapeDash(strokeWidth);
        if (dragKind === 'arrow' || dragKind === 'arrow2') {
            // The live preview already IS the final arrow group; a drag too
            // short to grow a head stays a plain line — discard it.
            if (currentShape.type !== 'path') {
                fabricCanvas.remove(currentShape);
                currentShape = null;
                shapeStartPoint = null;
                fabricCanvas.renderAll();
                return;
            }
        } else if (dragKind === 'cloud') {
            // Swap the dashed ghost rect for the puffy callout cloud: white
            // body, colored outline — scaled to the dragged box.
            const { left, top, width, height } = currentShape;
            fabricCanvas.remove(currentShape);
            const w = Math.max(width, 40), h = Math.max(height, 26);
            currentShape = new fabric.Path(CLOUD_PATH, {
                left, top, fill: '#ffffff', stroke, strokeWidth, strokeDashArray: dash,
                strokeLineJoin: 'round', strokeUniform: true,
            });
            currentShape.scaleX = w / currentShape.width;
            currentShape.scaleY = h / currentShape.height;
            _isRestoring = true;
            fabricCanvas.add(currentShape);
            _isRestoring = false;
        } else if (dragKind === 'callout' || dragKind === 'ellipsecallout') {
            // Build a callout from THREE SEPARATE objects (not grouped): a note
            // body, a leader line, and editable text. Kept separate so the user
            // can select the leader line ON ITS OWN and drag its endpoints to
            // change its length/angle freely - impossible inside a locked group.
            const r = currentShape.getBoundingRect(true, true);
            fabricCanvas.remove(currentShape);
            const bw = Math.max(r.width, 90), bh = Math.max(r.height, 44);
            const bx = r.left, by = r.top;
            const body = (dragKind === 'ellipsecallout')
                ? new fabric.Ellipse({ left: bx + bw / 2, top: by + bh / 2, originX: 'center', originY: 'center',
                    rx: bw / 2, ry: bh / 2, fill: '#ffffff', stroke, strokeWidth, strokeUniform: true })
                : new fabric.Rect({ left: bx, top: by, width: bw, height: bh, rx: 4, ry: 4,
                    fill: '#ffffff', stroke, strokeWidth, strokeUniform: true });
            // Leader line: it must START on the body's edge (touch it), then
            // point out below-left to what it's referring to.
            let x1, y1;
            if (dragKind === 'ellipsecallout') {
                // A point ON the ellipse perimeter in the lower-left direction,
                // so the line visibly connects to the bubble (the box corner
                // would float outside the curve).
                const cx = bx + bw / 2, cy = by + bh / 2, rx = bw / 2, ry = bh / 2;
                const ang = Math.PI * 0.72; // ~130deg → lower-left of the ellipse
                x1 = cx + rx * Math.cos(ang);
                y1 = cy + ry * Math.sin(ang);
            } else {
                x1 = bx + bw * 0.15; y1 = by + bh; // bottom edge of the rect
            }
            const x2 = bx - Math.min(60, bw * 0.6), y2 = by + bh + Math.min(50, bh);
            const tail = new fabric.Line([x1, y1, x2, y2], { stroke, strokeWidth, strokeUniform: true });
            tail._calloutTail = true;
            const txt = new fabric.Textbox('', {
                left: bx + 10, top: by + 8, width: bw - 20, fontSize: Math.max(12, strokeWidth * 6),
                fill: stroke, fontFamily: 'sans-serif', editable: true, splitByGrapheme: false,
            });
            _isRestoring = true;
            fabricCanvas.add(body);
            fabricCanvas.add(tail);
            fabricCanvas.add(txt);
            _isRestoring = false;
            body.setCoords(); tail.setCoords(); txt.setCoords();
            // Put the cursor straight into the empty note so the user can type.
            fabricCanvas.setActiveObject(txt);
            txt.enterEditing();
            currentShape = body; // the drag-end handler finalizes on this
            setStatus('Type your note - click the leader line alone to drag its ends and change its length');
        }

        currentShape.set({ selectable: true });
        currentShape.setCoords();
        fabricCanvas.renderAll();
        // Save final shape state (object:added fired at 0×0 start — this captures final size)
        saveAnnotationState();

        currentShape = null;
        shapeStartPoint = null;
    }

    // ── Text-snap highlight / underline / strikethrough ──
    // Drag across text: marks snap to the words underneath. While dragging the
    // ACTIVE selection previews in GREEN; on release it commits in the picked
    // color (default yellow), matching the reviewer redline convention.
    let drawMode = 'pen'; // pen | pencil | marker | spray
    window.setDrawMode = (m) => {
        drawMode = m;
        if (state.activeTool === 'draw') applyToolMode();
    };
    let highlightMode = 'text'; // text | free | underline | strike
    window.setHighlightMode = (m) => {
        highlightMode = m;
        if (state.activeTool === 'highlight') applyToolMode();
    };
    let _hlStart = null;
    let _hlPreview = [];

    function _hlEntriesIn(x0, y0, x1, y1) {
        if (!_textItemsCache) return [];
        const L = Math.min(x0, x1), R = Math.max(x0, x1);
        const T = Math.min(y0, y1), B = Math.max(y0, y1);
        return _textItemsCache.filter(({ bbox }) =>
            bbox.left < R && bbox.left + bbox.width > L &&
            bbox.top < B && bbox.top + bbox.height > T);
    }

    // Clip the matched text runs to the actual drag range, so highlighting a
    // few WORDS marks only those words (not the whole run/sentence). Behaves
    // like real text selection: on one line both ends clip; across lines the
    // first line clips from the start point, the last to the end point.
    function _hlClipped(x0, y0, x1, y1) {
        const ents = _hlEntriesIn(x0, y0, x1, y1);
        if (!ents.length) return [];
        const L = Math.min(x0, x1), R = Math.max(x0, x1);
        const rowOf = (e) => Math.round(e.baseline / 4);
        const rows = [...new Set(ents.map(rowOf))].sort((a, b) => a - b);
        const firstRow = rows[0], lastRow = rows[rows.length - 1];
        const topX = y0 <= y1 ? x0 : x1;   // x of the point on the upper line
        const botX = y0 <= y1 ? x1 : x0;   // x of the point on the lower line
        const out = [];
        for (const e of ents) {
            const b = e.bbox;
            let left = b.left, right = b.left + b.width;
            const row = rowOf(e);
            if (rows.length === 1) { left = Math.max(left, L); right = Math.min(right, R); }
            else if (row === firstRow) left = Math.max(left, topX);
            else if (row === lastRow) right = Math.min(right, botX);
            if (right - left < 2) continue;
            out.push({ ...e, bbox: { left, top: b.top, width: right - left, height: b.height } });
        }
        return out;
    }

    function _hlMakeMarks(entries, color, active) {
        const marks = [];
        for (const en of entries) {
            const { bbox, baseline, fontSizePx } = en;
            if (highlightMode === 'underline') {
                marks.push(new fabric.Rect({
                    left: bbox.left, top: baseline + Math.max(1.5, fontSizePx * 0.06),
                    width: bbox.width, height: Math.max(1.5, fontSizePx * 0.07),
                    fill: color, selectable: !active, evented: !active,
                }));
            } else if (highlightMode === 'strike') {
                marks.push(new fabric.Rect({
                    left: bbox.left, top: baseline - fontSizePx * 0.32,
                    width: bbox.width, height: Math.max(1.5, fontSizePx * 0.08),
                    fill: color, selectable: !active, evented: !active,
                }));
            } else {
                marks.push(new fabric.Rect({
                    left: bbox.left - 1, top: bbox.top,
                    width: bbox.width + 2, height: bbox.height,
                    fill: color, opacity: 0.38, selectable: !active, evented: !active,
                }));
            }
        }
        return marks;
    }

    function _hlClearPreview() {
        for (const m of _hlPreview) fabricCanvas.remove(m);
        _hlPreview = [];
    }

    function handleHilightStart(opt) {
        if (state.activeTool !== 'highlight' || highlightMode === 'free') return;
        _hlStart = fabricCanvas.getPointer(opt.e);
    }

    function handleHilightMove(opt) {
        if (!_hlStart || state.activeTool !== 'highlight' || highlightMode === 'free') return;
        const p = fabricCanvas.getPointer(opt.e);
        _isRestoring = true;
        _hlClearPreview();
        // Active selection previews GREEN (committed marks keep their color).
        _hlPreview = _hlMakeMarks(_hlClipped(_hlStart.x, _hlStart.y, p.x, p.y), '#22a95c', true);
        for (const m of _hlPreview) fabricCanvas.add(m);
        _isRestoring = false;
        fabricCanvas.renderAll();
    }

    function handleHilightEnd(opt) {
        if (!_hlStart || state.activeTool !== 'highlight' || highlightMode === 'free') return;
        const p = fabricCanvas.getPointer(opt.e);
        const start = _hlStart;
        _hlStart = null;
        _isRestoring = true;
        _hlClearPreview();
        _isRestoring = false;
        const entries = _hlClipped(start.x, start.y, p.x, p.y);
        if (!entries.length) {
            showToast('No text there — switch Highlight to Freehand for drawings');
            fabricCanvas.renderAll();
            return;
        }
        // Commit in the picked color. Untouched black defaults to marker
        // yellow for HIGHLIGHTS only — a black underline/strike is legitimate.
        const chosen = (highlightMode === 'text' && dom.colorPicker.value === '#000000')
            ? '#FFEB3B' : dom.colorPicker.value;
        const marks = _hlMakeMarks(entries, chosen, false);
        _isRestoring = true;
        for (const m of marks) fabricCanvas.add(m);
        _isRestoring = false;
        fabricCanvas.renderAll();
        saveAnnotationState();
    }

    // ── Comment on selected text ──
    // Armed by the "Comment on text" button in the panel: drag over a phrase,
    // it gets a RED redline mark and the comment is anchored to that snippet.
    let _tcArmed = false, _tcStart = null, _tcPreview = [];
    let _pendingAnchor = null; // { snippet, nx, ny } — set until Add Comment

    window.armTextComment = () => {
        if (!state.pdfDoc) return;
        _tcArmed = true;
        if (!_textItemsCache) buildTextItemsCache(state.currentPage);
        setActiveTool('select');
        if (fabricCanvas) {
            fabricCanvas.selection = false;
            fabricCanvas.defaultCursor = 'text';
            fabricCanvas.forEachObject((o) => { o.selectable = false; o.evented = false; });
        }
        setStatus('Drag across the words you want to comment on...');
    };

    function _tcMarks(entries, opacity) {
        const color = (document.getElementById('commentColor') || {}).value || '#e53935';
        return entries.map(({ bbox }) => new fabric.Rect({
            left: bbox.left - 1, top: bbox.top, width: bbox.width + 2, height: bbox.height,
            fill: color, opacity, selectable: false, evented: false, _isCommentMark: true,
        }));
    }

    function handleTextCommentStart(opt) {
        if (!_tcArmed) return;
        _tcStart = fabricCanvas.getPointer(opt.e);
    }
    function handleTextCommentMove(opt) {
        if (!_tcArmed || !_tcStart) return;
        const p = fabricCanvas.getPointer(opt.e);
        _isRestoring = true;
        for (const m of _tcPreview) fabricCanvas.remove(m);
        _tcPreview = _tcMarks(_hlClipped(_tcStart.x, _tcStart.y, p.x, p.y), 0.45);
        for (const m of _tcPreview) fabricCanvas.add(m);
        _isRestoring = false;
        fabricCanvas.renderAll();
    }
    function handleTextCommentEnd(opt) {
        if (!_tcArmed || !_tcStart) return;
        const p = fabricCanvas.getPointer(opt.e);
        const start = _tcStart;
        _tcStart = null;
        _isRestoring = true;
        for (const m of _tcPreview) fabricCanvas.remove(m);
        _tcPreview = [];
        _isRestoring = false;
        const entries = _hlClipped(start.x, start.y, p.x, p.y);
        if (!entries.length) { fabricCanvas.renderAll(); return; }
        commitTextCommentSelection(entries, opt.e && opt.e.clientX, opt.e && opt.e.clientY);
    }

    // Shared by the Comment tool AND the selection mini-toolbar: a small
    // popup composer appears AT the selection — type, press Add, done. Marks
    // are only drawn when the comment is actually submitted (cancel = clean).
    let _cmPopup = null;
    function commitTextCommentSelection(entries, clientX, clientY) {
        if (!_cmPopup) {
            _cmPopup = document.createElement('div');
            _cmPopup.id = 'commentPopup';
            _cmPopup.style.cssText = 'position:fixed;z-index:10001;display:none;width:260px;' +
                'background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;' +
                'padding:10px;box-shadow:0 8px 28px rgba(0,0,0,0.4);';
            _cmPopup.innerHTML =
                '<div id="cmPopSnippet" style="font-size:10.5px;color:var(--text-secondary);font-style:italic;' +
                'border-left:3px solid #e53935;padding:2px 8px;margin-bottom:7px;overflow:hidden;' +
                'text-overflow:ellipsis;white-space:nowrap;"></div>' +
                '<textarea id="cmPopText" rows="3" placeholder="Add your comment..." style="width:100%;box-sizing:border-box;' +
                'background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);' +
                'border-radius:8px;padding:7px;font-size:12.5px;font-family:inherit;resize:none;outline:none;"></textarea>' +
                '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px;">' +
                '<button id="cmPopCancel" style="border:1px solid var(--border);background:transparent;color:var(--text-secondary);' +
                'border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit;">Cancel</button>' +
                '<button id="cmPopAdd" style="border:none;background:var(--accent);color:#fff;border-radius:7px;' +
                'padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Add</button></div>';
            document.body.appendChild(_cmPopup);
            const hide = () => { _cmPopup.style.display = 'none'; _cmPopup._entries = null; };
            _cmPopup.querySelector('#cmPopCancel').addEventListener('click', hide);
            document.addEventListener('mousedown', (e) => {
                if (_cmPopup.style.display !== 'none' && !_cmPopup.contains(e.target)) hide();
            }, true);
            _cmPopup.querySelector('#cmPopText').addEventListener('keydown', (e) => {
                if (e.key === 'Escape') hide();
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) _cmPopup.querySelector('#cmPopAdd').click();
            });
            _cmPopup.querySelector('#cmPopAdd').addEventListener('click', () => {
                const ents = _cmPopup._entries;
                const text = _cmPopup.querySelector('#cmPopText').value.trim();
                if (!ents || !text) return;
                hide();
                // marks are drawn only now, on submit
                const marks = _tcMarks(ents, 0.3);
                _isRestoring = true;
                for (const m of marks) fabricCanvas.add(m);
                _isRestoring = false;
                fabricCanvas.renderAll();
                saveAnnotationState();
                const W = fabricCanvas.width, H = fabricCanvas.height;
                const snippet = ents.map(e => e.item.str).join(' ').trim().slice(0, 120);
                const b = ents[0].bbox;
                const page = state.currentPage;
                if (!state.comments[page]) state.comments[page] = [];
                commentIdCounter++;
                state.comments[page].push({
                    id: commentIdCounter, text,
                    time: new Date().toLocaleString(),
                    ref: snippet, nx: b.left / W, ny: b.top / H,
                    color: (document.getElementById('commentColor') || {}).value || '#e53935',
                    rects: ents.map(e => ({
                        nx: e.bbox.left / W, ny: e.bbox.top / H,
                        nw: e.bbox.width / W, nh: e.bbox.height / H,
                    })),
                });
                refreshCommentPanel();
                updateThumbnailBadges();
                showToast('Comment added — view all in Comments');
            });
        }
        _cmPopup._entries = entries;
        const snippet = entries.map(e => e.item.str).join(' ').trim();
        _cmPopup.querySelector('#cmPopSnippet').textContent = '\u201C' + snippet.slice(0, 60) + '\u201D';
        _cmPopup.querySelector('#cmPopText').value = '';
        _cmPopup.style.display = 'block';
        const px = Math.min(window.innerWidth - 280, Math.max(8, (clientX || window.innerWidth / 2) - 130));
        const py = Math.min(window.innerHeight - 190, Math.max(8, (clientY || 120) + 14));
        _cmPopup.style.left = px + 'px';
        _cmPopup.style.top = py + 'px';
        _cmPopup.querySelector('#cmPopText').focus();
    }

    // ── Import comments already in the PDF (from Acrobat, Preview, us) ──
    // Highlight/Text annotations with contents become entries in the comment
    // panel; their marked words are shown via ephemeral overlay rects. On the
    // next save they are re-written as annotations, so files ROUND-TRIP.
    async function importPdfComments() {
        try {
            let count = 0;
            for (let i = 1; i <= state.totalPages; i++) {
                const page = await state.pdfDoc.getPage(i);
                const annots = await page.getAnnotations().catch(() => []);
                const [vx0, vy0, vx1, vy1] = page.view;
                const W = vx1 - vx0, H = vy1 - vy0;
                for (const a of annots) {
                    if (a.subtype !== 'Highlight' && a.subtype !== 'Text') continue;
                    const text = ((a.contentsObj && a.contentsObj.str) || a.contents || '').trim();
                    if (!text) continue;
                    const color = a.color && a.color.length >= 3
                        ? '#' + [...a.color].slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
                        : '#e53935';
                    let rects = null;
                    if (a.quadPoints && a.quadPoints.length) {
                        rects = [];
                        for (const quad of a.quadPoints) {
                            const xs = quad.map(pt => pt.x), ys = quad.map(pt => pt.y);
                            const l = Math.min(...xs), r = Math.max(...xs);
                            const btm = Math.min(...ys), t = Math.max(...ys);
                            rects.push({ nx: (l - vx0) / W, ny: (vy1 - t) / H, nw: (r - l) / W, nh: (t - btm) / H });
                        }
                    }
                    if (!state.comments[i]) state.comments[i] = [];
                    commentIdCounter++;
                    state.comments[i].push({
                        id: commentIdCounter, text,
                        time: a.modificationDate || a.creationDate || '',
                        imported: true, color, ...(rects ? { rects, ref: '' } : {}),
                    });
                    count++;
                }
            }
            if (count) {
                refreshCommentPanel();
                updateThumbnailBadges();
                renderImportedCommentMarks(state.currentPage);
                showToast(count + ' comment' + (count === 1 ? '' : 's') + ' found in this PDF');
            }
        } catch (e) { console.warn('Comment import failed:', e); }
    }

    // Ephemeral overlay rects for imported comments (excludeFromExport: they
    // are re-added on every page restore and never persisted or re-baked).
    function renderImportedCommentMarks(pageNum) {
        if (!fabricCanvas) return;
        const cs = (state.comments[pageNum] || []).filter(c => c.imported && c.rects);
        if (!cs.length) return;
        _isRestoring = true;
        for (const c of cs) {
            for (const r of c.rects) {
                fabricCanvas.add(new fabric.Rect({
                    left: r.nx * fabricCanvas.width, top: r.ny * fabricCanvas.height,
                    width: r.nw * fabricCanvas.width, height: r.nh * fabricCanvas.height,
                    fill: c.color || '#e53935', opacity: 0.3,
                    selectable: false, evented: false,
                    excludeFromExport: true, _isCommentMark: true,
                }));
            }
        }
        _isRestoring = false;
        fabricCanvas.renderAll();
    }

    // ── Selection mini-toolbar (Acrobat-style) ──
    // With the plain Select cursor, dragging across words pops a small
    // "Highlight / Comment" toolbar at the cursor — no tool needed first.
    let _selStart = null, _miniBar = null;
    function ensureMiniBar() {
        if (_miniBar) return _miniBar;
        _miniBar = document.createElement('div');
        _miniBar.id = 'miniSelBar';
        _miniBar.style.cssText = 'position:fixed;z-index:10000;display:none;gap:2px;' +
            'background:var(--bg-secondary);border:1px solid var(--border);border-radius:9px;' +
            'padding:4px;box-shadow:0 5px 18px rgba(0,0,0,0.35);';
        const mk = (label, fn) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'border:none;background:transparent;color:var(--text-primary);' +
                'font-size:12px;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer;font-family:inherit;';
            b.addEventListener('mouseenter', () => b.style.background = 'var(--bg-hover)');
            b.addEventListener('mouseleave', () => b.style.background = 'transparent');
            b.addEventListener('click', fn);
            _miniBar.appendChild(b);
        };
        mk('📋 Copy', () => {
            const ents = _miniBar._entries; hideMiniBar();
            if (!ents) return;
            const text = ents.map(e => e.item.str).join(' ').replace(/\s+/g, ' ').trim();
            navigator.clipboard.writeText(text).then(
                () => showToast('Copied: "' + text.slice(0, 40) + (text.length > 40 ? '…"' : '"')),
                () => showToast('Copy failed'));
        });
        mk('🖍 Highlight', () => {
            const ents = _miniBar._entries; hideMiniBar();
            if (!ents) return;
            const chosen = dom.colorPicker.value === '#000000' ? '#FFEB3B' : dom.colorPicker.value;
            _isRestoring = true;
            for (const { bbox } of ents) fabricCanvas.add(new fabric.Rect({
                left: bbox.left - 1, top: bbox.top, width: bbox.width + 2, height: bbox.height,
                fill: chosen, opacity: 0.38,
            }));
            _isRestoring = false;
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        if (COMMENTS_ENABLED) mk('💬 Comment', () => {
            const ents = _miniBar._entries;
            const bx = parseFloat(_miniBar.style.left) || 0, by = parseFloat(_miniBar.style.top) || 0;
            hideMiniBar();
            if (ents) commitTextCommentSelection(ents, bx + 60, by + 30);
        });
        document.body.appendChild(_miniBar);
        document.addEventListener('mousedown', (e) => {
            if (_miniBar && !_miniBar.contains(e.target)) hideMiniBar();
        }, true);
        return _miniBar;
    }
    function hideMiniBar() { if (_miniBar) { _miniBar.style.display = 'none'; _miniBar._entries = null; } }

    function handleSelTextDown(opt) {
        _selStart = null;
        if (state.activeTool !== 'select' || _tcArmed || opt.target) return;
        _selStart = fabricCanvas.getPointer(opt.e);
    }
    function handleSelTextUp(opt) {
        const start = _selStart;
        _selStart = null;
        if (!start || state.activeTool !== 'select' || _tcArmed) return;
        if (fabricCanvas.getActiveObject()) return; // drag was an object selection
        const p = fabricCanvas.getPointer(opt.e);
        if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 8) return;
        if (!_textItemsCache) { buildTextItemsCache(state.currentPage); return; }
        const entries = _hlClipped(start.x, start.y, p.x, p.y);
        if (!entries.length) return;
        const bar = ensureMiniBar();
        bar._entries = entries;
        bar.style.display = 'flex';
        bar.style.left = Math.min(window.innerWidth - 200, (opt.e.clientX || 0) + 10) + 'px';
        bar.style.top = Math.max(8, (opt.e.clientY || 0) - 48) + 'px';
    }

    // ── Rotate handle with a visible rotate icon ──
    // Replaces fabric's anonymous dot above selections with an unmistakable
    // circular-arrow badge, so users know where to click-and-drag to rotate.
    (function () {
        if (!fabric.Object.prototype.controls || !fabric.controlsUtils) return;
        const renderRotate = (ctx, left, top) => {
            ctx.save();
            ctx.translate(left, top);
            // badge
            ctx.beginPath();
            ctx.arc(0, 0, 11, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#7c5cfc';
            ctx.stroke();
            // circular arrow
            ctx.beginPath();
            ctx.arc(0, 0, 5.5, -Math.PI * 0.25, Math.PI * 1.1);
            ctx.lineWidth = 1.8;
            ctx.strokeStyle = '#7c5cfc';
            ctx.stroke();
            // arrowhead at the arc start
            const ax = 5.5 * Math.cos(-Math.PI * 0.25), ay = 5.5 * Math.sin(-Math.PI * 0.25);
            ctx.beginPath();
            ctx.moveTo(ax + 3, ay - 1);
            ctx.lineTo(ax - 1.5, ay - 3.5);
            ctx.lineTo(ax + 1.5, ay + 3);
            ctx.closePath();
            ctx.fillStyle = '#7c5cfc';
            ctx.fill();
            ctx.restore();
        };
        fabric.Object.prototype.controls.mtr = new fabric.Control({
            x: 0, y: -0.5,
            offsetY: -32,
            withConnection: true,
            actionHandler: fabric.controlsUtils.rotationWithSnapping,
            cursorStyleHandler: fabric.controlsUtils.rotationStyleHandler,
            actionName: 'rotate',
            render: renderRotate,
            sizeX: 24, sizeY: 24,
        });
    })();

    // ── Annotation layers ──
    // Each markup carries _layerId. Toggling a layer flips the visibility of
    // its objects on the CURRENT page live; page restores re-apply it; saves
    // skip hidden layers, so several marked-up "options" can share one file.
    function layerById(id) { return state.layers.find(l => l.id === id); }
    function applyLayerVisibility() {
        if (!fabricCanvas) return;
        const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
        fabricCanvas.forEachObject((o) => {
            if (o.excludeFromExport) return;
            const layerHidden = o._layerId !== undefined && hidden.has(o._layerId);
            // A measurement caption also stays hidden when labels are globally off.
            const labelHidden = o._midLink && o.type === 'text' && _measureLabelsHidden;
            o.visible = !layerHidden && !labelHidden;
        });
        fabricCanvas.renderAll();
        if (window.renderMeasureList) window.renderMeasureList();   // list follows layer changes (M31)
    }
    window.pdfLayers = {
        list: () => state.layers.map(l => ({ ...l, active: l.id === state.activeLayer })),
        add: (name, color) => {
            const layer = { id: state.nextLayerId++, name: name || ('Layer ' + state.nextLayerId), visible: true, color: color || null };
            state.layers.push(layer);
            window.pdfLayers.setActive(layer.id);
            return layer;
        },
        rename: (id, name) => { const l = layerById(id); if (l && name) l.name = name; },
        setColor: (id, color) => {
            const l = layerById(id); if (!l) return;
            l.color = color;
            if (id === state.activeLayer && color) dom.colorPicker.value = color;
        },
        setVisible: (id, vis) => {
            const l = layerById(id); if (!l) return;
            l.visible = !!vis;
            applyLayerVisibility();
        },
        setActive: (id) => {
            const l = layerById(id); if (!l) return;
            state.activeLayer = id;
            if (!l.visible) { l.visible = true; applyLayerVisibility(); } // marking on a hidden layer makes no sense
            if (l.color) dom.colorPicker.value = l.color; // layer color = default ink
            setStatus('Drawing on layer: ' + l.name + ' — everything you add now belongs to it');
        },
        assignSelected: (id) => {
            // Move the currently selected markup(s) onto another layer
            const l = layerById(id); if (!l || !fabricCanvas) return 0;
            const sel = fabricCanvas.getActiveObjects().filter(o => !o.excludeFromExport);
            if (!sel.length) { showToast('Select a markup on the page first'); return 0; }
            sel.forEach(o => { o._layerId = id; });
            applyLayerVisibility();
            saveAnnotationState();
            saveCurrentAnnotations();
            showToast(sel.length + ' markup' + (sel.length === 1 ? '' : 's') + ' moved to "' + l.name + '"');
            return sel.length;
        },
        counts: () => {
            // markups per layer on the CURRENT page (for the panel badges)
            const c = {};
            if (fabricCanvas) fabricCanvas.forEachObject((o) => {
                if (o.excludeFromExport) return;
                const id = o._layerId !== undefined ? o._layerId : state.activeLayer;
                c[id] = (c[id] || 0) + 1;
            });
            return c;
        },
        remove: (id) => {
            if (state.layers.length <= 1) return false;
            state.layers = state.layers.filter(l => l.id !== id);
            if (state.activeLayer === id) state.activeLayer = state.layers[0].id;
            // Delete the layer's objects on the current page; other pages'
            // objects are dropped lazily on restore (orphan filter below).
            const gone = [];
            fabricCanvas.forEachObject((o) => { if (o._layerId === id) gone.push(o); });
            _isRestoring = true;
            gone.forEach(o => fabricCanvas.remove(o));
            _isRestoring = false;
            fabricCanvas.renderAll();
            saveAnnotationState();
            saveCurrentAnnotations();
            return true;
        },
    };

    // ── Clickable links: external URLs + internal jumps, like a real viewer ──
    async function renderPageLinks(pageNum) {
        document.querySelectorAll('.pdf-link').forEach(el => el.remove());
        try {
            const pg = await state.pdfDoc.getPage(pageNum);
            if (state.currentPage !== pageNum) return;
            const annots = await pg.getAnnotations();
            const viewport = pg.getViewport({ scale: state.zoom });
            for (const a of annots) {
                if (a.subtype !== 'Link' || !a.rect) continue;
                const [x1, y1, x2, y2] = a.rect;
                const [vx1, vy1] = viewport.convertToViewportPoint(x1, y2);
                const [vx2, vy2] = viewport.convertToViewportPoint(x2, y1);
                const el = document.createElement('div');
                el.className = 'pdf-link';
                // Links must not steal clicks while a markup/measure tool is armed
                // (N1) - the wrapper class gates their pointer-events via CSS.
                el.style.cssText = 'position:absolute;cursor:pointer;z-index:40;' +
                    'left:' + Math.min(vx1, vx2) + 'px;top:' + Math.min(vy1, vy2) + 'px;' +
                    'width:' + Math.abs(vx2 - vx1) + 'px;height:' + Math.abs(vy2 - vy1) + 'px;';
                el.title = a.url || 'Go to page';
                el.addEventListener('click', async (ev) => {
                    // Don't navigate while ANY markup tool is armed (B2): the click
                    // is meant for the canvas (place a stamp, start a shape, etc).
                    // Covers tools that arm via menus (Stamp) as well as data-tools.
                    if (_isMarkupModeActive()) { ev.stopPropagation(); return; }
                    ev.stopPropagation();
                    if (a.url) { window.open(a.url, '_blank', 'noopener'); return; }
                    try {
                        let dest = a.dest;
                        if (typeof dest === 'string') dest = await state.pdfDoc.getDestination(dest);
                        if (Array.isArray(dest) && dest[0]) {
                            const idx = await state.pdfDoc.getPageIndex(dest[0]);
                            goToPage(idx + 1);
                        }
                    } catch (_) { /* unresolvable destination */ }
                });
                dom.canvasWrapper.appendChild(el);
            }
        } catch (_) { /* links are best-effort */ }
    }

    // ── Print: every page rendered WITH its annotations, via system dialog ──
    async function printPdf() {
        if (!state.pdfDoc) return;
        setStatus('Preparing print...');
        try {
            saveCurrentAnnotations();
            const imgs = [];
            for (let p = 1; p <= state.totalPages; p++) {
                setStatus('Preparing page ' + p + '/' + state.totalPages + ' for print...');
                const pg = await state.pdfDoc.getPage(p);
                const vp = pg.getViewport({ scale: 2 });
                const cnv = document.createElement('canvas');
                cnv.width = vp.width; cnv.height = vp.height;
                const c2 = cnv.getContext('2d');
                c2.fillStyle = '#fff'; c2.fillRect(0, 0, cnv.width, cnv.height);
                await pg.render({ canvasContext: c2, viewport: vp }).promise;
                // flatten this page's annotations on top (same as the save path)
                const entry = state.annotations[p];
                const objs = entry && (entry.fabricData || entry).objects;
                if (objs && objs.length) {
                    const annotZoom = entry.zoom || 1;
                    const dispW = (await state.pdfDoc.getPage(p)).getViewport({ scale: annotZoom }).width;
                    const f = vp.width / dispW;
                    const live = new Set(state.layers.map(l => l.id));
                    const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
                    const use = objs.filter(o => !(o._layerId !== undefined && (hidden.has(o._layerId) || !live.has(o._layerId))));
                    if (use.length) {
                        const insts = await new Promise((res) => fabric.util.enlivenObjects(use, res));
                        const tmp = new fabric.StaticCanvas(null, { width: cnv.width, height: cnv.height });
                        tmp.setZoom(f);
                        insts.forEach(o => { if (o) tmp.add(o); });
                        tmp.renderAll();
                        c2.drawImage(tmp.lowerCanvasEl, 0, 0, cnv.width, cnv.height);
                    }
                }
                imgs.push(cnv.toDataURL('image/jpeg', 0.92));
            }
            if (location.search.includes('testhooks')) {
                // test mode: report what WOULD print instead of opening the dialog
                window.__printImgs = imgs.length;
                setStatus('Print prepared: ' + imgs.length + ' page(s)');
                return;
            }
            const frame = document.createElement('iframe');
            frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
            document.body.appendChild(frame);
            const doc = frame.contentDocument;
            doc.open();
            doc.write('<html><head><title>' + escapeHtml(state.fileName || 'document') + '</title><style>' +
                '@page{margin:0}body{margin:0}img{width:100%;display:block;page-break-after:always}' +
                'img:last-child{page-break-after:auto}</style></head><body>' +
                imgs.map(u => '<img src="' + u + '">').join('') + '</body></html>');
            doc.close();
            frame.onload = () => setTimeout(() => {
                frame.contentWindow.focus();
                frame.contentWindow.print();
                setTimeout(() => frame.remove(), 60000);
            }, 300);
            setStatus('Print dialog opened');
        } catch (err) {
            console.error(err);
            setStatus('Print failed: ' + err.message);
            showToast('Print failed');
        }
    }
    window.printPdf = printPdf;

    // ── Keyboard shortcuts overlay (F1 / Cmd+?) ──
    let _shortcutsEl = null;
    function toggleShortcutsOverlay() {
        if (_shortcutsEl) { _shortcutsEl.remove(); _shortcutsEl = null; return; }
        const ROWS = [
            ['Tools', [['V', 'Select'], ['T', 'Add text'], ['D', 'Draw'], ['H', 'Highlight'], ['R', 'Shapes'], ['E', 'Eraser'], ['C', 'Crop']]],
            ['Editing', [['Cmd/Ctrl+Z', 'Undo (incl. crop)'], ['Cmd/Ctrl+Shift+Z', 'Redo'], ['Delete', 'Remove selected'], ['Esc', 'Close tool / cancel']]],
            ['Document', [['Cmd/Ctrl+O', 'Open PDF'], ['Cmd/Ctrl+S', 'Save PDF'], ['Cmd/Ctrl+P', 'Print'], ['Cmd/Ctrl+F', 'Search']]],
            ['Help', [['F1 or Cmd/Ctrl+/', 'This overlay']]],
        ];
        _shortcutsEl = document.createElement('div');
        _shortcutsEl.className = 'modal-overlay';
        _shortcutsEl.style.display = 'flex';
        _shortcutsEl.innerHTML = '<div class="modal" style="max-width:520px;">' +
            '<div class="modal-header"><span>Keyboard shortcuts</span>' +
            '<button class="icon-btn" data-x="1">✕</button></div><div class="modal-body">' +
            ROWS.map(([g, rows]) =>
                '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary);margin:10px 0 6px;">' + g + '</div>' +
                rows.map(([k, d]) => '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12.5px;">' +
                    '<span>' + d + '</span><kbd style="background:var(--bg-tertiary);border:1px solid var(--border);' +
                    'border-radius:5px;padding:1px 8px;font-size:11px;">' + k + '</kbd></div>').join('')
            ).join('') + '</div></div>';
        const close = () => { if (_shortcutsEl) { _shortcutsEl.remove(); _shortcutsEl = null; } };
        _shortcutsEl.querySelector('[data-x]').addEventListener('click', close);
        _shortcutsEl.addEventListener('click', (e) => { if (e.target === _shortcutsEl) close(); });
        document.body.appendChild(_shortcutsEl);
    }

    // ── Paint-style eraser cursor: a circle that tracks the pointer at the
    // eraser's size, so you can see exactly what you're about to rub out. ──
    let _eraserCursorObj = null;
    function clearEraserCursor() {
        if (_eraserCursorObj && fabricCanvas) {
            const prev = _isRestoring;
            _isRestoring = true;
            fabricCanvas.remove(_eraserCursorObj);
            _isRestoring = prev;
            _eraserCursorObj = null;
            fabricCanvas.renderAll();
        }
    }
    function updateEraserCursor(opt) {
        if (state.activeTool !== 'eraser') { clearEraserCursor(); return; }
        const p = fabricCanvas.getPointer(opt.e);
        const r = Math.max(parseInt(dom.sizePicker.value, 10) * 2, 10) / 2;
        if (!_eraserCursorObj) {
            _eraserCursorObj = new fabric.Circle({
                radius: r, fill: 'rgba(255,255,255,0.65)', stroke: '#555', strokeWidth: 1.2,
                originX: 'center', originY: 'center',
                selectable: false, evented: false, excludeFromExport: true,
            });
            const prev = _isRestoring;
            _isRestoring = true;
            fabricCanvas.add(_eraserCursorObj);
            _isRestoring = prev;
        }
        _eraserCursorObj.set({ left: p.x, top: p.y, radius: r });
        if (_eraserCursorObj.bringToFront) _eraserCursorObj.bringToFront();
        fabricCanvas.renderAll();
    }

    // ── Eraser Tool ──
    // Two modes on one tool (toggled via the "Whiteout" checkbox in eraser options):
    //   * default  → remove ONLY your annotations (drag over them to delete). Safe: never touches PDF text.
    //   * whiteout → paint the sampled background color over content (hide original text/images).
    let _eraserBgColor = '#ffffff'; // sampled at mousedown, used as whiteout brush color
    let _eraserWhiteout = false;    // set by the Whiteout toggle
    let _eraserDragging = false;
    let _eraserDidErase = false;

    // Radius (display px) of the eraser, derived from the size slider.
    function eraserRadius() {
        return Math.max(parseInt(dom.sizePicker.value, 10) * 2, 10) / 2;
    }

    // True if the eraser circle at point p (radius r) overlaps object o's bounds.
    function eraserTouches(o, p, r) {
        const b = o.getBoundingRect(true, true); // absolute, calculate
        return p.x >= b.left - r && p.x <= b.left + b.width + r &&
               p.y >= b.top  - r && p.y <= b.top  + b.height + r;
    }

    function eraseObjectsAt(opt) {
        const p = fabricCanvas.getPointer(opt.e);
        const r = eraserRadius();
        const hit = fabricCanvas.getObjects().filter((o) =>
            !o._isTextCover && !o._isCropDim && !o.excludeFromExport &&
            eraserTouches(o, p, r)
        );
        if (hit.length) {
            let hadMeasure = false;
            hit.forEach((o) => {
                if (o._measure) { hadMeasure = true; _removeMeasureExtras(o._measure._mid); }
                fabricCanvas.remove(o);
            });
            fabricCanvas.renderAll();
            _eraserDidErase = true;
            // Keep the Measurements list in sync when a measurement is erased (M8).
            if (hadMeasure && window.renderMeasureList) window.renderMeasureList();
        }
    }

    function handleEraserDown(opt) {
        if (state.activeTool !== 'eraser') return;
        if (_eraserWhiteout) {
            // Sample the background color so the whiteout stroke blends in
            const p = fabricCanvas.getPointer(opt.e);
            applyEraserBrushColor(p.x, p.y);
            return;
        }
        // Annotation-erase: begin a drag-to-delete gesture
        _eraserDragging = true;
        _eraserDidErase = false;
        eraseObjectsAt(opt);
    }

    function handleEraserMove(opt) {
        if (state.activeTool !== 'eraser' || _eraserWhiteout || !_eraserDragging) return;
        eraseObjectsAt(opt);
    }

    function handleEraserUp() {
        if (_eraserDragging) {
            _eraserDragging = false;
            if (_eraserDidErase) { _eraserDidErase = false; saveAnnotationState(); }
        }
    }

    function applyEraserBrushColor(x, y) {
        const brush = fabricCanvas && fabricCanvas.freeDrawingBrush;
        if (!brush) return;
        const size = brush.width || 10;
        const sampled = sampleBgColor(dom.pdfCanvas, x - size / 2, y - size / 2, size, size);
        _eraserBgColor = sampled || '#ffffff';
        brush.color = _eraserBgColor;
    }

    // ── Crop Tool ──
    // Document-level undo for STRUCTURAL changes (crop): snapshots of the
    // whole PDF bytes, restored by Cmd+Z when there is no markup to undo.
    const _docUndoStack = []; // [{ bytes: ArrayBuffer, label, page }]
    function pushDocSnapshot(label) {
        try {
            saveCurrentAnnotations(); // capture the live canvas first
            const src = state.pdfBytes instanceof ArrayBuffer ? new Uint8Array(state.pdfBytes) : state.pdfBytes;
            _docUndoStack.push({
                bytes: src.slice().buffer, label, page: state.currentPage,
                ann: JSON.stringify(state.annotations),
                comments: JSON.stringify(state.comments),
            });
            if (_docUndoStack.length > 5) _docUndoStack.shift(); // cap memory
            updateUndoRedoButtons();
        } catch (e) {
            console.warn('doc snapshot failed', e);
            showToast('Note: undo will not be available for this action');
        }
    }
    async function undoDocChange() {
        const snap = _docUndoStack.pop();
        if (!snap) return false;
        // Restore per-page state EXACTLY as it was (crop modes shift/delete it)
        try { state.annotations = JSON.parse(snap.ann); } catch (_) {}
        try { state.comments = JSON.parse(snap.comments); } catch (_) {}
        state.undoStacks = {}; state.redoStacks = {};
        state.currentPage = snap.page;
        await _reloadFromBytes(new Uint8Array(snap.bytes), snap.label + ' undone', true);
        updateUndoRedoButtons();
        return true;
    }

    let cropRect = null;
    let cropStartPoint = null;

    function handleCropStart(opt) {
        if (state.activeTool !== 'crop') return;
        if (opt.target && opt.target === cropRect) return;

        // Remove old crop rect if exists
        if (cropRect) {
            fabricCanvas.remove(cropRect);
        }

        cropStartPoint = fabricCanvas.getPointer(opt.e);
        cropRect = new fabric.Rect({
            left: cropStartPoint.x,
            top: cropStartPoint.y,
            width: 0,
            height: 0,
            fill: 'rgba(124, 92, 252, 0.15)',
            stroke: '#7c5cfc',
            strokeWidth: 2,
            strokeDashArray: [6, 3],
            selectable: false,
            evented: false,
            excludeFromExport: true,
        });
        // Suppress undo state for temporary crop overlay
        _isRestoring = true;
        fabricCanvas.add(cropRect);
        _isRestoring = false;
    }

    function handleCropMove(opt) {
        if (state.activeTool !== 'crop' || !cropRect || !cropStartPoint) return;

        const pointer = fabricCanvas.getPointer(opt.e);
        const width = pointer.x - cropStartPoint.x;
        const height = pointer.y - cropStartPoint.y;

        cropRect.set({
            left: width >= 0 ? cropStartPoint.x : pointer.x,
            top: height >= 0 ? cropStartPoint.y : pointer.y,
            width: Math.abs(width),
            height: Math.abs(height),
        });
        fabricCanvas.renderAll();

        // Draw dim overlay outside the crop area
        drawCropDimOverlay();
        updateCropDims();
    }

    function handleCropEnd() {
        if (state.activeTool !== 'crop' || !cropRect) return;

        if (cropRect.width < 10 || cropRect.height < 10) {
            fabricCanvas.remove(cropRect);
            cropRect = null;
            clearCropDimOverlay();
            updateCropDims();
        } else {
            // The drawn box becomes ADJUSTABLE: drag to move, corners to
            // resize — no more cancel-and-redraw to fix a slightly-off crop.
            cropRect.set({ selectable: true, evented: true, lockRotation: true, hasRotatingPoint: false });
            cropRect.setControlsVisibility({ mtr: false });
            cropRect.setCoords();
            fabricCanvas.setActiveObject(cropRect);
            fabricCanvas.renderAll();
            updateCropDims();
        }
        cropStartPoint = null;
        _syncCropApply();
    }
    // Apply Crop is disabled until a valid rectangle exists (B9).
    function _syncCropApply() {
        if (dom.cropApply) dom.cropApply.disabled = !cropRect;
    }

    // Live size chip: shows the crop area in mm + pt while drawing/adjusting.
    let _cropDimsEl = null;
    function updateCropDims() {
        if (!_cropDimsEl) {
            _cropDimsEl = document.createElement('div');
            _cropDimsEl.style.cssText = 'position:fixed;z-index:10002;display:none;pointer-events:none;' +
                'background:#7c5cfc;color:#fff;font-size:11px;font-weight:700;padding:3px 9px;' +
                'border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-family:Inter,Arial,sans-serif;';
            document.body.appendChild(_cropDimsEl);
        }
        if (!cropRect || !fabricCanvas) { _cropDimsEl.style.display = 'none'; return; }
        const w = cropRect.width * (cropRect.scaleX || 1);
        const h = cropRect.height * (cropRect.scaleY || 1);
        // canvas px → PDF points (canvas renders the page at zoom × 1.5)
        const k = 1 / state.zoom; // fabric px are DISPLAY px (retina 1.5 already divided out)
        const wPt = w * k, hPt = h * k;
        const mm = (pt) => Math.round(pt / 72 * 25.4);
        _cropDimsEl.textContent = mm(wPt) + ' × ' + mm(hPt) + ' mm  ·  ' + Math.round(wPt) + ' × ' + Math.round(hPt) + ' pt';
        const cnvRect = fabricCanvas.upperCanvasEl.getBoundingClientRect();
        const css = cnvRect.width / fabricCanvas.width;
        const cx = cnvRect.left + (cropRect.left + w / 2) * css;
        const cy = cnvRect.top + cropRect.top * css - 28;
        _cropDimsEl.style.left = Math.max(8, cx - 80) + 'px';
        _cropDimsEl.style.top = Math.max(8, cy) + 'px';
        _cropDimsEl.style.display = 'block';
    }

    function handleCropAdjust(e) {
        if (!cropRect || !e || e.target !== cropRect) return;
        drawCropDimOverlay();
        updateCropDims();
    }

    function drawCropDimOverlay() {
        clearCropDimOverlay();
        if (!cropRect) return;

        const cw = fabricCanvas.width;
        const ch = fabricCanvas.height;
        const cl = cropRect.left;
        const ct = cropRect.top;
        const cr = cl + cropRect.width * (cropRect.scaleX || 1);
        const cb = ct + cropRect.height * (cropRect.scaleY || 1);

        // 4 rectangles around the crop area
        const dims = [
            { left: 0, top: 0, width: cw, height: ct },               // top
            { left: 0, top: cb, width: cw, height: ch - cb },          // bottom
            { left: 0, top: ct, width: cl, height: cb - ct },  // left
            { left: cr, top: ct, width: cw - cr, height: cb - ct }, // right
        ];

        // Suppress undo state for temporary dim overlays
        _isRestoring = true;
        dims.forEach((d) => {
            const overlay = new fabric.Rect({
                left: d.left,
                top: d.top,
                width: d.width,
                height: d.height,
                fill: 'rgba(0, 0, 0, 0.5)',
                selectable: false,
                evented: false,
                excludeFromExport: true,
                _isCropDim: true,
            });
            fabricCanvas.add(overlay);
        });
        _isRestoring = false;
        fabricCanvas.renderAll();
    }

    function clearCropDimOverlay() {
        if (!fabricCanvas) return;
        const toRemove = fabricCanvas.getObjects().filter((o) => o._isCropDim);
        toRemove.forEach((o) => fabricCanvas.remove(o));
    }

    async function applyCrop() {
        _exitScrollForOp();
        if (!cropRect || !state.pdfBytes) {
            showToast('Draw a crop area first');
            return;
        }

        // Ask how to apply it — replace the page, or keep the original and
        // add a cropped COPY right after it. Both are undoable with Cmd+Z. The
        // scope dropdown on the crop bar pre-selects "all pages" here (B9).
        const barScope = (document.getElementById('cropScope') || {}).value;
        const sel = (v) => barScope === 'all' ? (v === 'all' ? ' selected' : '') : (v === 'dup' ? ' selected' : '');
        const choice = await _toolModal('Apply crop', `
            <label class="modal-label">How do you want to crop page ${state.currentPage}?</label>
            <select class="modal-input" data-k="mode">
                <option value="dup"${sel('dup')}>Keep original — add a cropped copy after it</option>
                <option value="replace"${sel('replace')}>Crop this page (replace it)</option>
                <option value="all"${sel('all')}>Crop ALL ${state.totalPages} pages with this area</option>
            </select>
            <p class="modal-hint" style="margin-top:10px;">You can undo the crop any time with Cmd/Ctrl+Z.
            Note: crop hides the outside area — to permanently remove sensitive content use Redact instead.</p>`, 'Apply Crop');
        if (!choice) return;

        setStatus('Applying crop...');

        try {
            saveCurrentAnnotations(); // 'dup' mode promises the original keeps its markups
            // Rotated pages: the axis mapping below is wrong for /Rotate 90/270
            const pjRot = (await state.pdfDoc.getPage(state.currentPage)).rotate || 0;
            if (pjRot % 360 !== 0) {
                showToast('Crop is not supported on rotated pages yet — rotate the page upright first');
                setStatus('Crop cancelled: page is rotated');
                return;
            }
            pushDocSnapshot('Crop');
            // Get crop rect position relative to the display canvas
            // (scale factors appear when the user resizes via the handles)
            const cropLeft = cropRect.left;
            const cropTop = cropRect.top;
            const cropWidth = cropRect.width * (cropRect.scaleX || 1);
            const cropHeight = cropRect.height * (cropRect.scaleY || 1);

            // Convert display coordinates to PDF coordinates
            const pdfLibDoc = await PDFLib.PDFDocument.load(state.pdfBytes);
            const page = pdfLibDoc.getPages()[state.currentPage - 1];
            const { width: pageWidth, height: pageHeight } = page.getSize();

            const displayWidth = fabricCanvas.width;
            const displayHeight = fabricCanvas.height;

            const scaleX = pageWidth / displayWidth;
            const scaleY = pageHeight / displayHeight;

            // PDF coordinates: origin is bottom-left, y goes up
            const pdfLeft = cropLeft * scaleX;
            const pdfBottom = pageHeight - (cropTop + cropHeight) * scaleY;
            const pdfRight = (cropLeft + cropWidth) * scaleX;
            const pdfTop = pageHeight - cropTop * scaleY;

            if (choice.mode === 'all') {
                // Same AREA on every page, applied as fractions so mixed page
                // sizes crop proportionally (typical scans are uniform anyway).
                const fx = pdfLeft / pageWidth, fy = pdfBottom / pageHeight;
                const fw = (pdfRight - pdfLeft) / pageWidth, fh = (pdfTop - pdfBottom) / pageHeight;
                // The crop rectangle was drawn against the CURRENT page's
                // orientation (already checked upright above). Pages with a
                // different rotation would map the rectangle to the wrong axis,
                // so skip them rather than crop them incorrectly.
                let skipped = 0;
                for (const pg of pdfLibDoc.getPages()) {
                    if (((pg.getRotation().angle % 360) + 360) % 360 !== 0) { skipped++; continue; }
                    const sz = pg.getSize();
                    pg.setCropBox(fx * sz.width, fy * sz.height, fw * sz.width, fh * sz.height);
                    pg.setMediaBox(fx * sz.width, fy * sz.height, fw * sz.width, fh * sz.height);
                }
                if (skipped) showToast('Cropped - skipped ' + skipped + ' rotated page(s)');
                const allBytes = await pdfLibDoc.save();
                state.pdfBytes = allBytes.slice().buffer;
                // Every page's coordinate origin changed — markups are invalid
                state.annotations = {}; state.undoStacks = {}; state.redoStacks = {};
                const pdfAll = await pdfjsLib.getDocument({ data: allBytes.slice(), fontExtraProperties: true }).promise;
                if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdfAll;
                cleanupCrop();
                setActiveTool('select');
                renderPage(state.currentPage);
                generateThumbnails();
                setStatus('All ' + state.totalPages + ' pages cropped — Cmd/Ctrl+Z to undo');
                showToast('All pages cropped');
                return;
            }

            let targetPage = page;
            if (choice.mode === 'dup') {
                // Copy the page, insert the copy after the original, crop the COPY
                const [copied] = await pdfLibDoc.copyPages(pdfLibDoc, [state.currentPage - 1]);
                pdfLibDoc.insertPage(state.currentPage, copied);
                targetPage = copied;
                // Shift per-page state for pages after the insertion point
                for (let i = state.totalPages; i > state.currentPage; i--) {
                    if (state.annotations[i]) { state.annotations[i + 1] = state.annotations[i]; delete state.annotations[i]; }
                    if (state.undoStacks[i]) { state.undoStacks[i + 1] = state.undoStacks[i]; delete state.undoStacks[i]; }
                    if (state.redoStacks[i]) { state.redoStacks[i + 1] = state.redoStacks[i]; delete state.redoStacks[i]; }
                }
            }
            targetPage.setCropBox(pdfLeft, pdfBottom, pdfRight - pdfLeft, pdfTop - pdfBottom);
            targetPage.setMediaBox(pdfLeft, pdfBottom, pdfRight - pdfLeft, pdfTop - pdfBottom);

            // Save modified PDF and reload
            const newBytes = await pdfLibDoc.save();
            // Store a clean copy as ArrayBuffer
            state.pdfBytes = newBytes.slice().buffer;

            if (choice.mode === 'dup') {
                // Land on the cropped copy; the original keeps its markups
                state.currentPage = state.currentPage + 1;
            } else {
                // Clear annotations for cropped page (old coords are invalid)
                delete state.annotations[state.currentPage];
                delete state.undoStacks[state.currentPage];
                delete state.redoStacks[state.currentPage];
            }

            // Reload into PDF.js
            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;

            // Clean up crop UI
            cleanupCrop();
            setActiveTool('select');

            // Re-render
            renderPage(state.currentPage);

            // Regenerate thumbnails
            generateThumbnails();

            state.totalPages = state.pdfDoc.numPages;
            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;
            if (choice.mode === 'dup') {
                setStatus('Cropped copy added — original kept. Cmd/Ctrl+Z to undo.');
                showToast('Cropped copy added after the original page');
            } else {
                setStatus('Page cropped — Cmd/Ctrl+Z to undo');
                showToast('Page ' + state.currentPage + ' cropped');
            }
        } catch (err) {
            console.error(err);
            setStatus('Crop failed: ' + err.message);
            showToast('Crop failed');
        }
    }

    function cancelCrop() {
        cleanupCrop();
        setActiveTool('select');
    }

    function cleanupCrop() {
        if (_cropDimsEl) _cropDimsEl.style.display = 'none';
        clearCropDimOverlay();
        if (cropRect) {
            fabricCanvas.remove(cropRect);
            cropRect = null;
        }
        cropStartPoint = null;
        dom.cropConfirmBar.style.display = 'none';
        fabricCanvas.renderAll();
    }

    // ── Image Tool ──
    function handleImageSelect(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (event) {
            fabric.Image.fromURL(event.target.result, (img) => {
                // Scale image to fit reasonably
                const maxWidth = fabricCanvas.width * 0.5;
                const maxHeight = fabricCanvas.height * 0.5;
                const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
                img.scale(scale);
                img.set({
                    left: 50,
                    top: 50,
                    cornerStyle: 'circle',
                    transparentCorners: false,
                });
                fabricCanvas.add(img);
                fabricCanvas.setActiveObject(img);
                fabricCanvas.renderAll();
                setActiveTool('select');
            });
        };
        reader.readAsDataURL(file);
        // Reset input so same file can be selected again
        e.target.value = '';
    }

    // ── Comments ──
    let commentIdCounter = 0;

    function toggleCommentPanel() {
        // Close AI panel if it's open so both panels don't overlap
        if (!dom.commentPanel.classList.contains('open') && state.aiPanelOpen) {
            state.aiPanelOpen = false;
            dom.aiPanel.classList.remove('open');
        }
        dom.commentPanel.classList.toggle('open');
        refreshCommentPanel();
        // Comment mode = select text: arm while the panel is open.
        if (dom.commentPanel.classList.contains('open')) {
            window.armTextComment && window.armTextComment();
        } else {
            _tcArmed = false;
            _pendingAnchor = null;
            if (fabricCanvas) applyToolMode();
        }
    }

    function refreshCommentPanel() {
        const page = state.currentPage;
        dom.commentPageNum.textContent = page;
        renderComments(page);
    }

    function addComment() {
        const text = dom.commentInput.value.trim();
        if (!text) return;

        const page = state.currentPage;
        if (!state.comments[page]) state.comments[page] = [];

        // An anchor from another page must not attach here (marks live there).
        if (_pendingAnchor && _pendingAnchor.page !== page) {
            _pendingAnchor = null;
            dom.commentInput.placeholder = 'Add a comment...';
        }
        commentIdCounter++;
        state.comments[page].push({
            id: commentIdCounter,
            text: text,
            time: new Date().toLocaleString(),
            ...(_pendingAnchor ? { ref: _pendingAnchor.snippet, nx: _pendingAnchor.nx, ny: _pendingAnchor.ny,
                                    rects: _pendingAnchor.rects, color: _pendingAnchor.color } : {}),
        });
        _pendingAnchor = null;
        dom.commentInput.placeholder = 'Add a comment...';

        dom.commentInput.value = '';
        renderComments(page);
        updateThumbnailBadges();
        showToast('Comment added to page ' + page);
    }

    function editComment(page, commentId) {
        const comments = state.comments[page];
        if (!comments) return;
        const comment = comments.find((c) => c.id === commentId);
        if (!comment) return;

        // Find the comment DOM element and switch to edit mode
        const commentEl = document.querySelector(`.comment-item[data-id="${commentId}"]`);
        if (!commentEl) return;

        const textEl = commentEl.querySelector('.comment-text');
        const actionsEl = commentEl.querySelector('.comment-actions');

        // Replace text with textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'comment-edit-area';
        textarea.value = comment.text;
        textEl.replaceWith(textarea);
        textarea.focus();

        // Replace actions with save/cancel
        const editActions = document.createElement('div');
        editActions.className = 'comment-edit-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'save-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
            const newText = textarea.value.trim();
            if (newText) {
                comment.text = newText;
                comment.time = new Date().toLocaleString() + ' (edited)';
            }
            renderComments(page);
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cancel-edit-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            renderComments(page);
        });

        editActions.appendChild(saveBtn);
        editActions.appendChild(cancelBtn);
        actionsEl.replaceWith(editActions);
    }

    function deleteComment(page, commentId) {
        if (!state.comments[page]) return;
        state.comments[page] = state.comments[page].filter((c) => c.id !== commentId);
        if (state.comments[page].length === 0) {
            delete state.comments[page];
        }
        renderComments(page);
        updateThumbnailBadges();
    }

    function renderComments(page) {
        const list = dom.commentList;
        list.innerHTML = '';

        const comments = state.comments[page];
        if (!comments || comments.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'comment-empty';
            empty.textContent = 'No comments on this page. Add one below.';
            list.appendChild(empty);
            return;
        }

        comments.forEach((comment) => {
            const item = document.createElement('div');
            item.className = 'comment-item';
            item.dataset.id = comment.id;

            const time = document.createElement('div');
            time.className = 'comment-time';
            time.textContent = comment.time;

            if (comment.ref) {
                const ref = document.createElement('div');
                ref.className = 'comment-ref';
                ref.textContent = '\u201C' + comment.ref + '\u201D';
                item.appendChild(ref);
            }

            const text = document.createElement('div');
            text.className = 'comment-text';
            text.textContent = comment.text;

            const actions = document.createElement('div');
            actions.className = 'comment-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'comment-action-btn';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => editComment(page, comment.id));

            const delBtn = document.createElement('button');
            delBtn.className = 'comment-action-btn delete';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => {
                deleteComment(page, comment.id);
            });

            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            item.appendChild(time);
            item.appendChild(text);
            item.appendChild(actions);
            list.appendChild(item);
        });

        // Scroll to bottom
        list.scrollTop = list.scrollHeight;
    }

    function updateThumbnailBadges() {
        document.querySelectorAll('.thumbnail-item').forEach((el) => {
            const pageNum = parseInt(el.dataset.page, 10);
            // Remove existing badge
            const existing = el.querySelector('.comment-badge');
            if (existing) existing.remove();

            const comments = state.comments[pageNum];
            if (comments && comments.length > 0) {
                const badge = document.createElement('div');
                badge.className = 'comment-badge';
                badge.textContent = comments.length;
                el.appendChild(badge);
            }
        });
    }

    // ── Merge PDF ──
    async function handleMergeSelect(e) {
        _exitScrollForOp();
        const files = Array.from(e.target.files);
        if (!files.length) return;
        e.target.value = '';

        // Ask WHERE to merge (Pranshu): at the start, after the last page
        // (default), or after a specific page of the current document.
        const total = state.totalPages || 1;
        const w = await _toolModal('Merge PDF - where?', `
            <label class="modal-label">Insert the merged pages:</label>
            <select class="modal-input" data-k="pos">
                <option value="end">After the last page (append)</option>
                <option value="start">At the very start</option>
                <option value="after">After a specific page...</option>
            </select>
            <input type="number" class="modal-input" data-k="afterPage" min="1" max="${total}" value="${total}"
                   placeholder="page number" style="margin-top:6px;display:none;">
            <p class="modal-hint" style="margin-top:8px;">The current document has ${total} page(s).</p>`,
            'Merge',
            (root) => {
                const sel = root.querySelector('[data-k="pos"]');
                const inp = root.querySelector('[data-k="afterPage"]');
                if (sel && inp) sel.addEventListener('change', () => {
                    inp.style.display = sel.value === 'after' ? 'block' : 'none';
                });
            });
        if (!w) return;

        // Resolve the 0-based insertion index for the FIRST merged page.
        let insertAt;
        if (w.pos === 'start') insertAt = 0;
        else if (w.pos === 'after') {
            const p = Math.min(Math.max(parseInt(w.afterPage, 10) || total, 1), total);
            insertAt = p; // after page p => before index p (0-based)
        } else insertAt = total; // end

        pushDocSnapshot('Merge');
        setStatus('Merging PDFs...');

        try {
            // Save current annotations before merge
            saveCurrentAnnotations();

            // Load the current document
            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const mainDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });

            // Merge each selected file, inserting at the chosen position. Pages
            // are inserted in order so the merged document keeps its sequence.
            let cursor = insertAt;
            for (const file of files) {
                const fileBytes = await file.arrayBuffer();
                const srcDoc = await PDFLib.PDFDocument.load(fileBytes, { ignoreEncryption: true });
                const pageIndices = srcDoc.getPageIndices();
                const copiedPages = await mainDoc.copyPages(srcDoc, pageIndices);
                copiedPages.forEach((page) => {
                    mainDoc.insertPage(cursor, page);
                    cursor++;
                });
            }
            const insertedCount = cursor - insertAt;

            // Shift existing page-keyed state (annotations, comments, undo/redo)
            // for pages at or after the insertion point, so markups stay on their
            // original pages instead of drifting. Mirrors the blank-page insert
            // remap. insertAt is 0-based; page keys are 1-based, so any page
            // number > insertAt moves up by insertedCount.
            if (insertAt < state.totalPages && insertedCount > 0) {
                const shiftMap = (obj) => {
                    if (!obj) return obj;
                    const out = {};
                    for (const k of Object.keys(obj)) {
                        const pn = parseInt(k, 10);
                        out[pn > insertAt ? pn + insertedCount : pn] = obj[k];
                    }
                    return out;
                };
                state.annotations = shiftMap(state.annotations);
                state.comments    = shiftMap(state.comments);
                state.undoStacks  = shiftMap(state.undoStacks);
                state.redoStacks  = shiftMap(state.redoStacks);
                // Keep the user on the SAME content they were viewing: if pages
                // were inserted before the current page, advance past them.
                if (state.currentPage > insertAt) state.currentPage += insertedCount;
            }

            // Save merged PDF
            const mergedBytes = await mainDoc.save();
            state.pdfBytes = mergedBytes.slice().buffer;

            // Reload into PDF.js
            const pdf = await pdfjsLib.getDocument({ data: mergedBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;
            state.totalPages = pdf.numPages;

            // Update UI
            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;

            // Regenerate thumbnails and re-render
            await generateThumbnails();
            renderPage(state.currentPage);

            const where = insertAt === 0 ? 'at the start'
                        : insertAt >= (state.totalPages - insertedCount) ? 'at the end'
                        : 'after page ' + insertAt;
            setStatus('Merged ' + where + ' - now ' + state.totalPages + ' pages');
            showToast(files.length + ' PDF(s) merged ' + where + ' - ' + state.totalPages + ' pages total');
        } catch (err) {
            console.error(err);
            setStatus('Merge failed: ' + err.message);
            showToast('Merge failed');
        }
    }

    // ── Add Blank Page ──
    async function addBlankPage() {
        _exitScrollForOp();
        if (!state.pdfBytes) return;

        // Let the user choose the new page's size instead of silently copying
        // the current page (which surprises people on cropped/odd-size docs).
        const v = await _toolModal('Add blank page', `
            <label class="modal-label">Page size:</label>
            <select class="modal-input" data-k="size">
                <option value="same">Same as current page</option>
                <option value="a4">A4 (210 × 297 mm)</option>
                <option value="letter">Letter (8.5 × 11 in)</option>
                <option value="a3">A3 (297 × 420 mm)</option>
            </select>
            <label class="stamp-date-row" style="padding:10px 0 0;">
                <input type="checkbox" data-k="land"><span>Landscape</span></label>
            <p class="modal-hint" style="margin-top:8px;">The page is inserted after page ${state.currentPage}.</p>`, 'Add Page');
        if (!v) return;

        pushDocSnapshot('Add page');
        setStatus('Adding blank page...');

        try {
            saveCurrentAnnotations();

            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });

            const currentPdfPage = pdfLibDoc.getPages()[state.currentPage - 1];
            const SIZES = { a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55] };
            let { width, height } = currentPdfPage.getSize();
            if (v.size !== 'same') [width, height] = SIZES[v.size];
            if (v.land && height > width) [width, height] = [height, width];
            else if (!v.land && v.size !== 'same' && width > height) [width, height] = [height, width];

            // Insert blank page after current page
            const insertIndex = state.currentPage; // 0-based = after current
            pdfLibDoc.insertPage(insertIndex, [width, height]);

            const newBytes = await pdfLibDoc.save();
            state.pdfBytes = newBytes.slice().buffer;

            // Shift annotations/comments for pages after the insertion point
            const newAnnotations = {};
            const newUndoStacks = {};
            const newRedoStacks = {};
            const newComments = {};
            for (let i = state.totalPages; i >= 1; i--) {
                if (i > state.currentPage) {
                    // Shift up by 1
                    if (state.annotations[i]) newAnnotations[i + 1] = state.annotations[i];
                    if (state.undoStacks[i]) newUndoStacks[i + 1] = state.undoStacks[i];
                    if (state.redoStacks[i]) newRedoStacks[i + 1] = state.redoStacks[i];
                    if (state.comments[i]) newComments[i + 1] = state.comments[i];
                } else {
                    if (state.annotations[i]) newAnnotations[i] = state.annotations[i];
                    if (state.undoStacks[i]) newUndoStacks[i] = state.undoStacks[i];
                    if (state.redoStacks[i]) newRedoStacks[i] = state.redoStacks[i];
                    if (state.comments[i]) newComments[i] = state.comments[i];
                }
            }
            state.annotations = newAnnotations;
            state.undoStacks = newUndoStacks;
            state.redoStacks = newRedoStacks;
            state.comments = newComments;

            // Reload
            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;
            state.totalPages = pdf.numPages;

            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;

            // Go to the new blank page
            state.currentPage = state.currentPage + 1;

            await generateThumbnails();
            renderPage(state.currentPage);

            setStatus('Blank page added');
            showToast('Blank page added after page ' + (state.currentPage - 1));
        } catch (err) {
            console.error(err);
            setStatus('Add page failed: ' + err.message);
            showToast('Add page failed');
        }
    }

    // ── Template Page System ──
    // Analyze the CURRENT document for its own recurring header/footer text so a
    // new page can reuse the document's existing branding. Falls back to defaults.
    const TEMPLATE_BRAND = 'Greens Global';
    const TEMPLATE_WATERMARK = 'GREENS GLOBAL — CONFIDENTIAL';

    async function analyzeTemplate() {
        const result = { headerText: '', footerText: '' };
        if (!state.pdfDoc) return result;

        const pagesToScan = Math.min(state.totalPages, 6);
        const topCounts = {};
        const botCounts = {};

        for (let p = 1; p <= pagesToScan; p++) {
            try {
                const page = await state.pdfDoc.getPage(p);
                const vp = page.getViewport({ scale: 1 });
                const tc = await page.getTextContent();
                const H = vp.height;
                for (const it of tc.items) {
                    const s = (it.str || '').trim();
                    if (s.length < 3 || /^\d+$/.test(s) || /^page\s*\d+/i.test(s)) continue;
                    // viewport y: 0 = top of page, increases downward
                    const [, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
                    if (y < H * 0.10) topCounts[s] = (topCounts[s] || 0) + 1;
                    else if (y > H * 0.90) botCounts[s] = (botCounts[s] || 0) + 1;
                }
            } catch (_) { /* skip unreadable page */ }
        }

        // Pick the most frequent string that recurs on >= 2 pages (i.e. real branding).
        const pickRecurring = (map) => {
            let best = '', bestN = 1;
            for (const [s, n] of Object.entries(map)) {
                if (n >= 2 && n > bestN) { best = s; bestN = n; }
            }
            return best;
        };

        result.headerText = pickRecurring(topCounts);
        result.footerText = pickRecurring(botCounts);
        return result;
    }

    async function addTemplatePage() {
        if (!state.pdfBytes) return;
        setStatus('Analyzing document & adding template page...');

        try {
            saveCurrentAnnotations();

            // 1. Detect the document's own branding (or fall back to Greens Global defaults)
            const analysis = await analyzeTemplate();
            const usedDoc = !!(analysis.headerText || analysis.footerText);
            const headerText = analysis.headerText || TEMPLATE_BRAND;
            const footerText = analysis.footerText || (TEMPLATE_BRAND + ' — Confidential');

            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });

            const currentPdfPage = pdfLibDoc.getPages()[state.currentPage - 1];
            const { width, height } = currentPdfPage.getSize();

            const insertIndex = state.currentPage; // 0-based → after current
            const newPage = pdfLibDoc.insertPage(insertIndex, [width, height]);

            // 2. Draw the template onto the new page
            const helv = await pdfLibDoc.embedFont(PDFLib.StandardFonts.Helvetica);
            const helvBold = await pdfLibDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const green = PDFLib.rgb(0.05, 0.32, 0.15);
            const grey = PDFLib.rgb(0.42, 0.42, 0.42);
            const margin = 40;

            // Header
            newPage.drawText(headerText, {
                x: margin, y: height - margin, size: 12, font: helvBold, color: green,
            });
            newPage.drawLine({
                start: { x: margin, y: height - margin - 8 },
                end: { x: width - margin, y: height - margin - 8 },
                thickness: 1, color: green, opacity: 0.6,
            });

            // Footer
            newPage.drawLine({
                start: { x: margin, y: 46 }, end: { x: width - margin, y: 46 },
                thickness: 0.8, color: grey, opacity: 0.5,
            });
            newPage.drawText(footerText, { x: margin, y: 32, size: 9, font: helv, color: grey });
            const rightFooter = `Page ${insertIndex + 1}  |  ${new Date().toLocaleDateString()}`;
            const rfW = helv.widthOfTextAtSize(rightFooter, 9);
            newPage.drawText(rightFooter, { x: width - margin - rfW, y: 32, size: 9, font: helv, color: grey });

            // Diagonal CONFIDENTIAL watermark, scaled to span the page and centered
            const wm = TEMPLATE_WATERMARK;
            let wmSize = 40;
            let wmW = helvBold.widthOfTextAtSize(wm, wmSize);
            const diag = Math.sqrt(width * width + height * height);
            wmSize = wmSize * (diag * 0.62 / wmW);
            wmW = helvBold.widthOfTextAtSize(wm, wmSize);
            const theta = 35 * Math.PI / 180;
            newPage.drawText(wm, {
                x: width / 2 - (wmW / 2) * Math.cos(theta),
                y: height / 2 - (wmW / 2) * Math.sin(theta),
                size: wmSize, font: helvBold,
                color: PDFLib.rgb(0.85, 0.1, 0.1), opacity: 0.10,
                rotate: PDFLib.degrees(35),
            });

            const newBytes = await pdfLibDoc.save();
            state.pdfBytes = newBytes.slice().buffer;

            // 3. Shift annotations/comments for pages after the insertion point
            const newAnnotations = {}, newUndoStacks = {}, newRedoStacks = {}, newComments = {};
            for (let i = state.totalPages; i >= 1; i--) {
                const to = i > state.currentPage ? i + 1 : i;
                if (state.annotations[i]) newAnnotations[to] = state.annotations[i];
                if (state.undoStacks[i]) newUndoStacks[to] = state.undoStacks[i];
                if (state.redoStacks[i]) newRedoStacks[to] = state.redoStacks[i];
                if (state.comments[i]) newComments[to] = state.comments[i];
            }
            state.annotations = newAnnotations;
            state.undoStacks = newUndoStacks;
            state.redoStacks = newRedoStacks;
            state.comments = newComments;

            // 4. Reload
            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;
            state.totalPages = pdf.numPages;

            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;

            state.currentPage = state.currentPage + 1;
            await generateThumbnails();
            renderPage(state.currentPage);

            setStatus('Template page added');
            showToast(usedDoc
                ? 'Template page added (reused this document\'s header/footer)'
                : 'Greens Global template page added');
        } catch (err) {
            console.error(err);
            setStatus('Template page failed: ' + err.message);
            showToast('Template page failed');
        }
    }

    // ── Page Reorder ──
    async function movePageUp(pageNum) {
        if (pageNum <= 1) return;
        await movePageTo(pageNum, pageNum - 1);
    }

    async function movePageDown(pageNum) {
        if (pageNum >= state.totalPages) return;
        await movePageTo(pageNum, pageNum + 1);
    }

    // Move a page from one position to another (supports drag & drop and arrows)
    async function movePageTo(fromPage, toPage) {
        if (fromPage === toPage) return;
        if (fromPage < 1 || fromPage > state.totalPages) return;
        if (toPage < 1 || toPage > state.totalPages) return;

        pushDocSnapshot('Reorder pages');
        setStatus('Reordering pages...');

        try {
            saveCurrentAnnotations();

            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const srcDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            const newDoc = await PDFLib.PDFDocument.create();

            const totalPages = srcDoc.getPageCount();

            // Build new page order: remove fromIdx, insert at toIdx
            const order = [];
            for (let i = 0; i < totalPages; i++) {
                order.push(i);
            }
            const fromIdx = fromPage - 1;
            const toIdx = toPage - 1;
            const removed = order.splice(fromIdx, 1)[0];
            order.splice(toIdx, 0, removed);

            // Copy pages in new order
            const copiedPages = await newDoc.copyPages(srcDoc, order);
            copiedPages.forEach((page) => newDoc.addPage(page));

            // Save reordered PDF
            const newBytes = await newDoc.save();
            state.pdfBytes = newBytes.slice().buffer;

            // Remap annotations and comments
            const newAnnotations = {};
            const newUndoStacks = {};
            const newRedoStacks = {};
            const newComments = {};
            for (let i = 0; i < totalPages; i++) {
                const oldPageNum = order[i] + 1;
                const newPageNum = i + 1;
                if (state.annotations[oldPageNum]) {
                    newAnnotations[newPageNum] = state.annotations[oldPageNum];
                }
                if (state.undoStacks[oldPageNum]) {
                    newUndoStacks[newPageNum] = state.undoStacks[oldPageNum];
                }
                if (state.redoStacks[oldPageNum]) {
                    newRedoStacks[newPageNum] = state.redoStacks[oldPageNum];
                }
                if (state.comments[oldPageNum]) {
                    newComments[newPageNum] = state.comments[oldPageNum];
                }
            }
            state.annotations = newAnnotations;
            state.undoStacks = newUndoStacks;
            state.redoStacks = newRedoStacks;
            state.comments = newComments;

            // Reload into PDF.js
            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;

            // Follow the moved page
            state.currentPage = toPage;

            await generateThumbnails();
            renderPage(state.currentPage);

            setStatus('Pages reordered');
            showToast('Page ' + fromPage + ' moved to position ' + toPage);
        } catch (err) {
            console.error(err);
            setStatus('Reorder failed: ' + err.message);
            showToast('Reorder failed');
        }
    }

    // ── Drag & Drop State ──
    let dragSrcPage = null;

    async function deletePage(pageNum) {
        _exitScrollForOp();
        if (state.totalPages <= 1) {
            showToast('Cannot delete the only page');
            return;
        }

        pushDocSnapshot('Delete page');
        setStatus('Deleting page...');

        try {
            saveCurrentAnnotations();

            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            pdfLibDoc.removePage(pageNum - 1);

            const newBytes = await pdfLibDoc.save();
            state.pdfBytes = newBytes.slice().buffer;

            // Remap annotations and comments (shift pages after deleted page)
            const newAnnotations = {};
            const newUndoStacks = {};
            const newRedoStacks = {};
            const newComments = {};
            for (let i = 1; i <= state.totalPages; i++) {
                if (i < pageNum) {
                    if (state.annotations[i]) newAnnotations[i] = state.annotations[i];
                    if (state.undoStacks[i]) newUndoStacks[i] = state.undoStacks[i];
                    if (state.redoStacks[i]) newRedoStacks[i] = state.redoStacks[i];
                    if (state.comments[i]) newComments[i] = state.comments[i];
                } else if (i > pageNum) {
                    if (state.annotations[i]) newAnnotations[i - 1] = state.annotations[i];
                    if (state.undoStacks[i]) newUndoStacks[i - 1] = state.undoStacks[i];
                    if (state.redoStacks[i]) newRedoStacks[i - 1] = state.redoStacks[i];
                    if (state.comments[i]) newComments[i - 1] = state.comments[i];
                }
            }
            state.annotations = newAnnotations;
            state.undoStacks = newUndoStacks;
            state.redoStacks = newRedoStacks;
            state.comments = newComments;

            // Reload
            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;
            state.totalPages = pdf.numPages;

            if (state.currentPage > state.totalPages) {
                state.currentPage = state.totalPages;
            }

            dom.totalPages.textContent = state.totalPages;
            dom.pageInput.max = state.totalPages;
            dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;

            await generateThumbnails();
            renderPage(state.currentPage);

            setStatus('Page deleted');
            showToast('Page ' + pageNum + ' deleted');
        } catch (err) {
            console.error(err);
            setStatus('Delete failed: ' + err.message);
            showToast('Delete failed');
        }
    }

    // ── View Mode ──
    function setViewMode(mode) {
        state.viewMode = mode;

        // Update button active states
        document.querySelectorAll('.view-mode-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });

        // Regenerate thumbnails with appropriate scale
        if (state.pdfDoc) {
            generateThumbnails();
        }
    }

    function getThumbnailScale(pageWidth) {
        const sidebarWidth = dom.sidebar.clientWidth || 180;
        const padding = 24; // thumbnail-list padding + borders
        let targetWidth;

        switch (state.viewMode) {
            case 'preview':
                targetWidth = sidebarWidth - padding;
                break;
            case 'tiles':
                targetWidth = (sidebarWidth - padding - 6) / 2;
                break;
            case 'list':
                targetWidth = 40;
                break;
            case 'icons':
                targetWidth = (sidebarWidth - padding - 8) / 3;
                break;
            default:
                targetWidth = sidebarWidth - padding;
        }

        targetWidth *= state.thumbZoom; // Pages-panel size slider
        // Render at 2x for sharp/retina display
        return (targetWidth * 2) / pageWidth;
    }

    // ── Sidebar Resize ──
    function setupSidebarResize() {
        const handle = dom.sidebarResizeHandle;
        let isResizing = false;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isResizing = true;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = e.clientX;
            if (newWidth >= 80 && newWidth <= 600) {
                dom.sidebar.style.width = newWidth + 'px';
                dom.sidebar.style.minWidth = newWidth + 'px';
                dom.sidebar.style.transition = 'none';
            }
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            dom.sidebar.style.transition = '';

            // Regenerate thumbnails to fit new width
            if (state.pdfDoc) {
                generateThumbnails();
            }
        });
    }

    // ── Generate Thumbnails ──
    let _thumbGen = 0; // generation token: a newer run aborts older ones
    // Composite a page's stored markups onto a thumbnail canvas (B8). Annotations
    // are in canvas px at the capture zoom; we scale them to the thumb size. Skips
    // hidden-layer + helper objects so the thumbnail matches the page.
    async function _drawAnnotationsOnThumb(ctx, pageNum, thumbW, thumbH) {
        try {
            // Flush the live canvas for the current page so freshly-added markups
            // are included (they may not be in state.annotations yet).
            if (pageNum === state.currentPage) { try { saveCurrentAnnotations(); } catch (_) {} }
            const entry = state.annotations[pageNum];
            const data = entry && (entry.fabricData || entry);
            const objs = data && data.objects;
            if (!objs || !objs.length) return;
            // Capture-canvas size = pdf.js page at the capture zoom.
            const zoom = (entry.zoom) || state.zoom || 1;
            const pj = await state.pdfDoc.getPage(pageNum);
            const capVp = pj.getViewport({ scale: zoom });
            const f = thumbW / capVp.width;   // capture px -> thumb px
            const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
            const drawable = objs.filter(o => !o.excludeFromExport && !o._isCommentMark &&
                !(o._layerId !== undefined && hidden.has(o._layerId)));
            if (!drawable.length) return;
            const insts = await new Promise((res) => fabric.util.enlivenObjects(drawable, res));
            const tmp = new fabric.StaticCanvas(null, { width: Math.max(2, Math.round(thumbW)), height: Math.max(2, Math.round(thumbH)) });
            tmp.setZoom(f);
            insts.forEach(o => { if (o) { o.visible = true; tmp.add(o); } });
            tmp.renderAll();
            ctx.drawImage(tmp.lowerCanvasEl, 0, 0, Math.round(thumbW), Math.round(thumbH));
            tmp.dispose && tmp.dispose();
        } catch (_) { /* thumbnail markups are best-effort */ }
    }

    async function generateThumbnails() {
        const gen = ++_thumbGen;
        dom.thumbnailList.innerHTML = '';
        // Apply current view mode class
        dom.thumbnailList.classList.remove('view-preview', 'view-tiles', 'view-list', 'view-icons');
        dom.thumbnailList.classList.add('view-' + state.viewMode);

        // Loading hint while pages render (removed once the first thumbnail lands),
        // so the sidebar isn't a blank void on large documents.
        const _loading = document.createElement('div');
        _loading.className = 'thumb-loading';
        _loading.textContent = 'Rendering pages...';
        dom.thumbnailList.appendChild(_loading);

        for (let i = 1; i <= state.totalPages; i++) {
            if (gen !== _thumbGen) return; // superseded (slider drag / resize)
            if (i === 1 && _loading.parentNode) _loading.remove();
            // Yield to the UI every 5 pages to keep the app responsive on large PDFs
            if (i > 1 && (i - 1) % 5 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            let thumbCanvas;
            try {
                const page = await state.pdfDoc.getPage(i);
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.max(getThumbnailScale(baseViewport.width), 0.02);
                const viewport = page.getViewport({ scale });

                thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = Math.max(2, Math.round(viewport.width));
                thumbCanvas.height = Math.max(2, Math.round(viewport.height));

                const ctx = thumbCanvas.getContext('2d');
                // White backing so a partially-failed render is never invisible
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
                await page.render({ canvasContext: ctx, viewport }).promise;
                // Overlay this page's markups so thumbnails reflect annotations (B8).
                await _drawAnnotationsOnThumb(ctx, i, viewport.width, viewport.height);
            } catch (err) {
                // A page that refuses to render still gets a visible placeholder
                console.warn('Thumbnail render failed for page ' + i + ':', err);
                thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = 160; thumbCanvas.height = 210;
                const c2 = thumbCanvas.getContext('2d');
                c2.fillStyle = '#f2f2f5';
                c2.fillRect(0, 0, 160, 210);
                c2.fillStyle = '#8a8a95';
                c2.font = 'bold 28px Arial';
                c2.textAlign = 'center';
                c2.fillText(String(i), 80, 100);
                c2.font = '12px Arial';
                c2.fillText('preview unavailable', 80, 125);
            }
            if (gen !== _thumbGen) return; // superseded while rendering

            const item = document.createElement('div');
            item.className = 'thumbnail-item' + (i === state.currentPage ? ' active' : '');
            item.dataset.page = i;

            // ── Drag & Drop ──
            item.draggable = true;

            item.addEventListener('dragstart', (e) => {
                dragSrcPage = i;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', i.toString());
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                dragSrcPage = null;
                clearAllDragIndicators();
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (dragSrcPage === null || dragSrcPage === i) return;

                // Determine if dropping above or below the midpoint
                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                clearAllDragIndicators();
                if (e.clientY < midY) {
                    item.classList.add('drag-over-top');
                } else {
                    item.classList.add('drag-over-bottom');
                }
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                clearAllDragIndicators();
                if (dragSrcPage === null || dragSrcPage === i) return;

                // Determine drop position
                const rect = item.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                let targetPage = i;
                if (e.clientY >= midY && targetPage < state.totalPages) {
                    // Dropping below this item
                    if (dragSrcPage < targetPage) {
                        // Already moving down, keep target
                    } else {
                        targetPage = targetPage + 1;
                    }
                } else if (e.clientY < midY) {
                    // Dropping above this item
                    if (dragSrcPage > targetPage) {
                        // Already moving up, keep target
                    } else {
                        targetPage = targetPage - 1;
                    }
                }

                if (targetPage < 1) targetPage = 1;
                if (targetPage > state.totalPages) targetPage = state.totalPages;

                movePageTo(dragSrcPage, targetPage);
                dragSrcPage = null;
            });

            item.appendChild(thumbCanvas);

            const label = document.createElement('div');
            label.className = 'thumbnail-label';
            label.textContent = state.viewMode === 'list' ? 'Page ' + i : i;
            item.appendChild(label);

            // Page action buttons
            const actions = document.createElement('div');
            actions.className = 'thumb-actions';

            // Move up button
            if (i > 1) {
                const upBtn = document.createElement('button');
                upBtn.className = 'thumb-btn';
                upBtn.title = 'Move up';
                upBtn.innerHTML = '&#9650;';
                upBtn.draggable = false;
                upBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    movePageUp(i);
                });
                actions.appendChild(upBtn);
            }

            // Move down button
            if (i < state.totalPages) {
                const downBtn = document.createElement('button');
                downBtn.className = 'thumb-btn';
                downBtn.title = 'Move down';
                downBtn.innerHTML = '&#9660;';
                downBtn.draggable = false;
                downBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    movePageDown(i);
                });
                actions.appendChild(downBtn);
            }

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'thumb-btn delete-btn';
            delBtn.title = 'Delete page';
            delBtn.innerHTML = '&times;';
            delBtn.draggable = false;
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete page ' + i + '?')) {
                    deletePage(i);
                }
            });
            actions.appendChild(delBtn);

            item.appendChild(actions);

            item.addEventListener('click', () => goToPage(i));
            dom.thumbnailList.appendChild(item);
        }

        // Show comment badges
        updateThumbnailBadges();
    }

    function clearAllDragIndicators() {
        document.querySelectorAll('.thumbnail-item').forEach((el) => {
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });
    }

    function updateThumbnailActive() {
        document.querySelectorAll('.thumbnail-item').forEach((el) => {
            el.classList.toggle('active', parseInt(el.dataset.page, 10) === state.currentPage);
        });
    }

    // ── Download / Export PDF ──
    async function downloadPDF() {
        if (!state.pdfBytes) return;

        // Warn if hidden layers carry content that the save will drop (S12).
        try {
            saveCurrentAnnotations();
            const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
            if (hidden.size) {
                let hiddenCount = 0;
                for (const entry of Object.values(state.annotations || {})) {
                    const objs = (entry && (entry.fabricData || entry).objects) || [];
                    hiddenCount += objs.filter(o => o._layerId !== undefined && hidden.has(o._layerId) && !o.excludeFromExport).length;
                }
                if (hiddenCount > 0) {
                    const choice = await _choiceModal('Hidden layers won\'t be saved',
                        hiddenCount + ' markup' + (hiddenCount > 1 ? 's' : '') + ' on hidden layer' +
                        (hidden.size > 1 ? 's' : '') + ' will NOT be written into the PDF. Show those layers first if you want to keep them. Save anyway?',
                        [{ key: 'save', label: 'Save without them' }, { key: 'show', label: 'Show hidden layers first' }]);
                    if (choice !== 'save') {
                        if (choice === 'show') {
                            state.layers.forEach(l => { l.visible = true; });
                            applyLayerVisibility();
                            if (window.pdfLayers && window.renderLayersPanel) try { window.renderLayersPanel(); } catch (_) {}
                            showToast('Hidden layers shown - review, then Download again');
                        }
                        setStatus('Download cancelled');
                        return;
                    }
                }
            }
        } catch (_) { /* warning is best-effort - never block the save */ }

        // S5: warn once if the save will RASTERIZE any page. Redacted pages are
        // flattened to an image (searchable text under the boxes is destroyed -
        // that's the point of redaction, but the user should confirm). A remembered
        // "don't warn again" keeps it from nagging every save.
        try {
            let redactPages = 0;
            for (const entry of Object.values(state.annotations || {})) {
                const objs = (entry && (entry.fabricData || entry).objects) || [];
                if (objs.some(o => o._isRedact)) redactPages++;
            }
            if (redactPages > 0 && !_suppressRasterWarn) {
                const choice = await _choiceModal('Some pages will be flattened',
                    redactPages + ' page' + (redactPages > 1 ? 's' : '') + ' with redaction will be saved as an image - the text under the redaction boxes is permanently removed and those pages will no longer be searchable. This is how redaction protects the content. Continue?',
                    [{ key: 'go', label: 'Save' }, { key: 'goquiet', label: 'Save, don\'t warn again' }]);
                if (choice !== 'go' && choice !== 'goquiet') { setStatus('Download cancelled'); return; }
                if (choice === 'goquiet') _suppressRasterWarn = true;
            }
        } catch (_) { /* best-effort */ }

        setStatus('Preparing download...');

        try {
            // Save current annotations
            saveCurrentAnnotations();
            _exportFailures = 0;
            const _pendingMeasureAnnots = [];   // written in the annotation pass below (H3)

            // Load the current PDF with pdf-lib
            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            const pages = pdfLibDoc.getPages();

            // Fresh font cache for this export (embedded fonts belong to this doc)
            _exportFontCache = { doc: pdfLibDoc, fonts: {} };

            // For each page that has annotations, draw them onto the PDF
            for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
                const annotEntry = state.annotations[pageNum];
                if (!annotEntry) continue;

                // Support both new { fabricData, zoom } format and legacy plain-JSON format
                const annotData = annotEntry.fabricData || annotEntry;
                if (!annotData.objects || annotData.objects.length === 0) continue;

                const pdfPage = pages[pageNum - 1];
                const { width: pageWidth, height: pageHeight } = pdfPage.getSize();

                // Use the zoom level at which annotations were captured, not the current zoom.
                // Annotations' canvas coordinates were made at annotZoom, so the canvas was
                // annotZoom * pageWidth wide → scaleX = pageWidth / (annotZoom * pageWidth) = 1/annotZoom.
                const annotZoom = annotEntry.zoom || 1.0;
                const pdfJsPage = await state.pdfDoc.getPage(pageNum);
                const viewport = pdfJsPage.getViewport({ scale: annotZoom });
                const displayWidth = viewport.width;
                const displayHeight = viewport.height;

                const scaleX = pageWidth / displayWidth;
                const scaleY = pageHeight / displayHeight;

                const hiddenLayers = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
                const liveLayers = new Set(state.layers.map(l => l.id));
                const layerSkip = (o) => o._layerId !== undefined &&
                    (hiddenLayers.has(o._layerId) || !liveLayers.has(o._layerId));

                // TRUE redaction: if this page carries any redaction boxes,
                // rasterize the entire page (content + markups + black boxes)
                // and REPLACE the original page — the text/images underneath
                // are permanently removed, not just covered.
                const hasRedact = annotData.objects.some(o => o._isRedact && !layerSkip(o));
                if (hasRedact) {
                    const pj = await state.pdfDoc.getPage(pageNum);
                    const rotated = (pj.rotate % 180) !== 0; // H4: /Rotate 90 or 270
                    const vp = pj.getViewport({ scale: 2 });
                    const cnv = document.createElement('canvas');
                    cnv.width = vp.width; cnv.height = vp.height;
                    const c2 = cnv.getContext('2d');
                    c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, cnv.width, cnv.height);
                    await pj.render({ canvasContext: c2, viewport: vp }).promise;
                    // draw the page's annotations (scaled from capture zoom to 2x)
                    const f = vp.width / displayWidth;
                    const insts = await new Promise((res) => fabric.util.enlivenObjects(
                        annotData.objects.filter(o => !layerSkip(o) && !o._isCommentMark), res)); // M2: marks are annots, not ink
                    const tmp = new fabric.StaticCanvas(null, { width: cnv.width, height: cnv.height });
                    tmp.setZoom(f);
                    insts.forEach(o => { if (o) { o.visible = true; tmp.add(o); } });
                    tmp.renderAll();
                    if (location.search.includes('testhooks')) {
                        (window.__genDumps = window.__genDumps || []).push({
                            t: 'redact-page', insts: insts.length, live: insts.filter(Boolean).length,
                            f: +f.toFixed(3), cw: tmp.width, duLen: tmp.toDataURL().length,
                        });
                    }
                    // fabric renders retina-scaled internally — scale to fit
                    c2.drawImage(tmp.lowerCanvasEl, 0, 0, cnv.width, cnv.height);
                    if (location.search.includes('testhooks')) {
                        const pp = c2.getImageData(160, 160, 1, 1).data;
                        window.__genDumps.push({ t: 'redact-composite', px: [pp[0], pp[1], pp[2]], cnvW: cnv.width });
                    }
                    const jpg = await pdfLibDoc.embedJpg(cnv.toDataURL('image/jpeg', 0.88));
                    pdfLibDoc.removePage(pageNum - 1);
                    const npW = rotated ? pageHeight : pageWidth;
                    const npH = rotated ? pageWidth : pageHeight;
                    const np = pdfLibDoc.insertPage(pageNum - 1, [npW, npH]);
                    np.drawImage(jpg, { x: 0, y: 0, width: npW, height: npH });
                    pages[pageNum - 1] = np; // M1: later loops must see the NEW page
                    continue; // page fully replaced — skip per-object drawing
                }

                for (const obj of annotData.objects) {
                    if (layerSkip(obj)) continue; // hidden or deleted layer
                    if (obj._isCommentMark) continue; // becomes a real Highlight annotation below
                    await drawObjectOnPDF(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
                }

                // Collect this page's measurements so a real PDF markup annotation
                // can be attached AFTER all pages are drawn (see the annotation
                // pass below). Doing it here races the later comment-annotation
                // pass that can overwrite /Annots, so we defer.
                for (const obj of annotData.objects) {
                    if (obj._measure && !layerSkip(obj)) {
                        _pendingMeasureAnnots.push({ pageIndex: pageNum - 1, m: obj._measure, obj,
                            scaleX, scaleY, pageHeight });
                    }
                }
            }

            // Bake comments as REAL PDF annotations the way Acrobat does:
            // text-anchored comments become /Highlight annotations with
            // QuadPoints over the marked words (clean tint, hover/click shows
            // the note, listed in every viewer's comment panel). Page-level
            // comments (no anchor) become small sticky notes in the MARGIN.
            try {
                const { PDFName } = PDFLib;
                let annotSeq = 0;
                const addAnnot = (pg, dict) => {
                    // Every markup gets a linked /Popup annotation — without it
                    // Preview/Chrome/Acrobat may render the mark but never show
                    // the note text. This mirrors exactly what Acrobat writes.
                    dict.NM = PDFLib.PDFHexString.fromText('nexus-' + Date.now() + '-' + (++annotSeq));
                    const parentDict = pdfLibDoc.context.obj(dict);
                    const parentRef = pdfLibDoc.context.register(parentDict);
                    const [rx1, ry1, rx2, ry2] = dict.Rect;
                    const { width: pw } = pg.getSize();
                    const px = Math.min(rx2 + 8, pw - 190);
                    const popupDict = pdfLibDoc.context.obj({
                        Type: 'Annot', Subtype: 'Popup',
                        Rect: [px, Math.max(2, ry1 - 40), px + 180, ry2 + 40],
                        Parent: parentRef, Open: false, F: 28, // NoZoom|NoRotate|Print... popup default flags
                    });
                    const popupRef = pdfLibDoc.context.register(popupDict);
                    parentDict.set(PDFName.of('Popup'), popupRef);
                    const existing = pg.node.lookup(PDFName.of('Annots'));
                    if (existing) { existing.push(parentRef); existing.push(popupRef); }
                    else pg.node.set(PDFName.of('Annots'), pdfLibDoc.context.obj([parentRef, popupRef]));
                };
                if (COMMENTS_ENABLED) {
                // Remove the file's existing Highlight/Text annotations first —
                // they were imported into state.comments and are re-written
                // below; leaving them would duplicate on every round-trip.
                for (const pg of pages) {
                    const arr = pg.node.lookup(PDFName.of('Annots'));
                    if (!arr || !arr.size) continue;
                    const keep = [];
                    for (let k = 0; k < arr.size(); k++) {
                        const ref = arr.get(k);
                        try {
                            const d = pdfLibDoc.context.lookup(ref);
                            const st = d && d.get && d.get(PDFName.of('Subtype'));
                            if (st === PDFName.of('Highlight') || st === PDFName.of('Text') || st === PDFName.of('Popup')) continue;
                        } catch (_) { /* keep unknowns */ }
                        keep.push(ref);
                    }
                    pg.node.set(PDFName.of('Annots'), pdfLibDoc.context.obj(keep));
                }
                }
                const dateNow = (() => {
                    const d = new Date(), p = (n) => String(n).padStart(2, '0');
                    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
                })();
                for (const [pgStr, comments] of Object.entries(COMMENTS_ENABLED ? (state.comments || {}) : {})) {
                    const pg = pages[parseInt(pgStr, 10) - 1];
                    if (!pg || !comments || !comments.length) continue;
                    const { width, height } = pg.getSize();
                    comments.forEach((c, ci) => {
                        const contents = PDFLib.PDFHexString.fromText((c.ref ? '"' + c.ref + '" - ' : '') + c.text);
                        const title = PDFLib.PDFHexString.fromText('Comment');
                        let col = { r: 0.9, g: 0.22, b: 0.21 };
                        try { const rc = hexToRgb(c.color || '#e53935'); col = { r: rc.r / 255, g: rc.g / 255, b: rc.b / 255 }; } catch (_) {}
                        if (Array.isArray(c.rects) && c.rects.length) {
                            // Highlight annotation over the marked words
                            const quads = [], xs = [], ys = [];
                            for (const r of c.rects) {
                                const x1 = r.nx * width, x2 = (r.nx + r.nw) * width;
                                const yTop = height - r.ny * height, yBot = height - (r.ny + r.nh) * height;
                                quads.push(x1, yTop, x2, yTop, x1, yBot, x2, yBot);
                                xs.push(x1, x2); ys.push(yTop, yBot);
                            }
                            addAnnot(pg, {
                                Type: 'Annot', Subtype: 'Highlight',
                                Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
                                QuadPoints: quads,
                                Contents: contents, T: title,
                                Subj: PDFLib.PDFHexString.fromText('Highlight'),
                                C: [col.r, col.g, col.b], CA: 0.45,
                                F: 4, // print
                                M: PDFLib.PDFString.of(dateNow), CreationDate: PDFLib.PDFString.of(dateNow),
                            });
                        } else {
                            // Page-level note -> sticky in the right margin, never over text
                            const ay = height - 40 - ci * 28;
                            addAnnot(pg, {
                                Type: 'Annot', Subtype: 'Text',
                                Rect: [width - 30, ay - 20, width - 10, ay],
                                Contents: contents, T: title,
                                Name: PDFName.of('Comment'), Open: false,
                                C: [col.r, col.g, col.b], F: 4,
                                M: PDFLib.PDFString.of(dateNow), CreationDate: PDFLib.PDFString.of(dateNow),
                            });
                        }
                    });
                }

            } catch (e) { console.warn('Could not embed PDF comments:', e); }

            // Measurement markup annotations (H3): attach machine-readable measure
            // data (/Contents for any viewer's comment list, /NexusMeasure JSON for
            // round-trip) IF this build keeps vector annotations on save. Some save
            // paths rasterize pages (flattening annotations); in that case the
            // measure data still lives in the Excel/CSV export, and the visible
            // markup is baked into the page. Best-effort, never fatal.
            try {
                const { PDFName, PDFString, PDFHexString } = PDFLib;
                const ctx = pdfLibDoc.context;
                for (const pm of _pendingMeasureAnnots) {
                    const pg = pages[pm.pageIndex];
                    if (!pg) continue;
                    const { m, obj, scaleX, scaleY, pageHeight } = pm;
                    const bx = (obj.left || 0) * scaleX, byTop = (obj.top || 0) * scaleY;
                    const bw = Math.max(6, (obj.width || 20) * (obj.scaleX || 1) * scaleX);
                    const bh = Math.max(6, (obj.height || 20) * (obj.scaleY || 1) * scaleY);
                    const y1 = pageHeight - byTop - bh, y2 = pageHeight - byTop;
                    const dict = ctx.obj({
                        Type: 'Annot', Subtype: (m.area || m.cubic) ? 'Square' : 'PolyLine',
                        Rect: [bx, y1, bx + bw, y2],
                        Contents: PDFHexString.fromText((m.label ? m.label + ' - ' : '') + _autoLabelText(m).replace(/\s+/g, ' ')),
                        T: PDFHexString.fromText('Nexus Measure'),
                        Subj: PDFHexString.fromText('Measurement: ' + m.type),
                        C: [0.1, 0.44, 0.76], CA: 0.01, F: 4,
                        NexusMeasure: PDFString.of(JSON.stringify({
                            kind: m.kind, type: m.type, value: m.value, unit: m.unit,
                            subject: m.subject, label: m.label, geomPx: m.geomPx,
                            scaleAt: m.scaleAt, unitCost: m.unitCost, depth: m.depth,
                            area: !!m.area, cubic: !!m.cubic,
                        })),
                    });
                    const ref = ctx.register(dict);
                    const existing = pg.node.lookup(PDFName.of('Annots'));
                    if (existing && existing.push) existing.push(ref);
                    else pg.node.set(PDFName.of('Annots'), ctx.obj([ref]));
                }
            } catch (e) { console.warn('Could not write measurement annotations:', e); }

            if (_exportFailures > 0) {
                showToast(_exportFailures + ' markup(s) could not be saved into the PDF — check the result');
            }
            // Serialize and download
            const modifiedBytes = await pdfLibDoc.save();
            const blob = new Blob([modifiedBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.pdf$/i, '') + '_edited.pdf';
            a.click();
            // Defer revoke so the browser finishes reading the blob first.
            setTimeout(() => URL.revokeObjectURL(url), 60000);

            markDirty(false); // saved — the working copy is now safe on disk
            setStatus('PDF downloaded successfully');
            showToast('PDF saved: ' + a.download);
        } catch (err) {
            console.error(err);
            setStatus('Error downloading PDF: ' + err.message);
            showToast('Download failed');
        }
    }

    // Draw Fabric objects onto the actual PDF page using pdf-lib
    // Map a Fabric text object's family + bold/italic to an embedded PDF font.
    // pdf-lib ships the 14 standard fonts (Helvetica / Times / Courier families),
    // which cover sans / serif / mono + bold + italic — so exported text finally
    // reflects the detected font style instead of always being Helvetica-regular.
    let _exportFontCache = null;

    // ── Exact-font pipeline ─────────────────────────────────────────────────
    // pdf.js keeps each embedded font's actual program (TTF/OTF bytes) in
    // page.commonObjs for rendering. We capture those bytes when the user
    // edits a line, tag the edit with the font's id, and re-embed the SAME
    // font on save via fontkit — so edited text keeps the document's font.
    const _pdfFontRegistry = {};   // pdf.js loadedName -> font program bytes
    const _pdfFaceLoaded = new Set(); // FontFaces added for on-screen preview

    // Fabric strips unknown props on toJSON(); teach every object to persist
    // the font tag so it survives page switches and undo snapshots.
    (function () {
        const orig = fabric.Object.prototype.toObject;
        fabric.Object.prototype.toObject = function (props) {
            return orig.call(this, ['_pdfFontName', '_pdfWeight', '_pdfStyle', '_isTextCover', '_isCommentMark', '_isEraserPath',
                                    '_isSignature', '_isRedact', '_layerId', '_measure', '_measurePt', '_midLink',
                                    '_measureDecor', '_decorFor', '_cutoutFor', '_measureCaption', '_anchor', '_isLeader',
                                    '_isStamp', 'selectable', 'evented'].concat(props || []));
        };
    })();

    async function getExactPdfFont(pdfLibDoc, obj) {
        const name = obj._pdfFontName;
        const data = name && _pdfFontRegistry[name];
        if (!data) return null;
        try {
            if (!window.fontkit) await loadScript('libs/fontkit.umd.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'));
            if (!_exportFontCache || _exportFontCache.doc !== pdfLibDoc) {
                _exportFontCache = { doc: pdfLibDoc, fonts: {} };
            }
            if (!_exportFontCache.exact) _exportFontCache.exact = {};
            let entry = _exportFontCache.exact[name];
            if (entry === undefined) {
                pdfLibDoc.registerFontkit(window.fontkit);
                let fk = null;
                try { fk = window.fontkit.create(data instanceof Uint8Array ? data : new Uint8Array(data)); } catch { fk = null; }
                let embedded = null;
                try { embedded = await pdfLibDoc.embedFont(data); } catch { embedded = null; }
                entry = _exportFontCache.exact[name] = embedded ? { fk, embedded } : null;
            }
            if (!entry) return null;
            // Embedded fonts are usually SUBSET — they only contain the glyphs
            // the original document used. If the user typed a character the
            // subset lacks, fall back (else the PDF would show blanks).
            if (entry.fk) {
                for (const ch of (obj.text || '')) {
                    if (/\s/.test(ch)) continue;
                    if (!entry.fk.hasGlyphForCodePoint(ch.codePointAt(0))) return null;
                }
            }
            entry.embedded.widthOfTextAtSize('x', 10); // sanity: encoder works
            return entry.embedded;
        } catch { return null; }
    }
    async function getExportFont(pdfLibDoc, obj) {
        const SF = PDFLib.StandardFonts;
        const fam = (obj.fontFamily || 'Helvetica').toLowerCase();
        const w = obj._pdfWeight || obj.fontWeight;
        const st = obj._pdfStyle || obj.fontStyle;
        const bold = w === 'bold' || (typeof w === 'number' && w >= 600);
        const italic = st === 'italic' || st === 'oblique';

        let group = 'helv';
        if (/times|georgia|serif|garamond|palatino|book antiqua|cambria|minion/.test(fam)) group = 'times';
        else if (/courier|mono|consol/.test(fam)) group = 'courier';

        const key = group + (bold ? 'B' : '') + (italic ? 'I' : '');
        const map = {
            helv: SF.Helvetica, helvB: SF.HelveticaBold, helvI: SF.HelveticaOblique, helvBI: SF.HelveticaBoldOblique,
            times: SF.TimesRoman, timesB: SF.TimesRomanBold, timesI: SF.TimesRomanItalic, timesBI: SF.TimesRomanBoldItalic,
            courier: SF.Courier, courierB: SF.CourierBold, courierI: SF.CourierOblique, courierBI: SF.CourierBoldOblique,
        };
        if (!_exportFontCache || _exportFontCache.doc !== pdfLibDoc) {
            _exportFontCache = { doc: pdfLibDoc, fonts: {} };
        }
        if (!_exportFontCache.fonts[key]) {
            _exportFontCache.fonts[key] = await pdfLibDoc.embedFont(map[key]);
        }
        return _exportFontCache.fonts[key];
    }

    let _exportFailures = 0; // annotations that could not be baked this save
    async function drawObjectOnPDF(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight) {
        const { type } = obj;

        if (type === 'i-text' || type === 'text' || type === 'textbox') {
            // Rotated / center-origin text (stamps) and wrapping textboxes have
            // no faithful drawText mapping — rasterize them exactly instead.
            if (obj.angle || obj.originX === 'center' || obj.originY === 'center' || type === 'textbox'
                || (typeof obj.fill === 'string' && obj.fill.startsWith('rgba'))) {
                return await drawGenericObjectAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
            }
            // Text annotation — apply detected font family, bold, italic and underline
            const fontSize = (obj.fontSize || 16) * scaleY * (obj.scaleY || 1);
            const x = (obj.left || 0) * scaleX;
            const y = pageHeight - (obj.top || 0) * scaleY - fontSize;

            let color;
            try {
                color = hexToRgb(obj.fill || '#000000');
            } catch {
                color = { r: 0, g: 0, b: 0 };
            }
            const pdfColor = PDFLib.rgb(color.r / 255, color.g / 255, color.b / 255);

            let font = null;
            // 1st choice: the document's own embedded font (exact match);
            // fallback: closest standard font.
            try { font = await getExactPdfFont(pdfLibDoc, obj); } catch (_) { /* fall through */ }
            if (!font) {
                try { font = await getExportFont(pdfLibDoc, obj); } catch (_) { /* fall back to default */ }
            }

            const text = obj.text || '';
            pdfPage.drawText(text, {
                x, y, size: fontSize, color: pdfColor,
                ...(font ? { font } : {}),
            });

            // Underline: pdf-lib has no underline flag, so draw the line ourselves
            if (obj.underline && font) {
                const firstLine = text.split('\n')[0] || text;
                const lineW = font.widthOfTextAtSize(firstLine, fontSize);
                const uy = y - fontSize * 0.12;
                pdfPage.drawLine({
                    start: { x, y: uy }, end: { x: x + lineW, y: uy },
                    thickness: Math.max(fontSize * 0.06, 0.5), color: pdfColor,
                });
            }
        } else if (type === 'rect') {
            // Rectangle — outlined shapes AND filled marks (highlights,
            // underline/strike bars, comment marks, text-edit covers).
            const x = (obj.left || 0) * scaleX;
            const y = pageHeight - (obj.top || 0) * scaleY - (obj.height || 0) * scaleY * (obj.scaleY || 1);
            const w = (obj.width || 0) * scaleX * (obj.scaleX || 1);
            const h = (obj.height || 0) * scaleY * (obj.scaleY || 1);

            const opts = { x, y, width: w, height: h };
            const fillStr = typeof obj.fill === 'string' ? obj.fill : null;
            if (fillStr && fillStr !== 'transparent') {
                try {
                    let fr, alpha = obj.opacity !== undefined ? obj.opacity : 1;
                    const m = fillStr.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)$/);
                    if (m) { fr = { r: +m[1], g: +m[2], b: +m[3] }; if (m[4] !== undefined) alpha *= +m[4]; }
                    else fr = hexToRgb(fillStr);
                    opts.color = PDFLib.rgb(fr.r / 255, fr.g / 255, fr.b / 255);
                    opts.opacity = Math.max(0, Math.min(1, alpha));
                } catch { /* unparseable fill — skip it */ }
            }
            if (obj.stroke && obj.strokeWidth) {
                try {
                    const sc = hexToRgb(obj.stroke);
                    opts.borderColor = PDFLib.rgb(sc.r / 255, sc.g / 255, sc.b / 255);
                    opts.borderWidth = (obj.strokeWidth || 1) * scaleX;
                    if (Array.isArray(obj.strokeDashArray) && obj.strokeDashArray.length)
                        opts.borderDashArray = obj.strokeDashArray.map(v => v * scaleX);
                } catch { /* bad stroke color */ }
            }
            if (opts.color === undefined && opts.borderColor === undefined) return; // nothing to draw
            pdfPage.drawRectangle(opts);
        } else if (type === 'path') {
            // Freehand drawing - render as image overlay
            await drawPathAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
        } else if (type === 'ellipse' || type === 'triangle' || type === 'line' || type === 'group' || type === 'polygon') {
            // Shapes with no direct pdf-lib primitive (or with dash styles) —
            // re-create the fabric object and embed it as a crisp PNG overlay.
            // (These were previously DROPPED from the saved PDF entirely.)
            await drawGenericObjectAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
        } else if (type === 'image') {
            // Image object
            await drawImageOnPDF(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
        }
    }

    // Generic shape → PNG overlay: enliven the serialized object on a temp
    // canvas at 3× supersampling and embed the result at its bounding box.
    async function drawGenericObjectAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight) {
        try {
            const insts = await new Promise((resolve) => fabric.util.enlivenObjects([obj], resolve));
            const inst = insts && insts[0];
            if (!inst) return;
            const b = inst.getBoundingRect(true, true);
            if (b.width < 1 || b.height < 1) return;
            const pad = 8, ss = 3;
            const tmp = new fabric.StaticCanvas(null, {
                width: Math.ceil((b.width + pad * 2) * ss),
                height: Math.ceil((b.height + pad * 2) * ss),
            });
            inst.set({ left: inst.left - b.left + pad, top: inst.top - b.top + pad });
            inst.setCoords();
            tmp.setZoom(ss);
            tmp.add(inst);
            tmp.renderAll();
            const dataUrl = tmp.toDataURL({ format: 'png' });
            if (location.search.includes('testhooks')) {
                (window.__genDumps = window.__genDumps || []).push({
                    t: obj.type, cw: tmp.width, ch: tmp.height, duLen: dataUrl.length,
                    bb: { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
                    instLeft: Math.round(inst.left), instTop: Math.round(inst.top), vis: inst.visible,
                });
            }
            const png = await pdfLibDoc.embedPng(dataUrl);
            pdfPage.drawImage(png, {
                x: (b.left - pad) * scaleX,
                y: pageHeight - (b.top - pad) * scaleY - (b.height + pad * 2) * scaleY,
                width: (b.width + pad * 2) * scaleX,
                height: (b.height + pad * 2) * scaleY,
            });
        } catch (e) { _exportFailures++;
            console.warn('Shape export fallback failed:', e); }
    }

    // For complex paths (freehand drawing), render via a temp canvas and embed as image
    async function drawPathAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight) {
        try {
            const bounds = getBoundsFromPath(obj);
            const padding = 10;
            // Supersample factor for a crisp embedded stroke. The temp canvas is SS×
            // the natural size, so the path object must ALSO be scaled by SS and
            // offset by padding*SS — otherwise the ink renders at 1/SS size in the
            // top-left corner and appears shrunk/shifted in the exported PDF.
            const SS = 2;
            const canvasW = Math.max((bounds.width + padding * 2) * SS, 4);
            const canvasH = Math.max((bounds.height + padding * 2) * SS, 4);

            const tempCanvasEl = document.createElement('canvas');
            tempCanvasEl.width = canvasW;
            tempCanvasEl.height = canvasH;

            const tempCanvas = new fabric.StaticCanvas(tempCanvasEl, {
                width: canvasW,
                height: canvasH,
                enableRetinaScaling: false,
            });

            // Deep-clone the object data and reposition to origin
            const pathCopy = JSON.parse(JSON.stringify(obj));

            await new Promise((resolve, reject) => {
                try {
                    fabric.util.enlivenObjects([pathCopy], (objects) => {
                        objects.forEach((o) => {
                            o.set({
                                left: padding * SS,
                                top: padding * SS,
                                scaleX: (o.scaleX || 1) * SS,
                                scaleY: (o.scaleY || 1) * SS,
                            });
                            tempCanvas.add(o);
                        });
                        tempCanvas.renderAll();
                        resolve();
                    });
                } catch (e) {
                    reject(e);
                }
            });

            const dataUrl = tempCanvasEl.toDataURL('image/png');
            // Convert data URL to ArrayBuffer without fetch (works offline in Electron)
            const base64 = dataUrl.split(',')[1];
            const binaryStr = atob(base64);
            const pngBytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                pngBytes[i] = binaryStr.charCodeAt(i);
            }
            const pngImage = await pdfLibDoc.embedPng(pngBytes);

            const x = (obj.left || 0) * scaleX - padding * scaleX;
            const w = (bounds.width + padding * 2) * scaleX;
            const h = (bounds.height + padding * 2) * scaleY;
            const y = pageHeight - (obj.top || 0) * scaleY - h + padding * scaleY;

            pdfPage.drawImage(pngImage, { x, y, width: w, height: h });
            tempCanvas.dispose();
        } catch (err) {
            _exportFailures++;
            console.warn('Could not embed path:', err);
        }
    }

    function getBoundsFromPath(obj) {
        const w = (obj.width || 100) * (obj.scaleX || 1);
        const h = (obj.height || 100) * (obj.scaleY || 1);
        return { width: w, height: h };
    }

    async function drawImageOnPDF(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight) {
        try {
            const src = obj.src;
            if (!src) return;

            // Rotation, flips and borders have no fast path in pdf-lib here —
            // rasterize the fabric object so the save matches the screen.
            if (obj.angle || obj.flipX || obj.flipY || (obj.stroke && obj.strokeWidth)) {
                return await drawGenericObjectAsImage(pdfLibDoc, pdfPage, obj, scaleX, scaleY, pageHeight);
            }

            let imgBytes;
            if (src.startsWith('data:')) {
                // Data URL - convert without fetch
                const base64 = src.split(',')[1];
                if (!base64) return;
                const binaryStr = atob(base64);
                imgBytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    imgBytes[i] = binaryStr.charCodeAt(i);
                }
            } else {
                const response = await fetch(src);
                imgBytes = new Uint8Array(await response.arrayBuffer());
            }

            let pdfImage;
            const isPng = src.includes('image/png') || src.toLowerCase().endsWith('.png') ||
                          (src.startsWith('data:image/png'));
            if (isPng) {
                pdfImage = await pdfLibDoc.embedPng(imgBytes);
            } else {
                pdfImage = await pdfLibDoc.embedJpg(imgBytes);
            }

            const w = (obj.width || 100) * (obj.scaleX || 1) * scaleX;
            const h = (obj.height || 100) * (obj.scaleY || 1) * scaleY;
            const x = (obj.left || 0) * scaleX;
            const y = pageHeight - (obj.top || 0) * scaleY - h;

            pdfPage.drawImage(pdfImage, { x, y, width: w, height: h });
        } catch (err) {
            _exportFailures++;
            console.warn('Could not embed image:', err);
        }
    }

    // ── Edit-text guide boxes ──────────────────────────────────────────────────
    // When the Edit Text tool is active, outline every editable text block with a
    // dashed box so the user can SEE what is editable and click any block - no
    // guessing. Boxes are non-exporting overlays; cleared when leaving the tool.
    let _editTextGuides = [];
    async function showEditTextGuides() {
        clearEditTextGuides();
        if (!state.pdfDoc || !fabricCanvas) return;
        if (!_textItemsCache) await buildTextItemsCache(state.currentPage);
        if (!_textItemsCache || state.activeTool !== 'edittext') return;

        // pdf.js splits text into many small word/glyph fragments. Boxing each
        // one looks like confetti (a box per word). Instead, MERGE fragments that
        // sit on the same line (same baseline y, within a small tolerance) into
        // ONE box spanning the whole line - clean, readable outlines like a
        // proper editor. Fragments separated by a large horizontal gap (e.g.
        // table columns) stay as separate boxes on the same line.
        const rows = [];
        for (const entry of _textItemsCache) {
            const b = entry.bbox;
            const tol = Math.max(4, b.height * 0.5);
            let row = rows.find(r => Math.abs(r.cy - (b.top + b.height / 2)) < tol);
            if (!row) { row = { cy: b.top + b.height / 2, segs: [] }; rows.push(row); }
            row.segs.push({ left: b.left, right: b.left + b.width, top: b.top, bottom: b.top + b.height, h: b.height });
        }

        for (const row of rows) {
            row.segs.sort((a, b) => a.left - b.left);
            // Merge segments into runs; break a run where a big gap (a table
            // cell boundary) appears, so columns don't join into one wide box.
            let run = null;
            const runs = [];
            for (const s of row.segs) {
                const gap = run ? s.left - run.right : 0;
                if (run && gap <= s.h * 2.2) {
                    run.right = Math.max(run.right, s.right);
                    run.top = Math.min(run.top, s.top);
                    run.bottom = Math.max(run.bottom, s.bottom);
                } else {
                    run = { left: s.left, right: s.right, top: s.top, bottom: s.bottom };
                    runs.push(run);
                }
            }
            for (const r of runs) {
                const box = new fabric.Rect({
                    left: r.left - 2, top: r.top - 2, width: (r.right - r.left) + 4, height: (r.bottom - r.top) + 4,
                    fill: 'rgba(120,140,240,0.035)', stroke: 'rgba(120,145,235,0.5)', strokeWidth: 1,
                    strokeDashArray: [4, 3], rx: 3, ry: 3,
                    // evented:false means Fabric never routes hover here, so a
                    // hoverCursor would never fire - the tool-level cursor handles it.
                    selectable: false, evented: false, excludeFromExport: true, _editTextGuide: true,
                });
                _isRestoring = true;
                fabricCanvas.add(box);
                _isRestoring = false;
                _editTextGuides.push(box);
            }
        }
        fabricCanvas.renderAll();
        if (_editTextGuides.length) setStatus('Edit Text: click any highlighted line to edit it - font, size and style are kept');
    }
    function clearEditTextGuides() {
        if (!fabricCanvas || !_editTextGuides.length) { _editTextGuides = []; return; }
        _isRestoring = true;
        _editTextGuides.forEach(b => fabricCanvas.remove(b));
        _isRestoring = false;
        _editTextGuides = [];
        fabricCanvas.renderAll();
    }
    window.showEditTextGuides = showEditTextGuides;
    window.clearEditTextGuides = clearEditTextGuides;

    // ── Edit Text Tool (explicit tool mode click) ──
    function handleEditTextClick(opt) {
        if (state.activeTool !== 'edittext') return;
        if (opt.target) return;
        enterTextEditMode(opt);
    }

    // ── Core: enter in-place text editing at the pointer position ──
    // Called from explicit edittext tool clicks AND double-click in any mode.
    async function enterTextEditMode(opt) {
        if (!state.pdfDoc || !fabricCanvas) return;
        const pointer = fabricCanvas.getPointer(opt.e);

        if (!_textItemsCache) await buildTextItemsCache(state.currentPage);

        const entry = findTextItemAt(pointer.x, pointer.y, 5);
        if (!entry) {
            if (state.activeTool === 'edittext') showToast('No text found here. Click directly on text.');
            return;
        }

        const { item, baseline, fontSizePx, bbox } = entry;

        // ── Font family / bold / italic from PDF metadata ──
        const detected = detectPdfFont(item, fontSizePx); // pass pre-computed size

        // ── EXACT font, three levels of intelligence ──
        // 1) The font program EMBEDDED in the PDF (pdf.js keeps its bytes):
        //    loaded as a FontFace for on-screen editing AND re-embedded on save.
        // 2) Not embedded (PDF references a named system font): use that exact
        //    font from the OS if installed (document.fonts.check).
        // 3) Neither available: closest metric substitute (detectPdfFont).
        let exactFontName = null, exactFaceFamily = null, fontSource = 'substitute';
        try {
            const pg = await state.pdfDoc.getPage(state.currentPage);
            let fobj = null;
            try { fobj = pg.commonObjs.has(item.fontName) ? pg.commonObjs.get(item.fontName) : null; } catch (_) { fobj = null; }
            if (fobj && fobj.data && fobj.data.length) {
                // Level 1 — embedded font program
                _pdfFontRegistry[item.fontName] = fobj.data;
                exactFontName = item.fontName;
                exactFaceFamily = 'PDFExact-' + item.fontName;
                if (!_pdfFaceLoaded.has(exactFaceFamily)) {
                    const face = new FontFace(exactFaceFamily, fobj.data.buffer ? fobj.data : new Uint8Array(fobj.data));
                    await face.load();
                    document.fonts.add(face);
                    _pdfFaceLoaded.add(exactFaceFamily);
                }
                fontSource = 'embedded (exact)';
            } else {
                // Level 2 — same-named font installed on this computer
                const rawName = String((fobj && fobj.name) || item.fontName || '')
                    .replace(/^[A-Z]{1,6}\+/, '');                     // strip subset prefix
                const family = rawName.split(/[-,]/)[0]
                    .replace(/(MT|PS|Std|Pro)$/i, '')
                    .replace(/([a-z])([A-Z])/g, '$1 $2').trim();        // CamelCase → words
                if (family && document.fonts.check(`12px "${family}"`)) {
                    exactFaceFamily = `"${family}"`;
                    fontSource = 'system font "' + family + '"';
                }
            }
            // The REAL font name (e.g. "SegoeUI-Bold") lives on the font
            // object — item.fontName is just an alias like "g_d0_f1", so
            // bold/italic detection must use the real one.
            try {
                const realName = String((fobj && fobj.name) || '');
                if (/bold|black|heavy|semi|demi/i.test(realName)) detected.fontWeight = 'bold';
                if (/italic|oblique/i.test(realName)) detected.fontStyle = 'italic';
            } catch (_) {}
        } catch (e) { exactFaceFamily = null; console.warn('font capture:', e); }

        // ── Sample exact background and text colors from the rendered canvas ──
        const bgColor   = sampleBgColor(dom.pdfCanvas, bbox.left, bbox.top, bbox.width, bbox.height);
        const textColor = sampleTextColor(dom.pdfCanvas, bbox.left, bbox.top, bbox.width, bbox.height);
        const fill      = textColor || detected.fill;

        // ── Precise positioning ──
        // In Fabric IText, 'top' is the bounding-box top (above the ascender).
        // The visual baseline in Fabric sits at roughly: top + fontSize * 0.86
        // So to align Fabric baseline with the PDF baseline:
        //   fabricTop = baseline - fontSize * ASCENT_RATIO
        // Fabric renders an IText from its top, so we place the top one ascent
        // above the PDF baseline. 0.92 lines the edit box up with the original
        // glyphs; a smaller value made the box sit slightly LOW so the text
        // dropped and the user had to nudge it back up.
        const fabricTop  = Math.round(baseline - fontSizePx * 0.92);
        const fabricLeft = Math.round(bbox.left);

        // ── Cover rect: perfectly aligned with the visual text area ──
        // Spans from above ascender to below descender so no original ink shows.
        const coverTop    = Math.round(baseline - fontSizePx * 1.05);  // above cap-height
        const coverBottom = Math.round(baseline + fontSizePx * 0.28);  // below descender
        const coverRect   = new fabric.Rect({
            left:    fabricLeft - 2,
            top:     coverTop,
            width:   Math.max(bbox.width, 10) + 4,
            height:  Math.max(coverBottom - coverTop, fontSizePx),
            fill:    bgColor,
            opacity: 0.5,       // see-through so you can see what you're replacing
            selectable: false,
            evented:    false,
            _isTextCover: true,
        });

        // ── Font family + fallback chain ──
        // The embedded PDF font is usually SUBSETTED - it only carries the
        // glyphs already on the page. If the original text was lowercase, the
        // subset often has NO uppercase glyphs, so typing capitals fell back to
        // the browser default (wrong shape AND size). Give the canvas a fallback
        // family (the closest standard font from detectPdfFont) after the exact
        // face, so any glyph the subset lacks renders in a matching font instead
        // of a random default. Fabric draws via ctx.font, which honors a
        // comma-separated CSS stack for per-glyph fallback.
        const editFamily = exactFaceFamily
            ? `${exactFaceFamily}, "${detected.fontFamily}", sans-serif`
            : detected.fontFamily;

        // ── Editable IText — exact font size, no scaling ──
        const editText = new fabric.IText(item.str, {
            left:        fabricLeft,
            top:         fabricTop,
            fontSize:    fontSizePx,       // exact size from PDF transform matrix
            fontFamily:  editFamily,       // exact face first, matching fallback after
            // Embedded programs bake weight/style into the face; a system
            // family needs the PDF's bold/italic applied as CSS styles.
            fontWeight:  exactFontName ? 'normal' : detected.fontWeight,
            fontStyle:   exactFontName ? 'normal' : detected.fontStyle,
            // TRUE weight/style of the original — used by the standard-font
            // fallback on save so bold/italic survive even when the exact
            // embedded font can't be reused (e.g. new chars not in subset).
            _pdfWeight:  detected.fontWeight,
            _pdfStyle:   detected.fontStyle,
            lineHeight:  1,                // match PDF line-height (no Fabric inflation)
            fill:        fill,
            editable:    true,
            cursorColor: fill,
            _isTextEdit: true,
            ...(exactFontName ? { _pdfFontName: exactFontName } : {}),
        });

        // Force a UNIFORM weight/style across the whole edit box. Without this,
        // Fabric can carry per-character style overrides so newly typed text
        // (and neighbouring characters) rendered with mixed bold/normal within
        // the same word - the "bold in the middle" jumble. Clearing styles makes
        // every character follow the object's single fontWeight/fontFamily, and
        // re-clearing on each change keeps typed text uniform too.
        editText.styles = {};
        const _keepUniform = () => {
            if (editText.styles && Object.keys(editText.styles).length) {
                editText.styles = {};
                editText.set({ fontWeight: editText.fontWeight, fontFamily: editText.fontFamily });
            }
        };
        editText.on('changed', _keepUniform);

        // Once the user starts typing → cover becomes fully opaque
        editText.on('editing:entered', () => {
            coverRect.set({ opacity: 1 });
            fabricCanvas.renderAll();
        });

        _isRestoring = true;
        fabricCanvas.add(coverRect);
        _isRestoring = false;

        fabricCanvas.add(editText);
        fabricCanvas.setActiveObject(editText);
        editText.enterEditing();
        editText.selectAll();
        fabricCanvas.renderAll();

        showContextualBar(editText);
        setStatus(`Editing: "${item.str.substring(0, 40)}"  |  ${exactFaceFamily ? 'original font — ' + fontSource : 'substitute: ' + detected.fontFamily} · ${Math.round(fontSizePx)}px`);
    }

    // ── Sample background color from pdfCanvas at a display-coordinate bbox ──
    function sampleBgColor(canvas, dispLeft, dispTop, dispWidth, dispHeight) {
        try {
            const ctx = canvas.getContext('2d');
            const s = 1.5; // retina multiplier
            const x = Math.max(0, Math.round(dispLeft * s));
            const y = Math.max(0, Math.round(dispTop  * s));
            const w = Math.min(Math.max(Math.round(dispWidth  * s), 2), canvas.width  - x);
            const h = Math.min(Math.max(Math.round(dispHeight * s), 2), canvas.height - y);
            if (w <= 0 || h <= 0) return '#ffffff';

            const data = ctx.getImageData(x, y, w, h).data;

            // Collect all pixels, sort by brightness descending, average the top 25% (background)
            const pixels = [];
            for (let i = 0; i < data.length; i += 4) {
                pixels.push([data[i], data[i + 1], data[i + 2], data[i] + data[i + 1] + data[i + 2]]);
            }
            pixels.sort((a, b) => b[3] - a[3]);
            const top = pixels.slice(0, Math.max(1, Math.floor(pixels.length * 0.25)));
            const n   = top.length;
            const r   = Math.round(top.reduce((s, p) => s + p[0], 0) / n);
            const g   = Math.round(top.reduce((s, p) => s + p[1], 0) / n);
            const b   = Math.round(top.reduce((s, p) => s + p[2], 0) / n);
            return `rgb(${r},${g},${b})`;
        } catch (_) { return '#ffffff'; }
    }

    // ── Sample text color: find the darkest cluster of pixels (the ink) ──
    function sampleTextColor(canvas, dispLeft, dispTop, dispWidth, dispHeight) {
        try {
            const ctx = canvas.getContext('2d');
            const s = 1.5;
            // Sample center horizontal strip — most likely to hit ink
            const x = Math.max(0, Math.round((dispLeft + dispWidth  * 0.05) * s));
            const y = Math.max(0, Math.round((dispTop  + dispHeight * 0.2)  * s));
            const w = Math.min(Math.max(Math.round(dispWidth  * 0.9  * s), 2), canvas.width  - x);
            const h = Math.min(Math.max(Math.round(dispHeight * 0.6  * s), 2), canvas.height - y);
            if (w <= 0 || h <= 0) return null;

            const data = ctx.getImageData(x, y, w, h).data;

            // Find darkest pixel
            let dR = 0, dG = 0, dB = 0, dBri = 768;
            for (let i = 0; i < data.length; i += 4) {
                const bri = data[i] + data[i + 1] + data[i + 2];
                if (bri < dBri) { dBri = bri; dR = data[i]; dG = data[i + 1]; dB = data[i + 2]; }
            }
            // Only use if meaningfully dark (actual ink, not compression noise)
            if (dBri < 360) return `rgb(${dR},${dG},${dB})`;
        } catch (_) {}
        return null;
    }

    // ── Map PDF font metadata → web font family + bold/italic flags ──
    // fontSizePx is already computed from the transform matrix — no recalculation needed.
    function detectPdfFont(item, fontSizePx) {
        // Strip PDF subset prefix (e.g. "ABCDEF+Arial-Bold" → "Arial-Bold")
        const rawName   = (item.fontName || '').replace(/^[A-Z]{1,6}\+/, '');
        const nameLower = rawName.toLowerCase();

        let fontFamily = 'Arial';
        if      (nameLower.includes('timesnewroman') || (nameLower.includes('times') && !nameLower.includes('italic')))
                                                                                      fontFamily = 'Times New Roman';
        else if (nameLower.includes('times'))                                         fontFamily = 'Times New Roman';
        else if (nameLower.includes('courier'))                                       fontFamily = 'Courier New';
        else if (nameLower.includes('helvetica'))                                     fontFamily = 'Helvetica';
        else if (nameLower.includes('georgia'))                                       fontFamily = 'Georgia';
        else if (nameLower.includes('verdana'))                                       fontFamily = 'Verdana';
        else if (nameLower.includes('impact'))                                        fontFamily = 'Impact';
        else if (nameLower.includes('trebuchet'))                                     fontFamily = 'Trebuchet MS';
        else if (nameLower.includes('palatino') || nameLower.includes('garamond'))    fontFamily = 'Georgia';
        else if (nameLower.includes('arial'))                                         fontFamily = 'Arial';
        else if (nameLower.includes('calibri') || nameLower.includes('myriad'))       fontFamily = 'Arial';
        else if (nameLower.includes('futura')  || nameLower.includes('gill'))         fontFamily = 'Trebuchet MS';

        const isBold   = /bold|heavy|black|demi/i.test(rawName);
        const isItalic = /italic|oblique|slant/i.test(rawName);

        return {
            fontFamily,
            // fontSizePx passed in — already exact, no extra calculation
            fontSize:   fontSizePx || 14,
            fontWeight: isBold   ? 'bold'   : 'normal',
            fontStyle:  isItalic ? 'italic' : 'normal',
            fill:       '#000000',
        };
    }

    // ── Export As ──
    function toggleExportMenu() {
        if (!state.pdfDoc) return;
        const isOpen = dom.exportMenu.classList.contains('open');
        if (!isOpen) {
            const rect = dom.exportBtn.getBoundingClientRect();
            dom.exportMenu.style.top = rect.bottom + 4 + 'px';
            dom.exportMenu.style.left = rect.left + 'px';
        }
        dom.exportMenu.classList.toggle('open');
    }

    async function exportAs(format) {
        if (!state.pdfDoc) return;

        setStatus('Exporting as ' + format.toUpperCase() + '...');

        try {
            switch (format) {
                case 'png': await exportImage('png'); break;
                case 'jpeg': await exportImage('jpeg'); break;
                case 'tiff': await exportTIFF(); break;
                case 'all-png': await exportAllImages('png'); break;
                case 'all-jpeg': await exportAllImages('jpeg'); break;
                case 'word': await exportWord(); break;
                case 'excel': await exportExcel(); break;
                default: showToast('Unknown format'); return;
            }
        } catch (err) {
            console.error(err);
            setStatus('Export failed: ' + err.message);
            showToast('Export failed');
        }
    }

    async function exportImage(format) {
        const page = await state.pdfDoc.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: 3 }); // High quality render

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Include the annotation layer — what you see is what exports.
        try {
            const fc = document.getElementById('fabricCanvas');
            if (fc && fc.width > 0) ctx.drawImage(fc, 0, 0, canvas.width, canvas.height);
        } catch (_) { /* no annotations */ }

        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = format === 'jpeg' ? 0.95 : undefined;
        const ext = format === 'jpeg' ? 'jpg' : 'png';

        canvas.toBlob((blob) => {
            if (!blob) {
                setStatus('Export failed');
                showToast('Could not export image');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.pdf$/i, '') + '_page' + state.currentPage + '.' + ext;
            a.click();
            URL.revokeObjectURL(url);
            setStatus('Exported page ' + state.currentPage + ' as ' + ext.toUpperCase());
            showToast('Page ' + state.currentPage + ' saved as ' + ext.toUpperCase());
        }, mimeType, quality);
    }

    async function exportTIFF() {
        const page = await state.pdfDoc.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: 3 });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Include the annotation layer — what you see is what exports.
        try {
            const fc = document.getElementById('fabricCanvas');
            if (fc && fc.width > 0) ctx.drawImage(fc, 0, 0, canvas.width, canvas.height);
        } catch (_) { /* no annotations */ }

        const blob = canvasToTiffBlob(canvas);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.fileName.replace(/\.pdf$/i, '') + '_page' + state.currentPage + '.tiff';
        a.click();
        URL.revokeObjectURL(url);
        setStatus('Exported page ' + state.currentPage + ' as TIFF');
        showToast('Page ' + state.currentPage + ' saved as TIFF');
    }

    function canvasToTiffBlob(canvas) {
        const w = canvas.width;
        const h = canvas.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, w, h);
        const rgba = imgData.data;

        // Convert RGBA to RGB
        const stripSize = w * h * 3;
        const rgb = new Uint8Array(stripSize);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
            rgb[j] = rgba[i];
            rgb[j + 1] = rgba[i + 1];
            rgb[j + 2] = rgba[i + 2];
        }

        // TIFF structure
        const numTags = 11;
        const ifdStart = 8;
        const ifdSize = 2 + (numTags * 12) + 4;
        const extraStart = ifdStart + ifdSize;
        const bpsOffset = extraStart;
        const xresOffset = bpsOffset + 6;
        const yresOffset = xresOffset + 8;
        const pixelOffset = yresOffset + 8;
        const totalSize = pixelOffset + stripSize;

        const buf = new ArrayBuffer(totalSize);
        const dv = new DataView(buf);
        const u8 = new Uint8Array(buf);

        // Header: little-endian, TIFF magic, IFD offset
        dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);
        dv.setUint16(2, 42, true);
        dv.setUint32(4, ifdStart, true);

        // IFD entries (must be in ascending tag order)
        let p = ifdStart;
        dv.setUint16(p, numTags, true); p += 2;

        function tag(id, type, count, value) {
            dv.setUint16(p, id, true); p += 2;
            dv.setUint16(p, type, true); p += 2;
            dv.setUint32(p, count, true); p += 4;
            dv.setUint32(p, value, true); p += 4;
        }

        tag(256, 3, 1, w);              // ImageWidth
        tag(257, 3, 1, h);              // ImageLength
        tag(258, 3, 3, bpsOffset);       // BitsPerSample → offset
        tag(259, 3, 1, 1);              // Compression = None
        tag(262, 3, 1, 2);              // PhotometricInterpretation = RGB
        tag(273, 4, 1, pixelOffset);     // StripOffsets
        tag(277, 3, 1, 3);              // SamplesPerPixel
        tag(278, 3, 1, h);              // RowsPerStrip
        tag(279, 4, 1, stripSize);       // StripByteCounts
        tag(282, 5, 1, xresOffset);      // XResolution → offset
        tag(283, 5, 1, yresOffset);      // YResolution → offset

        dv.setUint32(p, 0, true); // Next IFD = 0

        // BitsPerSample: 8, 8, 8
        dv.setUint16(bpsOffset, 8, true);
        dv.setUint16(bpsOffset + 2, 8, true);
        dv.setUint16(bpsOffset + 4, 8, true);

        // XResolution: 72/1
        dv.setUint32(xresOffset, 72, true);
        dv.setUint32(xresOffset + 4, 1, true);

        // YResolution: 72/1
        dv.setUint32(yresOffset, 72, true);
        dv.setUint32(yresOffset + 4, 1, true);

        // Pixel data
        u8.set(rgb, pixelOffset);

        return new Blob([buf], { type: 'image/tiff' });
    }

    // ── Export All Pages as Images ──
    async function exportAllImages(format) {
        const ext = format === 'jpeg' ? 'jpg' : 'png';
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const quality = format === 'jpeg' ? 0.92 : undefined;
        const baseName = state.fileName.replace(/\.pdf$/i, '');

        dom.exportAllProgress.style.display = 'flex';
        dom.exportAllStatus.textContent = 'Preparing...';
        dom.exportAllBar.style.width = '0%';

        const canvases = [];
        for (let i = 1; i <= state.totalPages; i++) {
            dom.exportAllStatus.textContent = `Rendering page ${i} of ${state.totalPages}...`;
            dom.exportAllBar.style.width = Math.round((i / state.totalPages) * 70) + '%';

            const page = await state.pdfDoc.getPage(i);
            const viewport = page.getViewport({ scale: 3 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            canvases.push({ canvas, name: `${baseName}_page${i}.${ext}` });

            // Yield to UI
            if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
        }

        dom.exportAllStatus.textContent = 'Packaging into ZIP...';
        dom.exportAllBar.style.width = '80%';

        // Try JSZip (lazy load), fallback to sequential downloads
        try {
            await loadScript('libs/jszip.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js'));
            const zip = new JSZip();
            for (const { canvas, name } of canvases) {
                const blob = await new Promise((res) => canvas.toBlob(res, mimeType, quality));
                const buf = await blob.arrayBuffer();
                zip.file(name, buf);
            }
            dom.exportAllBar.style.width = '95%';
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${baseName}_all_pages.zip`;
            a.click();
            URL.revokeObjectURL(url);
            showToast(`${state.totalPages} pages saved as ZIP`);
        } catch (_) {
            // No JSZip (offline) — download each file individually
            for (let i = 0; i < canvases.length; i++) {
                const { canvas, name } = canvases[i];
                dom.exportAllStatus.textContent = `Downloading ${i + 1}/${canvases.length}...`;
                await new Promise((res) => {
                    canvas.toBlob((blob) => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = name;
                        a.click();
                        URL.revokeObjectURL(url);
                        setTimeout(res, 300); // slight delay between downloads
                    }, mimeType, quality);
                });
            }
            showToast(`${state.totalPages} pages downloaded`);
        }

        dom.exportAllBar.style.width = '100%';
        setStatus(`All ${state.totalPages} pages exported as ${ext.toUpperCase()}`);
        setTimeout(() => { dom.exportAllProgress.style.display = 'none'; }, 1500);
    }

    // ── Export to Word ──
    async function exportWord() {
        setStatus('Exporting to Word...');

        // Lazy-load docx library
        if (!window.docx) {
            try {
                await loadScript('libs/docx.umd.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/docx@8/build/index.umd.js'));
            } catch (e) {
                // Fallback: export as HTML-based .doc
                await exportWordFallback();
                return;
            }
        }

        try {
            const children = [];

            for (let i = 1; i <= state.totalPages; i++) {
                setStatus('Extracting text: page ' + i + '/' + state.totalPages);
                const page = await state.pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const lines = groupTextIntoLines(textContent.items);

                for (const line of lines) {
                    children.push(new docx.Paragraph({
                        children: [new docx.TextRun({ text: line, size: 24 })],
                    }));
                }

                // Page break between pages
                if (i < state.totalPages) {
                    children.push(new docx.Paragraph({
                        children: [],
                        pageBreakBefore: true,
                    }));
                }
            }

            const doc = new docx.Document({
                sections: [{ children: children }],
            });

            const blob = await docx.Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.pdf$/i, '') + '.docx';
            a.click();
            URL.revokeObjectURL(url);

            setStatus('Exported to Word successfully');
            showToast('Saved as Word document');
        } catch (err) {
            console.error(err);
            // Fallback on any error
            await exportWordFallback();
        }
    }

    async function exportWordFallback() {
        let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + escapeHtml(state.fileName) + '</title></head><body>';

        for (let i = 1; i <= state.totalPages; i++) {
            setStatus('Extracting text: page ' + i + '/' + state.totalPages);
            const page = await state.pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            const lines = groupTextIntoLines(textContent.items);

            for (const line of lines) {
                html += '<p>' + escapeHtml(line) + '</p>';
            }

            if (i < state.totalPages) {
                html += '<br style="page-break-after: always;">';
            }
        }

        html += '</body></html>';
        const blob = new Blob([html], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.fileName.replace(/\.pdf$/i, '') + '.doc';
        a.click();
        URL.revokeObjectURL(url);

        setStatus('Exported to Word (basic format)');
        showToast('Saved as Word document');
    }

    // ── Export to Excel ──
    async function exportExcel() {
        setStatus('Exporting to Excel...');

        // Lazy-load SheetJS
        if (!window.XLSX) {
            try {
                await loadScript('libs/xlsx.full.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'));
            } catch (e) {
                // Fallback: export as HTML-based .xls
                await exportExcelFallback();
                return;
            }
        }

        try {
            const wb = XLSX.utils.book_new();

            for (let i = 1; i <= state.totalPages; i++) {
                setStatus('Extracting tables: page ' + i + '/' + state.totalPages);
                const page = await state.pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const rows = groupTextIntoTable(textContent.items);
                const ws = XLSX.utils.aoa_to_sheet(rows);
                XLSX.utils.book_append_sheet(wb, ws, 'Page ' + i);
            }

            XLSX.writeFile(wb, state.fileName.replace(/\.pdf$/i, '') + '.xlsx');

            setStatus('Exported to Excel successfully');
            showToast('Saved as Excel spreadsheet');
        } catch (err) {
            console.error(err);
            await exportExcelFallback();
        }
    }

    async function exportExcelFallback() {
        let html = '<html><head><meta charset="utf-8"></head><body>';

        for (let i = 1; i <= state.totalPages; i++) {
            setStatus('Extracting tables: page ' + i + '/' + state.totalPages);
            const page = await state.pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            const rows = groupTextIntoTable(textContent.items);

            html += '<h3>Page ' + i + '</h3>';
            html += '<table border="1" cellpadding="4" cellspacing="0">';
            for (const row of rows) {
                html += '<tr>';
                for (const cell of row) {
                    html += '<td>' + escapeHtml(cell) + '</td>';
                }
                html += '</tr>';
            }
            html += '</table><br>';
        }

        html += '</body></html>';
        const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.fileName.replace(/\.pdf$/i, '') + '.xls';
        a.click();
        URL.revokeObjectURL(url);

        setStatus('Exported to Excel (basic format)');
        showToast('Saved as Excel spreadsheet');
    }

    // ── Text Grouping Utilities ──
    function groupTextIntoLines(items) {
        const filtered = items.filter((i) => i.str.trim());
        if (filtered.length === 0) return [''];

        // Sort by y (descending - top of page first) then by x (left to right)
        const sorted = [...filtered].sort((a, b) => {
            const ay = a.transform[5];
            const by = b.transform[5];
            if (Math.abs(ay - by) > 3) return by - ay;
            return a.transform[4] - b.transform[4];
        });

        const lines = [];
        let currentLine = [];
        let lastY = null;

        for (const item of sorted) {
            const y = item.transform[5];
            if (lastY !== null && Math.abs(y - lastY) > 3) {
                lines.push(currentLine.map((i) => i.str).join(' '));
                currentLine = [];
            }
            currentLine.push(item);
            lastY = y;
        }

        if (currentLine.length > 0) {
            lines.push(currentLine.map((i) => i.str).join(' '));
        }

        return lines;
    }

    function groupTextIntoTable(items) {
        const filtered = items.filter((i) => i.str.trim());
        if (filtered.length === 0) return [['']];

        // Sort by y (descending) then by x (ascending)
        const sorted = [...filtered].sort((a, b) => {
            const ay = a.transform[5];
            const by = b.transform[5];
            if (Math.abs(ay - by) > 3) return by - ay;
            return a.transform[4] - b.transform[4];
        });

        const rows = [];
        let currentRow = [];
        let lastY = null;

        for (const item of sorted) {
            const y = item.transform[5];
            if (lastY !== null && Math.abs(y - lastY) > 3) {
                rows.push(currentRow.map((i) => i.str));
                currentRow = [];
            }
            currentRow.push(item);
            lastY = y;
        }

        if (currentRow.length > 0) {
            rows.push(currentRow.map((i) => i.str));
        }

        return rows;
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Rotate Page ──
    async function rotatePage() {
        _exitScrollForOp();
        if (!state.pdfBytes) return;

        setStatus('Rotating page...');

        try {
            saveCurrentAnnotations();
            pushDocSnapshot('Rotate'); // Cmd+Z now undoes rotation too

            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            const page = pdfLibDoc.getPages()[state.currentPage - 1];

            const currentRotation = page.getRotation().angle;
            page.setRotation(PDFLib.degrees((currentRotation + 90) % 360));

            const newBytes = await pdfLibDoc.save();
            state.pdfBytes = newBytes.slice().buffer;

            // Rotate this page's annotations 90 deg CW to follow the page (M4)
            // instead of deleting them. Measurements keep their values (geomPx is
            // rotation-invariant); only positions/angles change. Must run BEFORE
            // state.pdfDoc is replaced, since it reads the pre-rotation viewport.
            await _rotatePageAnnotations(state.currentPage, 90);

            const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
            if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
            state.pdfDoc = pdf;

            renderPage(state.currentPage);
            generateThumbnails();

            setStatus('Page rotated 90\u00B0');
            showToast('Page ' + state.currentPage + ' rotated');
        } catch (err) {
            console.error(err);
            setStatus('Rotate failed: ' + err.message);
            showToast('Rotate failed');
        }
    }

    // ── Stamp / Watermark ──
    function toggleStampMenu() {
        if (!state.pdfDoc) return;
        const isOpen = dom.stampMenu.classList.contains('open');
        if (!isOpen) {
            const rect = dom.stampBtn.getBoundingClientRect();
            dom.stampMenu.style.top = rect.bottom + 4 + 'px';
            dom.stampMenu.style.left = rect.left + 'px';
        }
        dom.stampMenu.classList.toggle('open');
    }

    // Custom stamp dialog: stamp text + optional date, color, an "Approval
    // stamp" quick-fill (name + date), and "apply to all pages".
    const STAMP_NAME_KEY = 'pdfEditorStampName';
    function customStampDialog(defaultColor = '#d32f2f') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.display = 'flex';
            const today = new Date().toISOString().slice(0, 10);
            const savedName = (() => { try { return localStorage.getItem(STAMP_NAME_KEY) || ''; } catch { return ''; } })();
            overlay.innerHTML = `
                <div class="modal">
                    <div class="modal-header"><span>Custom stamp</span></div>
                    <div class="modal-body">
                        <button type="button" class="crop-btn" id="csApproval" style="width:100%;margin-bottom:12px;background:hsla(140,60%,40%,0.14);color:#1a7a3f;border:1px solid hsla(140,60%,40%,0.35);font-weight:600;">✓ Approval stamp (your name + today's date)</button>
                        <label class="modal-label">Your name (for approval stamps):</label>
                        <input type="text" class="modal-input" id="csName" placeholder="e.g. Ankush Narkhede" maxlength="40" value="${escapeHtml(savedName)}">
                        <label class="modal-label" style="margin-top:10px;">Stamp text:</label>
                        <input type="text" class="modal-input" id="csText" placeholder="e.g. GREENS GLOBAL" maxlength="60">
                        <label class="stamp-date-row" style="padding:10px 0 0;">
                            <input type="checkbox" id="csDateOn">
                            <span>Add date</span>
                            <input type="date" id="csDateVal" value="${today}">
                        </label>
                        <label class="stamp-date-row" style="padding:8px 0 0;">
                            <span>Stamp color</span>
                            <input type="color" id="csColor" value="${defaultColor}">
                        </label>
                        <label class="stamp-date-row" style="padding:10px 0 0;">
                            <input type="checkbox" id="csAllPages">
                            <span>Apply to all pages</span>
                        </label>
                    </div>
                    <div class="modal-footer">
                        <button class="crop-btn apply" data-act="ok">Add Stamp</button>
                        <button class="crop-btn cancel" data-act="cancel">Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const nameInput = overlay.querySelector('#csName');
            const input = overlay.querySelector('#csText');
            input.focus();
            const done = (val) => { overlay.remove(); resolve(val); };

            // "Approval stamp": fill the text with APPROVED — <name>, tick the
            // date, and set the color green. Remembers the name for next time.
            overlay.querySelector('#csApproval').addEventListener('click', () => {
                const nm = nameInput.value.trim();
                if (!nm) { nameInput.focus(); showToast('Enter your name first'); return; }
                try { localStorage.setItem(STAMP_NAME_KEY, nm); } catch { /* ignore */ }
                input.value = 'APPROVED — ' + nm;
                overlay.querySelector('#csDateOn').checked = true;
                overlay.querySelector('#csColor').value = '#1a7a3f';
            });

            const submit = () => {
                const text = input.value.trim();
                if (!text) { input.focus(); return; }
                const nm = nameInput.value.trim();
                if (nm) { try { localStorage.setItem(STAMP_NAME_KEY, nm); } catch { /* ignore */ } }
                let date = null;
                if (overlay.querySelector('#csDateOn').checked) {
                    const v = overlay.querySelector('#csDateVal').value;
                    const d = v ? new Date(v + 'T00:00:00') : new Date();
                    date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                }
                done({
                    text, date,
                    color: overlay.querySelector('#csColor').value,
                    allPages: overlay.querySelector('#csAllPages').checked,
                });
            };
            overlay.querySelector('[data-act="ok"]').addEventListener('click', submit);
            overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); done(null); }
            });
        });
    }

    // In-app text prompt (Electron does not support window.prompt()).
    // Returns a Promise resolving to the entered string, or null if cancelled.
    function customPrompt(message, placeholder = '', defaultValue = '') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.display = 'flex';
            overlay.innerHTML = `
                <div class="modal">
                    <div class="modal-header"><span>${message}</span></div>
                    <div class="modal-body">
                        <input type="text" class="modal-input" placeholder="${placeholder}">
                    </div>
                    <div class="modal-footer">
                        <button class="crop-btn apply" data-act="ok">OK</button>
                        <button class="crop-btn cancel" data-act="cancel">Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const input = overlay.querySelector('.modal-input');
            input.value = defaultValue;
            input.focus();

            const done = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(input.value.trim() || null));
            overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
                else if (e.key === 'Escape') { e.preventDefault(); done(null); }
            });
        });
    }

    async function addStamp(stampText) {
        if (!fabricCanvas) return;

        // Per-preset default colors (green = approved, red = warning, grey = draft).
        const PRESET_COLORS = {
            APPROVED: '#1a7a3f', DRAFT: '#6b7280', COPY: '#6b7280',
            FINAL: '#1d4ed8', VOID: '#d32f2f', CONFIDENTIAL: '#d32f2f',
        };
        let stampColor = PRESET_COLORS[stampText]
            || (document.getElementById('stampColor') || {}).value || '#d32f2f';
        let allPages = false;
        if (stampText === 'custom') {
            const res = await customStampDialog(stampColor);
            if (!res) return;
            stampText = res.text;
            if (res.date) stampText += '\n' + res.date;
            stampColor = res.color || stampColor;
            allPages = !!res.allPages;
        }

        // B1: a real stamp - a bordered badge placed at the center of the CURRENT
        // view, in the chosen color at full strength, upright, and immediately
        // selected with full move/scale/rotate handles so the user drags it into
        // place. (Was a fixed page-center 35deg translucent-grey watermark that
        // ignored the color swatch and had no handles.)
        const vw = fabricCanvas.getWidth(), vh = fabricCanvas.getHeight();
        // Size the stamp to the view, not the whole page: ~28% of view width.
        const fontSize = Math.max(22, Math.min(48, Math.round(vw * 0.05)));
        const label = new fabric.Text(stampText, {
            originX: 'center', originY: 'center',
            fontSize, fontFamily: 'Arial', fill: stampColor, fontWeight: 'bold',
            textAlign: 'center',
        });
        const padX = fontSize * 0.6, padY = fontSize * 0.35;
        const box = new fabric.Rect({
            originX: 'center', originY: 'center',
            width: label.width + padX * 2, height: label.height + padY * 2,
            rx: 6, ry: 6, fill: hexToRgba(stampColor, 0.08),
            stroke: stampColor, strokeWidth: Math.max(2, Math.round(fontSize / 12)),
        });
        const stamp = new fabric.Group([box, label], {
            left: vw / 2, top: vh / 2, originX: 'center', originY: 'center',
            selectable: true, hasControls: true, hasBorders: true, lockUniScaling: false,
        });
        stamp._isStamp = true;
        stamp.setControlsVisibility({ mtr: true });   // ensure the rotate handle shows
        const text = stamp;   // keep the downstream all-pages code working

        fabricCanvas.add(stamp);
        fabricCanvas.setActiveObject(stamp);
        fabricCanvas.renderAll();
        setActiveTool('select');
        setStatus('Stamp placed - drag to move, corner handles to resize, top handle to rotate');

        if (allPages && state.totalPages > 1) {
            // Persist the stamp onto every OTHER page's stored annotations. The
            // current page keeps its live object (saved on navigation); we clone
            // its serialized form (centred at each page's own dimensions) into
            // the rest so the stamp appears document-wide.
            saveCurrentAnnotations();
            const stampJson = text.toObject();
            for (let p = 1; p <= state.totalPages; p++) {
                if (p === state.currentPage) continue;
                if (!state.annotations[p]) state.annotations[p] = { fabricData: { objects: [] }, zoom: state.zoom };
                const fd = state.annotations[p].fabricData || (state.annotations[p].fabricData = { objects: [] });
                if (!fd.objects) fd.objects = [];
                // Centre on the stored page's canvas if we know it, else reuse coords.
                fd.objects.push({ ...stampJson });
            }
            showToast('Stamp added to all ' + state.totalPages + ' pages');
        } else {
            showToast('Stamp "' + stampText + '" added');
        }
    }

    // ── Split / Extract Pages ──
    function openSplitModal() {
        if (!state.pdfDoc) return;
        dom.splitTotal.textContent = state.totalPages;
        dom.splitRange.value = '';
        dom.splitModal.style.display = 'flex';
    }

    function closeSplitModal() {
        dom.splitModal.style.display = 'none';
    }

    function parsePageRange(rangeStr, totalPages) {
        const pages = new Set();
        const parts = rangeStr.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const rangeParts = trimmed.split('-');
            if (rangeParts.length === 1) {
                const num = parseInt(rangeParts[0], 10);
                if (num >= 1 && num <= totalPages) pages.add(num);
            } else if (rangeParts.length === 2) {
                const start = parseInt(rangeParts[0], 10);
                const end = parseInt(rangeParts[1], 10);
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                        pages.add(i);
                    }
                }
            }
        }
        return Array.from(pages).sort((a, b) => a - b);
    }

    async function splitPDF() {
        _exitScrollForOp();
        const rangeStr = dom.splitRange.value.trim();
        if (!rangeStr) {
            showToast('Please enter a page range');
            return;
        }

        const pageNumbers = parsePageRange(rangeStr, state.totalPages);
        if (pageNumbers.length === 0) {
            showToast('No valid pages in range');
            return;
        }

        setStatus('Extracting pages...');

        try {
            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const srcDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            const newDoc = await PDFLib.PDFDocument.create();

            const indices = pageNumbers.map((p) => p - 1);
            const copiedPages = await newDoc.copyPages(srcDoc, indices);
            copiedPages.forEach((page) => newDoc.addPage(page));

            const newBytes = await newDoc.save();
            const blob = new Blob([newBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.pdf$/i, '') + '_pages_' + rangeStr.replace(/\s/g, '') + '.pdf';
            a.click();
            URL.revokeObjectURL(url);

            closeSplitModal();
            setStatus('Pages extracted: ' + rangeStr);
            showToast(pageNumbers.length + ' page(s) extracted');
        } catch (err) {
            console.error(err);
            setStatus('Split failed: ' + err.message);
            showToast('Split failed');
        }
    }

    // ── Text Search ──
    let searchResults = [];
    let searchCurrentIdx = -1;
    let _searchCase = false;   // match case (S8)
    let _searchWord = false;   // whole word (S8)

    function toggleSearchBar() {
        const isVisible = dom.searchBar.style.display !== 'none';
        if (isVisible) {
            closeSearchBar();
        } else {
            dom.searchBar.style.display = 'flex';
            dom.searchInput.value = '';
            dom.searchInput.focus();
            dom.searchInfo.textContent = '0/0';
            clearSearchHighlights();
        }
    }

    function closeSearchBar() {
        dom.searchBar.style.display = 'none';
        const rp = document.getElementById('searchResultsPanel');
        if (rp) rp.style.display = 'none';
        clearSearchHighlights();
        searchResults = [];
        searchCurrentIdx = -1;
        dom.searchInfo.textContent = '0/0';
        // Clear the "N result(s) found" status so it doesn't linger (B11).
        setStatus('Ready');
    }

    function clearSearchHighlights() {
        document.querySelectorAll('.search-highlight').forEach((el) => el.remove());
    }

    let _searchGen = 0;
    async function searchText() {
        const gen = ++_searchGen;
        const rawQuery = dom.searchInput.value.trim();
        const query = _searchCase ? rawQuery : rawQuery.toLowerCase();
        searchResults = [];
        searchCurrentIdx = -1;
        clearSearchHighlights();

        if (!query || !state.pdfDoc) {
            dom.searchInfo.textContent = '0/0';
            return;
        }

        setStatus('Searching...');

        // Search every page in the document. Use the PDF's own page count
        // (pdfDoc.numPages) rather than state.totalPages, which can lag behind
        // the loaded document and would silently limit the scan to fewer pages.
        const pageCount = (state.pdfDoc && state.pdfDoc.numPages) || state.totalPages;
        let jumped = false;
        for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
            const page = await state.pdfDoc.getPage(pageNum);
            const textContent = await page.getTextContent();
            if (gen !== _searchGen) return; // a newer search superseded us

            const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
            textContent.items.forEach((item, idx) => {
                const raw = item.str;
                const text = _searchCase ? raw : raw.toLowerCase();
                let startIdx = 0;
                while ((startIdx = text.indexOf(query, startIdx)) !== -1) {
                    // Whole-word: require non-word boundaries around the match (S8).
                    const before = startIdx > 0 ? text[startIdx - 1] : '';
                    const after = text[startIdx + query.length] || '';
                    const wordOk = !_searchWord || (!isWordChar(before) && !isWordChar(after));
                    if (wordOk) {
                        // Snippet with a little context for the results list.
                        const s = Math.max(0, startIdx - 20), e = Math.min(raw.length, startIdx + query.length + 20);
                        searchResults.push({
                            page: pageNum, itemIndex: idx, item,
                            matchStart: startIdx, matchLength: query.length,
                            snippet: (s > 0 ? '…' : '') + raw.slice(s, e) + (e < raw.length ? '…' : ''),
                        });
                    }
                    startIdx += query.length;
                }
            });
            // Live feedback on long documents: update the counter as pages scan,
            // and jump to the first hit the moment it's found (don't wait for the
            // whole document). Trailing '+' shows the scan is still running.
            if (searchResults.length) {
                if (!jumped) { searchCurrentIdx = 0; await goToSearchResult(0); jumped = true; }
                if (pageNum < pageCount) dom.searchInfo.textContent = (searchCurrentIdx + 1) + '/' + searchResults.length + '+';
            }
        }

        if (searchResults.length > 0) {
            // Final count (drop the trailing '+' now the whole doc is scanned).
            dom.searchInfo.textContent = (searchCurrentIdx + 1) + '/' + searchResults.length;
            if (!jumped) { searchCurrentIdx = 0; await goToSearchResult(0); }
        } else {
            dom.searchInfo.textContent = '0/0';
            // Distinguish "no match" from "no text at all" (scanned pages)
            try {
                const p1 = await state.pdfDoc.getPage(state.currentPage);
                const tc = await p1.getTextContent();
                if (!tc.items.some(it => it.str && it.str.trim())) {
                    setStatus('No selectable text on this page — it looks scanned. Run Scan & OCR first, then search.');
                    showToast('Scanned PDF — run Scan & OCR to make it searchable');
                    return;
                }
            } catch (_) {}
        }

        setStatus(searchResults.length ? searchResults.length + ' result(s) found'
                                       : 'No matches for "' + query + '"');
        // Keep the results list in sync if it's open (S8).
        const rp = document.getElementById('searchResultsPanel');
        if (rp && rp.style.display !== 'none') _renderSearchResults();
    }

    // Results list grouped by page, each row jumps to that hit (S8).
    function _renderSearchResults() {
        const panel = document.getElementById('searchResultsPanel');
        if (!panel) return;
        if (!searchResults.length) {
            panel.innerHTML = '<div class="sr-empty">No results.</div>';
            return;
        }
        const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => (
            { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
        let html = '';
        let lastPage = null;
        searchResults.forEach((r, i) => {
            if (r.page !== lastPage) {
                const n = searchResults.filter(x => x.page === r.page).length;
                html += `<div class="sr-page">Page ${r.page} · ${n} hit${n > 1 ? 's' : ''}</div>`;
                lastPage = r.page;
            }
            const snip = escH(r.snippet || '');
            html += `<div class="sr-row${i === searchCurrentIdx ? ' active' : ''}" data-i="${i}">${snip}</div>`;
        });
        panel.innerHTML = html;
        panel.querySelectorAll('.sr-row[data-i]').forEach((row) => {
            row.addEventListener('click', async () => {
                const i = parseInt(row.getAttribute('data-i'), 10);
                searchCurrentIdx = i;
                dom.searchInfo.textContent = (i + 1) + '/' + searchResults.length;
                await goToSearchResult(i);
                _renderSearchResults();
            });
        });
    }

    async function navigateSearch(direction) {
        if (searchResults.length === 0) return;
        searchCurrentIdx = (searchCurrentIdx + direction + searchResults.length) % searchResults.length;
        dom.searchInfo.textContent = (searchCurrentIdx + 1) + '/' + searchResults.length;
        await goToSearchResult(searchCurrentIdx);
    }

    async function goToSearchResult(idx) {
        const result = searchResults[idx];
        if (!result) return;

        // Search highlights are drawn on the single-page (edit) canvas, which is
        // hidden in continuous-scroll mode. Since PDFs open in scroll mode by
        // default, jumping to a result must first switch to edit mode on that
        // page so the highlight is actually visible.
        if (window.isScrollMode && window.isScrollMode()) {
            state.currentPage = result.page;
            setScrollMode(false);           // shows the single-page canvas
            await renderPage(result.page);  // await so highlights land on the drawn page
        } else if (state.currentPage !== result.page) {
            saveCurrentAnnotations();
            await renderPage(result.page);
        }
        await drawPageSearchHighlights();

        // Scroll active highlight into view
        const activeHighlight = dom.canvasWrapper.querySelector('.search-highlight.active');
        if (activeHighlight) {
            activeHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // Draw highlight boxes for every match on the CURRENT page. Called from
    // navigation AND after re-renders (zoom, page ops) so boxes never vanish
    // or drift while the search bar is open.
    async function drawPageSearchHighlights() {
        clearSearchHighlights();
        if (!searchResults.length) return;
        const pageResults = searchResults.filter((r) => r.page === state.currentPage);

        const page = await state.pdfDoc.getPage(state.currentPage);
        // Use viewport at display scale (zoom only, not retina multiplied)
        const viewport = page.getViewport({ scale: state.zoom });

        // Measure substring positions with a real text measurer, normalized
        // against the item's true width — accurate on proportional fonts
        // (the old uniform char-width estimate drifted mid-sentence).
        if (!window.__searchMeasureCtx) window.__searchMeasureCtx = document.createElement('canvas').getContext('2d');
        const mctx = window.__searchMeasureCtx;

        for (const res of pageResults) {
            const item = res.item;
            const tx = item.transform;
            const fontSize = Math.hypot(tx[2], tx[3]) || 12;
            mctx.font = fontSize + 'px Helvetica, Arial, sans-serif';
            const fullW = Math.max(1, mctx.measureText(item.str).width);
            const preW  = mctx.measureText(item.str.slice(0, res.matchStart)).width;
            const midW  = Math.max(2, mctx.measureText(item.str.substr(res.matchStart, res.matchLength)).width);
            // Normalize measured proportions onto the item's REAL PDF width
            const offsetX = (preW / fullW) * item.width;
            const matchWidth = (midW / fullW) * item.width;
            const height = item.height || Math.abs(tx[3]) || 12;

            // PDF coordinates (bottom-left origin). tx[5] is the BASELINE —
            // the glyphs sit ABOVE it (ascent) with a small descender below.
            const pdfX = tx[4] + offsetX;
            const yTop = tx[5] + height * 0.86;    // above baseline (cap height)
            const yBot = tx[5] - height * 0.22;    // below baseline (descender)

            // Convert to viewport coordinates (top-left origin, scaled)
            const [vx1, vy1] = viewport.convertToViewportPoint(pdfX, yTop);
            const [vx2, vy2] = viewport.convertToViewportPoint(pdfX + matchWidth, yBot);

            const left = Math.min(vx1, vx2);
            const top = Math.min(vy1, vy2);
            const width = Math.abs(vx2 - vx1);
            const hHeight = Math.abs(vy2 - vy1);

            const highlight = document.createElement('div');
            highlight.className = 'search-highlight';
            if (res === searchResults[searchCurrentIdx]) {
                highlight.classList.add('active');
            }

            highlight.style.left = left + 'px';
            highlight.style.top = top + 'px';
            highlight.style.width = Math.max(width, 4) + 'px';
            highlight.style.height = Math.max(hHeight, 4) + 'px';

            dom.canvasWrapper.appendChild(highlight);
        }
    }

    // ── OCR (Make Searchable PDF) ──
    let ocrWorker = null;
    let ocrCancelled = false;

    let _ocrRunning = false;
    async function runOCR() {
        _exitScrollForOp();
        if (!state.pdfDoc || !state.pdfBytes || _ocrRunning) return;
        _ocrRunning = true;
        dom.ocrBtn.disabled = true; // before the modal — no double-launch

        // Language choice — English and Hindi are bundled (fully offline).
        const langPick = await _toolModal('Scan & OCR', `
            <label class="modal-label">Document language:</label>
            <select class="modal-input" data-k="lang">
                <option value="eng">English</option>
                <option value="hin">Hindi (हिन्दी)</option>
                <option value="eng+hin">English + Hindi (mixed)</option>
            </select>
            <p class="modal-hint" style="margin-top:8px;">OCR makes scanned pages searchable and selectable. Mixed mode is slower but handles documents using both languages.</p>`, 'Run OCR');
        if (!langPick) { _ocrRunning = false; dom.ocrBtn.disabled = false; return; }
        const ocrLang = langPick.lang || 'eng';

        ocrCancelled = false;
        dom.ocrProgress.style.display = 'flex';
        dom.ocrStatus.textContent = 'Loading OCR engine...';
        dom.ocrProgressBar.style.width = '0%';
        dom.ocrBtn.disabled = true;

        try {
            // OCR engine is BUNDLED — fully offline (CDN only as last resort)
            if (!window.Tesseract) {
                try {
                    await loadScript('libs/tesseract/tesseract.min.js')
                        .catch(() => loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js'));
                } catch (e) {
                    dom.ocrProgress.style.display = 'none';
                    dom.ocrBtn.disabled = false;
            _ocrRunning = false;
                    setStatus('OCR failed: could not load OCR engine');
                    showToast('Could not start the OCR engine');
                    return;
                }
            }

            dom.ocrStatus.textContent = 'Initializing OCR...';

            // Point the worker at the bundled engine/wasm/language files so
            // OCR runs with zero network access.
            // In packaged builds the OCR files live OUTSIDE the asar archive
            // (workers/wasm can't always load from inside it).
            const tessBase = new URL('libs/tesseract/', location.href).href
                .replace('app.asar/', 'app.asar.unpacked/');
            // corePath must be the DIRECTORY: the worker appends
            // "/tesseract-core-simd.wasm.js" or "/tesseract-core.wasm.js" to it
            // itself (based on SIMD detection). Passing the full .js filename made
            // it build ".../tesseract-core-simd.wasm.js/tesseract-core-simd.wasm.js"
            // → 404 → OCR silently stalled at "Initializing" in the browser.
            const worker = await Tesseract.createWorker({
                workerPath: tessBase + 'worker.min.js',
                corePath: tessBase,
                langPath: tessBase,
                gzip: true,
                logger: (m) => {
                    if (m.status === 'recognizing text' && m.progress) {
                        // Update sub-progress within current page
                    }
                },
            });
            await worker.loadLanguage(ocrLang);
            await worker.initialize(ocrLang);
            ocrWorker = worker;

            // Load PDF with pdf-lib for text embedding
            const bytesToLoad = state.pdfBytes instanceof ArrayBuffer
                ? new Uint8Array(state.pdfBytes)
                : state.pdfBytes;
            const pdfLibDoc = await PDFLib.PDFDocument.load(bytesToLoad, { ignoreEncryption: true });
            const pages = pdfLibDoc.getPages();
            const totalPages = pages.length;

            for (let i = 0; i < totalPages; i++) {
                if (ocrCancelled) break;

                const pageNum = i + 1;
                dom.ocrStatus.textContent = 'OCR page ' + pageNum + ' of ' + totalPages + '...';
                dom.ocrProgressBar.style.width = ((i / totalPages) * 100) + '%';

                // Render page to canvas at higher resolution for better OCR
                const pdfPage = await state.pdfDoc.getPage(pageNum);
                const viewport = pdfPage.getViewport({ scale: 2 });
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = viewport.width;
                tempCanvas.height = viewport.height;
                const ctx = tempCanvas.getContext('2d');
                await pdfPage.render({ canvasContext: ctx, viewport }).promise;

                // Run OCR on the rendered page
                const { data } = await worker.recognize(tempCanvas);

                // Add invisible text layer to the PDF page
                const pdfLibPage = pages[i];
                const { width: pageWidth, height: pageHeight } = pdfLibPage.getSize();
                const scaleX = pageWidth / viewport.width;
                const scaleY = pageHeight / viewport.height;

                let _ocrSkipped = 0, _ocrTotal = 0;
                for (const word of data.words) {
                    if (ocrCancelled) break;
                    if (!word.text.trim()) continue;
                    _ocrTotal++;

                    const x = word.bbox.x0 * scaleX;
                    const y = pageHeight - (word.bbox.y1 * scaleY);
                    const fontSize = (word.bbox.y1 - word.bbox.y0) * scaleY * 0.8;

                    if (fontSize < 2) continue;

                    try {
                        pdfLibPage.drawText(_winAnsi(word.text), {
                            x: x,
                            y: y,
                            size: Math.max(fontSize, 4),
                            color: PDFLib.rgb(0, 0, 0),
                            opacity: 0,
                        });
                    } catch (_) { _ocrSkipped++; /* a single unencodable word must not sink OCR */ }
                }
                if (_ocrTotal && _ocrSkipped / _ocrTotal > 0.4) {
                    showToast('Note: much of the recognized text uses a non-Latin script and could not be embedded as searchable text');
                }
            }

            if (!ocrCancelled) {
                // Save the searchable PDF
                const newBytes = await pdfLibDoc.save();
                state.pdfBytes = newBytes.slice().buffer;

                // Reload into PDF.js
                const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
                if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} }
                state.pdfDoc = pdf;
                // Keep totalPages in sync with the reloaded doc — the search loop
                // iterates 1..totalPages, so a stale value would limit search to
                // fewer pages (this is why search only covered the current page).
                state.totalPages = pdf.numPages;
                if (dom.totalPages) dom.totalPages.textContent = state.totalPages;

                dom.ocrProgressBar.style.width = '100%';
                dom.ocrStatus.textContent = 'OCR complete!';
                showToast('PDF is now searchable');
                setStatus('OCR completed - PDF is now searchable');

                // Re-render current page
                renderPage(state.currentPage);

                setTimeout(() => {
                    dom.ocrProgress.style.display = 'none';
                }, 2000);
            } else {
                dom.ocrProgress.style.display = 'none';
                showToast('OCR cancelled');
                setStatus('OCR cancelled');
            }

            try { await worker.terminate(); } catch (_) { /* already terminated by cancel */ }
            ocrWorker = null;
        } catch (err) {
            console.error(err);
            dom.ocrProgress.style.display = 'none';
            setStatus('OCR failed: ' + err.message);
            showToast('OCR failed: ' + err.message);
            if (ocrWorker) {
                try { await ocrWorker.terminate(); } catch (e) { /* ignore */ }
                ocrWorker = null;
            }
        } finally {
            // Always clear the re-entry guard, or OCR is bricked after the first
            // run for the life of the document (the button looks enabled but the
            // guard at the top silently returns).
            _ocrRunning = false;
            dom.ocrBtn.disabled = false;
        }
    }

    async function cancelOCR() {
        ocrCancelled = true;
        _ocrRunning = false;
        if (ocrWorker) {
            try { await ocrWorker.terminate(); } catch (e) { /* ignore */ }
            ocrWorker = null;
        }
        dom.ocrProgress.style.display = 'none';
        dom.ocrBtn.disabled = false;
    }

    // ═══════════════════════════════════════════════════
    //  DOCUMENT TOOLS — watermark, page numbers, compress, forms
    // ═══════════════════════════════════════════════════
    async function _reloadFromBytes(newBytes, msg, skipSave) {
        markDirty();
        if (!skipSave) saveCurrentAnnotations(); // keep markups on the visible page
        if (state.pdfDoc && state.pdfDoc.destroy) { try { state.pdfDoc.destroy(); } catch (_) {} } // L4: free worker memory
        // The page set changed - drop any hidden continuous view so it rebuilds
        // fresh next time (pages are kept hidden between edits, not destroyed).
        if (typeof destroyScrollView === 'function') destroyScrollView();
        _savedScrollTop = null;
        state.pdfBytes = newBytes.slice().buffer;
        const pdf = await pdfjsLib.getDocument({ data: newBytes.slice(), fontExtraProperties: true }).promise;
        state.pdfDoc = pdf;
        state.totalPages = pdf.numPages;
        dom.totalPages.textContent = state.totalPages;
        dom.pageInput.max = state.totalPages;
        dom.fileInfo.textContent = `${state.fileName} | ${state.totalPages} page(s)`;
        await generateThumbnails();
        renderPage(Math.min(state.currentPage, state.totalPages));
        if (msg) { setStatus(msg); showToast(msg); }
    }

    function _toolModal(title, bodyHtml, applyLabel, onRender) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.display = 'flex';
            overlay.innerHTML = `
                <div class="modal">
                    <div class="modal-header"><span>${title}</span></div>
                    <div class="modal-body">${bodyHtml}</div>
                    <div class="modal-footer">
                        <button class="crop-btn apply" data-act="ok">${applyLabel}</button>
                        <button class="crop-btn cancel" data-act="cancel">Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            // Optional hook to wire up dynamic fields (e.g. show a range input
            // only when a certain option is picked). Runs after the DOM exists.
            if (typeof onRender === 'function') {
                try { onRender(overlay); } catch (_) {}
            }
            const done = (ok) => { const vals = {}; overlay.querySelectorAll('[data-k]').forEach(el2 => {
                vals[el2.dataset.k] = el2.type === 'checkbox' ? el2.checked : el2.value; });
                overlay.remove(); resolve(ok ? vals : null); };
            overlay.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
            overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
            // Keyboard: Escape cancels, Enter confirms; focus the first field
            overlay.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.preventDefault(); done(false); }
                // Enter submits - except from a textarea or a <select> (M30: Enter
                // on a dropdown was submitting the Set Scale dialog).
                else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') { e.preventDefault(); done(true); }
            });
            const first = overlay.querySelector('input, select, textarea');
            if (first) first.focus();
        });
    }

    // A simple choice modal: a prompt + N buttons. Resolves the chosen button's
    // `key`, or null if cancelled (x / Escape / backdrop). The first option is
    // styled as the primary action.
    function _choiceModal(title, message, options) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.display = 'flex';
            const btns = options.map((o, i) =>
                `<button class="crop-btn ${i === 0 ? 'apply' : ''}" data-choice="${o.key}">${o.label}</button>`
            ).join('');
            overlay.innerHTML = `
                <div class="modal">
                    <div class="modal-header"><span>${title}</span></div>
                    <div class="modal-body"><p style="margin:0;font-size:13.5px;line-height:1.5;">${message}</p></div>
                    <div class="modal-footer">
                        ${btns}
                        <button class="crop-btn cancel" data-choice="">Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const done = (key) => { overlay.remove(); resolve(key || null); };
            overlay.querySelectorAll('[data-choice]').forEach(b =>
                b.addEventListener('click', () => done(b.dataset.choice)));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(''); });
            overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(''); } });
        });
    }

    // ── Watermark: text across every page ──
    async function addWatermarkTool() {
        _exitScrollForOp();
        if (!state.pdfBytes) { showToast('Open a PDF first'); return; }
        const v = await _toolModal('Add watermark', `
            <label class="modal-label">Watermark text:</label>
            <input type="text" class="modal-input" data-k="text" value="CONFIDENTIAL" maxlength="60">
            <!-- Live preview (S3) -->
            <div style="margin-top:10px;height:70px;border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f4f4f6 0% 25%, #fff 0% 50%) 50% / 16px 16px;">
                <span id="wmPreview" style="font-weight:700;font-family:Arial;white-space:nowrap;">CONFIDENTIAL</span>
            </div>
            <label class="modal-label" style="margin-top:10px;">Apply to:</label>
            <select class="modal-input" data-k="scope">
                <option value="all">All pages</option>
                <option value="current">Current page only (page ${state.currentPage})</option>
                <option value="range">Specific pages...</option>
            </select>
            <input type="text" class="modal-input" data-k="range" placeholder="e.g. 1-3, 5, 8" style="margin-top:6px;display:none;">
            <label class="stamp-date-row" style="padding:10px 0 0;"><span>Color</span>
                <input type="color" data-k="color" value="#9e9e9e"></label>
            <label class="stamp-date-row" style="padding:8px 0 0;"><span>Opacity</span>
                <input type="range" data-k="op" min="5" max="100" value="18" style="flex:1;"><span id="wmOpVal" style="width:38px;text-align:right;">18%</span></label>
            <label class="stamp-date-row" style="padding:8px 0 0;"><span>Rotation</span>
                <input type="range" data-k="angle" min="-90" max="90" value="45" style="flex:1;"><span id="wmAngVal" style="width:42px;text-align:right;">45&deg;</span></label>
            <label class="stamp-date-row" style="padding:8px 0 0;"><span>Size</span>
                <select class="modal-input" data-k="sizeMode" style="flex:1;">
                    <option value="fit">Fit to page (large)</option>
                    <option value="med">Medium</option>
                    <option value="small">Small (footer style)</option>
                </select></label>`, 'Add Watermark',
            (root) => {
                const sc = root.querySelector('[data-k="scope"]');
                const rg = root.querySelector('[data-k="range"]');
                if (sc && rg) sc.addEventListener('change', () => { rg.style.display = sc.value === 'range' ? 'block' : 'none'; });
                // Live preview wiring (S3).
                const pv = root.querySelector('#wmPreview');
                const txt = root.querySelector('[data-k="text"]');
                const col = root.querySelector('[data-k="color"]');
                const op = root.querySelector('[data-k="op"]');
                const ang = root.querySelector('[data-k="angle"]');
                const opVal = root.querySelector('#wmOpVal');
                const angVal = root.querySelector('#wmAngVal');
                const refresh = () => {
                    if (!pv) return;
                    pv.textContent = txt.value || 'CONFIDENTIAL';
                    pv.style.color = col.value;
                    pv.style.opacity = (parseInt(op.value, 10) / 100).toFixed(2);
                    pv.style.transform = 'rotate(' + (-parseInt(ang.value, 10)) + 'deg)';
                    if (opVal) opVal.textContent = op.value + '%';
                    if (angVal) angVal.innerHTML = ang.value + '&deg;';
                };
                [txt, col, op, ang].forEach(el => { el.addEventListener('input', refresh); });
                refresh();
            });
        if (!v || !v.text.trim()) return;

        // Resolve which page indexes (0-based) get the watermark.
        const pageCount = state.totalPages;
        let targetIdx;
        if (v.scope === 'current') {
            targetIdx = new Set([state.currentPage - 1]);
        } else if (v.scope === 'range') {
            targetIdx = _parsePageRange(v.range, pageCount);
            if (!targetIdx.size) { showToast('Enter valid page numbers (e.g. 1-3, 5)'); return; }
        } else {
            targetIdx = new Set(Array.from({ length: pageCount }, (_, i) => i));
        }

        pushDocSnapshot('Watermark');
        setStatus('Adding watermark...');
        try {
            const doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const c = hexToRgb(v.color);
            const text = _winAnsi(v.text.trim());
            const pages = doc.getPages();
            const angDeg = Math.max(-90, Math.min(90, parseInt(v.angle, 10) || 0));
            const ang = angDeg * Math.PI / 180;
            const sizeFrac = v.sizeMode === 'small' ? 0.28 : v.sizeMode === 'med' ? 0.45 : 0.62;
            for (let pi = 0; pi < pages.length; pi++) {
                if (!targetIdx.has(pi)) continue;
                const page = pages[pi];
                const { width, height } = page.getSize();
                const target = Math.hypot(width, height) * sizeFrac;
                const size = Math.max(12, Math.min(200, target / Math.max(1, font.widthOfTextAtSize(text, 100) / 100)));
                const tw = font.widthOfTextAtSize(text, size);
                const cx = width / 2, cy = height / 2;
                page.drawText(text, {
                    x: cx - (tw / 2) * Math.cos(ang), y: cy - (tw / 2) * Math.sin(ang) - size * 0.36,
                    size, font,
                    color: PDFLib.rgb(c.r / 255, c.g / 255, c.b / 255),
                    opacity: Math.max(0.05, Math.min(1, parseInt(v.op, 10) / 100)),
                    rotate: PDFLib.degrees(angDeg),
                });
            }
            const n = targetIdx.size;
            const where = v.scope === 'all' ? 'all pages'
                        : n === 1 ? '1 page' : n + ' pages';
            await _reloadFromBytes(await doc.save(), 'Watermark added to ' + where);
        } catch (err) { console.error(err); showToast('Watermark failed'); }
    }

    // Parse a page-range string like "1-3, 5, 8" into a Set of 0-based indexes,
    // clamped to [0, count). Ignores junk; returns an empty set if nothing valid.
    function _parsePageRange(str, count) {
        const out = new Set();
        for (const part of String(str || '').split(',')) {
            const s = part.trim();
            if (!s) continue;
            const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) {
                let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
                if (a > b) [a, b] = [b, a];
                for (let p = a; p <= b; p++) if (p >= 1 && p <= count) out.add(p - 1);
            } else if (/^\d+$/.test(s)) {
                const p = parseInt(s, 10);
                if (p >= 1 && p <= count) out.add(p - 1);
            }
        }
        return out;
    }

    // ── Page numbers ──
    async function addPageNumbersTool() {
        _exitScrollForOp();
        if (!state.pdfBytes) { showToast('Open a PDF first'); return; }
        const v = await _toolModal('Add page numbers', `
            <label class="modal-label">Position:</label>
            <select class="modal-input" data-k="pos">
                <option value="bc">Bottom center</option>
                <option value="br">Bottom right</option>
                <option value="bl">Bottom left</option>
                <option value="tr">Top right</option>
                <option value="tc">Top center</option>
            </select>
            <label class="modal-label" style="margin-top:10px;">Format:</label>
            <select class="modal-input" data-k="fmt">
                <option value="n">1</option>
                <option value="pn">Page 1</option>
                <option value="nn">1 / ${state.totalPages}</option>
                <option value="pnofn">Page 1 of ${state.totalPages}</option>
            </select>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;">
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Start at
                    <input type="number" class="modal-input" data-k="start" value="1" min="0" max="9999" style="width:80px;">
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Font size
                    <input type="number" class="modal-input" data-k="size" value="10" min="6" max="48" style="width:80px;">
                </label>
                <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;">Margin (pt)
                    <input type="number" class="modal-input" data-k="margin" value="24" min="4" max="120" style="width:80px;">
                </label>
            </div>
            <label class="modal-label" style="margin-top:10px;">Apply to pages:</label>
            <select class="modal-input" data-k="scope">
                <option value="all">All pages</option>
                <option value="skipfirst">All except the first page</option>
                <option value="range">A range...</option>
            </select>
            <input type="text" class="modal-input" data-k="range" placeholder="e.g. 2-10, 12" style="margin-top:6px;display:none;">`,
            'Add Numbers', (overlay) => {
                const scopeSel = overlay.querySelector('[data-k="scope"]');
                const rangeInp = overlay.querySelector('[data-k="range"]');
                scopeSel && scopeSel.addEventListener('change', () => {
                    rangeInp.style.display = scopeSel.value === 'range' ? 'block' : 'none';
                });
            });
        if (!v) return;
        pushDocSnapshot('Page numbers');
        setStatus('Adding page numbers...');
        try {
            const doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
            const pages = doc.getPages();
            const start = parseInt(v.start, 10); const startN = Number.isFinite(start) ? start : 1;
            const size = Math.max(6, Math.min(48, parseInt(v.size, 10) || 10));
            const margin = Math.max(4, Math.min(120, parseInt(v.margin, 10) || 24));
            // Which pages get a number (1-based indices).
            const include = new Set();
            if (v.scope === 'range') { parsePageRange(v.range, pages.length).forEach(p => include.add(p)); }
            else { for (let p = 1; p <= pages.length; p++) if (!(v.scope === 'skipfirst' && p === 1)) include.add(p); }
            const total = include.size;
            let seq = 0;
            pages.forEach((page, i) => {
                const pageNo = i + 1;
                if (!include.has(pageNo)) return;
                seq++;
                const n = startN + seq - 1;
                const label = v.fmt === 'pn' ? 'Page ' + n
                    : v.fmt === 'nn' ? n + ' / ' + (startN + total - 1)
                    : v.fmt === 'pnofn' ? 'Page ' + n + ' of ' + (startN + total - 1)
                    : String(n);
                const { width, height } = page.getSize();
                const tw = font.widthOfTextAtSize(label, size);
                const x = /c$/.test(v.pos) ? (width - tw) / 2 : /l$/.test(v.pos) ? margin : width - tw - margin;
                const y = v.pos.startsWith('t') ? height - margin : Math.max(8, margin - 8);
                page.drawText(label, { x, y, size, font, color: PDFLib.rgb(0.25, 0.25, 0.28) });
            });
            await _reloadFromBytes(await doc.save(), 'Page numbers added to ' + total + ' page' + (total > 1 ? 's' : ''));
        } catch (err) { console.error(err); showToast('Page numbers failed'); }
    }

    // ── Compress ──
    async function compressPdfTool() {
        if (!state.pdfBytes) { showToast('Open a PDF first'); return; }
        const beforeMB = ((state.pdfBytes.byteLength || state.pdfBytes.length) / 1048576).toFixed(1);
        const v = await _toolModal('Compress PDF', `
            <p class="modal-hint" style="margin:0 0 10px;">Current size: <b>${beforeMB} MB</b>. Save your markups first — compression works on the saved document content.</p>
            <label class="modal-label">Compression level:</label>
            <select class="modal-input" data-k="level">
                <option value="light">Light — keeps text selectable (small gain)</option>
                <option value="strong" selected>Strong — pages become images (big gain)</option>
                <option value="extreme">Extreme — smallest file, lower quality</option>
            </select>`, 'Compress & Save');
        if (!v) return;
        setStatus('Compressing...');
        try {
            let outBytes;
            if (v.level === 'light') {
                const doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
                outBytes = await doc.save({ useObjectStreams: true });
            } else {
                const scale = v.level === 'extreme' ? 1.0 : 1.5;
                const q = v.level === 'extreme' ? 0.38 : 0.6;
                const out = await PDFLib.PDFDocument.create();
                for (let i = 1; i <= state.totalPages; i++) {
                    setStatus('Compressing page ' + i + '/' + state.totalPages + '...');
                    const page = await state.pdfDoc.getPage(i);
                    const vp = page.getViewport({ scale });
                    const canvas = document.createElement('canvas');
                    canvas.width = vp.width; canvas.height = vp.height;
                    const cx2 = canvas.getContext('2d');
                    cx2.fillStyle = '#ffffff'; cx2.fillRect(0, 0, canvas.width, canvas.height);
                    await page.render({ canvasContext: cx2, viewport: vp }).promise;
                    const jpg = await out.embedJpg(canvas.toDataURL('image/jpeg', q));
                    // Use the ROTATION-AWARE render size so /Rotate pages keep
                    // their true orientation instead of being squashed.
                    const pw = vp.width / scale, ph = vp.height / scale;
                    const p = out.addPage([pw, ph]);
                    p.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
                }
                outBytes = await out.save();
            }
            const afterMB = (outBytes.length / 1048576).toFixed(1);
            // Apply in the editor (like the other tools) so the user can review
            // the result and Save when ready, instead of a forced download.
            await _reloadFromBytes(outBytes, 'Compressed ' + beforeMB + ' MB -> ' + afterMB + ' MB - Save when ready');
            showToast('Compressed ' + beforeMB + ' MB -> ' + afterMB + ' MB');
        } catch (err) { console.error(err); showToast('Compression failed'); }
    }

    // ── Form filling (AcroForm) ──
    async function fillFormsTool() {
        if (!state.pdfBytes) { showToast('Open a PDF first'); return; }
        let doc, fields;
        try {
            doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            fields = doc.getForm().getFields();
        } catch (_) { fields = []; }
        if (!fields.length) { showToast('This PDF has no fillable form fields'); return; }
        let body = '<p class="modal-hint" style="margin:0 0 10px;">' + fields.length + ' field(s) found:</p>';
        fields.forEach((f, i) => {
            const name = f.getName();
            const t = f.constructor.name;
            const esc = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            if (t === 'PDFTextField') {
                let cur = ''; try { cur = f.getText() || ''; } catch (_) {}
                const curEsc = cur.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
                body += `<label class="modal-label" style="margin-top:8px;">${esc}</label>
                         <input type="text" class="modal-input" data-k="f${i}" value="${curEsc}">`;
            } else if (t === 'PDFCheckBox') {
                let cur = false; try { cur = f.isChecked(); } catch (_) {}
                body += `<label class="stamp-date-row" style="padding:8px 0 0;">
                         <input type="checkbox" data-k="f${i}" ${cur ? 'checked' : ''}><span>${esc}</span></label>`;
            } else if (t === 'PDFDropdown' || t === 'PDFRadioGroup') {
                let opts = []; try { opts = f.getOptions(); } catch (_) {}
                let sel = ''; try { sel = (t === 'PDFDropdown' ? f.getSelected()[0] : f.getSelected()) || ''; } catch (_) {}
                body += `<label class="modal-label" style="margin-top:8px;">${esc}</label>
                         <select class="modal-input" data-k="f${i}"><option value=""></option>` +
                        opts.map(o => `<option ${o === sel ? 'selected' : ''}>${o.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`).join('') + '</select>';
            }
        });
        const v = await _toolModal('Fill form fields', body, 'Apply to PDF');
        if (!v) return;
        setStatus('Filling form...');
        try {
            fields.forEach((f, i) => {
                const val = v['f' + i];
                if (val === undefined) return;
                const t = f.constructor.name;
                try {
                    if (t === 'PDFTextField') f.setText(String(val));
                    else if (t === 'PDFCheckBox') { if (val) f.check(); else f.uncheck(); }
                    else if (t === 'PDFDropdown') { if (val) f.select(String(val)); }
                    else if (t === 'PDFRadioGroup') { if (val) f.select(String(val)); }
                } catch (e) { console.warn('field', f.getName(), e); }
            });
            try { doc.getForm().updateFieldAppearances(); } catch (_) {}
            await _reloadFromBytes(await doc.save(), 'Form filled');
        } catch (err) { console.error(err); showToast('Form filling failed'); }
    }

    // ── Save Flattened: rasterize every page into an uneditable PDF ──
    async function saveFlattened() {
        if (!state.pdfDoc) return;
        setStatus('Flattening document...');
        try {
            saveCurrentAnnotations();
            const out = await PDFLib.PDFDocument.create();
            for (let p = 1; p <= state.totalPages; p++) {
                setStatus('Flattening page ' + p + '/' + state.totalPages + '...');
                const pg = await state.pdfDoc.getPage(p);
                const vp = pg.getViewport({ scale: 2 });
                const cnv = document.createElement('canvas');
                cnv.width = vp.width; cnv.height = vp.height;
                const c2 = cnv.getContext('2d');
                c2.fillStyle = '#fff'; c2.fillRect(0, 0, cnv.width, cnv.height);
                await pg.render({ canvasContext: c2, viewport: vp }).promise;
                const entry = state.annotations[p];
                const objs = entry && (entry.fabricData || entry).objects;
                if (objs && objs.length) {
                    const f = vp.width / pg.getViewport({ scale: entry.zoom || 1 }).width;
                    const live = new Set(state.layers.map(l => l.id));
                    const hidden = new Set(state.layers.filter(l => !l.visible).map(l => l.id));
                    const use = objs.filter(o => !(o._layerId !== undefined && (hidden.has(o._layerId) || !live.has(o._layerId))));
                    if (use.length) {
                        const insts = await new Promise((res) => fabric.util.enlivenObjects(use, res));
                        const tmp = new fabric.StaticCanvas(null, { width: cnv.width, height: cnv.height });
                        tmp.setZoom(f);
                        insts.forEach(o => { if (o) tmp.add(o); });
                        tmp.renderAll();
                        c2.drawImage(tmp.lowerCanvasEl, 0, 0, cnv.width, cnv.height);
                    }
                }
                const jpg = await out.embedJpg(cnv.toDataURL('image/jpeg', 0.9));
                const [x0, y0, x1, y1] = pg.view;
                const np = out.addPage([x1 - x0, y1 - y0]);
                np.drawImage(jpg, { x: 0, y: 0, width: x1 - x0, height: y1 - y0 });
            }
            const bytes = await out.save();
            window.__lastFlatBytes = bytes; // test probe
            if (!location.search.includes('testhooks')) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
                a.download = state.fileName.replace(/\.pdf$/i, '') + '_flattened.pdf';
                a.click();
                URL.revokeObjectURL(a.href);
            }
            setStatus('Saved flattened (uneditable) PDF');
            showToast('Saved a flattened, uneditable copy');
        } catch (err) { console.error(err); showToast('Flatten failed'); }
    }
    window.saveFlattened = saveFlattened;

    // ── Document Info: view & edit title/author/subject/keywords ──
    async function documentInfoDialog() {
        if (!state.pdfBytes) return;
        let doc, meta = {};
        try {
            doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            meta = { title: doc.getTitle() || '', author: doc.getAuthor() || '',
                     subject: doc.getSubject() || '', keywords: doc.getKeywords() || '',
                     creator: doc.getCreator() || '' };
        } catch (_) { showToast('Could not read document info'); return; }
        const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const v = await _toolModal('Document information', `
            <label class="modal-label">Title:</label>
            <input type="text" class="modal-input" data-k="title" value="${esc(meta.title)}">
            <label class="modal-label" style="margin-top:8px;">Author:</label>
            <input type="text" class="modal-input" data-k="author" value="${esc(meta.author)}">
            <label class="modal-label" style="margin-top:8px;">Subject:</label>
            <input type="text" class="modal-input" data-k="subject" value="${esc(meta.subject)}">
            <label class="modal-label" style="margin-top:8px;">Keywords (comma separated):</label>
            <input type="text" class="modal-input" data-k="keywords" value="${esc(meta.keywords)}">
            <p class="modal-hint" style="margin-top:8px;">${state.totalPages} page(s) · ${(((state.pdfBytes.byteLength||state.pdfBytes.length)/1024)|0)} KB</p>`,
            'Save Info');
        if (!v) return;
        try {
            doc.setTitle(v.title || ''); doc.setAuthor(v.author || '');
            doc.setSubject(v.subject || ''); doc.setKeywords((v.keywords || '').split(',').map(k => k.trim()).filter(Boolean));
            await _reloadFromBytes(await doc.save(), 'Document info updated');
        } catch (err) { console.error(err); showToast('Could not save document info'); }
    }
    window.documentInfoDialog = documentInfoDialog;

    // ── Extract all text to a .txt file ──
    async function extractTextToFile() {
        if (!state.pdfDoc) return;
        setStatus('Extracting text...');
        try {
            let out = '';
            for (let p = 1; p <= state.totalPages; p++) {
                const pg = await state.pdfDoc.getPage(p);
                const tc = await pg.getTextContent();
                let last = 0, line = '';
                const parts = [];
                for (const it of tc.items) {
                    if (!it.str) continue;
                    const y = it.transform[5];
                    if (last && Math.abs(y - last) > 3) { parts.push(line.trim()); line = ''; }
                    line += it.str + (it.hasEOL ? '\n' : ' ');
                    last = y;
                }
                if (line.trim()) parts.push(line.trim());
                out += '=== Page ' + p + ' ===\n' + parts.join('\n') + '\n\n';
            }
            if (!out.replace(/=== Page \d+ ===/g, '').trim()) {
                showToast('No selectable text found — this looks scanned. Run Scan & OCR first.');
                setStatus('No text to extract (scanned document)');
                return;
            }
            window.__lastExtractLen = out.length; // test probe
            if (location.search.includes('testhooks')) return; // no real download in tests
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain' }));
            a.download = state.fileName.replace(/\.pdf$/i, '') + '.txt';
            a.click();
            URL.revokeObjectURL(a.href);
            setStatus('Text extracted to .txt');
            showToast('Saved all text as a .txt file');
        } catch (err) { console.error(err); showToast('Text extraction failed'); }
    }
    window.extractAllText = extractTextToFile;

    // ── Outline / bookmarks: expose the PDF's own table of contents ──
    async function getDocumentOutline() {
        try {
            const outline = await state.pdfDoc.getOutline();
            if (!outline || !outline.length) return [];
            const flat = [];
            const walk = async (items, depth) => {
                for (const it of items) {
                    let page = null;
                    try {
                        let dest = it.dest;
                        if (typeof dest === 'string') dest = await state.pdfDoc.getDestination(dest);
                        if (Array.isArray(dest) && dest[0]) page = (await state.pdfDoc.getPageIndex(dest[0])) + 1;
                    } catch (_) {}
                    flat.push({ title: it.title, depth, page });
                    if (it.items && it.items.length) await walk(it.items, depth + 1);
                }
            };
            await walk(outline, 0);
            return flat;
        } catch (_) { return []; }
    }
    window.pdfOutline = { get: getDocumentOutline, goto: (n) => goToPage(n) };

    // Lazy-load the encryption-capable pdf-lib fork (only when needed).
    let _encLib = null;
    async function encLib() {
        if (_encLib) return _encLib;
        if (!window.PDFLibEncrypt) {
            const mainLib = window.PDFLib; // guard: CDN fallback UMD is named PDFLib and would clobber it
            try {
                await loadScript('libs/pdf-lib-encrypt.js');
            } catch (_) {
                await loadScript('https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib@2/dist/pdf-lib.min.js');
                if (window.PDFLib && window.PDFLib !== mainLib) {
                    window.PDFLibEncrypt = window.PDFLib; // capture the fork
                    window.PDFLib = mainLib;              // restore the real main lib
                }
            }
        }
        _encLib = window.PDFLibEncrypt || window.PDFLib;
        return _encLib;
    }

    // ── 1. Add password + permissions (encrypt the saved file) ──
    async function addPasswordTool() {
        if (!state.pdfBytes) return;
        const v = await _toolModal('Password & permissions', `
            <label class="modal-label">Password to OPEN the file:</label>
            <input type="password" class="modal-input" data-k="user" placeholder="leave blank for no open-password">
            <label class="modal-label" style="margin-top:8px;">Owner password (to change permissions):</label>
            <input type="password" class="modal-input" data-k="owner" placeholder="defaults to the open password">
            <label class="modal-label" style="margin-top:10px;">Restrict:</label>
            <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noPrint"><span>No printing</span></label>
            <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noCopy"><span>No copying text</span></label>
            <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noModify"><span>No editing</span></label>
            <p class="modal-hint" style="margin-top:8px;color:#e07300;">⚠ If the open-password is lost, NO app can open the file — not even this one. Store it safely.</p>`,
            'Encrypt & Save');
        if (!v) return;
        if (!v.user && !v.owner && !v.noPrint && !v.noCopy && !v.noModify) { showToast('Set a password or a restriction first'); return; }
        setStatus('Encrypting...');
        try {
            const L = await encLib();
            const doc = await L.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            // @cantoo/pdf-lib: call encrypt() BEFORE save (not save-options)
            doc.encrypt({
                userPassword: v.user || v.owner || undefined,
                ownerPassword: v.owner || v.user || undefined,
                permissions: {
                    printing: v.noPrint ? false : 'highResolution',
                    copying: v.noCopy ? false : true,
                    modifying: v.noModify ? false : true,
                    annotating: v.noModify ? false : true,
                    fillingForms: v.noModify ? false : true,
                    contentAccessibility: true,
                    documentAssembly: v.noModify ? false : true,
                },
            });
            const bytes = await doc.save();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            a.download = state.fileName.replace(/\.pdf$/i, '') + '_protected.pdf';
            a.click();
            URL.revokeObjectURL(a.href);
            setStatus('Saved password-protected PDF');
            showToast('Saved encrypted copy — keep the password safe');
        } catch (err) { console.error(err); showToast('Encryption failed: ' + err.message); }
    }
    window.addPasswordTool = addPasswordTool;

    // ── Unlock: remove the password / encryption from the open PDF ──
    // The file is already decrypted in memory (the user supplied the password on
    // open, or it was never encrypted). We reload with ignoreEncryption and save
    // WITHOUT calling encrypt() - producing an unprotected copy. Fully local, no
    // API. Mirrors iLovePDF's Unlock, minus the cloud.
    async function unlockPdfTool() {
        if (!state.pdfBytes) { showToast('Open a PDF first'); return; }
        setStatus('Removing password...');
        try {
            let bytes;

            // The original bytes in state.pdfBytes are STILL ENCRYPTED - pdf.js
            // decrypted them in memory using the password the user typed on open,
            // but never wrote a plaintext copy back. pdf-lib's ignoreEncryption
            // only SKIPS the error; it cannot read encrypted streams, so
            // re-saving the encrypted original produced a broken/still-locked
            // file. That was the bug.
            //
            // For a file that WAS password-protected, get the real DECRYPTED
            // bytes from pdf.js (which holds the opened, unlocked document) via
            // saveDocument(). Saving those with no encryption yields a clean,
            // openable PDF with the password removed.
            if (state.pdfPassword && state.pdfDoc && state.pdfDoc.saveDocument) {
                const dec = await state.pdfDoc.saveDocument();
                // Re-save through pdf-lib so the output is a plain, unencrypted
                // PDF (and normalized), never re-applying encryption.
                const L = await encLib();
                const doc = await L.PDFDocument.load(dec, { ignoreEncryption: true });
                bytes = await doc.save();
            } else {
                // Not password-protected (or no pdf.js save available): a plain
                // pdf-lib round-trip strips any permissions/owner-password flags.
                const L = await encLib();
                const doc = await L.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
                bytes = await doc.save();
            }

            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            a.download = state.fileName.replace(/\.pdf$/i, '') + '_unlocked.pdf';
            a.click();
            URL.revokeObjectURL(a.href);
            setStatus('Saved unlocked PDF (no password)');
            showToast('Saved an unlocked copy - the password has been removed');
        } catch (err) {
            console.error(err);
            showToast('Could not unlock: ' + (err && err.message || 'unknown error'));
            setStatus('Unlock failed');
        }
    }
    window.unlockPdfTool = unlockPdfTool;

    // ── Standalone Lock / Unlock: pick a file directly, no need to open it in
    //    the editor first (Pranshu). One entry point handles both:
    //      • a password-protected file  → asks the password, removes it
    //      • an unprotected file        → offers to ADD a password (lock)
    //    Fully local: pdf.js decrypts (it takes the password), pdf-lib re-saves.
    function _pickPdfFile() {
        return new Promise((resolve) => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = 'application/pdf,.pdf';
            inp.style.display = 'none';
            let settled = false;
            const done = (f) => { if (settled) return; settled = true; inp.remove(); resolve(f || null); };
            inp.addEventListener('change', () => done(inp.files && inp.files[0]));
            // If the picker is dismissed (Cancel), the change event never fires.
            // When focus returns to the window, resolve null on the next tick so
            // the await never hangs and the input element doesn't leak.
            const onFocus = () => {
                window.removeEventListener('focus', onFocus);
                setTimeout(() => done(null), 300); // give a real 'change' time to win
            };
            document.body.appendChild(inp);
            inp.click();
            window.addEventListener('focus', onFocus);
        });
    }

    async function lockUnlockPdfFile() {
        // Ask UPFRONT what the user wants - Lock or Unlock - one button, like
        // Word<->PDF (Pranshu). No silent auto-detection guesswork.
        const mode = await _choiceModal('Unlock / Lock PDF',
            'What would you like to do?', [
                { key: 'unlock', label: 'Unlock a PDF (remove lock/restrictions)' },
                { key: 'lock',   label: 'Lock a PDF (restrict actions)' },
            ]);
        if (!mode) return;

        const file = await _pickPdfFile();
        if (!file) { setStatus('Ready'); return; }
        setStatus('Reading PDF...');
        try {
            const buf = await file.arrayBuffer();
            const baseName = file.name.replace(/\.pdf$/i, '');
            const L = await encLib();

            let wasEncrypted = false;

            if (mode === 'unlock') {
                // UNLOCK by RE-RENDERING each page. pdf.js decrypts the content to
                // display it; we render every page to a canvas and rebuild a fresh,
                // unencrypted PDF from those images. This is the only method that
                // reliably works with these bundled libs - stripping the Encrypt
                // dict (pdf-lib) OR saveDocument()/getData() (pdf.js) both left the
                // content streams still encrypted, so pages came out BLANK. Verified
                // in a real browser: this renders the actual content, no password.
                // Trade-off: the unlocked page becomes an image (not selectable
                // text), which is the accepted cost of guaranteed-correct unlock.
                setStatus('Removing lock...');
                let pdf = null, password = null;
                for (let attempt = 0; ; attempt++) {
                    try {
                        pdf = await pdfjsLib.getDocument({ data: buf.slice(0), ...(password ? { password } : {}) }).promise;
                        break;
                    } catch (err) {
                        if (err && err.name === 'PasswordException' && attempt < 3) {
                            wasEncrypted = true;
                            password = await customPrompt(
                                attempt === 0 ? 'This PDF has an open-password. Enter it to unlock:'
                                              : 'Wrong password - try again:', 'Password');
                            if (!password) { setStatus('Cancelled'); return; }
                            continue;
                        }
                        throw err;
                    }
                }
                const outDoc = await L.PDFDocument.create();
                for (let i = 1; i <= pdf.numPages; i++) {
                    setStatus('Removing lock... page ' + i + '/' + pdf.numPages);
                    const pg = await pdf.getPage(i);
                    const vp = pg.getViewport({ scale: 2 });   // 2x for crisp output
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.ceil(vp.width);
                    canvas.height = Math.ceil(vp.height);
                    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
                    const png = await outDoc.embedPng(canvas.toDataURL('image/png'));
                    const base = pg.getViewport({ scale: 1 });
                    const np = outDoc.addPage([base.width, base.height]);
                    np.drawImage(png, { x: 0, y: 0, width: base.width, height: base.height });
                }
                const bytes = await outDoc.save();

                // Ask what to do with the unlocked file (Pranshu): open it in the
                // editor to work on it, or just download the unlocked copy.
                const removedWhat = wasEncrypted ? 'The password has been removed.'
                                                 : 'The restrictions have been removed.';
                const choice = await _choiceModal('PDF unlocked',
                    removedWhat + ' What would you like to do?', [
                        { key: 'edit',     label: 'Open in editor' },
                        { key: 'download', label: 'Download unlocked copy' },
                    ]);
                if (choice === 'edit') {
                    state.fileName = baseName + '_unlocked.pdf';
                    await loadPDF(new File([bytes], state.fileName, { type: 'application/pdf' }));
                    setStatus('Opened the unlocked PDF');
                } else if (choice === 'download') {
                    _downloadBytes(bytes, baseName + '_unlocked.pdf');
                    setStatus('Saved unlocked PDF');
                    showToast(wasEncrypted ? 'Password removed - saved an unlocked copy'
                                           : 'Restrictions removed - saved an unlocked copy');
                } else {
                    setStatus('Ready'); // cancelled
                }
            } else {  // mode === 'lock'
                // LOCK with RESTRICTIONS only (owner password + permissions), NOT
                // an open-password. The file still OPENS for anyone to view, but
                // printing/copying/editing are blocked - and crucially, Unlock can
                // strip that WITHOUT needing any password (unlike a userPassword,
                // which truly encrypts the content and could never be removed
                // without it).
                const v = await _toolModal('Lock this PDF', `
                    <p class="modal-hint" style="margin:0 0 10px;">Restrict what people can do with this PDF. The file still opens for viewing - no password needed to open it - but the chosen actions are blocked. You can remove these restrictions later with Unlock (no password required).</p>
                    <label class="modal-label">Restrict:</label>
                    <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noPrint" checked><span>No printing</span></label>
                    <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noCopy" checked><span>No copying text</span></label>
                    <label class="stamp-date-row" style="padding:4px 0;"><input type="checkbox" data-k="noModify" checked><span>No editing</span></label>`,
                    'Lock & Save');
                if (!v) { setStatus('Ready'); return; }
                if (!v.noPrint && !v.noCopy && !v.noModify) { showToast('Pick at least one restriction'); return; }
                setStatus('Locking...');
                const doc = await L.PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
                // Owner password is internal-only (never shown) - it just backs the
                // permission flags. No userPassword => the file opens freely.
                doc.encrypt({
                    ownerPassword: 'greens-nexus-lock',
                    permissions: {
                        printing: v.noPrint ? false : 'highResolution',
                        copying: v.noCopy ? false : true,
                        modifying: v.noModify ? false : true,
                        annotating: v.noModify ? false : true,
                        fillingForms: v.noModify ? false : true,
                        contentAccessibility: true,
                        documentAssembly: v.noModify ? false : true,
                    },
                });
                const bytes = await doc.save();
                _downloadBytes(bytes, baseName + '_locked.pdf');
                setStatus('Saved restricted PDF');
                showToast('Restrictions added - the file still opens for viewing');
            }
        } catch (err) {
            console.error(err);
            showToast('Could not process: ' + (err && err.message || 'unknown error'));
            setStatus('Failed');
        }
    }
    function _downloadBytes(bytes, name) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        a.href = url;
        a.download = name;
        a.click();
        // Defer revocation - a.click() starts the download asynchronously, so
        // revoking synchronously can race the browser's blob read (empty/failed
        // download for large files).
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    window.lockUnlockPdfFile = lockUnlockPdfFile;

    // ── PDF → Markdown: extract text as a .md file, using layout heuristics ──
    // Fully local (pdf.js text extraction). Headings inferred from font size,
    // paragraphs from vertical gaps, bullets kept. Not a perfect converter, but
    // a clean, dependency-free Markdown export. Mirrors iLovePDF's PDF-to-Markdown.
    async function exportMarkdownTool() {
        if (!state.pdfDoc) { showToast('Open a PDF first'); return; }
        setStatus('Converting to Markdown...');
        try {
            let md = '';
            for (let i = 1; i <= state.totalPages; i++) {
                setStatus('Reading page ' + i + '/' + state.totalPages + '...');
                const page = await state.pdfDoc.getPage(i);
                const tc = await page.getTextContent();
                const items = (tc.items || []).filter(it => it.str && it.str.trim());
                if (!items.length) continue;

                // Group fragments into lines by baseline y, then join left-to-right.
                const lines = [];
                for (const it of items) {
                    const y = it.transform[5], x = it.transform[4];
                    const size = Math.max(6, Math.hypot(it.transform[2], it.transform[3]));
                    let L = lines.find(l => Math.abs(l.y - y) < Math.max(2, size * 0.4));
                    if (L) { L.parts.push({ x, str: it.str }); L.size = Math.max(L.size, size); }
                    else lines.push({ y, size, parts: [{ x, str: it.str }] });
                }
                lines.sort((a, b) => b.y - a.y);
                for (const l of lines) l.text = l.parts.sort((a, b) => a.x - b.x).map(p => p.str).join(' ').replace(/\s+/g, ' ').trim();

                // Median size → heading thresholds. Bigger lines become headings.
                const sizes = lines.map(l => l.size).sort((a, b) => a - b);
                const med = sizes[Math.floor(sizes.length / 2)] || 12;

                if (i > 1) md += '\n\n---\n\n'; // page break marker
                let prevY = null;
                for (const l of lines) {
                    if (!l.text) continue;
                    // Blank line between paragraphs when there's a big vertical gap.
                    if (prevY !== null && (prevY - l.y) > l.size * 1.8) md += '\n';
                    prevY = l.y;
                    const t = l.text;
                    if (l.size >= med * 1.6)      md += '# '   + t + '\n';
                    else if (l.size >= med * 1.3) md += '## '  + t + '\n';
                    else if (l.size >= med * 1.12) md += '### ' + t + '\n';
                    else if (/^\s*[•·▪◦‣-]\s+/.test(t)) md += t.replace(/^\s*[•·▪◦‣]\s+/, '- ') + '\n';
                    else md += t + '\n';
                }
            }
            md = md.trim() + '\n';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
            a.download = state.fileName.replace(/\.pdf$/i, '') + '.md';
            a.click();
            URL.revokeObjectURL(a.href);
            setStatus('Saved Markdown (.md)');
            showToast('Saved as Markdown');
        } catch (err) {
            console.error(err);
            showToast('Could not convert to Markdown: ' + (err && err.message || 'unknown error'));
            setStatus('Markdown export failed');
        }
    }
    window.exportMarkdownTool = exportMarkdownTool;

    // ── 2. Compare two PDFs — per-page visual diff ──
    async function comparePdfsTool() {
        _exitScrollForOp();
        if (!state.pdfDoc) { showToast('Open the first PDF, then pick the second to compare'); return; }
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'application/pdf';
        input.onchange = async () => {
            const f = input.files && input.files[0]; if (!f) return;
            await runCompare(new Uint8Array(await f.arrayBuffer()));
        };
        input.click();
    }
    async function runCompare(otherBytes) {
            setStatus('Comparing...');
            try {
                const otherDoc = await pdfjsLib.getDocument({ data: otherBytes }).promise;
                const nA = state.totalPages, nB = otherDoc.numPages;
                const out = await PDFLib.PDFDocument.create();
                const maxP = Math.max(nA, nB);
                let changedPages = 0;
                for (let p = 1; p <= maxP; p++) {
                    setStatus('Comparing page ' + p + '/' + maxP + '...');
                    const renderAt = async (doc, pageNo) => {
                        if (pageNo > doc.numPages) return null;
                        const pg = await doc.getPage(pageNo);
                        const vp = pg.getViewport({ scale: 1.5 });
                        const c = document.createElement('canvas');
                        c.width = vp.width; c.height = vp.height;
                        const cx = c.getContext('2d');
                        cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
                        await pg.render({ canvasContext: cx, viewport: vp }).promise;
                        return c;
                    };
                    const ca = await renderAt(state.pdfDoc, p);
                    const cb = await renderAt(otherDoc, p);
                    const W = Math.max(ca ? ca.width : 0, cb ? cb.width : 0);
                    const H = Math.max(ca ? ca.height : 0, cb ? cb.height : 0);
                    const diff = document.createElement('canvas');
                    diff.width = W; diff.height = H;
                    const dx = diff.getContext('2d');
                    dx.fillStyle = '#fff'; dx.fillRect(0, 0, W, H);
                    if (ca) dx.drawImage(ca, 0, 0);
                    // overlay B's differences in red — both buffers read at the
                    // FULL W×H so their row strides match (fixes skew on mixed sizes)
                    if (ca && cb) {
                        // paint each onto a common W×H canvas first
                        const norm = (c) => { const n = document.createElement('canvas'); n.width = W; n.height = H;
                            const nx = n.getContext('2d'); nx.fillStyle = '#fff'; nx.fillRect(0,0,W,H); nx.drawImage(c,0,0); return nx.getImageData(0,0,W,H); };
                        const a2 = norm(ca), b2 = norm(cb), od = dx.getImageData(0, 0, W, H);
                        let changed = false;
                        for (let i = 0; i < a2.data.length; i += 4) {
                            const da = Math.abs(a2.data[i] - b2.data[i]) + Math.abs(a2.data[i+1] - b2.data[i+1]) + Math.abs(a2.data[i+2] - b2.data[i+2]);
                            if (da > 40) {
                                od.data[i] = 230; od.data[i+1] = 30; od.data[i+2] = 30; od.data[i+3] = 255;
                                changed = true;
                            }
                        }
                        dx.putImageData(od, 0, 0);
                        if (changed) changedPages++;
                    } else {
                        // page only in one document = whole page differs
                        dx.fillStyle = 'rgba(230,30,30,0.25)'; dx.fillRect(0, 0, W, H);
                        dx.fillStyle = '#c00'; dx.font = '20px Arial';
                        dx.fillText(ca ? 'Only in FIRST document' : 'Only in SECOND document', 20, 40);
                        changedPages++;
                    }
                    const jpg = await out.embedJpg(diff.toDataURL('image/jpeg', 0.9));
                    const np = out.addPage([W / 1.5, H / 1.5]);
                    np.drawImage(jpg, { x: 0, y: 0, width: W / 1.5, height: H / 1.5 });
                }
                const bytes = await out.save();
                if (otherDoc && otherDoc.destroy) { try { otherDoc.destroy(); } catch (_) {} }
                await loadPDF(new File([bytes], 'comparison.pdf', { type: 'application/pdf' }));
                setStatus('Comparison ready — ' + changedPages + ' page(s) differ (changes in red)');
                showToast(changedPages + ' page(s) differ — differences shown in red');
            } catch (err) { console.error(err); showToast('Compare failed: ' + err.message); }
    }
    window.comparePdfsTool = comparePdfsTool;
    window.runCompare = runCompare;

    // ── 3. Sanitize — strip embedded JavaScript, files, and actions ──
    async function sanitizePdfTool() {
        _exitScrollForOp();
        if (!state.pdfBytes) return;
        setStatus('Sanitizing...');
        try {
            const { PDFName, PDFDict } = PDFLib;
            const doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            let removed = 0;
            const cat = doc.catalog;
            // Document-level auto-actions and JavaScript
            for (const key of ['OpenAction', 'AA']) {
                if (cat.has(PDFName.of(key))) { cat.delete(PDFName.of(key)); removed++; }
            }
            const names = cat.lookup(PDFName.of('Names'));
            if (names instanceof PDFDict) {
                for (const key of ['JavaScript', 'EmbeddedFiles']) {
                    if (names.has(PDFName.of(key))) { names.delete(PDFName.of(key)); removed++; }
                }
            }
            // AcroForm XFA (an XML forms layer that can carry its own scripts).
            try {
                const acro = cat.lookup(PDFName.of('AcroForm'));
                if (acro instanceof PDFDict && acro.has(PDFName.of('XFA'))) {
                    acro.delete(PDFName.of('XFA')); removed++;
                }
            } catch (_) {}
            // Per-page auto-actions
            for (const pg of doc.getPages()) {
                if (pg.node.has(PDFName.of('AA'))) { pg.node.delete(PDFName.of('AA')); removed++; }
                // Form-field & link scripts on this page's annotations
                try {
                    const annots = pg.node.lookup(PDFName.of('Annots'));
                    if (annots && annots.asArray) for (const ref of annots.asArray()) {
                        const an = doc.context.lookup(ref);
                        if (an && an.has) {
                            for (const k of ['AA', 'A', 'JS']) {
                                if (an.has(PDFName.of(k))) { an.delete(PDFName.of(k)); removed++; }
                            }
                        }
                    }
                } catch (_) {}
            }
            const bytes = await doc.save();
            await _reloadFromBytes(bytes, 'Sanitized — removed ' + removed + ' script/attachment item(s)');
            showToast(removed ? 'Removed ' + removed + ' embedded script/attachment item(s)' : 'No embedded scripts or attachments found');
        } catch (err) { console.error(err); showToast('Sanitize failed'); }
    }
    window.sanitizePdfTool = sanitizePdfTool;

    // ── 4. Remove blank pages (auto-detect near-white pages) ──
    async function removeBlankPagesTool() {
        _exitScrollForOp();
        if (!state.pdfDoc) return;
        setStatus('Scanning for blank pages...');
        try {
            const blanks = [];
            for (let p = 1; p <= state.totalPages; p++) {
                const pg = await state.pdfDoc.getPage(p);
                const tc = await pg.getTextContent();
                const hasText = tc.items.some(i => i.str && i.str.trim());
                if (hasText) continue;
                // no text — sample pixels to confirm it's visually blank
                const vp = pg.getViewport({ scale: 0.5 });
                const c = document.createElement('canvas');
                c.width = vp.width; c.height = vp.height;
                const cx = c.getContext('2d');
                cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
                await pg.render({ canvasContext: cx, viewport: vp }).promise;
                const data = cx.getImageData(0, 0, c.width, c.height).data;
                let ink = 0;
                for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel (denser)
                    if (data[i] < 230 || data[i+1] < 230 || data[i+2] < 230) ink++;
                }
                if (ink < 20) blanks.push(p); // needs to be VERY empty to count as blank
            }
            if (!blanks.length) { showToast('No blank pages found'); setStatus('No blank pages found'); return; }
            if (blanks.length >= state.totalPages) { showToast('Every page looks blank — nothing removed'); return; }
            if (!window.confirm('Remove ' + blanks.length + ' blank page(s)? (pages ' + blanks.join(', ') + ')')) return;
            saveCurrentAnnotations();
            pushDocSnapshot('Remove blank pages');
            const doc = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            blanks.sort((a, b) => b - a).forEach(p => doc.removePage(p - 1));
            state.annotations = {}; state.undoStacks = {}; state.redoStacks = {};
            state.currentPage = 1;
            await _reloadFromBytes(await doc.save(), 'Removed ' + blanks.length + ' blank page(s)');
        } catch (err) { console.error(err); showToast('Remove blank pages failed'); }
    }
    window.removeBlankPagesTool = removeBlankPagesTool;

    // ── 5. N-up: place multiple pages per sheet ──
    async function nUpTool() {
        _exitScrollForOp();
        if (!state.pdfBytes) return;
        const v = await _toolModal('Multiple pages per sheet (N-up)', `
            <label class="modal-label">Pages per sheet:</label>
            <select class="modal-input" data-k="n">
                <option value="2">2 (side by side)</option>
                <option value="4">4 (2 × 2)</option>
                <option value="6">6 (2 × 3)</option>
                <option value="9">9 (3 × 3)</option>
            </select>
            <p class="modal-hint" style="margin-top:8px;">Great for handouts and saving paper. Saved as a new file.</p>`, 'Create N-up');
        if (!v) return;
        pushDocSnapshot('N-up');
        setStatus('Building N-up...');

        const n = parseInt(v.n, 10);
        const cols = n === 2 ? 2 : n === 4 ? 2 : n === 6 ? 2 : 3;
        const rows = n === 2 ? 1 : n === 4 ? 2 : n === 6 ? 3 : 3;

        // Layout N pages per sheet. `mode` is 'vector' (embedPdf - crisp) or
        // 'image' (pdf.js render - works on ANY compression). embedPdf decodes
        // lazily at save() time, so a bad-compression PDF only throws THERE - we
        // run the whole build+save and, on failure, retry in image mode.
        const buildNup = async (mode) => {
            const src = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true });
            const out = await PDFLib.PDFDocument.create();
            const first = src.getPage(0);
            const pw = first.getWidth(), ph = first.getHeight();
            const sheetW = cols >= rows ? Math.max(pw, ph) : Math.min(pw, ph);
            const sheetH = cols >= rows ? Math.min(pw, ph) : Math.max(pw, ph);
            const total = src.getPageCount();
            const cellW = sheetW / cols, cellH = sheetH / rows;

            let embedded = null;
            const pageImg = [];
            if (mode === 'vector') {
                embedded = await out.embedPdf(src, Array.from({ length: total }, (_, i) => i));
            } else {
                for (let i = 0; i < total; i++) {
                    setStatus('Building N-up... rendering page ' + (i + 1) + '/' + total);
                    const pg = await state.pdfDoc.getPage(i + 1);
                    const vp = pg.getViewport({ scale: 1.5 });
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
                    const cx2 = canvas.getContext('2d');
                    cx2.fillStyle = '#fff'; cx2.fillRect(0, 0, canvas.width, canvas.height);
                    await pg.render({ canvasContext: cx2, viewport: vp }).promise;
                    const base = pg.getViewport({ scale: 1 });
                    const png = await out.embedPng(canvas.toDataURL('image/png'));
                    pageImg.push({ png, w: base.width, h: base.height });
                }
            }
            for (let i = 0; i < total; i += n) {
                const sheet = out.addPage([sheetW, sheetH]);
                for (let k = 0; k < n && i + k < total; k++) {
                    const idx = i + k;
                    let ew, eh, place;
                    if (mode === 'vector') {
                        const emb = embedded[idx];
                        ew = emb.width; eh = emb.height;
                        try {
                            const rot = (src.getPage(idx).getRotation().angle % 360 + 360) % 360;
                            if (rot === 90 || rot === 270) { ew = emb.height; eh = emb.width; }
                        } catch (_) {}
                        place = (opts) => sheet.drawPage(emb, opts);
                    } else {
                        const im = pageImg[idx];
                        ew = im.w; eh = im.h;
                        place = (opts) => sheet.drawImage(im.png, opts);
                    }
                    const scale = Math.min(cellW / ew, cellH / eh) * 0.95;
                    const w = ew * scale, h = eh * scale;
                    const col = k % cols, row = Math.floor(k / cols);
                    const x = col * cellW + (cellW - w) / 2;
                    const y = sheetH - (row + 1) * cellH + (cellH - h) / 2;
                    place({ x, y, width: w, height: h });
                }
            }
            return await out.save();   // vector mode throws HERE on bad compression
        };

        try {
            let bytes;
            try {
                bytes = await buildNup('vector');
            } catch (vecErr) {
                console.warn('N-up: vector build failed (' + vecErr.message + '), retrying as images');
                setStatus('Building N-up (image mode)...');
                bytes = await buildNup('image');   // works on any compression
            }
            // Apply IN the editor - don't force a download.
            await _reloadFromBytes(bytes, n + '-up layout applied - keep editing, then Save when ready');
            showToast('Created a ' + n + ' pages-per-sheet layout - download it with Save when ready');
        } catch (err) { console.error(err); showToast('N-up failed: ' + err.message); }
    }
    window.nUpTool = nUpTool;

    // ══════════════════════════════════════════════════════════════════
    //  CONTINUOUS SCROLL VIEW  (Adobe-style read/scroll of all pages)
    // ══════════════════════════════════════════════════════════════════
    // A separate scrolling layer that stacks EVERY page and lazy-renders the
    // ones near the viewport. Reading/reviewing scrolls freely through all
    // pages; clicking a page jumps into the existing single-page EDITOR for
    // that page. The proven editing pipeline is untouched.
    let _scrollOn = false;
    let _scrollEls = [];      // per-page { wrap, canvas, rendered, page }
    let _savedScrollTop = null;   // scroll position kept while editing a page

    async function buildScrollView() {
        const host = dom.canvasScrollWrapper;
        let cont = document.getElementById('continuousView');
        if (cont) cont.remove();
        cont = document.createElement('div');
        cont.id = 'continuousView';
        _scrollEls = [];
        // Render each page at the SAME on-screen size as single-page (Page) mode
        // (base page width × zoom, per renderPage). To avoid a multi-second blank
        // stall on open, we DON'T await getPage for every page here — that was
        // O(pages) sequential awaits before first paint. Instead we size all
        // wrappers from page 1's dimensions as an estimate and build them
        // synchronously; renderScrollPage() corrects each wrapper to its real
        // size as it scrolls into view.
        let estRatio = 1.294, estBaseW = 612;
        try { const pg1 = await state.pdfDoc.getPage(1); const v = pg1.view; estBaseW = v[2]-v[0]; estRatio = (v[3]-v[1]) / (v[2]-v[0]); } catch (_) {}
        const estDispW = estBaseW * state.zoom;

        for (let p = 1; p <= state.totalPages; p++) {
            const wrap = document.createElement('div');
            wrap.className = 'cv-page';
            wrap.dataset.page = p;
            wrap.style.width = estDispW + 'px';
            wrap.style.height = (estDispW * estRatio) + 'px';
            const canvas = document.createElement('canvas');
            wrap.appendChild(canvas);
            const num = document.createElement('div');
            num.className = 'cv-page-num';
            num.textContent = p;
            wrap.appendChild(num);
            // Clicking a page in the continuous view just tracks it as current -
            // it does NOT drop out of scroll mode (that jarring auto-switch was
            // the confusing part). Editing tools switch to single-page on their
            // own when you actually pick a tool.
            wrap.addEventListener('click', () => { state.currentPage = p; dom.pageInput.value = p; updateThumbnailActive(); });
            cont.appendChild(wrap);
            _scrollEls.push({ wrap, canvas, rendered: false, page: p, dispW: estDispW, sized: false });
        }
        host.appendChild(cont);

        // Render pages whose rect is within the viewport (+ a screen of margin),
        // and track the centered page. A plain scroll handler is more robust
        // than IntersectionObserver across zoom/layout states.
        const scroller = host; // .canvas-scroll-wrapper is the overflow:auto element
        const onScroll = () => {
            const sRect = scroller.getBoundingClientRect();
            const vh = sRect.height || window.innerHeight;
            const margin = vh; // one screen above/below
            let centeredPage = state.currentPage, bestDist = Infinity;
            const midY = sRect.top + vh / 2;
            for (const el of _scrollEls) {
                const r = el.wrap.getBoundingClientRect();
                // Render pages within ~2 screens so they're ready before you
                // reach them. Do NOT free here: freeing mid-scroll blanked pages
                // right at the edge, then re-rendered them - a visible FLICKER.
                // Freeing is deferred to freeFarPages() which runs only once
                // scrolling has stopped (see below).
                const near = (r.bottom >= sRect.top - margin * 2 && r.top <= sRect.bottom + margin * 2);
                if (near) {
                    renderScrollPage(el.page - 1);
                }
                const c = r.top + r.height / 2;
                const d = Math.abs(c - midY);
                if (d < bestDist) { bestDist = d; centeredPage = el.page; }
            }
            if (!settling && centeredPage !== state.currentPage) {
                state.currentPage = centeredPage;
                dom.pageInput.value = centeredPage;
                if (typeof updateThumbnailActive === 'function') updateThumbnailActive();
            }
        };
        // While we're programmatically jumping to the target page, ignore the
        // scroll handler's "centered page" updates - otherwise it overwrites
        // state.currentPage (often to page 1 at the top) mid-jump, which yanked
        // the user back to the first page when re-entering scroll mode.
        let settling = true;
        // Throttle to one run per animation frame. The raw scroll event fires
        // many times per frame and onScroll does per-page getBoundingClientRect +
        // render work, which made scrolling laggy/janky. rAF-coalescing keeps the
        // handler off the critical scroll path so scrolling stays smooth.
        let _scrollRaf = 0;
        // Free far-away page bitmaps to cap memory - but ONLY when scrolling has
        // stopped, so it never blanks a page you're scrolling past (that was the
        // flicker). Runs ~250ms after the last scroll event.
        let _freeTimer = 0;
        // Freeing bitmaps is what caused the blank-then-render FLICKER. For a
        // normal document we simply DON'T free - every page, once rendered,
        // stays rendered, so scrolling is rock-solid with zero flicker (dozens
        // of canvases are fine for the browser). Only very large documents free
        // pages, and even then only far away and only after scrolling stops.
        const FREE_ABOVE_PAGES = 60;
        const freeFarPages = () => {
            if (state.totalPages <= FREE_ABOVE_PAGES) return;   // keep all rendered
            const sRect = scroller.getBoundingClientRect();
            const margin = sRect.height || window.innerHeight;
            for (const el of _scrollEls) {
                if (!el.rendered) continue;
                const r = el.wrap.getBoundingClientRect();
                if (r.bottom < sRect.top - margin * 8 || r.top > sRect.bottom + margin * 8) {
                    el.canvas.width = 0; el.canvas.height = 0;
                    el.rendered = false;
                }
            }
        };
        const guardedOnScroll = () => {
            if (settling) return;
            if (state.totalPages > FREE_ABOVE_PAGES) {
                clearTimeout(_freeTimer);
                _freeTimer = setTimeout(freeFarPages, 400); // large docs: free after idle
            }
            if (_scrollRaf) return;
            _scrollRaf = requestAnimationFrame(() => { _scrollRaf = 0; onScroll(); });
        };
        _scrollOnScroll = guardedOnScroll;
        scroller.addEventListener('scroll', guardedOnScroll, { passive: true });

        // Jump to the page the user was on, then keep re-asserting it briefly
        // while the estimated wrappers settle to their real sizes.
        const targetPage = state.currentPage;
        const jumpToTarget = () => {
            const cur = _scrollEls[targetPage - 1];
            if (cur) scroller.scrollTop = cur.wrap.offsetTop;
        };
        setTimeout(() => {
            jumpToTarget();
            // Re-assert a few times as pages render and heights correct.
            let n = 0;
            const reassert = setInterval(() => {
                jumpToTarget();
                if (++n >= 4) {
                    clearInterval(reassert);
                    settling = false;   // hand control back to the scroll handler
                    onScroll();
                }
            }, 60);
        }, 30);
        // Render whatever is initially in view (doesn't move currentPage yet).
        onScroll();

        // Background pre-render: for a normal document, eagerly draw EVERY page
        // (one per idle tick so the UI stays responsive) so no page is ever
        // blank when it scrolls into view - fast scrolling then shows content
        // immediately with no flicker. Skipped for very large docs, which rely
        // on the near-viewport lazy render + freeing instead.
        if (state.totalPages <= 60) {
            const myGen = _thumbGen; // reuse the doc generation guard
            let p = 0;
            const pump = () => {
                if (_scrollEls.length === 0) return;          // view torn down
                if (p >= _scrollEls.length) return;           // all done
                const el = _scrollEls[p++];
                if (el && !(el.rendered && el.canvas.width > 0)) {
                    renderScrollPage(el.page - 1);
                }
                // requestIdleCallback where available, else a small timeout.
                (window.requestIdleCallback || ((f) => setTimeout(f, 16)))(pump);
            };
            (window.requestIdleCallback || ((f) => setTimeout(f, 60)))(pump);
        }
    }
    let _scrollOnScroll = null;

    async function renderScrollPage(idx) {
        const el = _scrollEls[idx];
        if (!el) return;
        // Re-render if not yet drawn OR if the bitmap was freed (canvas zeroed
        // when the page scrolled far away). Relying only on `rendered` left a
        // freed page blank when you scrolled back to it - e.g. page 2 -> page 1.
        if (el.rendered && el.canvas.width > 0) return;
        el.rendered = true; // claim early to avoid double-render
        try {
            const page = await state.pdfDoc.getPage(el.page);
            const base = page.getViewport({ scale: 1 });
            // This page's true display width at the current zoom (matches Page
            // mode). Always assert the wrapper to this page's REAL size (not just
            // once): mixed-size documents were left at page 1's estimated size,
            // so jumping back rendered into a wrong-sized box.
            const dispW = base.width * state.zoom;
            const dispH = dispW * (base.height / base.width);
            el.dispW = dispW;
            el.sized = true;
            el.wrap.style.width = dispW + 'px';
            el.wrap.style.height = dispH + 'px';
            const scale = (dispW / base.width) * 1.5; // 1.5 = retina sharpness
            const vp = page.getViewport({ scale });
            el.canvas.width = vp.width;
            el.canvas.height = vp.height;
            el.canvas.style.width = dispW + 'px';
            el.canvas.style.height = (dispW * (base.height / base.width)) + 'px';
            const ctx = el.canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            // flatten this page's saved annotations on top (read-only preview)
            const entry = state.annotations[el.page];
            const objs = entry && (entry.fabricData || entry).objects;
            if (objs && objs.length) {
                const f = vp.width / page.getViewport({ scale: (entry.zoom || 1) }).width;
                const insts = await new Promise((res) => fabric.util.enlivenObjects(objs.filter(o => !o.excludeFromExport), res));
                const tmp = new fabric.StaticCanvas(null, { width: el.canvas.width, height: el.canvas.height });
                tmp.setZoom(f);
                insts.forEach(o => { if (o) tmp.add(o); });
                tmp.renderAll();
                ctx.drawImage(tmp.lowerCanvasEl, 0, 0, el.canvas.width, el.canvas.height);
            }
        } catch (e) { el.rendered = false; console.warn('scroll render p' + el.page, e); }
    }

    function destroyScrollView() {
        if (_scrollOnScroll) { dom.canvasScrollWrapper.removeEventListener('scroll', _scrollOnScroll); _scrollOnScroll = null; }
        const cont = document.getElementById('continuousView');
        if (cont) cont.remove();
        _scrollEls = [];
    }
    // Re-add the existing scroll handler after the view was hidden for editing
    // (it was detached, not destroyed) so scrolling keeps working on return.
    function _reattachScrollHandler() {
        if (_scrollOnScroll && dom.canvasScrollWrapper) {
            dom.canvasScrollWrapper.removeEventListener('scroll', _scrollOnScroll); // avoid dupes
            dom.canvasScrollWrapper.addEventListener('scroll', _scrollOnScroll, { passive: true });
        }
    }

    function setScrollMode(on) {
        if (!state.pdfDoc) return;
        _scrollOn = on;
        const cw = dom.canvasWrapper;
        const btn = document.getElementById('scrollModeBtn');
        const existing = document.getElementById('continuousView');
        if (on) {
            saveCurrentAnnotations();
            if (cw) cw.style.display = 'none';       // hide the single-page editor canvas
            if (existing && _scrollEls.length) {
                // The continuous view is still built (we only hid it to edit) -
                // just SHOW it again and restore the scroll position. No rebuild,
                // so returning to scroll is instant with no flicker. Pages are
                // already rendered.
                existing.style.display = '';
                if (dom.canvasScrollWrapper && _savedScrollTop != null) {
                    dom.canvasScrollWrapper.scrollTop = _savedScrollTop;
                }
                _reattachScrollHandler();
            } else {
                buildScrollView();  // first time (or torn down): build it
            }
            setStatus('Scroll through all pages - pick a tool to edit the current page');
        } else {
            // Entering single-page edit: remember where we were and HIDE the
            // continuous view instead of destroying it, so coming back doesn't
            // rebuild/flicker. Detach the scroll handler while hidden.
            _savedScrollTop = dom.canvasScrollWrapper ? dom.canvasScrollWrapper.scrollTop : 0;
            if (_scrollOnScroll && dom.canvasScrollWrapper) {
                dom.canvasScrollWrapper.removeEventListener('scroll', _scrollOnScroll);
            }
            if (existing) existing.style.display = 'none';
            if (cw) cw.style.display = '';
            renderPage(state.currentPage);
            // Reset the scroll position to the top of the single page. Coming
            // from a scrolled-down continuous view, the wrapper kept its old
            // scrollTop, so the edited page appeared stuck at its bottom. Reset
            // now AND after the async render settles the layout.
            if (dom.canvasScrollWrapper) {
                dom.canvasScrollWrapper.scrollTop = 0;
                requestAnimationFrame(() => { dom.canvasScrollWrapper.scrollTop = 0; });
                setTimeout(() => { dom.canvasScrollWrapper.scrollTop = 0; }, 120);
            }
            setStatus('Edit mode — page ' + state.currentPage);
        }
        if (btn) btn.classList.toggle('active', on);
    }
    window.setScrollMode = setScrollMode;
    window.isScrollMode = () => _scrollOn;
    // Re-render scroll pages when zoom changes while scrolling
    window.rerenderScrollForZoom = () => {
        if (!_scrollOn || !_scrollEls.length) return;
        // Resize every page wrapper to the new zoom and re-render in place -
        // no destroy/rebuild, so zoom/Fit is smooth with no flicker. Keep the
        // user roughly on the same page by preserving the scroll ratio.
        const sc = dom.canvasScrollWrapper;
        const prevRatio = sc && sc.scrollHeight > 0 ? sc.scrollTop / sc.scrollHeight : 0;
        for (const el of _scrollEls) {
            el.sized = false;                 // force re-size to the new zoom
            el.rendered = false;              // force re-render
            el.canvas.width = 0; el.canvas.height = 0;
            renderScrollPage(el.page - 1);
        }
        if (sc) requestAnimationFrame(() => { sc.scrollTop = prevRatio * sc.scrollHeight; });
    };
    // Scroll the continuous view to a given page (1-based), staying in scroll
    // mode. Used by thumbnail clicks / page-number jumps so navigating doesn't
    // yank the user out of continuous scroll. Returns false if not applicable.
    window.scrollToScrollPage = (n) => {
        if (!_scrollOn) return false;
        const el = _scrollEls[n - 1];
        if (!el) return false;
        state.currentPage = n;
        // Draw the target BEFORE scrolling so it isn't blank on arrival, then
        // scroll to it, then re-run the scroll handler so pages that scrolled
        // into view along the way (and any freed ones) get (re)rendered.
        renderScrollPage(n - 1);
        el.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (_scrollOnScroll) setTimeout(_scrollOnScroll, 350);
        updateThumbnailActive();
        return true;
    };

    // Auto-return to continuous scroll: while editing a single page, the user
    // can still scroll within that (possibly tall) page. Only when they scroll
    // PAST the top or bottom edge — i.e. try to leave the page — do we flip back
    // to scroll mode, landing on the page they were editing. This lets someone
    // click a page, edit it, then just keep scrolling to move through the doc.
    (function wireEditScrollToContinuous() {
        const sc = dom.canvasScrollWrapper;
        if (!sc) return;
        let armed = 0; // consecutive over-edge wheel ticks (debounce accidental flicks)
        sc.addEventListener('wheel', (e) => {
            if (_scrollOn || !state.pdfDoc) { armed = 0; return; } // only in edit mode
            const atTop = sc.scrollTop <= 1;
            const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
            const goingUp = e.deltaY < 0, goingDown = e.deltaY > 0;
            if ((atTop && goingUp) || (atBottom && goingDown)) {
                // Already at the edge and pushing further → user wants to leave.
                if (++armed >= 2) { armed = 0; setScrollMode(true); }
            } else {
                armed = 0; // scrolling within the page — stay in edit mode
            }
        }, { passive: true });
    })();

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    // ── Utility Functions ──
    function debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function updateSwatchActive() {
        const current = dom.colorPicker.value.toLowerCase();
        document.querySelectorAll('.swatch').forEach((s) => {
            s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === current);
        });
    }

    function updateSizePresetActive() {
        const current = parseInt(dom.sizePicker.value, 10);
        document.querySelectorAll('.size-btn').forEach((btn) => {
            btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === current);
        });
    }

    function applyBrushColor() {
        // Live-recolor a selected shape's border so the color picker manages the
        // border of an existing shape, not just new drawing.
        applyStrokeColorToSelection(dom.colorPicker.value);
        if (!fabricCanvas || !fabricCanvas.isDrawingMode) return;
        const opacity = parseInt(dom.opacityPicker.value, 10) / 100;
        if (state.activeTool === 'highlight') {
            fabricCanvas.freeDrawingBrush.color = hexToRgba(dom.colorPicker.value, Math.min(opacity, 0.4));
        } else {
            fabricCanvas.freeDrawingBrush.color = hexToRgba(dom.colorPicker.value, opacity);
        }
    }

    // ── Manage the border of a SELECTED shape (width + color) ───────────────────
    // Only strokeable shapes (lines/rects/ellipses/paths/polylines) are touched;
    // text objects are left alone so recoloring text still works via its own bar.
    function _strokeableSelection() {
        if (!fabricCanvas) return [];
        const act = fabricCanvas.getActiveObjects ? fabricCanvas.getActiveObjects() : [];
        const list = act.length ? act : (fabricCanvas.getActiveObject() ? [fabricCanvas.getActiveObject()] : []);
        return list.filter(o => o && o.stroke !== undefined && o.stroke !== null &&
            !['i-text', 'text', 'textbox'].includes(o.type) && !o._editTextGuide);
    }
    function applyStrokeWidthToSelection(w) {
        const sel = _strokeableSelection();
        if (!sel.length) return;
        sel.forEach(o => { o.set({ strokeWidth: w, strokeUniform: true }); o.setCoords(); });
        fabricCanvas.requestRenderAll();
        saveAnnotationState(); saveCurrentAnnotations();
    }
    function applyStrokeColorToSelection(color) {
        const sel = _strokeableSelection();
        if (!sel.length) return;
        sel.forEach(o => o.set({ stroke: color }));
        fabricCanvas.requestRenderAll();
        saveAnnotationState(); saveCurrentAnnotations();
    }

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function hexToRgb(color) {
        if (!color) return { r: 0, g: 0, b: 0 };
        // Support rgb()/rgba() strings (sampled text/shape fills use this format)
        const rgbMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
        if (rgbMatch) {
            return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
        }
        if (color.charAt(0) !== '#') {
            return { r: 0, g: 0, b: 0 };
        }
        // Support shorthand #rgb as well as #rrggbb
        let hex = color.slice(1);
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
        };
    }

    function setStatus(msg) {
        dom.statusText.textContent = msg;
    }

    function showToast(msg) {
        let toast = document.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // Polished "coming soon" popup for features that aren't ready yet.
    function showComingSoon(feature, blurb) {
        document.querySelector('.cs-overlay')?.remove();
        const ov = document.createElement('div');
        ov.className = 'cs-overlay';
        ov.innerHTML =
            '<div class="cs-card" role="dialog" aria-modal="true">' +
              '<div class="cs-icon">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
              '</div>' +
              '<div class="cs-badge">Coming soon</div>' +
              '<h3 class="cs-title">' + escapeHtml(feature) + ' is on the way</h3>' +
              '<p class="cs-blurb">' + escapeHtml(blurb || '') + '</p>' +
              '<p class="cs-note">We’re putting the finishing touches on this feature so it works flawlessly. It’ll be available here shortly — thanks for your patience!</p>' +
              '<button class="cs-btn">Got it</button>' +
            '</div>';
        document.body.appendChild(ov);
        const close = () => ov.remove();
        ov.querySelector('.cs-btn').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    }
    window.showComingSoon = showComingSoon;

    // ═══════════════════════════════════════════════════
    //  AI PANEL — Ollama Integration (Streaming + Smart Q&A)
    // ═══════════════════════════════════════════════════
    const OLLAMA_BASE = 'http://localhost:11434';
    const AI_CHUNK_SIZE = 2000;

    function setupAIPanel() {
        // AI features are disabled (UI hidden by adobe-ui.js) — don't poll Ollama.
        // checkOllamaStatus();
        // setInterval(checkOllamaStatus, 15000);
        dom.aiSummarizeBtn.addEventListener('click', () => aiSummarize('full'));
        dom.aiCurrentPageBtn.addEventListener('click', () => aiSummarize('page'));
        dom.aiTagsBtn.addEventListener('click', aiAutoTag);
        dom.aiAskBtn.addEventListener('click', aiAskDocument);
        dom.aiReplaceBtn.addEventListener('click', aiReplaceText);
        dom.aiQuestionInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                aiAskDocument();
            }
        });
    }

    async function checkOllamaStatus() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
            clearTimeout(timeout);
            if (res.ok) {
                const data = await res.json();
                const models = (data.models || []).map(m => m.name);
                state.ollamaOnline = true;
                dom.aiStatusDot.className = 'ai-status-dot online';
                dom.aiStatusText.textContent = `Online · ${models.length} model(s)`;
                if (models.length > 0) {
                    const current = dom.aiModelSelect.value;
                    dom.aiModelSelect.innerHTML = '';
                    models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m;
                        opt.textContent = m;
                        if (m === current || m.startsWith(current)) opt.selected = true;
                        dom.aiModelSelect.appendChild(opt);
                    });
                }
                return;
            }
        } catch (e) { /* offline */ }
        state.ollamaOnline = false;
        dom.aiStatusDot.className = 'ai-status-dot offline';
        dom.aiStatusText.textContent = 'Offline — run: ollama serve';
    }

    function toggleAiPanel() {
        // Close comment panel if it's open so both panels don't overlap
        if (!state.aiPanelOpen && dom.commentPanel.classList.contains('open')) {
            dom.commentPanel.classList.remove('open');
        }
        state.aiPanelOpen = !state.aiPanelOpen;
        dom.aiPanel.classList.toggle('open', state.aiPanelOpen);
        if (state.aiPanelOpen) checkOllamaStatus();
    }

    async function extractAllText(maxPages) {
        const pages = maxPages || state.totalPages;
        const texts = [];
        for (let i = 1; i <= pages; i++) {
            const page = await state.pdfDoc.getPage(i);
            const content = await page.getTextContent();
            const lines = groupTextIntoLines(content.items);
            texts.push(`--- Page ${i} ---\n${lines.join('\n')}`);
        }
        return texts.join('\n\n');
    }

    async function extractPageText(pageNum) {
        const page = await state.pdfDoc.getPage(pageNum);
        const content = await page.getTextContent();
        return groupTextIntoLines(content.items).join('\n');
    }

    function chunkText(text, chunkSize) {
        const words = text.split(/\s+/);
        const chunks = [];
        let current = [];
        let count = 0;
        for (const word of words) {
            current.push(word);
            count += Math.ceil(word.length / 4);
            if (count >= chunkSize) {
                chunks.push(current.join(' '));
                current = [];
                count = 0;
            }
        }
        if (current.length > 0) chunks.push(current.join(' '));
        return chunks;
    }

    // ── Keyword-based relevance scoring (no extra AI call needed) ──
    function scoreChunkRelevance(chunk, question) {
        const qWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const cLower = chunk.toLowerCase();
        let score = 0;
        for (const word of qWords) {
            const matches = (cLower.match(new RegExp(word, 'g')) || []).length;
            score += matches;
        }
        return score;
    }

    // ── Non-streaming call (for background sub-tasks) ──
    async function ollamaQuick(prompt, model) {
        const selectedModel = model || dom.aiModelSelect.value || 'mistral';
        const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                prompt,
                stream: false,
                keep_alive: '30m', // keep model resident so later calls skip the reload
                options: { temperature: 0.3, num_predict: 512, top_k: 30, top_p: 0.9 },
            }),
        });
        if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
        const data = await res.json();
        return data.response || '';
    }

    // Fire-and-forget model warm-up: loads the model into memory (with a long
    // keep_alive) so the first real request doesn't pay the cold-start cost.
    function warmUpOllama(model) {
        const selectedModel = model || dom.aiModelSelect.value || 'mistral';
        fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: selectedModel, prompt: '', stream: false, keep_alive: '30m' }),
        }).catch(() => { /* offline — ignore */ });
    }

    // ── STREAMING call — text appears word-by-word in the panel ──
    async function ollamaStream(prompt, title, model) {
        const selectedModel = model || dom.aiModelSelect.value || 'mistral';

        // Prepare the output panel for streaming
        dom.aiOutputArea.innerHTML = `
            <div class="ai-response-header" id="aiStreamTitle">${escapeHtml(String(title || ''))}</div>
            <div class="ai-response" id="aiStreamBody"></div>`;
        const bodyEl = document.getElementById('aiStreamBody');
        let fullText = '';

        const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                prompt,
                stream: true,
                keep_alive: '30m',
                options: { temperature: 0.4, num_predict: 1024, top_k: 30, top_p: 0.9 },
            }),
        });

        if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const lines = decoder.decode(value, { stream: true }).split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        fullText += json.response;
                        // Render with basic markdown-like formatting
                        bodyEl.innerHTML = formatAiResponse(fullText);
                        // Auto-scroll to bottom
                        dom.aiOutputArea.scrollTop = dom.aiOutputArea.scrollHeight;
                    }
                    if (json.done) break;
                } catch (e) { /* partial JSON line, skip */ }
            }
        }

        // Buttons row after streaming completes
        const btnRow = document.createElement('div');
        btnRow.className = 'ai-btn-row';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(fullText).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000); });
        };

        const askAgainBtn = document.createElement('button');
        askAgainBtn.className = 'ai-ask-again-btn';
        askAgainBtn.textContent = 'Ask another question';
        askAgainBtn.onclick = () => {
            dom.aiQuestionInput.value = '';
            dom.aiQuestionInput.focus();
        };

        btnRow.appendChild(copyBtn);
        btnRow.appendChild(askAgainBtn);
        dom.aiOutputArea.appendChild(btnRow);

        return fullText;
    }

    // ── Light markdown formatter for AI responses ──
    function formatAiResponse(text) {
        // Escape HTML FIRST — the model is fed raw PDF text, so an untrusted
        // document could otherwise inject <img onerror=…>/<script> that runs in
        // the portal origin. Markdown regexes then run on the safe string and
        // only add our own known-safe tags.
        return escapeHtml(text)
            // Bold **text**
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            // Headers: lines starting with # or numbered like "1." "2."
            .replace(/^#{1,3}\s+(.+)$/gm, '<div class="ai-section-head">$1</div>')
            .replace(/^(\d+)\.\s+\*\*(.*?)\*\*/gm, '<div class="ai-section-head">$1. $2</div>')
            // Bullet points
            .replace(/^[-•]\s+(.+)$/gm, '<div class="ai-bullet">• $1</div>')
            // Line breaks
            .replace(/\n\n/g, '<br><br>')
            .replace(/\n/g, '<br>');
    }

    function showAiThinking() {
        dom.aiOutputArea.innerHTML = `
            <div class="ai-thinking">
                <div class="ai-thinking-dots"><span></span><span></span><span></span></div>
                Reading document...
            </div>`;
    }

    function showAiProgress(label, pct) {
        dom.aiProgress.style.display = 'block';
        dom.aiProgressLabel.textContent = label;
        dom.aiProgressBar.style.width = pct + '%';
    }

    function hideAiProgress() {
        dom.aiProgress.style.display = 'none';
        dom.aiProgressBar.style.width = '0%';
    }

    // ── Summarize ──
    async function aiSummarize(scope) {
        if (!state.pdfDoc) { showToast('No PDF loaded'); return; }
        if (!state.ollamaOnline) { showToast('Ollama is offline'); return; }
        if (!state.aiPanelOpen) toggleAiPanel();
        showAiThinking();

        try {
            let text, label;
            if (scope === 'page') {
                text = await extractPageText(state.currentPage);
                label = `📄 Page ${state.currentPage} — Summary`;
                setStatus('AI: Summarizing page...');
            } else {
                setStatus('AI: Extracting text...');
                showAiProgress('Extracting document text...', 10);
                text = await extractAllText();
                label = '📋 Document Summary';
            }

            if (!text.trim()) {
                dom.aiOutputArea.innerHTML = '<div class="ai-output-placeholder"><p>No text found. Try running OCR first.</p></div>';
                hideAiProgress();
                return;
            }

            const chunks = chunkText(text, AI_CHUNK_SIZE);
            hideAiProgress();

            if (chunks.length === 1) {
                const prompt = `You are a professional document analyst. Read the following document and provide a well-structured, professional summary.

Format your response as:

**EXECUTIVE SUMMARY**
(2-3 sentence overview)

**KEY POINTS**
- Point 1
- Point 2
- Point 3

**MAIN TOPICS**
(List the main subjects covered)

**IMPORTANT DETAILS**
(Any critical facts, figures, dates, or names)

**CONCLUSION**
(Final takeaway)

Document:
${chunks[0]}`;
                await ollamaStream(prompt, label);
            } else {
                // Map-reduce for large docs
                const summaries = [];
                for (let i = 0; i < chunks.length; i++) {
                    showAiProgress(`Summarizing section ${i + 1} of ${chunks.length}...`, Math.round(((i + 1) / chunks.length) * 75));
                    const s = await ollamaQuick(`Summarize this section in 4-5 sentences. Be concise and factual:\n\n${chunks[i]}`);
                    summaries.push(s);
                }
                showAiProgress('Writing final summary...', 85);
                hideAiProgress();

                const finalPrompt = `You are a professional document analyst. Based on these section summaries, write a comprehensive, professional document summary.

Format your response as:

**EXECUTIVE SUMMARY**
(2-3 sentence overview)

**KEY POINTS**
- Point 1
- Point 2
- Point 3

**MAIN TOPICS**
(List the main subjects covered)

**IMPORTANT DETAILS**
(Any critical facts, figures, dates, or names)

**CONCLUSION**
(Final takeaway)

Section summaries:
${summaries.join('\n\n---\n\n')}`;
                await ollamaStream(finalPrompt, label);
            }

            setStatus('AI summary complete');
        } catch (err) {
            hideAiProgress();
            console.error(err);
            dom.aiOutputArea.innerHTML = `<div class="ai-response" style="color:var(--danger)">Error: ${escapeHtml(String(err && err.message || err))}</div>`;
            setStatus('AI summarize failed');
        }
    }

    // ── Ask Document — hybrid document + knowledge Q&A ──
    async function aiAskDocument() {
        const question = dom.aiQuestionInput.value.trim();
        if (!question) { showToast('Enter a question first'); return; }
        if (!state.pdfDoc) { showToast('No PDF loaded'); return; }
        if (!state.ollamaOnline) { showToast('Ollama is offline'); return; }
        if (!state.aiPanelOpen) toggleAiPanel();

        showAiThinking();
        dom.aiAskBtn.disabled = true;

        try {
            setStatus('AI: Reading document...');

            // Extract text — scan full document for best coverage
            let fullText = await extractAllText(Math.min(state.totalPages, 20));
            const chunks = chunkText(fullText, AI_CHUNK_SIZE);

            // Fast keyword-based relevance scoring — no extra AI call
            const scored = chunks.map(chunk => ({
                chunk,
                score: scoreChunkRelevance(chunk, question),
            })).sort((a, b) => b.score - a.score);

            // Take top 3 most relevant chunks as document context
            const contextText = scored.slice(0, 3).map(s => s.chunk).join('\n\n');
            const hasDocContext = contextText.trim().length > 50;

            setStatus('AI: Generating answer...');

            // Answer strictly from the document — concise, no padding, no summaries
            const prompt = hasDocContext
                ? `You are a precise document assistant. Answer ONLY based on the document content below. Be concise and direct — no padding, no summaries, no "in conclusion". If the document does not contain enough information to answer, say so in one sentence.

QUESTION: ${question}

DOCUMENT CONTENT:
${contextText}

Answer directly and briefly:`
                : `The document does not contain relevant information to answer: "${question}". State this clearly in one sentence.`;

            const label = `💬 ${question.length > 55 ? question.substring(0, 55) + '...' : question}`;
            await ollamaStream(prompt, label);

            setStatus('AI answer ready');
        } catch (err) {
            hideAiProgress();
            console.error(err);
            dom.aiOutputArea.innerHTML = `<div class="ai-response" style="color:var(--danger)">Error: ${escapeHtml(String(err && err.message || err))}</div>`;
            setStatus('AI Q&A failed');
        }

        dom.aiAskBtn.disabled = false;
    }

    // ── Auto Tag ──
    async function aiAutoTag() {
        if (!state.pdfDoc) { showToast('No PDF loaded'); return; }
        if (!state.ollamaOnline) { showToast('Ollama is offline'); return; }
        if (!state.aiPanelOpen) toggleAiPanel();
        showAiThinking();

        try {
            setStatus('AI: Analyzing document...');
            const text = await extractAllText(Math.min(state.totalPages, 8));
            const chunks = chunkText(text, AI_CHUNK_SIZE);
            const sample = chunks.slice(0, 2).join('\n\n').substring(0, 3500);

            const prompt = `You are a professional document classifier. Analyze this document excerpt and provide a detailed classification.

Format your response as:

**DOCUMENT TYPE**
(e.g., Technical Report, Legal Contract, Invoice, Research Paper, Manual, Letter, etc.)

**PRIMARY CATEGORY**
(e.g., Finance, Legal, Medical, Engineering, Marketing, Education, etc.)

**SUGGESTED TAGS**
(8-12 specific keywords, comma-separated)

**LANGUAGE & TONE**
- Language:
- Tone: (Formal / Informal / Technical / Academic / Commercial)

**TARGET AUDIENCE**
(Who this document is written for)

**ONE-LINE SUMMARY**
(A single professional sentence describing the document)

Document excerpt:
${sample}`;

            await ollamaStream(prompt, '🏷️ Document Analysis & Tags');
            setStatus('AI tagging complete');
        } catch (err) {
            hideAiProgress();
            console.error(err);
            dom.aiOutputArea.innerHTML = `<div class="ai-response" style="color:var(--danger)">Error: ${escapeHtml(String(err && err.message || err))}</div>`;
            setStatus('AI tagging failed');
        }
    }

    // ═══════════════════════════════════════════════════
    //  TEXT FORMAT BAR
    // ═══════════════════════════════════════════════════

    // Track the currently selected text/image object for format bar
    let _selectedObj = null;

    function showContextualBar(obj) {
        hideContextualBars();
        _selectedObj = obj || null;
        if (!obj) return;
        const t = obj.type;
        if (t === 'i-text' || t === 'text' || t === 'textbox') {
            dom.textFormatBar.style.display = 'flex';
            syncTextFormatBar(obj);
        } else if (t === 'image') {
            dom.imageEditBar.style.display = 'flex';
            syncImageEditBar(obj);
        }
    }

    function hideContextualBars() {
        _selectedObj = null;
        dom.textFormatBar.style.display = 'none';
        dom.imageEditBar.style.display = 'none';
    }
    // Exposed so the ribbon (adobe-ui.js) can dismiss a lingering formatting bar
    // when the user switches ribbon groups (B3).
    window.hideEditorContextBars = function () { try { hideContextualBars(); } catch (_) {} };

    // Sync bar state to match the selected text object's current properties
    function syncTextFormatBar(obj) {
        dom.tbBold.classList.toggle('active', obj.fontWeight === 'bold');
        dom.tbItalic.classList.toggle('active', obj.fontStyle === 'italic');
        dom.tbUnderline.classList.toggle('active', !!obj.underline);
        dom.tbStrike.classList.toggle('active', !!obj.linethrough);
        dom.tbFontSize.value = Math.round(obj.fontSize || 20);
        // If the object's font isn't one of the dropdown's presets (e.g. an
        // embedded PDF font), the <select> would render EMPTY (B6). Inject a
        // one-off option so the user can see and keep the original font.
        const fam = obj.fontFamily || 'Arial';
        const sel = dom.tbFontFamily;
        if (sel && ![...sel.options].some(o => o.value === fam)) {
            const opt = document.createElement('option');
            opt.value = fam;
            opt.textContent = fam + (obj._pdfFontName ? ' (original)' : '');
            opt.dataset.injected = '1';
            sel.insertBefore(opt, sel.firstChild);
        }
        // Drop any previously-injected option that no longer applies.
        if (sel) [...sel.options].forEach(o => { if (o.dataset.injected && o.value !== fam) o.remove(); });
        dom.tbFontFamily.value = fam;
        // Fabric fill can be a color string or rgba
        const fillColor = obj.fill || '#000000';
        if (fillColor.startsWith('#') && fillColor.length === 7) {
            dom.tbColor.value = fillColor;
        }
        // Alignment
        dom.tbAlignLeft.classList.toggle('active', obj.textAlign === 'left' || !obj.textAlign);
        dom.tbAlignCenter.classList.toggle('active', obj.textAlign === 'center');
        dom.tbAlignRight.classList.toggle('active', obj.textAlign === 'right');
    }

    function applyTextProp(props) {
        if (!fabricCanvas) return;
        const active = fabricCanvas.getActiveObjects();
        if (!active.length) return;
        active.forEach((obj) => {
            const t = obj.type;
            if (t === 'i-text' || t === 'text' || t === 'textbox') {
                obj.set(props);
                // While typing, fabric applies per-character styles — update
                // them too or the change is invisible until editing ends.
                if (obj.isEditing && obj.setSelectionStyles) {
                    if (obj.selectionStart !== obj.selectionEnd) obj.setSelectionStyles(props);
                    else if (obj.styles) obj.styles = {};
                }
            }
        });
        fabricCanvas.renderAll();
        saveAnnotationState();
        // Re-sync bar
        if (_selectedObj) syncTextFormatBar(active[0]);
    }

    function setupTextFormatBar() {
        dom.tbBold.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            applyTextProp({ fontWeight: (obj && obj.fontWeight === 'bold') ? 'normal' : 'bold' });
        });
        dom.tbItalic.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            applyTextProp({ fontStyle: (obj && obj.fontStyle === 'italic') ? 'normal' : 'italic' });
        });
        dom.tbUnderline.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            applyTextProp({ underline: !(obj && obj.underline) });
        });
        dom.tbStrike.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            applyTextProp({ linethrough: !(obj && obj.linethrough) });
        });
        dom.tbFontSize.addEventListener('change', () => {
            const size = Math.max(6, Math.min(300, parseInt(dom.tbFontSize.value, 10) || 20));
            dom.tbFontSize.value = size;
            applyTextProp({ fontSize: size });
        });
        dom.tbFontDec.addEventListener('click', () => {
            const cur = parseInt(dom.tbFontSize.value, 10) || 20;
            const next = Math.max(6, cur - 2);
            dom.tbFontSize.value = next;
            applyTextProp({ fontSize: next });
        });
        dom.tbFontInc.addEventListener('click', () => {
            const cur = parseInt(dom.tbFontSize.value, 10) || 20;
            const next = Math.min(300, cur + 2);
            dom.tbFontSize.value = next;
            applyTextProp({ fontSize: next });
        });
        dom.tbFontFamily.addEventListener('change', () => {
            applyTextProp({ fontFamily: dom.tbFontFamily.value });
        });
        dom.tbColor.addEventListener('input', () => {
            applyTextProp({ fill: dom.tbColor.value });
        });
        dom.tbAlignLeft.addEventListener('click', () => applyTextProp({ textAlign: 'left' }));
        dom.tbAlignCenter.addEventListener('click', () => applyTextProp({ textAlign: 'center' }));
        dom.tbAlignRight.addEventListener('click', () => applyTextProp({ textAlign: 'right' }));
        dom.tbAiEdit.addEventListener('click', openAiEditModal);
    }

    // ═══════════════════════════════════════════════════
    //  IMAGE EDIT BAR
    // ═══════════════════════════════════════════════════

    function syncImageEditBar(obj) {
        dom.ibOpacity.value = Math.round((obj.opacity || 1) * 100);
        dom.ibOpacityVal.textContent = dom.ibOpacity.value + '%';
    }

    function setupImageEditBar() {
        dom.ibFlipH.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            obj.set({ flipX: !obj.flipX });
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        dom.ibFlipV.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            obj.set({ flipY: !obj.flipY });
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        const ibRotate = document.getElementById('ibRotate');
        if (ibRotate) ibRotate.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            obj.rotate(((obj.angle || 0) + 90) % 360);
            obj.setCoords();
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        const ibBorder = document.getElementById('ibBorder');
        if (ibBorder) ibBorder.addEventListener('change', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            const w = parseInt(ibBorder.value, 10);
            obj.set(w ? { stroke: '#111111', strokeWidth: w } : { stroke: null, strokeWidth: 0 });
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        dom.ibOpacity.addEventListener('input', () => {
            const val = parseInt(dom.ibOpacity.value, 10);
            dom.ibOpacityVal.textContent = val + '%';
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            obj.set({ opacity: val / 100 });
            fabricCanvas.renderAll();
        });
        dom.ibOpacity.addEventListener('change', () => saveAnnotationState());
        dom.ibBringFront.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            fabricCanvas.bringToFront(obj);
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        dom.ibSendBack.addEventListener('click', () => {
            const obj = fabricCanvas && fabricCanvas.getActiveObject();
            if (!obj) return;
            fabricCanvas.sendToBack(obj);
            fabricCanvas.renderAll();
            saveAnnotationState();
        });
        dom.ibCrop.addEventListener('click', () => {
            showToast('Select crop tool, draw area, then click Apply Crop');
            setActiveTool('crop');
        });
    }

    // ═══════════════════════════════════════════════════
    //  AI TEXT EDIT MODAL
    // ═══════════════════════════════════════════════════

    let _aiEditTargetObj = null;

    function setupAiEditModal() {
        dom.closeAiEditModal.addEventListener('click', closeAiEditModal);
        dom.aiEditModal.addEventListener('click', (e) => {
            if (e.target === dom.aiEditModal) closeAiEditModal();
        });
        dom.aiEditCancelBtn.addEventListener('click', closeAiEditModal);
        dom.aiEditRewriteBtn.addEventListener('click', runAiTextRewrite);
        dom.aiEditApplyBtn.addEventListener('click', applyAiTextRewrite);
        dom.aiEditInstruction.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runAiTextRewrite();
            }
        });
    }

    function openAiEditModal() {
        const obj = fabricCanvas && fabricCanvas.getActiveObject();
        if (!obj || (obj.type !== 'i-text' && obj.type !== 'text' && obj.type !== 'textbox')) {
            showToast('Select a text object first');
            return;
        }
        if (!state.ollamaOnline) {
            showToast('Ollama is offline — start it first');
            return;
        }
        _aiEditTargetObj = obj;
        // Warm the model up now (while the user types the instruction) so the
        // actual rewrite starts instantly instead of waiting on a cold load.
        warmUpOllama(dom.aiModelSelect.value);
        dom.aiEditOriginalText.textContent = obj.text || '';
        dom.aiEditInstruction.value = '';
        dom.aiEditResultSection.style.display = 'none';
        dom.aiEditFooter.style.display = 'none';
        dom.aiEditResultText.value = '';
        dom.aiEditRewriteBtn.disabled = false;
        dom.aiEditRewriteBtn.textContent = 'Rewrite with AI';
        dom.aiEditModal.style.display = 'flex';
        dom.aiEditInstruction.focus();
    }

    function closeAiEditModal() {
        dom.aiEditModal.style.display = 'none';
        _aiEditTargetObj = null;
    }

    async function runAiTextRewrite() {
        const instruction = dom.aiEditInstruction.value.trim();
        if (!instruction) { showToast('Enter an instruction first'); return; }
        if (!_aiEditTargetObj) { closeAiEditModal(); return; }

        const originalText = _aiEditTargetObj.text || '';
        dom.aiEditRewriteBtn.disabled = true;
        dom.aiEditRewriteBtn.textContent = 'Rewriting...';
        // Show the result box immediately and stream tokens into it so the user
        // sees progress right away instead of waiting for the whole response.
        dom.aiEditResultSection.style.display = 'block';
        dom.aiEditFooter.style.display = 'none';
        dom.aiEditResultText.value = '';

        try {
            const model = dom.aiModelSelect.value || 'mistral';
            const prompt = `You are a text editor assistant. Rewrite the following text exactly as instructed. Return ONLY the rewritten text — no explanations, no quotes, no labels.

Instruction: ${instruction}

Text to rewrite:
${originalText}

Rewritten text:`;

            // Stream the response into the textarea as it generates.
            const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model, prompt, stream: true, keep_alive: '30m',
                    options: { temperature: 0.3, num_predict: 400, top_k: 30, top_p: 0.9 },
                }),
            });
            if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let full = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const line of decoder.decode(value, { stream: true }).split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.response) {
                            full += json.response;
                            dom.aiEditResultText.value = full.replace(/^["']|["']$/g, '');
                        }
                    } catch (_) { /* partial line */ }
                }
            }
            dom.aiEditResultText.value = full.trim().replace(/^["']|["']$/g, '');
            dom.aiEditFooter.style.display = 'flex';
        } catch (err) {
            showToast('AI error: ' + err.message);
        }

        dom.aiEditRewriteBtn.disabled = false;
        dom.aiEditRewriteBtn.textContent = 'Rewrite with AI';
    }

    function applyAiTextRewrite() {
        if (!_aiEditTargetObj || !fabricCanvas) return;
        const newText = dom.aiEditResultText.value;
        if (!newText.trim()) { showToast('Result is empty'); return; }
        _aiEditTargetObj.set({ text: newText });
        fabricCanvas.renderAll();
        saveAnnotationState();
        closeAiEditModal();
        showToast('Text updated');
    }

    // ═══════════════════════════════════════════════════
    //  AI PAGE TEXT REPLACE (stanza / paragraph edit)
    // ═══════════════════════════════════════════════════
    async function aiReplaceText() {
        const findText    = dom.aiReplaceFind.value.trim();
        const instruction = dom.aiReplaceInstruction.value.trim();

        if (!findText)    { showToast('Enter the text you want to find/change'); return; }
        if (!instruction) { showToast('Enter what to change it to or an instruction'); return; }
        if (!state.pdfDoc) { showToast('No PDF loaded'); return; }
        if (!state.ollamaOnline) { showToast('Ollama is offline'); return; }

        dom.aiReplaceBtn.disabled = true;
        dom.aiReplaceStatus.style.display = 'block';
        dom.aiReplaceStatus.textContent = 'Generating replacement...';

        try {
            // Ask AI to produce ONLY the replacement text, nothing else
            const model = dom.aiModelSelect.value || 'mistral';
            const prompt = `You are a precise text editor. Apply the instruction below to the given text.
Return ONLY the replacement text. No explanations, no quotes, no labels.

Instruction: ${instruction}

Text:
${findText}

Replacement:`;

            const replacement = (await ollamaQuick(prompt, model)).trim().replace(/^["']|["']$/g, '');

            if (!replacement) { showToast('AI returned empty result'); return; }

            // Ensure cache is ready
            if (!_textItemsCache) await buildTextItemsCache(state.currentPage);

            // Find all text items that together form the searched text
            // Strategy: look for items whose concatenated text contains the findText
            const matchEntries = findTextItemsForString(findText);

            if (matchEntries.length === 0) {
                dom.aiReplaceStatus.textContent = `⚠ Text not found on this page. Make sure it's copied exactly.`;
                dom.aiReplaceBtn.disabled = false;
                return;
            }

            // Compute bounding box that covers all matched items
            const minLeft   = Math.min(...matchEntries.map(e => e.bbox.left));
            const minTop    = Math.min(...matchEntries.map(e => e.bbox.top));
            const maxRight  = Math.max(...matchEntries.map(e => e.bbox.left + e.bbox.width));
            const maxBottom = Math.max(...matchEntries.map(e => e.bbox.top  + e.bbox.height));
            const totalW    = maxRight  - minLeft;
            const totalH    = maxBottom - minTop;

            // Use font of the FIRST matched item
            const detected  = detectPdfFont(matchEntries[0].item, matchEntries[0].fontSizePx);
            const bgColor   = sampleBgColor(dom.pdfCanvas, minLeft, minTop, totalW, totalH);
            const textColor = sampleTextColor(dom.pdfCanvas, minLeft, minTop, totalW, totalH) || detected.fill;

            // Cover all matched items with background-matched rectangles
            _isRestoring = true;
            matchEntries.forEach(e => {
                const fsp = e.fontSizePx || detected.fontSize;
                const ct  = Math.round(e.baseline - fsp * 1.05);
                const cb  = Math.round(e.baseline + fsp * 0.28);
                const cover = new fabric.Rect({
                    left:   Math.round(e.bbox.left) - 2,
                    top:    ct,
                    width:  Math.max(e.bbox.width, 10) + 4,
                    height: Math.max(cb - ct, fsp),
                    fill: bgColor, selectable: false, evented: false, _isTextCover: true,
                });
                fabricCanvas.add(cover);
            });
            _isRestoring = false;

            // Place replacement text aligned to the first item's baseline
            const firstEntry   = matchEntries[0];
            const firstFsp     = firstEntry.fontSizePx || detected.fontSize;
            const firstFabTop  = Math.round(firstEntry.baseline - firstFsp * 0.86);

            const editText = new fabric.Textbox(replacement, {
                left:        Math.round(minLeft),
                top:         firstFabTop,
                width:       Math.max(totalW, 80),
                fontSize:    firstFsp,
                fontFamily:  detected.fontFamily,
                fontWeight:  detected.fontWeight,
                fontStyle:   detected.fontStyle,
                lineHeight:  1,
                fill:        textColor,
                editable:    true,
                cursorColor: textColor,
                _isTextEdit: true,
            });

            fabricCanvas.add(editText);
            fabricCanvas.setActiveObject(editText);
            fabricCanvas.renderAll();
            saveAnnotationState();
            showContextualBar(editText);

            dom.aiReplaceStatus.textContent = `✓ Replaced ${matchEntries.length} text block(s). Click text to adjust.`;
            setStatus(`AI replaced: "${findText.substring(0, 30)}…"`);
            showToast('Text replaced on page');

        } catch (err) {
            console.error(err);
            dom.aiReplaceStatus.textContent = 'Error: ' + err.message;
            showToast('AI replace failed');
        }

        dom.aiReplaceBtn.disabled = false;
    }

    // Find cached text items whose combined text matches the search string
    function findTextItemsForString(searchStr) {
        if (!_textItemsCache || !searchStr) return [];
        const normalised = searchStr.replace(/\s+/g, ' ').trim().toLowerCase();

        // Build a sliding window over consecutive items and test if their
        // joined text contains the search string
        const results = [];
        const items = _textItemsCache;

        for (let start = 0; start < items.length; start++) {
            let combined = '';
            for (let end = start; end < Math.min(start + 40, items.length); end++) {
                combined += (combined ? ' ' : '') + items[end].item.str;
                if (combined.replace(/\s+/g, ' ').trim().toLowerCase().includes(normalised)) {
                    // Found: collect all items from start to end
                    for (let k = start; k <= end; k++) results.push(items[k]);
                    return results; // first match only
                }
            }
        }

        // Fallback: partial match on individual items
        for (const entry of items) {
            if (entry.item.str.toLowerCase().includes(normalised)) {
                return [entry];
            }
        }

        return [];
    }

    // ═══════════════════════════════════════════════════
    //  CONVERSIONS — Word → PDF and exact-look PDF → Word
    // ═══════════════════════════════════════════════════
    // pdf-lib standard fonts are WinAnsi-only — swap smart punctuation, drop the rest.
    const _winAnsi = (s) => String(s)
        .replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
        .replace(/\uFB03/g, 'ffi').replace(/\uFB04/g, 'ffl')
        .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
        .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
        .replace(/[^\x00-\xFF]/g, '?');

    // Inline nodes → styled runs [{text, bold, italic}]; lists/tables/images
    // are lifted out as their own blocks.
    function _runsOf(node, bold = false, italic = false, out = []) {
        for (const ch of node.childNodes) {
            if (ch.nodeType === 3) { if (ch.textContent) out.push({ text: ch.textContent, bold, italic }); continue; }
            if (ch.nodeType !== 1) continue;
            const tag = ch.tagName;
            if (tag === 'BR') { out.push({ text: '\n', bold, italic }); continue; }
            if (tag === 'IMG' || tag === 'UL' || tag === 'OL' || tag === 'TABLE') continue;
            _runsOf(ch, bold || tag === 'STRONG' || tag === 'B', italic || tag === 'EM' || tag === 'I', out);
        }
        return out;
    }
    const _imgsOf = (node) => [...node.querySelectorAll('img')].map(im => im.getAttribute('src')).filter(s => s && s.startsWith('data:'));

    // Flatten the mammoth HTML body into layout blocks.
    function _blocksOf(body) {
        const blocks = [];
        const push = (b) => { if (b) blocks.push(b); };
        const pushList = (listEl, depth) => {
            [...listEl.children].filter(li => li.tagName === 'LI').forEach((li, n) => {
                _imgsOf(li).forEach(src => push({ kind: 'img', src }));
                push({ kind: 'li', runs: _runsOf(li), depth,
                       marker: listEl.tagName === 'OL' ? `${n + 1}.` : depth ? '–' : '•' });
                [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL')
                    .forEach(sub => pushList(sub, depth + 1));
                [...li.children].filter(c => c.tagName === 'TABLE').forEach(t => pushTable(t));
            });
        };
        const pushTable = (el) => {
            const rows = [...el.querySelectorAll('tr')].map(tr =>
                [...tr.children].filter(c => /^T[DH]$/.test(c.tagName))
                    .map(c => ({ runs: _runsOf(c, c.tagName === 'TH') })));
            if (rows.length) push({ kind: 'table', rows });
            _imgsOf(el).forEach(src => push({ kind: 'img', src }));
        };
        const walk = (node) => {
            for (const el of node.children) {
                const tag = el.tagName;
                if (/^H[1-6]$/.test(tag)) push({ kind: 'h', level: Math.min(4, +tag[1]), runs: _runsOf(el, true) });
                else if (tag === 'P') { _imgsOf(el).forEach(src => push({ kind: 'img', src })); push({ kind: 'p', runs: _runsOf(el) }); }
                else if (tag === 'UL' || tag === 'OL') pushList(el, 0);
                else if (tag === 'TABLE') pushTable(el);
                else if (tag === 'IMG') { const src = el.getAttribute('src'); if (src && src.startsWith('data:')) push({ kind: 'img', src }); }
                else walk(el);
            }
        };
        walk(body);
        return blocks;
    }

    // Extract Word headers & footers from the .docx zip. mammoth ignores these
    // (they live in word/header*.xml / word/footer*.xml, not document.xml), so
    // we read them directly to carry over logos/company text/page furniture.
    // Returns { headerText, footerText, headerImg, footerImg } — img = {bytes,
    // type, w, h} (first image found in that region), text = concatenated runs.
    async function _extractDocxHeaderFooter(file) {
        const out = { headerText: '', footerText: '', headerImg: null, footerImg: null };
        try {
            if (!window.JSZip) await loadScript('libs/jszip.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/jszip@3/dist/jszip.min.js'));
            if (!window.JSZip) return out;
            const zip = await JSZip.loadAsync(await file.arrayBuffer());

            const readXml = async (path) => {
                const f = zip.file(path); if (!f) return null;
                return new DOMParser().parseFromString(await f.async('string'), 'application/xml');
            };
            const textOf = (xml) => {
                if (!xml) return '';
                return [...xml.getElementsByTagName('w:t')].map(t => t.textContent).join('').trim();
            };
            // Map an r:embed id → media bytes via the part's .rels file.
            const firstImage = async (partName, xml) => {
                if (!xml) return null;
                const blip = xml.getElementsByTagName('a:blip')[0];
                const embed = blip && (blip.getAttribute('r:embed') || blip.getAttribute('embed'));
                if (!embed) return null;
                const relsXml = await readXml('word/_rels/' + partName + '.rels');
                if (!relsXml) return null;
                let target = null;
                for (const rel of relsXml.getElementsByTagName('Relationship')) {
                    if (rel.getAttribute('Id') === embed) { target = rel.getAttribute('Target'); break; }
                }
                if (!target) return null;
                const mediaPath = ('word/' + target).replace('word/../', '').replace('word/word/', 'word/');
                const mf = zip.file(mediaPath) || zip.file('word/' + target.replace(/^\/+/, ''));
                if (!mf) return null;
                const bytes = await mf.async('uint8array');
                const type = /\.png$/i.test(target) ? 'png' : 'jpg';
                return { bytes, type };
            };

            // Find the header/footer part names referenced by the document.
            const findParts = (regex) => Object.keys(zip.files).filter(n => regex.test(n)).sort();
            const headerParts = findParts(/^word\/header\d*\.xml$/i);
            const footerParts = findParts(/^word\/footer\d*\.xml$/i);

            for (const p of headerParts) {
                const name = p.replace(/^word\//, '');
                const xml = await readXml(p);
                if (!out.headerText) out.headerText = textOf(xml);
                if (!out.headerImg) out.headerImg = await firstImage(name, xml);
                if (out.headerText || out.headerImg) break;
            }
            for (const p of footerParts) {
                const name = p.replace(/^word\//, '');
                const xml = await readXml(p);
                if (!out.footerText) out.footerText = textOf(xml);
                if (!out.footerImg) out.footerImg = await firstImage(name, xml);
                if (out.footerText || out.footerImg) break;
            }
        } catch (e) { console.warn('header/footer extraction failed', e); }
        return out;
    }

    // Word (.docx) → PDF, entirely client-side: mammoth → HTML → flow layout
    // with pdf-lib. Headings, bold/italic runs, lists, simple tables and inline
    // images survive (images are embedded as-is). Headers/footers (text + logo)
    // are extracted separately from the .docx zip and drawn on every page.
    async function convertWordToPdf(file) {
        setStatus('Converting Word to PDF...');
        try {
            if (!window.mammoth) await loadScript('libs/mammoth.browser.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'));
            const { PDFDocument, StandardFonts, rgb } = PDFLib;

            const { value: html } = await window.mammoth.convertToHtml(
                { arrayBuffer: await file.arrayBuffer() }, { convertImage: window.mammoth.images.imgElement((img) =>
                    img.read('base64').then(b64 => ({ src: 'data:' + img.contentType + ';base64,' + b64 })))
                });
            const body = new DOMParser().parseFromString(html, 'text/html').body;
            const blocks = _blocksOf(body);

            const PAGE_W = 612, PAGE_H = 792, MARGIN = 56, USABLE = PAGE_W - MARGIN * 2;
            const doc = await PDFDocument.create();
            const F = {
                r: await doc.embedFont(StandardFonts.Helvetica),
                b: await doc.embedFont(StandardFonts.HelveticaBold),
                i: await doc.embedFont(StandardFonts.HelveticaOblique),
                bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
            };
            const fontOf = (r) => r.bold && r.italic ? F.bi : r.bold ? F.b : r.italic ? F.i : F.r;
            const ink = rgb(0.07, 0.09, 0.15), lineCol = rgb(0.72, 0.75, 0.78);

            // Word header/footer (logo + text) — extracted from the .docx zip and
            // stamped on every page. Reserve vertical bands so the body doesn't
            // overlap them.
            const hf = await _extractDocxHeaderFooter(file);
            const embedImg = async (im) => {
                if (!im) return null;
                try {
                    const pi = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
                    return pi;
                } catch (_) { return null; }
            };
            const hImg = await embedImg(hf.headerImg);
            const fImg = await embedImg(hf.footerImg);
            const HF_IMG_MAX_H = 46;                    // cap logo height
            const hasHeader = !!(hImg || hf.headerText);
            const hasFooter = !!(fImg || hf.footerText);
            const TOP_BAND = hasHeader ? 60 : 0;        // extra space below top margin
            const BOT_BAND = hasFooter ? 44 : 0;        // extra space above bottom margin
            const topLimit = PAGE_H - MARGIN - TOP_BAND;
            const botLimit = MARGIN + BOT_BAND;

            const drawHeaderFooter = (pg) => {
                if (hImg) {
                    const s = Math.min(HF_IMG_MAX_H / hImg.height, (USABLE * 0.5) / hImg.width);
                    const w = hImg.width * s, h = hImg.height * s;
                    pg.drawImage(hImg, { x: MARGIN, y: PAGE_H - MARGIN - h + 6, width: w, height: h });
                }
                if (hf.headerText) {
                    pg.drawText(_winAnsi(hf.headerText).slice(0, 200), {
                        x: hImg ? PAGE_W - MARGIN - F.r.widthOfTextAtSize(_winAnsi(hf.headerText).slice(0, 60), 9) : MARGIN,
                        y: PAGE_H - MARGIN - 10, size: 9, font: F.r, color: rgb(0.4, 0.42, 0.48) });
                }
                if (hasHeader) pg.drawLine({ start: { x: MARGIN, y: topLimit + 8 }, end: { x: PAGE_W - MARGIN, y: topLimit + 8 }, thickness: 0.5, color: lineCol });
                if (fImg) {
                    const s = Math.min(HF_IMG_MAX_H / fImg.height, (USABLE * 0.4) / fImg.width);
                    const w = fImg.width * s, h = fImg.height * s;
                    pg.drawImage(fImg, { x: MARGIN, y: MARGIN - 4, width: w, height: h });
                }
                if (hf.footerText) {
                    pg.drawText(_winAnsi(hf.footerText).slice(0, 200), {
                        x: MARGIN, y: MARGIN + 6, size: 9, font: F.r, color: rgb(0.4, 0.42, 0.48) });
                }
                if (hasFooter) pg.drawLine({ start: { x: MARGIN, y: botLimit - 8 }, end: { x: PAGE_W - MARGIN, y: botLimit - 8 }, thickness: 0.5, color: lineCol });
            };

            let page = null, y = 0;
            const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); drawHeaderFooter(page); y = topLimit; };
            const ensure = (h) => { if (!page || y - h < botLimit) newPage(); };
            newPage();

            function wrapRuns(runs, size, width) {
                const lines = [[]]; let x = 0;
                for (const r of runs) {
                    const font = fontOf(r);
                    for (const tok of _winAnsi(r.text).split(/(\n|\s+)/)) {
                        if (!tok) continue;
                        if (tok === '\n') { lines.push([]); x = 0; continue; }
                        let w = font.widthOfTextAtSize(tok, size);
                        if (x + w > width && x > 0 && tok.trim()) { lines.push([]); x = 0; }
                        if (!tok.trim() && x === 0) continue;
                        let t = tok;
                        while (w > width && t.length > 1) {
                            let cut = t.length - 1;
                            while (cut > 1 && font.widthOfTextAtSize(t.slice(0, cut), size) > width) cut--;
                            lines[lines.length - 1].push({ text: t.slice(0, cut), font, size });
                            lines.push([]); x = 0;
                            t = t.slice(cut); w = font.widthOfTextAtSize(t, size);
                        }
                        lines[lines.length - 1].push({ text: t, font, size });
                        x += w;
                    }
                }
                return lines.filter((l, i) => l.length || i < lines.length - 1);
            }
            const drawLines = (lines, x0, size, lh) => {
                for (const line of lines) {
                    ensure(lh);
                    let x = x0;
                    for (const seg of line) {
                        page.drawText(seg.text, { x, y: y - size * 0.8, size, font: seg.font, color: ink });
                        x += seg.font.widthOfTextAtSize(seg.text, size);
                    }
                    y -= lh;
                }
            };

            for (const b of blocks) {
                if (b.kind === 'h') {
                    const size = [0, 19, 15.5, 13, 12][b.level] || 12;
                    const lines = wrapRuns(b.runs, size, USABLE);
                    if (!lines.length) continue;
                    ensure(size * 1.3 + 10); y -= 10;
                    drawLines(lines, MARGIN, size, size * 1.3);
                    y -= 4;
                } else if (b.kind === 'p') {
                    const lines = wrapRuns(b.runs, 11, USABLE);
                    if (!lines.length) { y -= 7; continue; }
                    drawLines(lines, MARGIN, 11, 16);
                    y -= 6;
                } else if (b.kind === 'li') {
                    const indent = 16 + (b.depth || 0) * 14;
                    const lines = wrapRuns(b.runs, 11, USABLE - indent);
                    if (!lines.length) continue;
                    ensure(16);
                    page.drawText(_winAnsi(b.marker), { x: MARGIN + 2 + (b.depth || 0) * 14, y: y - 11 * 0.8, size: 11, font: F.r, color: ink });
                    drawLines(lines, MARGIN + indent + 6, 11, 16);
                    y -= 2;
                } else if (b.kind === 'table') {
                    const cols = Math.max(1, ...b.rows.map(r => r.length));
                    const colW = USABLE / cols, pad = 4, size = 9.5, lh = 12.5;
                    const maxLines = Math.floor((PAGE_H - MARGIN * 2 - pad * 2) / lh);
                    for (const row of b.rows) {
                        const cellLines = row.map(c => wrapRuns(c.runs, size, colW - pad * 2).slice(0, maxLines));
                        const rowH = Math.max(lh, ...cellLines.map(ls => ls.length * lh)) + pad * 2;
                        ensure(rowH);
                        const top = y;
                        row.forEach((_, ci) => {
                            page.drawRectangle({ x: MARGIN + ci * colW, y: top - rowH, width: colW, height: rowH,
                                borderColor: lineCol, borderWidth: 0.7 });
                            let cy = top - pad;
                            for (const line of cellLines[ci]) {
                                let x = MARGIN + ci * colW + pad;
                                for (const seg of line) {
                                    page.drawText(seg.text, { x, y: cy - size * 0.8, size, font: seg.font, color: ink });
                                    x += seg.font.widthOfTextAtSize(seg.text, size);
                                }
                                cy -= lh;
                            }
                        });
                        y -= rowH;
                    }
                    y -= 8;
                } else if (b.kind === 'img') {
                    try {
                        const m = b.src.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
                        if (!m) continue;
                        const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
                        const emb = /png/i.test(m[1]) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
                        let w = Math.min(USABLE, emb.width * 0.72);
                        let h = w * (emb.height / emb.width);
                        if (h > PAGE_H - MARGIN * 2) { h = PAGE_H - MARGIN * 2; w = h * (emb.width / emb.height); }
                        ensure(h);
                        page.drawImage(emb, { x: MARGIN, y: y - h, width: w, height: h });
                        y -= h + 8;
                    } catch { /* skip images pdf-lib can't decode */ }
                }
            }

            const bytes = await doc.save();
            const pdfFile = new File([bytes], (file.name || 'document').replace(/\.docx?$/i, '') + '.pdf',
                { type: 'application/pdf' });
            await loadPDF(pdfFile);
            setStatus('Word converted to PDF — click "Download" (top left) to save it');
            showToast('Converted — click "Download" to save the PDF');
        } catch (err) {
            console.error(err);
            setStatus('Word conversion failed: ' + err.message);
            showToast('Could not convert that Word file');
        }
    }
    window.convertWordToPdf = convertWordToPdf;

    // Images (PNG/JPG) → PDF: one page per image, page sized to the image so
    // nothing is cropped or stretched. Opens in the editor for saving/editing.
    async function convertImagesToPdf(files) {
        const list = [...files].filter(f => /^image\/(png|jpe?g)$/i.test(f.type));
        if (!list.length) { showToast('Choose PNG or JPG images'); return; }
        setStatus('Converting image' + (list.length > 1 ? 's' : '') + ' to PDF...');
        try {
            const { PDFDocument } = PDFLib;
            const doc = await PDFDocument.create();
            for (const f of list) {
                const bytes = new Uint8Array(await f.arrayBuffer());
                const emb = /png/i.test(f.type) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
                // Cap page size at A4-ish width so huge photos don't make giant pages.
                const maxW = 1240; // ~A4 at 150dpi
                const scale = Math.min(1, maxW / emb.width);
                const w = emb.width * scale, h = emb.height * scale;
                const page = doc.addPage([w, h]);
                page.drawImage(emb, { x: 0, y: 0, width: w, height: h });
            }
            const bytes = await doc.save();
            const name = list.length === 1
                ? list[0].name.replace(/\.(png|jpe?g)$/i, '') + '.pdf' : 'images.pdf';
            await loadPDF(new File([bytes], name, { type: 'application/pdf' }));
            setStatus('Images converted — use Organize ▸ "Add Images" to add more, then "Save"');
            showToast('Converted — add more via Organize ▸ Add Images');
        } catch (err) {
            console.error(err);
            showToast('Could not convert those images');
        }
    }
    window.convertImagesToPdf = convertImagesToPdf;

    // Image → PDF dialog: pick images, review them as thumbnails, add more or
    // remove, then create the PDF. Gives the user control before converting.
    function imageToPdfDialog() {
        let picked = []; // File[]
        document.querySelector('.i2p-overlay')?.remove();
        const ov = document.createElement('div');
        ov.className = 'i2p-overlay';
        ov.innerHTML =
            '<div class="i2p-modal" role="dialog" aria-modal="true">' +
              '<div class="i2p-head">' +
                '<span class="i2p-title">Image → PDF</span>' +
                '<button class="i2p-x" title="Close">✕</button>' +
              '</div>' +
              '<div class="i2p-body">' +
                '<div class="i2p-empty">No images yet — add PNG or JPG images to build your PDF.</div>' +
                '<div class="i2p-grid"></div>' +
              '</div>' +
              '<div class="i2p-foot">' +
                '<button class="i2p-btn i2p-add">＋ Add images</button>' +
                '<span class="i2p-count"></span>' +
                '<button class="i2p-btn i2p-create" disabled>Create PDF</button>' +
              '</div>' +
              '<input type="file" class="i2p-input" accept="image/png,image/jpeg" multiple style="display:none">' +
            '</div>';
        document.body.appendChild(ov);
        const $ = (s) => ov.querySelector(s);
        const grid = $('.i2p-grid'), empty = $('.i2p-empty'), input = $('.i2p-input');
        const close = () => ov.remove();

        const render = () => {
            grid.innerHTML = '';
            empty.style.display = picked.length ? 'none' : 'block';
            $('.i2p-count').textContent = picked.length ? picked.length + ' image' + (picked.length > 1 ? 's' : '') : '';
            $('.i2p-create').disabled = !picked.length;
            picked.forEach((f, idx) => {
                const cell = document.createElement('div');
                cell.className = 'i2p-cell';
                const url = URL.createObjectURL(f);
                cell.innerHTML =
                    '<img src="' + url + '" alt="">' +
                    '<span class="i2p-n">' + (idx + 1) + '</span>' +
                    '<button class="i2p-del" title="Remove">✕</button>';
                cell.querySelector('img').onload = () => URL.revokeObjectURL(url);
                cell.querySelector('.i2p-del').addEventListener('click', () => { picked.splice(idx, 1); render(); });
                grid.appendChild(cell);
            });
        };

        input.addEventListener('change', (e) => {
            const imgs = [...(e.target.files || [])].filter(f => /^image\/(png|jpe?g)$/i.test(f.type));
            picked = picked.concat(imgs);
            e.target.value = '';
            render();
        });
        $('.i2p-add').addEventListener('click', () => input.click());
        $('.i2p-x').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        $('.i2p-create').addEventListener('click', async () => {
            if (!picked.length) return;
            close();
            await convertImagesToPdf(picked);
        });

        // Open the file picker immediately so the flow feels one-step.
        input.click();
    }
    window.imageToPdfDialog = imageToPdfDialog;

    // Append one or more images as new pages at the END of the currently open
    // PDF. Lets a user add photos/scans to an existing document (or to a PDF
    // they just built from images) without starting over.
    async function appendImagesAsPages(files) {
        if (!state.pdfDoc || !state.pdfBytes) { showToast('Open a PDF first'); return; }
        const list = [...files].filter(f => /^image\/(png|jpe?g)$/i.test(f.type));
        if (!list.length) { showToast('Choose PNG or JPG images'); return; }
        setStatus('Adding ' + list.length + ' image' + (list.length > 1 ? 's' : '') + ' to the PDF...');
        try {
            const { PDFDocument } = PDFLib;
            const src = state.pdfBytes instanceof ArrayBuffer ? new Uint8Array(state.pdfBytes) : state.pdfBytes;
            const doc = await PDFDocument.load(src, { ignoreEncryption: true });
            for (const f of list) {
                const bytes = new Uint8Array(await f.arrayBuffer());
                const emb = /png/i.test(f.type) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
                const maxW = 1240;
                const scale = Math.min(1, maxW / emb.width);
                const w = emb.width * scale, h = emb.height * scale;
                const page = doc.addPage([w, h]);
                page.drawImage(emb, { x: 0, y: 0, width: w, height: h });
            }
            const out = await doc.save();
            await loadPDF(new File([out], state.fileName || 'document.pdf', { type: 'application/pdf' }));
            setStatus('Added ' + list.length + ' image page' + (list.length > 1 ? 's' : '') + ' — click "Save" to keep them');
            showToast('Images added as new pages');
        } catch (err) {
            console.error(err);
            showToast('Could not add those images');
        }
    }
    window.appendImagesAsPages = appendImagesAsPages;

    // PDF → Word (exact look): every page goes into the .docx as a full-width
    // image, so layout, fonts and images are preserved EXACTLY as in the PDF.
    // (Text is not editable in this mode — use the editable export for that.)
    async function exportWordExact() {
        if (!state.pdfDoc) { showToast('Open a PDF first'); return; }
        setStatus('Exporting exact-look Word...');
        try {
            if (!window.docx) await loadScript('libs/docx.umd.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/docx@8/build/index.umd.js'));
            const children = [];
            for (let i = 1; i <= state.totalPages; i++) {
                setStatus('Rendering page ' + i + '/' + state.totalPages + '...');
                const page = await state.pdfDoc.getPage(i);
                const vp = page.getViewport({ scale: 2 });
                const canvas = document.createElement('canvas');
                canvas.width = vp.width; canvas.height = vp.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
                const b64 = canvas.toDataURL('image/png').split(',')[1];
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const wPx = 690, hPx = Math.round(wPx * vp.height / vp.width);
                children.push(new docx.Paragraph({
                    children: [new docx.ImageRun({ data: bytes, transformation: { width: wPx, height: hPx } })],
                    ...(i > 1 ? { pageBreakBefore: true } : {}),
                }));
            }
            const doc = new docx.Document({
                sections: [{
                    properties: { page: { margin: { top: 360, bottom: 360, left: 360, right: 360 } } },
                    children,
                }],
            });
            const blob = await docx.Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.fileName.replace(/\.pdf$/i, '') + '.docx';
            a.click();
            URL.revokeObjectURL(url);
            setStatus('Exported exact-look Word document');
            showToast('Saved as Word (exact look)');
        } catch (err) {
            console.error(err);
            setStatus('Export failed: ' + err.message);
            showToast('Word export failed');
        }
    }
    window.exportWordExact = exportWordExact;

    // PDF → Word (smart, single option): editable text with per-run font size
    // and bold preserved; pages with no extractable text (scans) are inserted
    // as exact page images so nothing is ever lost.
    // Extract embedded raster images from a pdf.js page as {bytes, x, y, w, h}
    // (positions in PDF points, y from top). Used by PDF→Word so photos/logos
    // in mixed text+image pages carry over instead of being dropped.
    async function _extractPageImages(page) {
        const out = [];
        try {
            const ops = await page.getOperatorList();
            const vp = page.getViewport({ scale: 1 });
            const OPS = pdfjsLib.OPS;
            for (let i = 0; i < ops.fnArray.length; i++) {
                const fn = ops.fnArray[i];
                if (fn !== OPS.paintImageXObject && fn !== OPS.paintJpegXObject) continue;
                const name = ops.argsArray[i][0];
                let img = null;
                try { img = page.objs.get(name); } catch (_) { continue; }
                if (!img || !img.width || !img.height) continue;
                // rebuild the current transform matrix isn't tracked simply;
                // approximate placement using the image's own size at natural
                // scale, laid out in reading order (good enough for Word flow).
                let bytes = null;
                try {
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    const cx = c.getContext('2d');
                    if (img.bitmap) { cx.drawImage(img.bitmap, 0, 0); }
                    else if (img.data) {
                        const id = cx.createImageData(img.width, img.height);
                        const src = img.data, kind = img.kind;
                        if (kind === 3 || src.length === img.width * img.height * 4) { id.data.set(src); }
                        else if (kind === 2 || src.length === img.width * img.height * 3) {
                            for (let p = 0, q = 0; p < src.length; p += 3, q += 4) { id.data[q]=src[p]; id.data[q+1]=src[p+1]; id.data[q+2]=src[p+2]; id.data[q+3]=255; }
                        } else { // grayscale
                            for (let p = 0, q = 0; p < src.length; p++, q += 4) { id.data[q]=id.data[q+1]=id.data[q+2]=src[p]; id.data[q+3]=255; }
                        }
                        cx.putImageData(id, 0, 0);
                    } else continue;
                    const b64 = c.toDataURL('image/png').split(',')[1];
                    bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
                } catch (_) { continue; }
                if (bytes && bytes.length) out.push({ bytes, w: img.width, h: img.height });
            }
        } catch (_) {}
        return out;
    }

    async function exportWordSmart() {
        if (!state.pdfDoc) { showToast('Open a PDF first'); return; }
        setStatus('Exporting to Word...');
        try {
            if (!window.docx) await loadScript('libs/docx.umd.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/docx@8/build/index.umd.js'));
            const children = [];

            // Editable mode. Layout reconstruction based on pdf2docx's published
            // heuristics (Y-clustering for lines, free-space ratios for paragraph
            // vs line breaks, X-cluster columns for tables). Fully editable text;
            // layout is approximate — a browser can't match Adobe exactly.
            const previewUrls = null;
            const AL = docx.AlignmentType;
            for (let i = 1; i <= state.totalPages; i++) {
                setStatus('Converting page ' + i + '/' + state.totalPages + '...');
                const page = await state.pdfDoc.getPage(i);
                const pageW = page.getViewport({ scale: 1 }).width;
                const tc = await page.getTextContent();
                const items = (tc.items || []).filter(it => it.str && it.str.trim());
                if (!items.length) {
                    if (i < state.totalPages) children.push(new docx.Paragraph({ children: [], pageBreakBefore: true }));
                    continue;
                }

                // 1) Build lines: cluster items by baseline y, then merge fragments
                //    that are horizontally adjacent (gap < font width) into words so
                //    paragraph/column detection isn't scrambled by split glyphs.
                const rawLines = [];
                for (const it of items) {
                    const y = it.transform[5], x = it.transform[4];
                    const size = Math.max(6, Math.hypot(it.transform[2], it.transform[3]));
                    const fn = it.fontName || '';
                    const bold = /bold|black|heavy|semi|demi/i.test(fn);
                    const italic = /italic|oblique|-it\b|it$/i.test(fn);
                    const w = it.width || (it.str.length * size * 0.5);
                    const L = rawLines.find(l => Math.abs(l.y - y) < Math.max(2, size * 0.4));
                    const frag = { x, xEnd: x + w, str: it.str, size, bold, italic };
                    if (L) { L.frags.push(frag); L.y = (L.y + y) / 2; }
                    else rawLines.push({ y, frags: [frag] });
                }
                rawLines.sort((a, b) => b.y - a.y);
                // Per line: sort by x, compute segments (fragments separated by a big
                // gap → candidate table cells), plus geometry for alignment.
                const lines = rawLines.map(l => {
                    l.frags.sort((a, b) => a.x - b.x);
                    const size = l.frags[0].size;
                    const segs = [];
                    let cur = { text: l.frags[0].str, x0: l.frags[0].x, x1: l.frags[0].xEnd,
                                bold: l.frags[0].bold, italic: l.frags[0].italic, size };
                    for (let k = 1; k < l.frags.length; k++) {
                        const f = l.frags[k];
                        if (f.x - cur.x1 > size * 1.4) { segs.push(cur); cur = { text: f.str, x0: f.x, x1: f.xEnd, bold: f.bold, italic: f.italic, size: f.size }; }
                        else { cur.text += (cur.text.endsWith(' ') || f.str.startsWith(' ') ? '' : ' ') + f.str; cur.x1 = f.xEnd; cur.bold = cur.bold && f.bold; }
                    }
                    segs.push(cur);
                    const x0 = l.frags[0].x, x1 = l.frags[l.frags.length - 1].xEnd;
                    return { y: l.y, size, segs, x0, x1 };
                });

                // 2) Median font size + line height for heading/paragraph thresholds.
                const sizes = lines.map(l => l.size).sort((a, b) => a - b);
                const medSize = sizes[Math.floor(sizes.length / 2)] || 12;
                const gaps = [];
                for (let k = 1; k < lines.length; k++) gaps.push(lines[k - 1].y - lines[k].y);
                gaps.sort((a, b) => a - b);
                const lineH = gaps[Math.floor(gaps.length / 2)] || medSize * 1.2;

                const pageImages = await _extractPageImages(page);

                const alignOf = (l) => {
                    const leftGap = l.x0, rightGap = pageW - l.x1, span = l.x1 - l.x0;
                    if (span > pageW * 0.6) return AL.JUSTIFIED;
                    if (Math.abs(leftGap - rightGap) < pageW * 0.08 && leftGap > pageW * 0.12) return AL.CENTER;
                    if (rightGap < pageW * 0.12 && leftGap > pageW * 0.25) return AL.RIGHT;
                    return AL.LEFT;
                };

                // 3) Emit table (accumulated rows) as a Word table with column
                //    clustering so cells line up even when x drifts slightly.
                let tableRows = null;
                const flushTable = () => {
                    if (!tableRows || tableRows.length < 2) {
                        // Not enough rows to be a real table → fall back to paragraphs.
                        if (tableRows) for (const r of tableRows) children.push(new docx.Paragraph({
                            children: [new docx.TextRun({ text: r.map(c => c.text).join('   '), size: Math.round(medSize * 2) })],
                        }));
                        tableRows = null; return;
                    }
                    // Cluster all cell x0 across rows into column anchors (tol = medSize).
                    const anchors = [];
                    tableRows.forEach(r => r.forEach(c => {
                        const a = anchors.find(v => Math.abs(v - c.x0) < medSize * 1.2);
                        if (a === undefined) anchors.push(c.x0);
                    }));
                    anchors.sort((a, b) => a - b);
                    const colOf = (x0) => { let best = 0, bd = 1e9; anchors.forEach((a, idx) => { const d = Math.abs(a - x0); if (d < bd) { bd = d; best = idx; } }); return best; };
                    const grid = tableRows.map(r => { const row = Array(anchors.length).fill(''); r.forEach(c => { const ci = colOf(c.x0); row[ci] = (row[ci] ? row[ci] + ' ' : '') + c.text; }); return row; });
                    children.push(new docx.Table({
                        width: { size: 100, type: docx.WidthType.PERCENTAGE },
                        rows: grid.map(row => new docx.TableRow({
                            children: row.map(txt => new docx.TableCell({
                                children: [new docx.Paragraph({ children: [new docx.TextRun({ text: txt.trim(), size: Math.round(medSize * 2) })] })],
                            })),
                        })),
                    }));
                    tableRows = null;
                };

                // 4) Walk lines, joining wrapped lines into paragraphs by the
                //    free-space ratio; route multi-column lines to the table buffer.
                let para = null;
                const flushPara = () => {
                    if (!para) return;
                    children.push(new docx.Paragraph({
                        alignment: para.align,
                        spacing: { after: 60 },
                        children: para.runs.map(r => new docx.TextRun({
                            text: r.text, bold: r.bold, italics: r.italic,
                            size: Math.max(12, Math.min(96, Math.round(r.size * 2))),
                        })),
                    }));
                    para = null;
                };

                for (let li = 0; li < lines.length; li++) {
                    const l = lines[li];
                    const isTableRow = l.segs.length >= 2 && l.segs.some((s, k) => k > 0 && (s.x0 - l.segs[k - 1].x1) > l.size * 2);
                    if (isTableRow) { flushPara(); if (!tableRows) tableRows = []; tableRows.push(l.segs); continue; }
                    flushTable();

                    const prev = lines[li - 1];
                    const gap = prev ? (prev.y - l.y) : lineH;
                    const isHeading = l.size > medSize * 1.15 && l.segs.length === 1;
                    // New paragraph if: big vertical gap (>0.85 line-height beyond
                    // normal), a heading, or an alignment change.
                    const startNew = !para || isHeading || gap > lineH * 1.6;
                    const align = alignOf(l);
                    if (startNew) { flushPara(); para = { align, runs: [] }; }
                    // Append this line's segments as runs; keep a space at wraps.
                    for (const s of l.segs) {
                        const prevRun = para.runs[para.runs.length - 1];
                        if (prevRun && prevRun.bold === s.bold && prevRun.italic === s.italic && Math.round(prevRun.size) === Math.round(s.size)) {
                            prevRun.text += (prevRun.text.endsWith(' ') ? '' : ' ') + s.text;
                        } else para.runs.push({ text: s.text, bold: s.bold || isHeading, italic: s.italic, size: s.size });
                    }
                }
                flushPara();
                flushTable();

                for (const im of pageImages) {
                    const w = Math.min(620, im.w);
                    const h = Math.round(w * (im.h / im.w));
                    children.push(new docx.Paragraph({ children: [new docx.ImageRun({ data: im.bytes, transformation: { width: w, height: h } })] }));
                }
                if (i < state.totalPages) children.push(new docx.Paragraph({ children: [], pageBreakBefore: true }));
            }

            const doc = new docx.Document({
                sections: [{ children }],
            });
            const blob = await docx.Packer.toBlob(doc);
            const fileName = state.fileName.replace(/\.pdf$/i, '') + '.docx';
            setStatus('Word ready — preview');
            // Don't auto-download: show how the Word file will look first, then
            // let the user download from the preview. The preview shows the exact
            // page images that were embedded in the .docx.
            await showWordPreview(blob, fileName, previewUrls);
        } catch (err) {
            console.error(err);
            setStatus('Word export failed: ' + err.message);
            showToast('Word export failed');
        }
    }
    window.exportWordSmart = exportWordSmart;

    // Preview the generated .docx before saving. Shows the exact page images
    // that were embedded, so what you see is what the Word file contains.
    // Downloads only when the user clicks Download — no more silent auto-save.
    async function showWordPreview(blob, fileName, previewUrls) {
        const dl = () => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fileName; a.click();
            URL.revokeObjectURL(url);
            setStatus('Saved ' + fileName);
            showToast('Saved as Word document');
        };

        // Editable mode: render the real .docx to HTML via mammoth so the preview
        // reflects the actual Word content (text, tables, images). (Image-mode
        // passes previewUrls and shows those directly.)
        let bodyHtml, wrap = true;
        if (previewUrls && previewUrls.length) {
            bodyHtml = previewUrls
                .map(u => '<img class="word-preview-pageimg" src="' + u + '" alt="page">')
                .join('');
            wrap = false;
        } else {
            bodyHtml = '<p style="color:#888">Preview unavailable — you can still download.</p>';
            try {
                if (!window.mammoth) await loadScript('libs/mammoth.browser.min.js').catch(() => {});
                if (window.mammoth) {
                    const buf = await blob.arrayBuffer();
                    const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
                    if (res && res.value) bodyHtml = res.value;
                }
            } catch (e) { console.warn('Word preview render failed', e); }
        }
        const inner = wrap ? '<div class="word-preview-page">' + bodyHtml + '</div>' : bodyHtml;

        const ov = document.createElement('div');
        ov.className = 'word-preview-overlay';
        ov.innerHTML =
            '<div class="word-preview-modal">' +
              '<div class="word-preview-head">' +
                '<span class="word-preview-title">Word preview — ' + escapeHtml(fileName) + '</span>' +
                '<div class="word-preview-actions">' +
                  '<button class="wp-btn wp-cancel">Close</button>' +
                  '<button class="wp-btn wp-download">Download .docx</button>' +
                '</div>' +
              '</div>' +
              '<div class="word-preview-body">' + inner + '</div>' +
            '</div>';
        document.body.appendChild(ov);
        const close = () => ov.remove();
        ov.querySelector('.wp-cancel').addEventListener('click', close);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        ov.querySelector('.wp-download').addEventListener('click', () => { dl(); close(); });
    }

    // Expose downloadPDF globally so the menu can call it
    window.downloadPDF = downloadPDF;
    // Expose loadPDF so the landing page's Recent Files can reopen documents
    window.loadPdfFile = loadPDF;

    // Test hooks — exposed ONLY when the window is loaded with ?testhooks
    // (the automated suite in tests/ uses them; never active for users).
    if (location.search.includes('testhooks')) {
        window.__hooks = {
            fabric: () => fabricCanvas,
            contentSnap: (p) => _contentSnap(p),   // test probe for Snap to Content
            measures: () => fabricCanvas.getObjects().filter(o => o._measure).map(o => o._measure),
            scaleState: () => ({ scale: measureScale, unit: measureUnit, locked: _scaleLocked, stored: { ..._pageScales } }),
            addObj: (o) => { fabricCanvas.add(o); fabricCanvas.renderAll(); saveAnnotationState(); },
            rect: (opts) => new fabric.Rect(opts),
            ellipse: (opts) => new fabric.Ellipse(opts),
            itext: (t, opts) => new fabric.IText(t, opts),
            goto: (n) => renderPage(n),
            thumbs: () => generateThumbnails(),   // test probe for B8
            save: () => downloadPDF(),
            state: () => ({ page: state.currentPage, total: state.totalPages, zoom: state.zoom }),
            pdfDoc: () => state.pdfDoc,
            pdfBytes: () => state.pdfBytes,
            author: async () => { const d = await PDFLib.PDFDocument.load(new Uint8Array(state.pdfBytes), { ignoreEncryption: true }); return d.getAuthor(); },
        };
    }

    // ── Start ──
    init();
    // Announce the landing state to the Nexus shell so it shows the top bar on
    // the welcome screen (a document open later posts hasDoc:true).
    try { window.parent && window.parent.postMessage({ type: 'pdf-editor:doc-state', hasDoc: false }, '*'); } catch (_) {}
})();
