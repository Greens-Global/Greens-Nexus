import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Modal } from '../tasks/components';
import LiveCrewMap from './LiveCrewMap';
import { trailState, locationPermissionState } from '../lib/useLocationTrail';

// The plain notice on the Time Clock page while the person's company has
// Location Trail While Clocked In on (Oct 20 2026, lib/useLocationTrail.js):
// what is shared, with whom, when it stops, the browser's limits, and their
// own trail. Renders nothing when the switch is off.
export default function LocationTrailNote({ status }) {
  const state = trailState(status);
  const [perm, setPerm] = useState('unknown');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state === 'off') return undefined;
    let live = true;
    locationPermissionState().then(p => { if (live) setPerm(p); }).catch(() => {});
    return () => { live = false; };
  }, [state]);
  if (state === 'off') return null;

  const now = state === 'active' ? 'Your location is being shared now.'
    : state === 'on_break' ? 'Sharing is paused while you are on break.'
      : 'Nothing is shared while you are clocked out.';
  return (
    <div role="note" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 10, marginBottom: 14,
      background: 'var(--wk-brand-tint, rgba(37,99,235,0.08))', border: '1px solid var(--wk-line2)', fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.5 }}>
      <MapPin size={16} style={{ color: 'var(--wk-brand)', flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>Location Trail Is On</div>
        <div>
          While you are clocked in, Nexus shares your location with your manager about every 5 minutes. It pauses on
          breaks and stops when you clock out. {now}
        </div>
        {perm !== 'granted' && (
          <div style={{ color: 'var(--muted)' }}>
            Location access is not turned on for Nexus in this browser, so nothing is shared from it.
          </div>
        )}
        <div style={{ color: 'var(--muted)' }}>
          A browser only shares while Nexus is open: a locked phone screen or a closed tab leaves gaps in the trail.
        </div>
      </div>
      <button type="button" className="secondary-btn" onClick={() => setOpen(true)} style={{ fontSize: 12, flexShrink: 0 }}>
        View My Trail
      </button>
      {open && (
        <Modal title="My Location Trail" onClose={() => setOpen(false)} minHeight="60vh">
          <LiveCrewMap self />
        </Modal>
      )}
    </div>
  );
}
