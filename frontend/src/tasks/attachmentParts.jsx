// Task attachments: the Versions panel, Egnyte link rows and the Add From
// Egnyte picker (Neil, Oct 22 2026). Used by the drawer's AttachmentsTab.
// The rules live in egnyteLinks.js and on the server (routers/tasks.py):
// a version is a new file in the same group; an Egnyte link is a link, never
// a copy, and opens in Egnyte under each viewer's own Egnyte permissions.
import { useEffect, useState } from 'react';
import { ArrowLeft, Download, ExternalLink, File, Folder, HardDrive, Link2, Search, X } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { toDownloadUrl } from '../lib/storageView';
import { StatusLabel } from '../components/StatusLabel';
import { LoadingState } from '../components/AsyncState';
import { getFolderCached, formatBytes, egnyteErrorMessage } from '../egnyte/lib';
import { NX, btn, input as inputStyle } from './theme';
import { Modal, AttachmentViewer } from './components';
import { fmtDateTime } from './lib';
import { egnyteLinkProblem, egnyteLinkInfo, egnyteCrumbs, safeEgnyteHref } from './egnyteLinks';

const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const SLATE = '#64748b';

/** The soft "V3" label on a file that has versions. */
export function VersionChip({ version, title }) {
  return <StatusLabel size="sm" label={`V${version || 1}`} color={SLATE} title={title || `Version ${version || 1}`} />;
}

// ── Versions panel ───────────────────────────────────────────────────────────
// Every version of one file, newest first: number, name, size, who, when -
// each one opens or downloads. Delete All Versions takes the same right as
// removing a file, for every version: all of them yours, or an editor.
export function VersionsModal({ att, onClose, onChanged, canRemoveAny = false, myEmail = '', nameOf = (e) => e }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getTaskAttachmentVersions(att.id)
      .then((r) => { if (alive) setRows(r || []); })
      .catch((e) => { if (alive) { setRows([]); setError(e?.message || 'Could not load the versions.'); } });
    return () => { alive = false; };
  }, [att.id]);
  const me = (myEmail || '').toLowerCase();
  const canRemoveAll = !!rows?.length && (canRemoveAny || rows.every((r) => (r.addedBy || '').toLowerCase() === me && !!me));
  const removeAll = async () => {
    const ok = await dialog.confirm(`Delete "${att.name}" and all ${rows.length} of its versions from this task?`,
      { title: 'Delete All Versions', confirmText: 'Delete All Versions', danger: true });
    if (!ok) return;
    setBusy(true); setError('');
    try {
      await api.deleteTaskAttachmentVersions(att.id);
      onChanged?.();
      onClose();
    } catch (e) {
      setError(`Could not delete the versions.${e?.message ? ` ${e.message}` : ''}`);
    } finally { setBusy(false); }
  };
  const footer = (
    <>
      {canRemoveAll && (
        <button type="button" onClick={removeAll} disabled={busy}
          style={{ ...btn('outline'), color: NX.red, borderColor: NX.red, marginRight: 'auto', opacity: busy ? 0.6 : 1 }}>
          Delete All Versions
        </button>
      )}
      <button type="button" onClick={onClose} style={btn('outline')}>Close</button>
    </>
  );
  return (
    <Modal title={`Versions of ${att.name}`} onClose={onClose} footer={footer}>
      {error && <div role="alert" style={{ fontSize: 12.5, color: NX.red, marginBottom: 10 }}>{error}</div>}
      <div className="nx-fill" data-testid="versions-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows === null ? <LoadingState /> : rows.map((r, i) => {
          const href = r.dataUrl || r.url;
          return (
            <div key={r.id} data-testid="version-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: `1px solid ${NX.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 12.5 }}>
              <VersionChip version={r.version} />
              {i === 0 && <StatusLabel size="sm" label="Current" color="#16a34a" />}
              <span style={{ ...ELLIPSIS, flex: '1 1 160px', fontWeight: 600, color: NX.ink }} title={r.name}>{r.name}</span>
              <span style={{ color: NX.faint }}>{r.size}</span>
              <span style={{ color: NX.dim }}>{r.addedBy ? nameOf(r.addedBy) : ''}</span>
              <span style={{ color: NX.faint }}>{fmtDateTime(r.addedAt)}</span>
              {href ? (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  <button type="button" onClick={() => setView({ ...r, url: href })} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12 }}>View</button>
                  <a href={toDownloadUrl(href)} download={r.name} title="Download" aria-label={`Download version ${r.version}`}
                    style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12, textDecoration: 'none' }}><Download size={13} /></a>
                </span>
              ) : <span style={{ color: NX.faint }}>Not available</span>}
            </div>
          );
        })}
      </div>
      {view && <AttachmentViewer att={view} onClose={() => setView(null)} />}
    </Modal>
  );
}

// ── An Egnyte link in the Attachments list ───────────────────────────────────
export function EgnyteLinkRow({ a, onRemove }) {
  const href = safeEgnyteHref(a);
  const crumbs = egnyteCrumbs(a.egnytePath);
  const Icon = a.egnyteKind === 'folder' ? Folder : HardDrive;
  return (
    <div data-testid="egnyte-link" style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${NX.border}`, borderRadius: 10, padding: '6px 10px', fontSize: 12, maxWidth: '100%' }}>
      <Icon size={14} style={{ color: NX.blue, flexShrink: 0 }} aria-label={a.egnyteKind === 'folder' ? 'Egnyte folder' : 'Egnyte file'} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ ...ELLIPSIS, maxWidth: 200, color: NX.ink }} title={a.egnytePath || a.name}>{a.name}</span>
        {crumbs.length > 0 && (
          <span style={{ ...ELLIPSIS, maxWidth: 220, fontSize: 10.5, color: NX.faint }} title={a.egnytePath}>{crumbs.join(' › ')}</span>
        )}
      </span>
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" title="Open In Egnyte"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: NX.blue, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}>
          <ExternalLink size={12} /> Open In Egnyte
        </a>
      )}
      {onRemove && <button type="button" onClick={onRemove} title="Remove" aria-label={`Remove ${a.name}`} style={{ ...btn('ghost'), padding: 3, color: NX.faint }}><X size={13} /></button>}
    </div>
  );
}

// ── Add From Egnyte ──────────────────────────────────────────────────────────
// Browse folders or search, then Link a file or folder - as the caller's own
// Egnyte connection (the /egnyte routes). Someone who cannot browse (Egnyte
// not connected for them, or no Egnyte access in Nexus) is told so and can
// Paste Egnyte Link instead; the link still opens only for people Egnyte lets in.
function browseBlockedWhy(status, err) {
  if (!status.configured) return 'Egnyte is not connected to Nexus yet, so it cannot be browsed here.';
  if (status.oauth?.mustConnect || err?.status === 428) return 'Your Egnyte account is not connected to Nexus yet, so folders cannot be browsed here. Connect it once under Files (Connect Egnyte), or paste the Egnyte link instead.';
  if (err?.status === 403) return 'You do not have Egnyte access in Nexus, so folders cannot be browsed here. Paste the Egnyte link instead - Egnyte still decides who can open it.';
  return '';
}

// /egnyte/status answers every signed-in person (200 even when unconfigured).
function useLinkStatus() {
  const [st, setSt] = useState({ loading: true, configured: false, webHost: '', oauth: null });
  useEffect(() => {
    let alive = true;
    api.egnyteStatus()
      .then((r) => { if (alive) setSt({ loading: false, configured: !!r?.configured, webHost: r?.webHost || '', oauth: r?.oauth || null }); })
      .catch(() => { if (alive) setSt({ loading: false, configured: false, webHost: '', oauth: null }); });
    return () => { alive = false; };
  }, []);
  return st;
}

export function EgnyteLinkPicker({ taskId, onClose, onAdded }) {
  const status = useLinkStatus();
  const [tab, setTab] = useState('browse');
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [browseErr, setBrowseErr] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = !status.loading && browseBlockedWhy(status, browseErr);
  const showPaste = tab === 'paste' || !!blocked;

  useEffect(() => {
    if (status.loading || !status.configured || status.oauth?.mustConnect || tab !== 'browse') return undefined;
    let alive = true;
    getFolderCached(path)
      .then((d) => { if (alive) { setListing(d); setBrowseErr(null); } })
      .catch((e) => { if (alive) { setListing({ folders: [], files: [] }); setBrowseErr(e); } });
    return () => { alive = false; };
  }, [path, status.loading, status.configured, status.oauth?.mustConnect, tab]);

  const go = (p) => { setResults(null); setQ(''); setListing(null); setPath(p); };
  const add = async (body) => {
    setBusy(true); setError('');
    try {
      await api.addTaskEgnyteLink(taskId, body);
      onAdded?.();
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not add the link.');
    } finally { setBusy(false); }
  };
  const pick = (item, isFolder) => add({ url: item.webUrl, path: item.path, name: item.name, is_folder: isFolder });
  const search = async (e) => {
    e?.preventDefault();
    const term = q.trim();
    if (!term) { setResults(null); return; }
    setResults('loading');
    try { setResults((await api.egnyteSearch(term, path)).results || []); } catch (err) { setResults(null); setBrowseErr(err); }
  };
  const pasteProblem = pasted.trim() ? egnyteLinkProblem(pasted, status.webHost) : '';
  const submitPaste = (e) => {
    e?.preventDefault();
    const why = egnyteLinkProblem(pasted, status.webHost);
    if (why) { setError(why); return; }
    const info = egnyteLinkInfo(pasted);
    add({ url: pasted.trim(), path: info.path, name: info.name, is_folder: info.isFolder });
  };

  const row = (item, isFolder) => (
    <div key={`${isFolder ? 'd' : 'f'}:${item.path}`} data-testid="egnyte-pick-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: `1px solid ${NX.border2}`, fontSize: 13 }}>
      {isFolder ? <Folder size={15} style={{ color: NX.blue, flexShrink: 0 }} /> : <File size={15} style={{ color: NX.dim, flexShrink: 0 }} />}
      {isFolder ? (
        <button type="button" onClick={() => go(item.path)} title={`Open ${item.name}`}
          style={{ ...ELLIPSIS, flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: NX.ink, font: 'inherit' }}>{item.name}</button>
      ) : <span style={{ ...ELLIPSIS, flex: 1, color: NX.ink }} title={item.path}>{item.name}</span>}
      {!isFolder && <span style={{ color: NX.faint, fontSize: 11.5 }}>{formatBytes(item.size)}</span>}
      <button type="button" disabled={busy || !item.webUrl} onClick={() => pick(item, isFolder)}
        style={{ ...btn('outline'), padding: '4px 10px', fontSize: 12 }}>
        <Link2 size={12} /> {isFolder ? 'Link Folder' : 'Link File'}
      </button>
    </div>
  );

  const crumbs = egnyteCrumbs(path, { withLast: true });
  const tabBtn = (key, label) => (
    <button type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setError(''); }}
      style={{ ...btn(tab === key ? 'outline' : 'ghost'), padding: '5px 12px', fontSize: 12.5 }}>{label}</button>
  );

  return (
    <Modal title="Add From Egnyte" onClose={onClose} footer={<button type="button" onClick={onClose} style={btn('outline')}>Close</button>}>
      <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 10 }}>
        Adds a link to the file or folder, not a copy. It opens in Egnyte, where each person&apos;s own Egnyte access applies.
      </div>
      {!blocked && (
        <div role="tablist" className="scroll-tabs" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {tabBtn('browse', 'Browse')}
          {tabBtn('paste', 'Paste Egnyte Link')}
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 12.5, color: NX.red, marginBottom: 10 }}>{error}</div>}
      {status.loading ? <LoadingState /> : showPaste ? (
        <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {blocked && <div data-testid="egnyte-blocked" style={{ fontSize: 13, color: NX.ink, lineHeight: 1.5 }}>{blocked}</div>}
          {!status.webHost && !status.configured ? (
            <div style={{ fontSize: 12.5, color: NX.dim }}>Egnyte links can be added once an administrator connects Egnyte to Nexus.</div>
          ) : (
            <form onSubmit={submitPaste} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input aria-label="Egnyte link" value={pasted} onChange={(e) => { setPasted(e.target.value); setError(''); }}
                placeholder={`https://${status.webHost || 'your-company.egnyte.com'}/...`}
                style={{ ...inputStyle, flex: '1 1 280px', minWidth: 0, fontSize: 13 }} />
              <button type="submit" disabled={busy || !pasted.trim() || !!pasteProblem} style={{ ...btn('primary'), opacity: busy || !pasted.trim() || pasteProblem ? 0.6 : 1 }}>
                <Link2 size={13} /> Add Link
              </button>
              {pasteProblem && <div data-testid="paste-problem" style={{ flexBasis: '100%', fontSize: 12, color: NX.red }}>{pasteProblem}</div>}
              <div style={{ flexBasis: '100%', fontSize: 11.5, color: NX.faint }}>Copy the link from Egnyte (the address bar, or Copy Link) and paste it here.</div>
            </form>
          )}
        </div>
      ) : (
        <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <form onSubmit={search} style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 0 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
              <input aria-label="Search Egnyte" value={q} onChange={(e) => setQ(e.target.value)} placeholder={path ? 'Search in this folder' : 'Search Egnyte'}
                style={{ ...inputStyle, paddingLeft: 32, fontSize: 13 }} />
            </div>
            <button type="submit" style={btn('outline')}>Search</button>
          </form>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 12, color: NX.dim, marginBottom: 8 }}>
            {path && (
              <button type="button" aria-label="Up One Folder" onClick={() => go(`/${crumbs.slice(0, -1).join('/')}`.replace(/^\/$/, ''))}
                style={{ ...btn('ghost'), padding: 3 }}><ArrowLeft size={13} /></button>
            )}
            <button type="button" onClick={() => go('')} style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 12 }}>Egnyte</button>
            {crumbs.map((c, i) => (
              <span key={`${c}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: NX.faint }}>›</span>
                <button type="button" onClick={() => go(`/${crumbs.slice(0, i + 1).join('/')}`)}
                  style={{ ...btn('ghost'), padding: '2px 6px', fontSize: 12 }}>{c}</button>
              </span>
            ))}
          </div>
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, overflowY: 'auto', flex: 1, minHeight: 200 }}>
            {results === 'loading' || (results === null && listing === null) ? <LoadingState />
              : results !== null ? (
                results.length ? results.map((r) => row(r, !!r.isFolder))
                  : <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: NX.faint }}>Nothing in Egnyte matches that.</div>
              ) : browseErr ? (
                <div role="alert" style={{ padding: 20, fontSize: 13, color: NX.red }}>{egnyteErrorMessage(browseErr)}</div>
              ) : (listing.folders.length + listing.files.length) === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: NX.faint }}>This folder is empty.</div>
              ) : (
                <>
                  {listing.folders.map((d) => row(d, true))}
                  {listing.files.map((f) => row(f, false))}
                </>
              )}
          </div>
        </div>
      )}
    </Modal>
  );
}
