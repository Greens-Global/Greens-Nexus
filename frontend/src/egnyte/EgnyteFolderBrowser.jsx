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
import { Check, ChevronRight, FolderPlus, HardDrive, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';
import {
  crumbsFor, downloadEgnyteFile, egnyteErrorMessage, getFolderCached,
  invalidateFolder, isNotConnected, isShortcut, normPath, prefetchChildren,
  prefetchFolder,
} from './lib';
import EgnyteListing from './EgnyteList';
import EgnytePreview from './EgnytePreview';
import EgnyteTree from './EgnyteTree';
import EgnyteUpload from './EgnyteUpload';
import {
  BODY, CARD, ConnectRequired, ELLIPSIS, Loading, NotConnected, Notice, OpenInEgnyte, ProblemNote, Spinner,
} from './ui';

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

  const openFolder = (p, url) => {
    if (url) webUrls.current.set(normPath(p), url);
    setResults(null);
    setSearchTerm('');
    setQuery('');
    setNewFolderOpen(false);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flexShrink: 1 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--wk-ink)', letterSpacing: '-.01em', maxWidth: 320, ...ELLIPSIS }}>
              {path ? crumbs[crumbs.length - 1]?.name : rootLabel}
            </span>
            {!loading && !error && !results && (
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--wk-dim)', background: 'var(--wk-hover)', borderRadius: 10, padding: '2px 9px', whiteSpace: 'nowrap' }}>
                {(data?.folders?.length || 0) + (data?.files?.length || 0)} items
              </span>
            )}
          </div>

          <form onSubmit={runSearch} style={{ position: 'relative', flex: '1 1 220px', minWidth: 150, maxWidth: 420 }}>
            {searching
              ? <Spinner size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-faint)' }} />
              : <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-faint)', pointerEvents: 'none' }} />}
            <input
              className="form-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={path ? `Search in ${crumbs[crumbs.length - 1]?.name || 'this folder'}` : 'Search all of Egnyte'}
              title="Press Enter to search"
              style={{ width: '100%', paddingLeft: 30, paddingRight: (query || results) ? 30 : 10 }}
            />
            {(query || results) && (
              <button
                type="button"
                onClick={clearSearch}
                title="Clear search"
                aria-label="Clear search"
                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--wk-faint)', padding: 5, display: 'inline-flex' }}
              >
                <X size={14} />
              </button>
            )}
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
            {onPick && (
              <button type="button" className="primary-btn" onClick={() => onPick(path)} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Check size={13} /> Use This Folder
              </button>
            )}
            {canWrite && (
              <button type="button" className={onPick ? 'secondary-btn' : 'primary-btn'} onClick={() => setNewFolderOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FolderPlus size={13} /> New Folder
              </button>
            )}
          </div>
        </div>

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

      {/* ── Upload into the folder currently being viewed ── */}
      {showUpload && !results && (
        <EgnyteUpload folder={path} canWrite={canWrite} onUploaded={() => { invalidateFolder(path); load(path, { force: true }); }} />
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
            <EgnyteTree currentPath={path} onSelect={openFolder} refreshSignal={treeSync} rootLabel={rootLabel} />
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
    </div>
  );
}
