// Save As Template (Oct 28 2026): a full-level user keeps a published
// workflow as a company template - a name (the workflow's by default) and
// a description, then POST /workflows/{id}/save-as-template. The copy
// shows up under Workflows > Templates for the company.
import { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { api } from '../../api';
import { Modal } from '../../tasks/components';
import { btn } from '../../tasks/theme';
import { fieldLabel, hint, textInput } from '../lib/text.builder-helpers';
import { errorText } from '../lib/errors';

export default function SaveTemplateDialog({ workflow, onClose, onSaved }) {
  const [name, setName] = useState(workflow?.name || '');
  const [description, setDescription] = useState(workflow?.description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = name.trim() !== (workflow?.name || '') || description.trim() !== (workflow?.description || '');

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Give the template a name.'); return; }
    setBusy(true); setError('');
    try {
      const t = await api.wfSaveAsTemplate(workflow.id, { name: trimmed, description: description.trim() });
      onSaved?.(t);
    } catch (e) {
      setError(errorText(e, 'The template could not be saved.'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Save As Template" onClose={onClose} isDirty={dirty} footer={(
      <>
        <button type="button" onClick={onClose} disabled={busy} style={btn('ghost')}>Cancel</button>
        <button type="button" onClick={save} disabled={busy || !name.trim()} style={{ ...btn('primary'), opacity: busy || !name.trim() ? 0.6 : 1 }}>
          <LayoutTemplate size={14} /> {busy ? 'Saving...' : 'Save Template'}
        </button>
      </>
    )}>
      <div className="nx-fill" style={{ gap: 12 }}>
        <div style={hint}>The published version is kept as a template for this company. Anyone who uses it starts a draft of their own; this workflow keeps running as it is.</div>
        <div>
          <label style={fieldLabel} htmlFor="wf-template-name">Name</label>
          <input id="wf-template-name" type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ ...textInput, maxWidth: 480 }} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        </div>
        <div className="nx-fill" style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={fieldLabel} htmlFor="wf-template-description">Description</label>
          <textarea id="wf-template-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this workflow does and who it is for"
            style={{ ...textInput, flex: 1, minHeight: 120, resize: 'vertical' }} />
        </div>
        {error && <div role="alert" style={{ ...hint, color: 'hsl(var(--color-red))' }}>{error}</div>}
      </div>
    </Modal>
  );
}
