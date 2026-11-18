// Passwords - the 'credvault' view. Since 11/18/2026 (Neil) the module is a
// Dashboard tab beside Notes and Links, so for an employee this view is only a
// doorway: every bell, email and saved link that still names it lands here,
// and the person is sent on to the tab (the entry is replaced, so Back never
// loops). `activeSub` carries the deep link: "personal" | "activity" | "trash"
// | "cred-<id>" ... (credvault/vaultModel.parseSub); "approvals" goes to
// Dashboard > Approvals, where those requests are decided now.
//
// An outside guest has no Dashboard - they open only the modules granted to
// them - so for a guest who holds the grant the same screen renders here by
// itself, with its own Requests sheet.
import { useEffect, useRef } from "react";
import CredentialVaultApp from "../credvault/CredentialVaultApp";
import { ViewLoading } from "../components/AsyncState";
import { useRole } from "../contexts/RoleContext";
import { passwordsSub } from "../lib/routes";

export default function CredentialVault({ activeSub, onBounce }) {
  const { isExternal } = useRole();
  // Once per address: `onBounce` is a new function on every App render.
  const sent = useRef(null);
  useEffect(() => {
    if (isExternal || sent.current === (activeSub || "")) return;
    sent.current = activeSub || "";
    onBounce?.("dashboard", passwordsSub(activeSub));
  }, [isExternal, activeSub, onBounce]);
  if (!isExternal) return <ViewLoading minHeight="40vh" />;
  return <CredentialVaultApp activeSub={activeSub} standalone />;
}
