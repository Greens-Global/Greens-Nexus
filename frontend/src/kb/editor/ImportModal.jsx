// Import a Word file, a PDF, pasted text or screenshots. A Word or PDF file
// imports As Is with no AI (importFile.js: headings, lists, tables, bold and
// pictures in place, the original attached). With AI on, Read with Nexus
// also reads it in sections; a section that fails says so and its text is
// kept. The result opens in the editor; nothing is published here.
import { useEffect, useRef, useState } from 'react';
import { FileText, ClipboardPaste, Image as ImageIcon, Upload, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { api } from '../../api';
import Blocks from '../components/Blocks';
import { useToast, errText } from '../components/Toast';
import { PAGE_TYPES, readAsDataUrl } from '../lib';
import { importFileAsIs, importKind, baseTitle } from './importFile';
import { fileSize } from './extensions.jsx';

const MAX_FILE = 15 * 1024 * 1024;

async function extractDocx(file) {
  const mammoth = await import('mammoth');
  const images = {};
  let n = 0;
  const res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
    convertImage: mammoth.images.imgElement((img) => img.read('base64').then((b64) => { n += 1; images[String(n)] = `data:${img.contentType};base64,${b64}`; return { src: `[[IMG${n}]]` }; })),
  });
  const div = document.createElement('div');
  div.innerHTML = res.value || '';
  div.querySelectorAll('img').forEach((img) => img.replaceWith(document.createTextNode(` ${img.getAttribute('src') || ''} `)));
  div.querySelectorAll('table').forEach((t) => {
    const rows = Array.from(t.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td,th')).map((c) => c.textContent.trim()).join(' | '));
    t.replaceWith(document.createTextNode(`\n[[TABLE]]\n${rows.join('\n')}\n[[/TABLE]]\n`));
  });
  div.querySelectorAll('h1,h2,h3,h4,p,li,br').forEach((el) => { el.insertAdjacentText('afterend', '\n'); if (/^H[1-4]$/.test(el.tagName)) el.insertAdjacentText('beforebegin', '\n'); });
  return { text: div.textContent.replace(/\n{3,}/g, '\n\n').trim(), images, warnings: (res.messages || []).map((m) => m.message).slice(0, 5) };
}

async function extractPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let last = null;
    let line = [];
    const lines = [];
    for (const it of tc.items) {
      if (last !== null && Math.abs(it.transform[5] - last) > 3) { lines.push(line.join(' ')); line = []; }
      line.push(it.str);
      last = it.transform[5];
    }
    if (line.length) lines.push(line.join(' '));
    parts.push(lines.join('\n'));
  }
  const text = parts.join('\n\n').trim();
  return { text, images: {}, warnings: text.length < 50 * doc.numPages ? ['This PDF has little selectable text. If it is a scan, import it as screenshots instead.'] : [] };
}

export default function ImportModal({ onClose, onOpenInEditor, defaultCollection = '', ai = false }) {
  const toast = useToast();
  const [mode, setMode] = useState('');          // file | paste | shots
  const [title, setTitle] = useState('');
  const [pageType, setPageType] = useState(ai ? '' : 'how_to');
  const [fileObj, setFileObj] = useState(null);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [asIs, setAsIs] = useState(null);        // the Import As Is result
  const [step, setStep] = useState('');
  const [text, setText] = useState('');
  const [images, setImages] = useState({});     // {n: dataUrl}
  const [fileName, setFileName] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [job, setJob] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const shotRef = useRef(null);

  const takeFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_FILE) { toast('That file is larger than 15 MB', 'err'); return; }
    if (importKind(file.name) === 'doc') { toast('Old .doc files are not supported. Save it as .docx in Word first.', 'err'); return; }
    setFileObj(file); setFileName(file.name); setMode('file'); setWarnings([]);
    if (!title) setTitle(baseTitle(file.name));
    if (!ai) { setText(''); setImages({}); return; }   // As Is reads the file itself
    setExtracting(true);
    try {
      const name = file.name.toLowerCase();
      let out;
      if (name.endsWith('.docx')) out = await extractDocx(file);
      else if (name.endsWith('.pdf')) out = await extractPdf(file);
      else if (name.endsWith('.doc')) throw new Error('Old .doc files are not supported. Save it as .docx in Word first.');
      else out = { text: await file.text(), images: {}, warnings: [] };
      setText(out.text); setImages(out.images); setWarnings(out.warnings);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    } catch (e) { toast(errText(e, 'Could not read the file'), 'err'); } finally { setExtracting(false); }
  };
  const takeShots = async (files) => {
    const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    const next = { ...images };
    let n = Object.keys(next).length;
    for (const f of list.slice(0, 30)) { n += 1; next[String(n)] = await readAsDataUrl(f); }
    setImages(next); setMode('shots');
  };
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); takeShots(files); }
  };

  const startAsIs = async () => {
    if (!fileObj) return;
    setExtracting(true);
    try {
      const out = await importFileAsIs(fileObj, { keepOriginal, onStep: setStep });
      setAsIs(out);
      if (out.title && (!title || title === baseTitle(fileObj.name))) setTitle(out.title);
    } catch (e) { toast(errText(e, 'Could not import the file'), 'err'); } finally { setExtracting(false); setStep(''); }
  };
  const start = async () => {
    const body = mode === 'shots' ? (text.trim() || 'Screenshots of a procedure. Read the images in order.') : text.trim();
    if (!body && !Object.keys(images).length) { toast('Nothing to import yet', 'err'); return; }
    try {
      const j = await api.kbImport({ text: body, title, source_name: fileName, images, page_type: pageType });
      setJob(j);
    } catch (e) { toast(errText(e), 'err'); }
  };
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return undefined;
    const t = setTimeout(() => api.kbJob(job.id).then(setJob).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [job]);

  const result = job?.status === 'done' ? job.result : null;
  const canStart = (mode === 'paste' && text.trim().length > 20) || (mode === 'file' && text.trim().length > 0) || (mode === 'shots' && Object.keys(images).length > 0);
  const isFile = mode === 'file' && ['docx', 'pdf'].includes(importKind(fileName));

  const footer = asIs ? (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
      <span className="kb-meta kb-grow">{(asIs.words || 0).toLocaleString()} words{asIs.tables ? `, ${asIs.tables} table${asIs.tables === 1 ? '' : 's'}` : ''}{asIs.images ? `, ${asIs.images} picture${asIs.images === 1 ? '' : 's'}` : ''}. Nothing is published until you say so.</span>
      <button type="button" className="kb-btn" onClick={() => setAsIs(null)}>Back</button>
      <button type="button" className="kb-btn pri" onClick={() => onOpenInEditor({
        title: title.trim() || asIs.title || baseTitle(fileName) || 'Imported Page', summary: '',
        page_type: pageType || 'how_to', collection_id: defaultCollection, tags: [], blocks: asIs.blocks,
        original_content: '', original_title: fileName,
      })}>Open in Editor</button>
    </div>
  ) : result ? (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
      <span className="kb-meta kb-grow">{result.sections} section{result.sections === 1 ? '' : 's'} read{result.images ? `, ${result.images} images stored` : ''}. Nothing is published until you say so.</span>
      <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="kb-btn pri" onClick={() => onOpenInEditor({
        title: result.suggested?.title || title || fileName || 'Imported Page', summary: result.suggested?.summary || '',
        page_type: result.suggested?.page_type || pageType || 'how_to', collection_id: result.suggested?.collection_id || defaultCollection,
        tags: result.suggested?.tags || [], blocks: result.blocks, original_content: text, original_title: fileName || title, possible_match: result.possible_match,
      })}>Open in Editor</button>
    </div>
  ) : job ? null : (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" className="kb-btn" onClick={onClose}>Cancel</button>
      {isFile && <button type="button" className={`kb-btn${ai ? '' : ' pri'}`} disabled={extracting} onClick={startAsIs}>Import As Is</button>}
      {(ai || !isFile) && <button type="button" className="kb-btn pri" disabled={!canStart || extracting} onClick={start}>{ai ? 'Read with Nexus' : 'Import'}</button>}
    </div>
  );

  return (
    <Modal title="Import" onClose={onClose} footer={footer && <div className="kb">{footer}</div>}>
      <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }} onPaste={onPaste}>
        {!job && !asIs && (
          <>
            <div className="kb-grid3">
              {[
                ['file', FileText, 'Word or PDF', 'A .docx or .pdf up to 15 MB. Headings, lists, tables and pictures come along.'],
                ['paste', ClipboardPaste, 'Paste Text', 'From an email, a chat, a Google Doc.'],
                ...(ai ? [['shots', ImageIcon, 'Screenshots', 'Photos of a printed SOP or a whiteboard. Nexus reads them.']] : []),
              ].map(([k, Icon, h, d]) => (
                <button key={k} type="button" className="kb-coll" style={mode === k ? { borderColor: 'var(--kb-green)', background: 'var(--kb-green-soft)' } : {}}
                        onClick={() => { setMode(k); if (k === 'file') fileRef.current?.click(); if (k === 'shots') shotRef.current?.click(); }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon size={18} style={{ color: 'var(--kb-green)' }} /><span className="kb-title">{h}</span></div>
                  <div className="kb-meta">{d}</div>
                </button>
              ))}
            </div>
            <input ref={fileRef} type="file" accept=".docx,.pdf,.txt,.md" hidden onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
            <input ref={shotRef} type="file" accept="image/*" multiple hidden onChange={(e) => { takeShots(e.target.files); e.target.value = ''; }} />
            {mode === 'file' && (
              <div className={`kb-dropzone${drag ? ' on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); takeFile(e.dataTransfer.files?.[0]); }} onClick={() => fileRef.current?.click()}>
                {extracting ? <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Loader2 size={16} className="kb-spin" />{step || 'Reading'}: {fileName}...</span>
                  : fileName ? <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--kb-ink)' }}><CheckCircle2 size={16} style={{ color: 'var(--kb-green)' }} />{fileName}{ai ? ` · ${text.length.toLocaleString()} characters${Object.keys(images).length ? `, ${Object.keys(images).length} images` : ''}` : fileObj ? ` · ${fileSize(fileObj.size)}` : ''}</span>
                  : <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Upload size={16} />Drop a file here or click to choose</span>}
              </div>
            )}
            {mode === 'paste' && <textarea className="kb-textarea" style={{ minHeight: 220, fontSize: 14 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text here. Headings, numbered steps and bullet points are kept." autoFocus />}
            {mode === 'shots' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="kb-dropzone" onClick={() => shotRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); takeShots(e.dataTransfer.files); }}>
                  <ImageIcon size={16} /> Add screenshots, or press Ctrl+V with an image copied. In reading order.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(images).map(([k, src]) => <img key={k} src={src} alt={`Screenshot ${k}`} style={{ width: 110, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--kb-line)' }} />)}
                </div>
                <textarea className="kb-textarea" style={{ minHeight: 60 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional: what these are (helps Nexus name the page)" />
              </div>
            )}
            {isFile && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
                <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />
                Keep the original file attached to the page
              </label>
            )}
            {warnings.length > 0 && <div className="kb-banner amber"><AlertTriangle /><div>{warnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>}
            {mode && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="kb-field"><label>Working Title</label><input className="kb-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ai ? 'Nexus suggests one if blank' : 'The file name if blank'} /></div>
                <div className="kb-field"><label>Page Type</label><select className="kb-select" value={pageType} onChange={(e) => setPageType(e.target.value)}>{ai && <option value="">Let Nexus suggest</option>}{Object.values(PAGE_TYPES).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></div>
              </div>
            )}
          </>
        )}
        {asIs && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
            {asIs.warnings?.length > 0 && <div className="kb-banner amber"><AlertTriangle /><div><b>Check these.</b> {asIs.warnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>}
            <div className="kb-meta">Fonts, colors and page layout are not copied; the page takes the Knowledge Base style. Check the preview, then tidy it up in the editor (for example turn a numbered list into Steps).</div>
            <div className="kb-card soft nx-fill" style={{ overflow: 'auto', padding: 18 }}><Blocks doc={asIs.blocks} /></div>
          </div>
        )}
        {job && !result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 0' }}>
            {job.status === 'failed' ? (
              <div className="kb-banner red"><AlertTriangle /><div><b>The import failed.</b> {job.error} Your text is still here: close this and try again, or paste it into a blank page.</div></div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Loader2 size={18} className="kb-spin" style={{ color: 'var(--kb-green)' }} /><span className="kb-title">Nexus is reading it{job.total > 1 ? ` in ${job.total - 1} sections` : ''}</span></div>
                <div className="kb-progress" style={{ height: 8 }}><i style={{ width: `${job.total ? Math.round(100 * job.progress / job.total) : 10}%`, transition: 'width .4s' }} /></div>
                <div className="kb-meta">Section by section, so nothing is cut off. A section Nexus cannot read is kept as plain text and flagged.</div>
              </>
            )}
          </div>
        )}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {result.warnings?.length > 0 && <div className="kb-banner amber"><AlertTriangle /><div><b>Some parts need a look.</b> {result.warnings.map((w, i) => <div key={i}>{w}</div>)}<div>Nothing is lost: the raw text stays with the page as its original source.</div></div></div>}
            {result.possible_match && <div className="kb-banner blue"><AlertTriangle /><div><b>Possible match:</b> "{result.possible_match.title}"{result.possible_match.code ? ` (${result.possible_match.code})` : ''} already exists. Open it in the editor and paste this in as a revision if it is the same page.</div></div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }} className="kb-meta">
              Suggested: <b>{result.suggested?.title || title}</b>{result.suggested?.page_type && <span className="kb-tag">{PAGE_TYPES[result.suggested.page_type]?.label}</span>}{(result.suggested?.tags || []).map((t) => <span key={t} className="kb-tag">{t}</span>)}
            </div>
            <div className="kb-card soft" style={{ maxHeight: '46vh', overflow: 'auto', padding: 18 }}><Blocks doc={result.blocks} /></div>
          </div>
        )}
      </div>
    </Modal>
  );
}
