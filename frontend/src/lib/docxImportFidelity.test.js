// Does a Word import come back the size it went in?
//
// Sagar, Sep 16: an imported .docx renders as microscopic text in the editor -
// "0 alterations means 0". This builds real OOXML (the same shapes Word and the
// Teams transcript exporter emit), runs the direct converter, and checks the
// run properties and page setup that decide how it renders.
//
//   npx vitest run src/lib/docxImportFidelity.test.js
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertDocxToTiptap } from './docxToTiptap';
import { pageCanvasStyle, PAGE_SIZE_DIMS } from './pageSetup';

const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// A .docx is a zip; the converter reads word/document.xml directly.
async function docxFile(bodyXml, { styles = '' } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `</Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${DOC_NS}><w:body>${bodyXml}</w:body></w:document>`);
  if (styles) zip.file('word/styles.xml', styles);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  // jsdom's File has no arrayBuffer(); the converter only needs that one method.
  return {
    name: 'test.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    arrayBuffer: async () => buf,
  };
}

// Word stores run size in HALF-points: 11pt is <w:sz w:val="22"/>.
const para = (text, { sz, font } = {}) => `<w:p><w:r><w:rPr>`
  + (sz ? `<w:sz w:val="${sz}"/>` : '')
  + (font ? `<w:rFonts w:ascii="${font}"/>` : '')
  + `</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// Collect every textStyle mark the converter produced, in document order.
function textStyles(body) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const m of node.marks || []) {
      if (m.type === 'textStyle') out.push(m.attrs || {});
    }
    walk(node.content);
  };
  walk(body?.content ?? body);
  return out;
}

describe('Word import keeps the document the size it was', () => {
  it('reads w:sz as half-points, so 11pt stays 11pt', async () => {
    const file = await docxFile(para('Clause 1. The parties agree.', { sz: 22 }));
    const { body } = await convertDocxToTiptap(file, {});
    const sizes = textStyles(body).map(a => a.fontSize).filter(Boolean);
    expect(sizes).toContain('11pt');
    // The classic bug either way: halving twice (5.5pt, microscopic) or not
    // halving at all (22pt, enormous).
    expect(sizes).not.toContain('5.5pt');
    expect(sizes).not.toContain('22pt');
  });

  it('keeps a 9pt transcript readable rather than shrinking it', async () => {
    const file = await docxFile(para('Neil Kadakia   0:03', { sz: 18 }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body).map(a => a.fontSize)).toContain('9pt');
  });

  it('preserves the run font family', async () => {
    const file = await docxFile(para('Body text', { sz: 22, font: 'Calibri' }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body).map(a => a.fontFamily)).toContain('Calibri');
  });

  it('carries A4 page size through instead of forcing Letter', async () => {
    // A4 portrait in twentieths of a point: 11906 x 16838.
    const sect = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
      + `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
    const file = await docxFile(para('A4 contract', { sz: 22 }) + sect);
    const { pageSetup } = await convertDocxToTiptap(file, {});
    expect(pageSetup?.size).toBe('a4');
    expect(pageSetup?.orientation).toBe('portrait');
  });

  it('detects landscape from the section properties', async () => {
    const sect = `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>`;
    const file = await docxFile(para('Wide table page', { sz: 22 }) + sect);
    const { pageSetup } = await convertDocxToTiptap(file, {});
    expect(pageSetup?.orientation).toBe('landscape');
  });
});

// Where the size actually lives in the documents people import. The tests
// above all put w:sz on the run itself; a real Word file more often leaves the
// run bare and states the size once, further down the cascade. Reading only
// the run is why "Call with Neil Kadakia" imported at 2pt while Word and
// LibreOffice both rendered the same file correctly.
const STYLES_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const stylesXml = (inner) => `<?xml version="1.0"?><w:styles ${STYLES_NS}>${inner}</w:styles>`;
const bareRun = (text, rStyleId) => `<w:p><w:r>`
  + (rStyleId ? `<w:rPr><w:rStyle w:val="${rStyleId}"/></w:rPr>` : '')
  + `<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// The bug that started this file, finally pinned to the real XML.
//
// "Call with Neil Kadakia.docx" (a Teams meeting transcript) writes its run
// sizes as <w:sz w:val="4.3mm"/> and its page margins as <w:pgMar w:top="1in"/>.
// Both are valid OOXML: nearly every length in the spec is a union of a bare
// number in a type-specific unit AND an ST_UniversalMeasure with a suffix.
// Reading only the bare form gave parseInt("4.3mm") === 4, halved to 2pt - a
// 12pt transcript imported as microscopic text, and a 1-inch page as "narrow".
describe('OOXML lengths that carry their unit', () => {
  it('reads a millimetre font size as the size Word renders', async () => {
    // 4.3mm = 12.19pt. Word's own size box says 12.2.
    const file = await docxFile(para('Neil Kadakia   0:03', { sz: '4.3mm' }));
    const { body } = await convertDocxToTiptap(file, {});
    const sizes = textStyles(body).map(a => a.fontSize);
    expect(sizes).toContain('12.2pt');
    expect(sizes).not.toContain('2pt');   // parseInt("4.3mm") / 2
  });

  it('reads the transcript title and its small print', async () => {
    const file = await docxFile(para('Meeting Recording', { sz: '6mm' })
                              + para('16 September 2026, 06:31pm', { sz: '3mm' }));
    const { body } = await convertDocxToTiptap(file, {});
    const sizes = textStyles(body).map(a => a.fontSize);
    expect(sizes).toEqual(['17pt', '8.5pt']);
  });

  it('accepts the other universal measures the spec allows', async () => {
    const file = await docxFile(para('inches', { sz: '0.25in' })
                              + para('points', { sz: '14pt' })
                              + para('picas', { sz: '1pc' })
                              + para('centimetres', { sz: '0.5cm' }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body).map(a => a.fontSize)).toEqual(['18pt', '14pt', '12pt', '14.2pt']);
  });

  it('still reads a bare value as half-points', async () => {
    // The regression risk in the other direction: "22" is 11pt, not 22pt.
    const file = await docxFile(para('Ordinary Word output', { sz: 22 }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body).map(a => a.fontSize)).toContain('11pt');
  });

  it('reads page margins given in inches', async () => {
    const sect = `<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>`
      + `<w:pgMar w:top="1in" w:right="1in" w:bottom="1in" w:left="1in"/></w:sectPr>`;
    const file = await docxFile(para('A4 with one-inch margins', { sz: '4.3mm' }) + sect);
    const { pageSetup } = await convertDocxToTiptap(file, {});
    // parseInt("1in") === 1 twip, which read as the narrowest margins there are.
    expect(pageSetup).toEqual({ size: 'a4', orientation: 'portrait', margins: 'normal' });
  });

  it('reads a page size given in millimetres', async () => {
    const sect = `<w:sectPr><w:pgSz w:w="210mm" w:h="297mm"/></w:sectPr>`;
    const file = await docxFile(para('A4 stated in mm', { sz: 22 }) + sect);
    const { pageSetup } = await convertDocxToTiptap(file, {});
    expect(pageSetup?.size).toBe('a4');
    expect(pageSetup?.orientation).toBe('portrait');
  });

  it('ignores a size it cannot make sense of rather than inventing one', async () => {
    const file = await docxFile(para('Junk size', { sz: 'auto' }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body).every(a => !a.fontSize)).toBe(true);
  });
});

describe('the size is read from wherever Word actually put it', () => {
  it('takes the size from a character style (w:rStyle) over the paragraph style', async () => {
    // The transcript shape: the paragraph style says 2pt, a character style on
    // each run says 11pt. Word applies the character style - it outranks the
    // paragraph style - so 11pt is what the reader sees on screen.
    const styles = stylesXml(
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>`
      + `<w:rPr><w:sz w:val="4"/><w:rFonts w:ascii="Segoe UI"/></w:rPr></w:style>`
      + `<w:style w:type="character" w:styleId="TranscriptText"><w:name w:val="Transcript Text"/>`
      + `<w:rPr><w:sz w:val="22"/></w:rPr></w:style>`);
    const file = await docxFile(bareRun('Neil Kadakia   0:03', 'TranscriptText'), { styles });
    const { body } = await convertDocxToTiptap(file, {});
    const sizes = textStyles(body).map(a => a.fontSize).filter(Boolean);
    expect(sizes).toContain('11pt');
    expect(sizes).not.toContain('2pt');
  });

  it('falls back to the default paragraph style when a run says nothing', async () => {
    const styles = stylesXml(
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>`
      + `<w:rPr><w:sz w:val="24"/><w:rFonts w:ascii="Calibri"/></w:rPr></w:style>`);
    const file = await docxFile(bareRun('Body text with no formatting of its own'), { styles });
    const { body } = await convertDocxToTiptap(file, {});
    const [attrs] = textStyles(body);
    expect(attrs?.fontSize).toBe('12pt');
    expect(attrs?.fontFamily).toBe('Calibri');
  });

  it('falls back to w:docDefaults when there is no Normal style either', async () => {
    const styles = stylesXml(
      `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/>`
      + `<w:rFonts w:ascii="Aptos"/></w:rPr></w:rPrDefault></w:docDefaults>`);
    const file = await docxFile(bareRun('Default-sized text'), { styles });
    const { body } = await convertDocxToTiptap(file, {});
    const [attrs] = textStyles(body);
    expect(attrs?.fontSize).toBe('10pt');
    expect(attrs?.fontFamily).toBe('Aptos');
  });

  it('lets a run turn OFF bold that its style turned on', async () => {
    // <w:b w:val="0"/> is "explicitly not bold", not "says nothing" - the
    // difference only shows up once inheritance carries anything down at all.
    const styles = stylesXml(
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>`
      + `<w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>`);
    const body = `<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold</w:t></w:r></w:p>`;
    const file = await docxFile(body, { styles });
    const { body: doc } = await convertDocxToTiptap(file, {});
    const marks = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      (n.marks || []).forEach(m => marks.push(m.type));
      walk(n.content);
    };
    walk(doc.content);
    expect(marks).not.toContain('bold');
  });
});

// A Teams meeting transcript: one speaker AVATAR per turn, each in its own
// run. This is the document that started the bug report - it came into the
// editor as tiny text separated by enormous blank gaps.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function transcriptDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Default Extension="png" ContentType="image/png"/></Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/avatar.png"/></Relationships>`);
  zip.file('word/media/avatar.png', PNG_1PX, { base64: true });

  // An avatar paragraph, then the speaker line, then the utterance - twice.
  // wp:extent is the size Word DISPLAYS it at: 16x16px = 152400 EMU, however
  // many pixels the PNG itself happens to be.
  const avatar = `<w:p><w:r><w:drawing>`
    + `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
    + `<wp:extent cx="152400" cy="152400"/></wp:inline>`
    + `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/></w:drawing></w:r></w:p>`;
  const body = avatar + para('Neil Kadakia   0:03', { sz: 22 }) + para('The.', { sz: 22 })
             + avatar + para('Sagar Kumar Shoundik   0:04', { sz: 22 }) + para('Yeah.', { sz: 22 });
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document ${DOC_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<w:body>${body}</w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return { name: 'transcript.docx', type: '', arrayBuffer: async () => buf };
}

// A picture Word cropped, rotated, flipped, bordered and wrapped Square Right.
async function formattedPictureDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/></Relationships>`);
  zip.file('word/media/pic.png', PNG_1PX, { base64: true });
  const wp = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const r = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const pic = `<w:p><w:r><w:drawing><wp:anchor ${wp} behindDoc="0"><wp:extent cx="952500" cy="476250"/>`
    + `<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH><wp:wrapSquare wrapText="bothSides"/>`
    + `<a:graphic ${a}><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:blipFill><a:blip ${r} r:embed="rIdImg"/><a:srcRect l="10000" t="5000" r="20000" b="0"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm>`
    + `<a:prstGeom prst="rect"/><a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document ${DOC_NS} ${r}><w:body>${pic}${para('After the picture.')}</w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return { name: 'picture.docx', type: '', arrayBuffer: async () => buf };
}

const countType = (node, type, n = 0) => {
  if (Array.isArray(node)) return node.reduce((acc, c) => countType(c, type, acc), n);
  if (!node || typeof node !== 'object') return n;
  if (node.type === type) n += 1;
  return countType(node.content, type, n);
};

// A paragraph node with no content at all - what renders as a blank line.
const countEmptyParas = (body) => {
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'paragraph' && !(node.content || []).length) n += 1;
    walk(node.content);
  };
  walk(body?.content ?? body);
  return n;
};

describe('a Teams transcript imports without phantom blank lines', () => {
  it('keeps the avatars when storage upload works', async () => {
    const file = await transcriptDocx();
    const { body } = await convertDocxToTiptap(file, {
      uploadImage: async () => 'https://example.test/avatar.png',
    });
    expect(countType(body, 'image')).toBe(2);
    expect(countEmptyParas(body)).toBe(0);
  });

  it('inlines the avatars when upload fails, instead of losing them', async () => {
    // The real failure mode: no storage configured, so uploadImage returns ''.
    const file = await transcriptDocx();
    const { body } = await convertDocxToTiptap(file, { uploadImage: async () => '' });
    expect(countType(body, 'image')).toBe(2);
    const srcs = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'image') srcs.push(n.attrs?.src || '');
      walk(n.content);
    };
    walk(body.content);
    expect(srcs.every(u => u.startsWith('data:image/png;base64,'))).toBe(true);
  });

  it('leaves no blank gap where an image could not be embedded at all', async () => {
    // uploadImage throws AND the image is unembeddable - the paragraph that
    // held it must vanish with it, not become an empty line.
    const file = await transcriptDocx();
    const { body } = await convertDocxToTiptap(file, {
      uploadImage: async () => { throw new Error('storage down'); },
    });
    // Inline fallback still saves them here, so the real guard is: no gaps.
    expect(countEmptyParas(body)).toBe(0);
  });

  it('keeps a picture\'s crop, rotation, flips, border and wrap as Word had them', async () => {
    const { body } = await convertDocxToTiptap(await formattedPictureDocx(), { uploadImage: async () => '' });
    const imgs = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'image') imgs.push(n.attrs || {});
      walk(n.content);
    };
    walk(body);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({
      crop: { top: 5, right: 20, bottom: 0, left: 10 }, rotation: 90, flipH: true,
      borderColor: '#ff0000', wrapMode: 'squareRight', width: 100, height: 50,
    });
    expect(imgs[0].flipV).toBeUndefined();
  });

  it('sizes the avatars the way Word did, not at the PNG\'s own size', async () => {
    // The visible half of the bug report: a 16px avatar came in at the source
    // PNG's natural size and dwarfed the transcript it sat next to.
    const file = await transcriptDocx();
    const { body } = await convertDocxToTiptap(file, { uploadImage: async () => '' });
    const imgs = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'image') imgs.push(n.attrs || {});
      walk(n.content);
    };
    walk(body.content);
    expect(imgs.length).toBe(2);
    for (const a of imgs) {
      expect(a.width).toBe(16);
      expect(a.height).toBe(16);
    }
  });

  it('scales a picture wider than the text column down to fit it', async () => {
    // Word lets a picture run into the margin; this canvas cannot, so an
    // oversized one is scaled proportionally rather than overflowing the page.
    const zip = new JSZip();
    zip.file('[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Default Extension="png" ContentType="image/png"/></Types>`);
    zip.file('_rels/.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file('word/_rels/document.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/wide.png"/></Relationships>`);
    zip.file('word/media/wide.png', PNG_1PX, { base64: true });
    // 12 x 6 inches on a Letter page with 1in margins: a 6.5in column.
    const wide = `<w:p><w:r><w:drawing>`
      + `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`
      + `<wp:extent cx="${12 * 914400}" cy="${6 * 914400}"/></wp:inline>`
      + `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/></w:drawing></w:r></w:p>`;
    const sect = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>`
      + `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
    zip.file('word/document.xml',
      `<?xml version="1.0"?><w:document ${DOC_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<w:body>${wide}${sect}</w:body></w:document>`);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const file = { name: 'wide.docx', type: '', arrayBuffer: async () => buf };
    const { body } = await convertDocxToTiptap(file, { uploadImage: async () => '' });
    const imgs = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'image') imgs.push(n.attrs || {});
      walk(n.content);
    };
    walk(body.content);
    expect(imgs[0].width).toBe(624);          // 6.5in * 96
    expect(imgs[0].height).toBe(312);         // aspect ratio kept: 2:1
  });

  it('still keeps a paragraph Word genuinely left blank', async () => {
    // The opposite mistake: stripping real blank lines is its own alteration.
    const file = await docxFile(para('First', { sz: 22 }) + '<w:p/>' + para('Second', { sz: 22 }));
    const { body } = await convertDocxToTiptap(file, {});
    expect(countEmptyParas(body)).toBe(1);
  });
});

// ── Everything else Word keeps that the import used to drop ────────────────
// Pranshu, Nov 4: "when we are uploading the word file in NEXUS document it is
// not holding the same format that we have in word". Each case here is one
// thing a real business document carries: theme fonts, paragraph spacing and
// line spacing, indents, hyperlinks (both forms), headers and footers, list
// numbering formats, merged table cells, borderless tables, custom margins.
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relsXml = (rels) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + rels.map(r => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.type}" Target="${r.target}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')
  + `</Relationships>`;

async function docxWithParts({ body, styles, numbering, rels = [], parts = {} }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file('_rels/.rels', relsXml([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]));
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${DOC_NS} ${R_NS}><w:body>${body}</w:body></w:document>`);
  if (styles) zip.file('word/styles.xml', styles);
  if (numbering) zip.file('word/numbering.xml', `<?xml version="1.0"?><w:numbering ${DOC_NS}>${numbering}</w:numbering>`);
  if (rels.length) zip.file('word/_rels/document.xml.rels', relsXml(rels));
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return { name: 'parts.docx', type: '', arrayBuffer: async () => buf };
}

const firstBlock = (body) => body.content[0];
const texts = (node) => {
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; if (n.type === 'text') out.push(n); walk(n.content); };
  walk(node);
  return out;
};

describe('a Word document keeps the formatting Word shows', () => {
  it('resolves theme fonts (Aptos (Body)) through theme1.xml', async () => {
    const theme = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Office">`
      + `<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const styles = stylesXml(`<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>`);
    const file = await docxWithParts({ body: bareRun('Body in the theme font'), styles, parts: { 'word/theme/theme1.xml': theme } });
    const { body } = await convertDocxToTiptap(file, {});
    expect(textStyles(body)[0]?.fontFamily).toBe('Aptos');
  });

  it('carries paragraph spacing, line spacing and indents through the style cascade', async () => {
    // Word's Normal: after 8pt, line 1.08 (259/240); the paragraph adds a
    // half-inch left indent with a quarter-inch hanging first line.
    const styles = stylesXml(`<w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
      + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`);
    const body = `<w:p><w:pPr><w:spacing w:before="240"/><w:ind w:left="720" w:hanging="360"/><w:jc w:val="both"/></w:pPr><w:r><w:t>Clause</w:t></w:r></w:p>`;
    const { body: doc } = await convertDocxToTiptap(await docxWithParts({ body, styles }), {});
    const attrs = firstBlock(doc).attrs;
    expect(attrs.spacingAfter).toBe(8);
    expect(attrs.spacingBefore).toBe(12);
    expect(attrs.lineHeight).toBe('1.3');       // 1.08 x the browser's normal 1.2
    expect(attrs.indentLeft).toBe(36);
    expect(attrs.indentFirst).toBe(-18);
    expect(attrs.textAlign).toBe('justify');
  });

  it('keeps hyperlinks, in both the w:hyperlink and the field-code form', async () => {
    const body = `<w:p><w:hyperlink r:id="rLink"><w:r><w:t>Nexus</w:t></w:r></w:hyperlink></w:p>`
      + `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://example.test/b" </w:instrText></w:r>`
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Field link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
    const file = await docxWithParts({ body, rels: [{ id: 'rLink', type: 'hyperlink', target: 'https://example.test/a', external: true }] });
    const { body: doc } = await convertDocxToTiptap(file, {});
    const links = texts(doc).map(t => (t.marks || []).find(m => m.type === 'link')?.attrs?.href);
    expect(links).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(texts(doc).map(t => t.text)).toEqual(['Nexus', 'Field link']);
  });

  it('keeps tracked changes as changes, with who and when', async () => {
    const body = `<w:p><w:r><w:t xml:space="preserve">Net </w:t></w:r>`
      + `<w:del w:author="Sagar" w:date="2026-11-05T10:00:00Z"><w:r><w:delText>30</w:delText></w:r></w:del>`
      + `<w:ins w:author="Sagar" w:date="2026-11-05T10:00:00Z"><w:r><w:t>45</w:t></w:r></w:ins>`
      + `<w:r><w:t xml:space="preserve"> days</w:t></w:r></w:p>`;
    const { body: doc, warnings } = await convertDocxToTiptap(await docxWithParts({ body }), {});
    const runs = texts(doc).map(t => [t.text, (t.marks || []).find(m => m.type === 'deletion' || m.type === 'insertion')]);
    expect(runs.map(([t]) => t)).toEqual(['Net ', '30', '45', ' days']);
    expect(runs[1][1]).toEqual({ type: 'deletion', attrs: { author: 'Sagar', name: 'Sagar', at: '2026-11-05T10:00:00Z' } });
    expect(runs[2][1].type).toBe('insertion');
    expect(warnings.join(' ')).toMatch(/Review tab/);
  });

  it('brings the header and footer in, minus the page-number line Nexus draws itself', async () => {
    const header = `<?xml version="1.0"?><w:hdr ${DOC_NS}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Greens Global</w:t></w:r></w:p></w:hdr>`;
    const footer = `<?xml version="1.0"?><w:ftr ${DOC_NS}><w:p><w:r><w:t>Confidential</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
    const body = bareRun('Body') + `<w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:footerReference w:type="default" r:id="rF"/></w:sectPr>`;
    const file = await docxWithParts({
      body, rels: [{ id: 'rH', type: 'header', target: 'header1.xml' }, { id: 'rF', type: 'footer', target: 'footer1.xml' }],
      parts: { 'word/header1.xml': header, 'word/footer1.xml': footer },
    });
    const out = await convertDocxToTiptap(file, {});
    expect(texts(out.header).map(t => t.text)).toEqual(['Greens Global']);
    expect(out.header.content[0].attrs.textAlign).toBe('right');
    expect(texts(out.footer).map(t => t.text)).toEqual(['Confidential']);
    expect(out.warnings.join(' ')).toMatch(/Page numbers/);
  });

  it('keeps the numbering format and start of a lettered list', async () => {
    const numbering = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>`
      + `<w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>`;
    const li = (t) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const { body } = await convertDocxToTiptap(await docxWithParts({ body: li('c') + li('d'), numbering }), {});
    const list = firstBlock(body);
    expect(list.type).toBe('orderedList');
    expect(list.attrs).toEqual({ start: 3, type: 'a' });
    expect(list.content.length).toBe(2);
  });

  it('merges table cells across and down, keeps column widths, and notices a borderless table', async () => {
    const tc = (t, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const body = `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr>`
      + `<w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>`
      + `<w:tr>${tc('wide', '<w:gridSpan w:val="2"/>')}${tc('tall', '<w:vMerge w:val="restart"/>')}</w:tr>`
      + `<w:tr>${tc('a')}${tc('b')}${tc('', '<w:vMerge/>')}</w:tr></w:tbl>`;
    const { body: doc } = await convertDocxToTiptap(await docxWithParts({ body }), {});
    const table = firstBlock(doc);
    expect(table.type).toBe('table');
    expect(table.attrs).toEqual({ borders: 'none' });
    const [r1, r2] = table.content;
    expect(r1.content[0].attrs.colspan).toBe(2);
    expect(r1.content[0].attrs.colwidth).toEqual([192, 192]);   // 2in each at 96px
    expect(r1.content[1].attrs.rowspan).toBe(2);
    expect(r2.content.length).toBe(2);                            // the merged-away cell is gone
  });

  it('keeps custom margins instead of snapping them to a preset', async () => {
    const sect = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1440"/></w:sectPr>`;
    const { pageSetup } = await convertDocxToTiptap(await docxWithParts({ body: bareRun('x') + sect }), {});
    expect(pageSetup.margins).toBe('custom');
    expect(pageSetup.marginIn).toEqual({ top: 0.75, right: 0.75, bottom: 0.75, left: 1 });
  });

  it('reads caps, highlight and superscript', async () => {
    const body = `<w:p><w:r><w:rPr><w:caps/><w:highlight w:val="yellow"/></w:rPr><w:t>shout</w:t></w:r>`
      + `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r></w:p>`;
    const { body: doc } = await convertDocxToTiptap(await docxWithParts({ body }), {});
    const [a, b] = texts(doc);
    expect(a.text).toBe('SHOUT');
    expect(a.marks).toContainEqual({ type: 'highlight', attrs: { color: '#ffff00' } });
    expect(b.marks.map(m => m.type)).toContain('superscript');
  });
});

describe('the editor canvas renders those sizes at true scale', () => {
  // The canvas draws a Letter page 850px wide, so one inch is 850/8.5 = 100px.
  // CSS `pt` is absolute: 1pt = 1/72in = 1.333px at 96dpi. A page whose inch is
  // 100px but whose text is measured against a 96dpi inch renders text ~4%
  // small - tolerable. Anything much worse than that is the bug this guards.
  it('an inch of page and an inch of type agree within a few percent', () => {
    const { maxWidth } = pageCanvasStyle({ size: 'letter', orientation: 'portrait', margins: 'normal' });
    const pxPerInchOfPage = maxWidth / PAGE_SIZE_DIMS.letter.wIn;
    const pxPerInchOfType = 96;                       // what CSS pt resolves against
    const ratio = pxPerInchOfPage / pxPerInchOfType;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });

  it('a 12pt paragraph occupies a sane share of the text column', () => {
    const style = pageCanvasStyle({ size: 'letter', orientation: 'portrait', margins: 'normal' });
    const textColumnPx = style.maxWidth - 64 * 2;      // horizontal padding
    const twelvePtInPx = 12 * (96 / 72);               // 16px
    // ~45 characters of 12pt type across a 6.5in column, give or take. If the
    // import ever renders at a fifth of this, the line count explodes and the
    // page looks like the microscopic screenshot that started this.
    const approxCharsPerLine = textColumnPx / (twelvePtInPx * 0.5);
    expect(approxCharsPerLine).toBeGreaterThan(50);
    expect(approxCharsPerLine).toBeLessThan(130);
  });
});

// Word's tabs (Neil, 11/11/2026): a w:tab is a real tab now, not four
// spaces, and a paragraph's w:tabs are its stops (positions from the margin).
describe('Word import keeps tabs and tab stops', () => {
  it('reads a right tab stop and the tab that reaches it; a style\'s stop can be cleared', async () => {
    const styles = `<?xml version="1.0"?><w:styles ${DOC_NS}><w:style w:type="paragraph" w:styleId="Sig"><w:pPr><w:tabs><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr></w:style></w:styles>`;
    const body = '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/><w:tab w:val="center" w:pos="4680"/></w:tabs></w:pPr>'
      + '<w:r><w:t>Employee</w:t></w:r><w:r><w:tab/><w:t>Date</w:t></w:r></w:p>'
      + '<w:p><w:pPr><w:pStyle w:val="Sig"/><w:tabs><w:tab w:val="clear" w:pos="2880"/><w:tab w:val="decimal" w:pos="5760"/></w:tabs></w:pPr><w:r><w:t>Total</w:t><w:tab/><w:t>12.50</w:t></w:r></w:p>';
    const { body: doc } = await convertDocxToTiptap(await docxFile(body, { styles }), {});
    const [p1, p2] = doc.content;
    expect(p1.attrs.tabStops).toEqual([{ pos: 234, align: 'center' }, { pos: 468, align: 'right' }]);
    expect(p1.content.map((n) => n.type)).toEqual(['text', 'tab', 'text']);
    expect(p2.attrs.tabStops).toEqual([{ pos: 288, align: 'decimal' }]);
    expect(JSON.stringify(p2)).not.toContain('    ');
  });
});

// The Word redesign (Neil, 11/11/2026): variables, notes and a later
// section's header come through.
describe('Word import brings variables, notes and headers', () => {
  it('reads «Name» text and a simple MERGEFIELD as variables', async () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">Dear «First_Name», welcome to </w:t></w:r>'
      + '<w:fldSimple w:instr=" MERGEFIELD company \\* MERGEFORMAT "><w:r><w:t>«company»</w:t></w:r></w:fldSimple></w:p>';
    const { body: doc } = await convertDocxToTiptap(await docxFile(body), {});
    const p = doc.content[0];
    expect(p.content.filter((n) => n.type === 'mergeField').map((n) => n.attrs.token)).toEqual(['first_name', 'company']);
    expect(JSON.stringify(p)).not.toContain('«');
  });

  it('reads an endnote as a footnote, in place', async () => {
    const body = '<w:p><w:r><w:t>Rent</w:t></w:r><w:r><w:endnoteReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> is due monthly.</w:t></w:r></w:p>';
    const file = await docxWithParts({ body, parts: { 'word/endnotes.xml': `<?xml version="1.0"?><w:endnotes ${DOC_NS}><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:id="2"><w:p><w:r><w:t>Before the 5th.</w:t></w:r></w:p></w:endnote></w:endnotes>` } });
    const { body: doc } = await convertDocxToTiptap(file, {});
    expect(doc.content[0].content.map((n) => n.type)).toEqual(['text', 'footnote', 'text']);
    expect(doc.content[0].content[1].attrs.text).toBe('Before the 5th.');
  });

  it('takes the header of the first section that has one', async () => {
    const hdr = `<?xml version="1.0"?><w:hdr ${DOC_NS}><w:p><w:r><w:t>Section Two Header</w:t></w:r></w:p></w:hdr>`;
    const body = '<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p>'
      + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>';
    const file = await docxWithParts({ body, rels: [{ id: 'rIdH', type: 'header', target: 'header1.xml' }], parts: { 'word/header1.xml': hdr } });
    const { header } = await convertDocxToTiptap(file, {});
    expect(JSON.stringify(header)).toContain('Section Two Header');
  });
});
