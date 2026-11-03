// Item Management - One item's activity timeline.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect } from 'react';
import { Package, X, Pencil } from 'lucide-react';
import { SkeletonBlocks } from '../../components/AsyncState';
import { api } from '../../api';
import { useNameResolver } from '../../lib/useNameResolver';
import { renderNotifBody } from '../../components/NotificationBell';
import { formatAuditDetails, fmtAuditStamp, auditEventMeta, _auditFg, _auditBg, buildAuditDiffs } from '../model/auditFeed';
import { useEscapeKey } from '../ui/hooks';
import { auditVal } from './auditVal';

// Interactive per-item history - clicking a log row opens this: the item's whole
// life as a top-to-bottom flow (added → checked out → returned → updated →
// deleted), with who/when and a plain-English note for each step.
export function AuditHistoryModal({ item, onClose, onOpenItem }) {
  const [rows, setRows]   = useState(null);
  const [error, setError] = useState('');
  const nameOf = useNameResolver();
  useEscapeKey(onClose);
  useEffect(() => {
    api.getItemsAuditLog({ q: item.name || item.id, limit: 100 })
      .then(res => {
        const all = res.rows || [];
        const seen = (item.name || '').toLowerCase();
        const match = all.filter(r =>
          (item.id && r.resource_id === item.id) ||
          (seen && ((r.details || '').toLowerCase().includes(seen) || (r.action || '').toLowerCase().includes(seen)))
        );
        match.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '')); // oldest → newest
        setRows(match);
      })
      .catch(() => setError('Could not load this item’s history.'));
  }, [item]);

  return (
    <div role="dialog" aria-modal="true" onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1200, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'var(--card)', borderRadius:16, width:'100%', maxWidth:560, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'var(--shadow-lg)' }}>
        <div style={{ padding:'18px 22px 14px', borderBottom:'1px solid var(--line)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ minWidth:0 }}>
            <h3 style={{ margin:0, fontSize:16, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name || 'Item History'}</h3>
            <p style={{ margin:'3px 0 0', fontSize:12.5, color:'var(--muted)' }}>Full activity timeline - newest at the bottom</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', padding:4, flexShrink:0 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY:'auto', padding:'18px 22px', flex:1 }}>
          {error ? <div style={{ color:'hsl(var(--color-red))', fontSize:13 }}>{error}</div>
            : rows === null ? <SkeletonBlocks count={4} height={48} borderRadius={8} />
            : rows.length === 0 ? <div style={{ textAlign:'center', color:'var(--muted)', fontSize:13, padding:'30px 0' }}>No recorded history for this item.</div>
            : buildAuditDiffs(rows).map(({ row: r, changes, baseline, isAdd }, i) => {
                const m = baseline ? { Icon: Package, tone: 'blue', verb: 'Original values' } : auditEventMeta(r.action);
                return (
                  <div key={r.id} style={{ display:'flex', gap:13 }}>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                      <div style={{ width:32, height:32, borderRadius:'50%', flexShrink:0, background:_auditBg(m.tone), color:_auditFg(m.tone), display:'flex', alignItems:'center', justifyContent:'center' }}><m.Icon size={15} /></div>
                      {i < rows.length - 1 && <div style={{ width:2, flex:1, minHeight:14, background:'var(--line)', marginTop:2 }} />}
                    </div>
                    <div style={{ paddingBottom:18, flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:700, fontSize:13 }}>{m.verb}</div>
                      <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1 }}>by {nameOf(r.user_email, r.user_name)} · {fmtAuditStamp(r.timestamp)}</div>
                      {changes ? (
                        changes.length ? (
                          <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:3 }}>
                            {changes.map((c, j) => (
                              <div key={j} style={{ fontSize:12, lineHeight:1.5 }}>
                                <span style={{ color:'var(--muted)' }}>{c.label}: </span>
                                {!baseline && c.from !== null && c.from !== '' && <><span style={{ color:'hsl(var(--color-red))', textDecoration: c.field === 'photo_url' ? 'none' : 'line-through' }}>{auditVal(c.field, c.from, 'from')}</span> <span style={{ color:'var(--muted)' }}>→</span> </>}
                                <span style={{ color: baseline ? 'var(--ink)' : 'hsl(var(--color-green))', fontWeight:600 }}>{auditVal(c.field, c.to, baseline ? 'baseline' : 'to')}</span>
                              </div>
                            ))}
                            {baseline ? <div style={{ fontSize:10.5, color:'var(--muted)', marginTop:2, fontStyle:'italic' }}>earliest recorded state - changes are tracked from here</div>
                              : isAdd ? <div style={{ fontSize:10.5, color:'var(--muted)', marginTop:2, fontStyle:'italic' }}>values set when the item was added</div>
                              : <div style={{ fontSize:10.5, color:'var(--muted)', marginTop:2, fontStyle:'italic' }}>only the fields that changed are shown</div>}
                          </div>
                        ) : <div style={{ fontSize:12, color:'var(--muted)', marginTop:5 }}>No field values changed.</div>
                      ) : (() => {
                        const det = formatAuditDetails(r.action, r.details);
                        return det && det !== '-' ? <div style={{ fontSize:12, color:'var(--muted)', marginTop:4, lineHeight:1.5 }}>{renderNotifBody(det)}</div> : null;
                      })()}
                    </div>
                  </div>
                );
              })}
        </div>
        <div style={{ padding:'12px 22px', borderTop:'1px solid var(--line)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
          {onOpenItem
            ? <button className="secondary-btn" onClick={() => { onOpenItem(item); onClose(); }} style={{ display:'inline-flex', alignItems:'center', gap:6 }}><Pencil size={14} /> Open &amp; Edit This Item</button>
            : <span />}
          <button className="secondary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
