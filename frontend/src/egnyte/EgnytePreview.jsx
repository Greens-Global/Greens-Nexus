// Egnyte module - view a file WITHOUT leaving Nexus.
//
// Per Visesh (Jul 30): "I want to be able to view the files inside nexus and not
// just redirect to egnyte." Clicking a file used to download it or bounce the
// user to the Egnyte web app; both answer "what is in this document?" by making
// the person leave. This renders it in place instead, and keeps Download and
// Open in Egnyte as the two ways out.
//
// HOW THE BYTES GET HERE. The browser cannot call Egnyte directly - the API
// token lives on the server - so the bytes come through GET /egnyte/file
// (inline=true) and become a blob: URL. That URL inherits the APP's origin,
// which is exactly why the server keeps a hard allowlist of what it will serve
// inline: an HTML or SVG file out of a shared folder would otherwise execute as
// first-party script. previewKindFor() mirrors that list to pick a viewer; if
// the two ever disagree the server wins and the file merely downloads.
//
// Nothing here is cached or copied. The blob lives as long as the modal does.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileQuestion, X } from 'lucide-react';
import {
  MAX_TEXT_PREVIEW_BYTES, downloadEgnyteFile, egnyteErrorMessage,
  fetchEgnytePreview, formatBytes, isShortcut, previewKindFor,
} from './lib';
import { BODY, ELLIPSIS, HEADING, Loading, OpenInEgnyte, ProblemNote } from './ui';

// The sheet fills most of the viewport because these are plans and scans - a
// polite little dialog would defeat the point of viewing them here at all.
const SHEET = {
  background: 'var(--wk-card)',
  border: '1px solid var(--wk-line2)',
  borderRadius: 'var(--wk-r)',
  boxShadow: '0 24px 64px rgba(0,0,0,.32)',
  width: 'min(1100px, 96vw)',
  height: 'min(88vh, 100% - 24px)',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  overflow: 'hidden',
};

function Unsupported({ name, size }) {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <FileQuestion size={30} style={{ color: 'var(--wk-faint)', marginBottom: 12 }} />
      <div style={{ ...HEADING, fontSize: 14.5, marginBottom: 6 }}>No Preview For This Type</div>
      <div style={{ ...BODY, maxWidth: 420, margin: '0 auto' }}>
        Nexus previews PDFs, images and text files. {isShortcut(name)
          ? 'This is an Egnyte shortcut, which points at another file rather than holding one.'
          : 'Office documents and everything else open in Egnyte, or download and open locally.'}
      </div>
      {size > 0 && (
        <div style={{ ...BODY, fontSize: 12, marginTop: 8, color: 'var(--wk-faint)' }}>{formatBytes(size)}</div>
      )}
    </div>
  );
}

export default function EgnytePreview({ file, onClose, onNav = null, navIndex = -1, navCount = 0 }) {
  const [state, setState] = useState({ loading: true, url: '', text: '', error: '' });
  const [downloading, setDownloading] = useState(false);
  const urlRef = useRef('');

  const kind = previewKindFor(file?.name);
  const tooBigForText = kind === 'text' && Number(file?.size) > MAX_TEXT_PREVIEW_BYTES;
  const renderable = !!kind && !tooBigForText && !isShortcut(file?.name || '');

  const hasPrev = !!onNav && navIndex > 0;
  const hasNext = !!onNav && navIndex >= 0 && navIndex < navCount - 1;

  // Escape closes, the arrow keys walk the folder, and the page behind must not
  // scroll while a full-height sheet is over it - on iOS especially, that
  // scroll goes to the wrong element.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'ArrowLeft' && hasPrev) onNav(-1);
      if (e.key === 'ArrowRight' && hasNext) onNav(1);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, onNav, hasPrev, hasNext]);

  useEffect(() => {
    if (!file?.path || !renderable) { setState({ loading: false, url: '', text: '', error: '' }); return undefined; }
    let alive = true;
    setState({ loading: true, url: '', text: '', error: '' });

    fetchEgnytePreview(file.path)
      .then(async (blob) => {
        if (!alive) return;
        if (kind === 'text') {
          setState({ loading: false, url: '', text: await blob.text(), error: '' });
          return;
        }
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ loading: false, url, text: '', error: '' });
      })
      .catch(err => {
        if (!alive) return;
        setState({ loading: false, url: '', text: '', error: egnyteErrorMessage(err, `Could not open ${file.name}.`) });
      });

    return () => {
      alive = false;
      // Revoking on unmount is what keeps this from leaking a copy of every file
      // the user looked at for the rest of the session.
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ''; }
    };
  }, [file?.path, file?.name, kind, renderable]);

  if (!file) return null;

  const download = async () => {
    setDownloading(true);
    try {
      await downloadEgnyteFile(file.path, file.name);
    } catch (err) {
      setState(s => ({ ...s, error: egnyteErrorMessage(err, `Could not download ${file.name}.`) }));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      role="presentation"
      className="egx-overlay"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,18,24,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
        backdropFilter: 'blur(2px)',
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={file.name} className="egx-pop" style={{ ...SHEET, position: 'relative' }}>

        {hasPrev && (
          <button type="button" className="egx-navbtn" style={{ left: 12 }} title="Previous file (←)" aria-label="Previous file" onClick={() => onNav(-1)}>
            <ChevronLeft size={19} />
          </button>
        )}
        {hasNext && (
          <button type="button" className="egx-navbtn" style={{ right: 12 }} title="Next file (→)" aria-label="Next file" onClick={() => onNav(1)}>
            <ChevronRight size={19} />
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderBottom: '1px solid var(--wk-line2)', flexShrink: 0, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...HEADING, fontSize: 14, ...ELLIPSIS }} title={file.name}>{file.name}</div>
            <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)', ...ELLIPSIS }} title={file.path}>{file.path}</div>
          </div>
          {onNav && navIndex >= 0 && navCount > 1 && (
            <span style={{ ...BODY, fontSize: 12, color: 'var(--wk-faint)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {navIndex + 1} of {navCount}
            </span>
          )}
          <OpenInEgnyte url={file.webUrl} label="Open in Egnyte" />
          <button type="button" className="secondary-btn" disabled={downloading} onClick={download}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <Download size={13} /> {downloading ? 'Downloading…' : 'Download'}
          </button>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-dim)', padding: 5, display: 'inline-flex', flexShrink: 0 }}>
            <X size={17} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: kind === 'image' ? 'var(--wk-hover)' : 'var(--wk-card)' }}>
          {!renderable ? (
            <Unsupported name={file.name} size={file.size} />
          ) : state.loading ? (
            <Loading label="Opening file…" />
          ) : state.error ? (
            <ProblemNote message={state.error} />
          ) : kind === 'pdf' ? (
            // The browser's own PDF viewer.
            //
            // NO `sandbox` attribute, and that is a measured decision rather than
            // an oversight: under Playwright/WebKit a blob: PDF renders with no
            // sandbox and comes up BLANK with any sandbox value, including
            // "allow-scripts allow-same-origin". Sandboxing here would ship a
            // white rectangle to every Safari user. (Headless Chromium renders
            // blank in all cases because it bundles no PDF viewer, so it cannot
            // testify either way.)
            //
            // What actually keeps this safe is upstream: the server decides the
            // blob's content type and will only ever answer application/pdf for
            // a .pdf, so this frame cannot be handed markup to execute.
            <iframe
              title={file.name}
              src={state.url}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          ) : kind === 'image' ? (
            <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <img src={state.url} alt={file.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
            </div>
          ) : (
            <pre style={{ margin: 0, padding: 16, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.6, color: 'var(--wk-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {state.text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
