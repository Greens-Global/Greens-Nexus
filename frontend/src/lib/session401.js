// Which 401s mean "your Nexus sign-in is dead" (11/26/2026).
//
// The server answers 401 for more than a dead sign-in: "Insufficient
// permissions" (auth.require_level, app-wide), Egnyte refusing its stored
// token, a step the caller may not take. api.js used to read EVERY 401 as a
// dead sign-in: it re-sent the request with a fresh token (a wrong Personal
// Vault password went up twice) and then left the page for Microsoft sign-in.
//
// Only the sign-in check's own answers (backend/auth.py, and the preview
// handoff) are a dead sign-in; they are worded as below and
// backend/test_session_401.py fails when auth.py words one differently. A 401
// with no words at all (a proxy's, a structured one) is still read as a dead
// sign-in, as before - never the other way round.
const SESSION = /^(Missing or invalid Authorization header|Invalid token|Token |This preview sign-in has expired)/;

export const isSessionDead = (detail) => typeof detail !== 'string' || SESSION.test(detail);

/** True when this response is a 401 from the sign-in check itself. */
export async function sessionDead401(res) {
  if (res.status !== 401) return false;
  try { return isSessionDead((await res.clone().json())?.detail); } catch { return true; }
}
