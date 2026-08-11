// Egnyte module - the Details dialog (Egnyte "Details & Options" parity).
//
// One dialog for files and folders, fed entirely by data the listing already
// carries plus - for folders - the item counts out of the shared listing cache,
// so opening it costs at most one folder fetch that was probably prefetched
// anyway. Permissions, versions and sharing stay Egnyte's job; the dialog says
// so and links there.
import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Lock } from 'lucide-react';
import { formatDateTime } from '../lib/datetime';
import { formatBytes, getFolderCached, isShortcut, officeAppFor, parentOf } from './lib';
import { FileIcon, FolderIcon } from './EgnyteList';
import { EgnyteDialog, Spinner } from './ui';

function typeLabel(item, isFolder) {
  if (isFolder) return 'Folder';
  const name = item.name || '';
  if (isShortcut(name)) return 'Egnyte shortcut';
  const office = officeAppFor(name);
  if (office) return `${office} document`;
  const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
  return ext ? `${ext} file` : 'File';
}

// Tiny inline copy control - flips to a check for a moment so the click
// visibly landed, then goes back to being a copy button.
function CopyBtn({ value, what }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      title={copied ? 'Copied' : `Copy ${what}`}
      aria-label={`Copy ${what}`}
      onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => {})}
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: 3, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', borderRadius: 5,
        color: copied ? 'var(--wk-green)' : 'var(--wk-faint)',
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function DetailRow({ label, children }) {
  return (
    <>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--wk-faint)', paddingTop: 1 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--wk-ink)', minWidth: 0, wordBreak: 'break-word', display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        {children}
      </span>
    </>
  );
}

export default function EgnyteDetails({ item, isFolder, onClose, onDownload }) {
  // Folder item counts come from the same cache the browser reads, so this is
  // usually instant; null = loading, 'error' = the folder would not list.
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    if (!isFolder) return undefined;
    let alive = true;
    getFolderCached(item.path)
      .then(d => { if (alive) setCounts({ folders: d?.folders?.length || 0, files: d?.files?.length || 0 }); })
      .catch(() => { if (alive) setCounts('error'); });
    return () => { alive = false; };
  }, [isFolder, item.path]);

  const location = parentOf(item.path) || '/';
  const downloadable = !isFolder && !!onDownload;

  return (
    <EgnyteDialog
      title="Details"
      width={460}
      onClose={onClose}
      footer={
        <>
          {downloadable && (
            <button type="button" className="secondary-btn" onClick={() => onDownload(item)}>Download</button>
          )}
          {item.webUrl && (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => window.open(item.webUrl, '_blank', 'noopener')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <ExternalLink size={13} /> Open in Egnyte
            </button>
          )}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {isFolder ? <FolderIcon size={22} /> : <FileIcon name={item.name} size={22} />}
          <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--wk-ink)', minWidth: 0, wordBreak: 'break-word', lineHeight: 1.35 }}>
            {item.name || item.path?.split('/').pop() || 'Item'}
          </span>
          {item.locked && (
            <span title="Locked for editing in Egnyte" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: 'var(--wk-orange)', background: 'var(--wk-orange-bg)', borderRadius: 9, padding: '2px 8px', flexShrink: 0 }}>
              <Lock size={11} /> Locked
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', columnGap: 12, rowGap: 9, alignItems: 'start' }}>
          <DetailRow label="Type">{typeLabel(item, isFolder)}</DetailRow>
          <DetailRow label="Location">
            <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{location}</span>
          </DetailRow>
          <DetailRow label="Path">
            <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{item.path}</span>
            <CopyBtn value={item.path} what="path" />
          </DetailRow>
          {isFolder && (
            <DetailRow label="Contains">
              {counts === null ? <Spinner size={13} />
                : counts === 'error' ? <span style={{ color: 'var(--wk-faint)' }}>Could not load the folder's contents.</span>
                : `${counts.folders} folder${counts.folders === 1 ? '' : 's'}, ${counts.files} file${counts.files === 1 ? '' : 's'}`}
            </DetailRow>
          )}
          {!isFolder && Number(item.size) > 0 && (
            <DetailRow label="Size">{formatBytes(item.size)}</DetailRow>
          )}
          {item.modified && (
            <DetailRow label="Modified">{formatDateTime(item.modified)}</DetailRow>
          )}
          {!isFolder && item.uploaded && (
            <DetailRow label="Uploaded">{formatDateTime(item.uploaded)}</DetailRow>
          )}
          {!isFolder && item.uploadedBy && (
            <DetailRow label="Uploaded by">{item.uploadedBy}</DetailRow>
          )}
          {!isFolder && Number(item.versions) > 1 && (
            <DetailRow label="Versions">{item.versions}</DetailRow>
          )}
          {item.webUrl && (
            <DetailRow label="Egnyte link">
              <span style={{ minWidth: 0, wordBreak: 'break-all', color: 'var(--wk-dim)' }}>{item.webUrl}</span>
              <CopyBtn value={item.webUrl} what="Egnyte link" />
            </DetailRow>
          )}
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--wk-faint)', lineHeight: 1.5 }}>
          Permissions, version history and sharing are managed in Egnyte - the link above opens this item there.
        </div>
      </div>
    </EgnyteDialog>
  );
}
