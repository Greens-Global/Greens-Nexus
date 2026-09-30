import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import { useAccountingPrefs } from './prefs';
import { control } from './reportControls';
import { csvFileName, csvRows } from './reportModel';

// Export -> Email / Save to Egnyte / Share (Charmi, call of 09/29). The
// statement on screen becomes a file here (PDF or Excel, exactly what the
// screen shows) and goes where it is sent:
//   email   from the sender's own mailbox, with the file attached
//   egnyte  into a folder the person names (remembered for next time)
//   share   memorized, shared with the team, and a bell notification to the
//           teammate picked, who opens it under Saved Reports

const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const TITLES = { email: 'Email This Statement', egnyte: 'Save to Egnyte', share: 'Share With a Teammate' };
const DEFAULT_FOLDER = '/Shared/Accounting/Reports';

// The statement as a file: PDF (a page of a package) or Excel.
export async function statementFile(result, entities, title, format) {
  const base = csvFileName(result).replace(/\.csv$/, '');
  if (format === 'excel') {
    const { buildStatementWorkbook } = await import('./reportExcel');
    const bytes = await buildStatementWorkbook({ title, result, entities });
    return new File([bytes], `${base}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  if (format === 'csv') {
    const text = csvRows(result, entities).map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    return new File([String.fromCharCode(0xfeff) + text], `${base}.csv`, { type: 'text/csv;charset=utf-8' });
  }
  const { buildPackagePdf } = await import('./reportPdf');
  const bytes = await buildPackagePdf({ name: title, statements: [{ title: result.def.label, result, entities }], cover: false });
  return new File([bytes], `${base}.pdf`, { type: 'application/pdf' });
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
  const send = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'email') {
        const file = await statementFile(result, entities, title, format);
        const r = await api.emailAccountingReport({ to: to.trim(), subject: subject.trim(), message, file });
        onDone(`Emailed to ${r.to.join(', ')}${r.from && r.from !== r.to[0] ? ` from ${r.from}` : ''}.`);
      } else if (mode === 'egnyte') {
        const file = await statementFile(result, entities, title, format);
        const dest = folder.trim().replace(/\/+$/, '');
        const r = await api.egnyteUpload(dest, file);
        setPrefs({ egnyteFolder: dest });
        onDone(`Saved to Egnyte: ${dest}/${file.name}.`, r?.webUrl);
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
                <input id="send-folder" type="text" value={folder} onChange={(e) => setFolder(e.target.value)} autoFocus placeholder={DEFAULT_FOLDER} style={{ ...control, width: '100%' }} />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>The path as Egnyte shows it, starting with /Shared or /Private. The file keeps the statement's own name.</div>
              </div>
              {formatPicker}
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
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={!ready || busy}>{busy ? 'Sending...' : mode === 'email' ? 'Send Email' : mode === 'egnyte' ? 'Save to Egnyte' : 'Share'}</button>
        </div>
      </form>
    </div>
  );
}
