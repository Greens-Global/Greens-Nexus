// Egnyte module shell.
//
// Owner goal (Neil): "they can upload and pull directly and at the right folder
// level." Egnyte is the source of truth - Nexus lists, reads, writes and links,
// and never keeps a second copy.
//
// Two surfaces: a general folder browser, and a property-scoped view that jumps
// straight to a site's plans folder. Both are the same underlying pieces, so a
// file row behaves identically wherever it appears.
//
// Everything is gated on GET /egnyte/status first. That endpoint answers 200
// even when Egnyte is unconfigured, precisely so this screen can render an
// explained empty state instead of a wall of failed requests.
import { useState } from 'react';
import { Building2, Cable, FolderOpen } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import { useRole } from '../contexts/RoleContext';
import { useEgnyteStatus } from './lib';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import EgnytePropertyDocs from './EgnytePropertyDocs';
import EgnyteWiring from './EgnyteWiring';
import { BODY, CARD, HEADING, Loading, NotConnected } from './ui';

const TABS = [
  { key: 'browse',   label: 'Browse Files',       Icon: FolderOpen },
  { key: 'property', label: 'Property Documents', Icon: Building2 },
  // Manager+ only (mirrors require_manager on /egnyte/wiring) - filtered below.
  { key: 'wiring',   label: 'Wiring',             Icon: Cable, minRole: 'manager' },
];

export default function EgnyteApp({ activeSub, onSubChange }) {
  const { can } = useRole();
  // Mirrors require_level(2) on the write routes in routers/egnyte.py.
  const canWrite = can('supervisor');
  const { loading, configured, error, recheck } = useEgnyteStatus();

  const tabs = TABS.filter(t => !t.minRole || can(t.minRole));
  const sub = tabs.some(t => t.key === activeSub) ? activeSub : 'browse';
  const [site, setSite] = useState('');
  const [submittedSite, setSubmittedSite] = useState('');
  // Set when a property subfolder is opened from the property tab, so the Browse
  // tab lands there instead of at the root.
  const [browsePath, setBrowsePath] = useState('');

  const goTo = (key) => (onSubChange ? onSubChange(key) : undefined);

  const openInBrowser = (path) => { setBrowsePath(path); goTo('browse'); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <ModuleTabs tabs={tabs} active={sub} onChange={goTo} />

      {loading ? (
        <Loading label="Checking the Egnyte connection…" />
      ) : !configured ? (
        <NotConnected error={error} onRetry={recheck} />
      ) : sub === 'wiring' ? (
        <EgnyteWiring />
      ) : sub === 'property' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ ...CARD, padding: 14 }}>
            <div style={{ ...HEADING, fontSize: 14.5, marginBottom: 4 }}>Property Documents</div>
            <div style={{ ...BODY, fontSize: 12.5, marginBottom: 10 }}>
              Enter a site name to open its plans folder in Egnyte. If the property has no
              folder yet, you can create one from here.
            </div>
            <form
              onSubmit={e => { e.preventDefault(); setSubmittedSite(site.trim()); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <input
                className="form-input"
                value={site}
                onChange={e => setSite(e.target.value)}
                placeholder="Site name, for example Temecula"
                style={{ flex: '1 1 220px', minWidth: 0 }}
              />
              <button type="submit" className="primary-btn" disabled={!site.trim()}>Open Property</button>
            </form>
          </div>
          {submittedSite
            ? <EgnytePropertyDocs site={submittedSite} title={submittedSite} canWrite={canWrite} onOpenFolder={openInBrowser} />
            : null}
        </div>
      ) : (
        <EgnyteFolderBrowser initialPath={browsePath} canWrite={canWrite} />
      )}
    </div>
  );
}
