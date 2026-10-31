// Plays a replayPlan on the canvas (Blueprint, 10/30/2026): one node after
// another, the connector between them marching first. Timed with
// setTimeout, never animationend (lib/motion.js's rule), cleaned up on
// unmount or when the plan changes.
//
//   const r = useReplay(replay, { onDone, reduced });
//   r.nodeClass(id)                 -> 'wfc-lit' | 'wfc-waitlit' | 'wfc-failed' | 'wfc-skipped' | ''
//   r.edgeClass(edgeId, from, to)   -> 'wfc-live' | 'wfc-hot' | ''
//   r.active                        -> true while a replay is showing
//   r.stop()                        -> clears everything now
//
// Each step: the connector from the previous node runs `.wfc-live` for
// EDGE_MS and then stays `.wfc-hot`; a done node lights for NODE_MS; a
// waiting node breathes amber for WAIT_MS (and stays amber when it is the
// last one, the run really is waiting there); a failed node turns red and
// the story stops on it, nothing after it lights; a skipped node is passed
// over. After the last node the picture holds HOLD_MS, then clears and
// `onDone({ stoppedAt, failed })` fires. With `reduced` (reduced motion, or
// the test environment) every class lands at once with no timers and the
// picture stays until stop() or a new plan - onDone is not called.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const EDGE_MS = 420;
export const NODE_MS = 260;
export const WAIT_MS = 1100;
export const HOLD_MS = 2600;

const NODE_CLASS = { lit: 'wfc-lit', waitlit: 'wfc-waitlit', failed: 'wfc-failed', skipped: 'wfc-skippedrun' };
const EMPTY = { plan: null, nodes: {}, live: '', hot: {} };
const key = (from, to) => `${from}>${to}`;
const usable = (replay) => !!replay && Array.isArray(replay.order) && replay.order.length > 0;

function staticState(replay) {
  const nodes = {}; const hot = {};
  const order = replay.order;
  order.forEach((id, i) => {
    const st = replay.statusById?.[id];
    if (st === 'failed') nodes[id] = 'failed';
    else if (st === 'waiting') nodes[id] = 'waitlit';
    else if (st === 'skipped') nodes[id] = 'skipped';
    else if (st) nodes[id] = 'lit';
    if (i > 0) hot[key(order[i - 1], id)] = true;
  });
  return { plan: replay, nodes, live: '', hot };
}

export function useReplay(replay, { onDone, reduced = false } = {}) {
  // What the timers have drawn so far; it counts only while it belongs to
  // the plan being shown (a new plan starts from nothing).
  const [anim, setAnim] = useState(EMPTY);
  // The plan stop() cleared, so the picture stays off until a new plan comes.
  const [stopped, setStopped] = useState(null);
  const timer = useRef(null);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });

  const clear = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
  const stop = useCallback(() => { clear(); setAnim(EMPTY); setStopped(replay); }, [clear, replay]);

  const animated = usable(replay) && !reduced && stopped !== replay;

  useEffect(() => {
    if (!animated) return undefined;
    const order = replay.order;
    const statusOf = (id) => replay.statusById?.[id];
    const nodes = {}; const hot = {};
    const show = (live) => setAnim({ plan: replay, nodes: { ...nodes }, live, hot: { ...hot } });
    const wait = (ms, fn) => { timer.current = setTimeout(fn, ms); };

    const finish = (stoppedAt, failed) => {
      wait(HOLD_MS, () => { setAnim(EMPTY); doneRef.current?.({ stoppedAt, failed }); });
    };
    // Lights node k (its connector has already turned hot), then moves on.
    const light = (k) => {
      const id = order[k]; const st = statusOf(id); const lastOne = k === order.length - 1;
      if (st === 'failed') { nodes[id] = 'failed'; show(''); finish(id, true); return; }
      if (st === 'skipped') { nodes[id] = 'skipped'; show(''); next(k); return; }
      if (st === 'waiting') {
        nodes[id] = 'waitlit'; show('');
        if (lastOne) { finish(id, false); return; }
        wait(WAIT_MS, () => { nodes[id] = 'lit'; show(''); next(k); });
        return;
      }
      nodes[id] = 'lit'; show('');
      if (lastOne) { finish(id, false); return; }
      wait(NODE_MS, () => next(k));
    };
    // Runs the connector from node k to node k + 1, then lights k + 1.
    const next = (k) => {
      const from = order[k]; const to = order[k + 1];
      if (to === undefined) { finish(from, false); return; }
      show(key(from, to));
      wait(EDGE_MS, () => { hot[key(from, to)] = true; light(k + 1); });
    };

    // The first frame lands on the next tick, never inside the effect itself.
    wait(0, () => light(0));
    return clear;
  }, [animated, replay, clear]);

  const state = useMemo(() => {
    if (!usable(replay) || stopped === replay) return EMPTY;
    if (reduced) return staticState(replay);
    return anim.plan === replay ? anim : EMPTY;
  }, [replay, reduced, stopped, anim]);

  const nodeClass = useCallback((id) => NODE_CLASS[state.nodes[id]] || '', [state]);
  const edgeClass = useCallback((edgeId, from, to) => {
    const k = key(from, to);
    if (state.live === k) return 'wfc-live';
    return state.hot[k] ? 'wfc-hot' : '';
  }, [state]);
  const active = state !== EMPTY;

  return useMemo(() => ({ nodeClass, edgeClass, active, stop }), [nodeClass, edgeClass, active, stop]);
}
