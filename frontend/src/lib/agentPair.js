// Shared-PC binding for a clock-in - used by the Time Clock screen and the
// dashboard's My Time tile (Oct 8), so a punch from either binds the PC.
import { api } from '../api';

// Shared-PC binding: mint a nonce and hand it to the LOCAL Nexus agent over
// localhost, so the agent claims this PC's device identity with its own token
// (the browser never sends a device_id). Returns the nonce to send with clock-in,
// or '' if there's no agent - a personal machine then clocks in unbound, exactly
// as before. Best-effort with a short timeout so it never blocks the punch.
const NEXUS_AGENT_PORT = 47615;
export async function pairLocalAgent() {
  try {
    const { nonce } = await api.timeAgentPairChallenge();
    if (!nonce) return '';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    let ok = false;
    try {
      const r = await fetch(`http://127.0.0.1:${NEXUS_AGENT_PORT}/nexus/pair?nonce=${encodeURIComponent(nonce)}`,
        { signal: ctrl.signal });
      ok = r.ok;
    } catch { /* no agent reachable - unbound clock-in */ }
    clearTimeout(t);
    return ok ? nonce : '';
  } catch { return ''; }
}
