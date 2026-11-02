// CVE-2024-4367: a crafted font could run script through pdf.js's eval-based
// glyph path. The engine opens documents from many places, so the guard sits in
// one spot: this wraps pdfjsLib.getDocument before app.js starts, and every call
// from every file gets isEvalSupported: false. Add other pdf.js open options
// here too, never at a single call.
(function () {
    'use strict';
    const lib = window.pdfjsLib;
    const paramsOf = (src) => {
        if (typeof src === 'string' || src instanceof URL) return { url: src };
        if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return { data: src };
        return src;
    };
    window.pdfjsLib = Object.create(lib, {
        getDocument: {
            enumerable: true,
            value: (src) => lib.getDocument({ ...paramsOf(src), isEvalSupported: false }),
        },
    });
})();
