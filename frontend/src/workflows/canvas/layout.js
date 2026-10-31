// The canvas layout engine (Blueprint, Neil, 10/30/2026). Pure: the
// definition's lane tree in, nodes / edges / frames / insert points in
// world pixels out. Nothing is stored for the canvas - a workflow has ONE
// shape, computed from its steps every time, so two people build the same
// workflow the same way and nothing can turn into spaghetti. Never add
// stored node coordinates.
//
// Rules (the approved mockup https://claude.ai/artifact/DNVzU9aSAK3bcJEHHgDB8m):
//   trigger at the top, then the Only If gate when there are conditions,
//   then the root lane. If / Else fans Then left and Otherwise right; an
//   approval has one lane per answer (lanesOf: the options, then If Nobody
//   Answers); lanes rejoin at a dot when any of them is still open; For
//   Each draws its lane inside a dashed LOOP frame and exits at the frame's
//   bottom; Stop closes a lane; an empty lane shows a ghost drop slot. Every
//   connector carries one insert point (`hots`) that says where a dropped
//   step lands - a LanePath from lib/definition.js and an index - so the
//   canvas can never put a step somewhere the engine would not run it.
//   The fault lane (settings.faultSteps) sits to the right under a dashed
//   header. Coordinates are shifted so the sheet starts at (MARGIN, MARGIN).
import { getLane, lanesOf } from '../lib/definition';

export const NODE_W = 264;
export const NODE_H = 68;
export const STOP_W = 160;
export const V_GAP = 64;
export const H_GAP = 48;
export const JOIN_R = 6;
export const GHOST_H = 44;
export const FRAME_PAD = 24;
export const FAULT_GAP = 120;
export const TAIL = 40;
export const MARGIN = 60;

const PATH_KEY = (path) => path.join('.');

/** The lanes nested in a step, as [{ key, label, path (absolute), steps }]. */
function childLanes(definition, step, stepPath) {
  return lanesOf(step).map((l) => {
    const path = [...stepPath, ...l.path];
    return { key: l.key, label: l.label, path, steps: getLane(definition, path) };
  });
}

/** True while a lane can still flow on to whatever follows it. */
export function laneOpen(definition, steps, lanePath) {
  if (!steps.length) return true;
  const last = steps[steps.length - 1];
  if (last.kind === 'stop') return false;
  if (last.kind === 'if' || last.kind === 'approval') {
    return childLanes(definition, last, [...lanePath, steps.length - 1]).some((l) => laneOpen(definition, l.steps, l.path));
  }
  return true;
}

function nodeWidth(step) { return step.kind === 'stop' ? STOP_W : NODE_W; }

function measureLane(definition, steps, lanePath) {
  if (!steps.length) return { w: NODE_W, h: GHOST_H };
  let w = NODE_W; let h = 0;
  steps.forEach((s, i) => {
    const m = measureStep(definition, s, [...lanePath, i]);
    w = Math.max(w, m.w); h += m.h; if (i) h += V_GAP;
  });
  return { w, h };
}

function measureStep(definition, step, stepPath) {
  const lanes = childLanes(definition, step, stepPath);
  if (!lanes.length) return { w: nodeWidth(step), h: NODE_H };
  if (step.kind === 'for_each') {
    const m = measureLane(definition, lanes[0].steps, lanes[0].path);
    return { w: Math.max(NODE_W, m.w + 2 * FRAME_PAD), h: NODE_H + V_GAP + m.h + FRAME_PAD };
  }
  const ms = lanes.map((l) => measureLane(definition, l.steps, l.path));
  const tw = ms.reduce((s, m) => s + m.w, 0) + H_GAP * (ms.length - 1);
  const mh = Math.max(...ms.map((m) => m.h));
  const open = lanes.some((l) => laneOpen(definition, l.steps, l.path));
  return { w: Math.max(NODE_W, tw), h: NODE_H + V_GAP + mh + (open ? V_GAP + 2 * JOIN_R : 0) };
}

/** A point on a connector's curve (the cubic `edgePath` draws) at t in [0, 1]. */
export function bezierPoint(a, b, t) {
  const dy = b.y - a.y;
  const p1 = { x: a.x, y: a.y + dy * 0.5 };
  const p2 = { x: b.x, y: b.y - dy * 0.5 };
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y,
  };
}

export function edgePath(a, b) {
  const dy = b.y - a.y;
  return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy * 0.5}, ${b.x} ${b.y - dy * 0.5}, ${b.x} ${b.y}`;
}

/**
 * Lay the definition out.
 * @returns {{ nodes: Array, edges: Array, frames: Array, hots: Array, w: number, h: number }}
 *   Node:  { id, kind, x, y, w, h, step?, path?, index?, label? }   kind adds 'trigger' | 'gate' | 'join' | 'ghost' | 'fault'
 *   Edge:  { id, d, from, to, a, b, label?, dashed? }
 *   Frame: { id, x, y, w, h, label }
 *   Hot:   { id, x, y, edge, insert: { path, index } }
 */
export function layout(definition) {
  const def = definition || {};
  const out = { nodes: [], edges: [], frames: [], hots: [] };
  let edgeCount = 0;

  const addEdge = (a, b, from, to, insert, label, opts = {}) => {
    const edge = { id: `e${edgeCount++}`, d: edgePath(a, b), from, to, a: { ...a }, b: { ...b }, label: label || '', dashed: !!opts.dashed };
    out.edges.push(edge);
    if (insert) out.hots.push({ id: `h-${edge.id}`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, edge: edge.id, insert });
    return edge;
  };

  // Lays one lane down from (cx, y); answers where it ends and whether it
  // still flows on.
  function placeLane(steps, lanePath, cx, y) {
    if (!steps.length) {
      const id = `ghost-${PATH_KEY(lanePath)}`;
      out.nodes.push({ id, kind: 'ghost', x: cx - NODE_W / 2, y, w: NODE_W, h: GHOST_H, path: lanePath, index: 0 });
      return { exit: { x: cx, y: y + GHOST_H }, exitId: id, firstId: id };
    }
    let prev = null; let curY = y; const firstId = steps[0].id;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (prev) addEdge(prev, { x: cx, y: curY }, prev.id, step.id, { path: lanePath, index: i });
      const r = placeStep(step, lanePath, i, cx, curY);
      curY += r.h;
      if (!r.exit) {
        // Whatever follows a closed step is unreachable; it is still drawn
        // (below, with no connector in) so the person can see and fix it -
        // the Publish problems list already names it.
        for (let j = i + 1; j < steps.length; j++) { curY += V_GAP; curY += placeStep(steps[j], lanePath, j, cx, curY).h; }
        return { exit: null, exitId: null, firstId };
      }
      prev = { x: r.exit.x, y: r.exit.y, id: r.exitId };
      if (i < steps.length - 1) curY += V_GAP;
    }
    return { exit: { x: prev.x, y: prev.y }, exitId: prev.id, firstId };
  }

  function placeStep(step, lanePath, index, cx, y) {
    const stepPath = [...lanePath, index];
    const m = measureStep(def, step, stepPath);
    const w = nodeWidth(step);
    out.nodes.push({ id: step.id, kind: step.kind, x: cx - w / 2, y, w, h: NODE_H, step, path: lanePath, index });
    const lanes = childLanes(def, step, stepPath);
    if (step.kind === 'stop') return { h: NODE_H, exit: null };
    if (!lanes.length) return { h: NODE_H, exit: { x: cx, y: y + NODE_H }, exitId: step.id };

    if (step.kind === 'for_each') {
      const lane = lanes[0];
      const inner = measureLane(def, lane.steps, lane.path);
      const frame = { id: `frame-${step.id}`, x: cx - m.w / 2, y: y + NODE_H + V_GAP - FRAME_PAD, w: m.w, h: inner.h + 2 * FRAME_PAD, label: 'LOOP' };
      out.frames.push(frame);
      const r = placeLane(lane.steps, lane.path, cx, y + NODE_H + V_GAP);
      addEdge({ x: cx, y: y + NODE_H }, { x: cx, y: y + NODE_H + V_GAP }, step.id, r.firstId, { path: lane.path, index: 0 }, 'each');
      const bottom = { x: cx, y: frame.y + frame.h };
      if (r.exit) addEdge(r.exit, bottom, r.exitId, frame.id, { path: lane.path, index: lane.steps.length });
      return { h: m.h, exit: bottom, exitId: frame.id };
    }

    // If / Else and approvals: one column per lane, side by side under the node.
    const ms = lanes.map((l) => measureLane(def, l.steps, l.path));
    const tw = ms.reduce((s, q) => s + q.w, 0) + H_GAP * (ms.length - 1);
    let x = cx - tw / 2; const topY = y + NODE_H + V_GAP; const exits = [];
    const spread = Math.min(44, (w - 40) / Math.max(1, lanes.length - 1));
    lanes.forEach((lane, i) => {
      const ccx = x + ms[i].w / 2;
      const r = placeLane(lane.steps, lane.path, ccx, topY);
      const sx = lanes.length > 1 ? cx + (i - (lanes.length - 1) / 2) * spread : cx;
      addEdge({ x: sx, y: y + NODE_H }, { x: ccx, y: topY }, step.id, r.firstId, { path: lane.path, index: 0 }, laneLabel(step, lane));
      if (r.exit) exits.push({ ...r, lane });
      x += ms[i].w + H_GAP;
    });
    const mh = Math.max(...ms.map((q) => q.h));
    if (!exits.length) return { h: m.h, exit: null };
    const jy = topY + mh + V_GAP; const jid = `join-${step.id}`;
    out.nodes.push({ id: jid, kind: 'join', x: cx - JOIN_R, y: jy, w: 2 * JOIN_R, h: 2 * JOIN_R });
    exits.forEach((r) => addEdge(r.exit, { x: cx, y: jy }, r.exitId, jid, { path: r.lane.path, index: r.lane.steps.length }));
    return { h: m.h, exit: { x: cx, y: jy + 2 * JOIN_R }, exitId: jid };
  }

  // ── root ──
  const cx = 0; let y = 0;
  const triggerId = 'trigger';
  out.nodes.push({ id: triggerId, kind: 'trigger', x: cx - NODE_W / 2, y, w: NODE_W, h: NODE_H, trigger: def.trigger || null });
  let prev = { x: cx, y: y + NODE_H, id: triggerId };
  y += NODE_H + V_GAP;
  const hasGate = Array.isArray(def.conditions) && def.conditions.length > 0;
  if (hasGate) {
    out.nodes.push({ id: 'gate', kind: 'gate', x: cx - NODE_W / 2, y, w: NODE_W, h: NODE_H, conditions: def.conditions });
    addEdge(prev, { x: cx, y }, prev.id, 'gate', null);
    prev = { x: cx, y: y + NODE_H, id: 'gate' };
    y += NODE_H + V_GAP;
  }
  const rootPath = ['steps'];
  const rootSteps = getLane(def, rootPath);
  const root = placeLane(rootSteps, rootPath, cx, y);
  addEdge(prev, { x: cx, y }, prev.id, root.firstId, { path: rootPath, index: 0 });
  if (root.exit) addEdge(root.exit, { x: root.exit.x, y: root.exit.y + TAIL }, root.exitId, 'tail', { path: rootPath, index: rootSteps.length }, '', { dashed: true });

  // ── the fault lane ──
  const faultPath = ['settings', 'faultSteps'];
  const faultSteps = getLane(def, faultPath);
  const right = Math.max(...out.nodes.map((n) => n.x + n.w), ...out.frames.map((f) => f.x + f.w));
  const fx = right + FAULT_GAP + NODE_W / 2;
  out.nodes.push({ id: 'fault', kind: 'fault', x: fx - NODE_W / 2, y: 0, w: NODE_W, h: NODE_H, label: 'If a step fails, do this instead' });
  const fault = placeLane(faultSteps, faultPath, fx, NODE_H + V_GAP);
  addEdge({ x: fx, y: NODE_H }, { x: fx, y: NODE_H + V_GAP }, 'fault', fault.firstId, { path: faultPath, index: 0 }, '', { dashed: true });
  if (fault.exit) addEdge(fault.exit, { x: fx, y: fault.exit.y + TAIL }, fault.exitId, 'fault-tail', { path: faultPath, index: faultSteps.length }, '', { dashed: true });

  // ── shift to a positive sheet ──
  const minX = Math.min(...out.nodes.map((n) => n.x), ...out.frames.map((f) => f.x)) - MARGIN;
  const minY = Math.min(...out.nodes.map((n) => n.y), ...out.frames.map((f) => f.y)) - MARGIN;
  const shift = (p) => { p.x -= minX; p.y -= minY; };
  out.nodes.forEach(shift); out.frames.forEach(shift); out.hots.forEach(shift);
  out.edges.forEach((e) => { shift(e.a); shift(e.b); e.d = edgePath(e.a, e.b); });
  out.w = Math.max(...out.nodes.map((n) => n.x + n.w), ...out.frames.map((f) => f.x + f.w)) + MARGIN;
  out.h = Math.max(...out.nodes.map((n) => n.y + n.h), ...out.frames.map((f) => f.y + f.h)) + TAIL + MARGIN;
  return out;
}

function laneLabel(step, lane) {
  if (step.kind === 'if') return lane.key === 'then' ? 'Yes' : 'No';
  if (lane.key === 'expired') return 'No Answer';
  return lane.label;
}

/** True when the lane at `path` sits inside the step `stepId` (one of its own lanes, at any depth). */
export function laneInside(definition, path, stepId) {
  const walk = (steps, lanePath) => steps.some((s, i) => {
    const lanes = childLanes(definition, s, [...lanePath, i]);
    if (s.id === stepId) return lanes.some((l) => PATH_KEY(path) === PATH_KEY(l.path) || PATH_KEY(path).startsWith(`${PATH_KEY(l.path)}.`));
    return lanes.some((l) => walk(l.steps, l.path));
  });
  return walk(getLane(definition, ['steps']), ['steps']) || walk(getLane(definition, ['settings', 'faultSteps']), ['settings', 'faultSteps']);
}

/**
 * The node ids a run visits, in order: the trigger, the gate when there
 * are conditions, then the steps. At an If or an approval `pick(step,
 * lanes)` returns the index of the lane to follow (default the first); a
 * branch that rejoins adds its join dot, a For Each descends once and adds
 * its frame; Stop ends the walk; a step with enabled === false is skipped.
 */
export function walkOrder(definition, pick = () => 0) {
  const def = definition || {};
  const order = ['trigger'];
  if (Array.isArray(def.conditions) && def.conditions.length) order.push('gate');
  const walk = (steps, lanePath) => {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.enabled === false) continue;
      order.push(s.id);
      if (s.kind === 'stop') return false;
      const lanes = childLanes(def, s, [...lanePath, i]);
      if (!lanes.length) continue;
      if (s.kind === 'for_each') { if (!walk(lanes[0].steps, lanes[0].path)) return false; order.push(`frame-${s.id}`); continue; }
      const k = Math.max(0, Math.min(lanes.length - 1, Number(pick(s, lanes)) || 0));
      if (!walk(lanes[k].steps, lanes[k].path)) return false;
      order.push(`join-${s.id}`);
    }
    return true;
  };
  walk(getLane(def, ['steps']), ['steps']);
  return order;
}
