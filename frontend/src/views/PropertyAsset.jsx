// Asset Management view - now the faithful port of Neil's template (AssetModule).
// Kept as a thin wrapper so the App.jsx route (property-asset) stays unchanged.
import AssetModule from './AssetModule';

// activeSub carries a deep link from a ticket bell or email ("tickets:<propertyId>[:<ticketId>]").
export default function PropertyAsset({ activeSub = null, onSubChange = null }) {
  return <AssetModule activeSub={activeSub} onSubChange={onSubChange} />;
}
