// Egnyte - thin wrapper around the self-contained module in src/egnyte/
// (mirrors the Credential Vault / Marketing port pattern).
import EgnyteApp from "../egnyte/EgnyteApp";

export default function Egnyte({ activeSub, onSubChange }) {
  return <EgnyteApp activeSub={activeSub} onSubChange={onSubChange} />;
}
