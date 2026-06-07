import { useState, useRef, useEffect } from 'react';
import {
  Package, Plus, Search, CheckCircle, Clock, XCircle,
  RotateCcw, Camera, Monitor, Wrench, Building2, Calculator,
  AlertCircle, Filter, X, Loader2, ZoomIn, ChevronDown, ChevronRight,
  UploadCloud, FileSpreadsheet, Download,
} from 'lucide-react';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { useInventory }       from '../contexts/InventoryContext';
import { useNotifications }   from '../contexts/NotificationContext';
import { useRole }            from '../contexts/RoleContext';
import { api }                from '../api';
import { useMsal } from '@azure/msal-react';

// ── Config ────────────────────────────────────────────────────────────────────
const DEPARTMENTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting'];

const DEPT_META = {
  IT:           { icon: Monitor,    color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.10)'   },
  Construction: { icon: Wrench,     color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.10)' },
  Operations:   { icon: Building2,  color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.10)'  },
  Accounting:   { icon: Calculator, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.10)' },
};

const CATEGORIES = ['All', 'Tools', 'IT Supplies', 'Office Supplies', 'Furniture', 'Safety Equipment', 'Electrical'];

const CAT_COLORS = {
  'Tools':            { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  'IT Supplies':      { bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))' },
  'Office Supplies':  { bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))' },
  'Furniture':        { bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
  'Safety Equipment': { bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))' },
  'Electrical':       { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
};

const STATUS_META = {
  pending:   { label: 'Pending',         bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
  approved:  { label: 'To Be Allocated', bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: Package },
  allocated: { label: 'In Use',          bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
  rejected:  { label: 'Rejected',        bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
  returned:  { label: 'Returned',        bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
  cancelled: { label: 'Cancelled',       bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
};

// Requests that still need someone to act on them — kept visible/expanded.
// Everything else (returned, rejected, cancelled) is "done" and gets tucked
// into a collapsed history list so the active view stays short and scannable.
const ACTIVE_STATUSES    = ['pending', 'approved', 'allocated'];
const COMPLETED_STATUSES = ['returned', 'rejected', 'cancelled'];

// A request can only be cancelled by its requester before someone has
// physically handed the item over — once allocated, returning it is the
// correct path instead.
const CANCELLABLE_STATUSES = ['pending', 'approved'];

const REQ_STATUS_FILTERS = [
  { value: 'All',       label: 'All statuses' },
  { value: 'pending',   label: 'Pending' },
  { value: 'approved',  label: 'To Be Allocated' },
  { value: 'allocated', label: 'In Use / To Be Returned' },
  { value: 'returned',  label: 'Returned' },
  { value: 'rejected',  label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];

// ── Shared modal helpers ──────────────────────────────────────────────────────
// Escape-to-close — every modal in this file wires this in so keyboard users
// (and anyone used to standard dialog behavior) aren't stuck clicking the backdrop.
function useEscapeKey(onEscape) {
  useEffect(() => {
    function handler(e) { if (e.key === 'Escape') onEscape(); }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onEscape]);
}

// Full-size photo viewer — opened by clicking any return-photo thumbnail.
function ImageLightbox({ src, alt, onClose }) {
  useEscapeKey(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label={alt || 'Photo preview'}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:32 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <img src={src} alt={alt || 'Photo preview'} style={{ maxWidth:'100%', maxHeight:'100%', borderRadius:10, boxShadow:'0 20px 80px rgba(0,0,0,0.5)' }} />
      <button onClick={onClose} aria-label="Close photo preview"
        style={{ position:'absolute', top:20, right:24, background:'rgba(255,255,255,0.12)', border:'none', borderRadius:8, padding:8, color:'#fff', cursor:'pointer', display:'flex' }}>
        <X size={20} />
      </button>
    </div>
  );
}

// Lightweight toast/snackbar — the app has no app-wide system, and this view
// is the one place we currently swallow async errors silently. Self-contained
// so it doesn't force a wider refactor; can be promoted to NotificationContext later.
function Toast({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{ position:'fixed', bottom:24, right:24, zIndex:1200, display:'flex', flexDirection:'column', gap:8, maxWidth:340 }}>
      {toasts.map(t => (
        <div key={t.id} role="status"
          style={{
            display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', borderRadius:10,
            background: 'var(--card)', border: `1px solid ${t.kind === 'error' ? 'hsla(var(--color-red),0.35)' : 'hsla(var(--color-green),0.35)'}`,
            boxShadow:'0 8px 28px rgba(0,0,0,0.18)', animation:'fadeIn 0.2s ease-out',
          }}>
          {t.kind === 'error'
            ? <XCircle size={16} color="hsl(var(--color-red))" style={{ flexShrink:0, marginTop:1 }} />
            : <CheckCircle size={16} color="hsl(var(--color-green))" style={{ flexShrink:0, marginTop:1 }} />}
          <span style={{ fontSize:13, color:'var(--ink)', lineHeight:1.4, flex:1 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} aria-label="Dismiss notification"
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', display:'flex', flexShrink:0 }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Raise Request Modal ───────────────────────────────────────────────────────
function RaiseRequestModal({ items, onClose, onSubmit, currentUser, canRaiseOnBehalf, initialItem }) {
  const [itemSearch,  setItemSearch]  = useState(initialItem?.name ?? '');
  const [selected,    setSelected]    = useState(initialItem ?? null);
  const [qty,         setQty]         = useState(1);
  const [days,        setDays]        = useState(1);
  const [reason,      setReason]      = useState('');
  const [showList,    setShowList]    = useState(false);
  const [requestFor,  setRequestFor]  = useState(''); // optional: on behalf of
  const [qtyClamped,  setQtyClamped]  = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEscapeKey(onClose);

  const filtered = items.filter(i =>
    i.available > 0 && i.name.toLowerCase().includes(itemSearch.toLowerCase())
  );

  function selectItem(item) {
    setSelected(item); setItemSearch(item.name); setShowList(false); setQty(1); setQtyClamped(false);
  }

  function changeQty(raw) {
    const max = selected?.available ?? 1;
    const clamped = Math.max(1, Math.min(max, Number(raw) || 1));
    setQtyClamped(Number(raw) > max);
    setQty(clamped);
  }

  function submit() {
    if (!selected || !reason.trim() || isSubmitting) return;
    setIsSubmitting(true);
    Promise.resolve(onSubmit({ item: selected, qty, days, reason: reason.trim(), requestFor: requestFor.trim() || null }))
      .finally(() => setIsSubmitting(false));
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="raise-request-title"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 id="raise-request-title" style={{ fontSize:'16px', fontWeight:700, marginBottom:4 }}>Raise Inventory Request</h3>
        <p style={{ fontSize:'13px', color:'var(--muted)', marginBottom:24 }}>Search for an item and submit a request.</p>

        <div style={{ marginBottom:14, position:'relative' }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>ITEM</label>
          <div style={{ position:'relative' }}>
            <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--muted)', pointerEvents:'none' }} />
            <input className="form-input" style={{ width:'100%', paddingLeft:32 }}
              placeholder="Search available items…" value={itemSearch} autoFocus
              onChange={e => { setItemSearch(e.target.value); setSelected(null); setShowList(true); }}
              onFocus={() => setShowList(true)} />
          </div>
          {showList && itemSearch && filtered.length > 0 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'var(--card)', border:'1px solid var(--line)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', zIndex:10, maxHeight:200, overflowY:'auto', marginTop:4 }}>
              {filtered.map(item => {
                const dm = DEPT_META[item.department];
                return (
                  <div key={item.id} onClick={() => selectItem(item)}
                    style={{ padding:'10px 14px', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--mist)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                    <div>
                      <div style={{ fontWeight:600, fontSize:'13px' }}>{item.name}</div>
                      <div style={{ fontSize:'11px', color: dm ? `hsl(${dm.color})` : 'var(--muted)' }}>{item.department}</div>
                    </div>
                    <span style={{ fontSize:'11px', color:'hsl(var(--color-green))', fontWeight:600, flexShrink:0 }}>{item.available} avail.</span>
                  </div>
                );
              })}
            </div>
          )}
          {showList && itemSearch && filtered.length === 0 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'var(--card)', border:'1px solid var(--line)', borderRadius:8, padding:'12px 14px', fontSize:'13px', color:'var(--muted)', zIndex:10, marginTop:4 }}>
              No available items match "{itemSearch}"
            </div>
          )}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
          <div>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>QUANTITY</label>
            <input type="number" min={1} max={selected?.available ?? 1} value={qty} className="form-input" style={{ width:'100%' }}
              onChange={e => changeQty(e.target.value)} disabled={!selected} />
            {qtyClamped && (
              <div style={{ fontSize:11, color:'hsl(var(--color-orange))', marginTop:4 }}>
                Only {selected?.available} available — capped at {selected?.available}
              </div>
            )}
          </div>
          <div>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>DAYS NEEDED</label>
            <input type="number" min={1} max={90} value={days} className="form-input" style={{ width:'100%' }}
              onChange={e => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} disabled={!selected} />
            {days >= 90 && (
              <div style={{ fontSize:11, color:'hsl(var(--color-orange))', marginTop:4 }}>Maximum 90 days per request</div>
            )}
          </div>
        </div>

        {/* Request on behalf — supervisors and above only */}
        {canRaiseOnBehalf && (
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>
              REQUESTING FOR <span style={{ fontWeight:400, textTransform:'none' }}>(optional — leave blank if for yourself)</span>
            </label>
            <input className="form-input" style={{ width:'100%' }}
              placeholder={`e.g. Sarah Johnson  (you are: ${currentUser})`}
              value={requestFor}
              onChange={e => setRequestFor(e.target.value)} />
          </div>
        )}

        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>REASON FOR REQUEST</label>
          <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:'13px' }}
            placeholder="Briefly explain why you need this item…" value={reason}
            onChange={e => setReason(e.target.value)} disabled={!selected} />
        </div>

        {requestFor.trim() && (
          <div style={{ marginBottom:14, padding:'8px 12px', borderRadius:8, background:'hsla(var(--color-blue),0.08)', border:'1px solid hsla(var(--color-blue),0.2)', fontSize:12, color:'hsl(var(--color-blue))' }}>
            This request will be raised by <strong>{currentUser}</strong> on behalf of <strong>{requestFor.trim()}</strong>
          </div>
        )}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={isSubmitting}>Cancel</button>
          <button className="primary-btn" disabled={!selected || !reason.trim() || isSubmitting}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:140, justifyContent:'center' }}
            onClick={submit}>
            {isSubmitting ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Submitting…</> : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── CSV parsing (no library installed — small quote-aware hand-roll) ─────────
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseInventoryCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], error: 'That file looks empty — it needs a header row plus at least one item.' };

  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = {
    name:       header.findIndex(h => ['name', 'item', 'item name'].includes(h)),
    category:   header.findIndex(h => h === 'category'),
    department: header.findIndex(h => ['department', 'dept'].includes(h)),
    qty:        header.findIndex(h => ['total_qty', 'total', 'quantity', 'qty', 'total qty'].includes(h)),
  };
  if (idx.name === -1) return { rows: [], error: 'Couldn’t find a "Name" column in the header row — check your file and try again.' };

  const rows = lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const name   = (cells[idx.name] || '').trim();
    const qtyRaw = idx.qty > -1 ? (cells[idx.qty] || '').trim() : '';
    const qty    = qtyRaw ? parseInt(qtyRaw, 10) : 0;
    return {
      name,
      category:   idx.category   > -1 ? (cells[idx.category]   || '').trim() : '',
      department: idx.department > -1 ? (cells[idx.department] || '').trim() : '',
      total_qty:  Number.isFinite(qty) ? qty : 0,
      _valid:     !!name,
    };
  });
  return { rows, error: null };
}

// Hands people a starter file with the headers the parser recognizes plus a
// couple of filled-in example rows — saves them guessing column names/order.
function downloadImportTemplate() {
  const csv = [
    'Name,Category,Department,Total Qty',
    'Dell Monitor 24 inch,IT Supplies,IT,15',
    'Cordless Drill,Tools,Construction,8',
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'inventory-import-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Import Items Modal ────────────────────────────────────────────────────────
function ImportItemsModal({ onClose, onImport }) {
  const [fileName,    setFileName]    = useState('');
  const [rows,        setRows]        = useState([]);
  const [parseError,  setParseError]  = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [result,      setResult]      = useState(null); // { created, updated, skipped }
  const fileRef = useRef(null);

  useEscapeKey(onClose);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setSubmitError('');
    const reader = new FileReader();
    reader.onload = () => {
      const { rows: parsed, error } = parseInventoryCsv(String(reader.result || ''));
      if (error) { setParseError(error); setRows([]); }
      else { setParseError(''); setRows(parsed); }
    };
    reader.onerror = () => setParseError('Couldn’t read that file — please try again.');
    reader.readAsText(file);
  }

  function reset() {
    setFileName(''); setRows([]); setParseError(''); setResult(null); setSubmitError('');
    if (fileRef.current) fileRef.current.value = '';
  }

  const validRows   = rows.filter(r => r._valid);
  const invalidRows = rows.length - validRows.length;

  function submit() {
    if (!validRows.length || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    Promise.resolve(onImport(validRows.map(r => ({
      name: r.name, category: r.category, department: r.department, total_qty: r.total_qty,
    }))))
      .then(res => setResult(res))
      .catch(err => setSubmitError(err?.message || 'Import failed — please try again.'))
      .finally(() => setSubmitting(false));
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="import-items-title"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:640, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:4 }}>
          <h3 id="import-items-title" style={{ fontSize:'16px', fontWeight:700 }}>Import Inventory Items</h3>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4 }}><X size={18} /></button>
        </div>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:14, marginBottom:20 }}>
          <p style={{ fontSize:'13px', color:'var(--muted)', flex:1 }}>
            Upload a CSV to bulk-create items or update stock counts for existing ones (matched by name).
          </p>
          <button onClick={downloadImportTemplate}
            style={{ display:'inline-flex', alignItems:'center', gap:6, flexShrink:0, background:'none', border:'1px solid var(--line)', borderRadius:8, padding:'6px 12px', color:'var(--ink)', fontSize:'12.5px', fontWeight:600, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <Download size={14} /> Download Template
          </button>
        </div>

        {result ? (
          <div style={{ textAlign:'center', padding:'28px 12px' }}>
            <div style={{ width:48, height:48, borderRadius:'50%', background:'hsla(var(--color-green),0.12)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px' }}>
              <CheckCircle size={24} color="hsl(var(--color-green))" />
            </div>
            <p style={{ fontSize:'15px', fontWeight:700, marginBottom:6 }}>Import complete</p>
            <p style={{ fontSize:'13px', color:'var(--muted)' }}>
              {result.created} item{result.created !== 1 ? 's' : ''} created · {result.updated} updated
              {result.skipped > 0 && ` · ${result.skipped} skipped`}
            </p>
            <div style={{ display:'flex', gap:10, justifyContent:'center', marginTop:22 }}>
              <button className="secondary-btn" onClick={reset}>Import Another File</button>
              <button className="primary-btn" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            {!fileName ? (
              <div onClick={() => fileRef.current?.click()}
                style={{ border:'2px dashed var(--line)', borderRadius:10, padding:'34px 20px', textAlign:'center', cursor:'pointer' }}
                onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
                onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
                <UploadCloud size={28} style={{ color:'var(--muted)', marginBottom:8 }} />
                <div style={{ fontSize:'13px', fontWeight:600, color:'var(--ink)' }}>Click to browse or drop a CSV file</div>
                <div style={{ fontSize:'12px', color:'var(--muted)', marginTop:4 }}>Columns: Name, Category, Department, Total Qty</div>
              </div>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', border:'1px solid var(--line)', borderRadius:10 }}>
                <FileSpreadsheet size={18} style={{ color:'var(--muted)', flexShrink:0 }} />
                <span style={{ fontSize:'13px', fontWeight:600, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fileName}</span>
                <button onClick={reset} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', fontSize:'12px', fontFamily:'Inter,sans-serif' }}>Change file</button>
              </div>
            )}
            <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={handleFile} />

            {parseError && (
              <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:'12.5px', color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', margin:'14px 0 0' }}>
                <AlertCircle size={14} style={{ flexShrink:0 }} /> {parseError}
              </p>
            )}

            {rows.length > 0 && !parseError && (
              <>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', margin:'16px 0 8px' }}>
                  <span style={{ fontSize:'12px', fontWeight:700, color:'var(--muted)', letterSpacing:'.04em', textTransform:'uppercase' }}>
                    Preview — {validRows.length} item{validRows.length !== 1 ? 's' : ''}
                  </span>
                  {invalidRows > 0 && (
                    <span style={{ fontSize:'12px', color:'hsl(var(--color-orange))', fontWeight:600 }}>{invalidRows} row{invalidRows !== 1 ? 's' : ''} skipped (no name)</span>
                  )}
                </div>
                <div style={{ border:'1px solid var(--line)', borderRadius:10, overflow:'auto', flex:1, minHeight:0 }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12.5px' }}>
                    <thead>
                      <tr style={{ background:'var(--mist)' }}>
                        <th style={{ textAlign:'left',  padding:'8px 12px', fontWeight:700, color:'var(--muted)' }}>Name</th>
                        <th style={{ textAlign:'left',  padding:'8px 12px', fontWeight:700, color:'var(--muted)' }}>Category</th>
                        <th style={{ textAlign:'left',  padding:'8px 12px', fontWeight:700, color:'var(--muted)' }}>Department</th>
                        <th style={{ textAlign:'right', padding:'8px 12px', fontWeight:700, color:'var(--muted)' }}>Total Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 200).map((r, i) => (
                        <tr key={i} style={{ borderTop:'1px solid var(--line)', opacity: r._valid ? 1 : 0.4 }}>
                          <td style={{ padding:'7px 12px', fontWeight:600 }}>
                            {r.name || <em style={{ color:'hsl(var(--color-red))', fontWeight:400 }}>missing name</em>}
                          </td>
                          <td style={{ padding:'7px 12px', color:'var(--muted)' }}>{r.category   || '—'}</td>
                          <td style={{ padding:'7px 12px', color:'var(--muted)' }}>{r.department || '—'}</td>
                          <td style={{ padding:'7px 12px', textAlign:'right' }}>{r.total_qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {submitError && (
              <p style={{ display:'flex', alignItems:'center', gap:6, fontSize:'12.5px', color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', borderRadius:8, padding:'9px 12px', margin:'14px 0 0' }}>
                <AlertCircle size={14} style={{ flexShrink:0 }} /> {submitError}
              </p>
            )}

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button className="secondary-btn" onClick={onClose} disabled={submitting}>Cancel</button>
              <button className="primary-btn" disabled={!validRows.length || submitting}
                style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:160, justifyContent:'center' }}
                onClick={submit}>
                {submitting
                  ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Importing…</>
                  : `Import ${validRows.length || ''} Item${validRows.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Return Modal ──────────────────────────────────────────────────────────────
function ReturnModal({ request, onClose, onSubmit }) {
  const [photo,         setPhoto]         = useState(null);
  const [conditionNote, setConditionNote] = useState('');
  const [isSubmitting,  setIsSubmitting]  = useState(false);
  const [preview,       setPreview]       = useState(null); // lightbox src, or null
  const fileRef = useRef(null);

  useEscapeKey(onClose);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto({ url: URL.createObjectURL(file), name: file.name, file });
  }

  function submit() {
    if (!photo || isSubmitting) return;
    setIsSubmitting(true);
    Promise.resolve(onSubmit({ file: photo?.file, photoName: photo?.name, conditionNote: conditionNote.trim() }))
      .finally(() => setIsSubmitting(false));
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="return-item-title"
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:440, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 id="return-item-title" style={{ fontSize:'16px', fontWeight:700, marginBottom:4 }}>Return Item</h3>
        <p style={{ fontSize:'13px', color:'var(--muted)', marginBottom:24 }}>
          <strong>{request.itemName}</strong> — {request.quantity} unit{request.quantity > 1 ? 's' : ''}
        </p>

        <div style={{ marginBottom:18 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:8, letterSpacing:'.04em' }}>PHOTO OF ITEM</label>
          {photo ? (
            <div style={{ position:'relative', borderRadius:10, overflow:'hidden', border:'1px solid var(--line)' }}>
              <img src={photo.url} alt="Return preview" onClick={() => setPreview(photo.url)}
                style={{ width:'100%', maxHeight:200, objectFit:'cover', display:'block', cursor:'zoom-in' }} />
              <button onClick={() => setPreview(photo.url)} aria-label="View full-size photo"
                style={{ position:'absolute', bottom:8, left:8, background:'rgba(0,0,0,0.6)', border:'none', borderRadius:6, padding:'4px 8px', color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', gap:5, fontSize:'11px', fontFamily:'Inter,sans-serif' }}>
                <ZoomIn size={12} /> View full size
              </button>
              <button onClick={() => { setPhoto(null); fileRef.current.value=''; }} aria-label="Remove photo"
                style={{ position:'absolute', top:8, right:8, background:'rgba(0,0,0,0.6)', border:'none', borderRadius:6, padding:'4px 10px', color:'#fff', fontSize:'12px', cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                Remove
              </button>
            </div>
          ) : (
            <div onClick={() => fileRef.current.click()}
              style={{ border:'2px dashed var(--line)', borderRadius:10, padding:'28px 20px', textAlign:'center', cursor:'pointer' }}
              onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
              onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
              <Camera size={28} style={{ color:'var(--muted)', marginBottom:8 }} />
              <div style={{ fontSize:'13px', fontWeight:600, color:'var(--ink)' }}>Take a photo or upload</div>
              <div style={{ fontSize:'12px', color:'var(--muted)', marginTop:4 }}>On mobile, opens your camera</div>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display:'none' }} onChange={handleFile} />
        </div>

        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>
            CONDITION NOTE <span style={{ fontWeight:400 }}>(optional)</span>
          </label>
          <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:'13px' }}
            placeholder="e.g. Good condition, minor scratch on handle…"
            value={conditionNote} onChange={e => setConditionNote(e.target.value)} />
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose} disabled={isSubmitting}>Cancel</button>
          <button className="primary-btn" disabled={!photo || isSubmitting}
            style={{ display:'inline-flex', alignItems:'center', gap:7, minWidth:140, justifyContent:'center' }}
            onClick={submit}>
            {isSubmitting ? <><Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> Submitting…</> : 'Confirm Return'}
          </button>
        </div>
        {!photo && <p style={{ textAlign:'right', fontSize:'11px', color:'hsl(var(--color-red))', marginTop:8 }}>A photo is required to confirm return.</p>}
      </div>
      {preview && <ImageLightbox src={preview} alt="Return photo preview" onClose={() => setPreview(null)} />}
    </div>
  );
}

// ── Request Stage Tracker ─────────────────────────────────────────────────────
function StageTracker({ request, onViewPhoto }) {
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  // Due date counted from allocation (not creation) since that's when the clock starts
  const startDate = request.allocatedAt ?? request.createdAt;
  const dueDate   = request.days
    ? new Date(new Date(startDate).getTime() + request.days * 86400000)
    : null;
  const isOverdue = request.status === 'allocated' && dueDate && dueDate < new Date();
  const daysLeft  = dueDate ? Math.ceil((dueDate - new Date()) / 86400000) : null;
  const isRejected  = request.status === 'rejected';
  const isCancelled = request.status === 'cancelled';

  // Status rank for easy comparison
  const rank = { pending: 0, approved: 1, allocated: 2, returned: 3, rejected: -1, cancelled: -1 };
  const cur  = rank[request.status] ?? 0;

  const stages = isRejected ? [
    { label: 'Submitted',    detail: fmt(request.createdAt), state: 'done'    },
    { label: 'Under Review', detail: 'Manager notified',     state: 'done'    },
    { label: 'Rejected',     detail: request.rejectReason ? `"${request.rejectReason}"` : 'Not approved', state: 'error' },
  ] : isCancelled ? [
    { label: 'Submitted', detail: fmt(request.createdAt), state: 'done' },
    { label: 'Cancelled', detail: `By ${request.resolvedBy ?? 'requester'} · ${fmt(request.resolvedAt)}`, state: 'error' },
  ] : [
    {
      label: 'Submitted',
      detail: fmt(request.createdAt),
      state: 'done',
    },
    {
      label: 'Under Review',
      detail: cur > 0 ? 'Reviewed' : 'Awaiting manager',
      state: cur === 0 ? 'active' : 'done',
    },
    {
      label: 'Approved',
      detail: cur >= 1 ? `By ${request.resolvedBy ?? 'manager'}` : null,
      state: cur === 0 ? 'upcoming' : 'done',
    },
    {
      label: 'To Be Allocated',
      detail: cur >= 2
        ? `By ${request.allocatedBy ?? 'supervisor'} · ${fmt(request.allocatedAt)}`
        : (cur === 1 && request.assignedAllocatorName
            ? `Waiting for ${request.assignedAllocatorName}`
            : 'Waiting for supervisor'),
      state: cur === 1 ? 'active' : cur >= 2 ? 'done' : 'upcoming',
    },
    {
      label: 'In Use',
      detail: cur >= 2
        ? (isOverdue
            ? `⚠ Overdue since ${fmt(dueDate?.toISOString())}`
            : daysLeft != null && daysLeft > 0
              ? `Due ${fmt(dueDate?.toISOString())} · ${daysLeft}d left`
              : daysLeft === 0 ? 'Due today' : null)
        : null,
      state: cur === 2 ? 'active' : cur >= 3 ? 'done' : 'upcoming',
      isOverdue,
    },
    {
      label: 'Returned',
      detail: request.returnedAt ? fmt(request.returnedAt) : null,
      state: cur >= 3 ? 'done' : 'upcoming',
    },
  ];

  const stateStyle = {
    done:    { bg: 'hsl(var(--color-green))',  text: '#fff', border: 'none' },
    active:  { bg: 'hsl(var(--color-blue))',   text: '#fff', border: 'none' },
    error:   { bg: 'hsl(var(--color-red))',    text: '#fff', border: 'none' },
    upcoming:{ bg: 'var(--card)',              text: 'var(--muted)', border: '2px solid var(--line)' },
  };
  const lineColor = s => s === 'done' ? 'hsl(var(--color-green))' : 'var(--line)';
  const icon = s => s === 'done' ? '✓' : s === 'error' ? '✕' : s === 'active' ? '●' : '';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 16, overflowX: 'auto', paddingBottom: 4 }}>
      {stages.map((stage, i) => {
        const ss = stateStyle[stage.state];
        return (
          <div key={stage.label} style={{ display: 'flex', alignItems: 'flex-start', flex: i < stages.length - 1 ? '1 1 0' : 'none' }}>
            {/* Stage node */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 68 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: ss.bg, color: ss.text, border: ss.border,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, flexShrink: 0,
                boxShadow: stage.state === 'active' ? `0 0 0 4px hsla(var(--color-blue),0.15)` : 'none',
              }}>
                {icon(stage.state)}
              </div>
              <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 5, textAlign: 'center', whiteSpace: 'nowrap', color: stage.state === 'upcoming' ? 'var(--muted)' : 'var(--ink)' }}>
                {stage.label}
              </div>
              {stage.detail && (
                <div style={{ fontSize: 10, color: stage.isOverdue ? 'hsl(var(--color-red))' : 'var(--muted)', textAlign: 'center', marginTop: 2, lineHeight: 1.3, maxWidth: 80 }}>
                  {stage.detail}
                </div>
              )}
              {/* Condition photo, tied directly to the Returned step it belongs to */}
              {stage.label === 'Returned' && request.returnPhotoUrl && (
                <button onClick={() => onViewPhoto?.(request.returnPhotoUrl)}
                  aria-label={`View return photo for ${request.itemName}`}
                  title="View return photo"
                  style={{ marginTop: 6, padding: 0, border: '1px solid var(--line)', borderRadius: 7, cursor: 'zoom-in', background: 'var(--card)', overflow: 'hidden', width: 36, height: 36, flexShrink: 0, lineHeight: 0 }}>
                  <img src={request.returnPhotoUrl} alt="" style={{ width: 36, height: 36, objectFit: 'cover', display: 'block' }} />
                </button>
              )}
            </div>
            {/* Connector line */}
            {i < stages.length - 1 && (
              <div style={{ flex: 1, height: 2, marginTop: 13, background: lineColor(stage.state), minWidth: 16, transition: 'background 0.3s' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── My Requests drawer ────────────────────────────────────────────────────────
// Slides in from the right and overlays the inventory grid rather than
// replacing it — same pattern as the Access Manager panel (AdminPanel.jsx),
// so "My Requests" never takes over the whole screen.
function MyRequestsDrawer({
  open, onClose,
  myReqs, myReqsFiltered, activeReqs, completedReqs, assignedToMe,
  reqSearch, setReqSearch, reqStatusFilter, setReqStatusFilter,
  requestsLoading, requestsError, onRetry,
  historyOpen, setHistoryOpen, expandedReqs, toggleExpanded,
  cancellingId, setCancellingId, cancelBusyId, onCancelRequest,
  onReturnClick, onAllocate, allocatingId,
  onPhotoPreview, fmtDate,
}) {
  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        zIndex: 1200, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 0.25s ease',
      }} />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, height: '100vh',
        width: 'min(720px, 94vw)',
        background: 'var(--card)',
        boxShadow: '-12px 0 48px rgba(0,0,0,0.22)',
        zIndex: 1201,
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid var(--line)', gap: 12, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-blue),0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Clock size={17} style={{ color: 'hsl(var(--color-blue))' }} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>My Requests</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{myReqs.length} request{myReqs.length !== 1 ? 's' : ''} raised</div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 6, borderRadius: 8, display: 'flex', flexShrink: 0 }}
            title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* Search + filter */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
            <div className="search-bar" style={{ flex: '1 1 200px', minWidth: 180 }}>
              <Search size={14} style={{ flexShrink: 0 }} />
              <input placeholder="Search by item, ID, or reason…" value={reqSearch} onChange={e => setReqSearch(e.target.value)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Filter size={13} style={{ color: 'var(--muted)' }} />
              <select value={reqStatusFilter} onChange={e => setReqStatusFilter(e.target.value)} className="form-input"
                style={{ padding: '6px 10px', fontSize: '13px', height: 34 }}>
                {REQ_STATUS_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
          </div>

          {/* Assigned to You — requests a manager has handed this person to physically
              allocate; surfaced up top so it's not buried in the requester-centric list below. */}
          {assignedToMe.length > 0 && (
            <div style={{ marginBottom: 18, padding: '12px 14px', background: 'hsla(var(--color-orange),0.07)', borderRadius: 12, border: '1px solid hsla(var(--color-orange),0.22)' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'hsl(var(--color-orange))', marginBottom: 9, display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <Package size={13} /> Assigned to You — {assignedToMe.length} to allocate
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {assignedToMe.map(r => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--card)', borderRadius: 10, border: '1px solid var(--line)' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13.5px' }}>{r.itemName} <span style={{ fontWeight: 500, color: 'var(--muted)' }}>×{r.quantity}</span></div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 2 }}>For {r.requestedBy} · {r.department}</div>
                    </div>
                    <button onClick={() => onAllocate(r)} className="primary-btn"
                      disabled={allocatingId === r.id}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', fontSize: '13px' }}>
                      {allocatingId === r.id ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={14} />}
                      {allocatingId === r.id ? 'Allocating…' : 'Allocate'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {requestsError ? (
            <ErrorBanner message="Couldn't load your requests right now — this is usually temporary." onRetry={onRetry} />
          ) : requestsLoading ? (
            <SkeletonBlocks count={3} height={120} />
          ) : myReqsFiltered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '56px 0', color: 'var(--muted)', fontSize: '14px' }}>
              <Package size={32} style={{ opacity: .2, marginBottom: 10, display: 'block', margin: '0 auto 10px' }} />
              {reqSearch || reqStatusFilter !== 'All'
                ? 'No requests match your search or filter.'
                : "You haven't raised any requests yet."}
            </div>
          ) : (
            <>
              {/* Needs action — pending approval, awaiting allocation, or out and due back */}
              {activeReqs.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: completedReqs.length > 0 ? 22 : 0 }}>
                  {activeReqs.map(r => {
                    const s  = STATUS_META[r.status];
                    const dm = DEPT_META[r.department];
                    return (
                      <div key={r.id} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow-sm)' }}>

                        {/* Top row */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 38, height: 38, borderRadius: 10, background: dm ? `hsl(${dm.color})` + '22' : 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <Package size={18} color={dm ? `hsl(${dm.color})` : 'var(--muted)'} />
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: '14.5px' }}>{r.itemName}</div>
                              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 2 }}>
                                {r.department} · ×{r.quantity} · {r.days} day{r.days > 1 ? 's' : ''}
                                {r.raisedBy && r.raisedBy !== r.requestedBy && (
                                  <span style={{ marginLeft: 6, color: 'hsl(var(--color-blue))', fontWeight: 500 }}>via {r.raisedBy}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--muted)', background: 'var(--mist)', padding: '2px 7px', borderRadius: 5 }}>{r.id}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 20, fontSize: '11px', fontWeight: 700, background: s.bg, color: s.fg }}>
                              <s.Icon size={11} /> {s.label}
                            </span>
                          </div>
                        </div>

                        {/* Reason */}
                        {r.reason && (
                          <div style={{ fontSize: '12.5px', color: 'var(--muted)', background: 'var(--mist)', borderRadius: 8, padding: '7px 12px', marginBottom: 4, borderLeft: `3px solid ${dm ? `hsl(${dm.color})` : 'var(--line)'}` }}>
                            "{r.reason}"
                          </div>
                        )}

                        {/* Stage tracker — return photo (if any) shows inline on the Returned step */}
                        <StageTracker request={r} onViewPhoto={onPhotoPreview} />

                        {/* Actions */}
                        {r.status === 'allocated' && (
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button onClick={() => onReturnClick(r)} className="secondary-btn"
                              style={{ padding: '6px 14px', fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <RotateCcw size={13} /> Return Item
                            </button>
                          </div>
                        )}

                        {CANCELLABLE_STATUSES.includes(r.status) && cancellingId !== r.id && (
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button onClick={() => setCancellingId(r.id)} className="secondary-btn"
                              style={{ padding: '6px 14px', fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>
                              <XCircle size={13} /> Cancel Request
                            </button>
                          </div>
                        )}
                        {cancellingId === r.id && (
                          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', background: 'hsla(var(--color-red),0.05)', border: '1px solid hsla(var(--color-red),0.2)', borderRadius: 8, padding: '10px 14px' }}>
                            <span style={{ fontSize: '12.5px', color: 'var(--text)', marginRight: 'auto' }}>Cancel this request? This can't be undone.</span>
                            <button onClick={() => setCancellingId(null)} className="secondary-btn"
                              disabled={cancelBusyId === r.id}
                              style={{ padding: '5px 12px', fontSize: '12.5px' }}>
                              Keep It
                            </button>
                            <button onClick={() => onCancelRequest(r)} className="primary-btn"
                              disabled={cancelBusyId === r.id}
                              style={{ padding: '5px 14px', fontSize: '12.5px', background: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              {cancelBusyId === r.id
                                ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Cancelling…</>
                                : <>Yes, Cancel It</>}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {activeReqs.length === 0 && completedReqs.length > 0 && (
                <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--muted)', fontSize: 13 }}>
                  <CheckCircle size={20} style={{ opacity: .25, marginBottom: 6 }} /><br />
                  Nothing needs your attention right now.
                </div>
              )}

              {/* Completed / history — collapsed by default to keep this view short */}
              {completedReqs.length > 0 && (
                <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                  <button onClick={() => setHistoryOpen(o => !o)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--mist)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {historyOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      Completed ({completedReqs.length})
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)' }}>
                      {historyOpen ? 'Click to collapse' : 'Returned & rejected — click to view'}
                    </span>
                  </button>
                  {historyOpen && (
                    <div>
                      {completedReqs.map(r => {
                        const s      = STATUS_META[r.status];
                        const dm     = DEPT_META[r.department];
                        const isOpen = expandedReqs.has(r.id);
                        return (
                          <div key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                            <button onClick={() => toggleExpanded(r.id)}
                              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'var(--card)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                              {isOpen ? <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ flexShrink: 0, color: 'var(--muted)' }} />}
                              <div style={{ width: 30, height: 30, borderRadius: 8, background: dm ? `hsl(${dm.color})` + '22' : 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <Package size={14} color={dm ? `hsl(${dm.color})` : 'var(--muted)'} />
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.itemName}</div>
                                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                                  {r.department} · ×{r.quantity} · {fmtDate(r.returnedAt || r.resolvedAt || r.createdAt)}
                                </div>
                              </div>
                              {r.status === 'returned' && r.returnPhotoUrl && (
                                <span role="button" tabIndex={0} aria-label={`View return photo for ${r.itemName}`}
                                  onClick={e => { e.stopPropagation(); onPhotoPreview(r.returnPhotoUrl); }}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onPhotoPreview(r.returnPhotoUrl); } }}
                                  style={{ display: 'inline-block', cursor: 'zoom-in', lineHeight: 0, flexShrink: 0 }}>
                                  <img src={r.returnPhotoUrl} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', display: 'block' }} />
                                </span>
                              )}
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 20, fontSize: '11px', fontWeight: 700, background: s.bg, color: s.fg, flexShrink: 0 }}>
                                <s.Icon size={11} /> {s.label}
                              </span>
                            </button>
                            {isOpen && (
                              <div style={{ padding: '2px 16px 16px 58px' }}>
                                {r.reason && (
                                  <div style={{ fontSize: '12px', color: 'var(--muted)', background: 'var(--mist)', borderRadius: 8, padding: '7px 12px', marginBottom: 8, borderLeft: `3px solid ${dm ? `hsl(${dm.color})` : 'var(--line)'}` }}>
                                    "{r.reason}"
                                  </div>
                                )}
                                {r.status === 'rejected' && r.rejectReason && (
                                  <div style={{ fontSize: '12px', color: 'hsl(var(--color-red))', background: 'hsla(var(--color-red),0.07)', padding: '5px 10px', borderRadius: 7, marginBottom: 8 }}>
                                    Rejection reason: {r.rejectReason}
                                  </div>
                                )}
                                {r.status === 'returned' && r.conditionNote && (
                                  <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 8 }}>
                                    Condition note: {r.conditionNote}
                                  </div>
                                )}
                                <StageTracker request={r} onViewPhoto={onPhotoPreview} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────
export default function InventoryManagement({ activeSub, onSubChange }) {
  const {
    items, itemsLoading, itemsError,
    requests, requestsLoading, requestsError,
    raiseRequest, returnItem, cancelRequest, allocateItem,
    refreshRequests, refreshItems,
  } = useInventory();
  const { addNotification } = useNotifications();
  const { can }             = useRole();
  const { accounts }        = useMsal();
  const userName            = accounts[0]?.name     ?? 'Employee';
  const userEmail           = (accounts[0]?.username ?? '').toLowerCase();

  const [search,       setSearch]       = useState('');
  const [catFilter,    setCatFilter]    = useState('All');
  const [deptTab,      setDeptTab]      = useState('All');
  const [tab,          setTab]          = useState(activeSub === 'my-requests' ? 'my-requests' : 'inventory');
  const [showModal,    setShowModal]    = useState(false);
  const [showImport,   setShowImport]   = useState(false);
  const [prefillItem,  setPrefillItem]  = useState(null); // item card clicked → opens Raise Request pre-selected
  const [returningReq, setReturningReq] = useState(null);
  const [reqSearch,    setReqSearch]    = useState('');
  const [reqStatusFilter, setReqStatusFilter] = useState('All');
  const [historyOpen,  setHistoryOpen]  = useState(false);
  const [expandedReqs, setExpandedReqs] = useState(() => new Set());
  const [photoPreview, setPhotoPreview] = useState(null); // lightbox src, or null
  const [cancellingId, setCancellingId] = useState(null);  // request awaiting cancel confirmation
  const [cancelBusyId, setCancelBusyId] = useState(null);
  const [allocatingId, setAllocatingId] = useState(null);  // request being allocated from "Assigned to Me"

  // Minimal local toast/feedback system — see <Toast> for rationale.
  const [toasts, setToasts] = useState([]);
  const toast = (message, kind = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), kind === 'error' ? 6000 : 4000);
  };
  const dismissToast = id => setToasts(prev => prev.filter(t => t.id !== id));

  useEffect(() => {
    if (activeSub === 'my-requests') setTab('my-requests');
  }, [activeSub]);

  const myReqs = requests
    .filter(r =>
      (r.requestedByEmail && r.requestedByEmail.toLowerCase() === userEmail) ||
      r.requestedBy === userName);

  const myReqsFiltered = myReqs
    .filter(r => reqStatusFilter === 'All' || r.status === reqStatusFilter)
    .filter(r => {
      const q = reqSearch.trim().toLowerCase();
      if (!q) return true;
      return r.itemName.toLowerCase().includes(q)
        || r.id.toLowerCase().includes(q)
        || (r.reason || '').toLowerCase().includes(q);
    });

  // Needs-action items stay visible & expanded — these are the ones a person
  // is actually waiting on (to be allocated, or currently out and due back).
  const activeReqs    = myReqsFiltered.filter(r => ACTIVE_STATUSES.includes(r.status));
  const completedReqs = myReqsFiltered.filter(r => COMPLETED_STATUSES.includes(r.status));

  // Requests the manager has specifically handed to this person to physically
  // allocate — distinct from "My Requests" (which is what I asked for, not
  // what I owe someone else). The backend now includes these in `requests`
  // for non-managers too (see GET /inventory-requests's assigned_allocator_email check).
  const assignedToMe = requests.filter(r =>
    r.status === 'approved' && (r.assignedAllocatorEmail || '').toLowerCase() === userEmail);

  function toggleExpanded(id) {
    setExpandedReqs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const filtered = items.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase());
    const matchCat    = catFilter === 'All' || item.category   === catFilter;
    const matchDept   = deptTab   === 'All' || item.department === deptTab;
    return matchSearch && matchCat && matchDept;
  });

  // Dept summary stats
  const deptStats = DEPARTMENTS.filter(d => d !== 'All').map(dept => {
    const deptItems = items.filter(i => i.department === dept);
    const available = deptItems.reduce((s, i) => s + i.available, 0);
    const total     = deptItems.reduce((s, i) => s + i.total, 0);
    const outOfStock = deptItems.filter(i => i.available === 0).length;
    return { dept, total: deptItems.length, available, totalUnits: total, outOfStock };
  });

  const totalItems     = items.length;
  const totalAvailable = items.reduce((s, i) => s + i.available, 0);
  const totalCheckedOut = items.reduce((s, i) => s + (i.total - i.available), 0);
  const pendingReqs    = requests.filter(r => r.status === 'pending').length;

  function handleSubmit({ item, qty, days, reason, requestFor }) {
    const forPerson      = requestFor || userName;
    const forPersonEmail = requestFor ? '' : userEmail; // email only known when requesting for self
    return raiseRequest({
      itemId:            item.id,
      itemName:          item.name,
      requestedBy:       forPerson,
      requestedByEmail:  forPersonEmail,
      raisedBy:          userName,
      department:        item.department,
      quantity: qty, days, reason,
    }).then(saved => {
      const byLine = requestFor ? `${userName} on behalf of ${requestFor}` : userName;
      addNotification({
        type:        'inv_request',
        refId:       saved.id,
        title:       'New Inventory Request',
        body:        `${byLine} requested ${qty}× ${item.name} for ${days} day${days > 1 ? 's' : ''} — "${reason}"`,
        requestedBy: forPerson,
        itemName:    item.name,
        // Store the requester's email inside action so the bell can target the approval notification
        action:      forPersonEmail ? { requestedByEmail: forPersonEmail } : null,
      });
      toast(`Request submitted — ${qty}× ${item.name}`);
      setShowModal(false);
      setPrefillItem(null);
    }).catch(() => {
      toast(`Couldn't submit your request for ${item.name} — please try again`, 'error');
    });
  }

  // Clicking an item card raises a request for it directly — no need to open
  // the modal and search for the item all over again.
  function openRaiseRequestFor(item) {
    if (item.available <= 0) return;
    setPrefillItem(item);
    setShowModal(true);
  }

  function closeRaiseRequestModal() {
    setShowModal(false);
    setPrefillItem(null);
  }

  function handleImport(items) {
    return api.importInventoryItems(items)
      .then(res => {
        refreshItems();
        toast(`Imported ${res.created} new and updated ${res.updated} existing item${res.created + res.updated !== 1 ? 's' : ''}.`);
        return res;
      })
      .catch(err => {
        toast(err?.message || 'Import failed — please try again.', 'error');
        throw err;
      });
  }

  function handleReturnSubmit(req, data) {
    return returnItem(req.id, data).then(saved => {
      // Tell whoever physically handed the item out that it's back — they're
      // the one who needs to inspect it and return it to circulation. Targeted
      // by name (allocatedBy only stores a display name, not an email) the
      // same way 'approved'/'rejected' notifications already are.
      if (req.allocatedBy) {
        addNotification({
          type:        'item_returned',
          recipient:   req.allocatedBy,
          refId:       req.id,
          title:       'Item Returned',
          body:        `${req.requestedBy} returned ${req.itemName}${data?.conditionNote ? ` — "${data.conditionNote}"` : ''}.`,
          itemName:    req.itemName,
          requestedBy: req.requestedBy,
        });
      }
      toast(`Return confirmed — ${req.itemName}`);
      // The return itself succeeded even if the photo upload failed — don't
      // make that look like a hard error, but the requester does need to know
      // their condition photo didn't attach (it used to fail silently here).
      if (data?.file && saved?.photoUploadError) {
        toast(`Photo couldn't be saved with this return — ${saved.photoUploadError}`, 'error');
      }
      setReturningReq(null);
    }).catch(() => {
      toast(`Couldn't confirm the return of ${req.itemName} — please try again`, 'error');
    });
  }

  function handleCancelRequest(req) {
    setCancelBusyId(req.id);
    cancelRequest(req.id, userName).then(() => {
      toast(`Request cancelled — ${req.itemName}`);
      setCancellingId(null);
    }).catch(() => {
      toast(`Couldn't cancel your request for ${req.itemName} — please try again`, 'error');
    }).finally(() => setCancelBusyId(null));
  }

  function handleAllocateFromInventory(req) {
    setAllocatingId(req.id);
    allocateItem(req.id, userName).then(() => {
      addNotification({
        type:        'allocated',
        recipient:   req.requestedByEmail || req.requestedBy,
        refId:       req.id,
        itemName:    req.itemName,
        requestedBy: req.requestedBy,
        title:       'Item Allocated ✓',
        body:        `Your ${req.itemName} has been allocated and is ready for collection. Please pick it up from your supervisor.`,
        action:      { label: 'Track Request →', view: 'inventory', sub: 'my-requests' },
      });
      toast(`Marked as allocated — ${req.itemName}`);
    }).catch(err => {
      const msg = /409|stock/i.test(err?.message || '')
        ? `Not enough ${req.itemName} in stock to allocate right now.`
        : `Couldn't allocate ${req.itemName} — please try again.`;
      toast(msg, 'error');
    }).finally(() => setAllocatingId(null));
  }

  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>

      {/* ── Header ── */}
      <div className="view-header">
        <div className="view-title-group">
          <h2>Inventory Management</h2>
          <p>Company assets and supplies across all departments</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => setTab(t => t === 'my-requests' ? 'inventory' : 'my-requests')}
            className={tab === 'my-requests' ? 'primary-btn' : 'secondary-btn'}
            style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
            <Clock size={15} /> My Requests {myReqs.length > 0 && `(${myReqs.length})`}
          </button>
          <button onClick={() => setShowImport(true)} className="secondary-btn"
            style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
            <UploadCloud size={15} /> Import
          </button>
          <button onClick={() => { setPrefillItem(null); setShowModal(true); }} className="primary-btn"
            style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
            <Plus size={15} /> Raise Request
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom:24 }}>
        {[
          { label: 'Total Items',   value: totalItems,      sub: 'across all depts',       color: 'card-blue'   },
          { label: 'Available',     value: totalAvailable,  sub: 'units ready to request', color: 'card-green'  },
          { label: 'Checked Out',   value: totalCheckedOut, sub: 'units currently in use', color: 'card-orange' },
          { label: 'Pending Reqs',  value: pendingReqs,     sub: 'awaiting approval',      color: pendingReqs > 0 ? 'card-red' : '' },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className={`kpi-card ${color}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-delta">{sub}</div>
          </div>
        ))}
      </div>

      <MyRequestsDrawer
        open={tab === 'my-requests'}
        onClose={() => setTab('inventory')}
        myReqs={myReqs}
        myReqsFiltered={myReqsFiltered}
        activeReqs={activeReqs}
        completedReqs={completedReqs}
        assignedToMe={assignedToMe}
        reqSearch={reqSearch}
        setReqSearch={setReqSearch}
        reqStatusFilter={reqStatusFilter}
        setReqStatusFilter={setReqStatusFilter}
        requestsLoading={requestsLoading}
        requestsError={requestsError}
        onRetry={() => refreshRequests()}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        expandedReqs={expandedReqs}
        toggleExpanded={toggleExpanded}
        cancellingId={cancellingId}
        setCancellingId={setCancellingId}
        cancelBusyId={cancelBusyId}
        onCancelRequest={handleCancelRequest}
        onReturnClick={r => { setReturningReq(r); setTab('inventory'); }}
        onAllocate={handleAllocateFromInventory}
        allocatingId={allocatingId}
        onPhotoPreview={setPhotoPreview}
        fmtDate={fmtDate}
      />

      {/* ── Department tab strip ── */}
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {DEPARTMENTS.map(dept => {
          const dm  = DEPT_META[dept];
          const active = deptTab === dept;
          return (
            <button key={dept}
              onClick={() => setDeptTab(dept)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '7px 16px', borderRadius: 20, border: 'none',
                fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: '13px',
                cursor: 'pointer', transition: 'all 0.15s',
                background: active
                  ? (dm ? `hsl(${dm.color})` : 'var(--pine)')
                  : 'var(--mist)',
                color: active ? '#fff' : 'var(--muted)',
                boxShadow: active ? `0 2px 10px hsla(${dm?.color ?? '0,0%,0%'},0.3)` : 'none',
              }}>
              {dm && <dm.icon size={13} />}
              {dept}
              {dept !== 'All' && (() => {
                const ds = deptStats.find(s => s.dept === dept);
                return <span style={{ opacity: active ? 0.75 : 0.5, fontSize:'11px', fontWeight:500 }}>({ds?.total})</span>;
              })()}
            </button>
          );
        })}
      </div>

      {/* ── Department summary (when a dept is selected) ── */}
      {deptTab !== 'All' && (() => {
        const ds = deptStats.find(s => s.dept === deptTab);
        const dm = DEPT_META[deptTab];
        return ds ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
            {[
              { label:'Items',         value: ds.total },
              { label:'Available',     value: ds.available },
              { label:'Total Units',   value: ds.totalUnits },
              { label:'Out of Stock',  value: ds.outOfStock },
            ].map(({ label, value }) => (
              <div key={label} style={{ background:'var(--card)', border:'1px solid var(--line)', borderRadius:12, padding:'14px 18px', boxShadow:'var(--shadow-sm)' }}>
                <div style={{ fontSize:'11px', fontWeight:700, color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:6 }}>{label}</div>
                <div style={{ fontSize:'22px', fontWeight:700, color:'var(--ink)' }}>{value}</div>
              </div>
            ))}
          </div>
        ) : null;
      })()}

      {/* ── Search + Category filter ── */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ width:240 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <Filter size={13} style={{ color:'var(--muted)' }} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="form-input"
            style={{ padding:'6px 10px', fontSize:'13px', height:34 }}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <span style={{ marginLeft:'auto', fontSize:'13px', color:'var(--muted)' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Item Grid ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(230px,1fr))', gap:14 }}>
        {filtered.map(item => {
          const cat   = CAT_COLORS[item.category] ?? { bg:'var(--mist)', fg:'var(--ink)' };
          const dm    = DEPT_META[item.department];
          const avail = item.available > 0;
          const pct   = Math.round((item.available / item.total) * 100);
          return (
            <div key={item.id} className="motion-card"
              role={avail ? 'button' : undefined}
              tabIndex={avail ? 0 : undefined}
              onClick={avail ? () => openRaiseRequestFor(item) : undefined}
              onKeyDown={avail ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRaiseRequestFor(item); } }) : undefined}
              title={avail ? `Raise a request for ${item.name}` : undefined}
              aria-label={avail ? `Raise a request for ${item.name}` : undefined}
              style={{ border:'1px solid var(--line)', borderRadius:12, padding:16, background:'var(--card)', display:'flex', flexDirection:'column', gap:10, cursor: avail ? 'pointer' : 'default' }}>

              {/* Header row */}
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8, flexWrap:'wrap', rowGap:6 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0, flex:'1 1 auto' }}>
                  <div style={{ width:36, height:36, borderRadius:9, background:cat.bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <Package size={17} color={cat.fg} />
                  </div>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:'13.5px', lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
                    <div style={{ fontSize:'11px', marginTop:2, color: dm ? `hsl(${dm.color})` : 'var(--muted)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {item.department}
                    </div>
                  </div>
                </div>
                <span style={{ padding:'3px 8px', borderRadius:20, fontSize:'10.5px', fontWeight:600, background:cat.bg, color:cat.fg, whiteSpace:'nowrap', flexShrink:0 }}>
                  {item.category}
                </span>
              </div>

              {/* Availability bar */}
              <div>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5, fontSize:'12px' }}>
                  <span style={{ fontWeight:600, color: avail ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))' }}>
                    {avail ? `${item.available} available` : 'Out of stock'}
                  </span>
                  <span style={{ color:'var(--muted)' }}>{item.total} total</span>
                </div>
                <div style={{ height:5, borderRadius:3, background:'var(--line)', overflow:'hidden' }}>
                  <div style={{
                    height:'100%', borderRadius:3,
                    width: `${pct}%`,
                    background: pct > 50 ? 'hsl(var(--color-green))' : pct > 20 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))',
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>

              {/* Out of stock warning */}
              {!avail && (
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:'11.5px', color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', padding:'5px 10px', borderRadius:7 }}>
                  <AlertCircle size={12} /> All units currently checked out
                </div>
              )}
            </div>
          );
        })}
      </div>

      {itemsError ? (
        <ErrorBanner message="Couldn't load inventory items right now — this is usually temporary." onRetry={() => refreshItems()} />
      ) : itemsLoading && filtered.length === 0 && (
        <SkeletonBlocks count={6} height={138} borderRadius={12} gridTemplateColumns="repeat(auto-fill, minmax(230px,1fr))" />
      )}

      {!itemsLoading && !itemsError && filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)', fontSize:'14px' }}>
          <Package size={32} style={{ margin:'0 auto 10px', opacity:0.35, display:'block' }} />
          {search || catFilter !== 'All' ? `No items match your filters.` : 'No inventory items found.'}
        </div>
      )}

      {showModal && (
        <RaiseRequestModal items={items} currentUser={userName} canRaiseOnBehalf={can('supervisor')}
          initialItem={prefillItem} onClose={closeRaiseRequestModal} onSubmit={handleSubmit} />
      )}
      {returningReq && (
        <ReturnModal request={returningReq} onClose={() => setReturningReq(null)}
          onSubmit={data => handleReturnSubmit(returningReq, data)} />
      )}
      {showImport && (
        <ImportItemsModal onClose={() => setShowImport(false)} onImport={handleImport} />
      )}
      {photoPreview && (
        <ImageLightbox src={photoPreview} alt="Return photo" onClose={() => setPhotoPreview(null)} />
      )}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
