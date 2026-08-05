import PolicyDoc from './PolicyDoc';

// ⚠️ Drafted to match how Nexus is actually built and used (see PolicyGate.jsx,
// CLAUDE.md file-ownership/module rules). Have HR/legal review and finalize
// before treating this as the company's official terms - replace the contact
// address below with the real one.

const SECTIONS = [
  { h: '1. Acceptance', p: [
    'These Terms & Conditions govern your use of Nexus, Greens Global’s internal company portal. By signing in with your Microsoft work account, you agree to these Terms and to the Privacy Policy. If you do not agree, do not use Nexus and contact your manager or IT.',
  ]},
  { h: '2. Who can use Nexus', p: [
    'Nexus is provided for Greens Global employees, contractors, and authorized personnel for work purposes only. Access is tied to your Microsoft Entra ID work account; you may not share your access, session, or credentials with anyone else, and you must sign out or lock your device when stepping away from a session on a shared machine.',
  ]},
  { h: '3. Acceptable use', p: [
    'Nexus and the devices you use to access it are company property, provided for work. Use Nexus only for legitimate business purposes and in line with Greens Global’s policies. You agree not to:',
  ], list: [
    'Use Nexus for anything unlawful, fraudulent, or outside the scope of your role.',
    'Attempt to access data, modules, or accounts you are not authorized to use, or to circumvent role-based access controls.',
    'Upload content you do not have the right to upload, or that is unlawful, defamatory, or infringing.',
    'Interfere with or disrupt Nexus’s operation (e.g. attempting to overload, scrape, or reverse engineer the service).',
  ]},
  { h: '4. Employee monitoring', p: [
    'While you are clocked in through the Time Clock module on a company-managed device, Nexus may capture periodic screenshots, active application/window titles, and activity levels to verify worked time and support performance review, as described in the Privacy Policy and in the acknowledgment shown at sign-in. Continued use of the Time Clock feature constitutes agreement to that monitoring.',
  ]},
  { h: '5. Your content', p: [
    'You retain no separate ownership claim over work records, documents, photos, or other content you create or upload in Nexus in the course of your employment - it is Greens Global company data. You are responsible for the accuracy of information you enter (timesheets, checkouts, HR forms, etc.) and for having the right to upload any file you attach.',
  ]},
  { h: '6. Availability and changes', p: [
    'Nexus is provided "as is" and "as available." We aim for reliability but do not guarantee uninterrupted access - the service may be unavailable during maintenance, deployments, or outages. Features and modules may be added, changed, or removed at any time as the portal evolves.',
    'We may update these Terms from time to time. Material changes will be presented for re-acceptance at sign-in, the same way the initial acceptance works.',
  ]},
  { h: '7. Account and access termination', p: [
    'Your access to Nexus is tied to your employment or engagement with Greens Global. Access may be suspended or revoked at any time, including immediately upon end of employment, at management’s discretion, or if these Terms are violated. Company data and equipment tracked in Nexus (items, assets, documents) remain company property regardless of individual access.',
  ]},
  { h: '8. Limitation of liability', p: [
    'Nexus is an internal operational tool. To the extent permitted by law, Greens Global is not liable for indirect or incidental damages arising from use of, or inability to use, Nexus, beyond what is required by applicable employment law.',
  ]},
  { h: '9. Contact', p: [
    'Questions about these Terms can be sent to your manager, HR, IT, or to legal@greensglobal.com.',
  ]},
];

export default function TermsConditions({ embedded = false }) {
  return <PolicyDoc title="Terms & Conditions" updated="August 5, 2026" sections={SECTIONS} embedded={embedded} />;
}
