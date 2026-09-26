// Equipment Reminders (Sep 2026) - overdue checkout reminders and the asset
// date alerts (warranty, inspection, registration and insurance, service).
// Backend: equipment_reminder_config.py + routers/equipment_reminder_settings.py
// (decides who may save, reported as `canEdit`); the daily scan is
// equipment_reminders.py. Same panel as HR reminders (ReminderSettingsPanel).
import { api } from '../api';
import ReminderSettingsPanel, { beforeLabel } from './ReminderSettingsPanel';

const WARN = { field: 'daysBefore', label: 'Warn before the date', min: 0, format: beforeLabel };
const MANAGER = 'Goes to the asset manager set on the property, vehicle or equipment. If nobody is set, it goes to the IT Admins.';

const ROWS = [
  { key: 'overdue', title: 'Overdue Checkouts',
    what: 'Someone has an item checked out past its due date and has not returned it.',
    who: 'Goes to the person who has the item. After the days you pick below, it also goes to whoever handed the item over (or approved it, or the item\'s department lead).',
    checks: [{ field: 'onDueDate', label: 'Also remind on the due date' }],
    nums: [
      { field: 'everyDays', label: 'Remind every', suffix: n => (n === 1 ? 'day' : 'days'), min: 1, max: 30 },
      { field: 'maxReminders', label: 'Stop after', suffix: n => (n === 1 ? 'reminder' : 'reminders'), min: 0, max: 20 },
      { field: 'notifyOwnerAfterDays', label: 'Tell the owner after', suffix: 'days overdue', min: 0, max: 60 },
    ] },
  { key: 'warranty', title: 'Warranty Expiry', lists: [WARN],
    what: 'A property, equipment or item warranty is about to expire.',
    who: `${MANAGER} For an item, it goes to the person it is assigned to, or its department lead.` },
  { key: 'inspection', title: 'Inspection Due', lists: [WARN],
    what: 'A property inspection is coming up.', who: MANAGER },
  { key: 'registration', title: 'Registration & Insurance', lists: [WARN],
    what: 'A vehicle or equipment registration or insurance policy is about to expire.', who: MANAGER },
  { key: 'service', title: 'Next Service', lists: [WARN],
    what: 'A vehicle or piece of equipment is due for service.', who: MANAGER },
];

export default function EquipmentReminderSettings() {
  return (
    <ReminderSettingsPanel load={api.getEquipmentReminderSettings} save={api.updateEquipmentReminderSettings} rows={ROWS}
      intro="Nexus checks every morning and sends these to the notification bell. Each person gets at most one reminder a day per item. A warning is sent once for each day you pick; if a date is added late, the warning goes out at the next check."
      lockedNote="You can see these settings. Only an IT Admin, a Global Admin or someone with Full access to Item Management can change them." />
  );
}
