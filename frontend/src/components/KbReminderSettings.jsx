// Training Reminders (Oct 2026) - the Knowledge Base's daily reminders and
// Monday digests. Backend: kb_reminder_config.py + routers/kb_reminder_settings.py
// (decides who may save, reported as `canEdit`); the daily scan is kb_daily.py.
// Same panel as HR and Equipment reminders (ReminderSettingsPanel).
import { api } from '../api';
import ReminderSettingsPanel from './ReminderSettingsPanel';

const EMAIL = [{ field: 'email', label: 'Also send an email (off = notification bell only)' }];

const ROWS = [
  { key: 'learners', title: 'Training Due and Overdue', checks: EMAIL,
    what: 'Training is due in 7 days, due today, or overdue (then weekly), or a policy is waiting to be signed.',
    who: 'Goes to the person who has to take the training or sign the policy, listing everything in one reminder.' },
  { key: 'managers', title: 'Manager Digest', checks: EMAIL,
    what: 'Every Monday, the direct reports who are behind on training.',
    who: 'Goes to each manager with at least one direct report behind.' },
  { key: 'owners', title: 'Page Owner Digest', checks: EMAIL,
    what: 'Every Monday, pages past their review date, reader reports and page requests.',
    who: 'Goes to the page owner, else the collection owner.' },
];

export default function KbReminderSettings() {
  return (
    <ReminderSettingsPanel load={api.getKbReminderSettings} save={api.updateKbReminderSettings} rows={ROWS}
      intro="Nexus checks every morning. Each person gets at most one of each reminder a day. Training assignments and renewals keep running when these are off."
      lockedNote="You can see these settings. Only an IT Admin, a Global Admin or someone with Full access to the Knowledge Base can change them." />
  );
}
