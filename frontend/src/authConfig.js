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
    // Keep the redirect's auth state in a first-party cookie too. Silent token
    // renewal runs in a hidden iframe that depends on THIRD-party cookies, which
    // modern browsers increasingly block by default - when they do, renewal fails
    // and the user's token silently expires (the "sandboxed iframe can't navigate
    // top" console error). A first-party cookie is immune to that block and lets
    // the redirect flow recover reliably. Recommended by MSAL for exactly this.
    storeAuthStateInCookie: true,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
  // Always show the Microsoft account picker on the INTERACTIVE sign-in
  // (Aug 18): with a live Entra session the silent completion signed people
  // into whichever account the browser already held - Pranshu's guest test
  // got SSO'd into his work account and never got to pick the invited Gmail.
  // Interactive login only - silent token acquisition must never carry a
  // prompt, or it would stop being silent.
  prompt: "select_account",
};

// Scopes used to acquire the ID token sent to the Nexus backend
export const apiTokenRequest = {
  scopes: ["openid", "profile", "email"],
};

export const clientId = "be6f1e37-83a8-4a29-8b46-96d20beb32f9";

// Redirect target for popup AND silent-iframe token flows. A blank static
// page - never the app root: the SPA booting inside the popup/iframe consumed
// the auth hash before MSAL could read it (zombie popups; ssoSilent
// timed_out). EXTENSIONLESS on hosted domains: Cloudflare Pages pretty-URLs
// 301 /auth-popup.html -> /auth-popup, and that hop lands MSAL's iframe on a
// URL that doesn't match the requested redirectUri, so it waits for a page
// that never comes (verified on dev, Aug 5). Vite's dev server has no such
// rewrite and needs the real filename. Must be registered as a SPA redirect
// URI in Entra for every hosting domain exactly as produced here.
export const popupRedirectUri =
  typeof location === 'undefined' ? '/auth-popup'
    : location.origin + (location.hostname === 'localhost' ? '/auth-popup.html' : '/auth-popup');

// ── Step-up re-auth request (Entra Free - no Conditional Access needed) ────────
// Forces a FRESH interactive Microsoft sign-in for the sensitive action. If the
// tenant enforces MFA (Security Defaults or per-user MFA - both free), that
// re-login includes the Authenticator/SMS challenge. The resulting ID token
// carries a fresh `auth_time`, which the backend (/stepup/verify) checks to prove
// the re-auth just happened. prompt:"login" is what forces the re-authentication.
export const stepUpReauthRequest = {
  scopes: ["openid", "profile", "email"],
  prompt: "login",
};
