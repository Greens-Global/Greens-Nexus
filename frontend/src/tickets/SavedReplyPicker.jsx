// Saved Replies picker (Oct 2026) - opened from the ticket drawer's reply
// composer, desk side only. Search, see the reply with this ticket's details
// filled in, and Insert puts that text into the composer for editing. It
// never sends anything: the reply still goes out with the drawer's other
// changes on Done. Replies for the ticket's help topic are listed first.
// Placeholders: savedReplies.js (the one implementation).
import { useEffect, useMemo, useState } from 'react';
import { Search, MessageSquareText, Users, User } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { NX, FONT, btn, chip, input as inputStyle } from '../tasks/theme';
import { richBodyHtml } from '../tasks/lib';
import { SkeletonBlocks } from '../components/AsyncState';
import { fillPlaceholders, placeholderValues, rankReplies, replyText } from './savedReplies';
import TicketSavedRepliesSettings from './TicketSavedRepliesSettings';

export default function SavedReplyPicker({ ticket, agentEmail, nameOf, onInsert, onClose }) {
  const [replies, setReplies] = useState(null);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState('');
  // Manage: the Settings panel, right here - an agent who cannot open
  // Settings still keeps their own replies.
  const [managing, setManaging] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.getTicketSavedReplies(ticket?.companyId || '')
      .then((rows) => { if (alive) { setReplies(Array.isArray(rows) ? rows : []); setErr(''); } })
      .catch((e) => { if (alive) { setErr(e?.message || 'Could not load saved replies.'); setReplies([]); } });
    return () => { alive = false; };
  }, [ticket?.companyId, version]);

  const values = useMemo(() => placeholderValues({ ticket, agentEmail, nameOf }), [ticket, agentEmail, nameOf]);
  const ranked = useMemo(() => rankReplies(replies, { topic: ticket?.application || '', query }), [replies, ticket?.application, query]);
  const sel = ranked.find((r) => r.id === selId) || ranked[0] || null;
  const filled = sel ? fillPlaceholders(sel.body, values) : '';

  const insert = () => {
    if (!sel) return;
    onInsert(filled);
    // Counted for the Manage list's order; nobody waits on it.
    api.countTicketSavedReplyUse(sel.id).catch(() => {});
    onClose();
  };

  if (managing) {
    return (
      <Modal title="Manage Saved Replies" onClose={onClose} minHeight="60vh"
        footer={<button type="button" onClick={() => setManaging(false)} style={btn('primary')}>Back to Saved Replies</button>}>
        <TicketSavedRepliesSettings onChanged={() => setVersion((v) => v + 1)} />
      </Modal>
    );
  }

  const footer = (
    <>
      <button type="button" onClick={() => setManaging(true)} style={{ ...btn('ghost'), marginRight: 'auto' }}>Manage</button>
      <span style={{ fontSize: 11.5, color: NX.faint }}>Inserted into your reply for editing - nothing is sent until you click Done.</span>
      <button type="button" onClick={onClose} style={btn('ghost')}>Cancel</button>
      <button type="button" onClick={insert} disabled={!sel} style={{ ...btn('primary'), opacity: sel ? 1 : 0.55 }}>Insert Reply</button>
    </>
  );

  return (
    <Modal title="Saved Replies" onClose={onClose} footer={footer} minHeight="60vh">
      <div data-testid="saved-reply-picker" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search saved replies…"
            aria-label="Search saved replies" style={{ ...inputStyle, width: '100%', paddingLeft: 30, boxSizing: 'border-box' }} />
        </div>
        {replies === null ? <SkeletonBlocks count={4} height={40} />
          : err ? <div style={{ fontSize: 12.5, color: NX.red }}>{err}</div>
            : ranked.length === 0 ? (
              <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 24, lineHeight: 1.5 }}>
                {query ? 'No saved replies match your search.' : 'No saved replies yet. Click Manage to add one.'}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div role="listbox" aria-label="Saved replies" style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '48vh', overflowY: 'auto' }}>
                  {ranked.map((r) => {
                    const on = sel && r.id === sel.id;
                    return (
                      <button key={r.id} type="button" role="option" aria-selected={!!on} onClick={() => setSelId(r.id)}
                        style={{
                          textAlign: 'left', border: `1px solid ${on ? 'var(--wk-brand)' : NX.border}`, borderRadius: 10,
                          background: on ? 'var(--wk-brand-tint)' : NX.surface, padding: '8px 10px', cursor: 'pointer', fontFamily: FONT,
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {r.shared ? <Users size={12} style={{ color: NX.dim, flexShrink: 0 }} /> : <User size={12} style={{ color: NX.dim, flexShrink: 0 }} />}
                          <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                          {r.matchesTopic && <span style={{ ...chip(NX.blue, 'rgba(37,99,235,0.12)'), fontSize: 10.5 }}>This Topic</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyText(r.body)}</div>
                      </button>
                    );
                  })}
                </div>
                {sel && (
                  <div style={{ flex: '2 1 320px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <MessageSquareText size={14} style={{ color: NX.dim }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{sel.title}</span>
                      <span style={{ fontSize: 11.5, color: NX.faint }}>{sel.shared ? 'Shared' : 'Personal'}{sel.helpTopic ? ` · ${sel.helpTopic}` : ''}</span>
                    </div>
                    <div className="nx-rich-body" data-testid="saved-reply-preview"
                      style={{ fontSize: 13, color: NX.ink, border: `1px solid ${NX.border2}`, borderRadius: 10, padding: '10px 12px', background: NX.surface2 }}
                      dangerouslySetInnerHTML={{ __html: richBodyHtml(filled, nameOf) }} />
                  </div>
                )}
              </div>
            )}
      </div>
    </Modal>
  );
}
