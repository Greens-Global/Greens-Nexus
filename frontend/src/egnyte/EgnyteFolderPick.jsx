// Modal folder picker - the folder browser in pick mode. Kept dumb: the parent
// decides what the picked path means (a wiring value, a person's folder, ...).
// Shared by the Wiring tab and the People-card folder actions.
import { FolderSearch, X } from 'lucide-react';
import EgnyteFolderBrowser from './EgnyteFolderBrowser';
import { BODY, CARD, HEADING } from './ui';

export default function FolderPickModal({ startPath = '', title = 'Pick a Folder', hint = 'Browse to the folder, then press "Use This Folder".', onPick, onClose }) {
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
        <EgnyteFolderBrowser initialPath={startPath} showUpload={false} onPick={onPick} />
      </div>
    </div>
  );
}
