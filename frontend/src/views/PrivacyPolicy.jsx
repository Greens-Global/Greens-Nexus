import PolicyDoc from './PolicyDoc';

// ⚠️ Drafted to match what Nexus actually does today (see PolicyGate.jsx,
// backend/routers/policy.py, and the modules listed in CLAUDE.md). Have HR/
// legal review and finalize before treating this as the company's official
// policy - replace the contact address below with the real one.

const SECTIONS = [
  { h: '1. What this covers', p: [
    'Nexus is Greens Global’s internal company portal, used by employees, managers, and administrators for tasks, time tracking, HR, items and assets, documents, and related company operations. This policy explains what information Nexus collects about you, how it is used, and who can see it.',
    'It applies to your use of Nexus on company-managed devices and personal devices where you have signed in with your work account. It does not cover other Greens Global systems (e.g. Microsoft 365, Asana) beyond the data those systems exchange with Nexus.',
  ]},
  { h: '2. Information we collect', p: [
    'Account and identity: your name, work email, job title, and role, from Microsoft Entra ID (Azure AD) single sign-on. Nexus never sees or stores your Microsoft password.',
    'Work records you or others enter: HR records (attendance, leave, timesheets, documents), task and project data (including data synced with Asana), item and asset checkouts/assignments, uploaded photos and documents, tickets, and similar operational records tied to your account.',
  ], list: [
    'Time-clock and monitoring data - see Section 3, this is limited and disclosed separately at sign-in.',
    'Technical data: IP address, browser/user-agent, and timestamps, recorded for security and audit purposes (e.g. login events, e-signature audit trails, policy acknowledgments).',
    'Content you upload: photos and documents you attach to checkouts, assignments, or HR records, stored in Supabase storage.',
  ]},
  { h: '3. Employee monitoring while clocked in', p: [
    'On company-managed devices, while you are clocked in through Nexus’s Time Clock, Nexus may capture periodic screenshots of your work screen(s), record which applications and window titles are active, and measure your overall activity level. This is used to verify worked time and support performance review.',
    'This monitoring does NOT capture your keystrokes, and it stops the moment you clock out. It never runs on a personal device unless you have explicitly shared your screen. You are shown and must acknowledge this disclosure at sign-in and again whenever it changes (tracked and versioned - see your Profile for your acceptance history).',
  ]},
  { h: '4. How we use your information', p: ['We use the information above to:'], list: [
    'Operate Nexus’s modules - tasks, tickets, time tracking, HR, item/asset management, documents, and reporting.',
    'Verify worked time, run payroll, and support performance review.',
    'Keep the company’s equipment, assets, and property records accurate and auditable.',
    'Secure the portal - detect misuse, investigate incidents, and maintain audit trails (e-signatures, policy acceptances, login activity).',
    'Send you in-app notifications and, where applicable, email notifications about items assigned to you, approvals, or requests awaiting your action.',
  ]},
  { h: '5. Who can see it', p: [
    'Access inside Nexus is role-based: your own records are visible to you, your manager, and HR/administrators as appropriate to their role. Monitoring data specifically (Section 3) is visible to your manager and HR for time-verification, performance, and payroll purposes only.',
    'We do not sell your data. We do not share it outside Greens Global except with the service providers below, who process it on our behalf and only as needed to run Nexus:',
  ], list: [
    'Microsoft (Entra ID) - authentication and identity.',
    'Supabase - database and file storage that backs Nexus.',
    'Asana - two-way sync for tasks/projects you or your team use there.',
    'Cloudflare / Microsoft Azure - hosting for the Nexus web app and API.',
  ]},
  { h: '6. Data retention', p: [
    'Work records are retained for as long as your account is active and as required by Greens Global’s records-retention practices and applicable law (e.g. payroll and HR records). Monitoring screenshots and activity data are retained only as long as needed for time-verification and performance review, then deleted on a rolling basis.',
  ]},
  { h: '7. Security', p: [
    'Access to Nexus requires your Microsoft work account (single sign-on); Nexus does not maintain a separate password. Data in the underlying database is protected with row-level security so that only the backend service and authorized roles can read it. Uploaded files are stored in access-controlled cloud storage.',
  ]},
  { h: '8. Your rights', p: [
    'You can review the policy versions you’ve accepted from your Profile at any time. To review, correct, or ask questions about the personal data Nexus holds about you, contact your manager, HR, or IT.',
  ]},
  { h: '9. Changes to this policy', p: [
    'If we make a material change to this policy or to the monitoring disclosure in Section 3, you will be asked to review and re-accept it the next time you sign in, the same way you did the first time.',
  ]},
  { h: '10. Contact', p: [
    'Questions about this policy or your data can be sent to your HR or IT team, or to privacy@greensglobal.com.',
  ]},
];

export default function PrivacyPolicy({ embedded = false }) {
  return <PolicyDoc title="Privacy Policy" updated="August 5, 2026" sections={SECTIONS} embedded={embedded} />;
}
