// "Name This Document" / "Name This Template" (Neil, 11/11/2026): a new
// document or template opens with no name step; closing it asks for one,
// filled in already - the first line of the page, else "Document -
// 11/11/2026" - so Save & Close is one click. A template is also given its
// category here. A question, so a centered card; Keep Editing stays.
import { useEffect, useRef, useState } from 'react';
import { TEMPLATE_CATEGORIES } from '../../lib/templateCategories';

export default function NameOnClose({ kind = 'document', suggestion = '', category = 'general', onDone }) {
  const [name, setName] = useState(suggestion);
  const [cat, setCat] = useState(category || 'general');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const what = kind === 'template' ? 'Template' : 'Document';
  const ok = name.trim().length > 0;
  const save = () => { if (ok) onDone({ name: name.trim().slice(0, 200), category: cat }); };
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div className="modal-content nx-popup nx-center doc-nameclose" role="dialog" aria-modal="true" aria-labelledby="doc-nameclose-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } }}>
        <h3 id="doc-nameclose-title">Name This {what}</h3>
        <p>Give it a name before you close it, so it is easy to find in {kind === 'template' ? 'Templates' : 'Files'}. You can change it any time.</p>
        <label className="doc-dlg-field">
          <span className="doc-dlg-label">Name</span>
          <input ref={inputRef} className="form-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${what} name`}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
        </label>
        {kind === 'template' && (
          <label className="doc-dlg-field">
            <span className="doc-dlg-label">Category</span>
            <select className="form-input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Template category">
              {TEMPLATE_CATEGORIES.filter(([v]) => v !== 'letterhead').map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <div className="doc-nameclose-actions">
          <button type="button" className="secondary-btn" onClick={() => onDone(null)}>Keep Editing</button>
          <button type="button" className="primary-btn" disabled={!ok} onClick={save}>Save &amp; Close</button>
        </div>
      </div>
    </div>
  );
}
