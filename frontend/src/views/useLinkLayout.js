import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';

const EMPTY_LAYOUT = { folders: [], items: [], favorites: [] };

// One choke point for every Links Module personalization change - reorder an
// app, reorder a folder, add/remove from a folder, create/rename/delete a
// folder, toggle a favorite, toggle the "add to dashboard" flag. Every one of
// those is a thin wrapper around mutate(updaterFn) in ExternalLinks.jsx.
// Auto-saves 600ms after the last change (debounced, not on every keystroke
// of a drag) with optimistic apply + rollback-on-failure to the last version
// the server actually confirmed - mirrors useDashboards.js's layoutRef
// pattern (frontend/src/dashboard/useDashboards.js) for reading the current
// value inside a callback without a stale closure, but auto-saves instead of
// requiring an explicit Save click, since that's what this task needs.
export function useLinkLayout() {
  const [layout, setLayout] = useState(EMPTY_LAYOUT);
  const [isCustomized, setIsCustomized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState(null);

  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  // The last document the server actually confirmed persisted - a failed
  // save rolls back to THIS, not to whatever `layout` has drifted to if more
  // mutations queued while the failed request was in flight.
  const lastSavedRef = useRef(layout);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    api.getLinkLayout().then(res => {
      const { is_customized, ...doc } = res || {};
      setLayout(doc.items ? doc : EMPTY_LAYOUT);
      setIsCustomized(!!is_customized);
      lastSavedRef.current = doc;
    }).catch(() => {
      // Best-effort, same posture as vaultCreds/companies elsewhere in this
      // module - an uncustomized/default view is a safe fallback, not an
      // error state worth surfacing.
    }).finally(() => setLoading(false));
    return () => clearTimeout(saveTimerRef.current);
  }, []);

  const flushSave = useCallback((doc) => {
    api.saveLinkLayout(doc).then(res => {
      lastSavedRef.current = { folders: res?.folders || [], items: res?.items || [], favorites: res?.favorites || [] };
      setSaveError(null);
    }).catch(e => {
      setLayout(lastSavedRef.current);
      setSaveError(e?.message || 'Could not save your layout changes - reverted.');
    });
  }, []);

  const mutate = useCallback((updater) => {
    const next = updater(layoutRef.current);
    setLayout(next);
    setIsCustomized(true);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => flushSave(next), 600);
  }, [flushSave]);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  // Restore Default Layout (Aug 14) - cancels any pending debounced save
  // first (a queued mutation landing right after a reset would silently
  // re-customize the layout the user just asked to clear), then deletes the
  // saved row (or, with a scope, just that item_type's slice of it - Aug 14,
  // "add folders to personal links too": resetting Company Links shouldn't
  // also wipe out a Personal Links arrangement sitting in the same document)
  // server-side so the next load falls back to the synthesized default for
  // that type. Returns the promise so the caller can show its own
  // confirmation/loading state around the click.
  const resetToDefault = useCallback((scope) => {
    clearTimeout(saveTimerRef.current);
    return api.resetLinkLayout(scope).then(res => {
      const { is_customized, ...doc } = res || {};
      const next = doc.items ? doc : EMPTY_LAYOUT;
      setLayout(next);
      setIsCustomized(!!is_customized);
      lastSavedRef.current = next;
      setSaveError(null);
    }).catch(e => {
      setSaveError(e?.message || 'Could not restore the default layout.');
      throw e;
    });
  }, []);

  return { layout, isCustomized, loading, saveError, clearSaveError, mutate, resetToDefault };
}
