// Ticket Module - what a ticket drawer shows while the ticket is still
// arriving (Oct 1). Opening a ticket from an email's link (?ticket=<id>, on
// Support or Tickets) mounts the drawer before the ticket list has landed, and
// the drawer used to render nothing until it did - the page just sat there
// for several seconds and looked like the link had not worked. This is the
// Ticket module's copy of the Task module's TasksLoading (Sep 28): the same
// spinner, message and "taking longer than usual" note, in the drawer's own
// frame so the ticket fills in where it will appear.
import { useEffect, useState } from 'react';

import { NX } from '../tasks/theme';
import { Modal } from '../tasks/components';
import { Spinner } from '../components/AsyncState';

// Past this the message admits it is slow rather than looking frozen.
const SLOW_AFTER_MS = 8000;

const FIELD_WIDTHS = ['58%', '44%', '66%', '50%'];

export default function TicketOpening({ onClose }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <Modal title="Ticket" onClose={onClose}>
      <div role="status" aria-live="polite" aria-busy="true" style={{ padding: '8px 0 4px', animation: 'fadeIn 0.2s ease' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', marginBottom: 22 }}>
          <Spinner size="section" />
          <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>Opening your ticket…</div>
          <div style={{ fontSize: 12.5, color: NX.faint }}>
            {slow ? 'Still working on it - this is taking a little longer than usual.' : 'Getting the ticket details ready.'}
          </div>
        </div>
        {/* The shape of a ticket, shimmering - a title, then its fields - so
            the drawer reads as "filling in", not as a blank box. */}
        <div aria-hidden="true">
          <span className="skel" style={{ display: 'block', width: '72%', height: 16, marginBottom: 18 }} />
          {FIELD_WIDTHS.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 0', boxShadow: `inset 0 -1px 0 ${NX.border2}` }}>
              <span className="skel" style={{ width: 96, height: 11, flexShrink: 0 }} />
              <span className="skel" style={{ width: w, height: 11 }} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
