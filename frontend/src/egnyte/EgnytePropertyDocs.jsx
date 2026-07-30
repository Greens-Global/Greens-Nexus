// Egnyte module - documents for one property.
//
// DROP-IN COMPONENT. This is self-contained on purpose so the Asset Management
// screen (PropertyAsset.jsx, Ankush's file) can mount it on a property card
// without this work touching that file:
//
//     import EgnytePropertyDocs from '../egnyte/EgnytePropertyDocs';
//     <EgnytePropertyDocs site={property.name} />
//
// It resolves its own folders, checks its own permissions and renders its own
// empty states, so the host only has to supply the site name.
//
// GET /egnyte/property/{site} answers with the resolved folder paths plus the
// plans listing in one call. `missing: true` is NOT an error: a property that
// has no Egnyte folder yet is the normal state for a new property, so the panel
// offers to create it rather than showing a failure.
import { useCallback, useEffect, useState } from 'react';
import { Building2, FolderPlus } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { downloadEgnyteFile, egnyteErrorMessage, isNotConnected } from './lib';
import EgnyteListing from './EgnyteList';
import EgnyteUpload from './EgnyteUpload';
import {
  BODY, CARD, ELLIPSIS, HEADING, Loading, NotConnected, Notice, OpenInEgnyte, ProblemNote,
} from './ui';

// onOpenFolder is optional: the module shell passes one so a subfolder opens in
// the Browse tab. A host that has no browser of its own (a property card) omits
// it and subfolders open in Egnyte instead, which is always a valid destination.
export default function EgnytePropertyDocs({ site, canWrite: canWriteProp, title = 'Property Documents', onOpenFolder }) {
  const { can } = useRole();
  // Writes are supervisor+ on the server (routers/egnyte.py require_level(2)).
  // Mirroring that here hides actions the user cannot complete; the server stays
  // the real boundary and a 403 is still handled if the two ever disagree.
  const canWrite = canWriteProp ?? can('supervisor');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConnected, setNotConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [rowError, setRowError] = useState('');

  const load = useCallback(() => {
    if (!site) { setData(null); setLoading(false); return; }
    setLoading(true);
    setError('');
    setNotConnected(false);
    api.egnyteProperty(site)
      .then(setData)
      .catch(err => {
        setData(null);
        setNotConnected(isNotConnected(err));
        setError(egnyteErrorMessage(err, 'Could not load documents for this property.'));
      })
      .finally(() => setLoading(false));
  }, [site]);

  useEffect(() => { load(); }, [load]);

  const createFolder = async () => {
    if (!data?.plansFolder) return;
    setCreating(true);
    setRowError('');
    try {
      // Parent first, then the plans subfolder. Creating the leaf alone works on
      // most Egnyte tenants, but not all create intermediate folders, and the
      // endpoint is idempotent, so doing both is free and always correct.
      if (data.folder) await api.egnyteCreateFolder(data.folder);
      await api.egnyteCreateFolder(data.plansFolder);
      load();
    } catch (err) {
      setRowError(egnyteErrorMessage(err, 'Could not create the Egnyte folder.'));
    } finally {
      setCreating(false);
    }
  };

  const download = async (file) => {
    setDownloading(file.path);
    setRowError('');
    try {
      await downloadEgnyteFile(file.path, file.name);
    } catch (err) {
      setRowError(egnyteErrorMessage(err, `Could not download ${file.name}.`));
    } finally {
      setDownloading('');
    }
  };

  if (!site) {
    return (
      <div style={{ ...CARD, padding: '22px 18px' }}>
        <div style={BODY}>Pick a property to see its Egnyte documents.</div>
      </div>
    );
  }
  if (notConnected) return <NotConnected compact />;

  return (
    <div style={{ ...CARD, padding: 14, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
        <Building2 size={16} style={{ color: 'var(--wk-brand)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...HEADING, fontSize: 14.5, ...ELLIPSIS }}>{title}</div>
          <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)', ...ELLIPSIS }}>
            {data?.plansFolder || site}
          </div>
        </div>
        <OpenInEgnyte url={data?.webUrl} label="Open Property Folder" />
      </div>

      {rowError && <Notice tone="error" onDismiss={() => setRowError('')}>{rowError}</Notice>}

      {loading ? (
        <Loading label="Loading documents…" />
      ) : error ? (
        <ProblemNote message={error} onRetry={load} />
      ) : data?.missing ? (
        <div style={{ padding: '22px 12px', textAlign: 'center' }}>
          <div style={{ ...HEADING, fontSize: 14, marginBottom: 6 }}>No Egnyte Folder Yet</div>
          <div style={{ ...BODY, maxWidth: 400, margin: '0 auto' }}>
            This property has no folder in Egnyte so far, which is normal for a new one.
            Creating it sets up the plans folder at the standard location, and uploads from
            here will land in it.
          </div>
          <div style={{ ...BODY, fontSize: 11.5, marginTop: 8, color: 'var(--wk-faint)', wordBreak: 'break-word' }}>
            {data.plansFolder}
          </div>
          {canWrite ? (
            <button type="button" className="primary-btn" disabled={creating} onClick={createFolder}
              style={{ marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FolderPlus size={14} /> {creating ? 'Creating…' : 'Create Folder'}
            </button>
          ) : (
            <div style={{ ...BODY, fontSize: 12, marginTop: 12, color: 'var(--wk-faint)' }}>
              Ask a supervisor to create it.
            </div>
          )}
        </div>
      ) : (
        <>
          <EgnyteUpload folder={data?.plansFolder} canWrite={canWrite} onUploaded={load} compact />
          <div style={{ border: '1px solid var(--wk-line2)', borderRadius: 'var(--wk-r)', padding: 4, minWidth: 0 }}>
            <EgnyteListing
              folders={data?.plans?.folders || []}
              files={data?.plans?.files || []}
              onOpenFolder={(p, url) => {
                if (onOpenFolder) onOpenFolder(p);
                else if (url) window.open(url, '_blank', 'noopener');
              }}
              onDownload={download}
              downloadingPath={downloading}
              emptyLabel="No plans in Egnyte for this property yet."
              emptyHint={canWrite ? 'Drop a file above to add the first one.' : undefined}
            />
          </div>
          <OpenInEgnyte url={data?.plansWebUrl} label="Open Plans Folder in Egnyte" />
        </>
      )}
    </div>
  );
}
