// Live admin overrides for ticket taxonomy (Sep 2026) - SLA target hours and
// per-type intake fields used to be hardcoded constants in ticketMeta.js that
// an engineer had to edit and redeploy to change (see the Admin module audit,
// Pranshu Sep 9: "Ticket SLA targets per priority" / "Ticket types & intake
// questions", Tier 2 - no UI, backend config work needed first).
//
// ticketMeta.js stays "no JSX and no component imports" (its own header
// comment) - this file is the one that fetches the saved override and
// applies it. SLA_TARGET_HOURS / TICKET_TYPE_META / TYPE_FIELDS /
// TICKET_TYPE_ORDER are mutated IN PLACE (never reassigned), so every file
// that already imports them by reference sees the override automatically -
// no call site elsewhere in the ticket module needs to change. A type's icon
// and color are NOT overridable (they're compiled-in React components /
// tokens, not JSON) - only label, hint, intake-order membership, and the
// field list are.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { SLA_TARGET_HOURS, TICKET_TYPE_META, TICKET_TYPE_ORDER, TYPE_FIELDS } from './ticketMeta';

const EVENT = 'nexus:ticket-taxonomy-config';
let _loaded = false;
let _loading = null;

function applyConfig(cfg) {
  if (cfg?.slaTargetHours) Object.assign(SLA_TARGET_HOURS, cfg.slaTargetHours);
  if (cfg?.types) {
    for (const [key, override] of Object.entries(cfg.types)) {
      if (!TICKET_TYPE_META[key]) continue;   // unknown key - a type an admin retired/renamed the key of, ignore
      if (typeof override.label === 'string' && override.label.trim()) TICKET_TYPE_META[key].label = override.label.trim();
      if (typeof override.hint === 'string') TICKET_TYPE_META[key].hint = override.hint;
      if (Array.isArray(override.fields)) TYPE_FIELDS[key] = override.fields;
    }
  }
  if (Array.isArray(cfg?.typeOrder)) {
    TICKET_TYPE_ORDER.length = 0;
    TICKET_TYPE_ORDER.push(...cfg.typeOrder.filter((k) => TICKET_TYPE_META[k]));
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Fetches the saved override once per session and applies it - safe to call
 * from multiple mount points, only the first call actually fetches. */
export function loadTicketConfig() {
  if (_loaded) return Promise.resolve();
  if (_loading) return _loading;
  _loading = api.getTicketTaxonomySettings().then(applyConfig).catch(() => {}).finally(() => { _loaded = true; _loading = null; });
  return _loading;
}

/** Re-fetches and re-applies - call after an Admin save so every already-open
 * ticket screen picks up the change without a page reload. */
export function refreshTicketConfig() {
  _loaded = false;
  return loadTicketConfig();
}

/** Mount-time hook for any component that reads SLA_TARGET_HOURS /
 * TICKET_TYPE_META / TYPE_FIELDS / TICKET_TYPE_ORDER - triggers the load (a
 * no-op if already loaded) and re-renders once it lands, since the objects
 * are mutated in place rather than replaced. */
export function useTicketConfig() {
  const [, force] = useState(0);
  useEffect(() => {
    if (!_loaded) loadTicketConfig();
    const on = () => force((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
