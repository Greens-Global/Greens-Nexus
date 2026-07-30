// Egnyte module - the folder browser.
//
// Breadcrumb down into a folder, click a file to pull it, upload straight into
// whatever folder is open, and search without leaving it. Nexus holds no index
// and no copy: every listing, byte and search result comes from Egnyte on
// demand, and every row links back there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderPlus, HardDrive, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';
import {
  crumbsFor, downloadEgnyteFile, egnyteErrorMessage, isNotConnected, normPath,
} from './lib';
import EgnyteListing from './EgnyteList';
import EgnyteUpload from './EgnyteUpload';
import {
  BODY, CARD, ELLIPSIS, Loading, NotConnected, Notice, OpenInEgnyte, ProblemNote, Spinner,
} from './ui';

export default function EgnyteFolderBrowser({
  initialPath = '',
  canWrite = false,
  rootLabel = 'Egnyte',
  showUpload = true,
}) {
  const [path, setPath] = useState(normPath(initialPath));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConnected, setNotConnected] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [rowError, setRowError] = useState('');

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

  const load = useCallback((target) => {
    const next = normPath(target);
    setLoading(true);
    setError('');
    setNotConnected(false);
    setRowError('');
    api.egnyteFolder(next)
      .then(d => {
        setData(d);
        setPath(next);
        setFolderUrl(webUrls.current.get(next) || '');
        for (const f of d?.folders || []) if (f.webUrl) webUrls.current.set(normPath(f.path), f.webUrl);
      })
      .catch(err => {
        setData(null);
        setNotConnected(isNotConnected(err));
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
      .then(() => { setNewFolderOpen(false); setNewFolderName(''); load(path); })
      .catch(err => setRowError(egnyteErrorMessage(err, 'Could not create that folder.')))
      .finally(() => setCreating(false));
  };

  if (notConnected) return <NotConnected error="" />;

  const crumbs = crumbsFor(path);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

      {/* ── Breadcrumb + folder-level actions ── */}
      <div style={{ ...CARD, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
        <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 3, flex: '1 1 240px', minWidth: 0, overflowX: 'auto', padding: '2px 0' }}>
          <button
            type="button"
            onClick={() => openFolder('')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit', fontSize: 13, fontWeight: path ? 500 : 700, color: path ? 'var(--wk-dim)' : 'var(--wk-ink)', whiteSpace: 'nowrap' }}
          >
            <HardDrive size={14} /> {rootLabel}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
              <ChevronRight size={12} style={{ color: 'var(--wk-faint)', flexShrink: 0 }} />
              <button
                type="button"
                onClick={() => openFolder(c.path)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit', fontSize: 13, fontWeight: i === crumbs.length - 1 ? 700 : 500, color: i === crumbs.length - 1 ? 'var(--wk-ink)' : 'var(--wk-dim)', whiteSpace: 'nowrap', maxWidth: 200, ...ELLIPSIS }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <OpenInEgnyte url={folderUrl} label="Open in Egnyte" />
          <button type="button" className="secondary-btn" title="Refresh" onClick={() => load(path)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> Refresh
          </button>
          {canWrite && (
            <button type="button" className="secondary-btn" onClick={() => setNewFolderOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FolderPlus size={13} /> New Folder
            </button>
          )}
        </div>
      </div>

      {newFolderOpen && canWrite && (
        <div style={{ ...CARD, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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

      {/* ── Search, scoped to the folder on screen ── */}
      <form onSubmit={runSearch} style={{ ...CARD, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 0 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--wk-faint)', pointerEvents: 'none' }} />
          <input
            className="form-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={path ? `Search inside ${crumbs[crumbs.length - 1]?.name || 'this folder'}` : 'Search all of Egnyte'}
            style={{ width: '100%', paddingLeft: 30 }}
          />
        </div>
        <button type="submit" className="secondary-btn" disabled={searching || !query.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {searching ? <Spinner size={13} /> : <Search size={13} />} Search
        </button>
        {results && (
          <button type="button" className="secondary-btn" onClick={clearSearch} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <X size={13} /> Clear
          </button>
        )}
      </form>

      {rowError && <Notice tone="error" onDismiss={() => setRowError('')}>{rowError}</Notice>}

      {/* ── Upload into the folder currently being viewed ── */}
      {showUpload && !results && (
        <EgnyteUpload folder={path} canWrite={canWrite} onUploaded={() => load(path)} />
      )}

      {/* ── Listing or search results ── */}
      <div style={{ ...CARD, padding: 6, minWidth: 0 }}>
        {results ? (
          <>
            <div style={{ ...BODY, fontSize: 12, padding: '6px 8px 8px' }}>
              {results.length
                ? `${results.length} result${results.length === 1 ? '' : 's'} for "${searchTerm}"${path ? ' in this folder' : ''}.`
                : `No results for "${searchTerm}"${path ? ' in this folder' : ''}.`}
            </div>
            {results.map(r => (
              <div key={r.path} className="egnyte-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 4, minWidth: 0, padding: '4px 0' }}>
                <button
                  type="button"
                  onClick={() => download(r)}
                  title={`Download ${r.name}`}
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
            onDownload={download}
            downloadingPath={downloading}
            emptyLabel="This folder is empty."
            emptyHint={canWrite ? 'Drop a file above to add the first one.' : undefined}
          />
        )}
      </div>

      <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)' }}>
        Files stay in Egnyte. Nexus reads and writes them in place, so there is never a second copy to keep in sync.
      </div>
    </div>
  );
}
