export const msalConfig = {
  auth: {
    clientId: "be6f1e37-83a8-4a29-8b46-96d20beb32f9",
    authority: "https://login.microsoftonline.com/40966012-b88e-45c8-941a-341f87b9dc60",
    redirectUri: import.meta.env.VITE_REDIRECT_URI ?? "http://localhost:5173",
    postLogoutRedirectUri: import.meta.env.VITE_REDIRECT_URI ?? "http://localhost:5173",
  },
  cache: {
    // localStorage (not sessionStorage): the token cache is shared across tabs
    // and survives browser restarts, so opening Nexus from a new link signs in
    // silently instead of bouncing through Microsoft login every time.
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
  // No prompt override: with an active Entra session the redirect completes
  // silently. Entra shows its account picker on its own when it's ambiguous.
};

// Scopes used to acquire the ID token sent to the Nexus backend
export const apiTokenRequest = {
  scopes: ["openid", "profile", "email"],
};

export const clientId = "be6f1e37-83a8-4a29-8b46-96d20beb32f9";

// ── Step-up MFA request builder ───────────────────────────────────────────────
// Requests an ACCESS token for our API scope WITH a claims challenge for an Entra
// "authentication context" (the `acr` value, e.g. "c1"). A Conditional Access
// policy bound to that context forces a FRESH MFA — the live Microsoft
// Authenticator push, or SMS if the user registered it. The returned access
// token carries the `acrs` claim proving the context was satisfied; the backend
// (/stepup/verify) validates it. Scope + acr come from GET /stepup/config so
// Entra settings can change without a frontend rebuild (these are only fallbacks).
export const DEFAULT_STEPUP_SCOPE = `api://${clientId}/access_as_user`;
export function stepUpRequest(acr, scope) {
  return {
    scopes: [scope || DEFAULT_STEPUP_SCOPE],
    claims: JSON.stringify({ access_token: { acrs: { essential: true, values: [acr] } } }),
    // Force the interactive challenge for THIS action, not a cached token.
    prompt: "",
  };
}
