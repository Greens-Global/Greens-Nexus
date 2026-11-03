// What the Construction screens need to know about the server (Neil,
// 11/03/2026): whether AI is on. AI is OFF unless Neil or Visesh turns it on
// (backend ai_switch.py), and while it is off every AI chip, label, sort and
// helper is hidden - "AI Pending", "Queued for AI processing", the confidence
// sort, the Sparkles, "AI can suggest", "Safety Flags ... raised by AI".
//
// One read per page load (GET /construction/meta, cached in api.js), shared by
// every component through a module cache - no provider needed, so the views
// render the same inside the app and in their render-smoke tests. Until the
// answer arrives the answer is "off": nothing AI ever flashes on screen.
import { useEffect, useState } from 'react';
import { api } from '../../api';

const OFF = { aiEnabled: false, tags: ['delay', 'safety', 'issue', 'weather'] };
let cached = null;
let inflight = null;
const listeners = new Set();

function load() {
  if (cached || inflight) return;
  try {
    const p = api.getConstructionMeta?.();
    if (!p || typeof p.then !== 'function') { cached = OFF; return; }
    inflight = p
      .then((m) => { cached = { ...OFF, ...(m || {}) }; })
      .catch(() => { cached = OFF; })
      .finally(() => { inflight = null; listeners.forEach((fn) => fn(cached)); });
  } catch {
    cached = OFF;
  }
}

export function useConstructionMeta() {
  const [meta, setMeta] = useState(cached || OFF);
  useEffect(() => {
    listeners.add(setMeta);
    load();
    if (cached) setMeta(cached);
    return () => { listeners.delete(setMeta); };
  }, []);
  return meta;
}

// Tests start each case from a clean slate.
export function resetConstructionMeta() {
  cached = null;
  inflight = null;
}
