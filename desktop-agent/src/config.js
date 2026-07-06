// ── Agent configuration ───────────────────────────────────────────────────────
// Values default to the Greens Nexus DEV backend + the existing Entra app
// registration (same clientId the web app uses, so the ID token this agent
// obtains has aud == clientId and passes the backend's validation unchanged).
// Override any of these with an environment variable at build/run time.

const CLIENT_ID = process.env.NEXUS_CLIENT_ID || 'be6f1e37-83a8-4a29-8b46-96d20beb32f9';
const TENANT_ID = process.env.NEXUS_TENANT_ID || '40966012-b88e-45c8-941a-341f87b9dc60';

module.exports = {
  clientId: CLIENT_ID,
  authority: `https://login.microsoftonline.com/${TENANT_ID}`,

  // The backend consumes the ID token (aud == clientId); these scopes yield one.
  scopes: ['openid', 'profile', 'email'],

  // Where the Nexus API lives. DEV by default — set NEXUS_API_BASE for prod.
  apiBase: (process.env.NEXUS_API_BASE
    || 'https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net').replace(/\/+$/, ''),

  // Where "Open Time Clock" points (the web app).
  webBase: (process.env.NEXUS_WEB_BASE || 'https://dev.nexus.greensglobal.com').replace(/\/+$/, ''),

  captureIntervalMs: Number(process.env.NEXUS_CAPTURE_MS) || 5 * 60 * 1000, // one frame set / 5 min
  statusPollMs: 60 * 1000,          // how often we re-check clock state / heartbeat
  maxWidth: 1280,                   // longest edge of each saved frame
  jpegQuality: 55,
  idleBadgeSec: 300,                // parity with the web gallery's idle badge
  idleActiveSec: 120,               // silent mode: idle beyond this = "not working"
  sampleMs: 15 * 1000,              // how often to sample the foreground app
};
