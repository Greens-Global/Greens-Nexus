// Colors, labels and icons the canvas draws a block with (Blueprint,
// 10/30/2026). A branching step is colored by its kind, an action or the
// trigger by the module it belongs to - the same module key the catalog
// carries - so a glance says "that is Tasks, that is HR".
import { AlertTriangle, Filter, Radio } from 'lucide-react';
import { findAction, findEntity, findEvent } from '../lib/definition';
import { STEP_ICONS } from '../lib/text.builder-helpers';

export const MODULE_COLOR = {
  core: '#64748b', hr: 'hsl(271,60%,48%)', tasks: 'hsl(215,75%,45%)', tickets: 'hsl(30,80%,48%)',
  time: 'hsl(142,60%,35%)', shifts: 'hsl(174,60%,36%)', items: 'hsl(42,80%,42%)', approvals: 'hsl(236,60%,52%)',
  performance: 'hsl(330,60%,45%)',
};
export const KIND_COLOR = {
  if: 'hsl(271,60%,48%)', approval: 'hsl(236,60%,52%)', wait: 'hsl(30,80%,48%)', for_each: 'hsl(174,60%,36%)',
  stop: '#64748b', gate: '#475569', fault: '#dc2626',
};
export const KIND_LABEL = {
  trigger: 'Trigger', gate: 'Only If', action: 'Action', if: 'If / Else', approval: 'Ask For Approval',
  wait: 'Wait', for_each: 'For Each', stop: 'Stop', fault: 'If A Step Fails',
};
export const CANVAS_ICONS = { ...STEP_ICONS, trigger: Radio, gate: Filter, fault: AlertTriangle };

export const moduleColor = (key) => MODULE_COLOR[key] || MODULE_COLOR.core;

/** The module an action step or the trigger belongs to ('' when unknown). */
export function nodeModule(node, catalog) {
  if (!node) return '';
  if (node.kind === 'trigger') {
    const t = node.trigger || {};
    if (t.kind === 'event') return findEvent(catalog, t.event)?.module || '';
    return findEntity(catalog, t.entity)?.module || '';
  }
  if (node.kind === 'action') return findAction(catalog, node.step?.action)?.module || '';
  return '';
}

export function nodeColor(node, catalog) {
  if (!node) return MODULE_COLOR.core;
  if (KIND_COLOR[node.kind]) return KIND_COLOR[node.kind];
  return moduleColor(nodeModule(node, catalog));
}
