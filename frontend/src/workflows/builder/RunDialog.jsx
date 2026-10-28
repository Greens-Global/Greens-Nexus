// Run (Oct 2026): a manual workflow runs on one record someone picks. A
// workflow about people gets the Nexus People picker; other kinds take the
// record's id (there is no cross-module record search yet).
import { useState } from 'react';
import { Play } from 'lucide-react';
import { api } from '../../api';
import { Modal, PersonSelect } from '../../tasks/components';
import { btn } from '../../tasks/theme';
import { fieldLabel, hint, textInput } from '../lib/text.builder-helpers';
import { errorText } from '../lib/errors';

const PERSON_ENTITIES = new Set(['employee', 'person', 'people']);

export default function RunDialog({ workflow, entityDef, people, onClose, go }) {
  const [subjectId, setSubjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isPerson = PERSON_ENTITIES.has(entityDef?.key) || (entityDef?.fields || []).some((f) => f.key === 'email' && f.type === 'person');
  const label = entityDef?.label || 'record';

  const run = async () => {
    if (!subjectId.trim()) return;
    setBusy(true); setError('');
    try {
      const r = await api.wfRun(workflow.id, { subjectId: subjectId.trim() });
      const runId = r?.id || r?.runId;
      onClose();
      if (runId) go(`run:${runId}`);
    } catch (e) {
      setError(errorText(e, 'The run could not start.'));
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Run ${workflow.name || 'Workflow'}`} onClose={onClose} footer={(
      <>
        <button type="button" onClick={onClose} style={btn('ghost')}>Cancel</button>
        <button type="button" onClick={run} disabled={busy || !subjectId.trim()} style={{ ...btn('primary'), opacity: busy || !subjectId.trim() ? 0.6 : 1 }}>
          <Play size={14} /> {busy ? 'Starting...' : 'Run Now'}
        </button>
      </>
    )}>
      <div className="nx-fill" style={{ gap: 12 }}>
        <div style={hint}>Every step runs for real on the {label.toLowerCase()} you choose, as the workflow's owner.</div>
        <div>
          <label style={fieldLabel} htmlFor="wf-run-subject">{isPerson ? 'Person' : `${label} Id`}</label>
          {isPerson
            ? <PersonSelect id="wf-run-subject" value={subjectId} onChange={(v) => setSubjectId(v || '')} people={people} allowNone={false} placeholder="Choose a person" ariaLabel="Person" autoFocus />
            : (
              <>
                <input id="wf-run-subject" type="text" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder={`Paste the ${label.toLowerCase()} id`} style={{ ...textInput, maxWidth: 420 }} autoFocus />
                <div style={{ ...hint, marginTop: 4 }}>Open the {label.toLowerCase()} in its module and copy the id from its link.</div>
              </>
            )}
        </div>
        {error && <div style={{ ...hint, color: 'hsl(var(--color-red))' }}>{error}</div>}
      </div>
    </Modal>
  );
}
