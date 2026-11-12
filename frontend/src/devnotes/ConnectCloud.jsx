// Claude Code In The Cloud (Neil, 11/12/2026): a developer connects their own
// Claude Code once - nothing to install - and Send To Claude Code starts a
// session in Claude's cloud on their own Claude subscription. Three one-time
// steps: a Build Token so the session can reach Nexus, a scheduled task with
// the Build Mode instructions, and that task's API trigger (Fire URL and
// token) pasted here. The server keeps the trigger encrypted and never sends
// it back; this card only ever learns "connected" and the task id's tail.
// Full steps with pictures of where to click: docs/Build-Mode-Cloud-Setup.md.
import { useEffect, useState, useCallback } from 'react';
import { Cloud, Loader2, Copy, Check, Plug, Unplug } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { store, toast } from './store';
import { CLOUD_TASK_INSTRUCTIONS } from './meta';

function CopyBtn({ text, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }
    catch { toast('Copy failed - select the text and copy it'); }
  };
  return <button type="button" className="bm-btn bm-btn-sm" onClick={copy}>{done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Copied' : label}</button>;
}

const hostOf = (base) => { try { return new URL(base).host; } catch { return ''; } };

// What the rest of Build Mode reads: the connection answer and the target.
async function refreshClaude() {
  try {
    const c = await api.devNotesClaudeConnection();
    if (c && typeof c === 'object') store.set({ claude: c });
  } catch { /* the 15 s check catches up */ }
}

export default function ConnectCloud({ apiBase = '' }) {
  const [status, setStatus] = useState(null);      // null = not known yet
  const [open, setOpen] = useState(false);
  const [minted, setMinted] = useState(null);
  const [fireUrl, setFireUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => Promise.resolve(api.devNotesCloud?.())
    .then((r) => setStatus(r && typeof r === 'object' ? r : { connected: false }))
    .catch(() => setStatus({ connected: false })), []);
  useEffect(() => { load(); }, [load]);

  const mint = async () => {
    setBusy('mint');
    try { setMinted(await api.devNotesTokenCreate(`Claude Code Cloud ${formatDate(new Date())}`)); }
    catch (e) { toast(e?.message || 'The Build Token could not be made.'); }
    finally { setBusy(''); }
  };
  const connect = async () => {
    setBusy('connect'); setError('');
    try {
      const r = await api.devNotesCloudSave(fireUrl.trim(), token.trim());
      setStatus(r); setToken(''); setFireUrl(''); setOpen(false); setMinted(null);
      store.set((st) => ({ settings: { ...st.settings, dispatchTarget: 'cloud' } }));
      await refreshClaude();
      toast('Claude Code is connected in the cloud');
    } catch (e) { setError(e?.message || 'That did not connect.'); }
    finally { setBusy(''); }
  };
  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await api.devNotesCloudClear();
      setStatus({ connected: false });
      store.set((st) => ({ settings: { ...st.settings, dispatchTarget: 'local' } }));
      await refreshClaude();
      toast('Claude Code in the cloud is disconnected');
    } catch (e) { toast(e?.message || 'That did not disconnect.'); }
    finally { setBusy(''); }
  };

  if (status === null) return null;
  if (status.connected) {
    return (
      <div className="bm-connect is-ok" data-testid="bm-cloud-connected">
        <div><span className="bm-claude-dot" /> Claude Code is connected in the cloud{status.task ? ` (scheduled task ${status.task})` : ''}{status.target === 'cloud' ? ' - Send To Claude Code starts a session on your Claude subscription.' : ' - your pins go to your terminal for now (Settings > Dispatch Target).'}</div>
        {status.lastStartedAt && <div className="bm-small bm-dim">Last started {formatDateTime(status.lastStartedAt)}</div>}
        {status.lastError && <div className="bm-small" role="alert">Last try did not start: {status.lastError}</div>}
        <button type="button" className="bm-btn bm-btn-sm" onClick={disconnect} disabled={busy === 'disconnect'}>{busy === 'disconnect' ? <Loader2 size={13} className="bm-spin" /> : <Unplug size={13} />} Disconnect</button>
      </div>
    );
  }
  const host = hostOf(apiBase);
  return (
    <div className="bm-connect" data-testid="bm-cloud-connect">
      <div className="bm-sec-title"><Cloud size={13} /> Claude Code In The Cloud</div>
      <div className="bm-small bm-dim">Nothing to install. Send To Claude Code starts Claude Code in Claude&apos;s cloud, on your own Claude subscription - no terminal has to be open.</div>
      {!open ? (
        <button type="button" className="bm-btn bm-btn-primary" onClick={() => setOpen(true)}><Cloud size={14} /> Connect In The Cloud</button>
      ) : (
        <>
          <ol className="bm-steps bm-small">
            <li>
              <strong>Let Claude Code reach Nexus.</strong> Make a Build Token, then in Claude Code on the web add it to your cloud environment as a network secret{host ? <> for <code>{host}</code></> : ''}.
              {!minted
                ? <div><button type="button" className="bm-btn bm-btn-sm" onClick={mint} disabled={busy === 'mint'}>{busy === 'mint' ? <Loader2 size={13} className="bm-spin" /> : <Plug size={13} />} Make A Build Token</button></div>
                : <div className="bm-code-row"><code className="bm-code">{minted.token}</code><CopyBtn text={minted.token} label="Copy Token" /></div>}
              {minted && <div className="bm-dim">Shown once. It renews itself while Claude Code uses it.</div>}
            </li>
            <li>
              <strong>Make the scheduled task.</strong> In Claude Code on the web, add a scheduled task for the Nexus repository on that environment and paste these instructions.
              <div><CopyBtn text={CLOUD_TASK_INSTRUCTIONS} label="Copy Instructions" /></div>
            </li>
            <li>
              <strong>Add an API trigger to it</strong> and paste its Fire URL and token here.
              <div className="bm-field-block">
                <input className="bm-input" value={fireUrl} onChange={(e) => setFireUrl(e.target.value)} placeholder="Fire URL - https://api.anthropic.com/v1/claude_code/routines/trig_.../fire" aria-label="Fire URL" autoComplete="off" spellCheck={false} />
                <input className="bm-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token - sk-ant-oat01-..." aria-label="Trigger token" autoComplete="off" spellCheck={false} onKeyDown={(e) => { if (e.key === 'Enter' && fireUrl.trim() && token.trim()) connect(); }} />
              </div>
            </li>
          </ol>
          {error && <div className="bm-small" role="alert">{error}</div>}
          <div className="bm-code-row">
            <button type="button" className="bm-btn bm-btn-primary" onClick={connect} disabled={busy === 'connect' || !fireUrl.trim() || !token.trim()}>{busy === 'connect' ? <Loader2 size={14} className="bm-spin" /> : <Cloud size={14} />} Connect</button>
            <button type="button" className="bm-btn" onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
          </div>
          <div className="bm-small bm-dim">Nexus keeps the trigger encrypted and never shows it again. The full steps are in docs/Build-Mode-Cloud-Setup.md.</div>
        </>
      )}
    </div>
  );
}
