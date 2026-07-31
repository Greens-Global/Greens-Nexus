// Credential Vault - thin wrapper around the self-contained module port in
// src/credvault/ (mirrors the Marketing standalone-app port pattern).
import CredentialVaultApp from "../credvault/CredentialVaultApp";

export default function CredentialVault() {
  return <CredentialVaultApp />;
}
