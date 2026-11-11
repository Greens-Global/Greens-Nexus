// pdf.js for every screen that draws or reads a PDF - Nexus Sign, the PDF
// editor, KB import, a board's PDF page. ALWAYS the legacy build (11/12/2026):
// pdf.js 6's modern build calls Map.prototype.getOrInsertComputed, which older
// phone browsers do not have, so a time sheet never drew and the employee
// could not sign ("this[#t].getOrInsertComputed is not a function"). The
// legacy build carries its own polyfills, in the page and in its worker.
// Never import 'pdfjs-dist' directly - come through here.
export async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  }
  return pdfjs;
}
