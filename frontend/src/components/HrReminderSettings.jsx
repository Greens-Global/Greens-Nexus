// HR & Compliance Reminders (Sep 2026) - when the daily HR reminder scan
// warns people about visa expiry, contract ends, new starters, expiring HR
// documents and stalled signature requests. The days used to be hard-coded in
// backend/reminders.py; the admin picks them here now (backend
// hr_reminder_config.py + routers/hr_reminder_settings.py, which also decides
// who may save and reports it as `canEdit`).
//
// Written for an HR person, not an engineer. The panel itself is shared with
// Equipment Reminders - see ReminderSettingsPanel.jsx.
import { api } from '../api';
import ReminderSettingsPanel, { beforeLabel, afterLabel } from './ReminderSettingsPanel';

const BEFORE = { field: 'daysBefore', label: 'Remind before the date', min: 0, format: beforeLabel };
const AFTER = { field: 'daysAfter', label: 'Keep reminding after it expires', min: 1, format: afterLabel };

// Display order + copy.
const ROWS = [
  { key: 'rightToWork', title: 'Visa & Right-to-Work Expiry', lists: [BEFORE, AFTER],
    what: 'An employee\'s visa or right-to-work document is about to expire.',
    who: 'Goes to the HR team (everyone with access to People).' },
  { key: 'contractEnd', title: 'Contract End', lists: [BEFORE],
    what: 'A contractor\'s contract is about to end.',
    who: 'Goes to the HR team.' },
  { key: 'newStarter', title: 'New Starter', lists: [BEFORE],
    what: 'Someone being onboarded is about to start.',
    who: 'Goes to the HR team and the new starter\'s manager.' },
  { key: 'documentExpiry', title: 'HR Document Expiry', lists: [BEFORE],
    what: 'An HR document uploaded with an expiry date is about to expire.',
    who: 'Goes to the HR team.' },
  { key: 'esignExpiring', title: 'Signature Request Expiring', lists: [BEFORE],
    what: 'A signature request is still unsigned and close to its expiry date.',
    who: 'Goes to the person who sent the request.' },
  { key: 'esignChase', title: 'Signature Chase',
    what: 'Someone has not signed a request they were sent.',
    who: 'Goes to the person who still needs to sign (bell and email). After the last nudge, the sender is told the reminders have stopped.',
    nums: [
      { field: 'firstNudgeAfterDays', label: 'Nudge after', suffix: 'quiet days', min: 1, max: 30 },
      { field: 'maxNudges', label: 'Stop after', suffix: n => (n === 1 ? 'nudge' : 'nudges'), min: 0, max: 10 },
    ] },
];

export default function HrReminderSettings() {
  return (
    <ReminderSettingsPanel load={api.getHrReminderSettings} save={api.updateHrReminderSettings} rows={ROWS}
      intro="Nexus checks every morning and sends a reminder to the notification bell on each day you pick. Each reminder goes out at most once a day. Changes apply from the next check - days that have already passed are never sent late."
      lockedNote="You can see these settings. Only a Global Admin or someone with Full access to People can change them." />
  );
}
