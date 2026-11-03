import PolicyDoc from './PolicyDoc';

// Drafted to match how Nexus is actually built and used (see PolicyGate.jsx).
// A draft for counsel review, not legal advice: have counsel finalize it
// before treating it as the organization's official terms. White-label (Nov
// 2026): the text names "your organization", never a company, and points to
// the HR team for contact - no hard-coded address.

export const TERMS_SECTIONS = [
  { h: '1. Acceptance', p: [
    'These Terms & Conditions govern your use of Nexus, the internal portal your organization (your employer or the organization that engaged you) provides for its people. By signing in with your work account, you agree to these Terms and to the Privacy Policy. If you do not agree, do not use Nexus and contact your manager or IT.',
  ]},
  { h: '2. Who can use Nexus', p: [
    'Nexus is provided for your organization’s employees, contractors, and authorized personnel for work purposes only. Access is tied to your work account (Microsoft Entra ID, or an invitation sign-in for external users); you may not share your access, session, or credentials with anyone else, and you must sign out or lock your device when stepping away from a session on a shared machine.',
  ]},
  { h: '3. Acceptable use', p: [
    'Nexus and the devices you use to access it are company property, provided for work. Use Nexus only for legitimate business purposes and in line with your organization’s policies. You agree not to:',
  ], list: [
    'Use Nexus for anything unlawful, fraudulent, or outside the scope of your role.',
    'Attempt to access data, modules, or accounts you are not authorized to use, or to circumvent role-based access controls.',
    'Upload content you do not have the right to upload, or that is unlawful, defamatory, or infringing.',
    'Interfere with or disrupt Nexus’s operation (e.g. attempting to overload, scrape, or reverse engineer the service).',
  ]},
  { h: '4. Employee monitoring', p: [
    'Where your organization uses them, Nexus records your time punches (with the location your device reports when you punch, if the punch asks for it) and, while you are clocked in on a company-managed device running the desktop agent, periodic screenshots, active application and window titles, and activity levels, to verify worked time and support performance review, as described in the Privacy Policy and in the acknowledgment shown at sign-in. Continued use of the Time Clock feature constitutes agreement to that monitoring.',
  ]},
  { h: '5. Your content', p: [
    'You retain no separate ownership claim over work records, documents, photos, or other content you create or upload in Nexus in the course of your work - it is your organization’s data. You are responsible for the accuracy of information you enter (time sheets, checkouts, HR forms, etc.) and for having the right to upload any file you attach.',
  ]},
  { h: '6. Availability and changes', p: [
    'Nexus is provided "as is" and "as available." We aim for reliability but do not guarantee uninterrupted access - the service may be unavailable during maintenance, deployments, or outages. Features and modules may be added, changed, or removed at any time as the portal evolves.',
    'We may update these Terms from time to time. Material changes will be presented for re-acceptance at sign-in, the same way the initial acceptance works.',
  ]},
  { h: '7. Account and access termination', p: [
    'Your access to Nexus is tied to your employment or engagement with your organization. Access may be suspended or revoked at any time, including immediately upon end of employment, at management’s discretion, or if these Terms are violated. Company data and equipment tracked in Nexus (items, assets, documents) remain company property regardless of individual access.',
  ]},
  { h: '8. Limitation of liability', p: [
    'Nexus is an internal operational tool. To the extent permitted by law, your organization is not liable for indirect or incidental damages arising from use of, or inability to use, Nexus, beyond what is required by applicable employment law.',
  ]},
  { h: '9. Contact', p: [
    'Questions about these Terms can be sent to your manager, your HR team, or IT.',
  ]},
];

export const TERMS_UPDATED = '11/02/2026';

export default function TermsConditions({ embedded = false }) {
  return <PolicyDoc title="Terms & Conditions" updated={TERMS_UPDATED} sections={TERMS_SECTIONS} embedded={embedded} />;
}
