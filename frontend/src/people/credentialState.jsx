import { AlertTriangle } from 'lucide-react';
import { StatusLabel } from '../components/StatusLabel';
import { CRED_STATE } from './credentialStates';

// The state of a license or certification, as the record, the report and
// My HR show it (hr_credentials.state is the one rule; the words match).
// Expiring Soon and Expired carry the warning icon - yellow / red, never orange.
export function CredentialState({ state }) {
  const s = CRED_STATE[state] || CRED_STATE.no_expiry;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {s.warn && <AlertTriangle size={12} color={s.color} aria-hidden="true" />}
      <StatusLabel label={s.label} color={s.color} size="sm" />
    </span>
  );
}
