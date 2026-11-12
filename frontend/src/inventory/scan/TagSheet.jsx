// Items phase 4 - the print-ready QR tag sheet (lazy: its own chunk, with
// qrcode's vendor-qr behind it; nothing here is on first paint).
//
// A full-screen print view over the app: a toolbar (label size, where on a
// part-used sheet to start, Print, Close) and the sheets themselves, drawn
// to the inch. window.print() prints only the sheets - the "Tag sheet print"
// rules below hide the app and the toolbar and drop the page margins, so the
// labels land on the die cuts of a standard sheet at 100% scale.
// Each tag: the QR code (the item's own link), the item name, its serial
// and the company name - white-label, from the item's company on the server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X, AlertCircle } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../../components/AsyncState';
import { useBackToClose } from '../../lib/useBackToClose';
import { useEscapeLayer } from '../../tasks/components';
import { TAG_LAYOUTS, DEFAULT_LAYOUT, layoutOf, perPage, paginateTags, PAGE } from './tagLayout';
import { createQrMaker, qrPayload } from './qr';

const LAYOUT_KEY = 'nexus_items_tag_layout';
const readLayout = () => { try { const v = localStorage.getItem(LAYOUT_KEY); return TAG_LAYOUTS[v] ? v : DEFAULT_LAYOUT; } catch { return DEFAULT_LAYOUT; } };

const PRINT_CSS = `
.nx-tag-print { position: fixed; inset: 0; z-index: 5200; display: flex; flex-direction: column; background: var(--body-bg, #f4f5f8); font-family: Inter, sans-serif; }
.nx-tag-toolbar { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; padding: 12px 20px; background: var(--card); border-bottom: 1px solid var(--line); color: var(--ink); }
.nx-tag-canvas { flex: 1; min-height: 0; overflow: auto; padding: 24px 16px 48px; }
.nx-tag-pages { display: flex; flex-direction: column; align-items: center; gap: 24px; }
.nx-tag-page { position: relative; width: ${PAGE.w}in; height: ${PAGE.h}in; background: #fff; color: #111; box-shadow: 0 6px 24px rgba(17,24,39,.18); flex-shrink: 0; overflow: hidden; }
.nx-tag { position: absolute; box-sizing: border-box; overflow: hidden; display: flex; color: #111; }
.nx-tag-qr { flex-shrink: 0; display: block; }
.nx-tag-co { font-size: 6.5pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-tag-name { font-weight: 700; line-height: 1.15; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; word-break: break-word; }
.nx-tag-serial { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nx-tag-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.nx-tag-seg button { border: none; background: var(--card); color: var(--ink); font: 600 13px Inter, sans-serif; padding: 7px 12px; cursor: pointer; }
.nx-tag-seg button[aria-pressed="true"] { background: var(--nx-primary, #1f7a44); color: #fff; }
@media print {
  @page { size: letter portrait; margin: 0; }
  html, body { background: #fff !important; }
  /* A phone prints from inside a sheet that holds the page still
     (lib/useScrollLock pins body with position fixed + a negative top):
     let the body flow again for the print, or the sheets print cut off. */
  body.nx-printing-tags { position: static !important; top: auto !important; left: auto !important; right: auto !important; width: auto !important; overflow: visible !important; }
  body.nx-printing-tags > *:not(.nx-tag-print) { display: none !important; }
  body.nx-printing-tags .nx-tag-print { position: static !important; display: block !important; background: #fff !important; }
  /* style.css's other print views hide "body *" by visibility - the sheets opt back in. */
  body.nx-printing-tags .nx-tag-print, body.nx-printing-tags .nx-tag-print * { visibility: visible !important; }
  body.nx-printing-tags .nx-tag-toolbar, body.nx-printing-tags .nx-tag-note { display: none !important; }
  body.nx-printing-tags .nx-tag-canvas { overflow: visible !important; padding: 0 !important; }
  body.nx-printing-tags .nx-tag-pages { display: block !important; gap: 0 !important; zoom: 1 !important; }
  body.nx-printing-tags .nx-tag-page { box-shadow: none !important; margin: 0 !important; break-after: page; page-break-after: always; }
  body.nx-printing-tags .nx-tag-page:last-child { break-after: auto; page-break-after: auto; }
}
`;

function QrSvg({ qr, size }) {
  if (!qr) return <div className="nx-tag-qr" style={{ width: size, height: size }} />;
  return (
    <svg className="nx-tag-qr" width={size} height={size} viewBox={`-1 -1 ${qr.size + 2} ${qr.size + 2}`} shapeRendering="crispEdges" role="img" aria-label="QR code">
      <rect x="-1" y="-1" width={qr.size + 2} height={qr.size + 2} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  );
}

/** One label, absolutely placed on its sheet. Exported for the render test. */
export function TagLabel({ tag, layout, index, qr }) {
  const l = layoutOf(layout);
  const col = index % l.cols;
  const row = Math.floor(index / l.cols);
  const pos = {
    left: `${l.left + col * (l.w + l.gapX)}in`, top: `${l.top + row * (l.h + l.gapY)}in`,
    width: `${l.w}in`, height: `${l.h}in`,
  };
  if (!tag) return null;
  const square = l.key === 'square';
  return (
    <div className="nx-tag" data-testid="nx-tag" style={{ ...pos, padding: square ? '0.12in' : '0.07in 0.09in', gap: square ? 4 : '0.08in',
      flexDirection: square ? 'column' : 'row', alignItems: 'center', justifyContent: square ? 'center' : 'flex-start' }}>
      {square && tag.companyName ? <div className="nx-tag-co" style={{ maxWidth: '100%' }}>{tag.companyName}</div> : null}
      <QrSvg qr={qr} size={square ? '1.22in' : '0.84in'} />
      <div style={{ minWidth: 0, flex: square ? 'none' : 1, display: 'flex', flexDirection: 'column', gap: 2, alignItems: square ? 'center' : 'flex-start', textAlign: square ? 'center' : 'left', maxWidth: '100%' }}>
        {!square && tag.companyName ? <div className="nx-tag-co" style={{ maxWidth: '100%' }}>{tag.companyName}</div> : null}
        <div className="nx-tag-name" style={{ fontSize: square ? '8pt' : '8.5pt', WebkitLineClamp: square ? 1 : 2, maxWidth: '100%' }}>{tag.name || 'Item'}</div>
        {tag.serialNumber ? <div className="nx-tag-serial" style={{ fontSize: square ? '7.5pt' : '8pt', maxWidth: '100%' }}>{tag.serialNumber}</div> : null}
      </div>
    </div>
  );
}

// `origin` (tests) pins the address the QR codes carry; otherwise it is the
// app's public address from POST /items/tags (`publicBase`, review M1), and
// this tab's own origin only when the server did not send one.
// loadTags(ids) / payloadFor(tag, base) (Scan to Request, 11/03/2026): a
// property's site and equipment tags print on this same sheet - the rows come
// from POST /maintenance/tags and each code carries the tag's own path.
const itemTags = (ids) => api.getItemTags(ids);
const itemPayload = (t, base) => qrPayload(t.id, base);

export default function TagSheet({ items, onClose, origin = '', loadQr, loadTags = itemTags, payloadFor = itemPayload, emptyText = '' }) {
  const ids = useMemo(() => (items || []).map((i) => i.id), [items]);
  const [tags, setTags] = useState(null);         // null = loading
  const [publicBase, setPublicBase] = useState('');
  const [note, setNote] = useState('');
  const [qrs, setQrs] = useState({});              // id -> { size, path }
  const [layout, setLayout] = useState(readLayout);
  const [startAt, setStartAt] = useState(1);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef(null);
  const toolbarRef = useRef(null);

  useBackToClose(true, onClose);
  // Escape closes only this layer (the topmost), never the record beneath (review L3).
  useEscapeLayer(() => onClose?.());
  useEffect(() => {
    document.body.classList.add('nx-printing-tags');
    return () => document.body.classList.remove('nx-printing-tags');
  }, []);
  // Focus moves into the toolbar on open and back to what opened it on close.
  useEffect(() => {
    const back = document.activeElement;
    toolbarRef.current?.focus?.();
    return () => { try { if (back && document.contains(back)) back.focus?.(); } catch { /* gone */ } };
  }, []);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode */ } }, [layout]);

  // The tag rows (names, serials, company names) from the server, walled.
  useEffect(() => {
    let live = true;
    loadTags(ids)
      .then((res) => {
        if (!live) return;
        const list = Array.isArray(res) ? res : (Array.isArray(res?.tags) ? res.tags : []);
        setPublicBase(Array.isArray(res) ? '' : String(res?.publicBase || ''));
        setTags(list);
        const left = ids.length - list.length;
        setNote(left > 0 ? `${left} item${left !== 1 ? 's were' : ' was'} left off - outside your companies, or deleted.` : '');
      })
      .catch(() => {
        if (!live) return;
        setTags((items || []).map((i) => ({ id: i.id, name: i.name || '', serialNumber: i.serialNumber || '', companyName: '' })));
        setNote('The company names could not be loaded - the tags print without them.');
      });
    return () => { live = false; };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  // QR codes, made here once the library has loaded.
  const base = origin || publicBase || window.location.origin;
  useEffect(() => {
    if (!tags || !tags.length) return undefined;
    let live = true;
    createQrMaker(loadQr ? { load: loadQr } : undefined).then((make) => {
      if (!live) return;
      const next = {};
      for (const t of tags) {
        try { next[t.id] = make(payloadFor(t, base)); } catch { /* an unprintable id stays blank */ }
      }
      setQrs(next);
    }).catch(() => { if (live) setNote('The QR codes could not be made - reload the page and try again.'); });
    return () => { live = false; };
  }, [tags, base, loadQr]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit the sheets to a narrow window (a phone): the screen preview only.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const fit = () => setZoom(Math.min(1, Math.max(0.3, (el.clientWidth - 32) / (PAGE.w * 96))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = perPage(layout);
  const start = Math.min(startAt, n);   // a smaller label size keeps the pick in range
  const pages = useMemo(() => paginateTags(tags || [], layout, start), [tags, layout, start]);
  const ready = tags && tags.length && Object.keys(qrs).length > 0;
  const count = tags?.length || 0;

  return createPortal(
    <div className="nx-tag-print" role="dialog" aria-modal="true" aria-label="Print Tags">
      <style>{PRINT_CSS}</style>
      <div className="nx-tag-toolbar" ref={toolbarRef} tabIndex={-1} aria-label="Tag sheet options">
        <div style={{ minWidth: 0, marginRight: 'auto' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Print Tags</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {tags == null ? 'Getting the tags ready...' : `${count} tag${count !== 1 ? 's' : ''} on ${pages.length} sheet${pages.length !== 1 ? 's' : ''} - print at 100% (Actual Size) with no margins.`}
          </div>
        </div>
        <div className="nx-tag-seg" role="group" aria-label="Label Size">
          {Object.values(TAG_LAYOUTS).map((l) => (
            <button key={l.key} type="button" aria-pressed={layout === l.key} title={l.hint} onClick={() => setLayout(l.key)}>{l.label}</button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
          Start At
          <select className="form-input" value={start} onChange={(e) => setStartAt(Number(e.target.value) || 1)} style={{ width: 112, height: 34, padding: '4px 28px 4px 10px', fontSize: 13 }} aria-label="Start at label">
            {Array.from({ length: n }, (_, i) => <option key={i + 1} value={i + 1}>Label {i + 1}</option>)}
          </select>
        </label>
        <button type="button" className="primary-btn" disabled={!ready} onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Printer size={14} /> Print
        </button>
        <button type="button" className="secondary-btn" onClick={onClose} aria-label="Close" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <X size={14} /> Close
        </button>
      </div>
      <div className="nx-tag-canvas" ref={canvasRef}>
        {note && (
          <div className="nx-tag-note" role="status" style={{ maxWidth: `${PAGE.w}in`, margin: '0 auto 16px', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'var(--card)', border: '1px solid var(--line)', fontSize: 13, color: 'var(--ink)' }}>
            <AlertCircle size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} /> {note}
          </div>
        )}
        {tags == null ? (
          <div style={{ maxWidth: `${PAGE.w}in`, margin: '0 auto' }}><SkeletonBlocks count={3} height={180} borderRadius={8} /></div>
        ) : count === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 16px', color: 'var(--muted)', fontSize: 13 }}>{emptyText || 'None of these items can be tagged by you. Close this and pick items from your own companies.'}</div>
        ) : (
          <div className="nx-tag-pages" style={{ zoom }}>
            {pages.map((page, p) => (
              <div className="nx-tag-page" key={p} data-testid="nx-tag-page">
                {page.map((tag, i) => <TagLabel key={i} tag={tag} layout={layout} index={i} qr={tag ? qrs[tag.id] : null} />)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
