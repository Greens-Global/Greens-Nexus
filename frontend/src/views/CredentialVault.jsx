// Credential Vault - thin wrapper around the module in src/credvault/.
// `activeSub` carries deep links from the bell and the header search:
// "approvals" | "personal" | "activity" | "trash" | "cred-<id>" (see
// credvault/vaultModel.parseSub).
import CredentialVaultApp from "../credvault/CredentialVaultApp";

export default function CredentialVault({ activeSub, onSubChange }) {
  return <CredentialVaultApp activeSub={activeSub} onSubChange={onSubChange} />;
}
