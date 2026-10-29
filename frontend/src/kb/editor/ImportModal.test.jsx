// Import As Is (Oct 29 2026): a Word or PDF file becomes a draft page with no AI.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const calls = [];
vi.mock('../../api', () => {
  const api = {
    kbUploadMedia: (data, folder) => { calls.push(['upload', data.slice(0, 30), folder]); return Promise.resolve({ url: `https://x.supabase.co/storage/v1/object/public/kb-media/imports/${calls.length}` }); },
    kbImportConvert: (body) => { calls.push(['convert', body]); return Promise.resolve({ blocks: body.body, title: 'Gate Lockup', words: 12, images: 0, tables: 1 }); },
    kbImport: () => Promise.reject(new Error('the AI path must not run')),
  };
  return { api, default: api };
});

const { default: ImportModal } = await import('./ImportModal');
const { importFileAsIs } = await import('./importFile');
afterEach(() => { cleanup(); calls.length = 0; });

// jsdom's File has no arrayBuffer(); browsers do.
if (!File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(this); });
  };
}

// A real (tiny) .docx: a title, a bold run and a one-cell table.
async function makeDocx() {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${w}"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Gate Lockup</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Lock the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>main gate</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Key</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`);
  zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles xmlns:w="${w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'Gate_Lockup-v3.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

describe('Import As Is', () => {
  it('reads a Word file into blocks and attaches the original', async () => {
    const out = await importFileAsIs(await makeDocx());
    const convert = calls.find((c) => c[0] === 'convert')[1];
    const types = convert.body.content.map((n) => n.type);
    expect(types).toContain('heading');
    expect(types).toContain('table');
    expect(JSON.stringify(convert.body)).toContain('"bold"');
    expect(convert.title).toBe('Gate Lockup v3');
    expect(convert.original.name).toBe('Gate_Lockup-v3.docx');
    expect(calls.filter((c) => c[0] === 'upload').map((c) => c[2])).toEqual(['imports']);
    expect(out.warnings).toEqual([]);
  });

  it('refuses an old .doc file', async () => {
    await expect(importFileAsIs(new File(['x'], 'old.doc'))).rejects.toThrow(/Save As \.docx/);
  });

  it('with AI off, imports a file As Is and opens it as a draft', async () => {
    const opened = [];
    render(<ImportModal ai={false} onClose={() => {}} onOpenInEditor={(d) => opened.push(d)} />);
    expect(screen.queryByText('Screenshots')).toBeNull();
    fireEvent.click(screen.getByText('Word or PDF'));
    fireEvent.change(document.querySelector('input[type=file][accept^=".docx"]'), { target: { files: [await makeDocx()] } });
    expect(screen.queryByRole('button', { name: 'Read with Nexus' })).toBeNull();
    expect(screen.getByLabelText(/Keep the original file attached/).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import As Is' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Editor' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0].page_type).toBe('how_to');
    expect(opened[0].title).toBe('Gate Lockup');
    expect(opened[0].original_title).toBe('Gate_Lockup-v3.docx');
    expect(opened[0].blocks.type).toBe('doc');
  });
});
