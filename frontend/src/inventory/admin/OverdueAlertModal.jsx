// Item Management - Alert people about overdue checkouts, grouped by person.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useMemo } from 'react';
import { CheckCircle, X, Megaphone, Send } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { checkoutDueInfo, fmtDueDate } from '../model/due';
import { FL } from '../ui/styles';

// ── Overdue Alert Modal ───────────────────────────────────────────────────────
// Send Alert without typing emails: lists everyone holding OVERDUE items
// (person = parent, their overdue items = children), with per-person and
// select-all checkboxes. One send-alert call per selected person = one bell
// notification + one email each, covering all their items in a single message.
export function OverdueAlertModal({ checkouts, onClose, toast }) {
  const [selected, setSelected] = useState(null); // null until groups computed → select all by default
  const [note,     setNote]     = useState('');
  const [sending,  setSending]  = useState(false);

  const groups = useMemo(() => {
    const map = new Map();
    for (const co of checkouts) {
      if (co.status !== 'allocated') continue;
      const info = checkoutDueInfo(co);
      if (info.due >= new Date()) continue;
      const key = (co.requestedByEmail || co.requestedBy || '').toLowerCase();
      if (!map.has(key)) map.set(key, { key, name: co.requestedBy, email: (co.requestedByEmail || '').toLowerCase(), items: [] });
      map.get(key).items.push({ co, ...info });
    }
    // Most overdue items first; items inside each person oldest-due first
    const list = [...map.values()];
    list.forEach(g => g.items.sort((a, b) => a.due - b.due));
    return list.sort((a, b) => b.items.length - a.items.length);
  }, [checkouts]);

  // Everyone with an email starts selected - the common case is "alert them all"
  const sel = selected ?? new Set(groups.filter(g => g.email).map(g => g.key));
  const sendable = groups.filter(g => g.email && sel.has(g.key));

  function toggle(key) {
    setSelected(() => { const n = new Set(sel); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleAll() {
    const all = groups.filter(g => g.email).map(g => g.key);
    setSelected(sel.size === all.length ? new Set() : new Set(all));
  }

  async function handleSend() {
    if (!sendable.length || sending) return;
    setSending(true);
    let failed = 0, emailFailed = 0, emailErr = '';
    for (const g of sendable) {
      const lines = g.items.map(({ co, daysLeft }) => {
        const od = Math.abs(daysLeft);
        return `• ${co.itemName} - was due ${fmtDueDate(co)} (${od} day${od !== 1 ? 's' : ''} overdue)`;
      });
      const firstName = (g.name || '').split(' ')[0] || g.name;
      const message = `Hi ${firstName},\n\nThe following item${g.items.length !== 1 ? 's are' : ' is'} overdue. Please return ${g.items.length !== 1 ? 'them' : 'it'} as soon as possible:\n\n${lines.join('\n')}${note.trim() ? `\n\n${note.trim()}` : ''}`;
      try {
        const res = await api.sendAlert({
          to: [g.email],
          subject: `Overdue: ${g.items.length} item${g.items.length !== 1 ? 's' : ''} to return`,
          message,
        });
        if (!res.email_sent) { emailFailed++; emailErr = res.email_errors?.[0] || emailErr; }
      } catch { failed++; }
    }
    setSending(false);
    if (failed) toast?.(`Alerted ${sendable.length - failed} of ${sendable.length} people · ${failed} failed.`, 'error');
    else if (emailFailed) toast?.(`Bell alerts sent to ${sendable.length} - email did NOT go out${emailErr ? `: ${emailErr.slice(0, 160)}` : ' (check Azure config).'}`, 'error');
    else toast?.(`Overdue alert sent to ${sendable.length} ${sendable.length !== 1 ? 'people' : 'person'} (bell + email).`);
    onClose();
  }

  const allWithEmail = groups.filter(g => g.email);
  const dirty = note.trim() !== '';
  const guard = useUnsavedGuard(dirty, onClose, sendable.length ? handleSend : undefined);
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={e => e.target === e.currentTarget && guard.requestClose()}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:560, maxHeight:'min(90dvh, 720px)', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:'hsla(var(--color-orange),0.12)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Megaphone size={18} color="hsl(var(--color-orange))" />
            </div>
            <div>
              <h3 style={{ margin:0, fontSize:15, fontWeight:700 }}>Overdue Alert</h3>
              <p style={{ margin:0, fontSize:12, color:'var(--muted)' }}>Bell notification + email, one per person, listing their overdue items</p>
            </div>
          </div>
          <button onClick={guard.requestClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY:'auto', flex:1, padding:'16px 24px', display:'flex', flexDirection:'column', gap:14 }}>
          {groups.length === 0 ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'var(--muted)', fontSize:13 }}>
              <CheckCircle size={28} style={{ opacity:.3, display:'block', margin:'0 auto 8px' }} />
              Nothing is overdue right now.
            </div>
          ) : (<>
            {/* Select all */}
            <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', userSelect:'none' }}>
              <input type="checkbox"
                checked={sel.size === allWithEmail.length && allWithEmail.length > 0}
                ref={el => { if (el) el.indeterminate = sel.size > 0 && sel.size < allWithEmail.length; }}
                onChange={toggleAll}
                style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
              <span style={{ fontSize:12.5, fontWeight:700 }}>
                {sel.size > 0 ? `${sel.size} of ${allWithEmail.length} selected` : `Select all (${allWithEmail.length})`}
              </span>
              <span style={{ marginLeft:'auto', fontSize:11.5, color:'var(--muted)' }}>
                {groups.reduce((n, g) => n + g.items.length, 0)} overdue item{groups.reduce((n, g) => n + g.items.length, 0) !== 1 ? 's' : ''}
              </span>
            </label>
            {/* Person → overdue items */}
            <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'hidden' }}>
              {groups.map((g, gi) => {
                const checked = g.email && sel.has(g.key);
                return (
                  <label key={g.key} style={{ display:'block', padding:'10px 14px', cursor: g.email ? 'pointer' : 'default', borderTop: gi > 0 ? '1px solid var(--line)' : 'none', background: checked ? 'hsla(var(--color-orange),0.05)' : 'transparent' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <input type="checkbox" checked={checked} disabled={!g.email} onChange={() => toggle(g.key)}
                        style={{ cursor: g.email ? 'pointer' : 'not-allowed', accentColor:'var(--pine)', flexShrink:0 }} />
                      <span style={{ fontWeight:700, fontSize:13, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.name}</span>
                      <span style={{ fontSize:11, fontWeight:800, padding:'2px 9px', borderRadius:20, background:'hsla(var(--color-red),0.1)', color:'hsl(var(--color-red))', flexShrink:0 }}>
                        {g.items.length} overdue
                      </span>
                    </div>
                    {!g.email && <div style={{ fontSize:11, color:'hsl(var(--color-red))', paddingLeft:24, marginTop:2 }}>No email on file - can't alert</div>}
                    <div style={{ paddingLeft:24, marginTop:6, display:'flex', flexDirection:'column', gap:3 }}>
                      {g.items.map(({ co, daysLeft }) => (
                        <div key={co.id} style={{ fontSize:12, color:'var(--muted)' }}>
                          · {co.itemName} <span style={{ color:'hsl(var(--color-red))', fontWeight:600 }}>- {Math.abs(daysLeft)} day{Math.abs(daysLeft) !== 1 ? 's' : ''} overdue</span> (was due {fmtDueDate(co)})
                        </div>
                      ))}
                    </div>
                  </label>
                );
              })}
            </div>
            {/* Optional note appended to every message */}
            <div>
              <label style={FL}>Add a note <span style={{ fontWeight:400 }}>(optional, goes to everyone selected)</span></label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                placeholder="e.g. Drop items at the site office by Friday."
                className="form-input" style={{ width:'100%', resize:'vertical', fontFamily:'Inter,sans-serif', fontSize:13 }} />
            </div>
          </>)}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--line)', display:'flex', gap:10, alignItems:'center', flexShrink:0 }}>
          <div style={{ marginLeft:'auto', display:'flex', gap:10 }}>
            <button className="secondary-btn" onClick={onClose} disabled={sending}>Cancel</button>
            <button onClick={handleSend} disabled={sending || !sendable.length}
              style={{ display:'inline-flex', alignItems:'center', gap:7, background:'hsl(var(--color-orange))', color:'#fff', border:'none', borderRadius:9, padding:'9px 18px', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif', opacity: (sending || !sendable.length) ? 0.55 : 1 }}>
              {sending ? <Spinner size={14} /> : <Send size={14} />}
              Send to {sendable.length || '…'}
            </button>
          </div>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose}
          onSave={sendable.length ? guard.saveAndClose : undefined} saving={guard.saving || sending} />
      )}
    </div>
  );
}
