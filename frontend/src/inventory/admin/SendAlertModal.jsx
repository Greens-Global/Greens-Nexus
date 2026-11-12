// Item Management - Send an item alert to people (borrowed by Settings).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useMemo } from 'react';
import { X, Megaphone, Send, Users } from 'lucide-react';
import { Spinner, LoadingState } from '../../components/AsyncState';
import { api } from '../../api';
import { useItemsIdentity } from '../model/identity';
import { matchPeople } from '../../lib/peopleSearch';
import { useListNav } from '../../lib/listNav';
import { cleanName } from '../../lib/utils';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { auditName } from '../model/auditFeed';
import { FL } from '../ui/styles';

// ── Send Alert Modal ──────────────────────────────────────────────────────────
export function SendAlertModal({ onClose, toast }) {
  const { myName } = useItemsIdentity();
  const senderName  = cleanName(myName || 'Manager');

  const [users,      setUsers]      = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [search,     setSearch]     = useState('');
  const [selected,   setSelected]   = useState(new Set());
  const [subject,    setSubject]    = useState('');
  const [message,    setMessage]    = useState('');
  const [sending,    setSending]    = useState(false);

  useEffect(() => {
    // People directory (nexus_employees), not the raw GAL/roles list (P4 names).
    api.getPeopleDirectory()
      .then(rows => setUsers(Array.isArray(rows) ? rows : []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, []);

  // Name or email, first names first (Oct 25 2026 - the people-picker order);
  // nothing typed keeps the list as loaded.
  const filteredUsers = useMemo(() => matchPeople(users.map(u => ({ ...u, name: u.name || u.display_name || '' })), search),
    [users, search]);
  // Up / Down / Enter ticks the highlighted person once something is typed.
  const nav = useListNav(filteredUsers, { open: !!search.trim(), query: search, onPick: u => toggleUser(u.email) });

  function toggleUser(email) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  async function handleSend() {
    if (!selected.size) { toast?.('Select at least one recipient.', 'error'); return; }
    if (!subject.trim()) { toast?.('Subject is required.', 'error'); return; }
    if (!message.trim()) { toast?.('Message is required.', 'error'); return; }
    setSending(true);
    try {
      const res = await api.sendAlert({ to: [...selected], subject: subject.trim(), message: message.trim() });
      toast?.(res.email_sent
        ? `Alert sent to ${selected.size} recipient${selected.size !== 1 ? 's' : ''}.`
        : `Notification sent (email delivery failed - check Azure config).`, res.email_sent ? 'success' : 'error');
      onClose();
    } catch (err) {
      toast?.(err?.message || 'Could not send alert.', 'error');
    } finally {
      setSending(false);
    }
  }

  const dirty = selected.size > 0 || subject.trim() !== '' || message.trim() !== '';
  const canSave = selected.size > 0 && !!subject.trim() && !!message.trim();
  const guard = useUnsavedGuard(dirty, onClose, canSave ? handleSend : undefined);

  return (
    <div role="dialog" aria-modal="true" className="modal-overlay" style={{ zIndex:4100 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div className="modal-content nx-popup" style={{ display:'flex', flexDirection:'column' }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:'hsla(var(--color-orange),0.12)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Megaphone size={18} color="hsl(var(--color-orange))" />
            </div>
            <div>
              <h3 style={{ margin:0, fontSize:15, fontWeight:700 }}>Send Alert</h3>
              <p style={{ margin:0, fontSize:12, color:'var(--muted)' }}>Bell notification + email to selected users</p>
            </div>
          </div>
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'16px 24px', display:'flex', flexDirection:'column', gap:16 }}>
          {/* Recipients */}
          <div>
            <label style={FL}>Recipients{selected.size > 0 ? ` (${selected.size} selected)` : ''}</label>
            <div className="search-bar" style={{ marginBottom:8 }}>
              <Users size={13} style={{ flexShrink:0 }} />
              <input placeholder="Search by name or email…" value={search} onChange={e => setSearch(e.target.value)}
                {...nav.inputProps} onKeyDown={nav.onKeyDown} />
              {search && <button className="search-clear" onClick={() => setSearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
            </div>
            <div style={{ border:'1px solid var(--line)', borderRadius:10, maxHeight:180, overflowY:'auto' }}>
              {usersLoading ? (
                <LoadingState label="Loading users…" />
              ) : filteredUsers.length === 0 ? (
                <div style={{ padding:'16px', textAlign:'center', color:'var(--muted)', fontSize:13 }}>No users found.</div>
              ) : filteredUsers.map((u, i) => {
                const checked = selected.has(u.email);
                return (
                  <label key={u.email} {...nav.optionProps(i)} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', cursor:'pointer', borderBottom:'1px solid var(--line)', background: checked ? 'hsla(var(--color-green),0.06)' : 'transparent' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleUser(u.email)} style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{u.name || u.display_name || auditName(u.email)}</div>
                      <div style={{ fontSize:12, color:'var(--muted)' }}>{u.email}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
          {/* Subject */}
          <div>
            <label style={FL}>Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Alert subject…" className="form-input" style={{ width:'100%' }} />
          </div>
          {/* Message */}
          <div>
            <label style={FL}>Message</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder={`Write your message…\n\n- ${senderName}`} rows={4}
              className="form-input" style={{ width:'100%', resize:'vertical', fontFamily:'Inter,sans-serif', fontSize:13 }} />
          </div>
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', gap:10, justifyContent:'flex-end', flexShrink:0 }}>
          <button className="secondary-btn" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="primary-btn" onClick={handleSend} disabled={sending || !selected.size || !subject.trim() || !message.trim()}
            style={{ display:'inline-flex', alignItems:'center', gap:7 }}>
            {sending ? <Spinner size={14} /> : <Send size={14} />}
            Send Alert
          </button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={canSave ? guard.saveAndClose : undefined} saving={guard.saving || sending} />
      )}
    </div>
  );
}
