// Where BOD / EOD / break messages post in Microsoft Teams: a group chat, or a
// channel in a team. Used on a job role (Access > Job Roles, Neil 10/07: "it's
// based on a role") and on a shift group (the older place, kept as the
// fallback). `value` is { type: 'chat' | 'channel', id, name, teamId, teamName };
// an empty id means nothing is bound.
//
// The lists come from the server first (/timeclock/my-chats, /my-channels -
// the same delegated token the delivery queue uses) and fall back to an MSAL
// sign-in in the browser only when the server could not list them.
import { useState } from 'react';
import { Hash, Link2, MessageSquare } from 'lucide-react';
import { api } from '../api';
import { graphTokenSilent, graphTokenInteractive, listMyChats, channelTokenInteractive, listMyChannels } from '../teamsGraph';
import { Spinner } from './AsyncState';

export const EMPTY_TEAMS_TARGET = { type: 'chat', id: '', name: '', teamId: '', teamName: '' };

export function teamsTargetLabel(t) {
  if (!t?.id) return '';
  return t.type === 'channel' ? `${t.teamName || 'Team'} › ${t.name || 'Channel'}` : (t.name || 'Group chat');
}

const linkBtn = { border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--wk-brand)', fontWeight: 700, fontSize: 11.5 };

export default function TeamsTargetPicker({ value, onChange, toastErr, audience = 'Members' }) {
  const v = { ...EMPTY_TEAMS_TARGET, ...(value || {}) };
  const [chatList, setChatList] = useState(null);
  const [channelList, setChannelList] = useState(null);
  const [loading, setLoading] = useState(false);

  async function loadChats() {
    setLoading(true);
    let serverReason = '';
    try {
      const r = await api.timeMyChats();
      if (r?.chats?.length) { setChatList(r.chats); setLoading(false); return; }
      serverReason = r?.reason || 'no chats returned';
    } catch (e) { serverReason = e?.message || 'request failed'; }
    try {
      const tok = (await graphTokenSilent()) || (await graphTokenInteractive());
      setChatList(await listMyChats(tok));
    } catch (e) {
      toastErr?.(`Could not load your Teams chats - ${serverReason}; Microsoft sign-in: ${e?.errorCode || e?.message || 'failed'}.`);
      setChatList([]);
    }
    setLoading(false);
  }
  async function loadChannels() {
    setLoading(true);
    let serverReason = '';
    try {
      const r = await api.timeMyChannels();
      if (r?.channels?.length) { setChannelList(r.channels); setLoading(false); return; }
      serverReason = r?.reason || 'no channels returned';
    } catch (e) { serverReason = e?.message || 'request failed'; }
    try {
      setChannelList(await listMyChannels(await channelTokenInteractive()));
    } catch (e) {
      toastErr?.(`Could not load your Teams channels - ${serverReason}; Microsoft sign-in: ${e?.errorCode || e?.message || 'failed'}.`);
      setChannelList([]);
    }
    setLoading(false);
  }
  // Group chat or channel - switching clears a half-made choice of the other kind.
  const setType = (type) => { if (type !== v.type) onChange({ ...EMPTY_TEAMS_TARGET, type }); };
  const seg = (on) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
    background: on ? 'var(--surface, var(--card, #fff))' : 'transparent', color: on ? 'var(--ink, inherit)' : 'var(--muted)',
    boxShadow: on ? '0 1px 2px rgba(0,0,0,.12)' : 'none', fontFamily: 'inherit',
  });

  return (
    <div>
      <div role="radiogroup" aria-label="Post to" style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 9, background: 'var(--bg, var(--mist))', marginBottom: 8 }}>
        {[['chat', 'Group Chat', MessageSquare], ['channel', 'Channel', Hash]].map(([k, l, Icon]) => (
          <button key={k} type="button" role="radio" aria-checked={v.type === k} onClick={() => setType(k)} style={seg(v.type === k)}>
            <Icon size={12} /> {l}
          </button>
        ))}
      </div>
      {v.id ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, padding: '5px 11px', borderRadius: 9, background: 'var(--bg, var(--mist))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {v.type === 'channel' ? <Hash size={12} /> : <MessageSquare size={12} />} {teamsTargetLabel(v)}
          </span>
          <button type="button" className="secondary-btn" style={{ fontSize: 11.5 }} onClick={() => onChange({ ...EMPTY_TEAMS_TARGET, type: v.type })}>Change Or Clear</button>
        </div>
      ) : v.type === 'channel' ? (
        channelList === null ? (
          <button type="button" className="secondary-btn" onClick={loadChannels} disabled={loading} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {loading ? <Spinner size={12} /> : <Link2 size={12} />} Bind A Channel
          </button>
        ) : channelList.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            No Teams channels found for your account. This list only shows channels of teams you are a member of - join the team in Microsoft Teams first, then{' '}
            <button type="button" onClick={loadChannels} disabled={loading} style={linkBtn}>refresh</button>.
          </div>
        ) : (
          <select className="form-input" value="" aria-label="Teams channel" style={{ fontSize: 12.5, width: '100%' }}
            onChange={(e) => {
              const c = channelList.find((x) => x.channelId === e.target.value);
              if (c) onChange({ type: 'channel', id: c.channelId, name: c.channelName, teamId: c.teamId, teamName: c.teamName });
            }}>
            <option value="">Pick a channel</option>
            {[...new Set(channelList.map((c) => c.teamId))].map((tid) => {
              const inTeam = channelList.filter((c) => c.teamId === tid);
              return (
                <optgroup key={tid} label={inTeam[0].teamName}>
                  {inTeam.map((c) => <option key={c.channelId} value={c.channelId}>{c.channelName}{c.membershipType === 'private' ? ' (private)' : c.membershipType === 'shared' ? ' (shared)' : ''}</option>)}
                </optgroup>
              );
            })}
          </select>
        )
      ) : chatList === null ? (
        <button type="button" className="secondary-btn" onClick={loadChats} disabled={loading} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {loading ? <Spinner size={12} /> : <Link2 size={12} />} Bind A Chat
        </button>
      ) : chatList.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          No Teams chats found for your account. This list only shows chats you are already a member of - create or join the group chat in Microsoft Teams first, then{' '}
          <button type="button" onClick={loadChats} disabled={loading} style={linkBtn}>refresh</button>.
        </div>
      ) : (
        <select className="form-input" value="" aria-label="Teams chat" style={{ fontSize: 12.5, width: '100%' }}
          onChange={(e) => { const c = chatList.find((x) => x.id === e.target.value); if (c) onChange({ ...EMPTY_TEAMS_TARGET, type: 'chat', id: c.id, name: c.name }); }}>
          <option value="">Pick a group chat</option>
          {chatList.map((c) => <option key={c.id} value={c.id}>{c.name}{c.chatType === 'oneOnOne' ? ' (direct)' : ''}</option>)}
        </select>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, lineHeight: 1.45 }}>
        {v.type === 'channel'
          ? `${audience} must be in this team (and in the channel, if it is private) for their message to post. Each message is a new post in the channel.`
          : `${audience} must be in this chat for their message to post.`}
      </div>
    </div>
  );
}
