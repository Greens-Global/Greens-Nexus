// Asset Management view — now the faithful port of Neil's template (AssetModule).
// Kept as a thin wrapper so the App.jsx route (property-asset) stays unchanged.
import AssetModule from './AssetModule';

export default function PropertyAsset() {
  return <AssetModule />;
}
