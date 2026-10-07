// Legal (Neil, 10/06): the Privacy Policy and Terms & Conditions "have nothing
// to do with Support" - they were two cards on the Help Center. Now one page,
// opened from Legal in the profile menu, with the two documents as tabs.
// The public /privacy and /terms pages (login screen, sign-in policy links)
// are unchanged; this is the signed-in view of the same content.
import { FileSignature, Shield } from 'lucide-react';
import PrivacyPolicy from './PrivacyPolicy';
import TermsConditions from './TermsConditions';

export const LEGAL_TABS = [
  { key: 'privacy', label: 'Privacy Policy', Icon: Shield },
  { key: 'terms', label: 'Terms & Conditions', Icon: FileSignature },
];

export default function Legal({ activeSub, onSubChange }) {
  const tab = LEGAL_TABS.some((t) => t.key === activeSub) ? activeSub : 'privacy';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, fontFamily: 'Inter,sans-serif' }}>
      <div role="tablist" aria-label="Legal documents"
        style={{ display: 'inline-flex', alignSelf: 'flex-start', gap: 2, padding: 3, borderRadius: 9, background: 'var(--wk-hover, var(--mist))' }}>
        {LEGAL_TABS.map(({ key, label, Icon }) => {
          const on = tab === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={on} onClick={() => onSubChange?.(key)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                background: on ? 'var(--wk-card, var(--card))' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)',
                boxShadow: on ? '0 1px 3px rgba(29,33,57,.12)' : 'none' }}>
              <Icon size={14} /> {label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">
        {tab === 'privacy' ? <PrivacyPolicy embedded /> : <TermsConditions embedded />}
      </div>
    </div>
  );
}
