import { useEffect, useRef, useState } from 'react';
import { FolderSearch } from 'lucide-react';
import { api } from '../../../api.js';
import { egnyteFolderProblem, normalizeEgnyteFolder, HOW_WORDS } from '../../lib/egnyteFolder.js';

const inputStyle = { width: '100%', padding: '5px 9px', fontSize: '0.82rem' };
const noteStyle = { fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.45 };

/**
 * The Egnyte Folder field in edit mode (Neil, 11/03/2026): a property may pin
 * its exact Egnyte folder instead of matching by name. Paste a path (or an
 * Egnyte folder link), or Find Folder - the server lists the folders whose
 * name could be this property's (or the name typed in the box) and the person
 * picks one; nothing is pinned until the form is saved. Blank = not pinned,
 * construction files are matched by name as before.
 */
export function EgnyteFolderInput({ assetId, value, onChange }) {
  // null | { busy } | the server's answer | { error }, tagged with the asset it
  // was asked for: the form stays mounted from one asset to the next, and an
  // answer for the last one is never offered on this one.
  const [found, setFound] = useState(null);
  const find = found && found.for === assetId ? found : null;
  const setFind = (v) => setFound(v && { ...v, for: assetId });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const text = String(value ?? '');
  const roots = (find && find.roots) || [];
  // A path or a folder link is checked; a bare name is a search for Find Folder.
  const looksPath = /[/\\]/.test(text) || /^https?:/i.test(text.trim());
  const problem = looksPath ? egnyteFolderProblem(text, roots) : '';

  const runFind = () => {
    // A name typed in the box (no slash) is the search; else the asset's own name.
    const typed = text.trim();
    const q = typed && !typed.includes('/') ? typed : '';
    const asked = assetId;
    const land = (v) => { if (alive.current) setFound({ ...v, for: asked }); };
    setFind({ busy: true });
    Promise.resolve(api.findAssetEgnyteFolders?.(asked, q))
      .then((r) => land(r || { error: 'Egnyte did not answer - try again in a minute.' }))
      .catch((e) => land({ error: (e && e.message) || 'Egnyte did not answer - try again in a minute.' }));
  };
  const pick = (path) => { onChange(path); setFind(null); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="form-input" type="text" aria-label="Egnyte Folder" value={text}
          placeholder="Paste a folder path, or Find Folder"
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            // Tidy a pasted path or folder link; a bare name stays as typed - it is
            // what Find Folder searches (the blur runs before the button's click).
            if (!looksPath) return;
            const n = normalizeEgnyteFolder(text);
            if (n !== text && !/^https?:/i.test(n)) onChange(n);
          }}
          style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
        <button type="button" className="secondary-btn" onClick={runFind} disabled={!!(find && find.busy)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: '0.8rem', flexShrink: 0 }}>
          <FolderSearch size={14} /> Find Folder
        </button>
      </div>
      {problem && <div role="alert" style={{ ...noteStyle, color: 'hsl(var(--color-red))' }}>{problem}</div>}
      {!looksPath && text.trim() && (
        <div style={noteStyle}>Press Find Folder to search Egnyte for this name, then pick a folder - a name alone is not a folder.</div>
      )}
      {!text.trim() && !find && <div style={noteStyle}>Not pinned - construction files go to the folder matched by the property's name.</div>}
      {find && find.busy && <div style={noteStyle}>Looking in Egnyte...</div>}
      {find && find.error && <div role="alert" style={noteStyle}>{find.error}</div>}
      {find && !find.busy && !find.error && (
        <div data-testid="egnyte-find" style={{ border: '1px solid var(--border-color)', borderRadius: 9, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {find.configured === false ? (
            <div style={noteStyle}>{find.message || "Egnyte is not set up on this server - paste the folder's path instead."}</div>
          ) : (
            <>
              <div style={noteStyle}>
                {find.message || `Folders that could be "${find.site}":`}
                {find.pinned && find.pinnedFound === false && <> The folder pinned now is not in Egnyte - files wait until it is back or another is pinned.</>}
              </div>
              {(find.candidates || []).map((c) => (
                <button key={c.path} type="button" onClick={() => pick(c.path)}
                  aria-label={`Pin ${c.path}`}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', border: '1px solid var(--border-color)', borderRadius: 7, background: c.path === text ? 'var(--mist)' : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{c.name}</span>
                    <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', wordBreak: 'break-word' }}>{c.root}</span>
                  </span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: c.path === find.match ? 'hsl(var(--color-green))' : 'var(--text-secondary)', flexShrink: 0 }}>
                    {c.path === find.match ? 'Best Match' : (HOW_WORDS[c.how] || '')}
                  </span>
                </button>
              ))}
            </>
          )}
          <button type="button" onClick={() => setFind(null)}
            style={{ alignSelf: 'flex-start', border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
