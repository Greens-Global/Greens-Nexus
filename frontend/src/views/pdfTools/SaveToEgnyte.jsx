// Save To Egnyte: choose a folder, keep or change the name. A file of that name in
// the folder is a question, asked when Save is pressed against a fresh listing:
// replace it (Egnyte adds a new version) or use a new name. A failed save stays
// here with the document still open behind it.
import { useState } from 'react';
import { api } from '../../api';
import EgnyteBrowser from '../../components/EgnyteBrowser';
import { Spinner } from '../../components/AsyncState';
import { normPath } from '../../egnyte/lib';
import { freeFileName, isPdfName, pdfFileName } from '../../lib/pdfToolsHandoff';
import { browseProblem, saveProblem } from './words';

const RULE = (color) => ({ borderLeft: `3px solid ${color}`, padding: '6px 0 6px 10px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink)' });
const AMBER = 'hsl(30,80%,48%)';
const RED = 'hsl(var(--color-red))';

export default function SaveToEgnyte({ defaultName, startPath, redacted, onSave, onClose }) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);   // { folder, name, suggestion }
  const finalName = pdfFileName(name);

  const close = () => { if (!busy) onClose(); };

  const write = async (folder, fileName) => {
    setBusy('saving');
    setError('');
    setConflict(null);
    try {
      await onSave(folder, fileName);
      onClose();
    } catch (err) {
      setError(saveProblem(err));
      setBusy('');
    }
  };

  const save = async (folder) => {
    setBusy('checking');
    setError('');
    setConflict(null);
    let taken;
    try {
      taken = ((await api.egnyteFolder(folder))?.files || []).map((f) => f.name);
    } catch (err) {
      // Never write blind: an unseen file of this name would gain a version unasked.
      setError(browseProblem(err));
      setBusy('');
      return;
    }
    const existing = taken.find((n) => String(n).toLowerCase() === finalName.toLowerCase());
    if (existing) {
      setConflict({ folder, name: existing, suggestion: freeFileName(finalName, taken) });
      setBusy('');
      return;
    }
    await write(folder, finalName);
  };

  const footer = ({ path, loading }) => {
    const folder = normPath(path);
    const asked = conflict && conflict.folder === folder ? conflict : null;
    return (
      <div style={{ borderTop: '1px solid var(--line)', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {redacted && (
          <div style={RULE(AMBER)}>
            This file has redactions. Egnyte keeps earlier versions, so replacing a file leaves the unredacted original in
            its version history. Use a new name, or remove the original in Egnyte.
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
          File Name
          <input className="form-input" data-nx-noguard="1" value={name} disabled={!!busy}
            onChange={(e) => { setName(e.target.value); setConflict(null); setError(''); }} style={{ width: '100%' }} />
        </label>
        {finalName !== name && name.trim() && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Will be saved as {finalName}</div>
        )}
        {asked && (
          <div style={RULE(AMBER)} role="alert">
            <div>{asked.name} is already in this folder.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <button type="button" className="secondary-btn" disabled={!!busy} onClick={() => write(folder, asked.name)}>Replace (Adds New Version)</button>
              <button type="button" className="secondary-btn" disabled={!!busy}
                onClick={() => { setName(asked.suggestion); setConflict(null); }}>Use A New Name</button>
            </div>
          </div>
        )}
        {error && <div style={RULE(RED)} role="alert">{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {!folder && !loading && <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>Choose a folder to save in.</span>}
          <button type="button" className="secondary-btn" disabled={!!busy} onClick={close}>Cancel</button>
          <button type="button" className="primary-btn" disabled={!!busy || !folder || loading || !!asked}
            onClick={() => save(folder)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy && <Spinner size={13} />}
            {busy === 'saving' ? 'Saving...' : busy === 'checking' ? 'Checking...' : 'Save In This Folder'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <EgnyteBrowser title="Save To Egnyte" browse={api.egnyteFolder} startPath={startPath} onClose={close}
      canPick={(f) => isPdfName(f.name)} pickHint="Only PDFs are shown as choices here" describeError={browseProblem}
      onFileClick={(f) => { setName(f.name); setConflict(null); setError(''); }} footer={footer} />
  );
}
