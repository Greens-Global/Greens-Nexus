// TEMPORARY stub - Task 12 (the module shell) owns the real file; take
// theirs at integration. Kept functional so this branch builds and its
// tests run: one fetch of GET /workflows/catalog per session, shared by
// every screen, with the lookups the Templates and Catalog screens use.
import { useEffect, useState } from 'react';
import { api } from '../../api';

let cached = null;
let pending = null;

function loadOnce() {
  if (cached) return Promise.resolve(cached);
  pending ||= api.wfCatalog().then((c) => { cached = c; pending = null; return c; }, (e) => { pending = null; throw e; });
  return pending;
}

export function useCatalog() {
  const [catalog, setCatalog] = useState(cached);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    loadOnce().then((c) => { if (live) setCatalog(c); }, (e) => { if (live) setError(e); });
    return () => { live = false; };
  }, []);
  const find = (list, key) => (catalog?.[list] || []).find((x) => x.key === key) || null;
  return {
    catalog,
    loading: !catalog && !error,
    error,
    entity: (key) => find('entities', key),
    event: (key) => find('events', key),
    action: (key) => find('actions', key),
    isNew: (key) => (catalog?.newSince || []).includes(key),
  };
}
