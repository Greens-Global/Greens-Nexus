// Nexus Signature (DEV) - Outlook Add-in compose-time handler.
// Identical to commands.js except NEXUS_API_BASE points at the dev backend -
// see manifest-dev.xml for why this variant exists (sideloaded testing
// before anything touches production). Keep the two files in sync if the
// compose-event logic itself ever changes.

const NEXUS_API_BASE = "https://greens-nexus-api-dev-a6fad4brawevg8de.westus2-01.azurewebsites.net";
const FETCH_TIMEOUT_MS = 12000;

Office.onReady();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

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

function onMessageSendHandler(event) {
  applySignature()
    .catch(() => {})
    .then(() => event.completed({ allowEvent: true }));
}

Office.actions.associate("onNewMessageComposeHandler", onNewMessageComposeHandler);
Office.actions.associate("onMessageSendHandler", onMessageSendHandler);
