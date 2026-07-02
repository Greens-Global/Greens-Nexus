// Development-stage taxonomy. Properties can have a compound stage like
// "Stabilized — Renovation" (base stage + sub-status); baseStage() strips that suffix so
// stage-gated logic (e.g. hiding dev-only fields once Stabilized) only needs to match the base.

export const STAGE_FORM = [
  'In Escrow',
  'Entitlement',
  'Construction Drawings',
  'Construction',
  'Lease-Up',
  'Stabilized',
  'Stabilized — Renovation',
  'Stabilized — Expansion',
  'Stabilized — Capital Improvement',
  'Stabilized — Repositioning',
  'Stabilized — Re-Tenanting',
  'On Hold',
];

/** "Stabilized — Renovation" -> "Stabilized". Accepts an em dash, en dash, or hyphen separator. */
export function baseStage(stage) {
  return String(stage || '').split(/\s+[—–-]+\s+/)[0].trim();
}

// NOTE: the stage -> tone-color mapper (devStage -> 'red'/'green'/'gold'/etc, for the stage
// chip's dot/background color) lives in assetMetrics.js as stageColor(), not here — it's
// re-exported as `stageTone` from lib/portfolioCards.js for Portfolio-page call sites. Kept out
// of this file to avoid a circular import (assetMetrics.js already imports baseStage FROM here).

/** Stage filter dropdown options (base stages only — no "Stabilized — X" sub-status variants). */
export const STAGE_FILTER_OPTIONS = ['In Escrow', 'Entitlement', 'Construction Drawings', 'Construction', 'Lease-Up', 'Stabilized', 'On Hold'];
