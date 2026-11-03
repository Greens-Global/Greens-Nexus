// Item Management - is AI on for this server? (Items redesign, Neil 11/02/2026)
// AI is OFF unless Neil or Visesh switch it on (backend ai_switch.py blanks
// the key). The photo-finder buttons ask the server, and stay hidden until it
// says a key is there - never shown just to fail.
import { useEffect, useState } from 'react';
import { api } from '../../api';

let _known = null;

export function useAiEnabled() {
  const [on, setOn] = useState(_known === true);
  useEffect(() => {
    if (_known != null) { setOn(_known); return undefined; }
    let alive = true;
    Promise.resolve(api.getTicketAiStatus?.())
      .then(st => { _known = !!st?.keyConfigured; if (alive) setOn(_known); })
      .catch(() => { _known = false; if (alive) setOn(false); });
    return () => { alive = false; };
  }, []);
  return on;
}

export function _resetAiEnabled() { _known = null; }
