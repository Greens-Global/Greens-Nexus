// Passwords - the vault's code step, for a screen that is not the vault.
// Dashboard > Approvals decides a request for a login in place (Neil,
// 11/18/2026): Approve needs the same text / email code a reveal does, so
// `ensureVaultCode()` checks the caller's window and, when it is closed,
// shows the vault's own VaultOtpModal over whatever is on screen. Resolves
// true once the window is open, false when the person closes the card.
// Nothing here opens a password; the server still checks the window itself.
import { createRoot } from "react-dom/client";
import { api } from "../api";
import { VaultOtpModal } from "./vaultShared";
import "./credvault.css";

let inFlight = null;   // two approvals at once share one card

export function ensureVaultCode() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const st = await api.cvOtpStatus().catch(() => null);
    if (st?.verified && st.until > Date.now()) return true;
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.setAttribute("data-vault-code", "");
      document.body.appendChild(host);
      const root = createRoot(host);
      const finish = (ok) => { root.unmount(); host.remove(); resolve(ok); };
      root.render(
        <VaultOtpModal title="Verify Your Identity" subtitle="Approving opens a password for someone - confirm it is you."
          onClose={() => finish(false)} onVerified={() => finish(true)} />,
      );
    });
  })().finally(() => { inFlight = null; });
  return inFlight;
}
