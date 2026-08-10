// A person's wired Egnyte folder, as a drop-in panel for the HR person card.
//
// Resolution happens server-side through the wiring registry (slot
// people.person-folder): template -> real-folder name matching -> per-person
// override. This panel renders the outcome AND gives HR the two person-level
// acts as plain buttons - no Wiring tab, no placeholders (Visesh, Aug 10:
// "too hard for a normal HR user"):
//   - Create Folder: provisions the standard set (person folder + Contractor
//     Documents + Confidential) under the wired location.
//   - Choose Existing Folder: a visual picker; the choice is stored as this
//     person's override, and My Documents follows it automatically.
//
// HR-only by construction: the backend endpoints carry the hr module grant,
// and this folder includes the Confidential subfolder - the employee-facing
// counterpart (My HR) uses the separate people.my-documents wiring.
import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, FolderSearch, FolderX, HardDrive, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import FolderPickModal from './EgnyteFolderPick';
import { BODY, CARD, HEADING, Loading, Notice, OpenInEgnyte } from './ui';

export default function EgnytePersonFolder({ email, personName = '' }) {
  const { can } = useRole();
  // Mirrors require_level(2) on the Egnyte write routes.
  const canWrite = can('supervisor');
  const [state, setState] = useState({ loading: true });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setState({ loading: true });
    api.egnytePersonDocs(email)
      .then(d => setState({ loading: false, ...d }))
      .catch(err => setState({ loading: false, error: err?.message || 'Could not resolve the Egnyte folder.', status: err?.status }));
  }, [email]);
  useEffect(load, [load]);

  const provision = async () => {
    setBusy(true);
    setError('');
    try { setState({ loading: false, ...(await api.egnytePersonProvision(email)) }); }
    catch (e) { setError(e?.message || 'Could not create the folder.'); }
    finally { setBusy(false); }
  };

  const point = async (path) => {
    setPicking(false);
    if (!path) return;
    setBusy(true);
    setError('');
    try { setState({ loading: false, ...(await api.egnytePersonPoint(email, path)) }); }
    catch (e) { setError(e?.message || 'Could not save that folder.'); }
    finally { setBusy(false); }
  };

  if (state.loading) return <Loading label="Finding the Egnyte folder…" />;

  // 503 = Egnyte not connected on this environment - show nothing rather than
  // an error inside an HR card that is otherwise fine.
  if (state.status === 503) return null;

  if (state.error) {
    return (
      <div style={{ ...CARD, padding: 14 }}>
        <div style={{ ...BODY, fontSize: 12.5 }}>{state.error}</div>
      </div>
    );
  }

  const pickerModal = picking && (
    <FolderPickModal
      title={`Folder for ${personName || email}`}
      hint='Browse to the folder where this person&apos;s documents live - or paste its path or Egnyte link - then press "Use This Folder".'
      onPick={point}
      onClose={() => setPicking(false)}
    />
  );

  if (state.missing) {
    return (
      <div style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ ...HEADING, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderX size={16} /> No Egnyte Folder Yet
        </div>
        <div style={{ ...BODY, fontSize: 12.5 }}>
          {personName || email} has no documents folder in Egnyte yet. Create one in the standard
          location, or choose a folder that already exists.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" disabled={busy} onClick={provision} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <FolderPlus size={13} />} Create Folder
          </button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => setPicking(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FolderSearch size={13} /> Choose Existing Folder
          </button>
        </div>
        <div style={{ ...BODY, fontSize: 11.5, color: 'var(--wk-faint)' }}>
          Create Folder makes the person folder plus "Contractor Documents" and "Confidential" inside it.
        </div>
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
        {pickerModal}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...BODY, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <HardDrive size={13} style={{ flexShrink: 0 }} />
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.folder}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => setPicking(true)} title="Point this person at a different Egnyte folder" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FolderSearch size={13} /> Change
          </button>
          <OpenInEgnyte url={state.webUrl} label="Open in Egnyte" />
        </div>
      </div>
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
      <EgnyteFolderBrowser initialPath={state.folder} canWrite={canWrite} rootLabel={personName || 'Person folder'} />
      {pickerModal}
    </div>
  );
}
