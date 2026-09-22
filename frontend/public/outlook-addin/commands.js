// Nexus Signature - Outlook Add-in compose-time handler (Sep 16, Pranshu;
// recipient targeting Sep 22).
//
// Two entry points:
//  - onNewMessageComposeHandler fires on OnNewMessageCompose, which covers
//    new messages, replies, reply-alls, and forwards. On a reply/forward the
//    recipient list is already populated the instant compose opens, so
//    recipient-scope targeting (backend/routers/hr.py's
//    signature_recipient_scope: All/Internal/External) is correct
//    immediately. On a brand-new message there's nothing typed yet - the
//    add-in has no persistent runtime to react as the user adds recipients
//    afterward (LaunchEvent activation is short-lived, torn down once
//    event.completed() runs), so this pass is best-effort for that case.
//  - onMessageSendHandler fires on Send, with the complete To/Cc list
//    regardless of how the message started. This is the authoritative check:
//    whatever recipient-scope decision applies, it's correct here even if the
//    compose-time pass above got it wrong or never saw a recipient at all.
//
// Must always call event.completed() - a LaunchEvent handler that never
// completes blocks the user from composing/sending (SendMode="SoftBlock"
// gives a short grace period, not an indefinite hang), so every path below
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

// To+Cc only - Bcc is deliberately excluded, since whether a signature shows
// shouldn't depend on someone the sender chose to hide from the visible
// recipient list.
function getRecipientEmails() {
  const item = Office.context.mailbox.item;
  const getField = (field) => new Promise(resolve => {
    field.getAsync(r => resolve(r.status === Office.AsyncResultStatus.Succeeded ? r.value : []));
  });
  return Promise.all([getField(item.to), getField(item.cc)])
    .then(([to, cc]) => [...to, ...cc].map(p => p.emailAddress).filter(Boolean));
}

function fetchSignatureHtml(recipients) {
  return new Promise((resolve, reject) => {
    Office.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true })
      .then(token => fetch(
        `${NEXUS_API_BASE}/outlook-addin/signature?recipients=${encodeURIComponent(recipients.join(","))}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => resolve(data.html || ""))
      .catch(reject);
  });
}

// Sets (or actively clears) the signature. An empty html here is NOT "leave
// it alone" - it means the company's recipient-scope rule suppressed it
// (e.g. External Only, but every current recipient is internal), and a
// signature the compose-time pass already inserted must be removed, not
// just skipped.
function applySignature() {
  return getRecipientEmails()
    .then(recipients => withTimeout(fetchSignatureHtml(recipients), FETCH_TIMEOUT_MS))
    .then(html => new Promise(resolve => {
      Office.context.mailbox.item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        () => resolve(),
      );
    }));
}

function onNewMessageComposeHandler(event) {
  applySignature()
    .catch(() => {})
    .then(() => event.completed());
}

// Never block the send on our own failure - allowEvent stays true either way.
function onMessageSendHandler(event) {
  applySignature()
    .catch(() => {})
    .then(() => event.completed({ allowEvent: true }));
}

Office.actions.associate("onNewMessageComposeHandler", onNewMessageComposeHandler);
Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
