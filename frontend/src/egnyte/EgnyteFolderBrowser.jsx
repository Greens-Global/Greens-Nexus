// Egnyte module - the folder browser.
//
// Desktop file-manager shape: a lazy folder tree on the left, the open folder's
// contents on the right, one toolbar carrying breadcrumb, search and actions.
// Click a file and it opens in the Nexus viewer with arrow navigation through
// the folder's other files. Nexus holds no index and no copy: every listing,
// byte and search result comes from Egnyte on demand, and every row links back.
//
// The tree is opt-in (showTree) because this component also mounts inside the
// wiring folder picker and the HR person card, where a whole-domain tree is
// either cramped or the wrong scope. The .egx-* layout classes respond to the
// CONTAINER, so the same markup collapses to a single pane in narrow homes.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bookmark, Check, ChevronRight, Copy, Download, ExternalLink, Eye, FolderInput,
  FolderPlus, HardDrive, Link2, MoreVertical, PenLine, RefreshCw, Search, Trash2,
  Upload, X,
} from 'lucide-react';
import { api } from '../api';
import {
  canPreview, crumbsFor, downloadEgnyteFile, egnyteErrorMessage, getFolderCached,
  invalidateFolder, isNotConnected, isShortcut, normPath, prefetchChildren,
  prefetchFolder,
} from './lib';
import FolderPickModal from './EgnyteFolderPick';
import EgnyteListing from './EgnyteList';
import EgnytePreview from './EgnytePreview';
import EgnyteTree from './EgnyteTree';
import EgnyteUpload from './EgnyteUpload';
import {
  BODY, CARD, ConnectRequired, EgnyteDialog, EgnyteMenu, ELLIPSIS, Loading,
  NotConnected, Notice, OpenInEgnyte, ProblemNote, Spinner,
} from './ui';

const BOOKMARKS_KEY = 'egx-bookmarks';

function loadBookmarks() {
  try {
    const v = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(b => b && b.path) : [];
  } catch { return []; }
}

export default function EgnyteFolderBrowser({
  initialPath = '',
  canWrite = false,
  rootLabel = 'Egnyte',
  showUpload = true,
  showTree = false,
  // Pick mode: when set, the browser doubles as a folder PICKER - a "Use This
  // Folder" action appears and calls onPick(path) with the folder on screen.
  // Used by the Wiring tab; a plain browse mount is unchanged.
  onPick = null,
}) {
  const [path, setPath] = useState(normPath(initialPath));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConnected, setNotConnected] = useState(false);
  // 428 from the API: OAuth is on and this person hasn't connected their own
  // Egnyte account - every browse surface renders the same connect prompt.
  const [connectRequired, setConnectRequired] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [rowError, setRowError] = useState('');
  // The file open in the Nexus viewer, or null. Held here rather than in the
  // listing so a search result and a folder row open the same viewer, and so
  // the arrows can walk the same list the person is looking at.
  const [preview, setPreview] = useState(null);
  // Bumped when a folder is created so the tree refetches that node.
  const [treeSync, setTreeSync] = useState({ path: '', seq: 0 });

  // Folder web URLs only ever arrive on the PARENT's listing, so remember them
  // as the user descends. That makes "Open in Egnyte" work for the folder you
  // are standing in, including after a breadcrumb jump back up. The frontend
  // cannot derive the link itself - only the backend knows the Egnyte domain.
  const webUrls = useRef(new Map());
  const [folderUrl, setFolderUrl] = useState('');

  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);

  // "/" focuses search from anywhere in the browser - unless the person is
  // already typing somewhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback((target, { force = false } = {}) => {
    const next = normPath(target);
    setLoading(true);
    setError('');
    setNotConnected(false);
    setRowError('');
    getFolderCached(next, { force })
      .then(d => {
        setData(d);
        setPath(next);
        setFolderUrl(webUrls.current.get(next) || '');
        for (const f of d?.folders || []) if (f.webUrl) webUrls.current.set(normPath(f.path), f.webUrl);
        // Warm the folders now on screen so the next click opens instantly.
        prefetchChildren(d);
      })
      .catch(err => {
        setData(null);
        setNotConnected(isNotConnected(err));
        setConnectRequired(err?.status === 428);
        setError(egnyteErrorMessage(err, 'Could not open that folder.'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(initialPath); }, [load, initialPath]);

  // ── selection, bookmarks, row-menu, file-manager verbs (Aug 11) ──
  const [selected, setSelected] = useState(() => new Set());
  const [menu, setMenu] = useState(null);              // {item, isFolder, rect, align}
  const [createMenu, setCreateMenu] = useState(null);  // anchor rect for the Create dropdown
  const uploadTrigger = useRef(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);   // [paths]
  const [destPick, setDestPick] = useState(null);      // {mode: 'move'|'copy', paths}
  const [bulkBusy, setBulkBusy] = useState('');
  const [bookmarks, setBookmarks] = useState(loadBookmarks);

  const saveBookmarks = (next) => {
    setBookmarks(next);
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const isBookmarked = (p) => bookmarks.some(b => normPath(b.path) === normPath(p));
  const toggleBookmark = (p, name) => {
    const key = normPath(p);
    saveBookmarks(isBookmarked(key)
      ? bookmarks.filter(b => normPath(b.path) !== key)
      : [...bookmarks, { path: key, name: name || key.split('/').pop() }]);
  };

  const openFolder = (p, url) => {
    if (url) webUrls.current.set(normPath(p), url);
    setResults(null);
    setSearchTerm('');
    setQuery('');
    setNewFolderOpen(false);
    setSelected(new Set());
    load(p);
  };

  const download = async (file) => {
    setDownloading(file.path);
    setRowError('');
    try {
      await downloadEgnyteFile(file.path, file.name);
    } catch (err) {
      setRowError(egnyteErrorMessage(err, `Could not download ${file.name}.`));
    } finally {
      setDownloading('');
    }
  };

  // Search results are files too: they open in the same viewer, and shortcuts
  // (which hold no content) fall back to download.
  const openResult = (r) => {
    if (!isShortcut(r.name)) setPreview(r);
    else download(r);
  };

  const runSearch = (e) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) { setResults(null); setSearchTerm(''); return; }
    setSearching(true);
    setRowError('');
    api.egnyteSearch(q, path)
      .then(r => { setResults(r?.results || []); setSearchTerm(q); })
      .catch(err => { setResults([]); setSearchTerm(q); setRowError(egnyteErrorMessage(err, 'Search failed.')); })
      .finally(() => setSearching(false));
  };

  const clearSearch = () => { setResults(null); setSearchTerm(''); setQuery(''); };

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    setRowError('');
    api.egnyteCreateFolder(`${path}/${name}`)
      .then(() => {
        setNewFolderOpen(false);
        setNewFolderName('');
        invalidateFolder(path);
        setTreeSync(s => ({ path, seq: s.seq + 1 }));
        load(path, { force: true });
      })
      .catch(err => setRowError(egnyteErrorMessage(err, 'Could not create that folder.')))
      .finally(() => setCreating(false));
  };

  // After any mutation: drop the cached listing, refresh the pane and the tree
  // node, clear the selection - the screen must show what Egnyte now holds.
  const afterMutate = () => {
    invalidateFolder(path);
    setTreeSync(s => ({ path, seq: s.seq + 1 }));
    setSelected(new Set());
    load(path, { force: true });
  };

  const allItems = [...(data?.folders || []), ...(data?.files || [])];
  const toggleSelect = (p) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });
  const toggleAll = () => setSelected(prev => (
    prev.size >= allItems.length ? new Set() : new Set(allItems.map(i => i.path))
  ));

  const parentOfPath = (p) => normPath(p).slice(0, normPath(p).lastIndexOf('/')) || '/';
  const nameOfPath = (p) => normPath(p).split('/').pop();

  const doRename = async () => {
    const nn = renameName.trim();
    if (!nn || !renameTarget) return;
    setBulkBusy('Renaming…');
    setRowError('');
    try {
      await api.egnyteMove(renameTarget.path, `${parentOfPath(renameTarget.path)}/${nn}`);
      setRenameTarget(null);
      afterMutate();
    } catch (err) {
      setRowError(egnyteErrorMessage(err, `Could not rename ${renameTarget.name}.`));
    } finally {
      setBulkBusy('');
    }
  };

  const doDelete = async () => {
    const paths = confirmDelete || [];
    setConfirmDelete(null);
    setBulkBusy(`Deleting ${paths.length} item${paths.length === 1 ? '' : 's'}…`);
    setRowError('');
    try {
      for (const p of paths) await api.egnyteDelete(p);
      afterMutate();
    } catch (err) {
      setRowError(egnyteErrorMessage(err, 'Could not delete some of the items.'));
      afterMutate();
    } finally {
      setBulkBusy('');
    }
  };

  const doMoveCopy = async (destFolder) => {
    const { mode, paths } = destPick || {};
    setDestPick(null);
    if (!paths?.length) return;
    const verb = mode === 'move' ? 'Moving' : 'Copying';
    setBulkBusy(`${verb} ${paths.length} item${paths.length === 1 ? '' : 's'}…`);
    setRowError('');
    const call = mode === 'move' ? api.egnyteMove : api.egnyteCopy;
    try {
      for (const p of paths) {
        await call(p, `${normPath(destFolder)}/${nameOfPath(p)}`);
        invalidateFolder(parentOfPath(p));
      }
      invalidateFolder(destFolder);
      afterMutate();
    } catch (err) {
      setRowError(egnyteErrorMessage(err, `Could not ${mode} some of the items.`));
      afterMutate();
    } finally {
      setBulkBusy('');
    }
  };

  const downloadSelected = async () => {
    const files = allItems.filter(i => selected.has(i.path) && !(data?.folders || []).some(f => f.path === i.path));
    setBulkBusy(`Downloading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    try {
      for (const f of files) await downloadEgnyteFile(f.path, f.name);
    } catch (err) {
      setRowError(egnyteErrorMessage(err, 'Could not download some of the files.'));
    } finally {
      setBulkBusy('');
    }
  };

  const copyEgnyteLink = (item) => {
    if (item.webUrl) navigator.clipboard?.writeText(item.webUrl).catch(() => {});
  };

  // The "⋯" menu for one row. Write verbs appear only with write access; the
  // caller's own Egnyte permissions still decide server-side, and a refusal
  // surfaces as the row error.
  const menuItems = (item, isFolder, { skipOpen = false } = {}) => {
    const write = canWrite;
    return [
      isFolder
        ? (skipOpen ? null : { label: 'Open', icon: <FolderInput size={14} />, onClick: () => openFolder(item.path, item.webUrl) })
        : (canPreview(item) && !isShortcut(item.name)
          ? { label: 'View', icon: <Eye size={14} />, onClick: () => setPreview(item) }
          : null),
      !isFolder && { label: 'Download', icon: <Download size={14} />, onClick: () => download(item) },
      isFolder && {
        label: isBookmarked(item.path) ? 'Remove bookmark' : 'Add bookmark',
        icon: <Bookmark size={14} />,
        onClick: () => toggleBookmark(item.path, item.name),
      },
      'divider',
      write && { label: 'Rename', icon: <PenLine size={14} />, onClick: () => { setRenameTarget(item); setRenameName(item.name); } },
      write && { label: 'Move to…', icon: <FolderInput size={14} />, onClick: () => setDestPick({ mode: 'move', paths: [item.path] }) },
      write && { label: 'Copy to…', icon: <Copy size={14} />, onClick: () => setDestPick({ mode: 'copy', paths: [item.path] }) },
      write && 'divider',
      item.webUrl && { label: 'Copy Egnyte link', icon: <Link2 size={14} />, onClick: () => copyEgnyteLink(item) },
      item.webUrl && { label: 'Open in Egnyte', icon: <ExternalLink size={14} />, onClick: () => window.open(item.webUrl, '_blank', 'noopener') },
      write && 'divider',
      write && { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => setConfirmDelete([item.path]) },
    ];
  };

  // ── resizable tree pane ──
  const [treeW, setTreeW] = useState(() => {
    const saved = Number(localStorage.getItem('egx-tree-w'));
    return saved >= 180 && saved <= 440 ? saved : 252;
  });
  const [draggingPane, setDraggingPane] = useState(false);
  const dragStart = useRef({ x: 0, w: 252 });
  const clampW = (w) => Math.min(440, Math.max(180, Math.round(w)));
  const startPaneDrag = (e) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, w: treeW };
    setDraggingPane(true);
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (ev) => setTreeW(clampW(dragStart.current.w + (ev.clientX - dragStart.current.x)));
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = prevSelect;
      setDraggingPane(false);
      localStorage.setItem('egx-tree-w', String(clampW(dragStart.current.w + (ev.clientX - dragStart.current.x))));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const nudgePane = (delta) => {
    setTreeW(w => {
      const next = clampW(w + delta);
      localStorage.setItem('egx-tree-w', String(next));
      return next;
    });
  };

  if (notConnected) return <NotConnected error="" />;
  if (connectRequired) return <ConnectRequired />;

  const crumbs = crumbsFor(path);

  // What the arrows walk: the files the person is currently looking at, in the
  // order shown. Shortcuts are skipped - the viewer has nothing to show for a
  // pointer.
  const navList = (results ?? data?.files ?? []).filter(f => !isShortcut(f.name));
  const navIndex = preview ? navList.findIndex(f => f.path === preview.path) : -1;
  const navTo = (delta) => {
    const next = navList[navIndex + delta];
    if (next) setPreview(next);
  };

  const listingPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

      {/* ── Header: breadcrumb trail on top, then folder title · search · actions ── */}
      <div style={{ ...CARD, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px 0', minWidth: 0 }}>
          <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0, overflowX: 'auto' }}>
            <button
              type="button"
              onClick={() => openFolder('')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 5, fontFamily: 'inherit', fontSize: 12, fontWeight: 500, color: 'var(--wk-dim)', whiteSpace: 'nowrap' }}
            >
              <HardDrive size={12} /> {rootLabel}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <ChevronRight size={11} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
                <button
                  type="button"
                  onClick={() => openFolder(c.path)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 5, fontFamily: 'inherit', fontSize: 12, fontWeight: i === crumbs.length - 1 ? 600 : 500, color: i === crumbs.length - 1 ? 'var(--wk-ink)' : 'var(--wk-dim)', whiteSpace: 'nowrap', maxWidth: 180, ...ELLIPSIS }}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            <OpenInEgnyte url={folderUrl} label="Open in Egnyte" />
            <button type="button" title="Refresh" aria-label="Refresh" onClick={() => load(path, { force: true })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-dim)', padding: 6, borderRadius: 6, display: 'inline-flex' }}>
              <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '2px 14px 11px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flex: '1 1 0' }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--wk-ink)', letterSpacing: '-.01em', maxWidth: 320, ...ELLIPSIS }}>
              {path ? crumbs[crumbs.length - 1]?.name : rootLabel}
            </span>
            {!loading && !error && !results && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--wk-dim)', background: 'var(--wk-hover)', borderRadius: 10, padding: '2px 9px', whiteSpace: 'nowrap' }}>
                {(data?.folders?.length || 0) + (data?.files?.length || 0)} items
              </span>
            )}
          </div>

          {/* Centered: the title zone and the right zone flex equally, so the
              search sits in the middle of the card on wide screens and wraps
              to its own full-width line on narrow ones. */}
          <form className="egx-search" onSubmit={runSearch} style={{ position: 'relative', flex: '0 1 480px', minWidth: 180 }}>
            {searching
              ? <Spinner size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-faint)' }} />
              : <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-faint)', pointerEvents: 'none' }} />}
            <input
              ref={searchRef}
              className="form-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={path ? `Search in ${crumbs[crumbs.length - 1]?.name || 'this folder'}` : 'Search all of Egnyte'}
              title="Press Enter to search"
              style={{ width: '100%', paddingLeft: 32, paddingRight: (query || results) ? 32 : 40 }}
            />
            {(query || results) ? (
              <button
                type="button"
                onClick={clearSearch}
                title="Clear search"
                aria-label="Clear search"
                style={{ position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-faint)', padding: 5, display: 'inline-flex' }}
              >
                <X size={14} />
              </button>
            ) : (
              <kbd style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color: 'var(--wk-faint)', background: 'var(--wk-card)', border: '1px solid var(--wk-line2)', borderRadius: 5, padding: '1px 6px', pointerEvents: 'none' }}>/</kbd>
            )}
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', flex: '1 1 0', minWidth: 0 }}>
            {onPick && (
              <button type="button" className="primary-btn" onClick={() => onPick(path)} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <Check size={13} /> Use This Folder
              </button>
            )}
          </div>
        </div>

        {/* ── Action toolbar, Egnyte-style: Create + always-visible verbs that
            light up with the selection. Not rendered in pick mode. ── */}
        {!onPick && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '9px 12px', borderTop: '1px solid var(--wk-line2)' }}>
            {canWrite && (
              <button
                type="button"
                className="primary-btn"
                onClick={e => setCreateMenu(e.currentTarget.getBoundingClientRect())}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <FolderPlus size={14} /> Create <ChevronRight size={13} style={{ transform: 'rotate(90deg)' }} />
              </button>
            )}
            {canWrite && (
              <button type="button" className="egx-toolbtn" title="Upload files to this folder" aria-label="Upload files"
                onClick={() => uploadTrigger.current?.()}>
                <Upload size={15} />
              </button>
            )}
            <button type="button" className="egx-toolbtn" title={selected.size ? 'Download selected files' : 'Select files to download'} aria-label="Download selected"
              disabled={![...selected].some(p => (data?.files || []).some(f => f.path === p))}
              onClick={downloadSelected}>
              <Download size={15} />
            </button>
            {canWrite && (
              <>
                <button type="button" className="egx-toolbtn" title={selected.size ? 'Move selected' : 'Select items to move'} aria-label="Move selected"
                  disabled={!selected.size} onClick={() => setDestPick({ mode: 'move', paths: [...selected] })}>
                  <FolderInput size={15} />
                </button>
                <button type="button" className="egx-toolbtn" title={selected.size ? 'Copy selected' : 'Select items to copy'} aria-label="Copy selected"
                  disabled={!selected.size} onClick={() => setDestPick({ mode: 'copy', paths: [...selected] })}>
                  <Copy size={15} />
                </button>
                <button type="button" className="egx-toolbtn is-danger" title={selected.size ? 'Delete selected' : 'Select items to delete'} aria-label="Delete selected"
                  disabled={!selected.size} onClick={() => setConfirmDelete([...selected])}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
            <button type="button" className={`egx-toolbtn${path && isBookmarked(path) ? ' is-on' : ''}`}
              title={!path ? 'Open a folder to bookmark it' : (isBookmarked(path) ? 'Remove bookmark' : 'Bookmark this folder')}
              aria-label="Bookmark this folder"
              disabled={!path}
              onClick={() => toggleBookmark(path, crumbs[crumbs.length - 1]?.name)}>
              <Bookmark size={15} fill={path && isBookmarked(path) ? 'currentColor' : 'none'} />
            </button>
            <button type="button" className="egx-toolbtn" title="Folder actions" aria-label="Folder actions"
              disabled={!path}
              onClick={e => setMenu({
                item: { name: crumbs[crumbs.length - 1]?.name || '', path, webUrl: folderUrl },
                isFolder: true, skipOpen: true,
                rect: e.currentTarget.getBoundingClientRect(),
              })}>
              <MoreVertical size={15} />
            </button>
            {selected.size > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--wk-ink)' }}>
                {selected.size} selected
                <button type="button" onClick={() => setSelected(new Set())} title="Clear selection" aria-label="Clear selection"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-dim)', padding: 4, display: 'inline-flex', borderRadius: 5 }}>
                  <X size={14} />
                </button>
              </span>
            )}
          </div>
        )}

        {newFolderOpen && canWrite && (
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--wk-line2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="form-input"
              autoFocus
              placeholder="New folder name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setNewFolderOpen(false); }}
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <button type="button" className="primary-btn" disabled={creating || !newFolderName.trim()} onClick={createFolder}>
              {creating ? 'Creating…' : 'Create Folder'}
            </button>
            <button type="button" className="secondary-btn" onClick={() => { setNewFolderOpen(false); setNewFolderName(''); }}>Cancel</button>
          </div>
        )}
      </div>

      {rowError && <Notice tone="error" onDismiss={() => setRowError('')}>{rowError}</Notice>}

      {bulkBusy && (
        <div style={{ ...CARD, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--wk-dim)' }}>
          <Spinner size={14} /> {bulkBusy}
        </div>
      )}

      {/* ── Upload into the folder currently being viewed ── */}
      {showUpload && !results && (
        <EgnyteUpload folder={path} canWrite={canWrite} triggerRef={uploadTrigger} onUploaded={() => { invalidateFolder(path); load(path, { force: true }); }} />
      )}

      {/* ── Listing or search results ── */}
      <div style={{ ...CARD, padding: 6, minWidth: 0 }}>
        {results ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 8px', borderBottom: '1px solid var(--wk-line2)', marginBottom: 2 }}>
              <span style={{ ...BODY, fontSize: 12, flex: 1, minWidth: 0 }}>
                {results.length
                  ? `${results.length} result${results.length === 1 ? '' : 's'} for "${searchTerm}"${path ? ' in this folder' : ''}.`
                  : `No results for "${searchTerm}"${path ? ' in this folder' : ''}.`}
              </span>
              <button type="button" onClick={clearSearch} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-brand)', fontSize: 12, fontWeight: 600, padding: '2px 4px', flexShrink: 0 }}>
                Clear
              </button>
            </div>
            {results.map(r => (
              <div key={r.path} className="egnyte-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0, padding: '4px 0' }}>
                <button
                  type="button"
                  onClick={() => openResult(r)}
                  title={!isShortcut(r.name) ? `View ${r.name}` : `Download ${r.name}`}
                  style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', padding: '6px 8px', fontFamily: 'inherit', color: 'var(--wk-ink)' }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {downloading === r.path && <Spinner size={13} />}
                    <span style={ELLIPSIS}>{r.name}</span>
                  </span>
                  <span style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)', ...ELLIPSIS }}>{r.path}</span>
                  {r.snippet && (
                    <span style={{ ...BODY, fontSize: 12, color: 'var(--wk-dim)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {r.snippet}
                    </span>
                  )}
                </button>
                <OpenInEgnyte url={r.webUrl} iconOnly />
              </div>
            ))}
          </>
        ) : loading ? (
          <Loading label="Loading folder…" />
        ) : error ? (
          <ProblemNote message={error} onRetry={() => load(path)} />
        ) : (
          <EgnyteListing
            folders={data?.folders || []}
            files={data?.files || []}
            onOpenFolder={openFolder}
            onHoverFolder={prefetchFolder}
            onDownload={download}
            onPreview={setPreview}
            onMenu={onPick ? undefined : (item, isFolder, rect, align) => setMenu({ item, isFolder, rect, align })}
            selected={onPick ? undefined : selected}
            onToggleSelect={onPick ? undefined : toggleSelect}
            onToggleAll={onPick ? undefined : toggleAll}
            downloadingPath={downloading}
            emptyLabel="This folder is empty."
            emptyHint={canWrite ? 'Drop a file here to add the first one.' : undefined}
          />
        )}
      </div>

      <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)' }}>
        Files stay in Egnyte. Nexus reads and writes them in place, so there is never a second copy to keep in sync.
      </div>
    </div>
  );

  return (
    <div className="egx-wrap" style={{ minWidth: 0 }}>
      {showTree ? (
        <div className="egx-layout" style={{ '--egx-tree-w': `${treeW}px` }}>
          <aside className="egx-tree-pane" style={{ ...CARD, padding: '8px 6px', minWidth: 0 }}>
            <EgnyteTree
              currentPath={path}
              onSelect={openFolder}
              refreshSignal={treeSync}
              rootLabel={rootLabel}
              bookmarks={bookmarks}
              onRemoveBookmark={(p) => toggleBookmark(p)}
              onNodeMenu={(node, rect) => setMenu({ item: node, isFolder: true, rect, align: 'left' })}
            />
          </aside>
          <div
            className={`egx-divider${draggingPane ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the folder tree"
            tabIndex={0}
            title="Drag to resize"
            onPointerDown={startPaneDrag}
            onKeyDown={e => {
              if (e.key === 'ArrowLeft') { e.preventDefault(); nudgePane(-16); }
              if (e.key === 'ArrowRight') { e.preventDefault(); nudgePane(16); }
            }}
          />
          {listingPane}
        </div>
      ) : listingPane}

      {preview && (
        <EgnytePreview
          file={preview}
          onClose={() => setPreview(null)}
          onNav={navIndex >= 0 && navList.length > 1 ? navTo : null}
          navIndex={navIndex}
          navCount={navList.length}
        />
      )}

      {menu && (
        <EgnyteMenu
          anchorRect={menu.rect}
          align={menu.align || 'right'}
          items={menuItems(menu.item, menu.isFolder, { skipOpen: !!menu.skipOpen })}
          onClose={() => setMenu(null)}
        />
      )}

      {createMenu && (
        <EgnyteMenu
          anchorRect={createMenu}
          align="left"
          onClose={() => setCreateMenu(null)}
          items={[
            { label: 'Folder', icon: <FolderPlus size={14} />, onClick: () => setNewFolderOpen(true) },
            { label: 'Upload files', icon: <Upload size={14} />, onClick: () => uploadTrigger.current?.() },
          ]}
        />
      )}

      {renameTarget && (
        <EgnyteDialog
          title={`Rename ${renameTarget.name}`}
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <button type="button" className="secondary-btn" onClick={() => setRenameTarget(null)}>Cancel</button>
              <button type="button" className="primary-btn" disabled={!renameName.trim() || renameName.trim() === renameTarget.name} onClick={doRename}>
                Rename
              </button>
            </>
          }
        >
          <input
            className="form-input"
            autoFocus
            value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doRename(); }}
            style={{ width: '100%' }}
          />
        </EgnyteDialog>
      )}

      {confirmDelete && (
        <EgnyteDialog
          title={`Delete ${confirmDelete.length === 1 ? nameOfPath(confirmDelete[0]) : `${confirmDelete.length} items`}?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button type="button" className="secondary-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button type="button" className="egx-danger-btn" onClick={doDelete} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Trash2 size={13} /> Delete
              </button>
            </>
          }
        >
          {confirmDelete.length === 1
            ? 'It moves to Egnyte\'s Trash and can be restored from the Egnyte app.'
            : `These ${confirmDelete.length} items move to Egnyte's Trash and can be restored from the Egnyte app.`}
        </EgnyteDialog>
      )}

      {destPick && (
        <FolderPickModal
          startPath={path}
          title={destPick.mode === 'move' ? 'Move To' : 'Copy To'}
          hint={`Browse to the destination folder, then press "Use This Folder" to ${destPick.mode} ${destPick.paths.length === 1 ? nameOfPath(destPick.paths[0]) : `${destPick.paths.length} items`} there.`}
          onPick={doMoveCopy}
          onClose={() => setDestPick(null)}
        />
      )}
    </div>
  );
}
