// The tier mark (Neil, 11/02/2026): one small icon after a person's name
// that tells a Super Administrator, an Administrator and a Manager apart
// wherever names appear - the phone menu, the profile card, the hover card,
// the Contact Directory, the org charts, People, the Act As finder. Never a
// chip, never the tier word as text: the word is the tooltip and the
// accessible name. Employees and supervisors carry nothing. The tier itself
// comes from the server (`tier` on every people payload, auth.tier_of) or,
// for the signed-in person, useRole().myTier.
//
// Only views/RolesAccess.jsx's TierBadge still spells the tier out - it IS
// the tier screen.
import { Shield, ShieldCheck, Users } from 'lucide-react';

export const TIER_WORDS = { super: 'Super Administrator', admin: 'Administrator', manager: 'Manager' };

const LOOK = {
  super:   { Icon: ShieldCheck, color: 'var(--wk-brand)', fill: 'color-mix(in srgb, var(--wk-brand) 18%, transparent)' },
  admin:   { Icon: Shield,      color: '#64748b',         fill: 'none' },
  manager: { Icon: Users,       color: 'var(--muted)',    fill: 'none' },
};

export default function TierMark({ tier, size = 14, title }) {
  const look = LOOK[tier];
  if (!look) return null;
  const word = title || TIER_WORDS[tier];
  const px = tier === 'manager' ? Math.round(size * 0.9) : size;
  return (
    <span role="img" aria-label={word} title={word} data-tier={tier}
      style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', marginLeft: 5, lineHeight: 0, flexShrink: 0 }}>
      <look.Icon size={px} aria-hidden="true" focusable="false" strokeWidth={tier === 'super' ? 2.1 : 1.9}
        style={{ color: look.color, fill: look.fill, display: 'block' }} />
    </span>
  );
}
