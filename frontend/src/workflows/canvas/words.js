// The sentence a block speaks (10/30/2026): the recipe's own words from
// lib/text.js, so the canvas and the recipe never describe a step
// differently. Kept out of CanvasNode.jsx so that file exports only a
// component (fast refresh).
import { describeCondition, describeStep, describeTrigger } from '../lib/text';

export function gateWords(conditions, entityDef) {
  const groups = Array.isArray(conditions) ? conditions : [];
  const lines = groups.map((g) => (Array.isArray(g) ? g : []).filter((r) => r && r.field && r.op).map((r) => describeCondition(r, entityDef)).join(' and ')).filter(Boolean);
  if (!lines.length) return 'Only if (not set yet)';
  return `Only if ${lines.join(', or ')}`;
}

export function nodeWords(node, catalog, entityDef) {
  if (node.kind === 'trigger') return describeTrigger(node.trigger, catalog);
  if (node.kind === 'gate') return gateWords(node.conditions, entityDef);
  if (node.kind === 'fault') return node.label;
  if (node.step) return describeStep(node.step, catalog) || 'New step';
  return '';
}

