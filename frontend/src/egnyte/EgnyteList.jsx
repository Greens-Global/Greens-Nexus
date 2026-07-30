// Egnyte module - the folder/file rows.
//
// One listing component shared by the browser and the property panel, so a file
// row looks and behaves the same wherever Egnyte content shows up. Clicking a
// folder descends; clicking a file pulls the bytes down through the API. Every
// row also carries its Egnyte deep link, because Egnyte stays the place where
// permissions, versions and sharing are managed.
import { ChevronRight, Download, FileText, Folder } from 'lucide-react';
import { formatBytes, formatWhen } from './lib';
import { BODY, ELLIPSIS, EmptyFolder, OpenInEgnyte, Spinner } from './ui';

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
        return (
          <div key={`f:${f.path}`} className="egnyte-row" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <button type="button" style={ROW} onClick={() => !busy && onDownload?.(f)} title={`Download ${f.name}`}>
              {busy
                ? <Spinner size={16} />
                : <FileText size={16} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 13.5, ...ELLIPSIS }}>{f.name}</span>
                <Meta file={f} />
              </span>
              <Download size={14} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
            </button>
            <OpenInEgnyte url={f.webUrl} iconOnly />
          </div>
        );
      })}
    </div>
  );
}
