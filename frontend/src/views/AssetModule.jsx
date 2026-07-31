// Asset Management module - the dev-team source, ported into Nexus.
//
// The full module lives under frontend/src/asset/ (App.jsx + components/ + lib/), copied from
// the DEV-TEAM-SOURCE handoff. It is mounted here inside Nexus's shell. Two integration seams:
//   • Data  - asset/lib/sync.js's serverGet/serverPut delegate to Nexus's api.js
//             (GET/PUT /property-assets/workspace, MSAL-authenticated; identical workspace shape).
//   • Auth  - asset/lib/session.js maps Nexus RoleContext -> the module's { can, level, role }.
//
// All of the module's styling is scoped under `.nexus-asset-root` (asset-styles.scoped.css) so
// the ported stylesheet can never leak into the rest of Nexus (it shares class names like
// .card / .form-input / .header-*). Keep this wrapper thin - feature work goes in asset/.
import '../asset/asset-styles.scoped.css';
import AssetApp from '../asset/App.jsx';

export default function AssetModule() {
  return (
    <div className="nexus-asset-root">
      <AssetApp />
    </div>
  );
}
