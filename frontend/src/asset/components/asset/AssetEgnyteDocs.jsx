import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, Link2, Lock, RefreshCw, Search } from 'lucide-react';
import { api } from '../../../api.js';
import EgnyteListing from '../../../egnyte/EgnyteList.jsx';
import EgnytePreview from '../../../egnyte/EgnytePreview.jsx';
import { OpenInEgnyte } from '../../../egnyte/ui.jsx';
import { SkeletonBlocks } from '../../../components/AsyncState.jsx';
import { Card } from '../shared/Card.jsx';
import { EmptyState } from '../shared/EmptyState.jsx';
import FolderPickModal from '../../../egnyte/EgnyteFolderPick';
import { egnyteFolderOf, normalizeEgnyteFolder } from '../../lib/egnyteFolder.js';

const note = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', fontSize: 13 };
// The row save reaches the server a moment after Connect; ask again this many times.
const SAVE_WAIT_TRIES = 4;
const SAVE_WAIT_MS = 1500;

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);   // revoking at once cancels Safari's download
}

/**
 * Plans & Docs from the asset's CONNECTED Egnyte folder (Neil, 11/05/2026:
 * "nobody is lost in Egnyte to see the docs"). Anyone who may see the asset -
 * viewers included - browses and opens the folder's files right here, read
 * only, through the asset-scoped routes (routers/property_assets: the server
 * reads with its own Egnyte connection and refuses any path outside the
 * folder). Connecting is one time: an editor connects an asset that has no
 * folder; once connected only an Asset Management Owner changes it (the
 * server says so in `mayChange` and refuses anyone else on the row save).
 */
export function AssetEgnyteDocs({ asset, canConnect, onConnect, hideUnconnected = false }) {
  const pinned = egnyteFolderOf(asset);
  const [state, setState] = useState({ loading: true });
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null);
  const [downloading, setDownloading] = useState('');
  const [connecting, setConnecting] = useState(false);
  const ask = useRef(0);

  const load = useCallback((at = '', tries = 0) => {
    const mine = ++ask.current;
    setState((s) => ({ ...s, loading: true }));
    api.assetEgnyteFolder(asset.id, at)
      .then((r) => {
        if (mine !== ask.current) return;
        // Just connected here: the row save may not have reached the server yet.
        if (r && !r.connected && pinned && tries < SAVE_WAIT_TRIES) {
          setTimeout(() => { if (mine === ask.current) load(at, tries + 1); }, SAVE_WAIT_MS);
          return;
        }
        setState({ loading: false, ...r });
      })
      .catch((e) => { if (mine === ask.current) setState({ loading: false, error: (e && e.message) || 'Could not open this folder.' }); });
  }, [asset.id, pinned]);

  // A new asset or a new pin starts at the folder's top.
  useEffect(() => { setPath(''); setQuery(''); load(''); }, [load]);

  const open = (p) => { setPath(p); setQuery(''); load(p); };
  const fetchPreview = async (p) => (await api.assetEgnyteFile(asset.id, p, true)).blob;
  const downloadFile = async (p, name) => saveBlob((await api.assetEgnyteFile(asset.id, p)).blob, name);
  const download = async (f) => {
    setDownloading(f.path);
    try { await downloadFile(f.path, f.name); }
    catch (e) { setState((s) => ({ ...s, rowError: (e && e.message) || 'Could not download that file.' })); }
    finally { setDownloading(''); }
  };

  const folder = state.folder || pinned;
  const mayChange = !!state.mayChange;
  // Breadcrumb from the connected folder down - never above it.
  const rel = path && folder && path.toLowerCase().startsWith(folder.toLowerCase() + '/') ? path.slice(folder.length + 1).split('/') : [];
  const crumbs = rel.map((name, i) => ({ name, path: `${folder}/${rel.slice(0, i + 1).join('/')}` }));
  const q = query.trim().toLowerCase();
  const match = (x) => !q || String(x.name || '').toLowerCase().includes(q);
  const files = (state.files || []).filter(match);
  const folders = (state.folders || []).filter(match);

  let body;
  if (state.loading && !state.folders) body = <SkeletonBlocks count={3} height={36} borderRadius={8} />;
  else if (state.error && !state.connected) body = <div style={note}>{state.error}</div>;
  else if (!state.connected) {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
        <div style={note}>
          {canConnect
            ? 'Connect this asset to its Egnyte folder and everyone who can open the asset sees its plans and documents here - no need to look for them in Egnyte. You connect it once; after that only an Asset Management Owner can change it.'
            : 'This asset is not connected to an Egnyte folder yet. Someone who edits this asset can connect it.'}
        </div>
        {canConnect && (
          <button type="button" className="primary-btn" style={btn} onClick={() => setConnecting(true)}>
            <Link2 size={14} /> Connect Egnyte Folder
          </button>
        )}
      </div>
    );
  } else if (state.configured === false) body = <div style={note}>Egnyte is not connected on this server - the files cannot be listed right now.</div>;
  else if (state.missing) body = <div style={note}>The connected folder is no longer in Egnyte ({folder}). {mayChange ? 'Change it to the folder where the files live now.' : 'Ask an Asset Management Owner to connect the folder where the files live now.'}</div>;
  else if (state.error) body = <div style={note}>{state.error} <button type="button" className="secondary-btn" style={{ ...btn, padding: '3px 10px', marginLeft: 6 }} onClick={() => load(path)}>Try Again</button></div>;
  else {
    body = (
      <>
        {state.rowError && <div role="alert" style={{ ...note, color: 'var(--danger, #e2445c)', marginBottom: 8 }}>{state.rowError}</div>}
        <EgnyteListing folders={folders} files={files} onOpenFolder={open} onPreview={setPreview} onDownload={download}
          downloadingPath={downloading} emptyLabel={q ? 'Nothing here matches that search.' : 'This folder is empty.'} />
      </>
    );
  }

  // Not connected and nothing indexed: the Connect button sits in the Plans &
  // Documents table instead (ConnectEgnyteEmpty), never twice on the page.
  if (hideUnconnected && !pinned) return null;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <FolderOpen size={18} aria-hidden="true" style={{ color: '#ec9d29', flexShrink: 0 }} />
        <strong style={{ fontSize: 15 }}>Documents in Egnyte</strong>
        {state.connected && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, color: 'var(--text-muted)' }} />
              <input className="form-input" type="search" aria-label="Search this folder" placeholder="Search this folder..."
                value={query} onChange={(e) => setQuery(e.target.value)} style={{ padding: '6px 10px 6px 28px', fontSize: 13, width: 200 }} />
            </label>
            <button type="button" className="secondary-btn" style={btn} onClick={() => load(path)} title="Refresh" aria-label="Refresh">
              <RefreshCw size={14} className={state.loading ? 'spin' : undefined} />
            </button>
            {state.webUrl && <OpenInEgnyte url={state.webUrl} label="Open in Egnyte" />}
            {mayChange && (
              <button type="button" className="secondary-btn" style={btn} onClick={() => setConnecting(true)}>
                <Link2 size={14} /> Change Folder
              </button>
            )}
          </div>
        )}
      </div>

      {state.connected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 13 }}>
          <button type="button" onClick={() => open('')} title={folder}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600, color: rel.length ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
            {folder.split('/').pop() || 'Egnyte Folder'}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ChevronRight size={12} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
              {i === crumbs.length - 1
                ? <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span>
                : <button type="button" onClick={() => open(c.path)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--text-secondary)' }}>{c.name}</button>}
            </span>
          ))}
          {!mayChange && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, ...note, fontSize: 12 }}>
              <Lock size={12} aria-hidden="true" /> Connected - only an Asset Management Owner can change it
            </span>
          )}
        </div>
      )}

      {body}

      {preview && (
        <EgnytePreview file={preview} onClose={() => setPreview(null)} fetchPreview={fetchPreview} downloadFile={downloadFile} />
      )}
      {connecting && (
        <ConnectFolder asset={asset} current={pinned} onClose={() => setConnecting(false)}
          onConnect={(p) => { setConnecting(false); onConnect(p); }} />
      )}
    </Card>
  );
}

/** Connect (or, for an Owner, change) the asset's Egnyte folder by BROWSING
 *  Egnyte - the Files module's own picker, folder tree and paste box included
 *  (Pranshu, 11/07/2026: "browse the folder as we have in Files"). It browses
 *  as the person's own Egnyte account, so they see only what Egnyte lets them.
 *  Saves through the asset's ordinary row save, so the Activity Log records it
 *  and the server checks the folder is inside the property roots. */
export function ConnectFolder({ asset, current, onClose, onConnect }) {
  const pick = (path) => {
    const next = normalizeEgnyteFolder(path);
    if (!next) return;              // "All Files" itself is not a folder to connect
    if (next === current) onClose();
    else onConnect(next);
  };
  return (
    <FolderPickModal showTree startPath={current || ''}
      title={current ? 'Change Egnyte Folder' : 'Connect Egnyte Folder'}
      hint={`Browse to the folder that holds ${asset.name}'s plans and documents (or paste its path or Egnyte link), then press "Use This Folder". Once connected, only an Asset Management Owner can change it.`}
      onPick={pick} onClose={onClose} />
  );
}

/** The Plans & Documents table's empty state on an asset with no Egnyte
 *  folder: Connect Egnyte Folder in place of "No documents indexed". */
export function ConnectEgnyteEmpty({ asset, canConnect, onConnect }) {
  const [connecting, setConnecting] = useState(false);
  return (
    <>
      <EmptyState
        action={canConnect ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Link2 size={14} aria-hidden="true" /> Connect Egnyte Folder</span> : undefined}
        onAction={() => setConnecting(true)}>
        {canConnect
          ? 'Connect this asset to its Egnyte folder and everyone who can open the asset sees its plans and documents here. You connect it once; after that only an Asset Management Owner can change it.'
          : 'This asset is not connected to an Egnyte folder yet. Someone who edits this asset can connect it.'}
      </EmptyState>
      {connecting && (
        <ConnectFolder asset={asset} current="" onClose={() => setConnecting(false)}
          onConnect={(p) => { setConnecting(false); onConnect(p); }} />
      )}
    </>
  );
}
