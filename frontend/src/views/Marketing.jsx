import MarketingApp from '../marketing/Marketing';

// The Marketing module is a 1:1 port of the standalone "Marketing Module Nexus"
// app (Google Ads / Reputation / Insights / SEO / Business Profile / Leads).
// It owns its own in-page tab bar, so the Nexus sidebar just opens it. The
// address-bar sub (/marketing/marketing-listings) only picks the tab it opens
// on - the Google sign-in comes back to Business Profile that way.
export default function Marketing({ activeSub }) {
  return <MarketingApp initialSub={activeSub} />;
}
