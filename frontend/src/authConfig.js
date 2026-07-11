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
