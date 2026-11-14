// Whether AI interview scoring is on for this server (11/14/2026). AI is off
// unless Neil or Visesh switch it on (backend/ai_switch.py); while it is off
// Hiring shows no AI Auto-fill, Calibrate Score, Leaderboard, score chips or
// Final Round. Read from `aiEnabled` on GET /hr/hiring/options, once per page
// load; anything that fails reads as off.
import { useEffect, useState } from 'react';
import { api } from '../../api';

let pending = null;
let known = null;

function load() {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => api.hiringOptions(''))
      .then(o => { known = !!o?.aiEnabled; return known; })
      .catch(() => { pending = null; return false; });
  }
  return pending;
}

export function useHiringAi() {
  const [on, setOn] = useState(known ?? false);
  useEffect(() => {
    let alive = true;
    load().then(v => { if (alive) setOn(v); });
    return () => { alive = false; };
  }, []);
  return on;
}

// Tests start from "not known yet".
export function resetHiringAiForTests() { pending = null; known = null; }
