// Ticket Module - Manage: admin surface for the ticket workspace. Split out of
// the task module's ManageView (Jul 2026) so ticket admin lives with the
// module it configures instead of inside Tasks' Manage screen.
//
// Sub-tab strip matches ManageView's (underline tabs, icon + label,
// .scroll-tabs for mobile swipe) - the two Manage screens should not each
// invent their own navigation.
//
// Service Desk leads: it decides who OWNS a ticket - who is notified, who may
// route it for approval, who works the queues. Email settings are how those
// people are told, which is downstream of that.
import { useState } from 'react';
import { Headset, Mail } from 'lucide-react';
import TicketDeskSettings from './TicketDeskSettings';
import TicketNotifySettings from './TicketNotifySettings';
import { NX, FONT, btn } from '../tasks/theme';

const SUBTABS = [
  { key: 'desk', label: 'Service Desk', icon: Headset },
  { key: 'notify', label: 'Email Notifications', icon: Mail },
];

export default function TicketManageView() {
  const [tab, setTab] = useState('desk');

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto' }}>
        {SUBTABS.map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              ...btn('ghost'), flexShrink: 0, padding: '13px 12px', borderRadius: 0,
              borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
              color: active ? NX.ink : NX.dim, fontWeight: active ? 700 : 600,
            }}>
              <t.icon size={15} />{t.label}
            </button>
          );
        })}
      </div>

      {/* Full-bleed, deliberately NOT the centered admin column ManageView uses
          (Pranshu, Aug 27) - this module's settings are card grids/wide tables
          (per-company desk cards, the delivery log), not a single stack of
          short label/input pairs, so a 940px cap just wasted the rest of a
          wide monitor instead of helping anyone read a form. */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.surface2, padding: 20 }}>
        {tab === 'desk' && <TicketDeskSettings />}
        {tab === 'notify' && <TicketNotifySettings />}
      </div>
    </div>
  );
}
