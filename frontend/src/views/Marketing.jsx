import MarketingApp from '../marketing/Marketing';

// The Marketing module is a 1:1 port of the standalone "Marketing Module Nexus"
// app (Google Ads / Reputation / Insights / SEO / Business Profile / Leads).
// It owns its own in-page tab bar, so the Nexus sidebar just opens it — the
// activeSub/onSubChange props are accepted for interface compatibility but the
// module drives its own navigation.
export default function Marketing() {
  return <MarketingApp />;
}
