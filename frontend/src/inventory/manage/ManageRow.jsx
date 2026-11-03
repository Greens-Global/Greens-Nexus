// Item Management - A Manage list row (desktop) and card (phone).
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useRef, useEffect, memo } from 'react';
import { Camera, Pencil, Trash2, FileText, User } from 'lucide-react';
import { displayStatus } from '../model/status';
import { cleanField } from '../model/fields';
import { PhotoThumb } from '../ui/photos';
import { TypeBadge, StatusBadge, OpStatusBadge } from '../ui/badges';

// ── Manager Manage Tab ────────────────────────────────────────────────────────
// Memoised rows so toggling ONE checkbox re-renders only that row, not all 360+
// (selecting an item used to repaint the whole table - visible mouse lag). isSelected
// is a boolean and every handler is stable, so memo skips the untouched rows.
export const ManageRow = memo(function ManageRow({ item, isSelected, highlight, onToggle, onEdit, onDelete, onAssign, onDetails, onPreview, canDelete }) {
  const ref = useRef(null);
  useEffect(() => { if (highlight && ref.current) ref.current.scrollIntoView({ behavior:'smooth', block:'center' }); }, [highlight]);
  return (
    <tr ref={ref} style={{ borderTop:'1px solid var(--line)', background: highlight ? 'hsla(40,92%,55%,0.22)' : isSelected ? 'hsla(var(--color-blue),0.05)' : 'transparent', boxShadow: highlight ? 'inset 4px 0 0 hsl(40,92%,50%)' : 'none', transition:'background .9s ease, box-shadow .9s ease' }}>
      <td style={{ padding:'10px 14px' }}>
        {/* Shift-click selects the whole range from the last ticked row (onClick
            carries shiftKey; onMouseDown guard stops shift from selecting text). */}
        <input type="checkbox" checked={isSelected} readOnly
          onClick={e => onToggle(item.id, e.shiftKey)}
          onMouseDown={e => { if (e.shiftKey) e.preventDefault(); }}
          style={{ cursor:'pointer', accentColor:'var(--pine)' }} />
      </td>
      {/* Item - photo + name with make/model/year as a quiet second line; the
          old Photo/Make/Model/Ownership columns folded in here so the face of
          the table stays calm. "Permanent" only tags the exceptions. */}
      <td style={{ padding:'10px 14px', maxWidth:300 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
          {item.photoUrl
            ? <PhotoThumb url={item.photoUrl} size={40} onPreview={onPreview} />
            : (
              <div style={{ width:40, height:40, borderRadius:10, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }} title="Missing photo">
                <Camera size={16} color="hsl(var(--color-red))" />
              </div>
            )
          }
          <div style={{ minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
              {onDetails ? (
                <button onClick={() => onDetails(item)} title="Open item details"
                  style={{ background:'none', border:'none', padding:0, font:'inherit', fontWeight:600, color:'var(--ink)', cursor:'pointer', textAlign:'left', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'hsl(var(--color-blue))'; e.currentTarget.style.textDecoration = 'underline'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink)'; e.currentTarget.style.textDecoration = 'none'; }}>
                  {item.name}
                </button>
              ) : <span style={{ fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</span>}
              {item.ownershipType === 'permanent' && (
                <span style={{ fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:20, background:'hsla(var(--color-purple),0.1)', color:'hsl(var(--color-purple))', flexShrink:0 }}>Permanent</span>
              )}
            </div>
            {(cleanField(item.make) || cleanField(item.model)) && (
              <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {[cleanField(item.make), cleanField(item.model), cleanField(item.year)].filter(Boolean).join(' ')}
              </div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding:'10px 14px', fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize:12, color:'var(--muted)', whiteSpace:'nowrap' }}>{item.serialNumber || '-'}</td>
      <td style={{ padding:'10px 14px' }}><TypeBadge type={item.itemType} /></td>
      <td style={{ padding:'10px 14px', color:'var(--muted)', fontSize:12 }}>{cleanField(item.department) || '-'}</td>
      <td style={{ padding:'10px 14px', color:'var(--muted)', fontSize:12 }}>{cleanField(item.location) || '-'}</td>
      {/* One Status cell: lifecycle badge, with the op-status chip beside it only
          when something is actually flagged (lost/dead/…). */}
      <td style={{ padding:'10px 14px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
          <StatusBadge status={displayStatus(item)} item={item} />
          {item.opStatus && <OpStatusBadge value={item.opStatus} />}
        </div>
      </td>
      {/* Actions pinned to the right so they stay reachable when the table is wider
          than the viewport. Compact aligned icon buttons - labels moved to tooltips
          so every row's actions line up regardless of which ones apply. */}
      <td style={{ padding:'10px 14px', position:'sticky', right:0, background:'var(--card)' }}>
        <div style={{ display:'flex', gap:5, justifyContent:'flex-end' }}>
          {item.ownershipType === 'permanent' && onAssign && (
            <button onClick={() => onAssign(item, item.assignedToEmail ? 'reassign' : 'assign')}
              title={item.assignedToEmail ? `Held by ${item.assignedToName || item.assignedToEmail}${item.location ? ` · at ${item.location}` : ''} - reassign` : item.location ? `At ${item.location} · no person assigned - assign` : 'Assign a person or set a location'}
              aria-label={item.assignedToEmail ? 'Reassign' : 'Assign'}
              style={{ width:28, height:28, display:'inline-flex', alignItems:'center', justifyContent:'center', background:'none', border:'1px solid hsla(var(--color-purple),0.4)', borderRadius:7, color:'hsl(var(--color-purple))', cursor:'pointer' }}>
              <User size={13} />
            </button>
          )}
          {onDetails && (
            <button onClick={() => onDetails(item)} title="All details & custom fields" aria-label="Details"
              style={{ width:28, height:28, display:'inline-flex', alignItems:'center', justifyContent:'center', background:'none', border:'1px solid var(--line)', borderRadius:7, color:'var(--muted)', cursor:'pointer' }}>
              <FileText size={13} />
            </button>
          )}
          <button onClick={() => onEdit(item)} title="Edit item" aria-label="Edit"
            style={{ width:28, height:28, display:'inline-flex', alignItems:'center', justifyContent:'center', background:'none', border:'1px solid var(--line)', borderRadius:7, color:'var(--muted)', cursor:'pointer' }}>
            <Pencil size={13} />
          </button>
          {canDelete && (
            <button onClick={() => onDelete(item)} title="Delete item" aria-label="Delete"
              style={{ width:28, height:28, display:'inline-flex', alignItems:'center', justifyContent:'center', background:'none', border:'1px solid hsla(var(--color-red),0.35)', borderRadius:7, color:'hsl(var(--color-red))', cursor:'pointer' }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
});

export const ManageCard = memo(function ManageCard({ item, isSelected, highlight, onToggle, onEdit, onDelete, onAssign, onDetails, onPreview, canDelete }) {
  const ref = useRef(null);
  useEffect(() => { if (highlight && ref.current) ref.current.scrollIntoView({ behavior:'smooth', block:'center' }); }, [highlight]);
  return (
    <div ref={ref} style={{ border:'1px solid', borderColor: highlight ? 'hsl(40,92%,50%)' : 'var(--line)', borderRadius:12, background: highlight ? 'hsla(40,92%,55%,0.16)' : isSelected ? 'hsla(var(--color-blue),0.05)' : 'var(--card)', padding:'12px 14px', boxShadow: highlight ? '0 0 0 3px hsla(40,92%,50%,0.2)' : 'var(--shadow-sm)', transition:'background .9s ease, box-shadow .9s ease, border-color .9s ease' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <input type="checkbox" checked={isSelected} onChange={() => onToggle(item.id)}
          style={{ cursor:'pointer', accentColor:'var(--pine)', flexShrink:0 }} />
        {item.photoUrl
          ? <PhotoThumb url={item.photoUrl} size={44} onPreview={onPreview} />
          : (
            <div style={{ width:44, height:44, borderRadius:10, background:'hsla(var(--color-red),0.08)', border:'1px dashed hsla(var(--color-red),0.4)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }} title="Missing photo">
              <Camera size={18} color="hsl(var(--color-red))" />
            </div>
          )}
        <div style={{ flex:1, minWidth:0 }}>
          <div onClick={onDetails ? () => onDetails(item) : undefined}
            style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor: onDetails ? 'pointer' : 'default' }}>
            {item.name}
          </div>
          <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {[item.serialNumber, cleanField(item.make), cleanField(item.model), cleanField(item.location)].filter(Boolean).join(' · ') || '-'}
          </div>
        </div>
        <StatusBadge status={displayStatus(item)} item={item} />
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:10, flexWrap:'wrap' }}>
        <TypeBadge type={item.itemType} />
        {item.ownershipType === 'permanent' && (
          <span style={{ fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:20, background:'hsla(var(--color-purple),0.1)', color:'hsl(var(--color-purple))' }}>Permanent</span>
        )}
        {item.opStatus && <OpStatusBadge value={item.opStatus} />}
        <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
          {item.ownershipType === 'permanent' && onAssign && (
            <button className="secondary-btn" onClick={() => onAssign(item, item.assignedToEmail ? 'reassign' : 'assign')}
              style={{ color:'hsl(var(--color-purple))' }}>
              {item.assignedToEmail ? 'Reassign' : 'Assign'}
            </button>
          )}
          {onDetails && <button className="secondary-btn" onClick={() => onDetails(item)}>Details</button>}
          <button className="secondary-btn" onClick={() => onEdit(item)}>Edit</button>
          {canDelete && (
            <button className="secondary-btn" onClick={() => onDelete(item)} style={{ color:'hsl(var(--color-red))' }}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
});
