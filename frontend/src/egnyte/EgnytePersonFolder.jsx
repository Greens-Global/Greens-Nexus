// A person's wired Egnyte folder, as a drop-in panel for the HR person card.
//
// Resolution happens server-side through the wiring registry (slot
// people.person-folder): template -> real-folder name matching -> per-person
// override. This panel just renders the outcome: the folder browser pinned to
// the person's folder, or an explained empty state when nothing is wired yet.
//
// HR-only by construction: the backend endpoint carries the hr module grant,
// and this folder includes the Confidential subfolder - the employee-facing
// counterpart (My HR) uses the separate people.my-documents wiring.
import { useEffect, useState } from 'react';
import { FolderX, HardDrive } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import { BODY, CARD, HEADING, Loading, OpenInEgnyte } from './ui';

export default function EgnytePersonFolder({ email, personName = '' }) {
  const { can } = useRole();
  // Mirrors require_level(2) on the Egnyte write routes.
  const canWrite = can('supervisor');
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let gone = false;
    setState({ loading: true });
    api.egnytePersonDocs(email)
      .then(d => { if (!gone) setState({ loading: false, ...d }); })
      .catch(err => { if (!gone) setState({ loading: false, error: err?.message || 'Could not resolve the Egnyte folder.', status: err?.status }); });
    return () => { gone = true; };
  }, [email]);

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

  if (state.missing) {
    return (
      <div style={{ ...CARD, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ ...HEADING, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderX size={16} /> No Egnyte Folder Yet
        </div>
        <div style={{ ...BODY, fontSize: 12.5 }}>
          Nothing in Egnyte matches {personName || email} under the wired location
          {state.proposed ? <> (looked for <code style={{ fontSize: 11.5 }}>{state.proposed}</code>)</> : null}.
          Create the folder in Egnyte, or point this person at an existing folder from
          Egnyte&nbsp;- Wiring&nbsp;- "Person folder" overrides.
        </div>
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
        <OpenInEgnyte url={state.webUrl} label="Open in Egnyte" />
      </div>
      <EgnyteFolderBrowser initialPath={state.folder} canWrite={canWrite} rootLabel={personName || 'Person folder'} />
    </div>
  );
}
