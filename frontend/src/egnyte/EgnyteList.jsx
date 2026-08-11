// Egnyte module - the folder/file rows.
//
// One listing component shared by every Egnyte surface, so a file row looks and
// behaves the same wherever content shows up. Clicking a folder descends;
// clicking a file opens the Nexus viewer (which explains itself for types it
// cannot render, with Download one click away). Row actions - download, the
// Egnyte deep link and the "⋯" menu - reveal on hover so a full folder reads as
// a clean table; on touch they stay visible because there is no hover.
//
// Selection is the parent's state: rows render checkboxes only when the parent
// passes the selection props, so the pick-a-folder modal and the person card
// stay checkbox-free.
//
// Columns (Modified / Size) live in the .egx-cols grid and drop out on narrow
// viewports via the media query in style.css.
import { Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Link2, MoreVertical } from 'lucide-react';
import { formatBytes, formatWhen, isShortcut } from './lib';
import { ELLIPSIS, EmptyFolder, OpenInEgnyte, Spinner } from './ui';

const ICON_BTN = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 5,
  display: 'inline-flex', alignItems: 'center', color: 'var(--wk-faint)', flexShrink: 0,
  borderRadius: 6,
};

// Type recognition at a glance - the same trick every serious file manager
// plays. Muted, consistent hues per family; folders get the amber every OS
// trained people on. Iconography, not status - the --wk status tokens keep
// their semantic jobs.
const FOLDER_FILL = '#fdb64c';
const FOLDER_EDGE = '#ec9d29';

const FILE_VISUALS = [
  { exts: ['pdf'], Icon: FileText, color: '#e2445c' },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff'], Icon: FileImage, color: '#a25ddc' },
  { exts: ['xls', 'xlsx', 'csv'], Icon: FileSpreadsheet, color: '#00a25b' },
  { exts: ['doc', 'docx', 'txt', 'md', 'markdown', 'log', 'rtf'], Icon: FileText, color: '#579bfc' },
  { exts: ['ppt', 'pptx'], Icon: FileText, color: '#fdab3d' },
  { exts: ['zip', 'rar', '7z', 'tar', 'gz'], Icon: FileArchive, color: 'var(--wk-dim)' },
  { exts: ['mp4', 'mov', 'avi', 'mkv', 'webm'], Icon: FileVideo, color: '#a25ddc' },
  { exts: ['mp3', 'wav', 'm4a', 'flac'], Icon: FileAudio, color: '#a25ddc' },
];

const VISUAL_BY_EXT = new Map();
for (const v of FILE_VISUALS) for (const e of v.exts) VISUAL_BY_EXT.set(e, v);

export function FileIcon({ name = '', size = 17 }) {
  if (isShortcut(name)) return <Link2 size={size} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />;
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const v = VISUAL_BY_EXT.get(ext);
  const Icon = v?.Icon || File;
  return <Icon size={size} style={{ color: v?.color || 'var(--wk-faint)', flexShrink: 0 }} />;
}

export function FolderIcon({ size = 17 }) {
  return <Folder size={size} fill={FOLDER_FILL} style={{ color: FOLDER_EDGE, flexShrink: 0 }} />;
}

const CELL_META = { fontSize: 12, color: 'var(--wk-faint)', ...ELLIPSIS };

// Actions column width: three icon slots (download · open · menu). Fixed so
// the caption row and every row agree on where the grid ends.
const ACTIONS_W = 92;

const CHECK = {
  width: 15, height: 15, accentColor: 'var(--wk-brand)', cursor: 'pointer',
  margin: 0, flexShrink: 0,
};

function Row({ gridChildren, actions, onClick, onHover, onContext, title, checked, onCheck }) {
  return (
    <div className={`egnyte-row${checked ? ' is-selected' : ''}`} style={{ display: 'flex', alignItems: 'center', minWidth: 0 }} onMouseEnter={onHover} onContextMenu={onContext}>
      {onCheck && (
        <span className="egx-check" style={{ display: 'inline-flex', paddingLeft: 10, flexShrink: 0 }}>
          <input type="checkbox" checked={checked} onChange={onCheck} onClick={e => e.stopPropagation()} style={CHECK} aria-label="Select item" />
        </span>
      )}
      <button
        type="button"
        className="egx-cols"
        onClick={onClick}
        title={title}
        style={{
          flex: 1, minWidth: 0, padding: '10px 10px', border: 'none', background: 'none',
          textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--wk-ink)',
        }}
      >
        {gridChildren}
      </button>
      <div className="egx-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1, width: ACTIONS_W, paddingRight: 6, flexShrink: 0 }}>
        {actions}
      </div>
    </div>
  );
}

export default function EgnyteListing({
  folders = [],
  files = [],
  onOpenFolder,
  onHoverFolder,
  onDownload,
  onPreview,
  onMenu,                 // (item, isFolder, anchorRect) - opens the row menu
  selected,               // Set of paths, or undefined for no selection UI
  onToggleSelect,         // (path) => void
  onToggleAll,            // () => void
  downloadingPath = '',
  emptyLabel = 'This folder is empty.',
  emptyHint,
}) {
  if (!folders.length && !files.length) return <EmptyFolder label={emptyLabel} hint={emptyHint} />;

  const selectable = !!selected && !!onToggleSelect;
  const total = folders.length + files.length;
  const allChecked = selectable && total > 0 && selected.size >= total;

  const menuBtn = (item, isFolder) => onMenu && (
    <button
      type="button"
      style={ICON_BTN}
      title="More actions"
      aria-label={`Actions for ${item.name}`}
      onClick={e => { e.stopPropagation(); onMenu(item, isFolder, e.currentTarget.getBoundingClientRect()); }}
    >
      <MoreVertical size={15} />
    </button>
  );

  // Right-click opens the same menu at the cursor - the native file-manager
  // gesture. The zero-size rect anchors it; align 'left' opens it rightward.
  const contextFor = (item, isFolder) => onMenu && ((e) => {
    e.preventDefault();
    onMenu(item, isFolder, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }, 'left');
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Column captions - same grid as the rows so they cannot drift. */}
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, borderBottom: '1px solid var(--wk-line2)', marginBottom: 2 }}>
        {selectable && (
          <span style={{ display: 'inline-flex', paddingLeft: 10, flexShrink: 0 }}>
            <input type="checkbox" checked={allChecked} onChange={onToggleAll} style={CHECK} aria-label="Select all" />
          </span>
        )}
        <div className="egx-cols" style={{ flex: 1, minWidth: 0, padding: '4px 10px 7px' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-faint)' }}>Name</span>
          <span className="egx-col-meta" style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-faint)' }}>Modified</span>
          <span className="egx-col-meta" style={{ fontSize: 11, fontWeight: 600, color: 'var(--wk-faint)' }}>Size</span>
        </div>
        <span style={{ width: ACTIONS_W, flexShrink: 0 }} />
      </div>

      {folders.map(f => (
        <Row
          key={`d:${f.path}`}
          title={f.path}
          onClick={() => onOpenFolder?.(f.path, f.webUrl)}
          onHover={onHoverFolder ? () => onHoverFolder(f.path) : undefined}
          onContext={contextFor(f, true)}
          checked={selectable ? selected.has(f.path) : false}
          onCheck={selectable ? () => onToggleSelect(f.path) : undefined}
          gridChildren={
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <FolderIcon />
                <span style={{ fontSize: 14, fontWeight: 600, ...ELLIPSIS }}>{f.name}</span>
              </span>
              <span className="egx-col-meta" style={CELL_META}>{formatWhen(f.modified) || ''}</span>
              <span className="egx-col-meta" style={CELL_META} />
            </>
          }
          actions={
            <>
              <OpenInEgnyte url={f.webUrl} iconOnly />
              {menuBtn(f, true)}
            </>
          }
        />
      ))}

      {files.map(f => {
        const busy = downloadingPath === f.path;
        // Every real file opens in the Nexus viewer - it renders what it can and
        // explains what it cannot, with Download in reach either way. Shortcuts
        // (.egnyte_d) hold no content, so their click stays a download of the
        // pointer and their real home is the Egnyte link.
        const opensViewer = !!onPreview && !isShortcut(f.name);
        return (
          <Row
            key={`f:${f.path}`}
            title={opensViewer ? `View ${f.name}` : `Download ${f.name}`}
            onClick={() => { if (busy) return; if (opensViewer) onPreview(f); else onDownload?.(f); }}
            onContext={contextFor(f, false)}
            checked={selectable ? selected.has(f.path) : false}
            onCheck={selectable ? () => onToggleSelect(f.path) : undefined}
            gridChildren={
              <>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  {busy ? <Spinner size={17} /> : <FileIcon name={f.name} />}
                  <span style={{ fontSize: 14, ...ELLIPSIS }}>{f.name}</span>
                </span>
                <span className="egx-col-meta" style={CELL_META}>
                  {[formatWhen(f.modified), f.uploadedBy].filter(Boolean).join(' · ')}
                </span>
                <span className="egx-col-meta" style={CELL_META}>{formatBytes(f.size) || ''}</span>
              </>
            }
            actions={
              <>
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
                {menuBtn(f, false)}
              </>
            }
          />
        );
      })}
    </div>
  );
}
