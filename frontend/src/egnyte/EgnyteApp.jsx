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
import { Building2, Cable, FolderOpen, Link2, Loader2, UserCheck } from 'lucide-react';
import { api } from '../api';
import ModuleTabs from '../components/ModuleTabs';
import { useRole } from '../contexts/RoleContext';
import { useEgnyteStatus } from './lib';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import EgnytePropertyDocs from './EgnytePropertyDocs';
import EgnyteWiring from './EgnyteWiring';
import { BODY, CARD, HEADING, Loading, NotConnected, Notice } from './ui';

// Per-user Egnyte connection strip (Aug 10: "anybody in here would only be
// able to see what they actually have access to"). When OAuth is configured on
// the server, a connected user browses AS THEMSELVES - Egnyte's own folder
// permissions decide what they see. Unconnected privileged users (supervisor+
// or an egnyte/hr grant) keep the shared company view until they connect;
// everyone else must connect before the browser shows anything.
function ConnectStrip({ oauth, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Coming back from Egnyte's consent screen - surface the outcome once.
  const [cbNote, setCbNote] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('egnyte');
    if (!r) return null;
    const reason = p.get('reason') || '';
    p.delete('egnyte'); p.delete('reason');
    const rest = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    return { r, reason };
  });

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const { url, error: err } = await api.egnyteOauthStart();
      if (url) { window.location.assign(url); return; }
      setError(err || 'Could not start the Egnyte connection.');
    } catch (e) { setError(e?.message || 'Could not start the Egnyte connection.'); }
    setBusy(false);
  };

  const disconnect = async () => {
    setBusy(true);
    try { await api.egnyteOauthDisconnect(); onChanged(); }
    catch (e) { setError(e?.message || 'Could not disconnect.'); }
    setBusy(false);
  };

  if (!oauth?.enabled) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {cbNote?.r === 'connected' && <Notice tone="success" onDismiss={() => setCbNote(null)}>Egnyte connected - you now browse with your own permissions.</Notice>}
      {cbNote?.r === 'denied' && <Notice tone="error" onDismiss={() => setCbNote(null)}>Egnyte connection was declined.</Notice>}
      {cbNote?.r === 'error' && <Notice tone="error" onDismiss={() => setCbNote(null)}>{cbNote.reason || 'Egnyte connection failed - try again.'}</Notice>}
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}

      {oauth.connected ? (
        <div style={{ ...CARD, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <UserCheck size={15} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
          <span style={{ ...BODY, fontSize: 12.5, flex: 1, minWidth: 0 }}>
            Browsing as <strong style={{ color: 'var(--wk-ink)' }}>{oauth.egnyteUsername || 'your Egnyte account'}</strong> - you see exactly what your Egnyte permissions allow.
          </span>
          <button type="button" className="secondary-btn" disabled={busy} onClick={disconnect} style={{ flexShrink: 0 }}>Disconnect</button>
        </div>
      ) : (
        <div style={{ ...CARD, padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link2 size={17} style={{ color: 'var(--wk-dim)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ ...HEADING, fontSize: 13.5 }}>Connect Your Egnyte Account</div>
            <div style={{ ...BODY, fontSize: 12.5 }}>
              {oauth.mustConnect
                ? 'Connect to browse files - you will see exactly the folders your Egnyte account has access to.'
                : 'You are browsing with the shared company access. Connect to browse as yourself, with your own Egnyte permissions.'}
            </div>
          </div>
          <button type="button" className="primary-btn" disabled={busy} onClick={connect} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Link2 size={13} />} Connect Egnyte
          </button>
        </div>
      )}
    </div>
  );
}

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
  const { loading, configured, error, oauth, recheck } = useEgnyteStatus();

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
      ) : sub === 'browse' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <ConnectStrip oauth={oauth} onChanged={recheck} />
          {oauth?.mustConnect
            ? null
            : <EgnyteFolderBrowser initialPath={browsePath} canWrite={canWrite} />}
        </div>
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
