// Item Management - Import items from a CSV or spreadsheet.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useRef } from 'react';
import { UploadCloud, Download } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../../components/UnsavedChangesPrompt';
import { suggestKnown } from '../model/fields';
import { parseItemsFile, downloadImportTemplate } from '../model/csv';

// ── Import Modal ───────────────────────────────────────────────────────────────
// A blend-in editable cell for the import preview. Renders as plain text until
// focused, so the grid still reads like a table but any value can be corrected
// in place. When a close-but-not-exact match to a known value exists, it offers
// a one-click "Did you mean X?" chip beneath the field.
function ImportEditCell({ value, suggestion, onChange, placeholder }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3, minWidth:96 }}>
      <input
        value={value || ''}
        placeholder={placeholder || ''}
        onChange={e => onChange(e.target.value)}
        style={{ width:'100%', border:'1px solid transparent', borderRadius:5, padding:'3px 6px',
                 fontSize:12, background:'transparent', color:'var(--muted)', fontFamily:'inherit' }}
        onFocus={e => { e.target.style.borderColor = 'var(--line)'; e.target.style.background = 'var(--card)'; e.target.style.color = 'var(--ink)'; }}
        onBlur={e => { e.target.style.borderColor = 'transparent'; e.target.style.background = 'transparent'; e.target.style.color = 'var(--muted)'; }}
      />
      {suggestion && (
        <button type="button" onClick={() => onChange(suggestion)} title={`Use "${suggestion}"`}
          style={{ alignSelf:'flex-start', display:'inline-flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600,
                   color:'hsl(var(--color-orange))', background:'hsla(var(--color-orange),0.09)',
                   border:'1px solid hsla(var(--color-orange),0.35)', borderRadius:12, padding:'1px 8px', cursor:'pointer', whiteSpace:'nowrap' }}>
          Did you mean {suggestion}?
        </button>
      )}
    </div>
  );
}

export function ImportItemsModal({ onClose, onImport, onRestoreConflicts, customFields = [], knownDepts = [], knownLocations = [] }) {
  const [rows,      setRows]      = useState(null);
  const [parseErr,  setParseErr]  = useState('');
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState('');
  const [done,      setDone]      = useState(null);
  const fileRef = useRef(null);

  const [parsing, setParsing] = useState(false);
  async function handleFile(file) {
    if (!file) return;
    setParsing(true); setParseErr('');
    try {
      const { rows, error } = await parseItemsFile(file, customFields);
      if (error) { setParseErr(error); setRows(null); }
      else { setRows(rows); setParseErr(''); }
    } catch {
      setParseErr('Could not read that file. Upload a .csv, .xlsx, or .xls export.');
      setRows(null);
    } finally {
      setParsing(false);
    }
  }

  function doImport() {
    const valid = rows.filter(r => r._valid);
    if (!valid.length || importing) return;
    setImporting(true); setImportErr('');
    Promise.resolve(onImport(valid))
      .then(res => setDone(res))
      // Surface the failure inline instead of silently leaving the modal open (P4).
      .catch(err => setImportErr(err?.message || 'Import failed - please try again.'))
      .finally(() => setImporting(false));
  }

  // Edit a single preview row in place (Department / Location corrections). The
  // corrected value flows straight into the `valid` set that gets imported.
  const updateRow = (idx, patch) => setRows(rs => (rs || []).map((r, i) => i === idx ? { ...r, ...patch } : r));

  const valid   = rows?.filter(r => r._valid) ?? [];
  const invalid = rows?.filter(r => !r._valid) ?? [];
  const warned  = rows?.filter(r => r._unknownType) ?? [];
  // Rows whose Department or Location looks like a typo of an existing value.
  // Surfaced as a banner + inline "Did you mean" so an item never lands under a
  // phantom, unfilterable name (the "Constrcuction" that hid Ashley's item).
  const typoRows = rows?.filter(r => suggestKnown(r.department, knownDepts) || suggestKnown(r.location, knownLocations)) ?? [];
  // The distinct unknown type names (not just a count) - Amy needs to SEE all of
  // them before importing, not just "14 unknown".
  const unknownTypes = [...new Set(warned.map(r => (r.item_type || '').trim()).filter(Boolean))];
  const PREVIEW_CAP = 1000;

  // Nothing worth confirming once the import finished - the work is saved,
  // and before a file is parsed there's nothing to lose either.
  const dirty = !!rows && !done;
  const guard = useUnsavedGuard(dirty, onClose, undefined);

  return (
    <div role="dialog" aria-modal="true" className="modal-overlay" style={{ zIndex:4100 }}
      onClick={e => e.target === e.currentTarget && !importing && guard.requestClose()}>
      <div className="modal-content nx-popup" style={{ display:'flex', flexDirection:'column', padding:28 }}>
        {done ? (
          <>
            <h3 style={{ fontSize:16, fontWeight:700, marginBottom:10 }}>Import Complete</h3>
            <p style={{ fontSize:13.5, color:'var(--muted)', marginBottom:20 }}>
              <strong>{done.created}</strong> items added{done.updated ? <>, <strong>{done.updated}</strong> updated</> : null}. <strong>{done.skipped}</strong> rows skipped.
              {done.added_types?.length ? <> <strong>{done.added_types.length}</strong> new type{done.added_types.length !== 1 ? 's' : ''} created: {done.added_types.join(', ')}.</> : null}
              New rows each get a Nexus serial. Re-importing the same file updates units in place - matched by <strong>Serial</strong>,
              or by content for rows without one - so it won't create duplicates. To change fields, edit the exported file or use Batch Edit.
              Add photos on Inventory (Batch Edit, Photos).
              {done.restored ? <> <strong>{done.restored}</strong> item{done.restored !== 1 ? 's' : ''} brought back from the Recycle Bin.</> : null}
            </p>
            {/* Rows whose serial belongs to an item this import may not touch
                (another company's, or one in the Recycle Bin) were skipped -
                list them, and offer to bring the Recycle Bin ones back. */}
            {done.conflicts?.length > 0 && (
              <div style={{ border:'1px solid var(--wk-line2, var(--line))', borderRadius:12, padding:'12px 14px', marginBottom:20 }}>
                <div style={{ fontWeight:700, fontSize:13.5, marginBottom:6 }}>{done.conflicts.length} row{done.conflicts.length !== 1 ? 's' : ''} not imported</div>
                <ul style={{ margin:0, padding:0, listStyle:'none', display:'grid', gap:4, maxHeight:180, overflowY:'auto' }}>
                  {done.conflicts.map((c, i) => (
                    <li key={`${c.serial}-${i}`} style={{ fontSize:12.5, color:'var(--muted)' }}>
                      <strong style={{ color:'var(--ink)' }}>{c.name || 'Row'}</strong> · Serial {c.serial} · {c.reason}
                    </li>
                  ))}
                </ul>
                {onRestoreConflicts && done.conflicts.some(c => /recycle|deleted/i.test(c.reason || '')) && (
                  <button className="secondary-btn" style={{ marginTop:10 }} disabled={importing}
                    onClick={() => {
                      setImporting(true);
                      Promise.resolve(onRestoreConflicts(rows.filter(r => r._valid)))
                        .then(res => setDone(res))
                        .catch(err => setImportErr(err?.message || 'Could not bring them back.'))
                        .finally(() => setImporting(false));
                    }}>
                    Import Again and Restore Them From the Recycle Bin
                  </button>
                )}
                {importErr && <p style={{ fontSize:12.5, color:'var(--bad-fg)', margin:'8px 0 0' }}>{importErr}</p>}
              </div>
            )}
            <div style={{ display:'flex', justifyContent:'flex-end' }}><button className="primary-btn" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
              <h3 style={{ fontSize:16, fontWeight:700 }}>Import Items From CSV or Excel</h3>
              <button onClick={() => downloadImportTemplate(customFields)} className="secondary-btn" style={{ fontSize:12, padding:'5px 12px', display:'inline-flex', alignItems:'center', gap:5 }}>
                <Download size={13} /> Template
              </button>
            </div>
            <p style={{ fontSize:12.5, color:'var(--muted)', marginBottom:16 }}>
              Each row = one physical item. Accepts .csv, .xlsx, and .xls. Photos are always added manually after import. Required columns: <strong>Name</strong>.
              Leave <strong>Serial</strong> blank and Nexus assigns one - keep a serial to update that exact unit on re-import.
            </p>

            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style={{ display:'none' }} onChange={e => handleFile(e.target.files?.[0])} />
            <button onClick={() => fileRef.current?.click()} disabled={parsing} className="secondary-btn" style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px', marginBottom:14 }}>
              {parsing ? <><Spinner size={16} /> Reading…</> : <><UploadCloud size={16} /> Choose CSV / Excel file</>}
            </button>

            {parseErr && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', marginBottom:12 }}>{parseErr}</p>}

            {rows && (
              <>
                <div style={{ fontSize:12.5, color:'var(--muted)', marginBottom:10 }}>
                  <strong style={{ color:'hsl(var(--color-green))' }}>{valid.length} valid</strong>
                  {invalid.length > 0 && <>, <strong style={{ color:'hsl(var(--color-red))' }}>{invalid.length} missing name (skipped)</strong></>}
                  {warned.length > 0 && <>, <strong style={{ color:'hsl(var(--color-orange))' }}>{warned.length} row{warned.length !== 1 ? 's' : ''} with a new/unknown type</strong></>}
                </div>
                {/* Show EVERY distinct new/unknown type so they can all be reviewed
                    before importing - not just a count (Amy: "could not see all 14").
                    The backend AI-matches these to an existing type or creates them,
                    then reports the created ones after import (P1-12). */}
                {unknownTypes.length > 0 && (
                  <div style={{ border:'1px solid hsla(var(--color-orange),0.35)', background:'hsla(var(--color-orange),0.06)', borderRadius:8, padding:'10px 12px', marginBottom:14 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'hsl(var(--color-orange))', marginBottom:7 }}>
                      {unknownTypes.length} type{unknownTypes.length !== 1 ? 's' : ''} not in your list yet - these may be matched to an existing type or created on import (you'll get the created list afterwards):
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      {unknownTypes.map(t => (
                        <span key={t} style={{ fontSize:12, fontWeight:600, background:'var(--card)', border:'1px solid hsla(var(--color-orange),0.4)', color:'var(--ink)', borderRadius:20, padding:'3px 10px' }}>{t}</span>
                      ))}
                    </div>
                  </div>
                )}
                {typoRows.length > 0 && (
                  <div style={{ border:'1px solid hsla(var(--color-orange),0.35)', background:'hsla(var(--color-orange),0.06)', borderRadius:8, padding:'10px 12px', marginBottom:14 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'hsl(var(--color-orange))', marginBottom:4 }}>
                      {typoRows.length} row{typoRows.length !== 1 ? 's' : ''} with a department or location that looks like a typo of one you already use
                    </div>
                    <div style={{ fontSize:12, color:'var(--muted)' }}>
                      Tap the suggestion under the field to fix it, or type the correct value. An item filed under a misspelled name won't show up when you filter by the correct one.
                    </div>
                  </div>
                )}
                <div style={{ border:'1px solid var(--line)', borderRadius:8, overflow:'auto', maxHeight:'52vh', marginBottom:10 }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <thead>
                      <tr style={{ background:'var(--mist)', position:'sticky', top:0, zIndex:1 }}>
                        {['Serial','Name','Type','Make','Model','Dept','Ownership','Location'].map(h =>
                          <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontWeight:700, color:'var(--muted)', whiteSpace:'nowrap', background:'var(--mist)' }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, PREVIEW_CAP).map((r, i) => (
                        <tr key={i} style={{ borderTop:'1px solid var(--line)', background: !r._valid ? 'hsla(var(--color-red),0.04)' : 'transparent' }}>
                          <td style={{ padding:'6px 10px', color: r.serial_number ? 'var(--ink)' : 'var(--muted)', whiteSpace:'nowrap' }}>{r.serial_number || <em style={{ color:'var(--muted)' }}>auto</em>}</td>
                          <td style={{ padding:'6px 10px', fontWeight:600 }}>{r.name || <em style={{ color:'hsl(var(--color-red))' }}>missing</em>}</td>
                          <td style={{ padding:'6px 10px', color: r._unknownType ? 'hsl(var(--color-orange))' : 'var(--muted)' }}>{r.item_type}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.make}</td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.model}</td>
                          <td style={{ padding:'4px 8px', verticalAlign:'top' }}>
                            <ImportEditCell value={r.department} suggestion={suggestKnown(r.department, knownDepts)}
                              onChange={v => updateRow(i, { department: v })} />
                          </td>
                          <td style={{ padding:'6px 10px', color:'var(--muted)' }}>{r.ownership_type}</td>
                          <td style={{ padding:'4px 8px', verticalAlign:'top' }}>
                            <ImportEditCell value={r.location} suggestion={suggestKnown(r.location, knownLocations)}
                              onChange={v => updateRow(i, { location: v })} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > PREVIEW_CAP && (
                  <p style={{ fontSize:12, color:'var(--muted)', margin:'0 0 12px' }}>
                    Previewing the first {PREVIEW_CAP.toLocaleString()} of {rows.length.toLocaleString()} rows - all {valid.length.toLocaleString()} valid rows will still be imported.
                  </p>
                )}
                {importErr && <p style={{ fontSize:12.5, color:'hsl(var(--color-red))', margin:'0 0 10px', textAlign:'right' }}>{importErr}</p>}
                <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                  <button className="secondary-btn" onClick={onClose} disabled={importing}>Cancel</button>
                  <button className="primary-btn" disabled={!valid.length || importing}
                    style={{ display:'inline-flex', alignItems:'center', gap:7 }} onClick={doImport}>
                    {importing ? <><Spinner size={14} /> Importing…</> : `Import ${valid.length} items`}
                  </button>
                </div>
              </>
            )}
            {!rows && <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}><button className="secondary-btn" onClick={onClose}>Cancel</button></div>}
          </>
        )}
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} />
      )}
    </div>
  );
}
