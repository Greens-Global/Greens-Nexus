// Egnyte module - the folder tree (left pane of the browser).
//
// Lazy on purpose: Egnyte trees are huge and Nexus keeps no index, so a node's
// children are fetched the first time it expands and remembered for the rest of
// the mount. Selecting a node hands the path to the browser; expanding it never
// navigates, so the two gestures stay independent exactly like every desktop
// file manager users already know.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, HardDrive } from 'lucide-react';
import { crumbsFor, getFolderCached, invalidateFolder, normPath, prefetchChildren, prefetchFolder } from './lib';
import { ELLIPSIS, Spinner } from './ui';

const FOLDER_FILL = '#fdb64c';
const FOLDER_EDGE = '#ec9d29';

function TreeRow({ depth, active, hasChildren, expanded, loading, label, icon, onToggle, onSelect, onHover, title }) {
  return (
    <div className={`egx-tree-row${active ? ' is-active' : ''}`} style={{ paddingLeft: depth * 14 }} onMouseEnter={onHover}>
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          onClick={onToggle}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, display: 'inline-flex', alignItems: 'center', color: 'var(--wk-faint)', flexShrink: 0 }}
        >
          {loading
            ? <Spinner size={12} />
            : <ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />}
        </button>
      ) : (
        <span style={{ width: 19, flexShrink: 0 }} />
      )}
      <button
        type="button"
        className="egx-tree-label"
        onClick={onSelect}
        title={title || label}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7,
          background: 'none', border: 'none', cursor: 'pointer', padding: '5px 6px 5px 0',
          fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 700 : 500,
          color: active ? 'var(--wk-brand)' : 'var(--wk-ink)', textAlign: 'left',
        }}
      >
        {icon}
        <span style={ELLIPSIS}>{label}</span>
      </button>
    </div>
  );
}

export default function EgnyteTree({ currentPath = '', onSelect, refreshSignal, rootLabel = 'All files' }) {
  // path -> array of {name, path, webUrl} once loaded; 'error' when the fetch
  // failed (rendered as a quiet retry row, never as a blank hole).
  const [children, setChildren] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [loadingPaths, setLoadingPaths] = useState(() => new Set());
  const inFlight = useRef(new Set());

  const loadChildren = useCallback((path) => {
    const key = normPath(path);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setLoadingPaths(prev => new Set(prev).add(key));
    getFolderCached(key)
      .then(d => {
        setChildren(prev => new Map(prev).set(key, (d?.folders || []).map(f => ({
          name: f.name, path: normPath(f.path), webUrl: f.webUrl || '',
        }))));
        // Expanding a node warms its children, so the next expand or open is
        // instant - the "no delay" feel is this line.
        prefetchChildren(d, 16);
      })
      .catch(() => {
        setChildren(prev => new Map(prev).set(key, 'error'));
      })
      .finally(() => {
        inFlight.current.delete(key);
        setLoadingPaths(prev => { const n = new Set(prev); n.delete(key); return n; });
      });
  }, []);

  useEffect(() => { loadChildren(''); }, [loadChildren]);

  // Keep the tree honest about where the browser is: when the path changes
  // (breadcrumb jump, row descent, deep link), expand and load the ancestor
  // chain so the current folder is visible in the tree, without ever collapsing
  // anything the user opened themselves.
  useEffect(() => {
    const target = normPath(currentPath);
    if (!target) return;
    const chain = ['', ...crumbsFor(target).slice(0, -1).map(c => c.path)];
    setExpanded(prev => {
      if (chain.every(p => prev.has(p))) return prev;
      const n = new Set(prev);
      chain.forEach(p => n.add(p));
      return n;
    });
    chain.forEach(p => { if (!children.has(p)) loadChildren(p); });
  }, [currentPath, children, loadChildren]);

  // The browser bumps this after a folder is created so the affected node
  // refetches instead of showing a stale list.
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!refreshSignal?.seq || refreshSignal.seq === lastSeq.current) return;
    lastSeq.current = refreshSignal.seq;
    const key = normPath(refreshSignal.path);
    invalidateFolder(key);
    if (children.has(key)) loadChildren(key);
  }, [refreshSignal, children, loadChildren]);

  const toggle = (path) => {
    const key = normPath(path);
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else {
        n.add(key);
        if (!children.has(key)) loadChildren(key);
      }
      return n;
    });
  };

  const renderLevel = (path, depth) => {
    const kids = children.get(path);
    if (kids === 'error') {
      return (
        <button
          type="button"
          key={`err:${path}`}
          onClick={() => loadChildren(path)}
          style={{ marginLeft: depth * 14 + 19, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', fontFamily: 'inherit', fontSize: 12, color: 'var(--wk-faint)', textAlign: 'left' }}
        >
          Could not load - retry
        </button>
      );
    }
    if (!kids) return null;
    if (!kids.length && depth > 0) return null;
    return kids.map(node => {
      const open = expanded.has(node.path);
      const loaded = children.get(node.path);
      // Until a node loads we cannot know if it has children, so it keeps its
      // chevron; once loaded empty, the chevron gives way to plain indent.
      const expandable = !(Array.isArray(loaded) && loaded.length === 0);
      return (
        <div key={node.path}>
          <TreeRow
            depth={depth}
            active={normPath(currentPath) === node.path}
            hasChildren={expandable}
            expanded={open}
            loading={loadingPaths.has(node.path)}
            label={node.name}
            title={node.path}
            icon={<Folder size={15} fill={FOLDER_FILL} style={{ color: FOLDER_EDGE, flexShrink: 0 }} />}
            onToggle={() => toggle(node.path)}
            onSelect={() => onSelect?.(node.path, node.webUrl)}
            onHover={() => prefetchFolder(node.path)}
          />
          {open && renderLevel(node.path, depth + 1)}
        </div>
      );
    });
  };

  const rootLoading = loadingPaths.has('') && !children.has('');

  return (
    <nav aria-label="Egnyte folders" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <TreeRow
        depth={0}
        active={!normPath(currentPath)}
        hasChildren={false}
        expanded
        loading={false}
        label={rootLabel}
        icon={<HardDrive size={15} style={{ color: 'var(--wk-dim)', flexShrink: 0 }} />}
        onSelect={() => onSelect?.('', '')}
      />
      {rootLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px 8px 19px', color: 'var(--wk-faint)', fontSize: 12 }}>
          <Spinner size={13} /> Loading folders…
        </div>
      )}
      {renderLevel('', 0)}
    </nav>
  );
}
