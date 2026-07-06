// ── Entra sign-in (delegated, as the real user) ───────────────────────────────
// Public-client auth-code flow with PKCE. We open the SYSTEM browser (so the
// user sees the normal Microsoft login, MFA included), catch the redirect on a
// loopback port, and exchange the code. The MSAL token cache is persisted to
// disk encrypted with Electron safeStorage, so subsequent launches sign in
// silently. The token we hand back is the ID TOKEN (aud == clientId), which is
// exactly what the Nexus backend validates.

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { app, shell, safeStorage } = require('electron');
const { PublicClientApplication, CryptoProvider, LogLevel } = require('@azure/msal-node');
const config = require('./config');

const CACHE_PATH = path.join(app.getPath('userData'), 'msal-cache.bin');

function loadCache() {
  try {
    const buf = fs.readFileSync(CACHE_PATH);
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8'); // fallback: platform without a keychain
  } catch { return ''; }
}
function saveCache(data) {
  try {
    const out = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(data) : Buffer.from(data, 'utf8');
    fs.writeFileSync(CACHE_PATH, out, { mode: 0o600 });
  } catch { /* non-fatal: we just won't remember the session */ }
}

const cachePlugin = {
  beforeCacheAccess: async (ctx) => { ctx.tokenCache.deserialize(loadCache()); },
  afterCacheAccess: async (ctx) => { if (ctx.cacheHasChanged) saveCache(ctx.tokenCache.serialize()); },
};

const pca = new PublicClientApplication({
  auth: { clientId: config.clientId, authority: config.authority },
  cache: { cachePlugin },
  system: { loggerOptions: { logLevel: LogLevel.Error, loggerCallback: () => {} } },
});

async function cachedAccount() {
  const accounts = await pca.getTokenCache().getAllAccounts();
  return accounts[0] || null;
}

// Silent-first: returns an ID token, or null if interactive sign-in is needed.
async function getTokenSilent() {
  const account = await cachedAccount();
  if (!account) return null;
  try {
    const r = await pca.acquireTokenSilent({ account, scopes: config.scopes });
    return r.idToken;
  } catch { return null; }
}

// Interactive: opens the system browser, waits for the loopback redirect.
function getTokenInteractive() {
  return new Promise((resolve, reject) => {
    const crypto = new CryptoProvider();
    let server;
    const timeout = setTimeout(() => { try { server.close(); } catch {} reject(new Error('Sign-in timed out')); }, 5 * 60 * 1000);

    crypto.generatePkceCodes().then(({ verifier, challenge }) => {
      server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, 'http://localhost');
          const code = u.searchParams.get('code');
          if (!code) { res.end('Waiting for Microsoft…'); return; }
          const redirectUri = `http://localhost:${server.address().port}`;
          const result = await pca.acquireTokenByCode({ code, scopes: config.scopes, redirectUri, codeVerifier: verifier });
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:system-ui;padding:40px"><h2>Signed in to Greens Nexus Agent</h2><p>You can close this tab and return to the app.</p></body></html>');
          clearTimeout(timeout); server.close();
          resolve(result.idToken);
        } catch (e) {
          try { res.writeHead(500); res.end('Sign-in failed.'); } catch {}
          clearTimeout(timeout); try { server.close(); } catch {}
          reject(e);
        }
      });
      server.listen(0, '127.0.0.1', async () => {
        const redirectUri = `http://localhost:${server.address().port}`;
        const authUrl = await pca.getAuthCodeUrl({
          scopes: config.scopes, redirectUri,
          codeChallenge: challenge, codeChallengeMethod: 'S256',
        });
        shell.openExternal(authUrl);
      });
    }).catch(reject);
  });
}

async function signOut() {
  const account = await cachedAccount();
  if (account) { try { await pca.getTokenCache().removeAccount(account); } catch {} }
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

module.exports = { getTokenSilent, getTokenInteractive, signOut, cachedAccount };
