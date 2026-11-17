// What the portfolio's header tabs need to know (Neil, 11/17/2026): the plain number after
// Maintenance (open tickets) and Dates (dates passed), and whether Fleet, Development and
// Maintenance show at all. Also the ONE loader of GET /maintenance/portfolio, shared by the
// tab signal, the Maintenance tab and the Overview, so the header and the page never disagree
// and the endpoint is read once per minute at most.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { inferAssetKind } from './vehicleFields.js';
import { collectDates, bucketOf } from './datesModel.js';

// ── The development pipeline, in order ──────────────────────────────────────
export const PIPELINE = [
  { key: 'in escrow', label: 'In Escrow', tone: 'live' },
  { key: 'entitlement', label: 'Entitlement', tone: 'blue' },
  { key: 'construction drawings', label: 'Construction Drawings', tone: 'live' },
  { key: 'construction', label: 'Under Construction', tone: 'live' },
  { key: 'stabilized - renovation', label: 'Renovation', tone: 'live' },
];

/** "Stabilized – Renovation" -> "stabilized - renovation" (any dash, any spacing, any case). */
export function stageKey(stage) {
  return String(stage || '').toLowerCase().replace(/\s*[-–—]+\s*/g, ' - ').replace(/\s+/g, ' ').trim();
}

/** The pipeline step an asset is on, or null when it is not in development. */
export function pipelineStepOf(asset) {
  if (!asset || inferAssetKind(asset) !== 'property') return null;
  const k = stageKey(asset.devStage);
  return PIPELINE.find((s) => s.key === k) || null;
}

export const isFleet = (a) => inferAssetKind(a) !== 'property';

// ── GET /maintenance/portfolio, read once and shared ─────────────────────────
const FRESH_MS = 60 * 1000;
let shared = { at: 0, promise: null };

/** The portfolio's tickets per property (cached a minute; `force` reads again). Rejects with
 *  the request's error (err.status 403 = not for this person). */
export function loadMaintenancePortfolio({ force = false } = {}) {
  if (!force && shared.promise && Date.now() - shared.at < FRESH_MS) return shared.promise;
  const promise = Promise.resolve()
    .then(() => {
      if (typeof api.getMaintenancePortfolio !== 'function') throw Object.assign(new Error('unavailable'), { status: 0 });
      return api.getMaintenancePortfolio();
    });
  shared = { at: Date.now(), promise };
  promise.catch(() => { if (shared.promise === promise) shared = { at: 0, promise: null }; });
  return promise;
}

/** For tests: forget the shared answer. */
export function resetMaintenancePortfolio() { shared = { at: 0, promise: null }; }

/** { data, status: 'loading' | 'ok' | 'denied' | 'error', reload } */
export function useMaintenancePortfolio() {
  const [state, setState] = useState({ data: null, status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loadMaintenancePortfolio({ force: tick > 0 })
      .then((data) => { if (alive) setState({ data: data || { properties: [], totals: {} }, status: 'ok' }); })
      .catch((err) => { if (alive) setState({ data: null, status: err && err.status === 403 ? 'denied' : 'error' }); });
    return () => { alive = false; };
  }, [tick]);
  const reload = useCallback(() => { setState((s) => ({ ...s, status: 'loading' })); setTick((t) => t + 1); }, []);
  return { ...state, reload };
}

/**
 * The header tabs' signals.
 *   maintenanceOpen    open tickets across the portfolio; null while loading or when the read
 *                      failed (never a false 0)
 *   maintenanceAllowed whether the Maintenance tab shows: false on a 403 and until the answer
 *                      arrives (so it never shows to someone it is not for); a failed read
 *                      other than 403 keeps it (the tab says it could not load)
 *   maintenanceKnown   the answer has arrived (either way)
 *   datesPassed        dates passed without being marked done (suspect dates never count)
 *   hasFleet           any vehicle or piece of equipment among `assets`
 *   hasPipeline        any property in development
 */
export function useTabSignals({ store, assets }) {
  const m = useMaintenancePortfolio();
  const list = useMemo(() => (assets || []).filter((a) => a && !a.deleted), [assets]);
  const datesPassed = useMemo(() => {
    try { return collectDates(store || {}, list).filter((x) => bucketOf(x) === 'passed').length; } catch { return 0; }
  }, [store, list]);
  return {
    maintenanceOpen: m.status === 'ok' ? Number((m.data.totals || {}).open) || 0 : null,
    maintenanceAllowed: m.status === 'ok' || m.status === 'error',
    maintenanceKnown: m.status !== 'loading',
    datesPassed,
    hasFleet: list.some(isFleet),
    hasPipeline: list.some((a) => !!pipelineStepOf(a)),
  };
}
