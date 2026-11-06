// Share a Document or a Sheet (Neil, 11/05/2026, routers/documents.py
// "Working together"): people from Nexus People, Can Edit or Can View. The
// owner (or an administrator) changes the list; editors see it.
import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { Modal, usePeople, Avatar } from '../tasks/components';
import { ErrorBanner } from '../components/AsyncState';
import { matchPeople } from '../lib/peopleSearch';
import './docLive.css';

export default function ShareDocumentDialog({ doc, canManage, onClose, onChanged }) {
  const people = usePeople();
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('edit');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const shared = useMemo(() => doc.sharedWith || [], [doc.sharedWith]);
  const owner = (doc.ownerEmail || '').toLowerCase();
  const byEmail = useMemo(() => Object.fromEntries(people.map((p) => [p.email, p])), [people]);
  const options = useMemo(() => matchPeople(people.filter((p) => p.email !== owner && !shared.some((s) => s.email === p.email)), q, { limit: 8 }),
    [people, q, shared, owner]);
  const what = doc.kind === 'sheet' ? 'sheet' : 'document';
  const act = async (email, fn) => {
    setBusy(email); setError('');
    try { const out = await fn(); onChanged?.(out); } catch (e) { setError(e.message || 'Could not change sharing'); } finally { setBusy(''); }
  };
  const remove = (email) => act(email, async () => {
    await api.unshareDocument(doc.id, email);
    return { ...doc, sharedWith: shared.filter((s) => s.email !== email) };
  });
  const nameOf = (email) => byEmail[email]?.name || email;

  return (
    <Modal title={`Share "${doc.title || 'Untitled'}"`} onClose={onClose}
      footer={<button type="button" className="secondary-btn" onClick={onClose}>Done</button>}>
      <div className="dl-share">
        <p className="dl-share-hint">
          Share with people in Nexus People. They get one notice and find the {what} in Documents. Can Edit works in it with you, live, with
          each other's cursors; Can View reads it and follows your changes. Only you change the folder, tags, sharing and archive.
        </p>
        {error && <ErrorBanner message={error} />}
        {canManage && (
          <div className="dl-share-find">
            <div className="dl-share-search">
              <Search size={15} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone by name or email" aria-label="Find someone" autoFocus />
            </div>
            <select className="form-input" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="What they may do">
              <option value="edit">Can Edit</option>
              <option value="view">Can View</option>
            </select>
          </div>
        )}
        {canManage && q && (
          <div className="dl-share-list">
            {options.length === 0 && <div className="dl-share-empty">Nobody in Nexus People matches "{q}".</div>}
            {options.map((p) => (
              <div key={p.email} className="dl-share-person">
                <Avatar email={p.email} name={p.name} size={26} />
                <span className="dl-share-name">{p.name}<small>{p.email}</small></span>
                <button type="button" className="secondary-btn" disabled={busy === p.email}
                  onClick={() => act(p.email, () => api.shareDocument(doc.id, p.email, level)).then(() => setQ(''))}>Share</button>
              </div>
            ))}
          </div>
        )}
        <div className="dl-share-label">Shared With</div>
        <div className="dl-share-list nx-fill">
          {owner && (
            <div className="dl-share-person">
              <Avatar email={owner} name={nameOf(owner)} size={26} />
              <span className="dl-share-name">{nameOf(owner)}<small>{owner}</small></span>
              <span className="dl-share-role">Owner</span>
            </div>
          )}
          {shared.length === 0 && <div className="dl-share-empty">Nobody else yet.</div>}
          {shared.map((s) => (
            <div key={s.email} className="dl-share-person">
              <Avatar email={s.email} name={nameOf(s.email)} size={26} />
              <span className="dl-share-name">{nameOf(s.email)}<small>{s.email}</small></span>
              {canManage ? (
                <>
                  <select className="form-input" value={s.can} aria-label={`What ${nameOf(s.email)} may do`} disabled={busy === s.email}
                    onChange={(e) => act(s.email, () => api.shareDocument(doc.id, s.email, e.target.value))}>
                    <option value="edit">Can Edit</option>
                    <option value="view">Can View</option>
                  </select>
                  <button type="button" className="dl-icon-btn" aria-label={`Stop sharing with ${nameOf(s.email)}`} disabled={busy === s.email}
                    onClick={() => remove(s.email)}><X size={15} /></button>
                </>
              ) : <span className="dl-share-role">{s.can === 'edit' ? 'Can Edit' : 'Can View'}</span>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Who else is in the live session: colored initials, newest last. */
export function LivePeople({ peers = [], status }) {
  const seen = new Map();
  peers.forEach((u) => { if (u?.email || u?.name) seen.set(u.email || u.name, u); });
  const list = [...seen.values()];
  const word = status === 'live' ? (list.length ? 'Live' : 'Live, Just You') : status === 'stale' ? 'Reconnecting' : status === 'connecting' ? 'Connecting' : '';
  if (!word) return null;
  return (
    <div className="dl-live" aria-live="polite">
      {list.slice(0, 5).map((u) => (
        <span key={u.email || u.name} className="dl-live-dot" style={{ background: u.color || '#64748b' }} title={`${u.name || u.email} is here`}>
          {(u.name || u.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
        </span>
      ))}
      {list.length > 5 && <span className="dl-live-more">+{list.length - 5}</span>}
      <span className={`dl-live-word${status === 'live' ? ' on' : ''}`}>{word}</span>
    </div>
  );
}
