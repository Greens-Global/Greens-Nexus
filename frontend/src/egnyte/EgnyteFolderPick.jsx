// Modal folder picker - the folder browser in pick mode. Kept dumb: the parent
// decides what the picked path means (a wiring value, a person's folder, ...).
// Shared by the Wiring tab and the People-card folder actions.
//
// Two ways in (Visesh, Aug 10): browse down the tree, or PASTE - either a plain
// /Shared/... path or a full Egnyte link copied from the Egnyte web app's
// address bar (the ...#storage/files/1/... form). Pasting jumps the browser to
// that folder rather than accepting it blind, so a typo shows up as "could not
// open that folder" here instead of a silently mis-wired surface.
import { useState } from 'react';
import { ArrowRight, FolderSearch, X } from 'lucide-react';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import { BODY, CARD, HEADING } from './ui';

// A pasted value -> an Egnyte path. Handles the Egnyte web app's deep link
// (#storage/files/1/Shared/...) with percent-encoding, or a plain path.
function pathFromPaste(v) {
  const s = (v || '').trim();
  if (!s) return '';
  const m = s.match(/#storage\/files\/1(\/[^?]*)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return s;
}

export default function FolderPickModal({ startPath = '', title = 'Pick a Folder', hint = 'Browse to the folder, or paste its path, then press "Use This Folder".', onPick, onClose }) {
  const [start, setStart] = useState(startPath);
  const [pasted, setPasted] = useState('');

  const jump = (e) => {
    e?.preventDefault();
    const p = pathFromPaste(pasted);
    if (p) setStart(p);
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(15,18,24,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div style={{ ...CARD, width: 'min(860px, 100%)', maxHeight: '86vh', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ ...HEADING, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderSearch size={16} /> {title}
          </div>
          <button type="button" className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <X size={13} /> Close
          </button>
        </div>
        <div style={{ ...BODY, fontSize: 12.5 }}>{hint}</div>
        <form onSubmit={jump} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="form-input"
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            placeholder="Paste a folder path (/Shared/…) or an Egnyte link"
            style={{ flex: '1 1 320px', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
          />
          <button type="submit" className="secondary-btn" disabled={!pathFromPaste(pasted)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ArrowRight size={13} /> Go To Folder
          </button>
        </form>
        <EgnyteFolderBrowser initialPath={start} showUpload={false} onPick={onPick} />
      </div>
    </div>
  );
}
