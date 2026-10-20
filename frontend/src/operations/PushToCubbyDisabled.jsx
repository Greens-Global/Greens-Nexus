// "Push to Cubby", shown but switched off (Visesh, Oct 20 2026): the button is
// there so everyone knows where pushing will live, but Nexus only READS from
// Cubby for now - rates and rents are entered in Cubby by hand, then marked
// Entered here. This is UI only: there is no code path behind it that writes
// to Cubby (see ops_rate_mgmt.py / ops_revenue.py and their no-write tests).
import { Lock } from 'lucide-react';

export const PUSH_OFF_NOTE = 'Pushing to Cubby is turned off for now. Enter the changes in Cubby by hand, then mark them Entered in Cubby here.';

export default function PushToCubbyDisabled({ label = 'Push to Cubby', style }) {
  return (
    <span title={PUSH_OFF_NOTE} style={{ display: 'inline-flex', ...style }}>
      <button type="button" className="secondary-btn" disabled aria-disabled="true" aria-label={`${label} (turned off for now - manual entry only)`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'not-allowed', opacity: 0.55 }}>
        <Lock size={13} aria-hidden="true" /> {label}
        <span className="status-badge pill-muted" style={{ fontSize: 10, marginLeft: 2 }}>Off</span>
      </button>
    </span>
  );
}
