// Nexus Signature - Outlook Add-in compose-time handler (Sep 16, Pranshu).
//
// Fires on OnNewMessageCompose / OnMessageReplyCompose (see manifest.xml).
// Fetches the signed-in employee's signature from Nexus
// (backend/routers/outlook_addin.py) using an Office SSO access token, then
// inserts it as the message's signature via Office.js.
//
// Must always call event.completed() - a LaunchEvent handler that never
// completes blocks the user from composing (SendMode="SoftBlock" gives a
// short grace period, not an indefinite hang), so every path below
// (success, auth failure, network failure, slow response) is time-boxed and
// falls through to event.completed() no matter what happens.

// Production backend host (Sep 17 fix: the plain "greens-nexus-api.
// azurewebsites.net" guessed at commit time doesn't exist - Azure appended a
// random uniqueness suffix to the actual hostname. Confirmed against the
// live SPA's own bundled VITE_API_BASE, not guessed - if this ever needs
// re-checking, grep the deployed index-*.js bundle on nexus.greensglobal.com
// for "azurewebsites.net" rather than assuming the plain app-service name.
const NEXUS_API_BASE = "https://greens-nexus-api-ejfxdjcbevfxb2ht.westus2-01.azurewebsites.net";
const FETCH_TIMEOUT_MS = 12000;

Office.onReady();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function fetchSignatureHtml() {
  return new Promise((resolve, reject) => {
    Office.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true })
      .then(token => fetch(`${NEXUS_API_BASE}/outlook-addin/signature`, {
        headers: { Authorization: `Bearer ${token}` },
      }))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => resolve(data.html || ""))
      .catch(reject);
  });
}

function onNewMessageComposeHandler(event) {
  withTimeout(fetchSignatureHtml(), FETCH_TIMEOUT_MS)
    .then(html => {
      if (!html) { event.completed(); return; }
      Office.context.mailbox.item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        () => event.completed(),
      );
    })
    // Never block compose on our own failure - the employee just gets no
    // auto-inserted signature this time and can still write their message.
    .catch(() => event.completed());
}

Office.actions.associate("onNewMessageComposeHandler", onNewMessageComposeHandler);
