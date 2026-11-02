// CVE-2024-4367: a crafted font could run script through pdf.js's eval-based
// glyph path. The engine opens documents from many places, so the guard sits in
// one spot: this wraps pdfjsLib.getDocument before app.js starts, and every call
// from every file gets isEvalSupported: false. Add other pdf.js open options
// here too, never at a single call.
(function () {
    'use strict';
    const lib = window.pdfjsLib;
    // JPEG 2000, JBIG2 and color-profile decoders ship as wasm beside the library.
    const wasmUrl = new URL('libs/pdfjs-wasm/', document.baseURI).href;
    const paramsOf = (src) => {
        if (typeof src === 'string' || src instanceof URL) return { url: src };
        if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return { data: src };
        return src;
    };
    // pdf.js 6 moved destroy() from the document to its loading task. The engine
    // calls doc.destroy() to free the worker; without this it would leak one per reload.
    const withDestroy = (task) => {
        const opened = task.promise.then((doc) => {
            if (!doc.destroy) doc.destroy = () => task.destroy();
            return doc;
        });
        Object.defineProperty(task, 'promise', { value: opened });
        return task;
    };
    window.pdfjsLib = Object.create(lib, {
        getDocument: {
            enumerable: true,
            value: (src) => withDestroy(lib.getDocument({ ...paramsOf(src), isEvalSupported: false, wasmUrl })),
        },
    });
})();
