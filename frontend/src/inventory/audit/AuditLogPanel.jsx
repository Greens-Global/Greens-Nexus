// Item Management - Manage > Activity Log: the global feed with undo.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { Search, RotateCcw, X, ChevronDown, History } from 'lucide-react';
import { ErrorBanner, SkeletonBlocks, Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useNameResolver } from '../../lib/useNameResolver';
import { renderNotifBody } from '../../components/NotificationBell';
import { formatAuditDetails, auditEventMeta, _auditFg, _auditBg, auditDayKey, auditDayLabel, auditTime, auditInitials, buildGlobalFeed, feedUndoInfo, feedSummary } from '../model/auditFeed';
import { auditVal } from './auditVal';
import { AuditHistoryModal } from './AuditHistoryModal';

export const AuditLogPanel = memo(function AuditLogPanel({ items = [], onOpenItem, onLocate, onChanged }) {
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
