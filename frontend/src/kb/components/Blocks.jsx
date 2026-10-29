// Read-only renderer for a page's blocks (the TipTap JSON kb_blocks.py
// describes). The reader, the review compare, the course player and the
// phone all draw through this, so a page looks the same everywhere.
import { useState } from 'react';
import { AlertTriangle, Lightbulb, Info, ShieldAlert, Play, BookOpen, Camera, Paperclip, Download } from 'lucide-react';
import { fileSize } from '../editor/extensions.jsx';
import { goKb } from '../lib';

function Marks({ node }) {
  let el = node.text || '';
  for (const m of node.marks || []) {
    if (m.type === 'bold') el = <b>{el}</b>;
    else if (m.type === 'italic') el = <i>{el}</i>;
    else if (m.type === 'underline') el = <u>{el}</u>;
    else if (m.type === 'strike') el = <s>{el}</s>;
    else if (m.type === 'code') el = <code>{el}</code>;
    else if (m.type === 'highlight') el = <mark>{el}</mark>;
    else if (m.type === 'link') el = <a href={m.attrs?.href} target="_blank" rel="noopener noreferrer">{el}</a>;
  }
  return el;
}

function Inline({ nodes }) {
  return (nodes || []).map((n, i) => {
    if (n.type === 'text') return <Marks key={i} node={n} />;
    if (n.type === 'hardBreak') return <br key={i} />;
    return null;
  });
}

const CALLOUT_ICON = { warning: AlertTriangle, safety: ShieldAlert, tip: Lightbulb, note: Info };

export function Lightbox({ src, onClose }) {
  if (!src) return null;
  return (
    <div onClick={onClose} role="dialog" aria-label="Photo" style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(15,23,42,.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out' }}>
      <img src={src} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12 }} />
    </div>
  );
}

export default function Blocks({ doc, embeds = {}, onOpenPage, interactive = false, startNumber = 1, onVideoEnded }) {
  const [zoom, setZoom] = useState('');
  const [ticks, setTicks] = useState({});
  const content = Array.isArray(doc?.content) ? doc.content : [];
  let stepNo = startNumber;

  const render = (n, key, path = '') => {
    if (!n || typeof n !== 'object') return null;
    const kids = (n.content || []);
    switch (n.type) {
      case 'paragraph': return kids.length ? <p key={key}><Inline nodes={kids} /></p> : <p key={key}><br /></p>;
      case 'heading': {
        const L = Math.min(3, Math.max(1, Number(n.attrs?.level || 2)));
        const Tag = `h${L}`;
        return <Tag key={key} id={path === '' ? `h-${key}` : undefined}><Inline nodes={kids} /></Tag>;
      }
      case 'bulletList': return <ul key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</ul>;
      case 'orderedList': return <ol key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</ol>;
      case 'listItem': return <li key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</li>;
      case 'blockquote': return <blockquote key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</blockquote>;
      case 'horizontalRule': return <hr key={key} />;
      case 'hardBreak': return <br key={key} />;
      case 'codeBlock': return <pre key={key}><code>{kids.map((c) => c.text || '').join('')}</code></pre>;
      case 'table': return (
        <div key={key} style={{ overflowX: 'auto' }}>
          <table><tbody>{kids.map((r, i) => render(r, i, `${path}/${key}`))}</tbody></table>
        </div>
      );
      case 'tableRow': return <tr key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</tr>;
      case 'tableHeader': return <th key={key} colSpan={n.attrs?.colspan || 1} rowSpan={n.attrs?.rowspan || 1}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</th>;
      case 'tableCell': return <td key={key} colSpan={n.attrs?.colspan || 1} rowSpan={n.attrs?.rowspan || 1}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</td>;
      case 'image': return n.attrs?.src ? <img key={key} src={n.attrs.src} alt={n.attrs.alt || ''} loading="lazy" onClick={() => setZoom(n.attrs.src)} style={{ cursor: 'zoom-in' }} /> : null;
      case 'checklist': return <div key={key} style={{ margin: '0 0 12px' }}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</div>;
      case 'checkItem': {
        const id = `${path}/${key}`;
        return (
          <label key={key} className="kb-check-item">
            <input type="checkbox" checked={!!ticks[id]} onChange={() => setTicks((t) => ({ ...t, [id]: !t[id] }))} disabled={!interactive && false} />
            <span style={{ textDecoration: ticks[id] ? 'line-through' : 'none', color: ticks[id] ? 'var(--kb-dim)' : 'inherit' }}><Inline nodes={kids} /></span>
          </label>
        );
      }
      case 'steps': return <div key={key} className="kb-steps">{kids.map((c, i) => render(c, i, `${path}/${key}`))}</div>;
      case 'step': {
        const num = stepNo++;
        const [first, ...rest] = kids;
        const a = n.attrs || {};
        return (
          <div key={key} className="kb-step" id={`step-${num}`}>
            <span className="kb-step-num" aria-hidden="true">{num}</span>
            <div className="kb-step-title">{first ? render(first, 0, `${path}/${key}`) : <p>Step</p>}</div>
            {rest.length > 0 && <div className="kb-step-body">{rest.map((c, i) => render(c, i + 1, `${path}/${key}`))}</div>}
            {a.photos?.length > 0 && (
              <div className="kb-step-photos">
                {a.photos.map((p, i) => <img key={i} src={p} alt={`Step ${num} photo ${i + 1}`} loading="lazy" onClick={() => setZoom(p)} />)}
              </div>
            )}
            {a.warning && <div className="kb-step-flag warn"><AlertTriangle size={15} /><span><b>Warning.</b> {a.warning}</span></div>}
            {a.tip && <div className="kb-step-flag tip"><Lightbulb size={15} /><span>{a.tip}</span></div>}
            {a.photoRequired && <div className="kb-step-flag photo"><Camera size={15} /><span>A photo is required for this step when done as a task.</span></div>}
          </div>
        );
      }
      case 'callout': {
        const kind = n.attrs?.kind || 'note';
        const Icon = CALLOUT_ICON[kind] || Info;
        return <div key={key} className={`kb-callout ${kind}`}><Icon /><div>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</div></div>;
      }
      case 'video': {
        const url = n.attrs?.url || '';
        if (n.attrs?.kind === 'file' && url) {
          // An uploaded training video (WP 5.10): played here; the course player
          // counts the lesson only once it has played to the end (onVideoEnded).
          return (
            <figure key={key} style={{ margin: '12px 0' }}>
              <video src={url} controls preload="metadata" style={{ width: '100%', borderRadius: 10, background: '#000' }} onEnded={() => onVideoEnded?.(url)} />
              {n.attrs?.title && <figcaption className="kb-meta">{n.attrs.title}</figcaption>}
            </figure>
          );
        }
        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
        return (
          <a key={key} className="kb-video" href={url} target="_blank" rel="noopener noreferrer">
            <span className="play"><Play size={18} /></span>
            <span className="kb-grow"><span className="kb-title" style={{ display: 'block' }}>{n.attrs?.title || 'Video'}</span><span className="kb-meta">{host}</span></span>
          </a>
        );
      }
      case 'file': {
        // An attachment (WP 5.2): opens behind the reader's login.
        const url = n.attrs?.url || '';
        if (!url) return null;
        return (
          <a key={key} className="kb-video" href={url} target="_blank" rel="noopener noreferrer" download={n.attrs?.name || true}>
            <span className="play"><Paperclip size={18} /></span>
            <span className="kb-grow"><span className="kb-title" style={{ display: 'block' }}>{n.attrs?.name || 'File'}</span><span className="kb-meta">{['Attachment', fileSize(n.attrs?.size)].filter(Boolean).join(' · ')}</span></span>
            <Download size={16} style={{ color: 'var(--kb-dim)' }} />
          </a>
        );
      }
      case 'embedPage': {
        const id = n.attrs?.docId;
        const e = embeds[id];
        const title = e?.title || n.attrs?.title || 'A page';
        return (
          <div key={key} className="kb-embed" role="link" tabIndex={0} onClick={() => (onOpenPage ? onOpenPage(id) : goKb('page', id))}
               onKeyDown={(ev) => { if (ev.key === 'Enter') (onOpenPage ? onOpenPage(id) : goKb('page', id)); }}>
            <BookOpen size={18} style={{ color: 'var(--kb-green)', flex: '0 0 auto' }} />
            <span className="kb-grow"><span className="kb-title" style={{ display: 'block' }}>{title}</span>
              <span className="kb-meta">{e?.code ? `${e.code} · ` : ''}{e?.summary || 'Open this page'}</span></span>
          </div>
        );
      }
      case 'text': return <Marks key={key} node={n} />;
      default: return kids.length ? <div key={key}>{kids.map((c, i) => render(c, i, `${path}/${key}`))}</div> : null;
    }
  };

  return (
    <div className="kb-doc">
      {content.map((n, i) => render(n, i, ''))}
      <Lightbox src={zoom} onClose={() => setZoom('')} />
    </div>
  );
}
