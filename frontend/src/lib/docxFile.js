// Is this file a Word document? One predicate, shared by every upload gate
// that has to route a .docx somewhere other than the PDF path.
//
// This is all that remains of the old lib/docx2pdf.js. That module also
// exported a client-side mammoth -> pdf-lib Word converter which
// re-laid Word documents onto hardcoded US-Letter pages with the two standard
// PDF fonts: an A4 contract in Calibri came out Letter-sized in Helvetica,
// with every character outside Latin-1 replaced by "?" - and then that was
// what people signed. Word -> PDF now happens server-side through a real
// layout engine (backend/services/docx_convert.py, reached via
// api.convertDocxToPdf) or not at all. Sagar, Sep 16: "0 alterations means 0."
//
// Name AND mime, because both lie on their own: a file picker can hand back a
// .docx with an empty type, and some sources set the Word mime on a file whose
// name has no extension.
export const isDocx = (fl) => !!fl && (/\.docx$/i.test(fl.name || '')
  || fl.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
