import { useState, useEffect, useCallback, useMemo, useDeferredValue, memo } from 'react';
import { Package, Search, RotateCcw, AlertCircle, X, ChevronDown, Pencil, MapPin, ClipboardList, History, ShoppingCart, Filter, ZoomIn, ArrowLeft, ChevronRight, Users, User } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks, Spinner } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useInventory } from '../contexts/InventoryContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { useMsal } from '@azure/msal-react';
import { cleanName } from '../lib/utils';
import { useNameResolver } from '../lib/useNameResolver';
import { useAssignments, AssignItemModal } from '../components/Assignments';
import { renderNotifBody } from '../components/NotificationBell';
import { ITEM_TYPES, TYPE_META, displayStatus, MANAGER_CHECKOUT_STATUS_META, DEPARTMENTS } from '../inventory/model/status';
import { cleanField } from '../inventory/model/fields';
import { checkoutDueInfo } from '../inventory/model/due';
import { fmtMoney } from '../inventory/model/format';
import { triggerDownload, downloadItemsCsv } from '../inventory/model/csv';
import { diffItemEdit } from '../inventory/model/itemEdit';
import { formatAuditDetails, fmtAuditStamp, auditEventMeta, _auditFg, _auditBg, buildAuditDiffs, auditDayKey, auditDayLabel, auditTime, auditInitials, EMPTY, buildGlobalFeed, feedUndoInfo, feedSummary } from '../inventory/model/auditFeed';
import { useEscapeKey } from '../inventory/ui/hooks';
import { ImageLightbox } from '../inventory/ui/ImageLightbox';
import { Toast } from '../inventory/ui/Toast';
import { TypeBadge, OpStatusBadge } from '../inventory/ui/badges';
import { HighlightMatch } from '../inventory/ui/HighlightMatch';
import { CartDrawer } from '../inventory/ui/CartDrawer';
import { ReturnModal } from '../inventory/checkout/ReturnModal';
import { runBatchReRequest } from '../inventory/checkout/batchReRequest';
import { MyCheckoutsPanel } from '../inventory/checkout/MyCheckoutsPanel';
import { ManagerCheckoutsTab } from '../inventory/checkout/ManagerCheckoutsTab';
import { ManagerCatalogTab } from '../inventory/catalog/ManagerCatalogTab';
import { EmployeeView } from '../inventory/EmployeeView';
import { AddItemModal } from '../inventory/manage/AddItemModal';
import { EditItemModal } from '../inventory/manage/EditItemModal';
import { DeleteItemModal } from '../inventory/manage/DeleteItemModal';
import { ImportItemsModal } from '../inventory/manage/ImportItemsModal';
import { ReportModal } from '../inventory/manage/ReportModal';
import { ItemDetailsPanel } from '../inventory/manage/ItemDetailsPanel';
import { DeletedItemsModal } from '../inventory/manage/DeletedItemsModal';
import { ManagerManageTab } from '../inventory/manage/ManagerManageTab';
import { OverdueAlertModal } from '../inventory/admin/OverdueAlertModal';

// Borrowed by other modules (asset/App.jsx, components/PurchaseRequests.jsx,
// views/AdminConsole.jsx) - keep these re-exports.
export { AddItemModal } from '../inventory/manage/AddItemModal';
export { ManageTypesModal } from '../inventory/admin/ManageTypesModal';
export { CustomFieldsAdminModal } from '../inventory/admin/CustomFieldsAdminModal';
export { SendAlertModal } from '../inventory/admin/SendAlertModal';

// Interactive per-item history - clicking a log row opens this: the item's whole
// life as a top-to-bottom flow (added → checked out → returned → updated →
// deleted), with who/when and a plain-English note for each step.
function AuditHistoryModal({ item, onClose, onOpenItem }) {
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

// Render an audit field value: photos show as a thumbnail (old = dim/red ring,
// new = green ring), everything else as text. Broken images fall back to a label.
function PhotoChip({ url, kind }) {
  const [err, setErr] = useState(false);
  if (err) return <span style={{ fontSize:11.5, color:'var(--muted)' }}>image</span>;
  return <img src={url} alt="item photo" loading="lazy" onError={() => setErr(true)}
    onClick={() => window.open(url, '_blank', 'noopener')} title="Open full image"
    style={{ width:40, height:40, objectFit:'cover', borderRadius:7, cursor:'zoom-in', verticalAlign:'middle',
      border: `2px solid ${kind === 'from' ? 'hsla(var(--color-red),0.55)' : kind === 'to' ? 'hsl(var(--color-green))' : 'var(--line)'}`,
      opacity: kind === 'from' ? 0.65 : 1 }} />;
}
function auditVal(field, value, kind) {
  if (field === 'photo_url') return value ? <PhotoChip url={value} kind={kind} /> : EMPTY;
  // Show the friendly ownership words everywhere, never the raw "transient" (Neil).
  if (field === 'ownership_type' && value) return value === 'permanent' ? 'Permanent' : 'Temporary';
  return value === '' || value == null ? EMPTY : value;
}

const AuditLogPanel = memo(function AuditLogPanel({ items = [], onOpenItem, onLocate, onChanged }) {
  const [query,   setQuery]   = useState('');
  const [logs,    setLogs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [history, setHistory] = useState(null);   // { id, name } → per-item timeline modal
  const [from,    setFrom]    = useState('');
  const [to,      setTo]      = useState('');
  const [confirmUndo, setConfirmUndo] = useState(null); // audit row id awaiting confirm
  const [undoing,     setUndoing]     = useState(null); // audit row id in flight
  const [expanded,    setExpanded]    = useState(() => new Set()); // cards showing field detail
  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const nameOf = useNameResolver(); // email → real display name (never show a raw email)

  // resource_id → { name, type }: current items first, then anything a log named.
  const meta = useMemo(() => {
    const m = {};
    for (const it of items) if (it.id) m[it.id] = { name: it.name, type: it.itemType };
    for (const log of logs) {
      const rid = log.resource_id;
      if (!rid) continue;
      try { const d = JSON.parse(log.details || '{}'); const nm = d.name || d.item_name; const ty = d.item_type;
        if (!m[rid]) m[rid] = { name: nm || '', type: ty || '' };
        else { if (!m[rid].name && nm) m[rid].name = nm; if (!m[rid].type && ty) m[rid].type = ty; }
      } catch { /* skip */ }
    }
    return m;
  }, [items, logs]);

  const itemFor = (log) => {
    const info = meta[log.resource_id];
    if (info?.name) return { id: log.resource_id || '', name: info.name };
    return log.resource_id ? { id: log.resource_id, name: '' } : null;
  };

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: 300 };
    if (query.trim()) params.q = query.trim();
    api.getItemsAuditLog(params)
      .then(res => { setLogs(res.rows || []); setError(''); })
      .catch(() => setError('Could not load activity log.'))
      .finally(() => setLoading(false));
  }, [query]);
  useEffect(() => { const t = setTimeout(load, query ? 350 : 0); return () => clearTimeout(t); }, [load, query]);

  async function doUndo(entry) {
    const info = feedUndoInfo(entry);
    if (!info) return;
    setConfirmUndo(null);
    setUndoing(entry.row.id);
    try {
      await api.undoAuditEntry(entry.row.id, info.fields || null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e?.message || 'Could not undo that change.');
    } finally {
      setUndoing(null);
    }
  }

  // Build → date-filter → group by day (newest first).
  const groups = useMemo(() => {
    const feed = buildGlobalFeed(logs).filter(e => {
      const k = auditDayKey(e.row.timestamp);
      if (from && k < from) return false;
      if (to   && k > to)   return false;
      return true;
    });
    const gs = [];
    for (const e of feed) {
      const k = auditDayKey(e.row.timestamp);
      let g = gs.find(x => x.k === k);
      if (!g) { g = { k, list: [] }; gs.push(g); }
      g.list.push(e);
    }
    return gs;
  }, [logs, from, to]);

  const shown = groups.reduce((n, g) => n + g.list.length, 0);

  const tone = (action, baseline) => baseline ? 'blue' : auditEventMeta(action).tone;
  const verb = (action, baseline) => baseline ? 'First record' : auditEventMeta(action).verb;

  return (
    <div>
      {/* Detail-reveal animation: rows slide in, the new value flashes green and
          the old value flashes red so the change is obvious at a glance. */}
      <style>{`
        @keyframes auditReveal   { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
        @keyframes auditNewFlash { 0% { background:hsla(145,63%,45%,0.30); } 100% { background:transparent; } }
        @keyframes auditOldFlash { 0% { background:hsla(2,72%,55%,0.24); } 100% { background:transparent; } }
      `}</style>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ flex:1, minWidth:180, maxWidth:300 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search by item, user, or action…" value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="search-clear" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <label style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:5 }}>
            From <input type="date" className="form-input" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} style={{ height:32, fontSize:12, padding:'0 8px' }} />
          </label>
          <label style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:5 }}>
            To <input type="date" className="form-input" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} style={{ height:32, fontSize:12, padding:'0 8px' }} />
          </label>
          {(from || to) && <button className="secondary-btn" style={{ height:32, padding:'0 12px', fontSize:12 }} onClick={() => { setFrom(''); setTo(''); }}>Clear</button>}
        </div>
      </div>
      <p style={{ fontSize:12.5, color:'var(--muted)', margin:'0 0 14px' }}>
        {shown} {shown === 1 ? 'entry' : 'entries'}{(from || to) ? ' in range' : ''} · newest first · edits show <span style={{ color:'hsl(var(--color-red))' }}>old</span> → <span style={{ color:'hsl(var(--color-green))' }}>new</span>, and most changes can be undone
      </p>

      {error ? (
        <ErrorBanner message="Could not load the activity log." onRetry={load} />
      ) : loading ? (
        <SkeletonBlocks count={5} height={56} borderRadius={10} />
      ) : shown === 0 ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)', fontSize:13 }}>
          <History size={28} style={{ opacity:.3, display:'block', margin:'0 auto 8px' }} />
          {query || from || to ? 'No entries match your filters.' : 'No activity yet.'}
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
          {groups.map(g => (
            <div key={g.k}>
              <div style={{ fontSize:10.5, fontWeight:800, letterSpacing:'.08em', textTransform:'uppercase', color:'var(--muted)', margin:'0 0 9px 2px' }}>{auditDayLabel(g.k)}</div>
              <div style={{ display:'flex', flexDirection:'column', gap:9 }}>
                {g.list.map(e => {
                  const r = e.row;
                  const t = tone(r.action, e.baseline);
                  const it = itemFor(r);
                  const typeBadge = meta[r.resource_id]?.type;
                  const undo = feedUndoInfo(e);
                  const summary = feedSummary(e);
                  const det = e.changes ? null : formatAuditDetails(r.action, r.details);
                  const hasDetail = !!(e.changes && e.changes.length);
                  const open = expanded.has(r.id);
                  return (
                    <div key={r.id} style={{ display:'flex', gap:11, padding:'12px 13px', borderRadius:11, border:'1px solid var(--line)', background:'var(--card)', opacity: r.undone_at ? 0.62 : 1 }}>
                      <span style={{ flexShrink:0, width:9, height:9, marginTop:5, borderRadius:'50%', background:_auditFg(t), boxShadow:`0 0 0 3px ${_auditBg(t)}` }} />
                      <div style={{ minWidth:0, flex:1 }}>
                        {/* Header: badge · item name · type · time */}
                        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                          <span style={{ fontSize:10, fontWeight:800, textTransform:'uppercase', letterSpacing:'.04em', padding:'2px 7px', borderRadius:5, color:_auditFg(t), background:_auditBg(t) }}>{verb(r.action, e.baseline)}</span>
                          {it && (it.name
                            ? <span onClick={() => setHistory(it)} title="Open this item’s full history"
                                style={{ fontSize:13, fontWeight:700, color:'var(--ink)', cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'46vw' }}>{it.name}</span>
                            : <span style={{ fontSize:12.5, color:'var(--muted)' }}>#{(it.id || '').slice(0, 8)}</span>)}
                          {typeBadge && <span style={{ fontSize:10.5, fontWeight:600, padding:'2px 7px', borderRadius:5, color:'hsl(var(--color-blue))', background:'hsla(var(--color-blue),0.10)' }}>{typeBadge}</span>}
                          {r.details && (() => { try { const d = JSON.parse(r.details); return d.items ? <span style={{ fontSize:11.5, color:'var(--muted)' }}>· {d.items} items</span> : null; } catch { return null; } })()}
                          <span style={{ marginLeft:'auto', fontSize:11.5, color:'var(--muted)', whiteSpace:'nowrap' }}>{auditTime(r.timestamp)}</span>
                        </div>

                        {/* Plain-English summary + a Show details toggle for the field changes */}
                        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:6, flexWrap:'wrap' }}>
                          <span style={{ fontSize:12.5, color:'var(--ink)', lineHeight:1.5, minWidth:0 }}>
                            {summary != null ? summary : (det && det !== '-' ? renderNotifBody(det) : auditEventMeta(r.action).verb)}
                          </span>
                          {hasDetail && (
                            <button onClick={() => toggleExpand(r.id)}
                              style={{ display:'inline-flex', alignItems:'center', gap:3, padding:'2px 8px', borderRadius:6, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', fontSize:11, fontWeight:700, color:'var(--muted)', fontFamily:'Inter,sans-serif', flexShrink:0 }}>
                              {open ? 'Hide details' : 'Show details'} <ChevronDown size={12} style={{ transform: open ? 'rotate(180deg)' : 'none', transition:'transform .2s' }} />
                            </button>
                          )}
                        </div>
                        {hasDetail && open && (
                          <div style={{ display:'flex', flexDirection:'column', gap:5, padding:'9px 11px', borderRadius:8, background:'var(--mist)', border:'1px solid var(--line)', marginTop:7, animation:'auditReveal .22s ease' }}>
                            {e.changes.map((c, ci) => (
                              <div key={ci} style={{ fontSize:12.5, lineHeight:1.6, wordBreak:'break-word', display:'flex', flexWrap:'wrap', alignItems:'baseline', gap:7, animation:'auditReveal .3s ease both', animationDelay:`${ci * 45}ms` }}>
                                <span style={{ color:'var(--muted)', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em', minWidth:96 }}>{c.label}</span>
                                {!e.baseline && c.from !== null && (
                                  <>
                                    <span style={{ color:'hsl(var(--color-red))', textDecoration: c.field === 'photo_url' ? 'none' : 'line-through', padding:'1px 5px', borderRadius:4, animation:'auditOldFlash 1s ease both', animationDelay:`${ci * 45}ms` }}>{auditVal(c.field, c.from, 'from')}</span>
                                    <span style={{ color:'var(--muted)' }}>→</span>
                                  </>
                                )}
                                <span style={{ fontWeight:700, color: e.baseline ? 'var(--ink)' : 'hsl(var(--color-green))', padding:'1px 5px', borderRadius:4, animation: e.baseline ? 'none' : 'auditNewFlash 1.1s ease both', animationDelay:`${ci * 45}ms` }}>{auditVal(c.field, c.to, e.baseline ? 'baseline' : 'to')}</span>
                              </div>
                            ))}
                            {e.baseline && <div style={{ fontSize:10.5, color:'var(--muted)', fontStyle:'italic', marginTop:2 }}>This is the oldest record we have for this item. Anything changed later shows up as an update above.</div>}
                          </div>
                        )}

                        {/* Undo reason trail */}
                        {e.reason && (
                          <div style={{ marginTop:7, padding:'6px 10px', borderRadius:8, fontSize:12, background:'hsla(40,90%,50%,0.10)', border:'1px solid hsla(40,90%,45%,0.32)', wordBreak:'break-word' }}>
                            <strong style={{ color:'hsl(36,92%,38%)' }}>Reason:</strong> <span style={{ fontStyle:'italic' }}>{e.reason}</span>
                          </div>
                        )}

                        {/* Footer: actor + actions */}
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:8, flexWrap:'wrap' }}>
                          <span title={r.user_email} style={{ flexShrink:0, width:20, height:20, borderRadius:'50%', display:'inline-flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:800, color:'hsl(var(--color-purple))', background:'hsla(var(--color-purple),0.14)' }}>{auditInitials(nameOf(r.user_email, r.user_name))}</span>
                          <span title={r.user_email} style={{ fontSize:12, color:'var(--muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nameOf(r.user_email, r.user_name)}</span>
                          <div style={{ marginLeft:'auto', display:'inline-flex', alignItems:'center', gap:6 }}>
                            {r.undone_at && <span style={{ fontSize:11, fontWeight:700, color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:4 }}><RotateCcw size={12} /> Undone</span>}
                            {it && (it.id || it.name) && onLocate && <button onClick={() => onLocate(it)} title="Find this item in the list"
                              style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 10px', borderRadius:7, border:'1px solid var(--line)', background:'var(--card)', cursor:'pointer', fontSize:11.5, fontWeight:600, color:'hsl(var(--color-blue))', whiteSpace:'nowrap' }}>Open item →</button>}
                            {undo && (undoing === r.id
                              ? <span style={{ fontSize:11.5, color:'var(--muted)', display:'inline-flex', alignItems:'center', gap:5 }}><Spinner size={12} /> Undoing…</span>
                              : <button onClick={() => setConfirmUndo(r.id)} title="Undo this change"
                                  style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 10px', borderRadius:7, border:'1px solid hsla(40,90%,45%,0.5)', background:'hsla(40,90%,50%,0.10)', cursor:'pointer', fontSize:11.5, fontWeight:700, color:'hsl(36,92%,38%)', whiteSpace:'nowrap' }}><RotateCcw size={12} /> Undo</button>)}
                          </div>
                        </div>

                        {/* Inline undo confirmation */}
                        {confirmUndo === r.id && undo && (
                          <div style={{ marginTop:8, padding:'11px 13px', borderRadius:9, border:'1px solid hsla(40,90%,45%,0.5)', background:'hsla(40,90%,50%,0.08)' }}>
                            <div style={{ fontSize:12.5, marginBottom:9 }}>{undo.confirm}</div>
                            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                              <button className="secondary-btn" style={{ fontSize:12.5, padding:'5px 12px' }} onClick={() => setConfirmUndo(null)}>Cancel</button>
                              <button onClick={() => doUndo(e)} style={{ fontSize:12.5, padding:'5px 14px', display:'inline-flex', alignItems:'center', gap:5, background:'hsl(36,92%,42%)', color:'#fff', border:'none', borderRadius:8, fontWeight:700, cursor:'pointer', fontFamily:'Inter,sans-serif' }}><RotateCcw size={13} /> Undo</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {history && <AuditHistoryModal item={history} onClose={() => setHistory(null)} onOpenItem={onOpenItem} />}
    </div>
  );
});

// Neil: clicking an item under a person shows that item's details and picture
// as a card - acting on it still routes through Checkouts / Assignments.
function WhwItemDetailCard({ item, checkout, holderName, onClose, onAct, actLabel }) {
  useEscapeKey(onClose);
  const tm = TYPE_META[item?.itemType || checkout?.itemType] || TYPE_META.Other;
  const name  = item?.name || checkout?.itemName || 'Item';
  const photo = item?.photoUrl || checkout?.checkoutPhotoUrl || null;
  const due   = checkout ? checkoutDueInfo(checkout) : null;
  const inUse = checkout?.status === 'allocated';
  const rows = [
    ['Held by', holderName],
    ['Type', [item?.itemType || checkout?.itemType, item?.department || checkout?.department].filter(Boolean).join(' · ') || '-'],
    item && (item.make || item.model) ? ['Make / Model', [item.make, item.model].filter(Boolean).join(' ')] : null,
    checkout
      ? ['Status', inUse
          ? (due.daysLeft < 0 ? `In use - overdue ${Math.abs(due.daysLeft)}d` : due.daysLeft === 0 ? 'In use - due today' : `In use - ${due.daysLeft}d left`)
          : (MANAGER_CHECKOUT_STATUS_META[checkout.status]?.label || checkout.status)]
      : ['Status', 'Permanently assigned'],
    checkout?.reason ? ['Reason', checkout.reason] : null,
    Number(item?.assetValue) > 0 ? ['Asset value', fmtMoney(Number(item.assetValue))] : null,
  ].filter(Boolean);
  return (
    <div role="dialog" aria-modal="true"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, width:'100%', maxWidth:380, overflow:'hidden', boxShadow:'0 20px 60px rgba(0,0,0,0.25)' }}>
        {/* Full photo, never cropped - the box grows to the image's own ratio */}
        <div style={{ background:'var(--mist)', display:'flex', alignItems:'center', justifyContent:'center', minHeight:120 }}>
          {photo
            ? <img src={photo} alt={name} style={{ width:'100%', maxHeight:'45vh', objectFit:'contain', display:'block' }} />
            : <tm.Icon size={44} color={tm.color} style={{ margin:'38px 0' }} />}
        </div>
        <div style={{ padding:'16px 18px' }}>
          <div style={{ fontWeight:800, fontSize:16, letterSpacing:'-.01em' }}>{name}</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:12 }}>
            {rows.map(([label, value]) => (
              <div key={label} style={{ display:'flex', gap:10, fontSize:13 }}>
                <span style={{ width:92, flexShrink:0, fontSize:10.5, fontWeight:800, letterSpacing:'.06em', color:'var(--muted)', textTransform:'uppercase', paddingTop:2 }}>{label}</span>
                <span style={{ color:'var(--ink)', fontWeight:600, minWidth:0 }}>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:16, justifyContent:'flex-end' }}>
            <button className="secondary-btn" style={{ fontSize:13 }} onClick={onClose}>Close</button>
            {onAct && <button className="primary-btn" style={{ fontSize:13 }} onClick={onAct}>{actLabel} →</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Who Has It Tab ────────────────────────────────────────────────────────────
// Per-person view of every allocation: searchable, split into permanent
// assignments and transient checkouts - Neil's "permanent vs transient" ask.
const WhoHasItTab = memo(function WhoHasItTab({ items, checkouts, onOpenCheckouts }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('person'); // 'person' | 'location' (Neil: split Who Has What)
  const [photoPreview, setPhotoPreview] = useState(null);
  const [detail, setDetail] = useState(null);
  const nameOf = useNameResolver(); // never show a raw email as the holder label (P4 names)

  // Transient: live checkouts grouped by holder
  const holders = useMemo(() => {
    const map = new Map(); // key → { name, transient: [], permanent: [], declared: [] }
    for (const c of checkouts) {
      if (!['approved','pending_receipt','allocated'].includes(c.status) || !c.requestedBy) continue;
      const key = (c.requestedByEmail || c.requestedBy).toLowerCase();
      if (!map.has(key)) map.set(key, { name: nameOf(c.requestedByEmail, c.requestedBy), transient: [], permanent: [], declared: [] });
      map.get(key).transient.push(c);
    }
    // Permanent: only items tagged to a REAL person via the assignment flow.
    // No defaultOwner fallback - that's a department label, not a holder, and
    // it filed unassigned items under whoever added them (Sai's Oneplus bug).
    for (const i of items) {
      if (i.ownershipType !== 'permanent' && i.status !== 'permanently_assigned') continue;
      // A person holder is required here. Location is just where the item lives now
      // (independent of the holder), so a person-held item that also sits at a place
      // still belongs under that person - no location-based exclusion.
      const email = (i.assignedToEmail || '').toLowerCase();
      const owner = (i.assignedToName || '').trim();
      if (!email && !owner) continue;
      const key = email || `perm-${owner.toLowerCase()}`;
      if (!map.has(key)) {
        // Resolve through People so a stale stored name ("Neil") still shows
        // the full directory name ("Neil Kadakia").
        const display = nameOf(email, owner);
        const existing = [...map.values()].find(h => h.name.toLowerCase() === display.toLowerCase() || h.name.toLowerCase() === owner.toLowerCase());
        if (existing) { existing.permanent.push(i); continue; }
        map.set(key, { name: display, transient: [], permanent: [], declared: [] });
      }
      map.get(key).permanent.push(i);
    }
    // Declared statuses (lost/retired) tied to a person - show under that person as
    // Person → Status → Item, so accountability is visible on the same board.
    for (const i of items) {
      if (!i.opStatus) continue;
      const email = (i.opStatusPersonEmail || '').toLowerCase();
      const owner = (i.opStatusPersonName  || '').trim();
      if (!email && !owner) continue;
      const key = email || `decl-${owner.toLowerCase()}`;
      if (!map.has(key)) {
        const display = nameOf(email, owner);
        const existing = [...map.values()].find(h => h.name.toLowerCase() === display.toLowerCase() || h.name.toLowerCase() === owner.toLowerCase());
        if (existing) { existing.declared.push(i); continue; }
        map.set(key, { name: display, transient: [], permanent: [], declared: [] });
      }
      map.get(key).declared.push(i);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [checkouts, items, nameOf]);

  const filtered = useMemo(() => holders.filter(h =>
    !search ||
    h.name.toLowerCase().includes(search.toLowerCase()) ||
    h.transient.some(c => c.itemName.toLowerCase().includes(search.toLowerCase())) ||
    h.permanent.some(i => i.name.toLowerCase().includes(search.toLowerCase())) ||
    h.declared.some(i => i.name.toLowerCase().includes(search.toLowerCase()))
  ), [holders, search]);

  const initials = name => name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  // Neil: "this person's holding $6,000 worth of items" - total value in hand
  const holderValue = h =>
    h.transient.reduce((s, c) => s + (Number(items.find(i => i.id === c.itemId)?.assetValue) || 0), 0) +
    h.permanent.reduce((s, i) => s + (Number(i.assetValue) || 0), 0);

  // By-location view - everything physically AT a place (Neil: "search GSE, see
  // everything that's there"). Groups every item by its location field.
  const places = useMemo(() => {
    const map = new Map();
    for (const i of items) {
      const loc = (i.location || '').trim() || '- No location set -';
      if (!map.has(loc)) map.set(loc, { location: loc, items: [], value: 0 });
      const g = map.get(loc);
      g.items.push(i);
      g.value += Number(i.assetValue) || 0;
    }
    return [...map.values()].sort((a, b) => a.location.localeCompare(b.location));
  }, [items]);
  const filteredPlaces = useMemo(() => places.filter(p =>
    !search || p.location.toLowerCase().includes(search.toLowerCase()) ||
    p.items.some(i => (i.name || '').toLowerCase().includes(search.toLowerCase()))
  ), [places, search]);
  const holderOf = (i) => {
    if (i.assignedToName || i.assignedToEmail) return nameOf(i.assignedToEmail, i.assignedToName);
    const co = checkouts.find(c => c.itemId === i.id && ['approved','pending_receipt','allocated'].includes(c.status));
    return co ? co.requestedBy : '';
  };

  return (
    <div>
      <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:20, flexWrap:'wrap' }}>
        <div className="search-bar" style={{ flex:1, minWidth:220, maxWidth:420, marginBottom:0 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder={view === 'person' ? 'Search by person or item…' : 'Search by location or item…'} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
          {search && <button className="search-clear" onClick={() => setSearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>}
        </div>
        {/* By Person / By Location (Neil: search GSE → see everything there) */}
        <div style={{ display:'inline-flex', border:'1px solid var(--line)', borderRadius:9, overflow:'hidden', flexShrink:0 }}>
          {[['person', 'By person', User], ['location', 'By location', MapPin]].map(([k, label, Icon]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', fontSize:12.5, fontWeight:700, border:'none', cursor:'pointer', fontFamily:'Inter,sans-serif', background: view === k ? 'var(--pine)' : 'var(--card)', color: view === k ? '#fff' : 'var(--muted)' }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'location' ? (
        filteredPlaces.length === 0 ? (
          <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
            <MapPin size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
            {search ? 'No location or item matches your search.' : 'No items yet.'}
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(330px,1fr))', gap:14 }}>
            {filteredPlaces.map(p => (
              <div key={p.location} style={{ border:'1px solid var(--line)', borderRadius:12, background:'var(--card)', boxShadow:'var(--shadow-sm)', overflow:'hidden' }}>
                <div style={{ display:'flex', alignItems:'center', gap:11, padding:'13px 16px', borderBottom:'1px solid var(--line)', background:'var(--mist)' }}>
                  <div style={{ width:34, height:34, borderRadius:9, background:'hsla(var(--color-green),0.14)', color:'hsl(var(--color-green))', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><MapPin size={17} /></div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={p.location} query={search} /></div>
                    <div style={{ fontSize:11.5, color:'var(--muted)' }}>{p.items.length} item{p.items.length !== 1 ? 's' : ''}{p.value > 0 && <> · <strong style={{ color:'var(--ink)' }}>{fmtMoney(p.value)}</strong></>}</div>
                  </div>
                </div>
                <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:6, maxHeight:340, overflowY:'auto' }}>
                  {p.items.map(i => {
                    const who = holderOf(i);
                    return (
                      <div key={i.id} onClick={() => setDetail({ item: i, holderName: who })} title="View item details"
                        style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                        <TypeBadge type={i.itemType} />
                        {who && <span style={{ fontSize:11, color:'var(--muted)', flexShrink:0, maxWidth:90, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{who}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)' }}>
          <Users size={32} style={{ opacity:.25, display:'block', margin:'0 auto 10px' }} />
          {search ? 'Nobody matches your search.' : 'No items are currently allocated to anyone.'}
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(330px,1fr))', gap:14 }}>
          {filtered.map(h => (
            <div key={h.name} style={{ border:'1px solid var(--line)', borderRadius:12, background:'var(--card)', boxShadow:'var(--shadow-sm)', overflow:'hidden' }}>
              {/* Person header - click-through to their orders & actions */}
              <div onClick={() => onOpenCheckouts?.({ q: h.name, segment: h.transient.length ? 'checkouts' : 'assignments' })}
                title={`Open ${h.name}'s checkouts - approve, hand over, force return`}
                style={{ display:'flex', alignItems:'center', gap:11, padding:'13px 16px', borderBottom:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', transition:'background .12s' }}
                onMouseEnter={e => e.currentTarget.style.background = 'hsla(var(--color-blue),0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--mist)'}>
                <div style={{ width:34, height:34, borderRadius:'50%', background:'hsla(var(--color-blue),0.14)', color:'hsl(var(--color-blue))', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12.5, fontWeight:800, flexShrink:0 }}>
                  {initials(h.name)}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:13.5, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={h.name} query={search} /></div>
                  <div style={{ fontSize:11.5, color:'var(--muted)' }}>
                    {h.transient.length > 0 && `${h.transient.length} checked out`}
                    {h.transient.length > 0 && h.permanent.length > 0 && ' · '}
                    {h.permanent.length > 0 && `${h.permanent.length} permanent`}
                    {h.declared.length > 0 && ((h.transient.length > 0 || h.permanent.length > 0) ? ' · ' : '')}
                    {h.declared.length > 0 && `${h.declared.length} declared`}
                    {holderValue(h) > 0 && <> · <strong style={{ color:'var(--ink)' }}>{fmtMoney(holderValue(h))}</strong> in hand</>}
                  </div>
                </div>
                <ChevronRight size={15} style={{ color:'var(--muted)', flexShrink:0 }} />
              </div>

              <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:12 }}>
                {/* Transient */}
                {h.transient.length > 0 && (
                  <div>
                    <div style={{ fontSize:10.5, fontWeight:800, color:'hsl(var(--color-orange))', letterSpacing:'.06em', marginBottom:7 }}>CHECKED OUT (TEMPORARY)</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.transient.map(c => {
                        const { daysLeft } = checkoutDueInfo(c);
                        const inUse = c.status === 'allocated';
                        const itemPhoto = items.find(i => i.id === c.itemId)?.photoUrl || c.checkoutPhotoUrl;
                        return (
                          // Row click → item detail card (photo + facts); the
                          // card's action button deep-links into Checkouts
                          <div key={c.id} onClick={() => setDetail({
                              item: items.find(i => i.id === c.itemId) || null,
                              checkout: c, holderName: h.name,
                              act: () => { setDetail(null); onOpenCheckouts?.({ q: c.itemName }); },
                              actLabel: 'Open in Checkouts',
                            })}
                            title="View item details"
                            style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background: inUse ? (daysLeft < 0 ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))') : 'hsl(var(--color-blue))' }} />
                            <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={c.itemName} query={search} /></span>
                            <span style={{ fontSize:11, color: inUse && daysLeft < 0 ? 'hsl(var(--color-red))' : 'var(--muted)', flexShrink:0, fontWeight: inUse && daysLeft < 0 ? 700 : 400 }}>
                              {inUse
                                ? (daysLeft < 0 ? `overdue ${Math.abs(daysLeft)}d` : daysLeft === 0 ? 'due today' : `${daysLeft}d left`)
                                : MANAGER_CHECKOUT_STATUS_META[c.status]?.label}
                            </span>
                            {itemPhoto && (
                              <button onClick={e => { e.stopPropagation(); setPhotoPreview(itemPhoto); }}
                                title="See the exact item"
                                style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                                <ZoomIn size={12} />
                              </button>
                            )}
                            <ChevronRight size={12} style={{ color:'var(--muted)', flexShrink:0, opacity:.6 }} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Permanent */}
                {h.permanent.length > 0 && (
                  <div>
                    <div style={{ fontSize:10.5, fontWeight:800, color:'hsl(var(--color-blue))', letterSpacing:'.06em', marginBottom:7 }}>PERMANENTLY ASSIGNED</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.permanent.map(i => (
                        // Row click → item detail card; its action button opens
                        // Assignments (force recover / reassign live there)
                        <div key={i.id} onClick={() => setDetail({
                            item: i, holderName: h.name,
                            act: () => { setDetail(null); onOpenCheckouts?.({ segment: 'assignments' }); },
                            actLabel: 'Open in Assignments',
                          })}
                          title="View item details"
                          style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background:'hsl(var(--color-blue))' }} />
                          <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                          <span style={{ fontSize:11, color:'var(--muted)', flexShrink:0 }}>{[i.make, i.model].filter(Boolean).join(' ') || i.itemType}</span>
                          {i.photoUrl && (
                            <button onClick={e => { e.stopPropagation(); setPhotoPreview(i.photoUrl); }}
                              title="See the exact item"
                              style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                          <ChevronRight size={12} style={{ color:'var(--muted)', flexShrink:0, opacity:.6 }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Declared (lost / retired) - Person → Status → Item */}
                {h.declared.length > 0 && (
                  <div>
                    <div style={{ fontSize:10.5, fontWeight:800, color:'hsl(var(--color-red))', letterSpacing:'.06em', marginBottom:7 }}>DECLARED</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      {h.declared.map(i => (
                        <div key={i.id} onClick={() => setDetail({ item: i, holderName: h.name })}
                          title="View item details"
                          style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, cursor:'pointer', borderRadius:7, padding:'4px 6px', margin:'0 -6px', transition:'background .12s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <OpStatusBadge value={i.opStatus} />
                          <span style={{ fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}><HighlightMatch text={i.name} query={search} /></span>
                          {i.photoUrl && (
                            <button onClick={e => { e.stopPropagation(); setPhotoPreview(i.photoUrl); }}
                              title="See the exact item"
                              style={{ background:'none', border:'none', cursor:'zoom-in', color:'var(--muted)', display:'flex', padding:2 }}>
                              <ZoomIn size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <WhwItemDetailCard
          item={detail.item} checkout={detail.checkout} holderName={detail.holderName}
          onAct={detail.act} actLabel={detail.actLabel}
          onClose={() => setDetail(null)}
        />
      )}
      {photoPreview && <ImageLightbox src={photoPreview} onClose={() => setPhotoPreview(null)} />}
    </div>
  );
});

// ── Main view ─────────────────────────────────────────────────────────────────
const INV_VALID_TABS = ['myitems','catalog','manage','checkouts','whohasit','audit'];

export default function InventoryManagement({ activeSub }) {
  const {
    items, itemsLoading, itemsError,
    checkouts, checkoutsLoading, checkoutsError,
    submitCartCheckouts, approveRequest, rejectRequest,
    allocateItem, initiateHandover, confirmReceipt, returnItem, cancelRequest,
    refreshItems, refreshCheckouts,
    patchItemLocal, removeItemsLocal, addItemLocal,
  } = useInventory();
  const { addNotification } = useNotifications();
  const { can, canAccessModule, loading: roleLoading } = useRole();
  const { accounts } = useMsal();
  const userName  = cleanName(accounts[0]?.name ?? 'Employee');
  const userEmail = (accounts[0]?.username ?? '').toLowerCase();

  // Manager tier OR an Access-Group/job-role grant of Item Management at
  // editor+ (grants layer additively - an Employee-tier person with the
  // "Item Management: Full" grant gets the full Manage experience).
  const isManager = canAccessModule('inventory', 'manager', 'editor');
  const canDelete = canAccessModule('inventory', 'owner', 'full');

  const pendingCount   = checkouts.filter(c => c.status === 'pending').length;
  const approvedCount  = checkouts.filter(c => c.status === 'approved').length;
  const myActiveCount  = checkouts.filter(c =>
    ['pending','approved','pending_receipt','allocated'].includes(c.status) &&
    ((c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName)
  ).length;
  const myTotalCount   = checkouts.filter(c =>
    (c.requestedByEmail && c.requestedByEmail.toLowerCase() === userEmail) || c.requestedBy === userName
  ).length;

  // Cart - DB-backed, survives logout and device switches
  const { assignments, refreshAssignments } = useAssignments();
  const [assigningItem, setAssigningItem] = useState(null); // {item, mode}
  const [cart,        setCart]        = useState([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [cartBusy,    setCartBusy]    = useState(false);
  const [returningCo, setReturningCo] = useState(null);

  useEffect(() => {
    api.getItemCart().then(rows => {
      setCart(rows.map(r => ({ id: r.id, item: { id: r.itemId, name: r.itemName, itemType: r.itemType }, days: 1 })));
    }).catch(() => {});
  }, []);

  const inCart = useMemo(() => new Set(cart.map(c => c.item.id)), [cart]);
  // Items flagged picture_required=false - every photo step for them is optional
  const photoOptionalIds = useMemo(() => new Set(items.filter(i => i.pictureRequired === false).map(i => i.id)), [items]);
  const addToCart = useCallback(item => {
    if (inCart.has(item.id)) return;
    const optimisticId = `cart-${Date.now()}`;
    setCart(prev => [...prev, { id: optimisticId, item, days: 1 }]);
    api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
      .then(saved => setCart(prev => prev.map(c => c.id === optimisticId ? { id: saved.id, item, days: 1 } : c)))
      // P4: surface the failure instead of the row silently disappearing.
      .catch(err => { setCart(prev => prev.filter(c => c.id !== optimisticId)); toast(err?.message || 'Could not add item to cart.', 'error'); });
    // `toast` intentionally omitted: it's a stable useCallback declared lower in
    // this component, so listing it here read it in the temporal dead zone and
    // crashed the whole view ("Cannot access 'toast' before initialization").
  }, [inCart]); // eslint-disable-line react-hooks/exhaustive-deps
  function removeFromCart(cartId) {
    const entry = cart.find(c => c.id === cartId);
    setCart(prev => prev.filter(c => c.id !== cartId));
    // P4: on failure, restore the row and tell the user rather than swallowing it.
    if (entry) api.removeItemFromCart(entry.item.id).catch(err => { setCart(prev => prev.some(c => c.id === cartId) ? prev : [...prev, entry]); toast(err?.message || 'Could not remove item from cart.', 'error'); });
  }
  // Catalog cards only know the item, not its cart row id - resolve it here so
  // the "In cart" pill on the card can double as a remove button (Pranshu: it
  // was just a disabled label before, no way back off the cart from the card).
  function removeFromCartByItemId(itemId) {
    const entry = cart.find(c => c.item.id === itemId);
    if (entry) removeFromCart(entry.id);
  }
  function handleDaysChange(cartId, days) {
    setCart(prev => prev.map(c => c.id === cartId ? { ...c, days } : c));
  }
  async function handleSubmitCart({ reason, approverEmail, approverName, forName = '', forEmail = '' }) {
    setCartBusy(true);
    const results = await submitCartCheckouts(cart, { reason, raisedBy: userName, raisedByEmail: userEmail, forName, forEmail, approverEmail, approverName });
    const succeededItems = cart.filter((_, i) => results[i].status === 'fulfilled');
    const failedItems    = cart.filter((_, i) => results[i].status === 'rejected');
    await Promise.all(succeededItems.map(c => api.removeItemFromCart(c.item.id).catch(() => {})));
    setCartBusy(false); setCartOpen(false); setCart(failedItems);
    if (succeededItems.length > 0) {
      toast(`${succeededItems.length} checkout${succeededItems.length !== 1 ? 's' : ''} submitted.`);
      // Land on My Items → Active Checkouts to see the fresh order's trackers
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: 'active-checkouts' } }));
    }
    if (failedItems.length > 0) {
      const allConflict = results.filter(r => r.status === 'rejected').every(r => r.reason?.message?.includes('active checkout'));
      toast(
        <div>
          <div style={{ fontWeight:700, marginBottom:5 }}>
            {failedItems.length} item{failedItems.length !== 1 ? 's' : ''} couldn't be submitted
          </div>
          <ul style={{ margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:2 }}>
            {failedItems.map((c, i) => <li key={i} style={{ fontSize:12 }}>{c.item.name}</li>)}
          </ul>
          {allConflict && <div style={{ fontSize:11.5, color:'var(--muted)', marginTop:5 }}>Each already has an active checkout request.</div>}
        </div>,
        'error'
      );
    }
  }

  // Manager-only tab/modal state
  // Remember the last tab so a page refresh keeps you where you were instead of
  // bouncing back to Catalog. Explicit navigation (activeSub / nexus:navigate)
  // still wins over this saved default below.
  const [mainTab, setMainTab] = useState(() => {
    try { const s = localStorage.getItem('nexus_inv_tab'); if (s && INV_VALID_TABS.includes(s)) return s; } catch { /* ignore */ }
    return 'catalog';
  });
  useEffect(() => { try { localStorage.setItem('nexus_inv_tab', mainTab); } catch { /* ignore */ } }, [mainTab]);
  // Managers land on the normal employee screen; the full management UI lives behind
  // a "Manage" tab they opt into (Neil). A deep-link to a management tab enters it.
  const [manageMode, setManageMode] = useState(false);
  // Who Has What → Checkouts deep-link: carries the person/item to prefill the
  // search so the landing view is already scoped to what was clicked.
  const [checkoutsPrefilter, setCheckoutsPrefilter] = useState(null);
  const openInCheckouts = useCallback(filter => {
    setCheckoutsPrefilter({ ...filter, ts: Date.now() }); // ts: re-trigger on same target
    setMainTab('checkouts');
  }, []);

  // Deep-link: NotificationBell navigates with ('inventory', subTab) - land on
  // that tab instead of the default Catalog so the click shows the relevant info.
  const VALID_SUBTABS = INV_VALID_TABS;
  // 'permanent' / 'active-checkouts' are sub-tabs inside My Items;
  // 'checkouts-completed' is the Completed filter inside Checkouts
  // (the inner components pick these up from the same event)
  const resolveSub = sub =>
    (sub === 'permanent' || sub === 'active-checkouts') ? 'myitems'
    : (sub === 'checkouts-completed' || sub === 'assignment-returns' || sub === 'handover') ? 'checkouts'
    : sub;
  useEffect(() => {
    const t = resolveSub(activeSub);
    if (t && VALID_SUBTABS.includes(t)) { setMainTab(t); setManageMode(true); }
  }, [activeSub]); // eslint-disable-line react-hooks/exhaustive-deps
  // Window event covers repeat clicks where activeSub doesn't change value
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      const t = resolveSub(sub);
      if (view === 'inventory' && t && VALID_SUBTABS.includes(t)) { setMainTab(t); setManageMode(true); }
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [deptFilter,    setDeptFilter]    = useState('All');
  const [typeFilter,    setTypeFilter]    = useState('All');
  // Master ownership filter: All | transient (temporary) | permanent.
  // Lets managers filter permanent items out of Catalog/Manage (Neil, Jun 16).
  // Default the ownership filter to Temporary (Neil: opening to hundreds of items
  // is overwhelming; lead with the checkout-able/temporary ones). One click to All.
  // Catalog is the employee browse view - they check out Temporary items and have
  // no reason to see Permanent ones, so it leads with Temporary. Manage is the
  // manager view and shows All ownership. The default resets per tab when you
  // switch between the two (Neil).
  const [ownershipFilter, setOwnershipFilter] = useState('transient');
  const [locationFilter, setLocationFilter] = useState('All');
  const [modelFilter,    setModelFilter]    = useState('All');
  // Which KPI tile (Manage tab) is narrowing the list, if any - clicking a tile
  // toggles it on/off; it's a bucket on top of the dropdown filters, not a
  // replacement for them (Neil: cards were dead placeholders, make them act
  // like the filter chips everywhere else in the app).
  const [cardFilter,    setCardFilter]      = useState(null);
  // Reset the ownership default when moving between the employee (Catalog) and
  // manager (Manage) views - Temporary-only vs All.
  useEffect(() => {
    if (mainTab === 'catalog')     setOwnershipFilter('transient');
    else if (mainTab === 'manage') setOwnershipFilter('All');
    setCardFilter(null);
  }, [mainTab]);
  // Type filter auto-populates from the data so imported types (e.g. "IP Camera")
  // appear alongside the built-in ones; "Other" stays last.
  // Ankush: when a DEPARTMENT is selected, hide types that department never has
  // (Ops has no networking, IT has no vehicles) - derived from the live data so
  // the full set still exists system-wide. With "All departments" we show
  // everything, keeping the complexity available.
  const typeOptions = useMemo(() => {
    if (deptFilter === 'All') {
      const base = ITEM_TYPES.filter(t => t !== 'Other');
      const custom = [...new Set(items.map(i => (i.itemType || '').trim()).filter(Boolean))]
        .filter(t => !ITEM_TYPES.includes(t)).sort();
      return [...base, ...custom, 'Other'];
    }
    const present = new Set(items.filter(i => (i.department || '') === deptFilter)
      .map(i => (i.itemType || '').trim()).filter(Boolean));
    const builtins = ITEM_TYPES.filter(t => t !== 'Other' && present.has(t));
    const custom   = [...present].filter(t => !ITEM_TYPES.includes(t)).sort();
    return [...builtins, ...custom, ...(present.has('Other') ? ['Other'] : [])];
  }, [items, deptFilter]);
  // If the selected type isn't valid for the chosen department, fall back to All
  // so the list never shows zero items because of a stale, now-hidden type.
  useEffect(() => {
    if (typeFilter !== 'All' && !typeOptions.includes(typeFilter)) setTypeFilter('All');
  }, [typeOptions, typeFilter]);
  // Location filter populates entirely from the data (locations come from the import).
  const locationOptions = useMemo(() =>
    [...new Set(items.map(i => (i.location || '').trim()).filter(Boolean))].sort(),
  [items]);
  // Model filter - derived from the data, scoped to the chosen department + type so
  // the list stays relevant (you don't see every model in the company at once).
  const modelOptions = useMemo(() => {
    const pool = items.filter(i =>
      (deptFilter === 'All' || (i.department || '') === deptFilter) &&
      (typeFilter === 'All' || (i.itemType || '') === typeFilter));
    return [...new Set(pool.map(i => cleanField(i.model)).filter(Boolean))].sort();
  }, [items, deptFilter, typeFilter]);
  // Drop a stale model selection when dept/type narrows it away.
  useEffect(() => {
    if (modelFilter !== 'All' && !modelOptions.includes(modelFilter)) setModelFilter('All');
  }, [modelOptions, modelFilter]);
  const [search,        setSearch]        = useState('');
  // Items scoped to the active filters - the KPI tiles must follow ALL of them
  // (department, ownership, location, type), not show company-wide totals (Sai).
  const deptItems = useMemo(
    () => items.filter(i =>
      (deptFilter === 'All' || (i.department || '') === deptFilter) &&
      (ownershipFilter === 'All' || (i.ownershipType || 'transient') === ownershipFilter) &&
      (locationFilter === 'All' || (i.location || '') === locationFilter) &&
      (typeFilter === 'All' || (i.itemType || '') === typeFilter) &&
      (modelFilter === 'All' || cleanField(i.model) === modelFilter)
    ),
    [items, deptFilter, ownershipFilter, locationFilter, typeFilter, modelFilter]
  );
  // Deferred copy keeps the input responsive: tabs re-filter at low priority
  // instead of blocking every keystroke.
  const deferredSearch = useDeferredValue(search);
  const [addItemOpen,   setAddItemOpen]   = useState(false);
  const [editingItem,   setEditingItem]   = useState(null);
  const [detailsItem,   setDetailsItem]   = useState(null);        // item Details slide-over (Ankush)
  const [deletingItem,  setDeletingItem]  = useState(null);
  const [deletedOpen,   setDeletedOpen]   = useState(false);       // recycle bin
  const [highlightItemId,    setHighlightItemId]    = useState(null); // Manage row to glow (Audit "Open item")
  const [deletedHighlightId, setDeletedHighlightId] = useState(null); // Recycle Bin row to glow
  // Manage Types / Add Custom Field / generic Send Alert moved to the Admin
  // module in full (Pranshu, Sep 9) - no local open-state for them here any
  // more; ManageTypesModal / CustomFieldsAdminModal / SendAlertModal stay
  // exported from this file since Admin still borrows them from here.
  const [importOpen,    setImportOpen]    = useState(false);
  const [reportOpen,    setReportOpen]    = useState(false);
  const [reportInitial, setReportInitial] = useState(null); // seeds the report with the active filters
  const [overdueAlertOpen, setOverdueAlertOpen] = useState(false); // person-grouped overdue alert (default)
  // Admin-defined custom field definitions - loaded once, surfaced in the Details
  // panel and editable via the Custom Fields modal.
  const [customFields, setCustomFields] = useState([]);
  const refreshCustomFields = useCallback(() => {
    api.getItemCustomFields().then(setCustomFields).catch(() => {});
  }, []);
  useEffect(() => { refreshCustomFields(); }, [refreshCustomFields]);
  // Manager-curated item types - loaded from the server (falls back to the static
  // list). Used by the Add/Edit/Batch dropdowns and the Manage Types modal.
  const [itemTypes, setItemTypes] = useState(ITEM_TYPES);
  const refreshItemTypes = useCallback(() => {
    api.getItemTypes().then(t => setItemTypes(Array.isArray(t) && t.length ? t : ITEM_TYPES)).catch(() => {});
  }, []);
  useEffect(() => { refreshItemTypes(); }, [refreshItemTypes]);

  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, kind = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts(prev => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), kind === 'error' ? 6000 : 4000);
  }, []);
  const dismissToast = id => setToasts(prev => prev.filter(t => t.id !== id));

  function handleAddItem(data, opts = {}) {
    return api.createItem(data)
      .then(created => {
        addItemLocal(created); toast(`Added "${data.name}" to the catalog.`);
        // Permanent item + "assign right away" → straight into the normal
        // assign flow (acceptance + photo), same as the Manage-tab button
        if (opts.assignNow && created?.id) setAssigningItem({ item: created, mode: 'assign' });
        // "Let AI find a photo" - fire-and-forget, photo lands via refresh
        if (opts.aiFill && created?.id) {
          toast(`AI is finding a photo for "${data.name}"…`);
          api.autoFillItemPhotos([created.id], false)
            .then(() => { refreshItems(); })
            .catch(() => {});
        }
      })
      .catch(err => { toast(err?.message || 'Could not add item.', 'error'); throw err; });
  }
  function handleEditItem(item, data) {
    // Only send what actually changed, so the audit log shows the real edit.
    const changed = diffItemEdit(item, data);
    if (Object.keys(changed).length === 0) { toast('No changes to save.'); return Promise.resolve(); }
    return api.updateItem(item.id, changed)
      .then(updated => { patchItemLocal(updated); toast(`Updated "${data.name}".`); })
      .catch(err => { toast(err?.message || 'Could not save changes.', 'error'); throw err; });
  }
  function handleDeleteItem(item) {
    return api.deleteItem(item.id)
      .then(() => { removeItemsLocal(item.id); toast(`Deleted "${item.name}".`); setDeletingItem(null); })
      .catch(err => { toast(err?.message || 'Could not delete item.', 'error'); throw err; });
  }
  function handleImport(rows) {
    return api.importItems(rows)
      .then(res => {
        refreshItems();
        toast(`Imported ${res.created} item${res.created !== 1 ? 's' : ''}${res.updated ? `, updated ${res.updated}` : ''}.`);
        // The import can extend the type list - pull the new types in and say so.
        const added = res.added_types || [];
        if (added.length) {
          refreshItemTypes();
          toast(`Added ${added.length} new type${added.length !== 1 ? 's' : ''}: ${added.join(', ')}.`);
        }
        return res;
      })
      .catch(err => { toast(err?.message || 'Import failed.', 'error'); throw err; });
  }

  // Stable handlers so the memoized tab components skip re-renders when
  // unrelated state (toasts, cart, modals) changes in this component.
  const openReturn = useCallback(co => setReturningCo(co), []);
  const cancelCo = useCallback((co, opts = {}) => cancelRequest(co.id, userName)
    .then(() => { if (!opts.silent) toast('Checkout cancelled.'); })
    .catch(() => { if (!opts.silent) toast('Could not cancel.', 'error'); }), [cancelRequest, userName, toast]);
  const selfAllocate = useCallback(co => allocateItem(co.id, userName)
    .then(() => toast(`Confirmed - ${co.itemName} is with you.`))
    .catch(() => toast('Could not confirm.', 'error')), [allocateItem, userName, toast]);
  // Manager accepting their OWN approved checkout: must upload a handover photo
  // just like an employee does - receipts are evidence (Jun 16 bug: this path
  // skipped the photo modal and auto-accepted). Throws on failure so the modal
  // surfaces the error and stays open.
  const handleSelfAccept = useCallback((co, url, name) =>
    allocateItem(co.id, userName, url, name)
      .then(() => toast(`Confirmed - ${co.itemName} is with you.`))
      .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); }),
    [allocateItem, userName, toast]);
  const openAdd       = useCallback(() => setAddItemOpen(true), []);
  const openImport    = useCallback(() => setImportOpen(true), []);
  const openReport    = useCallback((ctx) => { setReportInitial(ctx || null); setReportOpen(true); }, []);
  const openSendAlert = useCallback(() => setOverdueAlertOpen(true), []);
  const exportCsv     = useCallback((rows) => downloadItemsCsv(Array.isArray(rows) && rows.length ? rows : items, customFields), [items, customFields]);
  // "All Items → PDF": route through the report export with no filters applied.
  const exportAllPdf  = useCallback(() => {
    api.getItemsReport({ format:'pdf' })
      .then(({ blob, filename }) => triggerDownload(filename, blob))
      .catch(() => toast('Could not generate the PDF.', 'error'));
  }, [toast]);
  const openAssign    = useCallback((item, mode) => setAssigningItem({ item, mode }), []);
  const refreshAssignmentsAndItems = useCallback(() => { refreshAssignments(); refreshItems(); }, [refreshAssignments, refreshItems]);
  const handleConfirmReceipt = useCallback((co, batch, photoMap) =>
    confirmReceipt(co.id, userName, photoMap[co.id]?.url || '', photoMap[co.id]?.name || '')
      .catch(() => { throw new Error(`Could not confirm receipt for ${co.itemName}.`); }),
    [confirmReceipt, userName]);
  const handleReturnAll = useCallback(async (cos, data) => {
    // P1-5: count real successes/failures rather than always claiming all N returned.
    let ok = 0, failed = 0;
    for (const c of cos) {
      try { await returnItem(c.id, data); ok++; } catch { failed++; }
    }
    refreshCheckouts();
    if (failed === 0) toast(`Returned ${ok} item${ok !== 1 ? 's' : ''}.`);
    else toast(`Returned ${ok} · ${failed} failed.`, 'error');
  }, [returnItem, toast, refreshCheckouts]);
  const handleRequestExtension = useCallback((co, days, reason) =>
    api.requestItemExtension(co.id, { days, reason })
      .then(() => { toast(`Extension requested for ${co.itemName} - awaiting approval.`); refreshCheckouts(); }),
    [toast, refreshCheckouts]);
  const handleReRequest = useCallback(async (co, newReason) => {
    try {
      await api.createItemCheckout({
        id: crypto.randomUUID(),
        item_id: co.itemId, item_name: co.itemName, item_type: co.itemType,
        requested_by: co.requestedBy, requested_by_email: co.requestedByEmail || userEmail,
        raised_by: userName, department: co.department, days: co.days || 1,
        reason: newReason,
        order_id: co.orderId || null,            // rejoin the original order, not a new solo card
        approver_email: co.approverEmail || '', approver_name: co.approverName || '',
      });
      toast(`Re-submitted request for ${co.itemName}.`);
      refreshCheckouts();
    } catch (err) {
      toast(err?.message || `Could not re-submit request for ${co.itemName}.`, 'error');
      throw err; // panel must not clear the rejected card on failure
    }
  }, [userEmail, userName, toast, refreshCheckouts]);
  const handleBatchReRequest = useCallback((cos, vals) =>
    runBatchReRequest(cos, vals, { submitCartCheckouts, userName, userEmail, toast }),
    [submitCartCheckouts, userName, userEmail, toast]);

  if (roleLoading) return <SkeletonBlocks count={6} height={56} borderRadius={10} />;

  // Items assigned to me still awaiting my acceptance - persistent callout; the
  // 7s toast alone is easy to miss (Neil couldn't find where his iPhone landed).
  const awaitingAcceptance = assignments.filter(a => a.assigneeEmail === userEmail && a.status === 'pending_acceptance').length;
  const goAccept = () => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view:'inventory', sub:'permanent' } }));
  const acceptBanner = awaitingAcceptance > 0 ? (
    <div role="button" tabIndex={0} onClick={goAccept} onKeyDown={e => e.key === 'Enter' && goAccept()}
      style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, marginBottom:14,
               background:'hsla(var(--color-blue),0.08)', border:'1px solid hsla(var(--color-blue),0.35)', cursor:'pointer' }}>
      <Package size={16} style={{ color:'hsl(var(--color-blue))', flexShrink:0 }} />
      <span style={{ fontSize:13, color:'var(--ink)' }}>
        <strong>{awaitingAcceptance} item{awaitingAcceptance !== 1 ? 's' : ''}</strong> assigned to you - waiting for your acceptance.
      </span>
      <span style={{ marginLeft:'auto', fontSize:12.5, fontWeight:700, color:'hsl(var(--color-blue))', whiteSpace:'nowrap' }}>Review →</span>
    </div>
  ) : null;

  // Everyone lands on the normal employee screen. Managers get a "Manage" tab on it
  // that flips into the full management UI below (Neil). Employees never see it.
  if (!isManager || !manageMode) {
    return (
      <>
        {acceptBanner}
        <EmployeeView
          items={items} checkouts={checkouts} activeSub={activeSub}
          userName={userName} userEmail={userEmail}
          itemsLoading={itemsLoading} itemsError={itemsError}
          onReturn={returnItem}
          refreshItems={refreshItems} refreshCheckouts={refreshCheckouts}
          submitCartCheckouts={submitCartCheckouts}
          cancelRequest={cancelRequest}
          allocateItem={allocateItem}
          initiateHandover={initiateHandover}
          confirmReceipt={confirmReceipt}
          addNotification={addNotification}
          toast={toast}
          showManage={isManager} onEnterManage={() => { setMainTab('manage'); setManageMode(true); }}
        />
        <Toast toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // The filter selects, rendered directly above the table on Catalog and Manage
  // (no longer in the page header - Neil: filters must sit in one consistent spot,
  // not jump around). Any filter that isn't on "All" gets a tinted background so
  // it's obvious one is active and nothing is silently hidden.
  const baseSel   = { padding:'6px 10px', fontSize:13, height:34, width:'auto' };
  const activeSel = v => (v && v !== 'All')
    ? { borderColor:'var(--pine)', background:'hsla(var(--color-green),0.12)', fontWeight:700, color:'var(--ink)' }
    : null;
  const filterSelects = (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <Filter size={13} style={{ color:'var(--muted)' }} />
        <select className="form-input" value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{ ...baseSel, minWidth:150, ...activeSel(deptFilter) }}>
          {DEPARTMENTS.map(d => <option key={d} value={d}>{d === 'All' ? 'All departments' : d}</option>)}
        </select>
      </div>
      <select className="form-input" value={locationFilter} onChange={e => setLocationFilter(e.target.value)} style={{ ...baseSel, minWidth:130, ...activeSel(locationFilter) }}>
        <option value="All">All locations</option>
        {locationOptions.map(l => <option key={l}>{l}</option>)}
      </select>
      <select className="form-input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ ...baseSel, minWidth:110, ...activeSel(typeFilter) }}>
        <option value="All">All types</option>
        {typeOptions.map(t => <option key={t}>{t}</option>)}
      </select>
      <select className="form-input" value={modelFilter} onChange={e => setModelFilter(e.target.value)} style={{ ...baseSel, minWidth:120, ...activeSel(modelFilter) }}>
        <option value="All">All models</option>
        {modelOptions.map(m => <option key={m}>{m}</option>)}
      </select>
      <select className="form-input" value={ownershipFilter} onChange={e => setOwnershipFilter(e.target.value)} style={{ ...baseSel, minWidth:130, ...activeSel(ownershipFilter) }}>
        <option value="All">All ownership</option>
        <option value="transient">Temporary</option>
        <option value="permanent">Permanent</option>
      </select>
    </>
  );

  return (
    <div style={{ animation:'fadeIn var(--transition-normal) ease-in-out' }}>
      {acceptBanner}
      {/* Header */}
      <div className="view-header" style={{ marginBottom:0 }}>
        <div className="view-title-group">
          {/* Leave the manager-only Manage UI, back to the normal employee screen. */}
          <button onClick={() => setManageMode(false)}
            style={{ display:'inline-flex', alignItems:'center', gap:6, background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:12.5, fontFamily:'Inter,sans-serif', padding:'0 0 4px', fontWeight:600 }}
            onMouseEnter={e => e.currentTarget.style.color='var(--ink)'} onMouseLeave={e => e.currentTarget.style.color='var(--muted)'}>
            <ArrowLeft size={13} /> Exit Manage
          </button>
          <h2>Item Management <span style={{ fontSize:13, fontWeight:700, color:'hsl(var(--color-purple))', verticalAlign:'middle' }}>· Manage</span></h2>
          <p>Browse company assets and check out what you need</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          {/* Filters no longer live in the header - each tab renders them directly
              above its own table so they never jump around between tabs (Neil). */}
          {/* Cart last: it's the one control visible on every tab, so it anchors
              the right edge instead of floating next to hidden filters */}
          {/* header-cart: phones pin this to ONE fixed spot (title row, top
              right) on every tab - no FAB, no drifting (Visesh) */}
          <button className="header-cart"
            style={{ display:'inline-flex', alignItems:'center', gap:7, position:'relative', background:'#000', color:'#fff', border:'1px solid #000', borderRadius:9, fontWeight:700, padding:'8px 18px', cursor:'pointer', fontFamily:'Inter,sans-serif' }}
            onClick={() => setCartOpen(true)}>
            <ShoppingCart size={14} /> Cart
            {cart.length > 0 && (
              <span style={{ position:'absolute', top:-7, right:-1, background:'hsl(var(--color-red))', color:'#fff', borderRadius:'50%', width:17, height:17, fontSize:10, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>
                {cart.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Tab strip - desktop only; on phones the bottom action bar replaces it */}
      {/* Manager tabs - desktop renders them centered in the top header; on
          phones the bottom action bar replaces them (mobileInline off, same as
          the old `.im-tabs { display:none }` rule). */}
      <ModuleTabs mobileInline={false}
        tabs={[
          { key:'myitems',      label:'My Items',          Icon: User,         badge: myActiveCount          },
          { key:'catalog',      label:'Catalog',           Icon: Package                                     },
          { key:'manage',       label:'Manage',            Icon: ClipboardList                               },
          { key:'checkouts',    label:'Checkouts',         Icon: ShoppingCart, badge: pendingCount + approvedCount },
          { key:'whohasit',     label:'Who Has What',      Icon: Users                                       },
          { key:'audit',        label:'Activity Log',      Icon: History                                     },
        ]}
        active={mainTab} onChange={setMainTab} />

      {/* Pending approvals banner - below the tab strip so the nav itself never moves */}
      {pendingCount > 0 && (
        <div onClick={() => setMainTab('checkouts')}
          style={{ margin:'0 0 16px', background:'hsla(var(--color-orange),0.1)', border:'1px solid hsla(var(--color-orange),0.35)', borderRadius:12, padding:'12px 18px', display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
          <AlertCircle size={18} color="hsl(var(--color-orange))" style={{ flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <span style={{ fontWeight:700, fontSize:13.5 }}>{pendingCount} checkout request{pendingCount !== 1 ? 's' : ''} waiting for your approval</span>
            <span style={{ fontSize:12, color:'var(--muted)', marginLeft:8 }}>Tap to review</span>
          </div>
          <ChevronRight size={16} style={{ color:'var(--muted)', flexShrink:0 }} />
        </div>
      )}

      {/* KPI strip now renders INSIDE the Manage tab, below its search/filter bar,
          so the toolbar sits at the same height on every tab (Neil: stop the
          search/filters jumping up and down). */}

      {/* Tab content */}
      {mainTab === 'catalog' && (
        <ManagerCatalogTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} ownershipFilter={ownershipFilter} locationFilter={locationFilter} modelFilter={modelFilter} search={deferredSearch}
          searchValue={search} onSearchChange={setSearch}
          refreshItems={refreshItems} onAddToCart={addToCart} onRemoveFromCart={removeFromCartByItemId} inCart={inCart}
          checkouts={checkouts} userEmail={userEmail} userName={userName}
          onReturn={openReturn} onCancel={cancelCo}
          onSelfAllocate={selfAllocate}
          filterControls={filterSelects}
        />
      )}
      {mainTab === 'manage' && (
        <ManagerManageTab
          items={items} itemsLoading={itemsLoading} itemsError={itemsError}
          deptFilter={deptFilter} typeFilter={typeFilter} ownershipFilter={ownershipFilter} locationFilter={locationFilter} modelFilter={modelFilter} search={deferredSearch}
          searchValue={search} onSearchChange={setSearch}
          refreshItems={refreshItems} canDelete={canDelete}
          onAdd={openAdd} onEdit={setEditingItem}
          onDelete={setDeletingItem} onImport={openImport}
          onExport={exportCsv} onExportAllPdf={exportAllPdf} onReport={openReport}
          checkouts={checkouts} toast={toast}
          onAssign={openAssign} onDetails={setDetailsItem}
          onShowDeleted={() => setDeletedOpen(true)}
          // Manage Types / Add Custom Field moved to the Admin module in full
          // (Pranshu, Sep 9) - no longer triggered from here.
          itemTypes={itemTypes}
          highlightId={highlightItemId} onHighlightDone={() => setHighlightItemId(null)}
          filterControls={filterSelects}
          cardFilter={cardFilter}
          kpiStrip={
            <div className="kpi-grid" style={{ gridTemplateColumns:'repeat(auto-fit, minmax(104px, 1fr))', gap:8, margin:'0 0 16px' }}>
              {/* Tiles now cover every lifecycle bucket so the counts reconcile against
                  Total items (P4): available-to-checkout + unassigned-permanent +
                  assigned-to-location + assigned-to-person + checked-out (+ retired).
                  Clicking a tile narrows the table below to that bucket (on top of the
                  dropdown filters, same idea as the checkout status chips) - clicking the
                  active tile again, or Total/Items Value, clears back to the full set. */}
              {[
                { key:'available',            label:'Available to check out', value: deptItems.filter(i => i.status === 'available' && i.ownershipType !== 'permanent').length, color:'card-green'  },
                { key:'unassigned',           label:'Unassigned permanent',   value: deptItems.filter(i => displayStatus(i) === 'unassigned').length, color:'card-purple' },
                { key:'location_assigned',    label:'Assigned · location',    value: deptItems.filter(i => displayStatus(i) === 'location_assigned').length, color:'card-blue' },
                { key:'permanently_assigned', label:'Assigned · person',      value: deptItems.filter(i => i.status === 'permanently_assigned').length, color:'card-blue' },
                { key:'checked_out',          label:'Checked out', value: deptItems.filter(i => i.status === 'checked_out').length,  color:'card-orange' },
                { key:null,                   label:'Total Items', value: deptItems.length,                                          color:'card-blue'   },
                { key:null,                   label:'Items Value', value: fmtMoney(deptItems.reduce((s, i) => s + (Number(i.assetValue) || 0), 0)), color:'card-blue' },
              ].map(({ key, label, value, color }) => {
                const active = key && cardFilter === key;
                return (
                  <div key={label} className={`kpi-card ${color}`} role="button" tabIndex={0}
                    aria-pressed={active}
                    onClick={() => setCardFilter(prev => (!key || prev === key) ? null : key)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCardFilter(prev => (!key || prev === key) ? null : key); } }}
                    style={{
                      padding:'8px 11px', cursor:'pointer',
                      outline: active ? '2px solid var(--pine)' : 'none', outlineOffset: -2,
                      background: active ? 'hsla(var(--color-green),0.08)' : undefined,
                    }}>
                    <div className="kpi-label" style={{ fontSize:10.5 }}>{label}</div>
                    <div className="kpi-value" style={{ fontSize:18, lineHeight:1.1 }}>{value}</div>
                  </div>
                );
              })}
            </div>
          }
        />
      )}
      {mainTab === 'myitems' && (
        <div>
          <MyCheckoutsPanel
            checkouts={checkouts} userEmail={userEmail} userName={userName} activeSub={activeSub}
            photoOptionalIds={photoOptionalIds}
            assignments={assignments} refreshAssignments={refreshAssignments} toast={toast}
            onReturn={openReturn} onCancel={cancelCo}
            onEmployeeAccept={handleSelfAccept}
            onConfirmReceipt={handleConfirmReceipt}
            onReturnAll={handleReturnAll}
            onRequestExtension={handleRequestExtension}
            onReRequest={handleReRequest}
            onBatchReRequest={handleBatchReRequest}
          />
          {myTotalCount === 0 && (
            <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--muted)' }}>
              <Package size={36} style={{ opacity:.15, display:'block', margin:'0 auto 14px' }} />
              <div style={{ fontWeight:600, fontSize:15, marginBottom:6 }}>No checkouts yet</div>
              <div style={{ fontSize:13 }}>Your personal item checkouts will appear here.</div>
            </div>
          )}
        </div>
      )}
      {mainTab === 'checkouts' && (
        <ManagerCheckoutsTab
          checkouts={checkouts} items={items}
          userName={userName} userEmail={userEmail}
          approveRequest={approveRequest} rejectRequest={rejectRequest}
          allocateItem={allocateItem} initiateHandover={initiateHandover}
          refreshCheckouts={refreshCheckouts} refreshItems={refreshItems} toast={toast}
          assignments={assignments} refreshAssignments={refreshAssignmentsAndItems}
          onSendAlert={openSendAlert} prefilter={checkoutsPrefilter} activeSub={activeSub}
        />
      )}
      {mainTab === 'whohasit' && (
        <WhoHasItTab items={items} checkouts={checkouts} onOpenCheckouts={openInCheckouts} />
      )}
      {mainTab === 'audit' && <AuditLogPanel items={items} onChanged={refreshItems}
        onOpenItem={(it) => {
          const found = items.find(x => x.id === it.id) || items.find(x => x.name === it.name);
          if (found) { setMainTab('manage'); setEditingItem(found); }
          else toast('That item no longer exists (it may have been deleted).', 'error');
        }}
        onLocate={(it) => {
          const found = items.find(x => x.id === it.id) || (it.name && items.find(x => x.name === it.name));
          if (found) {
            // Clear filters so the row is guaranteed visible, jump to Manage, glow
            // it in the background, and open it for editing on top.
            setSearch(''); setDeptFilter('All'); setTypeFilter('All'); setOwnershipFilter('All'); setLocationFilter('All'); setModelFilter('All');
            setMainTab('manage');
            setHighlightItemId(null);
            setTimeout(() => setHighlightItemId(found.id), 0); // re-trigger even if same id
            setEditingItem(found);
          } else {
            // Deleted / purged → open the Recycle Bin, select + glow it there.
            setDeletedHighlightId(it.id || '');
            setDeletedOpen(true);
          }
        }} />}

      {overdueAlertOpen && (
        <OverdueAlertModal checkouts={checkouts} toast={toast}
          onClose={() => setOverdueAlertOpen(false)} />
      )}
      {assigningItem && (
        <AssignItemModal item={assigningItem.item} mode={assigningItem.mode} userEmail={userEmail}
          locations={[...new Set(items.map(i => i.location).filter(Boolean))].sort()} toast={toast}
          onClose={() => setAssigningItem(null)}
          onDone={() => { refreshAssignments(); refreshItems(); }} />
      )}
      {addItemOpen  && <AddItemModal   onClose={() => setAddItemOpen(false)}  onSave={handleAddItem} types={itemTypes} />}
      {editingItem  && <EditItemModal  item={editingItem} onClose={() => setEditingItem(null)} onSave={data => handleEditItem(editingItem, data)} types={itemTypes} />}
      {deletingItem && <DeleteItemModal item={deletingItem} onClose={() => setDeletingItem(null)} onConfirm={() => handleDeleteItem(deletingItem)} />}
      {detailsItem && (
        <ItemDetailsPanel item={detailsItem} customFields={customFields} canEdit={isManager}
          onClose={() => setDetailsItem(null)} onSaved={refreshItems} toast={toast} />
      )}
      {deletedOpen && (
        <DeletedItemsModal onClose={() => { setDeletedOpen(false); setDeletedHighlightId(null); }}
          onRestored={refreshItems} toast={toast} highlightId={deletedHighlightId} />
      )}
      {importOpen   && <ImportItemsModal onClose={() => setImportOpen(false)} onImport={handleImport} customFields={customFields}
        knownDepts={[...new Set([...DEPARTMENTS.filter(d => d !== 'All'), ...items.map(i => (i.department || '').trim()).filter(Boolean)])]}
        knownLocations={locationOptions} />}
      {reportOpen   && <ReportModal onClose={() => setReportOpen(false)} checkouts={checkouts} initial={reportInitial} />}
      {returningCo  && (
        <ReturnModal checkout={returningCo} onClose={() => setReturningCo(null)}
          photoOptional={photoOptionalIds.has(returningCo.itemId)}
          onSubmit={data => returnItem(returningCo.id, data)
            .then(() => { toast(`Return confirmed - ${returningCo.itemName}`); setReturningCo(null); })
            .catch(err => toast(err?.message || 'Could not confirm return - please try again.', 'error'))} />
      )}

      {/* P1-15: managers pick a targeted approver here too - without showApprover this
          cart submitted approver_email:'' and broadcast to every manager. (Follow-up:
          this Manage-mode cart is a second, divergent cart state from the employee
          path - unify to one cart context in a later refactor.) */}
      <CartDrawer open={cartOpen} cart={cart} items={items} onClose={() => setCartOpen(false)}
        onRemove={removeFromCart} onSubmit={handleSubmitCart} submitting={cartBusy}
        onDaysChange={handleDaysChange} showApprover />

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
