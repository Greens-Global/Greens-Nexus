import { useEffect, useState } from 'react';
import { ChevronRight, CornerLeftUp, Folder, FolderPlus, Loader2, X } from 'lucide-react';
import { api } from '../../api';
import { useAccountingPrefs } from './prefs';
import { control } from './reportControls';
import { csvRows, reportFileName } from './reportModel';

// Export -> Email / Save to Egnyte / Share (Charmi, call of 09/29). The
// statement on screen becomes a file here (PDF or Excel, exactly what the
// screen shows) and goes where it is sent:
//   email   from the sender's own mailbox, with the file attached
//   egnyte  into a folder the person names (remembered for next time)
//   share   memorized, shared with the team, and a bell notification to the
//           teammate picked, who opens it under Saved Reports
//
// Oct 2 (Charmi: "I am not sure where will this be stored?"): the Egnyte
// dialog says exactly where - "Will be saved as /Shared/Accounting/Reports/
// Income Statement - Darshana R. Kadakia MD Inc. (13000) - 01-01-2026 to
// 12-31-2026.pdf" - with Browse to pick a folder from Egnyte's own list,
// Create Folder when the one named is not there yet, and "Open in Egnyte"
// once it is saved (the bar above the report carries the link).

const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const TITLES = { email: 'Email This Statement', egnyte: 'Save to Egnyte', share: 'Share With a Teammate' };
const DEFAULT_FOLDER = '/Shared/Accounting/Reports';
const cleanFolder = (s) => `/${String(s || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
const parentOf = (p) => { const c = cleanFolder(p); const at = c.lastIndexOf('/'); return at <= 0 ? '/' : c.slice(0, at); };
const missing = (err) => /not found|does not exist|no such|404/i.test(err?.message || '');

// The statement as a file: PDF (a page of a package), Excel or CSV, named
// after the statement, its entity and its period (reportFileName).
export async function statementFile(result, entities, title, format) {
  const name = reportFileName(result, entities, format);
  if (format === 'excel') {
    const { buildStatementWorkbook } = await import('./reportExcel');
    const bytes = await buildStatementWorkbook({ title, result, entities });
    return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  if (format === 'csv') {
    const text = csvRows(result, entities).map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    return new File([String.fromCharCode(0xfeff) + text], name, { type: 'text/csv;charset=utf-8' });
  }
  const { buildPackagePdf } = await import('./reportPdf');
  const bytes = await buildPackagePdf({ name: title, statements: [{ title: result.def.label, result, entities }], cover: false });
  return new File([bytes], name, { type: 'application/pdf' });
}

// Egnyte's folders, one level at a time, to pick the one to save into.
function FolderBrowser({ start, onPick, onClose }) {
  const [path, setPath] = useState(() => cleanFolder(start || DEFAULT_FOLDER));
  const [state, setState] = useState({ loading: true, folders: [], error: '', missing: false });
  const [creating, setCreating] = useState(false);
  const load = (p) => {
    setState({ loading: true, folders: [], error: '', missing: false });
    api.egnyteFolder(p)
      .then((d) => setState({ loading: false, folders: (d?.folders || []).map((f) => ({ name: f.name, path: cleanFolder(f.path) })), error: '', missing: false }))
      .catch((e) => setState({ loading: false, folders: [], error: missing(e) ? '' : e?.message || 'Could not browse Egnyte.', missing: missing(e) }));
  };
  useEffect(() => { load(path); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = () => {
    if (creating) return;
    setCreating(true);
    api.egnyteCreateFolder(path).then(() => load(path)).catch((e) => setState((s) => ({ ...s, error: e?.message || 'Could not create the folder.' }))).finally(() => setCreating(false));
  };
  return (
    <div role="region" aria-label="Browse Egnyte folders" style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem' }}>
        <button type="button" className="secondary-btn" onClick={() => setPath(parentOf(path))} disabled={path === '/'} aria-label="Up one folder" title="Up one folder" style={{ padding: '2px 6px', display: 'inline-flex' }}><CornerLeftUp size={13} /></button>
        <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>{path}</strong>
        <button type="button" className="primary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }} onClick={() => onPick(path)} disabled={state.missing}>Use This Folder</button>
        <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '3px 10px' }} onClick={onClose}>Close</button>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 1 }}>
        {state.loading && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', padding: 6 }}><Loader2 size={12} className="spin" /> Reading Egnyte...</div>}
        {state.error && <div style={{ ...bad, padding: '6px 10px' }}>{state.error}</div>}
        {state.missing && (
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', padding: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            This folder does not exist yet.
            <button type="button" className="secondary-btn" onClick={create} disabled={creating} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.74rem', padding: '3px 10px' }}><FolderPlus size={13} /> {creating ? 'Creating...' : 'Create Folder'}</button>
          </div>
        )}
        {!state.loading && !state.error && !state.missing && !state.folders.length && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', padding: 6 }}>No folders inside this one.</div>}
        {state.folders.map((f) => (
          <button key={f.path} type="button" onClick={() => setPath(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, background: 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <Folder size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SendReportDialog({ mode, result, entities, title, config, onClose, onDone }) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const [format, setFormat] = useState('pdf');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState(title);
  const [message, setMessage] = useState('');
  const [folder, setFolder] = useState(prefs.egnyteFolder || DEFAULT_FOLDER);
  const [people, setPeople] = useState([]);
  const [recipient, setRecipient] = useState('');
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [offerCreate, setOfferCreate] = useState(false);   // the save failed because the folder is not there
  const fileName = reportFileName(result, entities, format);
  const dest = cleanFolder(folder || DEFAULT_FOLDER);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (mode !== 'share') return;
    // The curated Nexus People list, never M365.
    api.getPeopleDirectory()
      .then((rows) => setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || '' })).filter((p) => p.email).sort((a, b) => a.name.localeCompare(b.name, 'en-US'))))
      .catch(() => setPeople([]));
  }, [mode]);

  const ready = mode === 'email' ? to.trim() && subject.trim() : mode === 'egnyte' ? folder.trim() : recipient && name.trim();
  const send = async (e, createFirst = false) => {
    e?.preventDefault?.();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    setOfferCreate(false);
    try {
      if (mode === 'email') {
        const file = await statementFile(result, entities, title, format);
        const r = await api.emailAccountingReport({ to: to.trim(), subject: subject.trim(), message, file });
        onDone(`Emailed to ${r.to.join(', ')}${r.from && r.from !== r.to[0] ? ` from ${r.from}` : ''}.`);
      } else if (mode === 'egnyte') {
        const file = await statementFile(result, entities, title, format);
        if (createFirst) await api.egnyteCreateFolder(dest);
        let r;
        try {
          r = await api.egnyteUpload(dest, file);
        } catch (err) {
          // The folder named is not there: offer to make it and save again.
          if (missing(err) && !createFirst) { setOfferCreate(true); throw new Error(`Egnyte has no folder ${dest} yet.`, { cause: err }); }
          throw err;
        }
        setPrefs({ egnyteFolder: dest });
        onDone(`Saved to Egnyte as ${dest}/${file.name}.`, r?.webUrl);
      } else {
        const r = await api.shareAccountingReport({ recipient, name: name.trim(), config, message });
        onDone(`Shared "${r.report.name}" - it is under Saved Reports for the whole team, and ${people.find((p) => p.email === recipient)?.name || 'they'} were told.`);
      }
    } catch (err) {
      setError(err?.message || 'Could not send the statement.');
      setBusy(false);
    }
  };
  const formatPicker = (
    <div>
      <div style={label}>File</div>
      <div role="radiogroup" aria-label="File format" style={{ display: 'flex', gap: 6 }}>
        {[['pdf', 'PDF'], ['excel', 'Excel'], ['csv', 'CSV']].map(([k, text]) => (
          <button key={k} type="button" role="radio" aria-checked={format === k} onClick={() => setFormat(k)}
            style={{ ...control, cursor: 'pointer', fontWeight: format === k ? 700 : 500, border: `1px solid ${format === k ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: format === k ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: format === k ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form className="modal-content" role="dialog" aria-modal="true" aria-label={TITLES[mode]} onClick={(e) => e.stopPropagation()} onSubmit={send} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{TITLES[mode]}</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {mode === 'email' ? 'Sent from your own mailbox, with the statement attached exactly as it is on screen.'
                : mode === 'egnyte' ? 'The statement as it is on screen, filed in the folder you name. The folder is remembered.'
                  : 'Memorizes this view, shares it with the accounting team, and tells the person on their bell.'}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12 }}>
          {mode === 'email' && (
            <>
              <div>
                <label style={label} htmlFor="send-to">To</label>
                <input id="send-to" type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="lender@bank.com, cfo@bank.com" autoFocus style={{ ...control, width: '100%' }} />
              </div>
              <div>
                <label style={label} htmlFor="send-subject">Subject</label>
                <input id="send-subject" type="text" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} style={{ ...control, width: '100%' }} />
              </div>
              <div>
                <label style={label} htmlFor="send-message">Message</label>
                <textarea id="send-message" value={message} maxLength={4000} rows={4} onChange={(e) => setMessage(e.target.value)} placeholder="Attached is the statement you asked for." style={{ ...control, width: '100%', height: 'auto', padding: 8, lineHeight: 1.5, resize: 'vertical' }} />
              </div>
              {formatPicker}
            </>
          )}
          {mode === 'egnyte' && (
            <>
              <div>
                <label style={label} htmlFor="send-folder">Egnyte Folder</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="send-folder" type="text" value={folder} onChange={(e) => { setFolder(e.target.value); setOfferCreate(false); }} autoFocus placeholder={DEFAULT_FOLDER} style={{ ...control, flex: 1, minWidth: 0 }} />
                  <button type="button" className="secondary-btn" onClick={() => setBrowsing((v) => !v)} aria-expanded={browsing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}><Folder size={14} /> Browse</button>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>The path as Egnyte shows it, starting with /Shared or /Private. The folder is remembered for next time.</div>
              </div>
              {browsing && <FolderBrowser start={dest} onPick={(p) => { setFolder(p); setBrowsing(false); setOfferCreate(false); }} onClose={() => setBrowsing(false)} />}
              {formatPicker}
              <div role="status" aria-label="Where the file will be saved" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '8px 10px', wordBreak: 'break-all' }}>
                Will be saved as <strong style={{ color: 'var(--text-primary)' }}>{dest}/{fileName}</strong>
              </div>
            </>
          )}
          {mode === 'share' && (
            <>
              <div>
                <label style={label} htmlFor="send-person">Share With</label>
                <select id="send-person" value={recipient} onChange={(e) => setRecipient(e.target.value)} style={{ ...control, width: '100%' }} autoFocus>
                  <option value="">Pick a person...</option>
                  {people.map((p) => <option key={p.email} value={p.email}>{p.name || 'Unnamed'}</option>)}
                </select>
              </div>
              <div>
                <label style={label} htmlFor="send-name">Saved As</label>
                <input id="send-name" type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} style={{ ...control, width: '100%' }} />
              </div>
              <div>
                <label style={label} htmlFor="send-note">Note (optional)</label>
                <input id="send-note" type="text" value={message} maxLength={600} onChange={(e) => setMessage(e.target.value)} placeholder="Have a look at September before the close." style={{ ...control, width: '100%' }} />
              </div>
            </>
          )}
          {error && (
            <div style={bad}>
              {error}
              {offerCreate && (
                <button type="button" className="secondary-btn" onClick={(e) => send(e, true)} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.74rem', padding: '3px 10px', marginLeft: 10 }}><FolderPlus size={13} /> Create Folder and Save</button>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={!ready || busy}>{busy ? 'Sending...' : mode === 'email' ? 'Send Email' : mode === 'egnyte' ? 'Save to Egnyte' : 'Share'}</button>
        </div>
      </form>
    </div>
  );
}
