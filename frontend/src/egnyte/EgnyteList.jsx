// Egnyte module - the folder/file rows.
//
// One listing component shared by the browser and the property panel, so a file
// row looks and behaves the same wherever Egnyte content shows up. Clicking a
// folder descends; clicking a file OPENS it in the Nexus viewer when the type
// allows, and downloads it otherwise. Download stays available on every row as
// its own button, so the row click can be the safe, reversible action. Every row
// also carries its Egnyte deep link, because Egnyte stays the place where
// permissions, versions and sharing are managed.
import { ChevronRight, Download, Eye, FileText, Folder } from 'lucide-react';
import { canPreview, formatBytes, formatWhen, isShortcut } from './lib';
import { BODY, ELLIPSIS, EmptyFolder, OpenInEgnyte, Spinner } from './ui';

const ICON_BTN = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 5,
  display: 'inline-flex', alignItems: 'center', color: 'var(--wk-faint)', flexShrink: 0,
};

const ROW = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  padding: '9px 10px', borderRadius: 7, border: 'none', background: 'none',
  textAlign: 'left', cursor: 'pointer', minWidth: 0,
  fontFamily: 'inherit', color: 'var(--wk-ink)',
};

function Meta({ file }) {
  const bits = [formatBytes(file.size), formatWhen(file.modified), file.uploadedBy].filter(Boolean);
  if (!bits.length) return null;
  return (
    <span style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)', ...ELLIPSIS }}>{bits.join(' · ')}</span>
  );
}

export default function EgnyteListing({
  folders = [],
  files = [],
  onOpenFolder,
  onDownload,
  onPreview,
  downloadingPath = '',
  emptyLabel = 'This folder is empty.',
  emptyHint,
}) {
  if (!folders.length && !files.length) return <EmptyFolder label={emptyLabel} hint={emptyHint} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {folders.map(f => (
        <div key={`d:${f.path}`} className="egnyte-row" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <button type="button" style={ROW} onClick={() => onOpenFolder?.(f.path, f.webUrl)} title={f.path}>
            <Folder size={16} style={{ color: 'var(--wk-blue)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, ...ELLIPSIS }}>{f.name}</span>
            <ChevronRight size={14} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
          </button>
          <OpenInEgnyte url={f.webUrl} iconOnly />
        </div>
      ))}

      {files.map(f => {
        const busy = downloadingPath === f.path;
        // Viewable in Nexus? Shortcuts are excluded even though ".egnyte_d" looks
        // like a file - they point at another item rather than holding content,
        // so previewing one would show meaningless bytes.
        const viewable = !!onPreview && canPreview(f) && !isShortcut(f.name);
        return (
          <div key={`f:${f.path}`} className="egnyte-row" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <button
              type="button"
              style={ROW}
              onClick={() => { if (busy) return; if (viewable) onPreview(f); else onDownload?.(f); }}
              title={viewable ? `View ${f.name}` : `Download ${f.name}`}
            >
              {busy
                ? <Spinner size={16} />
                : <FileText size={16} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 13.5, ...ELLIPSIS }}>{f.name}</span>
                <Meta file={f} />
              </span>
              {viewable && <Eye size={14} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />}
            </button>
            <button
              type="button"
              style={ICON_BTN}
              title={`Download ${f.name}`}
              aria-label={`Download ${f.name}`}
              onClick={e => { e.stopPropagation(); if (!busy) onDownload?.(f); }}
            >
              <Download size={14} />
            </button>
            <OpenInEgnyte url={f.webUrl} iconOnly />
          </div>
        );
      })}
    </div>
  );
}
