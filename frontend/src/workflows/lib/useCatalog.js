// The catalog GET /workflows/catalog returns (entities, events, actions, list
// sources, operators, filters, what is new since the person last looked),
// fetched once per session and shared by every Workflows screen (Oct 28
// 2026). The module renders only what the catalog says exists - never a
// hard-coded event or action.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { findAction, findEntity, findEvent, findListSource } from './text';

let cache = null;      // the catalog once it arrived
let inflight = null;   // the request on its way, shared by every mount
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn());

function fetchCatalog(force = false) {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.wfCatalog()
      .then((c) => { cache = c || {}; return cache; })
      .finally(() => { inflight = null; notify(); });
  }
  return inflight;
}

/** Drop the cached catalog (tests; after Settings changes the packs). */
export function invalidateCatalog() { cache = null; }

export function useCatalog() {
  const [, bump] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const load = useCallback((force = false) => {
    setLoading(!cache || force);
    setError(false);
    return fetchCatalog(force)
      .then(() => setError(false))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (!cache) load(); }, [load]);

  const catalog = cache;
  const newSince = new Set(Array.isArray(catalog?.newSince) ? catalog.newSince : []);
  return {
    catalog,
    loading: loading && !catalog,
    error: error && !catalog,
    reload: () => load(true),
    entity: (key) => findEntity(catalog, key),
    event: (key) => findEvent(catalog, key),
    action: (key) => findAction(catalog, key),
    listSource: (key) => findListSource(catalog, key),
    isNew: (key) => newSince.has(key),
  };
}
