// Share to Nexus - the sheet the installed app opens when something was
// shared into it from the phone's share sheet (lib/shareTarget.js; the
// manifest's share_target, answered by public/sw.js).
//
// It lists what came - the words, the files (a thumbnail for a picture) - and
// offers the three places it can go: New Ticket, New Task, New Note. Each is
// the Quick Action of that name, for the people the bolt offers it to
// (lib/quickCreate.js visibleActions - the one visibility rule), and opens
// that module's OWN form through the bolt (runQuickAction), filled in:
//   New Ticket, New Task - the words, and the files in the form's own
//                          attachment list (its save uploads them);
//   New Note             - the words only, at the end of today's Quick Note.
// Nothing is uploaded from here, and nothing is a form of its own. What was
// shared is removed from the browser the moment a place is picked or the
// sheet is closed.
import { useEffect, useState } from 'react';
import { FileText, ChevronRight } from 'lucide-react';
import { Modal } from '../tasks/components';
import { NX, btn } from '../tasks/theme';
import { FS } from '../lib/typeScale';
import { useRole } from '../contexts/RoleContext';
import { SkeletonBlocks } from './AsyncState';
import { visibleActions, runQuickAction } from '../lib/quickCreate';
import { readShare, clearShare, shareSeed, carryLine, SHARE_ACTIONS } from '../lib/shareTarget';

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const sectionLabel = { fontSize: FS.label, fontWeight: 700, color: NX.dim, margin: '0 0 8px' };

export default function ShareToNexus({ onClose }) {
  const role = useRole() || {};
  const [state, setState] = useState({ loading: true, shared: null, thumbs: [] });
  useEffect(() => {
    let alive = true;
    let urls = [];
    readShare().then((shared) => {
      if (!alive) return;
      // Pictures show from the phone itself (blob: URLs, allowed by the CSP).
      urls = (shared?.files || []).map((f) => ((f.type || '').startsWith('image/') ? URL.createObjectURL(f) : ''));
      setState({ loading: false, shared, thumbs: urls });
    });
    return () => { alive = false; urls.forEach((u) => { if (u) URL.revokeObjectURL(u); }); };
  }, []);
  const { loading, shared, thumbs } = state;

  const mine = visibleActions(role);
  const choices = SHARE_ACTIONS.map((key) => mine.find((it) => it.key === key)).filter(Boolean);

  const dismiss = () => { clearShare(); onClose(); };
  const start = (it) => {
    const seed = shareSeed(it.key, shared);
    clearShare();
    onClose();
    runQuickAction(it.key, seed);
  };

  const files = shared?.files || [];
  const words = [shared?.title, shared?.text, shared?.url && !(shared?.text || '').includes(shared.url) ? shared.url : ''].filter(Boolean);

  return (
    <Modal title="Share to Nexus" onClose={dismiss}
      footer={(close) => <button type="button" style={btn('outline')} onClick={() => close()}>Not Now</button>}>
      <div className="nx-fill" style={{ overflowY: 'auto', gap: 10 }}>
        <p style={sectionLabel}>What You Shared</p>
        {loading && <SkeletonBlocks count={2} height={56} />}
        {!loading && !shared && (
          <div style={{ fontSize: FS.body, color: NX.dim, lineHeight: 1.5 }}>
            <strong style={{ display: 'block', color: NX.ink, marginBottom: 4 }}>Nothing Came Through</strong>
            Nexus could not pick up what you shared. You can still start below and add it from your phone.
          </div>
        )}
        {words.length > 0 && (
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 10, padding: '10px 12px', fontSize: FS.body, color: NX.ink, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflowY: 'auto' }}>
            {words.map((w, i) => <div key={i} style={i === 0 && shared.title ? { fontWeight: 700 } : undefined}>{w}</div>)}
          </div>
        )}
        {files.map((f, i) => (
          <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${NX.border}`, borderRadius: 10, padding: 8 }}>
            {thumbs[i]
              ? <img src={thumbs[i]} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
              : <span aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 6, background: NX.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: NX.dim, flexShrink: 0 }}><FileText size={20} /></span>}
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: FS.body, color: NX.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ fontSize: FS.label, color: NX.dim }}>{sizeText(f.size)}</span>
            </span>
          </div>
        ))}
        {shared?.skipped > 0 && (
          <div style={{ fontSize: FS.label, color: NX.dim, lineHeight: 1.5 }}>
            {plural(shared.skipped, 'file')} could not be brought in (too many, or too large). Add {shared.skipped === 1 ? 'it' : 'them'} from your phone after you start.
          </div>
        )}
      </div>

      {!loading && (
        <div style={{ marginTop: 16, flexShrink: 0 }}>
          <p style={sectionLabel}>Start With It</p>
          {choices.length === 0 && (
            <div style={{ fontSize: FS.body, color: NX.dim, lineHeight: 1.5 }}>
              You do not have Tickets, Tasks or Notes in Nexus, so there is nowhere to send this.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {choices.map((it) => (
              <button key={it.key} type="button" onClick={() => start(it)} aria-label={`${it.label}. ${carryLine(it.key, shared)}`}
                style={{ ...btn('outline'), width: '100%', justifyContent: 'flex-start', gap: 12, padding: '12px 14px', minHeight: 56, textAlign: 'left', lineHeight: 1.35 }}>
                <it.Icon size={20} style={{ flexShrink: 0, color: NX.dim }} aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: FS.body, fontWeight: 700, color: NX.ink }}>{it.label}</span>
                  <span style={{ display: 'block', fontSize: FS.label, fontWeight: 400, color: NX.dim }}>{carryLine(it.key, shared)}</span>
                </span>
                <ChevronRight size={16} style={{ flexShrink: 0, color: NX.faint }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
