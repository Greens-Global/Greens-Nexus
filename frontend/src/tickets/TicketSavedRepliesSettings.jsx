// Settings > Ticket Manager > Saved Replies (Oct 2026): the desk's canned
// responses. The same panel opens from the drawer's Saved Replies picker
// (Manage), so an agent who cannot reach Settings can still keep their own.
//
// Shared replies are the whole desk's (of one company) - only ticket
// supervisors create, edit or delete them. Personal ones are yours alone.
// The backend (routers/ticket_saved_replies.py) is the real boundary; this
// only decides what to offer. Placeholders: savedReplies.js.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, MessageSquareText, Users, User, ArrowLeft, Save } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, btn, card, input as inputStyle } from '../tasks/theme';
import { usePeople } from '../tasks/components';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import { richBodyHtml } from '../tasks/lib';
import { LoadingState } from '../components/AsyncState';
import { dialog } from '../ui/dialog';
import { useTicketAccess } from './ticketAccess';
import { PLACEHOLDERS, fillPlaceholders, replyText } from './savedReplies';

const EXAMPLES = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.example]));
const BLANK = { id: '', title: '', body: '', helpTopic: '', shared: false, companyId: '' };

function topicNames(cfg) {
  const out = [];
  const seen = new Set();
  for (const g of cfg?.helpTopics || []) {
    for (const tp of g.topics || []) {
      const n = (tp.name || '').trim();
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function Editor({ draft, setDraft, canShare, topics, companies, onCancel, onSave, saving, err }) {
  const people = usePeople();
  const label = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 4, display: 'block' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <button type="button" onClick={onCancel} style={{ ...btn('ghost'), alignSelf: 'flex-start', padding: '4px 8px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <ArrowLeft size={13} /> All Saved Replies
      </button>
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{draft.id ? 'Edit Saved Reply' : 'New Saved Reply'}</div>
      <div>
        <label style={label} htmlFor="sr-title">Title</label>
        <input id="sr-title" autoFocus value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Password Reset Steps" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <label style={label} htmlFor="sr-topic">Help Topic</label>
          <select id="sr-topic" value={draft.helpTopic} onChange={(e) => setDraft({ ...draft, helpTopic: e.target.value })}
            style={{ ...inputStyle, width: '100%' }}>
            <option value="">Any Topic</option>
            {topics.map((n) => <option key={n} value={n}>{n}</option>)}
            {draft.helpTopic && !topics.includes(draft.helpTopic) && <option value={draft.helpTopic}>{draft.helpTopic}</option>}
          </select>
          <div style={{ fontSize: 11, color: NX.faint, marginTop: 3 }}>Suggested first on tickets about this topic.</div>
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <span style={label}>Who Can Use It</span>
          <div role="radiogroup" aria-label="Who can use it" style={{ display: 'flex', gap: 6 }}>
            {[[false, 'Personal', User], [true, 'Shared', Users]].map(([val, lab, Icon]) => {
              const on = draft.shared === val;
              const off = val && !canShare;
              return (
                <button key={lab} type="button" role="radio" aria-checked={on} disabled={off}
                  title={off ? 'Only a ticket supervisor can share a reply with the desk' : undefined}
                  onClick={() => setDraft({ ...draft, shared: val })}
                  style={{ ...btn(on ? 'primary' : 'outline'), padding: '6px 12px', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5, opacity: off ? 0.5 : 1 }}>
                  <Icon size={13} /> {lab}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: NX.faint, marginTop: 3 }}>
            {draft.shared ? 'Every agent on the desk can use it.' : 'Only you see it.'}
          </div>
        </div>
        {/* A shared reply belongs to one company's desk; with several, pick
            which (a Global Admin with no company of their own must). */}
        {draft.shared && !draft.id && companies.length > 0 && (
          <div style={{ flex: '1 1 220px' }}>
            <label style={label} htmlFor="sr-company">Company</label>
            <select id="sr-company" value={draft.companyId} onChange={(e) => setDraft({ ...draft, companyId: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}>
              <option value="">My Company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div>
        <span style={label}>Reply</span>
        <RichDescription value={draft.body} onChange={(b) => setDraft({ ...draft, body: b })} minHeight={140}
          mentionPeople={people} placeholder="Hi {requester_first_name}, …" />
      </div>
      <div style={{ fontSize: 11.5, color: NX.faint, lineHeight: 1.6 }}>
        Placeholders are filled in when the reply is inserted:{' '}
        {PLACEHOLDERS.map((p, i) => (
          <span key={p.key}><code style={{ fontSize: 11 }}>{`{${p.key}}`}</code> ({p.label.toLowerCase()}){i < PLACEHOLDERS.length - 1 ? ', ' : '.'}</span>
        ))}{' '}Anything else in braces stays as typed.
      </div>
      {!isEmptyDoc(draft.body) && (
        <div>
          <span style={label}>Preview</span>
          <div className="nx-rich-body" style={{ fontSize: 13, color: NX.ink, border: `1px solid ${NX.border2}`, borderRadius: 10, padding: '10px 12px', background: NX.surface2 }}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(fillPlaceholders(draft.body, EXAMPLES)) }} />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={onSave} disabled={saving || !draft.title.trim() || isEmptyDoc(draft.body)}
          style={{ ...btn('primary'), display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (saving || !draft.title.trim() || isEmptyDoc(draft.body)) ? 0.6 : 1 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save Reply'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} style={btn('ghost')}>Cancel</button>
        {err && <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>{err}</span>}
      </div>
    </div>
  );
}

export default function TicketSavedRepliesSettings({ onChanged }) {
  const access = useTicketAccess();
  const [replies, setReplies] = useState(null);
  const [topics, setTopics] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  const load = () => api.getTicketSavedReplies()
    .then((rows) => { setReplies(Array.isArray(rows) ? rows : []); setLoadErr(''); })
    .catch((e) => { setLoadErr(e?.message || 'Could not load saved replies.'); setReplies([]); });
  useEffect(() => {
    load();
    api.getTicketTaxonomySettings().then((cfg) => setTopics(topicNames(cfg))).catch(() => {});
    api.getTicketCompanies().then((rows) => setCompanies(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const rows = replies || [];
    const byUse = (a, b) => (b.useCount || 0) - (a.useCount || 0) || a.title.localeCompare(b.title);
    return [
      { key: 'shared', title: 'Shared With the Desk', Icon: Users, rows: rows.filter((r) => r.shared).sort(byUse) },
      { key: 'mine', title: 'My Saved Replies', Icon: User, rows: rows.filter((r) => !r.shared).sort(byUse) },
    ];
  }, [replies]);

  // No desk role: the list call answers 403 and its message shows below -
  // the server decides, not a flag that is still loading.
  if (replies === null) return <LoadingState />;

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const payload = { title: draft.title, body: draft.body, help_topic: draft.helpTopic, shared: draft.shared };
      if (draft.id) await api.updateTicketSavedReply(draft.id, payload);
      else await api.createTicketSavedReply({ ...payload, ...(draft.shared && draft.companyId ? { company_id: draft.companyId } : {}) });
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) { setErr(e?.message || 'Could not save the reply.'); }
    finally { setSaving(false); }
  };
  const remove = async (r) => {
    const ok = await dialog.confirm(`Delete the saved reply "${r.title}"?${r.shared ? ' Nobody on the desk will be able to use it.' : ''}`,
      { title: 'Delete Saved Reply', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.deleteTicketSavedReply(r.id); }
    catch (e) { dialog.alert(e?.message || 'Could not delete the reply.', { title: 'Not Deleted' }); return; }
    await load();
    onChanged?.();
  };

  if (draft) {
    return (
      <div style={{ fontFamily: FONT, color: NX.ink, maxWidth: 820 }}>
        <Editor draft={draft} setDraft={setDraft} canShare={access.canManageDesk} topics={topics} companies={companies}
          onCancel={() => { setDraft(null); setErr(''); }} onSave={save} saving={saving} err={err} />
      </div>
    );
  }

  return (
    <div data-testid="saved-replies-settings" style={{ fontFamily: FONT, color: NX.ink, maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <MessageSquareText size={15} style={{ color: NX.dim }} />
        <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>Saved Replies</div>
        <button type="button" onClick={() => setDraft({ ...BLANK })} style={{ ...btn('primary'), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Saved Reply
        </button>
      </div>
      <div style={{ fontSize: 12, color: NX.faint, marginBottom: 14, lineHeight: 1.5 }}>
        Answers the desk gives again and again. Pick one from Saved Replies in a ticket&apos;s reply box - it is filled in
        for that ticket and dropped into your reply to edit, never sent on its own.
        {access.canManageDesk ? '' : ' Shared replies are managed by ticket supervisors.'}
      </div>
      {loadErr && <div style={{ fontSize: 12.5, color: NX.red, marginBottom: 10 }}>{loadErr}</div>}
      {groups.map((g) => (
        <div key={g.key} style={{ ...card, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <g.Icon size={13} style={{ color: NX.dim }} />
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{g.title}</div>
            <span style={{ fontSize: 11.5, color: NX.faint }}>{g.rows.length}</span>
          </div>
          {g.rows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: NX.faint }}>
              {g.key === 'shared' ? 'No shared replies yet.' : 'No personal replies yet.'}
            </div>
          ) : g.rows.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${NX.border2}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                <div style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.helpTopic ? `${r.helpTopic} · ` : ''}Used {r.useCount || 0} time{(r.useCount || 0) === 1 ? '' : 's'} · {replyText(r.body)}
                </div>
              </div>
              {r.canEdit && (
                <>
                  <button type="button" aria-label={`Edit ${r.title}`} title="Edit"
                    onClick={() => setDraft({ id: r.id, title: r.title, body: r.body, helpTopic: r.helpTopic || '', shared: r.shared, companyId: r.companyId || '' })}
                    style={{ ...btn('ghost'), padding: 5 }}><Pencil size={14} /></button>
                  <button type="button" aria-label={`Delete ${r.title}`} title="Delete" onClick={() => remove(r)}
                    style={{ ...btn('ghost'), padding: 5, color: NX.red }}><Trash2 size={14} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
